/* ==========================================================================
   FANTASY FILMBALL — content.js
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
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var idx = line.indexOf(':');
      if (idx === -1) continue;
      var key = line.slice(0, idx).trim();
      var val = line.slice(idx + 1).trim();
      if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
      if (val === 'true') val = true;
      else if (val === 'false') val = false;
      else if (/^-?\d+(\.\d+)?$/.test(val)) val = parseFloat(val);
      meta[key] = val;
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
      return Promise.all(list.map(function (item) {
        return fetchText(item.downloadUrl).then(function (md) {
          var parsed = parseFrontMatter(md);
          return Object.assign(
            { slug: item.slug, _sha: item.sha },
            parsed.meta,
            { body: parsed.body }
          );
        });
      }));
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
    var excerpt = r.excerpt || r.deck || '';

    var kicker = '';
    if (options.showKicker) {
      var parts = [];
      if (r.studio) parts.push(r.studio);
      if (r.director) parts.push(r.director);
      if (r.publishedDate) parts.push(r.publishedDate);
      kicker = parts.join(' · ');
    }

    var foot = options.compact
      ? '<div class="review-card__foot"><span class="rating">' + stars + ' <span class="rating__num">' + rating + '</span></span><span>' + esc(r.publishedDate || '') + '</span></div>'
      : '<div class="review-card__foot"><span class="rating">' + stars + ' <span class="rating__num">' + rating + '</span></span><span>By <strong>' + esc(r.writer || '[ Writer ]') + '</strong></span></div>';

    // Title: italicize the film, append the rest of the headline if different
    var titleHTML;
    if (headline.toLowerCase().indexOf(film.toLowerCase()) === 0) {
      titleHTML = '<em>' + esc(film) + '</em>' + esc(headline.slice(film.length));
    } else if (headline) {
      titleHTML = '<em>' + esc(film) + '</em> — ' + esc(headline);
    } else {
      titleHTML = '<em>' + esc(film) + '</em>';
    }

    var inner =
      '<div class="review-card__image">' +
        '<div class="review-card__badge-row"><span class="stock-badge stock-badge--' + esc(stance) + '">' + badgeArrow + ' ' + esc(stanceLabel) + '</span></div>' +
        '<img src="' + esc(posterPath) + '" alt="' + esc(film) + ' poster" class="review-card__poster" loading="lazy" onerror="this.style.display=\'none\'">' +
        '<div class="review-card__image-placeholder">' + esc(film) + '</div>' +
      '</div>' +
      (options.wrapText ? '<div>' : '') +
      (kicker ? '<div class="review-card__kicker">' + esc(kicker) + '</div>' : '') +
      '<h3 class="review-card__title">' + titleHTML + '</h3>' +
      '<p class="review-card__excerpt">' + esc(excerpt) + '</p>' +
      foot +
      (options.wrapText ? '</div>' : '');

    var href = 'review.html?slug=' + encodeURIComponent(r.slug);
    return '<a href="' + href + '" class="review-card">' + inner + '</a>';
  }

  // ---- homepage review grids --------------------------------------------

  function renderReviewGrids(reviews) {
    $$('[data-reviews-grid]').forEach(function (grid) {
      var limit  = parseInt(grid.getAttribute('data-limit'), 10) || 6;
      var offset = parseInt(grid.getAttribute('data-offset'), 10) || 0;
      var heroSlug = (window.__filmball_hero_slug || '');
      var pool = reviews.filter(function (r) { return r.slug !== heroSlug; });
      var slice = pool.slice(offset, offset + limit);
      if (slice.length === 0) return;
      var compact = grid.classList.contains('review-grid--4');
      grid.innerHTML = slice.map(function (r) {
        return reviewCardHTML(r, { showKicker: !compact, compact: compact });
      }).join('\n');
    });
  }

  // ---- reviews archive page ---------------------------------------------

  function renderReviewsArchive(reviews) {
    var list = $('[data-reviews-list]');
    if (!list) return;
    list.innerHTML = reviews.map(function (r) {
      return reviewCardHTML(r, { showKicker: true, wrapText: true });
    }).join('\n');
  }

  // ---- homepage hero block ----------------------------------------------

  function renderHero(reviews, siteSettings) {
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
      var headline = hero.title || '';
      if (headline.toLowerCase().indexOf(film.toLowerCase()) === 0) {
        titleEl.innerHTML = '<em>' + esc(film) + '</em>' + esc(headline.slice(film.length));
      } else {
        titleEl.innerHTML = '<em>' + esc(film) + '</em> — ' + esc(headline);
      }
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
      byline.innerHTML = 'By <strong>' + esc(hero.writer || '[ Writer ]') + '</strong>'
        + (hero.publishedDate ? ' · ' + esc(hero.publishedDate) : '');
    }
    var link = $('.hero__image', heroBlock);
    if (link) link.href = 'review.html?slug=' + encodeURIComponent(hero.slug);
  }

  // ---- single review page -----------------------------------------------

  function renderSingleReview(reviews, siteSettings) {
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
      var headline = review.title || '';
      if (headline.toLowerCase().indexOf(film.toLowerCase()) === 0) {
        title.innerHTML = '<em>' + esc(film) + '</em>' + esc(headline.slice(film.length));
      } else {
        title.innerHTML = '<em>' + esc(film) + '</em> — ' + esc(headline);
      }
    }

    var deck = $('[data-review-deck]');
    if (deck) deck.textContent = review.deck || '';

    var writer = $('[data-review-writer]');
    if (writer) writer.textContent = review.writer || '[ Writer ]';

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
  }

  // ---- bootstrap --------------------------------------------------------

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

    var needsReviews =
      document.querySelector('[data-hero-review]') ||
      document.querySelector('[data-reviews-grid]') ||
      document.querySelector('[data-reviews-list]') ||
      document.querySelector('[data-review-body]');

    if (needsReviews) {
      fetchAllReviews().then(function (reviews) {
        renderHero(reviews, site);
        renderReviewGrids(reviews);
        renderReviewsArchive(reviews);
        renderSingleReview(reviews, site);
      }).catch(function (err) {
        if (window.console) console.warn('[content] reviews load failed:', err);
      });
    }
  }).catch(function (err) {
    if (window.console) console.warn('[content] init failed:', err);
  });
})();
