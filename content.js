/* ==========================================================================
   FANTASY FILMBALL — content.js (v25-prospects-polish)
   Reads /content/*.json and Markdown reviews, then populates each page.
   This is the runtime that turns the static site into a CMS-editable one.

   Sections handled here:
     • Ticker (top 20 films from rankings.json)
     • Best Picture rankings widget (top 15 with cutoff at 10)
     • YouTube embed (from site.json)
     • Homepage hero block (from the review marked isHero: true)
     • Review card grids on the homepage (latest 3 + "more" 8)
     • Reviews archive page (all reviews, newest first)
     • Single review page (?slug=... or falls back to hero)

   Reviews are discovered via the GitHub Contents API. This means we don't
   need a manifest file — drop a new .md file in /content/reviews/ via
   the CMS and it shows up everywhere automatically.
   ========================================================================== */

(function () {
  'use strict';

  // ---- helpers ------------------------------------------------------------

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  // Build a link that preserves the current ?snapshot= query param. Used so
  // that clicking from Oscar Race to a Category page (or vice versa) keeps
  // the user looking at the same historical snapshot.
  function withCurrentSnapshot(href) {
    try {
      var params = new URLSearchParams(window.location.search);
      var snap = params.get('snapshot');
      if (!snap) return href;
      var sep = href.indexOf('?') >= 0 ? '&' : '?';
      return href + sep + 'snapshot=' + encodeURIComponent(snap);
    } catch (e) { return href; }
  }

  function esc(s) {
    var div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  }

  /**
   * Render a review's title with the film name italicized.
   * Strategy:
   *   • If headline starts with the film name → italicize just the prefix.
   *     "Michael Jackson is off the wall" + film "Michael" →
   *       "<em>Michael</em> Jackson is off the wall"
   *   • If headline contains the film name elsewhere → italicize inline.
   *   • If headline is just the film name → italicize the whole thing.
   *   • If no headline → return italicized film name.
   *   • If no film → return raw headline (no italics).
   */
  function headlineHTML(film, headline) {
    var f = (film || '').trim();
    var h = (headline || '').trim();
    if (!h) return f ? '<strong>' + esc(f) + '</strong>' : '';
    if (!f) return esc(h);
    var fLower = f.toLowerCase();
    var hLower = h.toLowerCase();

    // Exact match
    if (hLower === fLower) return '<strong>' + esc(h) + '</strong>';

    // Headline starts with film (followed by a non-letter)
    if (hLower.indexOf(fLower) === 0 && !/^[a-z0-9]/i.test(h.charAt(f.length))) {
      return '<strong>' + esc(h.slice(0, f.length)) + '</strong>' + esc(h.slice(f.length));
    }

    // Headline contains film as a whole word
    var wordPat = new RegExp('\\b' + f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    var m = h.match(wordPat);
    if (m) {
      var i = h.toLowerCase().indexOf(m[0].toLowerCase());
      return esc(h.slice(0, i)) + '<strong>' + esc(h.slice(i, i + m[0].length)) + '</strong>' + esc(h.slice(i + m[0].length));
    }

    // Film name not in headline at all — show "Film — Headline"
    return '<strong>' + esc(f) + '</strong> — ' + esc(h);
  }

  function repoConfig() {
    var body = document.body;
    return {
      repo:   body.getAttribute('data-cms-repo')   || 'Brenfred/brenfred.github.io',
      branch: body.getAttribute('data-cms-branch') || 'main'
    };
  }

  function contentUrl(path) {
    var base = document.body.getAttribute('data-content-base') || 'content/';
    return base + path;
  }

  function fetchJSON(path) {
    return fetch(contentUrl(path), { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('Failed to load ' + path + ': ' + r.status);
        return r.json();
      });
  }

  function fetchText(url) {
    return fetch(url, { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('Failed to load ' + url + ': ' + r.status);
        return r.text();
      });
  }

  // ---- markdown front-matter parser --------------------------------------

  function parseFrontMatter(md) {
    var match = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!match) return { meta: {}, body: md };
    var meta = {};
    var bodyText = match[2];
    var lines = match[1].split('\n');

    // Parse a single scalar value: "quoted", numbers, booleans, plain strings.
    function parseScalar(val) {
      val = val.trim();
      if (val === '') return '';
      if (/^".*"$/.test(val) || /^'.*'$/.test(val)) return val.slice(1, -1);
      if (val === 'true')  return true;
      if (val === 'false') return false;
      if (/^-?\d+(\.\d+)?$/.test(val)) return parseFloat(val);
      return val;
    }

    // Parse inline list: [a, "b", c]  →  [a, b, c]
    function parseInlineList(val) {
      var inner = val.trim().slice(1, -1).trim();
      if (inner === '') return [];
      return inner.split(',').map(function (item) { return parseScalar(item); });
    }

    // Collect indented continuation lines (after a key with a value on same
    // line OR a block scalar indicator) — they all start with whitespace.
    function collectIndented(startIdx) {
      var collected = [];
      var k = startIdx;
      while (k < lines.length) {
        var nextLine = lines[k];
        if (nextLine === '') { collected.push(''); k++; continue; }
        if (!/^\s/.test(nextLine)) break;     // new top-level key
        collected.push(nextLine.replace(/^\s+/, '')); // strip leading whitespace
        k++;
      }
      // Trim trailing empty entries
      while (collected.length && collected[collected.length - 1] === '') {
        collected.pop();
      }
      return { lines: collected, nextIdx: k };
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.trim() || /^\s*#/.test(line)) continue;
      var idx = line.indexOf(':');
      if (idx === -1) continue;
      var key = line.slice(0, idx).trim();
      if (/^\s/.test(line)) continue;  // indented line — handled by parent key
      var rest = line.slice(idx + 1);
      var trimmedRest = rest.trim();

      // ---- Block scalar indicators: |, |-, |+, >, >-, >+ ----
      // > = folded (newlines → spaces), | = literal (newlines preserved)
      // The "-" or "+" controls trailing-newline behavior; we ignore both.
      var blockMatch = trimmedRest.match(/^([|>])([-+]?)$/);
      if (blockMatch) {
        var collected = collectIndented(i + 1);
        var joined = blockMatch[1] === '>'
          ? collected.lines.filter(function (l) { return l !== ''; }).join(' ')
          : collected.lines.join('\n');
        meta[key] = joined;
        i = collected.nextIdx - 1;
        continue;
      }

      // ---- Empty value: might be a multi-line list ----
      // Two flavors:
      //   (a) list of scalars     - item1
      //                           - item2
      //   (b) list of objects     - key1: val1
      //                             key2: val2
      //                           - key1: val1
      //                             key2: val2
      if (trimmedRest === '') {
        var items = [];
        var j = i + 1;

        // Detect indent of the FIRST dash so we know what "this list's" lines look like
        var firstDashLine = null;
        var jk = j;
        while (jk < lines.length) {
          if (lines[jk].trim() === '') { jk++; continue; }
          if (/^\s+-\s/.test(lines[jk])) { firstDashLine = lines[jk]; break; }
          if (!/^\s/.test(lines[jk])) break;   // hit a top-level key
          jk++;
        }
        var dashIndent = firstDashLine
          ? firstDashLine.match(/^(\s*)/)[1].length
          : -1;

        while (j < lines.length) {
          var next = lines[j];
          if (next.trim() === '') { j++; continue; }
          if (!/^\s/.test(next)) break;        // top-level key — end of list

          var dashMatch = next.match(/^(\s*)-\s+(.*)$/);
          if (dashMatch && dashMatch[1].length === dashIndent) {
            var afterDash = dashMatch[2];
            var colonAt = afterDash.indexOf(':');
            // OBJECT ITEM if there's a `key: value` after the dash
            if (colonAt !== -1 && /^[A-Za-z_][\w\-]*$/.test(afterDash.slice(0, colonAt).trim())) {
              var obj = {};
              var kkey = afterDash.slice(0, colonAt).trim();
              var kval = afterDash.slice(colonAt + 1).trim();
              obj[kkey] = parseScalar(kval);
              // collect subsequent indented (deeper than dashIndent) lines that
              // aren't themselves dashes — those are more fields of this object
              j++;
              while (j < lines.length) {
                var follow = lines[j];
                if (follow.trim() === '') { j++; continue; }
                var followIndent = follow.match(/^(\s*)/)[1].length;
                if (followIndent <= dashIndent) break;
                var followDash = follow.match(/^\s*-\s+/);
                if (followDash) break;       // another item in the list
                var fIdx = follow.indexOf(':');
                if (fIdx !== -1) {
                  var fk = follow.slice(0, fIdx).trim();
                  var fv = follow.slice(fIdx + 1).trim();
                  obj[fk] = parseScalar(fv);
                }
                j++;
              }
              items.push(obj);
            } else {
              // SCALAR ITEM
              items.push(parseScalar(afterDash));
              j++;
            }
          } else {
            j++;   // indented but not a top-level dash item — skip
          }
        }
        meta[key] = items;
        i = j - 1;
        continue;
      }

      // ---- Inline list: [a, b, c] ----
      if (/^\[.*\]$/.test(trimmedRest)) {
        meta[key] = parseInlineList(trimmedRest);
        continue;
      }

      // ---- Plain multi-line continuation ----
      // If the next line is indented (and not a list item), it continues this
      // value. E.g.   deck: First line of the deck
      //                 continued on the next indented line.
      var continuation = '';
      var jj = i + 1;
      while (jj < lines.length) {
        var nextLine = lines[jj];
        if (nextLine.trim() === '') break;
        if (!/^\s/.test(nextLine)) break;
        // Skip list-item lines — they belong to a list, not a continuation
        if (/^\s+-\s/.test(nextLine)) break;
        continuation += ' ' + nextLine.trim();
        jj++;
      }
      meta[key] = parseScalar(rest + continuation);
      i = jj - 1;
    }
    return { meta: meta, body: bodyText };
  }

  function mdToHtml(body) {
    // Parser with two states: text (markdown) and raw (passthrough HTML/SVG).
    // We split the body into "blocks" separated by blank lines, BUT if we're
    // currently inside an open raw-HTML element (figure, svg, div, table,
    // etc.), blank lines don't terminate the block — we keep accumulating
    // until we find the matching close tag.
    //
    // This lets writers leave blank lines inside SVG for readability without
    // breaking the passthrough.
    var OPEN_RAW_RE  = /^\s*<(figure|svg|div|section|table|iframe|blockquote|picture|video|audio|ul|ol|h[1-6])(\s|>)/i;
    var lines = body.split('\n');
    var blocks = [];
    var current = [];
    var rawTag = null;  // name of the open passthrough tag, if any
    var depthOfRaw = 0; // open-count of that tag (to handle nested)

    function flush() {
      if (current.length === 0) return;
      var text = current.join('\n');
      if (text.trim().length > 0) blocks.push({ raw: rawTag !== null, text: text });
      current = [];
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      if (rawTag === null) {
        // Not in a raw block. A blank line terminates the current text block.
        if (line.trim() === '') {
          flush();
          continue;
        }
        // Does this line start a new raw block?
        var openMatch = line.match(OPEN_RAW_RE);
        if (openMatch && current.length === 0) {
          // Start of a raw passthrough block
          rawTag = openMatch[1].toLowerCase();
          // Count open vs close occurrences of THIS tag on this line
          var openCount = countTagOccurrences(line, rawTag, true);
          var closeCount = countTagOccurrences(line, rawTag, false);
          depthOfRaw = openCount - closeCount;
          current.push(line);
          // If the raw block opens and closes on this same line, flush it now
          if (depthOfRaw <= 0) {
            flush();
            rawTag = null;
            depthOfRaw = 0;
          }
          continue;
        }
        // Regular markdown text line
        current.push(line);
      } else {
        // Inside an open raw block. Accumulate the line regardless of blanks.
        current.push(line);
        depthOfRaw += countTagOccurrences(line, rawTag, true);
        depthOfRaw -= countTagOccurrences(line, rawTag, false);
        if (depthOfRaw <= 0) {
          // Found the matching close — flush
          flush();
          rawTag = null;
          depthOfRaw = 0;
        }
      }
    }
    flush(); // catch trailing content

    return blocks.map(function (b) {
      if (b.raw) return b.text;
      // Markdown text → escape, format, wrap in <p>
      var html = esc(b.text);
      html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      html = html.replace(/(^|[^*])\*([^*]+)\*([^*]|$)/g, '$1<em>$2</em>$3');
      html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
      return '<p>' + html.replace(/\n/g, ' ') + '</p>';
    }).join('');
  }

  // Count opening or closing occurrences of a tag in a line.
  // Treats self-closing tags (<tag .../>) as both open and close (no-op for depth).
  function countTagOccurrences(line, tag, opening) {
    // Opening: <tag ...> or <tag>, but NOT <tag .../>
    // Closing: </tag>
    if (opening) {
      // Match <tag with word boundary; exclude self-closing
      var openRe = new RegExp('<' + tag + '(?:\\s[^>]*?)?>', 'gi');
      var selfRe = new RegExp('<' + tag + '(?:\\s[^>]*?)?/>', 'gi');
      var opens = (line.match(openRe) || []).length;
      var selfs = (line.match(selfRe) || []).length;
      return opens - selfs;
    } else {
      var closeRe = new RegExp('</' + tag + '\\s*>', 'gi');
      return (line.match(closeRe) || []).length;
    }
  }

  // ---- movement arrows ----------------------------------------------------

  function computeMovement(currentFilms, previousFilms) {
    var prevMap = {};
    previousFilms.forEach(function (f) {
      prevMap[f.title.toLowerCase()] = f.rank;
    });
    return currentFilms.map(function (f) {
      var prevRank = prevMap[f.title.toLowerCase()];
      var movement;
      if (prevRank == null)        movement = { kind: 'new',  delta: 0 };
      else if (prevRank > f.rank)  movement = { kind: 'up',   delta: prevRank - f.rank };
      else if (prevRank < f.rank)  movement = { kind: 'down', delta: f.rank - prevRank };
      else                         movement = { kind: 'flat', delta: 0 };
      return Object.assign({}, f, { movement: movement });
    });
  }

  function movementSpan(m, klass) {
    klass = klass || 'rankings__move';
    if (m.kind === 'new')  return '<span class="' + klass + ' ' + klass + '--new">NEW</span>';
    if (m.kind === 'up')   return '<span class="' + klass + ' ' + klass + '--up">▲ ' + m.delta + '</span>';
    if (m.kind === 'down') return '<span class="' + klass + ' ' + klass + '--down">▼ ' + m.delta + '</span>';
    return '<span class="' + klass + ' ' + klass + '--flat">—</span>';
  }

  // ---- ticker -------------------------------------------------------------

  function renderTicker(films) {
    var inner = $('.ticker__inner');
    if (!inner) return;
    var label = $('.ticker__label', inner);
    inner.innerHTML = '';
    if (label) inner.appendChild(label);

    function tickerHTML(f) {
      var m = f.movement;
      var moveHTML;
      if (m.kind === 'new')        moveHTML = '<span class="ticker__new">NEW</span>';
      else if (m.kind === 'up')    moveHTML = '<span class="ticker__up">▲ ' + m.delta + '</span>';
      else if (m.kind === 'down')  moveHTML = '<span class="ticker__down">▼ ' + m.delta + '</span>';
      else                         moveHTML = '<span class="ticker__flat">—</span>';
      // Wrap in an anchor when the film has a slug, plain span otherwise.
      // The anchor inherits all styling (no underline, same colors) — see
      // .ticker__item-link in style.css.
      var inner =
        '<span class="ticker__name">' + esc(f.title.toUpperCase()) + '</span>' +
        '<span class="ticker__price">' + esc(f.nomPct) + '</span>' +
        moveHTML;
      if (f.slug) {
        return (
          '<a href="film.html?slug=' + encodeURIComponent(f.slug) + '" class="ticker__item ticker__item-link">' +
            inner +
          '</a>'
        );
      }
      return '<span class="ticker__item">' + inner + '</span>';
    }
    var html = films.map(tickerHTML).join('') + films.map(tickerHTML).join('');
    inner.insertAdjacentHTML('beforeend', html);
  }

  // ---- rankings widget ---------------------------------------------------

  function renderRankings(films, cutoffRank, label) {
    var widget = $('.rankings');
    if (!widget) return;
    var top15 = films.slice(0, 15);

    var weekEl = $('.rankings__week', widget);
    if (weekEl && label) weekEl.textContent = label;

    // Foot: "JUNE 1 · COMMUNITY CONSENSUS" — derive a short upper-case date
    // from the snapshot's publishedDate ("June 1, 2026" → "JUNE 1").
    var footEl = $('[data-rankings-foot]', widget);
    if (footEl && label) {
      var shortDate = (label || '').replace(/,\s*\d{4}\s*$/, '').toUpperCase();
      footEl.textContent = shortDate + ' · COMMUNITY CONSENSUS';
    }

    $$('.rankings__row, .rankings__cutoff', widget).forEach(function (el) { el.remove(); });

    function rowHTML(f) {
      var rankClass = 'rankings__rank' + (f.rank === 1 ? ' rankings__rank--top' : '');
      return (
        '<div class="rankings__row">' +
          '<span class="' + rankClass + '">' + f.rank + '</span>' +
          '<span class="rankings__film">' + esc(f.title) + '</span>' +
          '<span class="rankings__odds">' + esc(f.nomPct) + '</span>' +
          movementSpan(f.movement) +
        '</div>'
      );
    }

    var foot = $('.rankings__foot', widget);
    var insertBefore = foot || null;
    top15.forEach(function (f) {
      var div = document.createElement('div');
      div.innerHTML = rowHTML(f).trim();
      var row = div.firstChild;
      widget.insertBefore(row, insertBefore);
      if (f.rank === cutoffRank) {
        var cutoff = document.createElement('div');
        cutoff.className = 'rankings__cutoff';
        cutoff.innerHTML = '<span>Projected Cutoff</span>';
        widget.insertBefore(cutoff, insertBefore);
      }
    });
  }

  // ---- Snapshot → legacy rankings adapter --------------------------------
  // The home page Best Picture widget AND the Oscar Race "Films" view both
  // predate the snapshot system; they were originally written against
  // rankings.json / rankings-previous.json (with `title` strings inline).
  // Rather than rewrite both renderers, we synthesize a rankings-shaped
  // object from the active snapshot's Best Picture category. That keeps a
  // single source of truth — every snapshot push updates all three views.
  function snapshotToRankings(snapshot, films) {
    if (!snapshot || !snapshot.categories || !snapshot.categories.picture) return null;
    var bp = snapshot.categories.picture;
    var filmMap = {};
    (films || []).forEach(function (f) { filmMap[f.slug] = f; });

    var entries = (bp.films || []).map(function (e) {
      var film = filmMap[e.filmSlug];
      return {
        rank: e.rank,
        slug: e.filmSlug,
        title: film ? film.title : (e.filmSlug || ''),
        nomPct: e.nomPct || '',
        winPct: e.winPct || ''
      };
    });

    return {
      films: entries,
      cutoffRank: bp.cutoffRank || 10,
      updatedDate: snapshot.publishedDate || ''
    };
  }

  // ---- YouTube embed ------------------------------------------------------

  function renderVideoEmbed(videoId) {
    var iframe = $('.podcast__embed iframe');
    if (!iframe || !videoId) return;
    iframe.src = 'https://www.youtube.com/embed/' + encodeURIComponent(videoId);
  }

  // ---- review discovery via GitHub API ----------------------------------

  function fetchReviewList() {
    var cfg = repoConfig();
    var apiUrl = 'https://api.github.com/repos/' + cfg.repo
               + '/contents/content/reviews?ref=' + cfg.branch;
    return fetch(apiUrl, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('GitHub API failed: ' + r.status);
      return r.json();
    }).then(function (files) {
      return files
        .filter(function (f) { return f.name && f.name.endsWith('.md'); })
        .map(function (f) {
          return {
            slug: f.name.replace(/\.md$/, ''),
            downloadUrl: f.download_url,
            sha: f.sha  // useful as a stable secondary sort key
          };
        });
    });
  }

  function parsePublishedDate(dateStr) {
    // Accepts formats like "April 3, 2026", "2026-04-03", "Apr 3 2026"
    if (!dateStr) return 0;
    var parsed = Date.parse(dateStr);
    if (!isNaN(parsed)) return parsed;
    return 0;
  }

  function fetchAllReviews() {
    return fetchReviewList().then(function (list) {
      // Each fetch+parse is independently wrapped — a single failure won't
      // sink the entire batch. We collect successes and warn on failures.
      return Promise.all(list.map(function (item) {
        return fetchText(item.downloadUrl).then(function (md) {
          try {
            var parsed = parseFrontMatter(md);
            return Object.assign(
              { slug: item.slug, _sha: item.sha },
              parsed.meta,
              { body: parsed.body }
            );
          } catch (err) {
            if (window.console) console.error('[content] failed to parse ' + item.slug + ':', err);
            return null;
          }
        }).catch(function (err) {
          if (window.console) console.error('[content] failed to fetch ' + item.slug + ':', err);
          return null;
        });
      })).then(function (results) {
        return results.filter(function (r) { return r !== null; });
      });
    }).then(function (reviews) {
      // Sort newest-first. Order of preference:
      //   1. Reviews with a publishable hero flag float to the top
      //   2. Reviews with a parseable publishedDate, newer first
      //   3. Reviews without a parseable date drop to the bottom,
      //      tiebroken alphabetically (so order is stable, not random)
      reviews.sort(function (a, b) {
        // Hero always wins
        if (a.isHero === true && b.isHero !== true) return -1;
        if (b.isHero === true && a.isHero !== true) return 1;

        var da = parsePublishedDate(a.publishedDate);
        var db = parsePublishedDate(b.publishedDate);
        if (db !== da) return db - da;

        // Fall back to slug alphabetical (stable, predictable)
        return (a.slug || '').localeCompare(b.slug || '');
      });
      return reviews;
    });
  }

  // ---- review-card rendering --------------------------------------------

  function renderStars(rating) {
    var full = Math.floor(rating);
    var hasHalf = (rating - full) >= 0.5;
    var stars = '';
    for (var i = 0; i < full; i++) stars += '★ ';
    if (hasHalf) stars += '<span class="star-half">½</span>';
    return stars.trim();
  }

  function reviewCardHTML(r, options) {
    options = options || {};
    // Stance: optional. Empty string (no stance) is preserved as empty —
    // don't default to "buy". The badge only renders for buy/hold/sell.
    var stance = (r.stance || '').toLowerCase();
    var hasStance = stance === 'buy' || stance === 'hold' || stance === 'sell';
    var badgeArrow = stance === 'sell' ? '▼' : stance === 'hold' ? '—' : '▲';
    var stanceLabel = r.stanceLabel || (stance === 'sell' ? 'Sell' : stance === 'hold' ? 'Hold' : 'Buy');
    var posterSlug = r.posterSlug || (r.film ? r.slug : '');
    var posterPath = posterSlug ? 'posters/' + posterSlug + '.jpg' : '';
    var film = (r.film || '').trim();
    var isDiscussion = (r.type || 'review').toLowerCase() === 'discussion';
    var rating = r.rating != null ? r.rating : 4.0;
    var stars = isDiscussion ? '' : renderStars(rating);
    var ratingChunk = isDiscussion
      ? ''
      : '<span class="rating">' + stars + ' <span class="rating__num">' + rating + '</span></span>';
    var headline = r.title || '';
    // Card excerpt: prefer the explicit excerpt/tagline; truncate if it's
    // way too long (CMS users sometimes paste body content here by mistake).
    var rawExcerpt = r.excerpt || r.deck || '';
    var excerpt = rawExcerpt.length > 160
      ? rawExcerpt.slice(0, 155).replace(/\s+\S*$/, '') + '…'
      : rawExcerpt;

    var kicker = '';
    if (options.showKicker) {
      var parts = [];
      if (r.studio) parts.push(r.studio);
      if (r.director) parts.push(r.director);
      if (r.publishedDate) parts.push(r.publishedDate);
      kicker = parts.join(' · ');
    }

    var foot;
    if (options.minimal) {
      foot = '';
    } else if (options.compact) {
      // Compact: rating on left, date on right. For discussions, show a
      // "Discussion" kicker on the left in place of stars.
      var leftChunk = isDiscussion
        ? '<span class="rating rating--discussion">◆ Discussion</span>'
        : ratingChunk;
      foot = '<div class="review-card__foot">' + leftChunk + '<span>' + esc(r.publishedDate || '') + '</span></div>';
    } else {
      var bylineStr = options.writersBySlug
        ? bylineHTML(r, options.writersBySlug)
        : 'By <strong>' + esc(r.writer || '[ Writer ]') + '</strong>';
      var leftChunkFull = isDiscussion
        ? '<span class="rating rating--discussion">◆ Discussion</span>'
        : ratingChunk;
      foot = '<div class="review-card__foot">' + leftChunkFull + '<span>' + bylineStr + '</span></div>';
    }

    // Title: italicize the film name where it appears in the headline
    var titleHTML = headlineHTML(film, headline);

    var imgInlineStyle = options.archive
      ? ' style="flex: 0 0 180px; width: 180px; max-width: 180px; margin-bottom: 0;"'
      : '';
    var textInlineStyle = options.archive
      ? ' style="flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 0.4rem;"'
      : '';

    var href = 'review.html?slug=' + encodeURIComponent(r.slug);

    // Stance badge on the poster: only when stance is explicitly set.
    // Discussions with `stance: ""` show no badge; discussions with a real
    // stance (rare but allowed) show one normally.
    var imageBadgeHTML = hasStance
      ? '<div class="review-card__badge-row"><span class="stock-badge stock-badge--' + esc(stance) + '">' + badgeArrow + ' ' + esc(stanceLabel) + '</span></div>'
      : '';

    var inner =
      '<a href="' + href + '" class="review-card__image"' + imgInlineStyle + '>' +
        imageBadgeHTML +
        '<img src="' + esc(posterPath) + '" alt="' + esc(film) + ' poster" class="review-card__poster" loading="lazy" onerror="this.style.display=\'none\'">' +
        '<div class="review-card__image-placeholder">' + esc(film) + '</div>' +
      '</a>' +
      '<div class="review-card__text"' + textInlineStyle + '>' +
        (kicker ? '<div class="review-card__kicker">' + esc(kicker) + '</div>' : '') +
        '<h3 class="review-card__title"><a href="' + href + '">' + titleHTML + '</a></h3>' +
        '<p class="review-card__excerpt">' + esc(excerpt) + '</p>' +
        foot +
      '</div>';

    // For .review-list cards (archive page), embed inline flex styles so the
    // horizontal layout is locked in regardless of CSS cache or specificity.
    var inlineStyle = options.archive
      ? ' style="display: flex; flex-direction: row; align-items: stretch; gap: 1.5rem;"'
      : '';
    return '<article class="review-card"' + inlineStyle + '>' + inner + '</article>';
  }

  // ---- homepage review grids --------------------------------------------

  function renderReviewGrids(reviews, writersBySlug) {
    $$('[data-reviews-grid]').forEach(function (grid) {
      var limit  = parseInt(grid.getAttribute('data-limit'), 10) || 6;
      var offset = parseInt(grid.getAttribute('data-offset'), 10) || 0;
      var heroSlug = (window.__filmball_hero_slug || '');
      var pool = reviews.filter(function (r) { return r.slug !== heroSlug; });
      var slice = pool.slice(offset, offset + limit);
      if (slice.length === 0) return;
      var compact = grid.classList.contains('review-grid--4');
      grid.innerHTML = slice.map(function (r) {
        return reviewCardHTML(r, { showKicker: !compact, compact: compact, writersBySlug: writersBySlug });
      }).join('\n');
    });
  }

  // ---- reviews archive page ---------------------------------------------

  // ---- reviews archive page ---------------------------------------------
  // A fresh, self-contained implementation. Uses archive-* class names that
  // don't share any styles with the review cards used on home/film/writer
  // pages. Everything visual is inline-styled or scoped to .archive-grid.

  function renderReviewsArchive(reviews, writersBySlug) {
    var grid = $('[data-reviews-list]');
    if (!grid) return;

    // Update the meta row: total count + breakdown by type
    var metaEl = $('[data-archive-meta]');
    if (metaEl) {
      var reviewCount = 0, discussionCount = 0;
      reviews.forEach(function (r) {
        if ((r.type || 'review') === 'discussion') discussionCount++;
        else reviewCount++;
      });
      var parts = [reviews.length + ' article' + (reviews.length !== 1 ? 's' : '')];
      if (reviewCount)     parts.push(reviewCount + ' review' + (reviewCount !== 1 ? 's' : ''));
      if (discussionCount) parts.push(discussionCount + ' discussion' + (discussionCount !== 1 ? 's' : ''));
      metaEl.textContent = parts.join(' · ');
    }

    function archiveCardHTML(r) {
      var type = (r.type || 'review').toLowerCase();
      var isDiscussion = type === 'discussion';

      // Stance: optional. Only render badge/styling if explicitly set.
      var stance = (r.stance || '').toLowerCase();
      var hasStance = stance === 'buy' || stance === 'hold' || stance === 'sell';
      var stanceLabel = r.stanceLabel || (stance === 'sell' ? 'Sell' : stance === 'hold' ? 'Hold' : 'Buy');
      var stanceArrow = stance === 'sell' ? '▼' : stance === 'hold' ? '—' : '▲';

      var film = r.film || '';
      var hasPoster = !!r.posterSlug;
      var posterPath = hasPoster ? 'posters/' + r.posterSlug + '.jpg' : '';

      // Rating: optional. Only show stars if explicitly set. Discussions
      // never show stars even if a rating value is present in the file.
      var hasRating = !isDiscussion && r.rating != null && r.rating !== '';
      var rating = hasRating ? r.rating : null;
      var stars = hasRating ? renderStars(rating) : '';

      var rawTagline = r.excerpt || r.deck || '';
      var tagline = rawTagline.length > 140
        ? rawTagline.slice(0, 135).replace(/\s+\S*$/, '') + '…'
        : rawTagline;

      var headline = r.title || '';
      var titleHTML = isDiscussion ? esc(headline) : headlineHTML(film || headline, headline);
      var bylineStr = writersBySlug
        ? bylineHTML(r, writersBySlug)
        : 'By <strong>' + esc(r.writer || '[ Writer ]') + '</strong>';
      var href = 'review.html?slug=' + encodeURIComponent(r.slug);

      // Kicker varies by type. Reviews show studio/director. Discussions show
      // category tags ("BEST DIRECTOR · BEST PICTURE") if any.
      var kickerParts = [];
      if (isDiscussion) {
        if (Array.isArray(r.categoryTags) && r.categoryTags.length) {
          kickerParts = r.categoryTags.map(function (slug) {
            return prettifyCategorySlug(slug);
          });
        } else {
          kickerParts.push('Discussion');
        }
      } else {
        if (r.studio)   kickerParts.push(r.studio);
        if (r.director) kickerParts.push(r.director);
      }
      var kicker = kickerParts.join(' · ');

      // Badge: stance badge for either type if stance is set.
      // For discussions without a stance, show a subtle "Discussion" tag.
      var badgeHTML = '';
      if (hasStance) {
        badgeHTML = '<span class="archive-card__badge archive-card__badge--' + esc(stance) + '">' +
          stanceArrow + ' ' + esc(stanceLabel) + '</span>';
      } else if (isDiscussion) {
        badgeHTML = '<span class="archive-card__badge archive-card__badge--discussion">' +
          '◆ Discussion</span>';
      }

      // Poster column: either real poster image OR typographic card with headline.
      var posterHTML;
      if (hasPoster) {
        posterHTML =
          '<a href="' + href + '" class="archive-card__poster">' +
            badgeHTML +
            '<img src="' + esc(posterPath) + '" alt="' + esc(film || headline) + ' poster" loading="lazy" onerror="this.style.display=\'none\'">' +
            '<div class="archive-card__poster-fallback">' + esc(film || headline) + '</div>' +
          '</a>';
      } else {
        // Typographic poster for discussions with no film image
        posterHTML =
          '<a href="' + href + '" class="archive-card__poster archive-card__poster--typo">' +
            badgeHTML +
            '<div class="archive-card__typo-stamp">' + esc((r.categoryTags && r.categoryTags[0]) ? prettifyCategorySlug(r.categoryTags[0]).toUpperCase() : 'OSCAR DESK') + '</div>' +
            '<div class="archive-card__typo-headline">' + esc(headline) + '</div>' +
          '</a>';
      }

      // Foot row: rating + byline. For discussions without rating, just byline.
      var footHTML = '<div class="archive-card__foot">';
      if (hasRating) {
        footHTML += '<span class="archive-card__rating">' + stars + ' <span>' + rating + '</span></span>';
      } else {
        footHTML += '<span class="archive-card__rating archive-card__rating--empty">—</span>';
      }
      footHTML += '<span class="archive-card__byline">' + bylineStr + '</span></div>';

      return '<article class="archive-card" data-type="' + esc(type) + '" data-stance="' + esc(stance || 'none') + '">' +
        posterHTML +
        '<div class="archive-card__body">' +
          (kicker ? '<div class="archive-card__kicker">' + esc(kicker) + '</div>' : '') +
          '<h3 class="archive-card__title"><a href="' + href + '">' + titleHTML + '</a></h3>' +
          (tagline ? '<p class="archive-card__tagline">' + esc(tagline) + '</p>' : '') +
          footHTML +
          (r.publishedDate ? '<div class="archive-card__date">' + esc(r.publishedDate) + '</div>' : '') +
        '</div>' +
      '</article>';
    }

    if (reviews.length === 0) {
      grid.innerHTML = '<p class="archive-empty">No articles published yet. Check back soon.</p>';
    } else {
      grid.innerHTML = reviews.map(archiveCardHTML).join('\n');
    }

    // ---- Filter logic: two independent groups (type, stance) ----
    var filterState = { type: 'all', stance: 'all' };

    function applyFilters() {
      var cards = grid.querySelectorAll('.archive-card');
      var shown = 0;
      for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        var cardType = card.getAttribute('data-type') || 'review';
        var cardStance = card.getAttribute('data-stance') || 'none';
        var typeMatch = filterState.type === 'all' || filterState.type === cardType;
        var stanceMatch = filterState.stance === 'all' || filterState.stance === cardStance;
        if (typeMatch && stanceMatch) {
          card.style.display = '';
          shown++;
        } else {
          card.style.display = 'none';
        }
      }
      if (window.console) {
        console.log('[archive] filter applied:', filterState, '→', shown + '/' + cards.length, 'visible');
      }
    }

    // Type buttons
    var typeButtons = document.querySelectorAll('[data-filter-type]');
    for (var t = 0; t < typeButtons.length; t++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          filterState.type = btn.getAttribute('data-filter-type');
          // Update is-active among type buttons only
          for (var k = 0; k < typeButtons.length; k++) {
            typeButtons[k].classList.toggle('is-active', typeButtons[k] === btn);
          }
          applyFilters();
        });
      })(typeButtons[t]);
    }

    // Stance buttons
    var stanceButtons = document.querySelectorAll('[data-filter-stance]');
    for (var s = 0; s < stanceButtons.length; s++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          filterState.stance = btn.getAttribute('data-filter-stance');
          for (var k = 0; k < stanceButtons.length; k++) {
            stanceButtons[k].classList.toggle('is-active', stanceButtons[k] === btn);
          }
          applyFilters();
        });
      })(stanceButtons[s]);
    }

    if (window.console) {
      console.log('[archive] wired', typeButtons.length, 'type buttons +', stanceButtons.length, 'stance buttons');
    }
  }

  // Turn a category slug into a display label.
  function prettifyCategorySlug(slug) {
    var map = {
      'picture':           'Best Picture',
      'director':          'Best Director',
      'actor':             'Best Actor',
      'actress':           'Best Actress',
      'supp-actor':        'Supp. Actor',
      'supp-actress':      'Supp. Actress',
      'orig-screenplay':   'Original Screenplay',
      'adapt-screenplay':  'Adapted Screenplay'
    };
    return map[slug] || slug;
  }

  // ---- homepage hero block ----------------------------------------------

  function renderHero(reviews, siteSettings, writersBySlug) {
    var heroBlock = $('[data-hero-review]');
    if (!heroBlock) return;

    var hero = null;
    if (siteSettings && siteSettings.heroReviewSlug) {
      hero = reviews.find(function (r) { return r.slug === siteSettings.heroReviewSlug; });
    }
    if (!hero) hero = reviews.find(function (r) { return r.isHero === true; });
    if (!hero) hero = reviews[0];
    if (!hero) return;

    window.__filmball_hero_slug = hero.slug;

    // For articles without an associated film (industry analysis, lists,
    // discussion pieces), `hero.film` is intentionally blank. Don't fall
    // back to slug — it would surface as "the-best-picture-blueprint" in
    // the headline.
    var film = (hero.film || '').trim();
    var stance = (hero.stance || '').toLowerCase();
    var hasStance = stance === 'buy' || stance === 'hold' || stance === 'sell';
    var stanceLabel = hero.stanceLabel || (stance === 'sell' ? 'Strong Sell' : stance === 'hold' ? 'Hold' : 'Strong Buy');
    var badgeArrow = stance === 'sell' ? '▼' : stance === 'hold' ? '—' : '▲';
    var hasRating = hero.rating != null && hero.rating !== '';
    var rating = hasRating ? hero.rating : null;
    // Poster: only when posterSlug or film is explicitly set. Otherwise
    // skip the image so the typographic placeholder shows nothing.
    var posterSlug = hero.posterSlug || (film ? hero.slug : '');
    var posterPath = posterSlug ? 'posters/' + posterSlug + '.jpg' : '';

    var img = $('.hero__poster', heroBlock);
    if (img) {
      if (posterPath) {
        img.src = posterPath;
        img.alt = (film || hero.title || '') + ' poster';
        img.style.display = '';
      } else {
        img.style.display = 'none';
      }
    }
    var placeholder = $('.hero__image-placeholder', heroBlock);
    if (placeholder) placeholder.textContent = film || '';

    var heroHref = 'review.html?slug=' + encodeURIComponent(hero.slug);

    var titleEl = $('.hero__title', heroBlock);
    if (titleEl) {
      titleEl.innerHTML = '<a href="' + heroHref + '" class="hero__title-link">' + headlineHTML(film, hero.title) + '</a>';
    }
    var deckEl = $('.hero__deck', heroBlock);
    if (deckEl) deckEl.textContent = hero.deck || hero.excerpt || '';

    var badge = $('.stock-badge', heroBlock);
    if (badge) {
      if (hasStance) {
        badge.className = 'stock-badge stock-badge--' + stance;
        badge.innerHTML = '<span class="stock-badge__arrow">' + badgeArrow + '</span> ' + esc(stanceLabel);
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
    }
    var ratingEl = $('.rating', heroBlock);
    if (ratingEl) {
      if (hasRating) {
        ratingEl.innerHTML = renderStars(rating) + ' <span class="rating__num">' + rating + ' / 5</span>';
        ratingEl.style.display = '';
      } else {
        ratingEl.style.display = 'none';
      }
    }
    var byline = $('.hero__byline', heroBlock);
    if (byline) {
      var bylineStr = writersBySlug
        ? bylineHTML(hero, writersBySlug)
        : 'By <strong>' + esc(hero.writer || '[ Writer ]') + '</strong>';
      byline.innerHTML = bylineStr + (hero.publishedDate ? ' · ' + esc(hero.publishedDate) : '');
    }
    var link = $('.hero__image', heroBlock);
    if (link) link.href = heroHref;
  }

  // ---- single review page -----------------------------------------------

  function renderSingleReview(reviews, siteSettings, writersBySlug, categories, films) {
    var body = $('[data-review-body]');
    if (!body) return;

    var params = new URLSearchParams(window.location.search);
    var requestedSlug = params.get('slug');
    var review = null;
    if (requestedSlug) {
      review = reviews.find(function (r) { return r.slug === requestedSlug; });
    }
    if (!review && siteSettings && siteSettings.heroReviewSlug) {
      review = reviews.find(function (r) { return r.slug === siteSettings.heroReviewSlug; });
    }
    if (!review) review = reviews.find(function (r) { return r.isHero === true; });
    if (!review) review = reviews[0];
    if (!review) return;

    // For articles without an associated film (e.g. discussion pieces,
    // industry analysis), `review.film` is intentionally blank. Don't fall
    // back to slug — it would surface as "the-best-picture-blueprint" in
    // headlines and breadcrumbs.
    var film = (review.film || '').trim();
    var stance = (review.stance || '').toLowerCase();
    var hasStance = stance === 'buy' || stance === 'hold' || stance === 'sell';
    var stanceLabel = review.stanceLabel || (stance === 'sell' ? 'Strong Sell' : stance === 'hold' ? 'Hold' : 'Strong Buy');
    var badgeArrow = stance === 'sell' ? '▼' : stance === 'hold' ? '—' : '▲';
    var rating = review.rating != null ? review.rating : null;
    var hasRating = rating != null && rating !== '';

    document.title = (review.title || (film ? film + ' Review' : 'Article')) + ' — Fantasy Filmball';

    // Articles without a film have nothing for the film-focused sidebar
    // (director, studio, by-the-numbers, prospects). Collapse the layout to
    // a single full-width column.
    var bodyGrid = $('.review__body');
    if (bodyGrid) {
      if (film) bodyGrid.classList.remove('review__body--no-aside');
      else      bodyGrid.classList.add('review__body--no-aside');
    }

    var crumb = $('[data-review-film]');
    if (crumb) crumb.textContent = film || (review.title || 'Article');

    var kicker = $('[data-review-kicker]');
    if (kicker) {
      var parts = [];
      if (review.genre) parts.push(review.genre);
      if (review.studio) parts.push(review.studio);
      kicker.textContent = parts.join(' · ');
    }

    var title = $('[data-review-title]');
    if (title) {
      title.innerHTML = headlineHTML(film, review.title);
    }

    var deck = $('[data-review-deck]');
    if (deck) deck.textContent = review.deck || '';

    var writer = $('[data-review-writer]');
    if (writer) {
      if (writersBySlug) {
        var people = resolveReviewWriters(review, writersBySlug);
        if (people.length > 0) {
          // Build inline writers list (without "By " prefix — the page already has it)
          var parts = people.map(function (p) {
            if (p._freetext || p._missing || !p.slug) return '<strong>' + esc(p.name) + '</strong>';
            return '<a href="writer.html?slug=' + encodeURIComponent(p.slug) + '" class="byline-link"><strong>' + esc(p.name) + '</strong></a>';
          });
          var bylineStr;
          if (parts.length === 1) bylineStr = parts[0];
          else if (parts.length === 2) bylineStr = parts[0] + ' & ' + parts[1];
          else bylineStr = parts.slice(0, -1).join(', ') + ', & ' + parts[parts.length - 1];
          writer.innerHTML = bylineStr;
        } else {
          writer.textContent = review.writer || '[ Writer ]';
        }
      } else {
        writer.textContent = review.writer || '[ Writer ]';
      }
    }

    var date = $('[data-review-date]');
    if (date) date.textContent = review.publishedDate || '';

    var isDiscussion = (review.type || 'review').toLowerCase() === 'discussion';

    var stars = $('[data-review-stars]');
    if (stars) stars.innerHTML = hasRating ? renderStars(rating) : '';

    var ratingNum = $('[data-review-rating-num]');
    if (ratingNum) ratingNum.textContent = hasRating ? (rating + ' / 5 STARS') : '';

    var badge = $('[data-review-badge]');
    if (badge) {
      if (hasStance) {
        badge.className = 'stock-badge stock-badge--' + stance;
        badge.innerHTML = '<span class="stock-badge__arrow">' + badgeArrow + '</span> ' + esc(stanceLabel);
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
    }

    // ---- Verdict block: optional ----
    // Shows whenever the article has either a stance OR a rating set.
    // Discussion pieces without either (e.g. festival analysis, lists) hide
    // the block entirely. Discussions WITH a stance show it normally.
    var verdictBlock = $('[data-review-verdict]');
    if (verdictBlock) {
      if (!hasStance && !hasRating) {
        verdictBlock.style.display = 'none';
      } else {
        verdictBlock.style.visibility = '';   // un-hide the initial placeholder state
        verdictBlock.style.display = '';
        var verdictNoteEl = $('[data-review-verdict-note]');
        if (verdictNoteEl) {
          if (review.verdictNote) {
            verdictNoteEl.textContent = '"' + review.verdictNote + '"';
            verdictNoteEl.style.display = '';
          } else {
            verdictNoteEl.style.display = 'none';
          }
        }
      }
    }

    // ---- Hero image: from CMS heroImage field, else hide block ----
    var heroBlock = $('[data-review-hero]');
    var heroImg = $('[data-review-hero-img]');
    var heroCaption = $('[data-review-hero-caption]');
    if (heroBlock) {
      if (review.heroImage) {
        if (heroImg) {
          heroImg.src = review.heroImage;
          heroImg.alt = film || review.title || '';
          heroImg.style.display = '';
          heroImg.onerror = function () {
            // If the uploaded image fails to load, hide the whole block
            // rather than showing a broken poster fallback.
            heroBlock.style.display = 'none';
          };
        }
        if (heroCaption) {
          heroCaption.textContent = review.heroCaption || '';
        }
        heroBlock.style.display = '';
      } else {
        // No hero image set — hide the entire hero block. Better to skip
        // it than to show an awkwardly cropped poster.
        heroBlock.style.display = 'none';
      }
    }
    // (Placeholder hero-title was removed — image now fills the frame.)

    if (body && review.body) {
      body.innerHTML = mdToHtml(review.body);
    }

    var director = $('[data-review-director]');
    if (director) director.textContent = review.director || '';
    var studio = $('[data-review-studio]');
    if (studio) studio.textContent = review.studio || '';

    // ---- Writer's Prospects ---------------------------------------------
    // The writer sets prospects as a list in the CMS — each entry has a
    // category, a tier (predicted / in-the-mix / long-shot), and optional
    // performer name + note. We group entries by tier and render them under
    // the writer's first name. If the list is empty, the whole block hides.
    var outlookEl = $('[data-review-outlook]');
    if (outlookEl) {
      var prospects = Array.isArray(review.prospects) ? review.prospects : [];

      // Always show the block. Resolve the writer's first name (used in the
      // title and in the empty-state message).
      outlookEl.style.display = '';
      var firstName = 'Writer';
      try {
        var prospPeople = (writersBySlug)
          ? resolveReviewWriters(review, writersBySlug)
          : [];
        if (prospPeople.length > 0 && prospPeople[0].name) {
          firstName = String(prospPeople[0].name).trim().split(/\s+/)[0] || 'Writer';
        } else if (review.writer) {
          firstName = String(review.writer).trim().split(/\s+/)[0] || 'Writer';
        }
      } catch (e) { /* leave default */ }

      var titleHTML = '<h3 class="aside-block__title">' + esc(firstName) + '&rsquo;s Prospects</h3>';

      if (prospects.length === 0) {
        // No prospects supplied — show block with an empty-state message.
        outlookEl.innerHTML = titleHTML +
          '<p class="aside-block__empty">No Predicted Oscar Prospects.</p>';
      } else {

        // Category slug → display label
        var CATEGORY_LABELS = {
          'picture':           'Best Picture',
          'director':          'Best Director',
          'actress':           'Best Actress',
          'actor':             'Best Actor',
          'supp-actress':      'Supp. Actress',
          'supp-actor':        'Supp. Actor',
          'orig-screenplay':   'Original Screenplay',
          'adapt-screenplay':  'Adapted Screenplay',
          'cinematography':    'Cinematography',
          'editing':           'Film Editing',
          'production-design': 'Production Design',
          'costume-design':    'Costume Design',
          'makeup-hair':       'Makeup & Hair',
          'sound':             'Sound',
          'vfx':               'Visual Effects',
          'score':             'Original Score',
          'song':              'Original Song',
          'casting':           'Casting',
          'international':     'International Feature',
          'animated':          'Animated Feature',
          'documentary':       'Documentary Feature',
          'doc-short':         'Documentary Short',
          'animated-short':    'Animated Short',
          'live-short':        'Live Action Short'
        };
        // Convert kebab-case slug → Title Case fallback for unknown categories.
        // This way if labels get out of sync (or a typo creeps in), the
        // sidebar still reads cleanly instead of showing raw slugs.
        function prettifyCategorySlug(slug) {
          return String(slug || '')
            .replace(/-/g, ' ')
            .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
        }
        // Tier slug → display + sort order
        var TIERS = [
          { key: 'predicted',  label: 'Predicted'  },
          { key: 'in-the-mix', label: 'In the Mix' },
          { key: 'long-shot',  label: 'Long Shot'  }
        ];

        // Bucket entries by tier
        var buckets = { 'predicted': [], 'in-the-mix': [], 'long-shot': [] };
        prospects.forEach(function (p) {
          if (!p || !p.category) return;
          var tier = p.tier || 'predicted';
          if (!buckets[tier]) buckets[tier] = [];
          buckets[tier].push(p);
        });

        // Render
        var html = titleHTML;
        TIERS.forEach(function (tier) {
          var entries = buckets[tier.key];
          if (!entries || entries.length === 0) return;
          html += '<div class="prospects__tier prospects__tier--' + tier.key + '">';
          html += '<div class="prospects__tier-label">' + esc(tier.label) + '</div>';
          html += '<ul class="prospects__list">';
          entries.forEach(function (p) {
            var catLabel = CATEGORY_LABELS[p.category] || prettifyCategorySlug(p.category);
            var perf = (p.performer || '').trim();
            var note = (p.note || '').trim();
            html += '<li class="prospects__item">';
            html += '<span class="prospects__cat">' + esc(catLabel) + '</span>';
            if (perf) html += ' <span class="prospects__perf">— ' + esc(perf) + '</span>';
            if (note) html += '<div class="prospects__note">' + esc(note) + '</div>';
            html += '</li>';
          });
          html += '</ul></div>';
        });

        outlookEl.innerHTML = html;
      }
    }

    // ---- By the Numbers (auto-computed from film record + BP rankings) -
    var numbersEl = $('[data-review-numbers]');
    if (numbersEl) {
      var filmRecord = (films || []).find(function (f) {
        return f.slug === (review.posterSlug || review.slug);
      });

      // Find the film in BP categories for Nom/Win %
      var bpCat = (categories || []).find(function (c) { return c.slug === 'picture'; });
      var bpRow = bpCat && (bpCat.current.films || []).find(function (r) {
        return r.filmSlug === (review.posterSlug || review.slug);
      });

      var numRows = [];
      var runtime = (filmRecord && filmRecord.runtime) || review.runtime || '';
      if (runtime) numRows.push({ label: 'Runtime', value: runtime, stat: true });

      var released = (filmRecord && filmRecord.releaseDate) || '';
      if (released) numRows.push({ label: 'Released', value: released, stat: true });

      if (bpRow) {
        if (bpRow.winPct) numRows.push({ label: 'B.P. Win %', value: bpRow.winPct, stat: true });
        if (bpRow.nomPct) numRows.push({ label: 'B.P. Nom %', value: bpRow.nomPct, stat: true });
        numRows.push({ label: 'FFB Rank', value: '#' + bpRow.rank + ' / ' + (bpCat.current.films || []).length, stat: true });
      }

      if (numRows.length === 0) {
        numbersEl.innerHTML =
          '<h3 class="aside-block__title">By the Numbers</h3>' +
          '<p class="aside-block__empty">Not currently in the Best Picture top 20.</p>';
      } else {
        // Mark community-derived rows so the footnote is contextually accurate
        var hasCommunityStats = !!bpRow;
        numbersEl.innerHTML =
          '<h3 class="aside-block__title">By the Numbers</h3>' +
          numRows.map(function (r) {
            var statClass = r.stat ? ' aside-block__value--stat' : '';
            return '<div class="aside-block__row">' +
              '<span class="aside-block__label">' + esc(r.label) + '</span>' +
              '<span class="aside-block__value' + statClass + '">' + esc(r.value) + '</span>' +
            '</div>';
          }).join('') +
          (hasCommunityStats
            ? '<p class="aside-block__footnote">Nom %, Win % &amp; FFB Rank are aggregated from the Filmball Discord community consensus.</p>'
            : '');
      }
    }

    // ---- More from this writer (other articles by the same byline) -----
    var relatedEl = $('[data-review-related]');
    var relatedTitleEl = $('[data-review-related-title]');
    if (relatedEl) {
      // Resolve writer slugs for the current review
      var currentWriters = [];
      try {
        var resolved = writersBySlug ? resolveReviewWriters(review, writersBySlug) : [];
        currentWriters = resolved.map(function (w) { return w.slug; }).filter(Boolean);
      } catch (e) { /* leave empty */ }

      // Resolve writer slug list for an arbitrary review (for matching)
      function writerSlugsFor(r) {
        var credits = creditSlugs(r);
        if (credits.length) {
          return credits;
        }
        // Older schema: single `writer` string. Try to match against the
        // writer name across the directory.
        if (r.writer && writersBySlug) {
          for (var slug in writersBySlug) {
            if (writersBySlug[slug] && writersBySlug[slug].name === r.writer) return [slug];
          }
        }
        return [];
      }

      // Filter: same writer, not this one
      var byWriter = (reviews || []).filter(function (r) {
        if (r.slug === review.slug) return false;
        var rs = writerSlugsFor(r);
        return rs.some(function (s) { return currentWriters.indexOf(s) !== -1; });
      });

      // Title — use the first writer's first name
      var firstWriterName = '';
      try {
        if (currentWriters.length && writersBySlug[currentWriters[0]]) {
          var fullName = writersBySlug[currentWriters[0]].name || '';
          firstWriterName = fullName.trim().split(/\s+/)[0] || '';
        }
      } catch (e) { /* ignore */ }

      if (relatedTitleEl) {
        relatedTitleEl.innerHTML = firstWriterName
          ? 'More from <em>' + esc(firstWriterName) + '</em>'
          : 'More <em>articles</em>';
      }

      if (byWriter.length === 0) {
        relatedEl.innerHTML = '<p style="grid-column: 1 / -1; color: var(--ink-faded); text-align: center; padding: 1rem 0;">' +
          (firstWriterName ? esc(firstWriterName) + ' hasn&rsquo;t published anything else yet.' : 'No other articles yet.') +
          '</p>';
      } else {
        // Sort newest-first by publishedDate (falls back to slug order if no date)
        byWriter.sort(function (a, b) {
          var ad = Date.parse(a.publishedDate || '') || 0;
          var bd = Date.parse(b.publishedDate || '') || 0;
          return bd - ad;
        });
        relatedEl.innerHTML = byWriter.slice(0, 3).map(function (r) {
          return reviewCardHTML(r, { showKicker: false, compact: true });
        }).join('\n');
      }
    }
  }

  // ============================================================
  //  CATEGORIES + FILMS — the Oscar Race system
  // ============================================================

  // List of category slugs (each snapshot file is expected to contain all 8)
  var CATEGORY_SLUGS = [
    'picture', 'director',
    'actress', 'actor',
    'supp-actress', 'supp-actor',
    'orig-screenplay', 'adapt-screenplay'
  ];

  // ---- snapshot fetching ------------------------------------------------
  // Snapshots live in /content/ranking-snapshots/*.json. Each one contains
  // all 8 categories for one moment in time. We fetch the directory listing
  // via the GitHub API, then load every snapshot in parallel.

  function fetchSnapshotList() {
    var cfg = repoConfig();
    var apiUrl = 'https://api.github.com/repos/' + cfg.repo
               + '/contents/content/ranking-snapshots?ref=' + cfg.branch;
    return fetch(apiUrl, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('GitHub API failed: ' + r.status);
      return r.json();
    }).then(function (files) {
      return files
        .filter(function (f) { return f.name && f.name.endsWith('.json'); })
        .map(function (f) {
          return {
            slug: f.name.replace(/\.json$/, ''),
            downloadUrl: f.download_url
          };
        });
    });
  }

  function fetchAllSnapshots() {
    return fetchSnapshotList().then(function (list) {
      return Promise.all(list.map(function (item) {
        return fetchText(item.downloadUrl).then(function (txt) {
          try {
            var parsed = JSON.parse(txt);
            // Use snapshotSlug from the JSON if present, else filename.
            if (!parsed.snapshotSlug) parsed.snapshotSlug = item.slug;
            return parsed;
          } catch (err) {
            if (window.console) console.error('[content] bad snapshot json:', item.slug, err);
            return null;
          }
        }).catch(function () { return null; });
      }));
    }).then(function (results) {
      var snapshots = results.filter(function (s) { return s !== null; });
      // Sort newest-first by sortKey (ascending lexicographic order works
      // because we mandate YYYY-MM format).
      snapshots.sort(function (a, b) {
        var ak = String(a.sortKey || '');
        var bk = String(b.sortKey || '');
        if (ak < bk) return 1;
        if (ak > bk) return -1;
        return 0;
      });
      return snapshots;
    });
  }

  // Convert one snapshot into the {slug, current, previous} shape that the
  // rest of the rendering code expects — for ALL 8 categories.
  function snapshotToCategoryArray(snapshot, previousSnapshot) {
    var out = [];
    CATEGORY_SLUGS.forEach(function (slug) {
      var current = snapshot.categories && snapshot.categories[slug];
      if (!current) return;
      var previous = previousSnapshot && previousSnapshot.categories && previousSnapshot.categories[slug];
      out.push({
        slug: slug,
        current: current,
        previous: previous || current  // fall back to identical so movement = flat
      });
    });
    return out;
  }

  // Pick which snapshot is "active" based on URL query param ?snapshot=slug.
  // Falls back to the newest snapshot. Returns { active, previous } where
  // `previous` is the snapshot immediately older than active (for movement).
  function pickActiveSnapshot(snapshots) {
    var params = new URLSearchParams(window.location.search);
    var requested = params.get('snapshot');
    var activeIdx = 0;  // default to newest (snapshots are sorted newest-first)
    if (requested) {
      for (var i = 0; i < snapshots.length; i++) {
        if (snapshots[i].snapshotSlug === requested) { activeIdx = i; break; }
      }
    }
    return {
      active: snapshots[activeIdx] || null,
      previous: snapshots[activeIdx + 1] || null,
      allSnapshots: snapshots,
      activeIndex: activeIdx
    };
  }

  // Master fetch — replaces the old fetchAllCategories. Returns an object:
  //   { categoryArray, allSnapshots, activeSnapshot, isHistorical }
  // categoryArray is the same shape the rest of the renders consume.
  function fetchSnapshotData() {
    return fetchAllSnapshots().then(function (snapshots) {
      if (snapshots.length === 0) {
        return { categoryArray: [], allSnapshots: [], activeSnapshot: null, previousSnapshot: null, activeIndex: -1 };
      }
      var pick = pickActiveSnapshot(snapshots);
      return {
        categoryArray: snapshotToCategoryArray(pick.active, pick.previous),
        allSnapshots: snapshots,
        activeSnapshot: pick.active,
        previousSnapshot: pick.previous,
        activeIndex: pick.activeIndex
      };
    });
  }

  // Backwards-compatible wrapper — code that just wants the category array.
  function fetchAllCategories() {
    return fetchSnapshotData().then(function (d) { return d.categoryArray; });
  }

  function computeCategoryMovement(current, previous, categorySlug) {
    // current.films and previous.films are arrays of {rank, filmSlug, subtitle, ...}
    //
    // Match by filmSlug only for non-acting categories — a film can't be
    // listed twice in Best Picture / Screenplay / Director, so the slug is
    // the unique key. Including the subtitle in the key would cause false
    // "NEW" flags when minor text changes (different ellipsis characters,
    // an added co-writer, capitalization) between snapshots.
    //
    // Acting categories CAN have the same film twice (different performers)
    // so we include a normalized version of the subtitle in the key.
    var slug = (categorySlug || '').toLowerCase();
    var isPersonCat = /^actor$|^actress$|^supp-actor$|^supp-actress$/.test(slug);

    function normSub(s) {
      return (s || '')
        .replace(/[\u2026]/g, '...')   // unicode ellipsis → ascii
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    }

    function keyOf(f) {
      if (isPersonCat) {
        return (f.filmSlug || '').toLowerCase() + '|' + normSub(f.subtitle);
      }
      return (f.filmSlug || '').toLowerCase();
    }

    var prevMap = {};
    (previous.films || []).forEach(function (f) { prevMap[keyOf(f)] = f.rank; });
    return (current.films || []).map(function (f) {
      var k = keyOf(f);
      var prevRank = prevMap[k];
      var movement;
      if (prevRank == null)        movement = { kind: 'new',  delta: 0 };
      else if (prevRank > f.rank)  movement = { kind: 'up',   delta: prevRank - f.rank };
      else if (prevRank < f.rank)  movement = { kind: 'down', delta: f.rank - prevRank };
      else                          movement = { kind: 'flat', delta: 0 };
      return Object.assign({}, f, { movement: movement });
    });
  }

  function fetchAllFilms() {
    // Discover all film files via the GitHub Contents API.
    var cfg = repoConfig();
    var apiUrl = 'https://api.github.com/repos/' + cfg.repo
               + '/contents/content/films?ref=' + cfg.branch;
    return fetch(apiUrl, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('GitHub API films/ failed: ' + r.status);
      return r.json();
    }).then(function (files) {
      var jsonFiles = files.filter(function (f) { return f.name && f.name.endsWith('.json'); });
      return Promise.all(jsonFiles.map(function (f) {
        return fetchText(f.download_url).then(function (txt) {
          var data = JSON.parse(txt);
          data.slug = f.name.replace(/\.json$/, '');
          return data;
        });
      }));
    });
  }

  // ---- Oscar Race page: categories grid ---------------------------------

  // ---- Snapshot toggle (Oscar Race + category pages) --------------------
  // Renders a dropdown/pill control of all available snapshots. Changing it
  // navigates to ?snapshot=<slug> which triggers a re-fetch.

  function renderSnapshotToggle(snapshotData) {
    var targets = document.querySelectorAll('[data-snapshot-toggle]');
    if (!targets.length) return;
    var snapshots = snapshotData.allSnapshots || [];
    if (snapshots.length === 0) return;

    var active = snapshotData.activeSnapshot;
    var prev = snapshotData.previousSnapshot;

    // Build the pill row: each snapshot is a pill. Active gets is-active.
    // The newest one is labeled "Current" for clarity.
    var pillsHTML = snapshots.map(function (s, idx) {
      var isActive = active && s.snapshotSlug === active.snapshotSlug;
      var isLatest = idx === 0;
      var hereUrl = window.location.pathname + window.location.search.replace(/[?&]snapshot=[^&]*/, '');
      // Build query: if this is the latest, omit the param to keep URLs clean.
      var query = isLatest
        ? hereUrl.replace(/\?$/, '')
        : (hereUrl.indexOf('?') >= 0 ? hereUrl + '&' : hereUrl + '?') + 'snapshot=' + encodeURIComponent(s.snapshotSlug);
      var classes = 'snapshot-pill' + (isActive ? ' is-active' : '') + (isLatest ? ' snapshot-pill--latest' : '');
      return '<a href="' + esc(query) + '" class="' + classes + '">' +
        (isLatest ? '<span class="snapshot-pill__tag">CURRENT</span>' : '') +
        '<span class="snapshot-pill__label">' + esc(s.label || s.snapshotSlug) + '</span>' +
        '<span class="snapshot-pill__date">' + esc(s.publishedDate || '') + '</span>' +
      '</a>';
    }).join('');

    var html =
      '<div class="snapshot-toggle__inner">' +
        '<div class="snapshot-toggle__label">Snapshot</div>' +
        '<div class="snapshot-toggle__pills">' + pillsHTML + '</div>' +
      '</div>';

    targets.forEach(function (t) { t.innerHTML = html; });
  }

  function renderCategoriesGrid(categories, films) {
    var grid = $('[data-categories-grid]');
    if (!grid) return;

    var filmMap = {};
    films.forEach(function (f) { filmMap[f.slug] = f; });

    var html = categories.map(function (cat) {
      var label = cat.current.shortLabel || cat.current.label;
      var withMove = computeCategoryMovement(cat.current, cat.previous, cat.slug);
      var top5 = withMove.slice(0, 5);

      var rows = top5.map(function (f) {
        // Display name: subtitle is primary (handles Best Actress/Actor),
        // film title as accent if filmSlug points at one.
        var nameHTML;
        var film = filmMap[f.filmSlug];
        var filmTitle = film ? film.title : '';
        if (f.subtitle && filmTitle) {
          nameHTML = '<strong>' + esc(f.subtitle) + '</strong> · <em>' + esc(filmTitle) + '</em>';
        } else if (filmTitle) {
          nameHTML = '<em>' + esc(filmTitle) + '</em>';
        } else {
          nameHTML = '<em>' + esc(f.subtitle || '') + '</em>';
        }
        var moveHTML = movementSpan(f.movement, 'category-table__move');
        return '<div class="category-table__row">' +
          '<span class="category-table__rank">' + f.rank + '</span>' +
          '<span class="category-table__name">' + nameHTML + '</span>' +
          moveHTML +
        '</div>';
      }).join('');

      var detailHref = withCurrentSnapshot('category.html?cat=' + encodeURIComponent(cat.slug));
      return '<a href="' + detailHref + '" class="category-table category-table--link">' +
        '<div class="category-table__head">' +
          '<span class="category-table__title">' + esc(label) + '</span>' +
          '<span class="category-table__count">Top 5 · See Top 10 →</span>' +
        '</div>' +
        rows +
      '</a>';
    }).join('\n');

    grid.innerHTML = html;
  }

  // ---- Oscar Race page: The Films section -------------------------------

  function renderFilmsSection(rankingsCurrent, rankingsPrevious, categories, films) {
    // Build a film lookup
    var filmMap = {};
    films.forEach(function (f) { filmMap[f.slug] = f; });

    // Helper to convert a ranked title (e.g. "The Odyssey") to a film slug.
    // rankings.json uses titles, so we need to map by title.
    function findFilmByTitle(title) {
      var lower = (title || '').toLowerCase();
      for (var i = 0; i < films.length; i++) {
        if ((films[i].title || '').toLowerCase() === lower) return films[i];
      }
      return null;
    }

    var bpFilms = (rankingsCurrent && rankingsCurrent.films) || [];

    // TIER 1 — top 10 as poster grid
    var tier1 = $('[data-films-grid="top10"]');
    if (tier1) {
      var top10HTML = bpFilms.slice(0, 10).map(function (r) {
        var film = findFilmByTitle(r.title);
        var slug = film ? film.slug : '';
        var poster = film ? film.posterSlug : '';
        var href = slug ? ('film.html?slug=' + encodeURIComponent(slug)) : '#';
        return '<a href="' + href + '" class="film-tile">' +
          '<div class="film-tile__image">' +
            (poster ? '<img src="posters/' + esc(poster) + '.jpg" alt="' + esc(r.title) + ' poster" loading="lazy" onerror="this.style.display=\'none\'">' : '') +
            '<div class="film-tile__rank">' + r.rank + '</div>' +
          '</div>' +
          '<div class="film-tile__title">' + esc(r.title) + '</div>' +
          '<div class="film-tile__meta">' + esc(r.nomPct) + ' Nom</div>' +
        '</a>';
      }).join('');
      tier1.innerHTML = top10HTML;
    }

    // TIER 2 — BP ranks #11-20 as a text list
    var tier2 = $('[data-films-list="next10"]');
    if (tier2) {
      var next10HTML = bpFilms.slice(10, 20).map(function (r) {
        var film = findFilmByTitle(r.title);
        var slug = film ? film.slug : '';
        var href = slug ? ('film.html?slug=' + encodeURIComponent(slug)) : '#';
        return '<a href="' + href + '" class="films-list__row">' +
          '<span class="films-list__rank">' + r.rank + '</span>' +
          '<span class="films-list__name">' + esc(r.title) + '</span>' +
          '<span class="films-list__meta">' + esc(r.nomPct) + '</span>' +
        '</a>';
      }).join('');
      tier2.innerHTML = next10HTML;
    }

    // TIER 3 — films appearing in any category's top 10 but NOT in BP top 20
    var tier3 = $('[data-films-list="contention"]');
    if (tier3) {
      var inBP20 = {};
      bpFilms.slice(0, 20).forEach(function (r) {
        var film = findFilmByTitle(r.title);
        if (film) inBP20[film.slug] = true;
      });

      var extraSlugs = {};
      categories.forEach(function (cat) {
        (cat.current.films || []).forEach(function (row) {
          if (row.filmSlug && !inBP20[row.filmSlug] && filmMap[row.filmSlug]) {
            if (!extraSlugs[row.filmSlug]) extraSlugs[row.filmSlug] = [];
            extraSlugs[row.filmSlug].push(cat.current.shortLabel || cat.current.label);
          }
        });
      });

      var extraSlugList = Object.keys(extraSlugs).sort(function (a, b) {
        return (filmMap[a].title || '').localeCompare(filmMap[b].title || '');
      });

      if (extraSlugList.length === 0) {
        tier3.innerHTML = '<p style="color: var(--ink-faded); text-align: center; padding: 1rem 0;">No additional films in contention this week.</p>';
      } else {
        var extraHTML = extraSlugList.map(function (slug) {
          var f = filmMap[slug];
          var cats = extraSlugs[slug].join(', ');
          var href = 'film.html?slug=' + encodeURIComponent(slug);
          return '<a href="' + href + '" class="films-list__row">' +
            '<span class="films-list__rank">—</span>' +
            '<span class="films-list__name">' + esc(f.title) + '</span>' +
            '<span class="films-list__meta">' + esc(cats) + '</span>' +
          '</a>';
        }).join('');
        tier3.innerHTML = extraHTML;
      }
    }
  }

  // ---- Category detail page (category.html?cat=...) ---------------------

  function renderCategoryDetail(categories, films, reviews) {
    if (!$('[data-category-detail]')) return;

    var params = new URLSearchParams(window.location.search);
    var slug = params.get('cat') || 'picture';
    var cat = categories.find(function (c) { return c.slug === slug; });
    if (!cat) {
      $('[data-category-detail]').innerHTML = '<p style="text-align:center;padding:3rem 0;">Category not found.</p>';
      return;
    }

    var filmMap = {};
    films.forEach(function (f) { filmMap[f.slug] = f; });

    var withMove = computeCategoryMovement(cat.current, cat.previous, cat.slug);

    // Header bits
    document.title = (cat.current.label || 'Category') + ' — Fantasy Filmball';
    var label = $('[data-cat-label]');       if (label) label.textContent = cat.current.label;
    var labelT = $('[data-cat-label-title]'); if (labelT) labelT.textContent = cat.current.label;
    var kicker = $('[data-cat-kicker]');
    var listLength = (cat.current.films || []).length;
    if (kicker) kicker.textContent = '★ ' + cat.current.label + ' · Top ' + listLength + ' ★';

    // Render full list (10 for most categories, 20 for Best Picture)
    var html = '<div class="category-detail__table">' +
      '<div class="category-detail__head">' +
        '<span>Rank</span>' +
        '<span>Contender</span>' +
        '<span>Nom %</span>' +
        '<span>Win %</span>' +
        '<span>Move</span>' +
      '</div>' +
      withMove.map(function (f) {
        var film = filmMap[f.filmSlug];
        var filmTitle = film ? film.title : '';
        var posterPath = film ? ('posters/' + film.posterSlug + '.jpg') : '';
        var poster = posterPath
          ? '<img src="' + esc(posterPath) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">'
          : '';
        var nameHTML;
        if (f.subtitle && filmTitle) {
          nameHTML = '<strong>' + esc(f.subtitle) + '</strong><span class="category-detail__sub"><em>' + esc(filmTitle) + '</em></span>';
        } else if (filmTitle) {
          nameHTML = '<em>' + esc(filmTitle) + '</em>';
        } else {
          nameHTML = esc(f.subtitle || '[ TBD ]');
        }
        var href = film ? ('film.html?slug=' + encodeURIComponent(film.slug)) : null;
        var nameCell = href
          ? '<a href="' + href + '" class="category-detail__name">' + nameHTML + '</a>'
          : '<span class="category-detail__name">' + nameHTML + '</span>';
        var rankClass = 'category-detail__rank' + (f.rank === 1 ? ' category-detail__rank--top' : '');

        var rowContent =
          '<span class="' + rankClass + '">' + f.rank + '</span>' +
          '<span class="category-detail__film">' + poster + nameCell + '</span>' +
          '<span class="category-detail__stat">' + esc(f.nomPct || '—') + '</span>' +
          '<span class="category-detail__stat">' + esc(f.winPct || '—') + '</span>' +
          movementSpan(f.movement, 'category-table__move');

        var cutoff = (f.rank === (cat.current.cutoffRank || 5))
          ? '<div class="category-detail__cutoff"><span>Predicted Cutoff</span></div>'
          : '';

        return '<div class="category-detail__row">' + rowContent + '</div>' + cutoff;
      }).join('') +
    '</div>';

    $('[data-category-detail]').innerHTML = html;
  }

  // ---- Film detail page (film.html?slug=...) ----------------------------

  function renderFilmDetail(categories, films, reviews, writersBySlug) {
    var profile = $('[data-film-profile]');
    if (!profile) return;

    var params = new URLSearchParams(window.location.search);
    var slug = params.get('slug') || '';
    var film = films.find(function (f) { return f.slug === slug; });
    if (!film) {
      profile.innerHTML = '<p style="text-align:center;padding:3rem 0;">Film not found.</p>';
      return;
    }

    document.title = film.title + ' — Fantasy Filmball';

    // Update breadcrumb
    var crumb = $('[data-film-title]');
    if (crumb) crumb.textContent = film.title;

    // Profile header
    var posterPath = 'posters/' + film.posterSlug + '.jpg';
    profile.innerHTML =
      '<div class="film-profile__grid">' +
        '<div class="film-profile__poster">' +
          '<img src="' + esc(posterPath) + '" alt="' + esc(film.title) + ' poster" onerror="this.style.display=\'none\'">' +
        '</div>' +
        '<div class="film-profile__info">' +
          '<div class="kicker kicker--gold">★ Tracked Film ★</div>' +
          '<h1 class="film-profile__title"><em>' + esc(film.title) + '</em></h1>' +
          (film.director ? '<div class="film-profile__meta"><strong>Directed by</strong> ' + esc(film.director) + '</div>' : '') +
          (film.studio   ? '<div class="film-profile__meta"><strong>Distributed by</strong> ' + esc(film.studio) + '</div>' : '') +
          (film.releaseDate ? '<div class="film-profile__meta"><strong>Release</strong> ' + esc(film.releaseDate) + '</div>' : '') +
          (film.runtime ? '<div class="film-profile__meta"><strong>Runtime</strong> ' + esc(film.runtime) + '</div>' : '') +
        '</div>' +
      '</div>';

    // Find every category appearance
    var appearances = [];
    categories.forEach(function (cat) {
      var withMove = computeCategoryMovement(cat.current, cat.previous, cat.slug);
      withMove.forEach(function (row) {
        if (row.filmSlug === film.slug) {
          appearances.push({
            category: cat.current,
            slug: cat.slug,
            row: row
          });
        }
      });
    });

    var categoriesEl = $('[data-film-categories]');
    if (categoriesEl) {
      if (appearances.length === 0) {
        categoriesEl.innerHTML = '<p style="color: var(--ink-faded); text-align: center; padding: 1rem 0;">Not currently ranked in any category.</p>';
      } else {
        appearances.sort(function (a, b) { return a.row.rank - b.row.rank; });
        categoriesEl.innerHTML = appearances.map(function (a) {
          var href = 'category.html?cat=' + encodeURIComponent(a.slug);
          return '<a href="' + href + '" class="film-category-row">' +
            '<span class="film-category-row__label">' + esc(a.category.label) + '</span>' +
            '<span class="film-category-row__rank">#' + a.row.rank + '</span>' +
            (a.row.subtitle ? '<span class="film-category-row__sub">' + esc(a.row.subtitle) + '</span>' : '<span></span>') +
            '<span class="film-category-row__stat">' + esc(a.row.nomPct || '—') + ' Nom</span>' +
            '<span class="film-category-row__stat">' + esc(a.row.winPct || '—') + ' Win</span>' +
            movementSpan(a.row.movement, 'category-table__move') +
          '</a>';
        }).join('');
      }
    }

    // Tagged reviews
    var articlesEl = $('[data-film-articles]');
    if (articlesEl) {
      var tagged = (reviews || []).filter(function (r) {
        return Array.isArray(r.tags) && r.tags.indexOf(film.slug) !== -1;
      });
      if (tagged.length === 0) {
        articlesEl.innerHTML = '<p style="color: var(--ink-faded); text-align: center; padding: 1rem 0; grid-column: 1 / -1;">No articles tagged with this film yet.</p>';
      } else {
        articlesEl.innerHTML = tagged.map(function (r) {
          return reviewCardHTML(r, { showKicker: true, writersBySlug: writersBySlug });
        }).join('\n');
      }
    }
  }

  // ============================================================
  //  WRITERS — writer records + writer detail page + directory
  // ============================================================

  function fetchAllWriters() {
    var cfg = repoConfig();
    var apiUrl = 'https://api.github.com/repos/' + cfg.repo
               + '/contents/content/writers?ref=' + cfg.branch;
    return fetch(apiUrl, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('GitHub API writers/ failed: ' + r.status);
      return r.json();
    }).then(function (files) {
      var jsonFiles = files.filter(function (f) { return f.name && f.name.endsWith('.json'); });
      return Promise.all(jsonFiles.map(function (f) {
        return fetchText(f.download_url).then(function (txt) {
          var data = JSON.parse(txt);
          data.slug = data.slug || f.name.replace(/\.json$/, '');
          return data;
        });
      }));
    }).catch(function (err) {
      // If no writers/ folder yet, return empty so pages still work
      if (window.console) console.warn('[content] no writers:', err.message);
      return [];
    });
  }

  // Build initials for monogram-style avatar fallbacks
  function writerInitials(name) {
    if (!name) return '?';
    var parts = name.replace(/[\[\]]/g, '').trim().split(/\s+/);
    if (parts.length === 1) return (parts[0][0] || '?').toUpperCase();
    return ((parts[0][0] || '') + (parts[parts.length - 1][0] || '')).toUpperCase();
  }

  // Render an avatar — headshot if available, monogram fallback
  function writerAvatarHTML(writer, klass) {
    klass = klass || 'writer-card__avatar';
    // Resolve image path. Three formats are accepted, in priority order:
    //   1. writer.headshot — set by the new CMS image widget, full path like
    //      "/headshots/dylan.jpg" (or whatever the CMS stored).
    //   2. writer.headshotSlug — legacy text field, just the filename stub.
    //   3. writer.slug — final fallback, matches /headshots/<slug>.jpg.
    var src;
    if (writer.headshot) {
      src = writer.headshot;
    } else if (writer.headshotSlug) {
      src = 'headshots/' + writer.headshotSlug + '.jpg';
    } else if (writer.slug) {
      src = 'headshots/' + writer.slug + '.jpg';
    } else {
      src = '';
    }
    // <img> with monogram-fallback via onerror — if no image is uploaded
    // (or the file is missing), the inline monogram shows through.
    return '<div class="' + klass + '">' +
      '<img src="' + esc(src) + '" alt="' + esc(writer.name || '') + '" class="' + klass + '-img" onerror="this.style.display=\'none\'; this.parentNode.classList.add(\'' + klass + '--no-img\')">' +
      '<span class="' + klass + '-monogram">' + esc(writerInitials(writer.name)) + '</span>' +
    '</div>';
  }

  // Resolve a review's writers (slugs) to writer records.
  // Falls back to a synthetic "freetext" writer if only the old `writer` field is set.
  function resolveReviewWriters(review, writersBySlug) {
    var slugs = Array.isArray(review.writers) ? review.writers : [];
    var resolved = [];
    slugs.forEach(function (s) {
      if (writersBySlug[s]) {
        resolved.push(writersBySlug[s]);
      } else if (window.console) {
        console.warn('[content] writer slug not found: "' + s + '" (referenced by review "' +
          review.slug + '"). Available writers: ' +
          Object.keys(writersBySlug).join(', '));
        // Show the slug itself so the bug is visible in the UI, not hidden as [ Writer ]
        resolved.push({ name: '[' + s + ']', slug: null, _missing: true });
      }
    });
    if (resolved.length > 0) return resolved;
    // Fallback: use the old `writer` free-text field
    if (review.writer) {
      return [{ name: review.writer, slug: null, _freetext: true }];
    }
    return [];
  }

  // Compose a clickable byline string (HTML) for cards/articles
  function bylineHTML(review, writersBySlug) {
    var people = resolveReviewWriters(review, writersBySlug);
    if (people.length === 0) return 'By <strong>[ Writer ]</strong>';
    var parts = people.map(function (p) {
      if (p._freetext || p._missing || !p.slug) return '<strong>' + esc(p.name) + '</strong>';
      return '<a href="writer.html?slug=' + encodeURIComponent(p.slug) +
             '" class="byline-link"><strong>' + esc(p.name) + '</strong></a>';
    });
    if (parts.length === 1) return 'By ' + parts[0];
    if (parts.length === 2) return 'By ' + parts[0] + ' & ' + parts[1];
    return 'By ' + parts.slice(0, -1).join(', ') + ', & ' + parts[parts.length - 1];
  }

  // ---- writers.html — directory page ----------------------------------

  // ---- home page Co-GMs block (pulls hosts from writers) ---------------

  function renderHomeHosts(writers) {
    var container = $('[data-home-hosts]');
    if (!container) return;

    // "Host" in role → counts as a Co-GM. Sort alphabetically for stability.
    var hosts = (writers || []).filter(function (w) {
      return (w.role || '').toLowerCase().indexOf('host') !== -1;
    });
    hosts.sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });

    if (hosts.length === 0) {
      container.innerHTML = '<p style="color: var(--ink-faded); padding: 1rem 0; grid-column: 1 / -1;">' +
        'Hosts coming soon.</p>';
      return;
    }

    container.innerHTML = hosts.map(function (w) {
      var avatar = writerAvatarHTML(w, 'host__avatar');
      var href = 'writer.html?slug=' + encodeURIComponent(w.slug);
      return '<a href="' + href + '" class="host">' +
        avatar +
        '<div>' +
          '<div class="host__role">' + esc(w.role || 'Co-Host') + '</div>' +
          '<h3 class="host__name">' + esc(w.name || '') + '</h3>' +
          '<p class="host__bio">' + esc(w.bio || '') + '</p>' +
        '</div>' +
      '</a>';
    }).join('');
  }

  // Slugs a review is credited to for WRITER-PAGE association: bylined authors
  // (writers[]) plus non-byline contributors[] (e.g. awards-ballot voters). The
  // byline itself still uses writers[] only, so contributors surface on writer
  // pages without changing the displayed byline.
  function creditSlugs(r) {
    var out = [];
    if (Array.isArray(r.writers)) out = out.concat(r.writers.filter(Boolean));
    if (Array.isArray(r.contributors)) out = out.concat(r.contributors.filter(Boolean));
    return out;
  }

  function renderWritersDirectory(writers, reviews) {
    var hostsContainer = $('[data-writers-hosts]');
    var gridContainer  = $('[data-writers-grid]');
    var countEl        = $('[data-writers-count]');

    if (!hostsContainer && !gridContainer) return;

    // Split: anyone whose role contains "Host" is a host, others are contributors
    var hosts = writers.filter(function (w) {
      return (w.role || '').toLowerCase().indexOf('host') !== -1;
    });
    var contributors = writers.filter(function (w) {
      return (w.role || '').toLowerCase().indexOf('host') === -1;
    });

    // Sort each group alphabetically by name
    function nameCmp(a, b) { return (a.name || '').localeCompare(b.name || ''); }
    hosts.sort(nameCmp);

    // Contributors: editors (Lead Editor, Editor, etc.) come first as a group,
    // then everyone else. Within each group, alphabetical by name.
    function isEditor(w) {
      return /editor/i.test(w.role || '');
    }
    contributors.sort(function (a, b) {
      var ea = isEditor(a), eb = isEditor(b);
      if (ea && !eb) return -1;
      if (!ea && eb) return 1;
      return nameCmp(a, b);
    });

    if (countEl) {
      countEl.textContent = hosts.length + ' host' + (hosts.length !== 1 ? 's' : '') +
                            ' · ' + contributors.length + ' contributor' + (contributors.length !== 1 ? 's' : '');
    }

    // Article counts per writer (used in tiles)
    var counts = {};
    (reviews || []).forEach(function (r) {
      creditSlugs(r).forEach(function (s) {
        counts[s] = (counts[s] || 0) + 1;
      });
    });

    // ---- Hosts: bigger horizontal cards with bio ----
    if (hostsContainer) {
      if (hosts.length === 0) {
        hostsContainer.innerHTML = '<p style="color: var(--ink-faded); padding: 1rem 0;">Hosts coming soon.</p>';
      } else {
        hostsContainer.innerHTML = hosts.map(function (w) {
          var avatar = writerAvatarHTML(w, 'host__avatar');
          var href = 'writer.html?slug=' + encodeURIComponent(w.slug);
          return '<a href="' + href + '" class="host">' +
            avatar +
            '<div>' +
              '<div class="host__role">' + esc(w.role || '') + '</div>' +
              '<h3 class="host__name">' + esc(w.name || '') + '</h3>' +
              '<p class="host__bio">' + esc(w.bio || '') + '</p>' +
            '</div>' +
          '</a>';
        }).join('');
      }
    }

    // ---- Contributors: smaller card grid ----
    if (gridContainer) {
      if (contributors.length === 0) {
        gridContainer.innerHTML = '<p style="color: var(--ink-faded); padding: 1rem 0; grid-column: 1 / -1;">No contributing writers yet.</p>';
      } else {
        gridContainer.innerHTML = contributors.map(function (w) {
          var avatar = writerAvatarHTML(w, 'writer-card__avatar');
          var n = counts[w.slug] || 0;
          var href = 'writer.html?slug=' + encodeURIComponent(w.slug);
          return '<a href="' + href + '" class="writer-card">' +
            avatar +
            '<div class="writer-card__name">' + esc(w.name || '') + '</div>' +
            '<div class="writer-card__role">' + esc(w.role || '') + '</div>' +
            '<p class="writer-card__bio">' + esc(w.bio || '') + '</p>' +
            (n > 0 ? '<div class="writer-card__count">' + n + ' article' + (n !== 1 ? 's' : '') + '</div>' : '') +
          '</a>';
        }).join('');
      }
    }
  }

  // ---- writer.html — detail page ---------------------------------------

  function renderWriterDetail(writers, reviews) {
    var profile = $('[data-writer-profile]');
    if (!profile) return;

    var params = new URLSearchParams(window.location.search);
    var slug = params.get('slug') || '';
    var writer = writers.find(function (w) { return w.slug === slug; });
    if (!writer) {
      profile.innerHTML = '<p style="text-align:center;padding:3rem 0;">Writer not found.</p>';
      return;
    }

    document.title = (writer.name || 'Writer') + ' — Fantasy Filmball';
    var nameEl = $('[data-writer-name]');
    if (nameEl) nameEl.textContent = writer.name || '';

    var avatar = writerAvatarHTML(writer, 'writer-profile__avatar');

    // Longer bio: if longBio missing, fall back to bio
    var longBio = writer.longBio || writer.bio || '';
    var bioHTML = longBio.split(/\n\s*\n/).filter(function (p) {
      return p.trim().length > 0;
    }).map(function (p) {
      return '<p>' + esc(p.replace(/\n/g, ' ')) + '</p>';
    }).join('');

    var pullQuote = writer.pullQuote
      ? '<blockquote class="writer-profile__quote">' + esc(writer.pullQuote) + '</blockquote>'
      : '';

    // Build social links — accepts a bare handle, '@handle', or a full URL.
    function socialLink(raw, baseUrl) {
      if (!raw) return '';
      var s = String(raw).trim();
      // If it's already a URL, use it as-is
      if (/^https?:\/\//i.test(s)) {
        var displayLabel = s.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
        return '<a href="' + esc(s) + '" target="_blank" rel="noopener">' + esc(displayLabel) + '</a>';
      }
      // Otherwise treat as a handle. Strip leading @ for the URL but keep it for display.
      var handle = s.replace(/^@/, '');
      var display = '@' + handle;
      var url = baseUrl + encodeURIComponent(handle);
      return '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(display) + '</a>';
    }

    var meta = [];
    if (writer.joinedDate)  meta.push('<dt>Joined</dt><dd>' + esc(writer.joinedDate) + '</dd>');
    if (writer.twitter)     meta.push('<dt>Twitter / X</dt><dd>' + socialLink(writer.twitter, 'https://x.com/') + '</dd>');
    if (writer.letterboxd)  meta.push('<dt>Letterboxd</dt><dd>' + socialLink(writer.letterboxd, 'https://letterboxd.com/') + '</dd>');

    var favorites = Array.isArray(writer.favorites) && writer.favorites.length
      ? '<div class="writer-profile__favorites">' +
          '<div class="writer-profile__fav-title">Films on the desk</div>' +
          '<ul>' + writer.favorites.map(function (f) {
            return '<li><em>' + esc(f) + '</em></li>';
          }).join('') + '</ul>' +
        '</div>'
      : '';

    profile.innerHTML =
      '<div class="writer-profile__grid">' +
        '<div class="writer-profile__head">' +
          avatar +
          '<div class="kicker kicker--gold">★ ' + esc(writer.shortRole || writer.role || 'Writer') + ' ★</div>' +
          '<h1 class="writer-profile__title">' + esc(writer.name || '') + '</h1>' +
          '<div class="writer-profile__role">' + esc(writer.role || '') + '</div>' +
        '</div>' +
        '<div class="writer-profile__body">' +
          pullQuote +
          '<div class="prose">' + bioHTML + '</div>' +
          (meta.length ? '<dl class="writer-profile__meta">' + meta.join('') + '</dl>' : '') +
          favorites +
        '</div>' +
      '</div>';

    // Filter reviews to those authored by this writer
    var writersBySlug = {};
    writers.forEach(function (w) { writersBySlug[w.slug] = w; });
    var byThisWriter = (reviews || []).filter(function (r) {
      return creditSlugs(r).indexOf(writer.slug) !== -1;
    });

    var countEl = $('[data-writer-count]');
    if (countEl) {
      countEl.textContent = byThisWriter.length + ' article' + (byThisWriter.length !== 1 ? 's' : '');
    }

    var articlesEl = $('[data-writer-articles]');
    if (articlesEl) {
      if (byThisWriter.length === 0) {
        articlesEl.innerHTML = '<p style="color: var(--ink-faded); text-align: center; padding: 1rem 0; grid-column: 1 / -1;">No articles by this writer yet.</p>';
      } else {
        articlesEl.innerHTML = byThisWriter.map(function (r) {
          return reviewCardHTML(r, { showKicker: true, minimal: true });
        }).join('\n');
      }
    }
  }

  // ============================================================
  //  bootstrap
  // ============================================================

  // Version marker — change when you ship a new content.js so you can spot
  // stale-cache issues in the browser console.
  if (window.console) console.log('[content.js] v26-snapshot-unified loaded');

  Promise.all([
    fetchJSON('site.json').catch(function () { return null; })
  ]).then(function (results) {
    var site = results[0];

    if (site && site.youtubeVideoId) {
      renderVideoEmbed(site.youtubeVideoId);
    }

    // ---- Detect what this page needs (so we don't over-fetch) -----
    var needsReviews =
      document.querySelector('[data-hero-review]') ||
      document.querySelector('[data-reviews-grid]') ||
      document.querySelector('[data-reviews-list]') ||
      document.querySelector('[data-review-body]') ||
      document.querySelector('[data-film-articles]') ||
      document.querySelector('[data-writer-articles]') ||
      document.querySelector('[data-writers-hosts]') ||
      document.querySelector('[data-writers-grid]') ||
      document.querySelector('[data-writer-profile]');

    var needsWriters =
      document.querySelector('[data-writers-hosts]') ||
      document.querySelector('[data-writers-grid]') ||
      document.querySelector('[data-writer-profile]') ||
      document.querySelector('[data-home-hosts]') ||
      // Also load writers wherever review bylines need to be clickable:
      document.querySelector('[data-hero-review]') ||
      document.querySelector('[data-reviews-grid]') ||
      document.querySelector('[data-reviews-list]') ||
      document.querySelector('[data-review-body]') ||
      document.querySelector('[data-film-articles]');

    var needsRace =
      document.querySelector('.rankings') ||
      document.querySelector('.ticker') ||
      document.querySelector('[data-categories-grid]') ||
      document.querySelector('[data-films-grid]') ||
      document.querySelector('[data-films-list]') ||
      document.querySelector('[data-category-detail]') ||
      document.querySelector('[data-film-profile]') ||
      document.querySelector('[data-snapshot-toggle]') ||
      // Single-review pages now use category + film data for Oscar Outlook,
      // By the Numbers, and Related Reviews sections.
      document.querySelector('[data-review-outlook]') ||
      document.querySelector('[data-review-numbers]') ||
      document.querySelector('[data-review-related]');

    // ---- Fetch reviews and writers in parallel -----
    var reviewsPromise = needsReviews
      ? fetchAllReviews().catch(function (err) {
          if (window.console) console.warn('[content] reviews load failed:', err);
          return [];
        })
      : Promise.resolve([]);

    var writersPromise = needsWriters
      ? fetchAllWriters().catch(function (err) {
          if (window.console) console.warn('[content] writers load failed:', err);
          return [];
        })
      : Promise.resolve([]);

    var racePromise = needsRace
      ? Promise.all([
          fetchSnapshotData().catch(function () { return { categoryArray: [], allSnapshots: [], activeSnapshot: null, previousSnapshot: null, activeIndex: -1 }; }),
          fetchAllFilms().catch(function () { return []; })
        ])
      : Promise.resolve([{ categoryArray: [], allSnapshots: [], activeSnapshot: null, previousSnapshot: null, activeIndex: -1 }, []]);

    // ---- Once we have everything, render every dependent page region -----
    Promise.all([reviewsPromise, writersPromise, racePromise]).then(function (data) {
      var reviews = data[0];
      var writers = data[1];
      var snapshotData = data[2][0];
      var categories = snapshotData.categoryArray;
      var films = data[2][1];

      var writersBySlug = {};
      writers.forEach(function (w) { writersBySlug[w.slug] = w; });

      // Render helper that catches errors so one breakage doesn't cascade
      function safeRender(name, fn) {
        try { fn(); }
        catch (err) {
          if (window.console) console.error('[content] ' + name + ' failed:', err);
        }
      }

      // Reviews-driven regions
      if (needsReviews) {
        safeRender('renderHero',          function () { renderHero(reviews, site, writersBySlug); });
        safeRender('renderReviewGrids',   function () { renderReviewGrids(reviews, writersBySlug); });
        safeRender('renderReviewsArchive',function () { renderReviewsArchive(reviews, writersBySlug); });
        safeRender('renderSingleReview',  function () { renderSingleReview(reviews, site, writersBySlug, categories, films); });
      }

      // Writers-driven regions
      safeRender('renderHomeHosts',        function () { renderHomeHosts(writers); });
      safeRender('renderWritersDirectory', function () { renderWritersDirectory(writers, reviews); });
      safeRender('renderWriterDetail',     function () { renderWriterDetail(writers, reviews); });

      // Race-driven regions
      if (needsRace) {
        // Synthesize rankings-shaped data from the active + previous snapshots
        // for the home widgets and Films view.
        var rankingsCurrent  = snapshotToRankings(snapshotData.activeSnapshot,   films);
        var rankingsPrevious = snapshotToRankings(snapshotData.previousSnapshot, films);

        if (rankingsCurrent) {
          safeRender('renderTicker+Rankings', function () {
            var prevFilms = rankingsPrevious ? rankingsPrevious.films : rankingsCurrent.films;
            var withMovement = computeMovement(rankingsCurrent.films, prevFilms);
            renderTicker(withMovement);
            renderRankings(withMovement, rankingsCurrent.cutoffRank, rankingsCurrent.updatedDate);
          });
        }

        safeRender('renderSnapshotToggle', function () { renderSnapshotToggle(snapshotData); });
        safeRender('renderCategoriesGrid', function () { renderCategoriesGrid(categories, films); });
        if (rankingsCurrent && rankingsPrevious) {
          safeRender('renderFilmsSection', function () { renderFilmsSection(rankingsCurrent, rankingsPrevious, categories, films); });
        } else if (rankingsCurrent) {
          // First snapshot ever (no previous) — render with current data twice
          // so movement reads flat.
          safeRender('renderFilmsSection', function () { renderFilmsSection(rankingsCurrent, rankingsCurrent, categories, films); });
        }
        safeRender('renderCategoryDetail', function () { renderCategoryDetail(categories, films, reviews); });
        safeRender('renderFilmDetail',     function () { renderFilmDetail(categories, films, reviews, writersBySlug); });
      }
    });
  }).catch(function (err) {
    if (window.console) console.warn('[content] init failed:', err);
  });
})();
