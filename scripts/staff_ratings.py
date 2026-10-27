#!/usr/bin/env python3
"""
Staff Letterboxd ratings -> content/staff-ratings.json

Run by .github/workflows/staff-ratings.yml on a schedule. Stdlib only.

For every writer record in content/writers/*.json that has a `letterboxd`
handle, pull their public diary feed (https://letterboxd.com/<handle>/rss/),
match each rated entry to a film record in content/films/*.json, and merge
the result into content/staff-ratings.json.

Matching, in order:
  1. film record `tmdbId`  ==  feed's <tmdb:movieId>        (exact, preferred)
  2. normalized title match, with a year sanity check       (fallback)

The feed only exposes the ~50 most recent diary entries, so this script
MERGES into the existing JSON and never drops a rating it has already seen.
A newer diary entry for the same writer+film replaces the older one.

Output shape (content/staff-ratings.json):
{
  "updated": "2026-10-27T01:23:45Z",
  "source": "letterboxd",
  "films": {
    "<film slug>": {
      "tmdbId": 123456,
      "ratings": {
        "<writer slug>": { "rating": 4.0, "watched": "2026-10-20",
                           "url": "https://letterboxd.com/..." }
      }
    }
  }
}
"""

import csv
import datetime as dt
import difflib
import glob
import json
import os
import re
import sys
import unicodedata
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
WRITERS_DIR = os.path.join(ROOT, 'content', 'writers')
FILMS_DIR = os.path.join(ROOT, 'content', 'films')
OUT_PATH = os.path.join(ROOT, 'content', 'staff-ratings.json')
IMPORT_DIR = os.path.join(ROOT, 'content', 'staff-ratings-import')

# Title-only matches are only trusted for films from this year onward, so a
# writer logging an older film with the same title as a contender doesn't
# leak into the consensus.
SEASON_MIN_YEAR = 2025
# The run summary only lists unmatched films from this year on — the tracked
# pool is the 2026–27 season, so last season's films are pure noise there.
REPORT_MIN_YEAR = 2026
# When our film record has a release year, the feed's year must be within
# this many years of it (festival year vs. release year drift).
YEAR_TOLERANCE = 1

USER_AGENT = 'FantasyFilmball-StaffRatings/1.0 (+https://fantasyfilmball.com)'
TIMEOUT_S = 30


# ---------------------------------------------------------------------------
# helpers

def log(msg):
    print(msg, flush=True)


def load_json_dir(path):
    out = []
    for fp in sorted(glob.glob(os.path.join(path, '*.json'))):
        slug = os.path.splitext(os.path.basename(fp))[0]
        try:
            with open(fp, encoding='utf-8') as fh:
                out.append((slug, json.load(fh)))
        except Exception as exc:  # noqa: BLE001
            log(f'  ! skipping {fp}: {exc}')
    return out


