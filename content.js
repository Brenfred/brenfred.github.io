/* ==========================================================================
   FANTASY FILMBALL — content.js (v13-archive-redesign)
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
    if (!h) return f ? '<em>' + esc(f) + '</em>' : '';
    if (!f) return esc(h);
    var fLower = f.toLowerCase();
    var hLower = h.toLowerCase();

    // Exact match
    if (hLower === fLower) return '<em>' + esc(h) + '</em>';

    // Headline starts with film (followed by a non-letter)
    if (hLower.indexOf(fLower) === 0 && !/^[a-z0-9]/i.test(h.charAt(f.length))) {
      return '<em>' + esc(h.slice(0, f.length)) + '</em>' + esc(h.slice(f.length));
    }

    // Headline contains film as a whole word
    var wordPat = new RegExp('\\b' + f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    var m = h.match(wordPat);
    if (m) {
      var i = h.toLowerCase().indexOf(m[0].toLowerCase());
      return esc(h.slice(0, i)) + '<em>' + esc(h.slice(i, i + m[0].length)) + '</em>' + esc(h.slice(i + m[0].length));
    }

    // Film name not in headline at all — show "<em>Film</em> — Headline"
    return '<em>' + esc(f) + '</em> — ' + esc(h);
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
      if (trimmedRest === '') {
        var items = [];
        var j = i + 1;
        while (j < lines.length) {
          var next = lines[j];
          if (next.trim() === '') { j++; continue; }
          var listMatch = next.match(/^\s+-\s+(.*)$/);
          if (listMatch) {
            items.push(parseScalar(listMatch[1]));
            j++;
          } else if (/^\s/.test(next)) {
            j++;
          } else {
            break;
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
    var html = esc(body);
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(^|[^*])\*([^*]+)\*([^*]|$)/g, '$1<em>$2</em>$3');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    var paragraphs = html.split(/\n\s*\n/).filter(function (p) { return p.trim().length > 0; });
    return paragraphs.map(function (p) { return '<p>' + p.replace(/\n/g, ' ') + '</p>'; }).join('');
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
      return (
        '<span class="ticker__item">' +
          '<span class="ticker__name">' + esc(f.title.toUpperCase()) + '</span>' +
          '<span class="ticker__price">' + esc(f.nomPct) + '</span>' +
          moveHTML +
        '</span>'
      );
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
        cutoff.innerHTML = '<span>Below the Line</span>';
        widget.insertBefore(cutoff, insertBefore);
      }
    });
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
    var stars = '';
    for (var i = 0; i < full; i++) stars += '★ ';
    return stars.trim();
  }

  function reviewCardHTML(r, options) {
    options = options || {};
    var stance = (r.stance || 'buy').toLowerCase();
    var badgeArrow = stance === 'sell' ? '▼' : stance === 'hold' ? '—' : '▲';
    var stanceLabel = r.stanceLabel || (stance === 'sell' ? 'Sell' : stance === 'hold' ? 'Hold' : 'Buy');
    var posterSlug = r.posterSlug || r.slug;
    var posterPath = 'posters/' + posterSlug + '.jpg';
    var film = r.film || r.slug;
    var rating = r.rating != null ? r.rating : 4.0;
    var stars = renderStars(rating);
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
      foot = '<div class="review-card__foot"><span class="rating">' + stars + ' <span class="rating__num">' + rating + '</span></span><span>' + esc(r.publishedDate || '') + '</span></div>';
    } else {
      var bylineStr = options.writersBySlug
        ? bylineHTML(r, options.writersBySlug)
        : 'By <strong>' + esc(r.writer || '[ Writer ]') + '</strong>';
      foot = '<div class="review-card__foot"><span class="rating">' + stars + ' <span class="rating__num">' + rating + '</span></span><span>' + bylineStr + '</span></div>';
    }

    // Title: italicize the film name where it appears in the headline
    var titleHTML = headlineHTML(film, headline);

    var imgInlineStyle = options.archive
      ? ' style="flex: 0 0 180px; width: 180px; max-width: 180px; margin-bottom: 0;"'
      : '';
    var textInlineStyle = options.archive
      ? ' style="flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 0.4rem;"'
      : '';

    var inner =
      '<div class="review-card__image"' + imgInlineStyle + '>' +
        '<div class="review-card__badge-row"><span class="stock-badge stock-badge--' + esc(stance) + '">' + badgeArrow + ' ' + esc(stanceLabel) + '</span></div>' +
        '<img src="' + esc(posterPath) + '" alt="' + esc(film) + ' poster" class="review-card__poster" loading="lazy" onerror="this.style.display=\'none\'">' +
        '<div class="review-card__image-placeholder">' + esc(film) + '</div>' +
      '</div>' +
      '<div class="review-card__text"' + textInlineStyle + '>' +
        (kicker ? '<div class="review-card__kicker">' + esc(kicker) + '</div>' : '') +
        '<h3 class="review-card__title">' + titleHTML + '</h3>' +
        '<p class="review-card__excerpt">' + esc(excerpt) + '</p>' +
        foot +
      '</div>';

    // For .review-list cards (archive page), embed inline flex styles so the
    // horizontal layout is locked in regardless of CSS cache or specificity.
    var inlineStyle = options.archive
      ? ' style="display: flex; flex-direction: row; align-items: stretch; gap: 1.5rem;"'
      : '';
    var href = 'review.html?slug=' + encodeURIComponent(r.slug);
    return '<a href="' + href + '" class="review-card"' + inlineStyle + '>' + inner + '</a>';
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

    // Update the meta row (X reviews · X buys · X holds · X sells)
    var metaEl = $('[data-archive-meta]');
    if (metaEl) {
      var counts = { buy: 0, hold: 0, sell: 0 };
      reviews.forEach(function (r) {
        var s = (r.stance || 'buy').toLowerCase();
        if (counts[s] != null) counts[s]++;
      });
      var parts = [reviews.length + ' review' + (reviews.length !== 1 ? 's' : '')];
      if (counts.buy)  parts.push(counts.buy + ' buy' + (counts.buy !== 1 ? 's' : ''));
      if (counts.hold) parts.push(counts.hold + ' hold' + (counts.hold !== 1 ? 's' : ''));
      if (counts.sell) parts.push(counts.sell + ' sell' + (counts.sell !== 1 ? 's' : ''));
      metaEl.textContent = parts.join(' · ');
    }

    function archiveCardHTML(r) {
      var stance = (r.stance || 'buy').toLowerCase();
      var stanceLabel = r.stanceLabel || (stance === 'sell' ? 'Sell' : stance === 'hold' ? 'Hold' : 'Buy');
      var stanceArrow = stance === 'sell' ? '▼' : stance === 'hold' ? '—' : '▲';
      var posterPath = 'posters/' + (r.posterSlug || r.slug) + '.jpg';
      var film = r.film || r.slug;
      var rating = r.rating != null ? r.rating : 4.0;
      var stars = renderStars(rating);

      // Tagline — cap at ~140 chars to keep cards uniform height
      var rawTagline = r.excerpt || r.deck || '';
      var tagline = rawTagline.length > 140
        ? rawTagline.slice(0, 135).replace(/\s+\S*$/, '') + '…'
        : rawTagline;

      var titleHTML = headlineHTML(film, r.title);
      var bylineStr = writersBySlug
        ? bylineHTML(r, writersBySlug)
        : 'By <strong>' + esc(r.writer || '[ Writer ]') + '</strong>';

      var href = 'review.html?slug=' + encodeURIComponent(r.slug);
      var kickerParts = [];
      if (r.studio)        kickerParts.push(r.studio);
      if (r.director)      kickerParts.push(r.director);
      var kicker = kickerParts.join(' · ');

      return '<a href="' + href + '" class="archive-card" data-stance="' + esc(stance) + '">' +
        '<div class="archive-card__poster">' +
          '<span class="archive-card__badge archive-card__badge--' + esc(stance) + '">' + stanceArrow + ' ' + esc(stanceLabel) + '</span>' +
          '<img src="' + esc(posterPath) + '" alt="' + esc(film) + ' poster" loading="lazy" onerror="this.style.display=\'none\'">' +
          '<div class="archive-card__poster-fallback">' + esc(film) + '</div>' +
        '</div>' +
        '<div class="archive-card__body">' +
          (kicker ? '<div class="archive-card__kicker">' + esc(kicker) + '</div>' : '') +
          '<h3 class="archive-card__title">' + titleHTML + '</h3>' +
          (tagline ? '<p class="archive-card__tagline">' + esc(tagline) + '</p>' : '') +
          '<div class="archive-card__foot">' +
            '<span class="archive-card__rating">' + stars + ' <span>' + rating + '</span></span>' +
            '<span class="archive-card__byline">' + bylineStr + '</span>' +
          '</div>' +
          (r.publishedDate ? '<div class="archive-card__date">' + esc(r.publishedDate) + '</div>' : '') +
        '</div>' +
      '</a>';
    }

    if (reviews.length === 0) {
      grid.innerHTML = '<p class="archive-empty">No reviews yet. Publish one in the CMS.</p>';
    } else {
      grid.innerHTML = reviews.map(archiveCardHTML).join('\n');
    }

    // Hook up the stance filters
    var filterButtons = $$('[data-archive-filters] .archive-filter');
    filterButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var filter = btn.getAttribute('data-filter');
        filterButtons.forEach(function (b) { b.classList.toggle('is-active', b === btn); });
        $$('.archive-card', grid).forEach(function (card) {
          var stance = card.getAttribute('data-stance');
          card.style.display = (filter === 'all' || filter === stance) ? '' : 'none';
        });
      });
    });
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

    var film = hero.film || hero.slug;
    var stance = (hero.stance || 'buy').toLowerCase();
    var stanceLabel = hero.stanceLabel || 'Strong Buy';
    var badgeArrow = stance === 'sell' ? '▼' : stance === 'hold' ? '—' : '▲';
    var rating = hero.rating != null ? hero.rating : 4.5;
    var posterPath = 'posters/' + (hero.posterSlug || hero.slug) + '.jpg';

    var img = $('.hero__poster', heroBlock);
    if (img) {
      img.src = posterPath;
      img.alt = film + ' poster';
      img.style.display = '';
    }
    var placeholder = $('.hero__image-placeholder', heroBlock);
    if (placeholder) placeholder.textContent = film;

    var titleEl = $('.hero__title', heroBlock);
    if (titleEl) {
      titleEl.innerHTML = headlineHTML(film, hero.title);
    }
    var deckEl = $('.hero__deck', heroBlock);
    if (deckEl) deckEl.textContent = hero.deck || hero.excerpt || '';

    var badge = $('.stock-badge', heroBlock);
    if (badge) {
      badge.className = 'stock-badge stock-badge--' + stance;
      badge.innerHTML = '<span class="stock-badge__arrow">' + badgeArrow + '</span> ' + esc(stanceLabel);
    }
    var ratingEl = $('.rating', heroBlock);
    if (ratingEl) {
      ratingEl.innerHTML = renderStars(rating) + ' <span class="rating__num">' + rating + ' / 5</span>';
    }
    var byline = $('.hero__byline', heroBlock);
    if (byline) {
      var bylineStr = writersBySlug
        ? bylineHTML(hero, writersBySlug)
        : 'By <strong>' + esc(hero.writer || '[ Writer ]') + '</strong>';
      byline.innerHTML = bylineStr + (hero.publishedDate ? ' · ' + esc(hero.publishedDate) : '');
    }
    var link = $('.hero__image', heroBlock);
    if (link) link.href = 'review.html?slug=' + encodeURIComponent(hero.slug);
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

    var film = review.film || review.slug;
    var stance = (review.stance || 'buy').toLowerCase();
    var stanceLabel = review.stanceLabel || 'Strong Buy';
    var badgeArrow = stance === 'sell' ? '▼' : stance === 'hold' ? '—' : '▲';
    var rating = review.rating != null ? review.rating : 4.5;

    document.title = (review.title || (film + ' Review')) + ' — Fantasy Filmball';

    var crumb = $('[data-review-film]');
    if (crumb) crumb.textContent = film;

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

    var stars = $('[data-review-stars]');
    if (stars) stars.textContent = renderStars(rating);

    var ratingNum = $('[data-review-rating-num]');
    if (ratingNum) ratingNum.textContent = rating + ' / 5 STARS';

    var badge = $('[data-review-badge]');
    if (badge) {
      badge.className = 'stock-badge stock-badge--' + stance;
      badge.innerHTML = '<span class="stock-badge__arrow">' + badgeArrow + '</span> ' + esc(stanceLabel);
    }

    var heroImg = $('[data-review-hero-img]');
    if (heroImg) {
      var posterSlug = review.posterSlug || review.slug;
      heroImg.src = 'posters/' + posterSlug + '-hero.jpg';
      heroImg.alt = film;
      heroImg.onerror = function () {
        if (!this.dataset.fallback) {
          this.dataset.fallback = '1';
          this.src = 'posters/' + posterSlug + '.jpg';
        } else {
          this.style.display = 'none';
        }
      };
    }
    var heroTitle = $('[data-review-hero-title]');
    if (heroTitle) heroTitle.textContent = film;

    if (body && review.body) {
      body.innerHTML = mdToHtml(review.body);
    }

    var director = $('[data-review-director]');
    if (director) director.textContent = review.director || '';
    var studio = $('[data-review-studio]');
    if (studio) studio.textContent = review.studio || '';

    // ---- Oscar Outlook (auto-computed from category rankings) ----------
    var outlookEl = $('[data-review-outlook]');
    if (outlookEl) {
      var filmSlug = review.posterSlug || review.slug;
      var outlookRows = [];

      // Map a rank → outlook label. For Best Picture, top-10 nominees, so:
      //   #1     → "Frontrunner"
      //   #2-5   → "Strong Contender"
      //   #6-10  → "Top 10"
      //   #11-20 → "In the Conversation"
      // For other categories (top 10 list, 5 nominees):
      //   #1     → "Frontrunner"
      //   #2     → "Lock"
      //   #3-5   → "Top 5"
      //   #6-10  → "Outside Looking In"
      function outlookLabel(catSlug, rank) {
        if (catSlug === 'picture') {
          if (rank === 1)  return 'Frontrunner';
          if (rank <= 5)   return 'Strong Contender';
          if (rank <= 10)  return 'Top 10';
          return 'In the Conversation';
        }
        if (rank === 1)  return 'Frontrunner';
        if (rank === 2)  return 'Lock';
        if (rank <= 5)   return 'Top 5';
        return 'Outside Top 5';
      }

      (categories || []).forEach(function (cat) {
        (cat.current.films || []).forEach(function (row) {
          if (row.filmSlug === filmSlug) {
            outlookRows.push({
              label: cat.current.shortLabel || cat.current.label,
              fullLabel: cat.current.label,
              value: outlookLabel(cat.slug, row.rank),
              rank: row.rank,
              subtitle: row.subtitle || ''
            });
          }
        });
      });

      // Sort: Best Picture first, then by rank (best ranks first)
      outlookRows.sort(function (a, b) {
        if (a.fullLabel === 'Best Picture') return -1;
        if (b.fullLabel === 'Best Picture') return 1;
        return a.rank - b.rank;
      });

      if (outlookRows.length === 0) {
        outlookEl.innerHTML =
          '<h3 class="aside-block__title">Oscar Outlook</h3>' +
          '<p class="aside-block__empty">Not currently ranked in any category.</p>';
      } else {
        outlookEl.innerHTML =
          '<h3 class="aside-block__title">Oscar Outlook</h3>' +
          outlookRows.map(function (r) {
            // Acting categories include the performer name as part of the value
            var isActing = /^(Actor|Actress|Supp|Performance)/i.test(r.label);
            var displayValue = isActing && r.subtitle
              ? r.value + ' (' + esc(r.subtitle.split(',')[0]) + ')'
              : esc(r.value);
            return '<div class="aside-block__row">' +
              '<span class="aside-block__label">' + esc(r.label) + '</span>' +
              '<span class="aside-block__value">' + displayValue + '</span>' +
            '</div>';
          }).join('');
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
          '<p class="aside-block__empty">Not currently in the Best Picture top 20. ' +
          'Add this film to a category in the CMS to populate stats here.</p>';
      } else {
        numbersEl.innerHTML =
          '<h3 class="aside-block__title">By the Numbers</h3>' +
          numRows.map(function (r) {
            var statClass = r.stat ? ' aside-block__value--stat' : '';
            return '<div class="aside-block__row">' +
              '<span class="aside-block__label">' + esc(r.label) + '</span>' +
              '<span class="aside-block__value' + statClass + '">' + esc(r.value) + '</span>' +
            '</div>';
          }).join('');
      }
    }

    // ---- Related Reviews (same stance, excluding the current one) -------
    var relatedEl = $('[data-review-related]');
    var relatedTitleEl = $('[data-review-related-title]');
    if (relatedEl) {
      var sameStance = (reviews || []).filter(function (r) {
        return r.slug !== review.slug && (r.stance || '').toLowerCase() === stance;
      });

      // Friendly section heading
      var stanceWord = stance === 'sell' ? 'Sell' : stance === 'hold' ? 'Hold' : 'Buy';
      if (relatedTitleEl) {
        relatedTitleEl.innerHTML = 'More <em>' + esc(stanceWord) + ' ratings</em>';
      }

      if (sameStance.length === 0) {
        relatedEl.innerHTML = '<p style="grid-column: 1 / -1; color: var(--ink-faded); text-align: center; padding: 1rem 0;">' +
          'No other ' + esc(stanceWord) + ' reviews yet.</p>';
      } else {
        relatedEl.innerHTML = sameStance.slice(0, 3).map(function (r) {
          return reviewCardHTML(r, { showKicker: false, compact: true });
        }).join('\n');
      }
    }
  }

  // ============================================================
  //  CATEGORIES + FILMS — the Oscar Race system
  // ============================================================

  // List of category slugs (matches /content/categories/*.json)
  var CATEGORY_SLUGS = [
    'picture', 'director',
    'actress', 'actor',
    'supp-actress', 'supp-actor',
    'orig-screenplay', 'adapt-screenplay'
  ];

  function fetchAllCategories() {
    // Fetch current + previous for all 8 categories in parallel.
    var jobs = CATEGORY_SLUGS.map(function (slug) {
      return Promise.all([
        fetchJSON('categories/' + slug + '.json').catch(function () { return null; }),
        fetchJSON('categories-previous/' + slug + '.json').catch(function () { return null; })
      ]).then(function (pair) {
        if (!pair[0]) return null;
        return {
          slug: slug,
          current: pair[0],
          previous: pair[1] || pair[0]  // fall back to identical so movement = flat
        };
      });
    });
    return Promise.all(jobs).then(function (cats) {
      return cats.filter(function (c) { return c !== null; });
    });
  }

  function computeCategoryMovement(current, previous) {
    // current.films and previous.films are arrays of {rank, filmSlug, subtitle, ...}
    // Match by filmSlug if present, else by subtitle (for personnel categories
    // like Best Actress where the "key" is the performer not the film).
    function keyOf(f) { return (f.filmSlug || '').toLowerCase() + '|' + (f.subtitle || '').toLowerCase(); }
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

  function renderCategoriesGrid(categories, films) {
    var grid = $('[data-categories-grid]');
    if (!grid) return;

    var filmMap = {};
    films.forEach(function (f) { filmMap[f.slug] = f; });

    var html = categories.map(function (cat) {
      var label = cat.current.shortLabel || cat.current.label;
      var withMove = computeCategoryMovement(cat.current, cat.previous);
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

      var detailHref = 'category.html?cat=' + encodeURIComponent(cat.slug);
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

    var withMove = computeCategoryMovement(cat.current, cat.previous);

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
      var withMove = computeCategoryMovement(cat.current, cat.previous);
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
    contributors.sort(nameCmp);

    if (countEl) {
      countEl.textContent = hosts.length + ' host' + (hosts.length !== 1 ? 's' : '') +
                            ' · ' + contributors.length + ' contributor' + (contributors.length !== 1 ? 's' : '');
    }

    // Article counts per writer (used in tiles)
    var counts = {};
    (reviews || []).forEach(function (r) {
      (r.writers || []).forEach(function (s) {
        counts[s] = (counts[s] || 0) + 1;
      });
    });

    // ---- Hosts: bigger horizontal cards with bio ----
    if (hostsContainer) {
      if (hosts.length === 0) {
        hostsContainer.innerHTML = '<p style="color: var(--ink-faded); padding: 1rem 0;">No hosts added yet. Create a writer in the CMS with "Host" in their role.</p>';
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
      return Array.isArray(r.writers) && r.writers.indexOf(writer.slug) !== -1;
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
  if (window.console) console.log('[content.js] v13-archive-redesign loaded');

  Promise.all([
    fetchJSON('site.json').catch(function () { return null; }),
    fetchJSON('rankings.json').catch(function () { return null; }),
    fetchJSON('rankings-previous.json').catch(function () { return null; })
  ]).then(function (results) {
    var site = results[0];
    var current = results[1];
    var previous = results[2];

    if (current && previous) {
      var withMovement = computeMovement(current.films, previous.films);
      renderTicker(withMovement);
      renderRankings(withMovement, current.cutoffRank, current.updatedDate);
    }
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
      // Also load writers wherever review bylines need to be clickable:
      document.querySelector('[data-hero-review]') ||
      document.querySelector('[data-reviews-grid]') ||
      document.querySelector('[data-reviews-list]') ||
      document.querySelector('[data-review-body]') ||
      document.querySelector('[data-film-articles]');

    var needsRace =
      document.querySelector('[data-categories-grid]') ||
      document.querySelector('[data-films-grid]') ||
      document.querySelector('[data-films-list]') ||
      document.querySelector('[data-category-detail]') ||
      document.querySelector('[data-film-profile]') ||
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
          fetchAllCategories().catch(function () { return []; }),
          fetchAllFilms().catch(function () { return []; })
        ])
      : Promise.resolve([[], []]);

    // ---- Once we have everything, render every dependent page region -----
    Promise.all([reviewsPromise, writersPromise, racePromise]).then(function (data) {
      var reviews = data[0];
      var writers = data[1];
      var categories = data[2][0];
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
      safeRender('renderWritersDirectory', function () { renderWritersDirectory(writers, reviews); });
      safeRender('renderWriterDetail',     function () { renderWriterDetail(writers, reviews); });

      // Race-driven regions
      if (needsRace) {
        safeRender('renderCategoriesGrid', function () { renderCategoriesGrid(categories, films); });
        if (current && previous) {
          safeRender('renderFilmsSection', function () { renderFilmsSection(current, previous, categories, films); });
        }
        safeRender('renderCategoryDetail', function () { renderCategoryDetail(categories, films, reviews); });
        safeRender('renderFilmDetail',     function () { renderFilmDetail(categories, films, reviews, writersBySlug); });
      }
    });
  }).catch(function (err) {
    if (window.console) console.warn('[content] init failed:', err);
  });
})();
