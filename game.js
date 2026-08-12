/* ==========================================================================
   FANTASY FILMBALL — GAME RUNTIME (game.js)
   Renders the Filmball game page: league standings, rosters (with posters),
   and the per-show scoring chart. Data lives in content/game/:
     season.json           — award show list (colors, logos, tiers)
     films.json            — eligible film pool + points earned per show
     leagues/<slug>.json   — one file per league (players + rosters)
   ========================================================================== */
(function () {
  'use strict';

  // ---- shared helpers (mirrors content.js patterns) -----------------------

  function $(sel, ctx) { return (ctx || document).querySelector(sel); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

  function posterUrl(posterSlug) { return 'posters/' + posterSlug + '.jpg'; }

  // ---- league directory ---------------------------------------------------
  // Leagues are listed in a static index (content/game/leagues.json) rather
  // than via the GitHub Contents API — the API's 60 req/hr unauthenticated
  // rate limit is shared with content.js and hard-fails the whole page when
  // exceeded. Add a new league = add its slug to the index.

  function fetchAllLeagues() {
    return fetchJSON('game/leagues.json').then(function (index) {
      var slugs = index.leagues || [];
      return Promise.all(slugs.map(function (slug) {
        return fetchJSON('game/leagues/' + slug + '.json').then(function (d) {
          if (!d.slug) d.slug = slug;
          return d;
        }).catch(function (err) {
          if (window.console) console.error('[game] failed league ' + slug + ':', err);
          return null;
        });
      })).then(function (arr) {
        return arr.filter(Boolean);
      });
    });
  }

  // ---- points math --------------------------------------------------------

  // Per-film breakdown: { total, sources: [{id, points}] } where id is a show
  // id or one of critics/money/misc. Zero-point sources are dropped.
  function filmBreakdown(film) {
    var sources = [];
    var byId = {};

    function add(id, pts) {
      pts = Number(pts) || 0;
      if (pts === 0) return;
      if (!byId[id]) { byId[id] = { id: id, points: 0 }; sources.push(byId[id]); }
      byId[id].points += pts;
    }

    add('critics', film.critics);
    add('money',   film.money);
    add('misc',    film.misc);
    (film.points || []).forEach(function (p) { add(p.show, p.points); });

    var total = sources.reduce(function (s, x) { return s + x.points; }, 0);
    return { total: total, sources: sources };
  }

  // ---- rendering ----------------------------------------------------------

  var state = { season: null, films: null, leagues: [], filmMap: {}, showMap: {} };

  function sourceMeta(id) {
    return state.showMap[id] || { id: id, name: id, short: id.toUpperCase(), color: 'var(--ink-faded)' };
  }

  function pickLabel(pick) {
    // Draft picks are numbers; waiver adds use strings like "R6" / "62".
    if (pick == null || pick === '') return '';
    return String(pick);
  }

  function playerTotals(player) {
    var total = 0;
    var perSource = {};
    (player.roster || []).forEach(function (slot) {
      var film = state.filmMap[slot.filmSlug];
      if (!film) return;
      var bd = filmBreakdown(film);
      total += bd.total;
      bd.sources.forEach(function (s) {
        perSource[s.id] = (perSource[s.id] || 0) + s.points;
      });
    });
    return { total: total, perSource: perSource };
  }

  function renderStandings(league) {
    var el = $('[data-game-standings]');
    if (!el) return;

    var rows = (league.players || []).map(function (p) {
      return { player: p, totals: playerTotals(p) };
    });
    rows.sort(function (a, b) { return b.totals.total - a.totals.total; });

    var html = rows.map(function (r, i) {
      return '<div class="game-standings__row">'
        + '<span class="game-standings__rank">' + (i + 1) + '</span>'
        + '<span class="game-standings__name">' + esc(r.player.name) + '</span>'
        + '<span class="game-standings__films">' + (r.player.roster || []).length + ' films</span>'
        + '<span class="game-standings__pts">' + r.totals.total.toLocaleString() + '</span>'
        + '</div>';
    }).join('');

    el.innerHTML = html || '<p class="game-empty">No players in this league yet.</p>';
  }

  function rosterFilmRow(slot) {
    var film = state.filmMap[slot.filmSlug];
    if (!film) {
      return '<div class="game-roster__film"><span class="game-roster__pick">'
        + esc(pickLabel(slot.pick)) + '</span>'
        + '<span class="game-roster__title">' + esc(slot.filmSlug) + '</span></div>';
    }
    var bd = filmBreakdown(film);
    return '<div class="game-roster__film">'
      + '<span class="game-roster__pick">' + esc(pickLabel(slot.pick)) + '</span>'
      + '<span class="game-roster__poster"><img src="' + esc(posterUrl(film.posterSlug))
        + '" alt="" loading="lazy" onerror="this.parentNode.classList.add(\'is-missing\')"></span>'
      + '<span class="game-roster__title">' + esc(film.title) + '</span>'
      + '<span class="game-roster__pts">' + bd.total.toLocaleString() + '</span>'
      + '</div>';
  }

  function renderRosters(league) {
    var el = $('[data-game-rosters]');
    if (!el) return;

    var html = (league.players || []).map(function (p) {
      var totals = playerTotals(p);
      return '<article class="game-roster">'
        + '<header class="game-roster__head">'
        + '<h3 class="game-roster__player">' + esc(p.name) + '</h3>'
        + '<span class="game-roster__total">' + totals.total.toLocaleString() + ' PTS</span>'
        + '</header>'
        + (p.roster || []).map(rosterFilmRow).join('')
        + '</article>';
    }).join('');

    el.innerHTML = html || '<p class="game-empty">No rosters yet — check back after the draft.</p>';
  }

  function renderScoringChart(league) {
    var el = $('[data-game-chart]');
    if (!el) return;

    var rows = (league.players || []).map(function (p) {
      return { player: p, totals: playerTotals(p) };
    });
    rows.sort(function (a, b) { return b.totals.total - a.totals.total; });

    var max = rows.reduce(function (m, r) { return Math.max(m, r.totals.total); }, 0);

    var html = rows.map(function (r) {
      var segs = '';
      if (max > 0 && r.totals.total > 0) {
        Object.keys(r.totals.perSource).forEach(function (id) {
          var meta = sourceMeta(id);
          var pts = r.totals.perSource[id];
          var w = (pts / max) * 100;
          segs += '<span class="game-chart__seg" style="width:' + w.toFixed(2)
            + '%;background:' + esc(meta.color) + '" title="'
            + esc(meta.name + ' — ' + pts.toLocaleString() + ' pts') + '"></span>';
        });
      } else {
        segs = '<span class="game-chart__seg game-chart__seg--empty"></span>';
      }
      return '<div class="game-chart__row">'
        + '<span class="game-chart__name">' + esc(r.player.name) + '</span>'
        + '<span class="game-chart__bar">' + segs + '</span>'
        + '<span class="game-chart__pts">' + r.totals.total.toLocaleString() + '</span>'
        + '</div>';
    }).join('');

    el.innerHTML = html || '<p class="game-empty">Nothing to chart yet.</p>';
  }

  function renderLegend() {
    var el = $('[data-game-legend]');
    if (!el || !state.season) return;

    var all = (state.season.pointSources || []).concat(state.season.shows || []);
    el.innerHTML = all.map(function (s) {
      var logo = s.logo
        ? '<img class="game-legend__logo" src="' + esc(s.logo) + '" alt="" loading="lazy">'
        : '<span class="game-legend__chip" style="background:' + esc(s.color) + '"></span>';
      return '<span class="game-legend__item">' + logo
        + '<span class="game-legend__label">' + esc(s.short || s.name) + '</span></span>';
    }).join('');
  }

  function renderFilmPool() {
    var el = $('[data-game-pool]');
    if (!el || !state.films) return;

    var films = state.films.films.slice();
    films.sort(function (a, b) { return filmBreakdown(b).total - filmBreakdown(a).total; });

    el.innerHTML = films.map(function (f) {
      var bd = filmBreakdown(f);
      return '<a class="game-pool__card" href="film.html?slug=' + esc(f.filmSlug) + '">'
        + '<span class="game-pool__poster"><img src="' + esc(posterUrl(f.posterSlug))
          + '" alt="" loading="lazy" onerror="this.parentNode.classList.add(\'is-missing\')"></span>'
        + '<span class="game-pool__title">' + esc(f.title) + '</span>'
        + '<span class="game-pool__pts">' + bd.total.toLocaleString() + ' PTS</span>'
        + '</a>';
    }).join('');
  }

  // ---- league selector ----------------------------------------------------

  function currentLeagueSlug() {
    var params = new URLSearchParams(window.location.search);
    return params.get('league') || '';
  }

  function renderLeaguePicker() {
    var sel = $('[data-game-league-select]');
    if (!sel) return;

    var current = currentLeagueSlug();
    sel.innerHTML = state.leagues.map(function (l) {
      return '<option value="' + esc(l.slug) + '"'
        + (l.slug === current ? ' selected' : '') + '>' + esc(l.name) + '</option>';
    }).join('');

    sel.addEventListener('change', function () {
      var url = new URL(window.location.href);
      url.searchParams.set('league', sel.value);
      window.history.replaceState(null, '', url.toString());
      renderLeague();
    });
  }

  function activeLeague() {
    var slug = currentLeagueSlug();
    for (var i = 0; i < state.leagues.length; i++) {
      if (state.leagues[i].slug === slug) return state.leagues[i];
    }
    return state.leagues[0] || null;
  }

  function renderLeague() {
    var league = activeLeague();
    if (!league) return;
    var nameEl = $('[data-game-league-name]');
    if (nameEl) nameEl.textContent = league.name;
    renderStandings(league);
    renderRosters(league);
    renderScoringChart(league);
  }

  // ---- boot ---------------------------------------------------------------

  function init() {
    if (!$('[data-game-rosters]')) return;

    Promise.all([
      fetchJSON('game/season.json'),
      fetchJSON('game/films.json'),
      fetchAllLeagues()
    ]).then(function (res) {
      state.season = res[0];
      state.films = res[1];
      state.leagues = res[2];

      state.filmMap = {};
      (state.films.films || []).forEach(function (f) { state.filmMap[f.filmSlug] = f; });

      state.showMap = {};
      (state.season.pointSources || []).concat(state.season.shows || []).forEach(function (s) {
        state.showMap[s.id] = s;
      });

      var seasonEl = $('[data-game-season]');
      if (seasonEl) seasonEl.textContent = state.season.label || state.season.season;

      renderLeaguePicker();
      renderLegend();
      renderFilmPool();
      renderLeague();
    }).catch(function (err) {
      if (window.console) console.error('[game] init failed:', err);
      var el = $('[data-game-rosters]');
      if (el) el.innerHTML = '<p class="game-empty">Couldn\u2019t load game data. Try refreshing.</p>';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