def norm_title(s):
    s = unicodedata.normalize('NFKD', str(s or ''))
    s = ''.join(ch for ch in s if not unicodedata.combining(ch))
    s = s.lower().replace('&', ' and ')
    s = re.sub(r"[’'`]", '', s)
    s = re.sub(r'[^a-z0-9]+', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()


def year_of(rec):
    """Pull a 4-digit year out of a film record's releaseDate, if any."""
    m = re.search(r'(19|20)\d{2}', str(rec.get('releaseDate') or ''))
    return int(m.group(0)) if m else None


def handle_of(writer):
    raw = str(writer.get('letterboxd') or '').strip()
    if not raw:
        return None
    if '//' in raw:
        raw = raw.split('//', 1)[1]
    raw = raw.split('?', 1)[0].rstrip('/')
    if raw.lower().startswith('letterboxd.com/'):
        raw = raw.split('/', 1)[1]
    raw = raw.strip('/').split('/')[0]
    return raw.lstrip('@') or None


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Accept': 'application/rss+xml, application/xml, text/xml'})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        return resp.read()


def local(tag):
    return tag.rsplit('}', 1)[-1]


def parse_feed(xml_bytes):
    """Yield dicts for every rated diary entry in a Letterboxd RSS feed."""
    root = ET.fromstring(xml_bytes)
    for item in root.iter():
        if local(item.tag) != 'item':
            continue
        f = {}
        for child in item:
            f[local(child.tag)] = (child.text or '').strip()
        if 'filmTitle' not in f or not f.get('memberRating'):
            continue  # list items, unrated logs, etc.
        try:
            rating = float(f['memberRating'])
        except ValueError:
            continue
        try:
            tmdb = int(f.get('movieId') or 0) or None
        except ValueError:
            tmdb = None
        try:
            year = int(f.get('filmYear') or 0) or None
        except ValueError:
            year = None
        watched = f.get('watchedDate') or ''
        if not watched and f.get('pubDate'):
            try:
                watched = parsedate_to_datetime(f['pubDate']).date().isoformat()
            except Exception:  # noqa: BLE001
                watched = ''
        yield {
            'title': f['filmTitle'],
            'year': year,
            'tmdbId': tmdb,
            'rating': rating,
            'watched': watched,
            'url': f.get('link') or '',
            'rewatch': (f.get('rewatch') or '').lower() == 'yes',
        }


def parse_rating(raw):
    """'4', '4.5', '3.5/5', '★★★½' -> float, or None."""
    raw = str(raw or '').strip()
    if not raw:
        return None
    if '★' in raw or '½' in raw:
        return raw.count('★') + (0.5 if '½' in raw else 0)
    raw = raw.split('/')[0].strip()
    try:
        v = float(raw)
    except ValueError:
        return None
    return v if 0 < v <= 5 else None


def parse_import_csv(path):
    """Yield feed-shaped entries from a one-off import file.

    Accepts either a Letterboxd data export (ratings.csv: Date, Name, Year,
    Letterboxd URI, Rating) or a minimal hand-typed file with a header of
    title,year,rating (optional date, url columns). Header names are matched
    case-insensitively.
    """
    with open(path, encoding='utf-8-sig', newline='') as fh:
        reader = csv.DictReader(fh)
        if not reader.fieldnames:
            raise ValueError('empty file')
        cols = {c.strip().lower(): c for c in reader.fieldnames if c}
        if 'name' in cols:            # Letterboxd export
            t, y, r = cols['name'], cols.get('year'), cols.get('rating')
            d, u = cols.get('date'), cols.get('letterboxd uri')
        elif 'title' in cols:         # hand-typed
            t, y, r = cols['title'], cols.get('year'), cols.get('rating')
            d, u = cols.get('date') or cols.get('watched'), cols.get('url')
        else:
            raise ValueError('header must include "Name" (Letterboxd export) or "title"')
        if not r:
            raise ValueError('no rating column')
        for row in reader:
            rating = parse_rating(row.get(r))
            title = (row.get(t) or '').strip()
            if not title or rating is None:
                continue
            try:
                year = int(str(row.get(y) or '').strip()[:4]) or None
            except ValueError:
                year = None
            yield {
                'title': title,
                'year': year,
                'tmdbId': None,
                'rating': rating,
                'watched': (row.get(d) or '').strip()[:10] if d else '',
                'url': (row.get(u) or '').strip() if u else '',
                'rewatch': False,
            }


# ---------------------------------------------------------------------------
# matching

class Matcher:
    def __init__(self, films):
        self.by_tmdb = {}
        self.by_title = {}
        for slug, rec in films:
            tid = rec.get('tmdbId')
            if isinstance(tid, (int, float)) and int(tid) > 0:
                self.by_tmdb[int(tid)] = slug
            elif isinstance(tid, str) and tid.strip().isdigit():
                self.by_tmdb[int(tid.strip())] = slug
            key = norm_title(rec.get('title'))
            if key:
                self.by_title.setdefault(key, []).append((slug, year_of(rec)))

    def match(self, entry):
        if entry['tmdbId'] and entry['tmdbId'] in self.by_tmdb:
            return self.by_tmdb[entry['tmdbId']], 'tmdb'
        cands = self.by_title.get(norm_title(entry['title']), [])
        ok = []
        for slug, rec_year in cands:
            if rec_year is not None:
                if entry['year'] is None or abs(entry['year'] - rec_year) <= YEAR_TOLERANCE:
                    ok.append((slug, rec_year))
            elif entry['year'] is None or entry['year'] >= SEASON_MIN_YEAR:
                ok.append((slug, rec_year))
        if len(ok) == 1:
            return ok[0][0], 'title'
        if len(ok) > 1 and entry['year'] is not None:
            ok.sort(key=lambda c: (abs((c[1] or entry['year']) - entry['year']), c[0]))
            return ok[0][0], 'title'
        return None, None


# ---------------------------------------------------------------------------
# main

def main():
    writers = load_json_dir(WRITERS_DIR)
    films = load_json_dir(FILMS_DIR)
    matcher = Matcher(films)
    _FILM_TITLES[:] = [(norm_title(rec.get('title')), slug) for slug, rec in films if rec.get('title')]
    log(f'{len(writers)} writer records, {len(films)} film records '
        f'({len(matcher.by_tmdb)} with tmdbId)')

    if os.path.exists(OUT_PATH):
        with open(OUT_PATH, encoding='utf-8') as fh:
            existing = json.load(fh)
    else:
        existing = {}
    films_out = json.loads(json.dumps(existing.get('films') or {}))  # deep copy

    unmatched = {}   # (title, year, tmdbId) -> set(handles)
    per_writer = []  # rows for the job summary
    feeds_ok = 0
    feeds_tried = 0

    for file_slug, w in writers:
        wslug = w.get('slug') or file_slug
        handle = handle_of(w)
        if not handle:
            continue
        feeds_tried += 1
        url = f'https://letterboxd.com/{handle}/rss/'
        try:
            xml_bytes = fetch(url)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
            log(f'  ! {wslug} ({handle}): fetch failed: {exc}')
            per_writer.append((wslug, handle, 'fetch failed', 0, 0))
            continue
        try:
            entries = list(parse_feed(xml_bytes))
        except ET.ParseError as exc:
            log(f'  ! {wslug} ({handle}): bad XML: {exc}')
            per_writer.append((wslug, handle, 'bad XML', 0, 0))
            continue
        feeds_ok += 1

        matched = 0
        changed = 0
        for e in entries:
            slug, how = matcher.match(e)
            if not slug:
                unmatched.setdefault((e['title'], e['year'], e['tmdbId']), set()).add(handle)
                continue
            matched += 1
            film = films_out.setdefault(slug, {'ratings': {}})
            film.setdefault('ratings', {})
            if e['tmdbId'] and not film.get('tmdbId'):
                film['tmdbId'] = e['tmdbId']
            prev = film['ratings'].get(wslug)
            # Newest diary entry wins; equal dates -> treat as the same log.
            if prev and prev.get('watched', '') > e['watched']:
                continue
            new = {'rating': e['rating'], 'watched': e['watched'], 'url': e['url']}
            if new != prev:
                film['ratings'][wslug] = new
                changed += 1
        per_writer.append((wslug, handle, f'{len(entries)} rated entries', matched, changed))
        log(f'  {wslug:24s} {handle:20s} entries={len(entries):3d} matched={matched:3d} changed={changed:3d}')

    # ---- one-off imports: content/staff-ratings-import/<writer-slug>.csv ----
    # Backfill for films logged before the feed window. Either a Letterboxd
    # data export (ratings.csv, renamed to the writer's slug) or a hand-typed
    # title,year,rating file. Imports only ADD — they never override a rating
    # the feed has already given us — so leaving the files in place is safe.
    writer_slugs = {(w.get('slug') or s): handle_of(w) or '' for s, w in writers}
    for fp in sorted(glob.glob(os.path.join(IMPORT_DIR, '*.csv'))):
        wslug = os.path.splitext(os.path.basename(fp))[0]
        if wslug not in writer_slugs:
            log(f'  ! import {os.path.basename(fp)}: no writer with slug "{wslug}" — skipped')
            per_writer.append((wslug, '(import)', 'unknown writer slug', 0, 0))
            continue
        try:
            rows = list(parse_import_csv(fp))
        except Exception as exc:  # noqa: BLE001
            log(f'  ! import {os.path.basename(fp)}: {exc}')
            per_writer.append((wslug, '(import)', f'unreadable: {exc}', 0, 0))
            continue
        handle = writer_slugs[wslug] or wslug
        matched = 0
        added = 0
        for e in rows:
            slug, how = matcher.match(e)
            if not slug:
                unmatched.setdefault((e['title'], e['year'], None), set()).add(handle)
                continue
            matched += 1
            film = films_out.setdefault(slug, {'ratings': {}})
            film.setdefault('ratings', {})
            if wslug in film['ratings']:
                continue  # feed already has it; feed wins
            film['ratings'][wslug] = {'rating': e['rating'], 'watched': e['watched'], 'url': e['url']}
            added += 1
        per_writer.append((wslug, '(import)', f'{len(rows)} rows in {os.path.basename(fp)}', matched, added))
        log(f'  {wslug:24s} {"(import)":20s} rows={len(rows):3d} matched={matched:3d} added={added:3d}')

    if feeds_tried and not feeds_ok:
        log('All feeds failed — leaving staff-ratings.json untouched.')
        write_summary(per_writer, unmatched, feeds_ok, feeds_tried, wrote=False)
        return 1

    # Stable ordering so diffs stay readable.
    films_sorted = {}
    for slug in sorted(films_out):
        rec = films_out[slug]
        rec['ratings'] = {k: rec['ratings'][k] for k in sorted(rec.get('ratings') or {})}
        films_sorted[slug] = {k: rec[k] for k in sorted(rec)}

    if films_sorted == (existing.get('films') or {}):
        log('No rating changes.')
        write_summary(per_writer, unmatched, feeds_ok, feeds_tried, wrote=False)
        return 0

    out = {
        'updated': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'letterboxd',
        'films': films_sorted,
    }
    with open(OUT_PATH, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    log(f'Wrote {os.path.relpath(OUT_PATH, ROOT)} ({len(films_sorted)} films).')
    write_summary(per_writer, unmatched, feeds_ok, feeds_tried, wrote=True)
    return 0


_FILM_TITLES = []  # [(normalized title, slug)] — filled in main() for hints


def closest_record(title):
    """Fuzzy hint for the summary: the tracked film whose title looks most
    like this one, if it's reasonably close. Never used for matching."""
    key = norm_title(title)
    best, score = None, 0.0
    for nt, slug in _FILM_TITLES:
        r = difflib.SequenceMatcher(None, key, nt).ratio()
        if r > score:
            best, score = slug, r
    return f'`{best}`?' if best and score >= 0.8 else ''


def write_summary(per_writer, unmatched, feeds_ok, feeds_tried, wrote):
    path = os.environ.get('GITHUB_STEP_SUMMARY')
    lines = [
        '## Staff ratings sync',
        '',
        f'Feeds: {feeds_ok}/{feeds_tried} fetched · '
        + ('**staff-ratings.json updated**' if wrote else 'no changes'),
        '',
        '| Writer | Handle | Feed | Matched | Changed |',
        '|---|---|---|---:|---:|',
    ]
    for wslug, handle, status, matched, changed in per_writer:
        lines.append(f'| {wslug} | `{handle}` | {status} | {matched} | {changed} |')
    # Unmatched entries are informational only — the sync never creates film
    # records. Older films are ignored outright; current-season titles are
    # listed (most-logged first) so a tracked film hiding under a different
    # Letterboxd title (e.g. "The Black Ball" for La Bola Negra) is easy to
    # spot and pin with a tmdbId.
    recent = {k: v for k, v in unmatched.items() if (k[1] or REPORT_MIN_YEAR) >= REPORT_MIN_YEAR}
    older = len(unmatched) - len(recent)
    if recent:
        lines += ['', f'### Current-season logs with no film record ({len(recent)})', '',
                  'Ignored unless one of these is actually a tracked film under another title — '
                  'then add `"tmdbId": <id>` to that `content/films/<slug>.json` and it attaches on the next run.', '',
                  '| Title | Year | TMDB id | Logged by | Closest record |', '|---|---|---|---|---|']
        for (title, year, tmdb), handles in sorted(recent.items(), key=lambda kv: (-len(kv[1]), (kv[0][0] or '').lower())):
            hint = closest_record(title)
            lines.append(f'| {title} | {year or ""} | {tmdb or ""} | {", ".join(sorted(handles))} | {hint} |')
    if older:
        lines += ['', f'_{older} older films logged by staff were ignored (pre-{REPORT_MIN_YEAR})._']
    text = '\n'.join(lines) + '\n'
    if path:
        with open(path, 'a', encoding='utf-8') as fh:
            fh.write(text)
    else:
        log('\n' + text)


if __name__ == '__main__':
    sys.exit(main())
