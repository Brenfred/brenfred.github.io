/* ==========================================================================
   FANTASY FILMBALL — content.js
   Reads /content/*.json and Markdown review files, then populates the page.
   This is what turns a static site into a CMS-editable site.

   Sections handled here:
     • Ticker (top 20 films from rankings.json)
     • Best Picture rankings widget (top 15 with cutoff at 10)
     • YouTube embed (from site.json)
     • Hero review block on the homepage (from site.json + matching review .md)

   Each populate function is gated on whether its target element exists,
   so this file is safe to load on every page.
   ========================================================================== */

(function () {
  'use strict';

  // ---- helpers ------------------------------------------------------------

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function slugify(text) {
    return String(text)
      .toLowerCase()
      .replace(/[''"]/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  function esc(s) {
    var div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  }

  // Resolve content path relative to current page (so /admin and root both work).
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

  function fetchText(path) {
    return fetch(contentUrl(path), { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('Failed to load ' + path + ': ' + r.status);
        return r.text();
      });
  }

  // ---- markdown front-matter parser (just for review files) --------------

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
      // Strip surrounding quotes
      if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
      // Coerce numbers and booleans
      if (val === 'true') val = true;
      else if (val === 'false') val = false;
      else if (/^-?\d+(\.\d+)?$/.test(val)) val = parseFloat(val);
      meta[key] = val;
    }
    return { meta: meta, body: bodyText };
  }

  function mdToHtml(body) {
    // Tiny markdown → HTML for paragraphs, bold, italic, links.
    // Reviews are short prose; we don't need a full parser.
    var html = esc(body);
    // bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // italic
    html = html.replace(/(^|[^*])\*([^*]+)\*([^*]|$)/g, '$1<em>$2</em>$3');
    // links [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    // paragraphs (double newline) — skip bracket-only paragraphs (they're prompts)
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
      else                          movement = { kind: 'flat', delta: 0 };
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
    // Keep the label, drop everything else, then add items (doubled for the marquee loop).
    var label = $('.ticker__label', inner);
    inner.innerHTML = '';
    if (label) inner.appendChild(label);

    function tickerHTML(f) {
      var m = f.movement;
      var moveHTML;
      if (m.kind === 'new')        moveHTML = '<span class="ticker__new">NEW</span>';
      else if (m.kind === 'up')    moveHTML = '<span class="ticker__up">▲ ' + m.delta + '</span>';
      else if (m.kind === 'down')  moveHTML = '<span class="ticker__down">▼ ' + m.delta + '</span>';
      else                          moveHTML = '<span class="ticker__flat">—</span>';
      return (
        '<span class="ticker__item">' +
          '<span class="ticker__name">' + esc(f.title.toUpperCase()) + '</span>' +
          '<span class="ticker__price">' + esc(f.nomPct) + '</span>' +
          moveHTML +
        '</span>'
      );
    }

    // Render twice for the seamless marquee animation
    var html = films.map(tickerHTML).join('') + films.map(tickerHTML).join('');
    inner.insertAdjacentHTML('beforeend', html);
  }

  // ---- best-picture rankings widget --------------------------------------

  function renderRankings(films, cutoffRank, label) {
    var widget = $('.rankings');
    if (!widget) return;

    // Top 15 for the home-page widget
    var top15 = films.slice(0, 15);

    // Update the header label (date)
    var weekEl = $('.rankings__week', widget);
    if (weekEl && label) weekEl.textContent = label;

    // Remove existing rows + cutoff (preserve head/foot)
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
      // Drop the cutoff visual after the cutoff rank
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

  // ---- bootstrap ----------------------------------------------------------

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
  }).catch(function (err) {
    // Fail silently — the HTML still has fallback content baked in.
    if (window.console) console.warn('[content] init failed:', err);
  });
})();
