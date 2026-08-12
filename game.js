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
    // Prediction/bonus points live on the player, not a film.
    var bonus = Number(player.bonus) || 0;
    if (bonus !== 0) {
      total += bonus;
      perSource.misc = (perSource.misc || 0) + bonus;
    }
    return { total: total, perSource: perSource };
  }

  function renderStandings(league) {
    var el = $('[data-game-standings]');
    if (!el) return;

    var rows = (league.players || []).map(function (p) {
      return { player: p, totals: playerTotals(p) };
    });
    rows.sort(function (a, b) { return b.totals.total - a.totals.total; });

    var hasFaab = rows.some(function (r) { return r.player.faab != null; });

    var html = rows.map(function (r, i) {
      var faab = hasFaab
        ? '<span class="game-standings__faab">' + (r.player.faab != null
            ? 'FAAB ' + Number(r.player.faab).toLocaleString() : '') + '</span>'
        : '';
      return '<div class="game-standings__row' + (hasFaab ? ' game-standings__row--faab' : '') + '">'
        + '<span class="game-standings__rank">' + (i + 1) + '</span>'
        + '<span class="game-standings__name">' + esc(r.player.name) + '</span>'
        + '<span class="game-standings__films">' + (r.player.roster || []).length + ' films</span>'
        + faab
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
            + '%;background:' + esc(meta.color) + '" data-tip-name="' + esc(meta.name)
            + '" data-tip-pts="' + esc(pts.toLocaleString()) + '"></span>';
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

  function renderFilmPool() {
    var el = $('[data-game-pool]');
    if (!el || !state.films) return;

    // Archive films (pool: false) score on rosters but stay out of the pool.
    var films = state.films.films.filter(function (f) { return f.pool !== false; });
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

  // ---- chart tooltip -------------------------------------------------------

  var tipEl = null;

  function ensureTip() {
    if (tipEl) return tipEl;
    tipEl = document.createElement('div');
    tipEl.className = 'game-tip';
    tipEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(tipEl);
    return tipEl;
  }

  function wireChartTooltip() {
    var chart = $('[data-game-chart]');
    if (!chart || chart.__tipWired) return;
    chart.__tipWired = true;
    var tip = ensureTip();

    function move(e) {
      var pad = 14;
      var x = e.clientX + pad;
      var y = e.clientY - tip.offsetHeight - pad;
      if (x + tip.offsetWidth > window.innerWidth - 8) x = e.clientX - tip.offsetWidth - pad;
      if (y < 8) y = e.clientY + pad;
      tip.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    }

    chart.addEventListener('mouseover', function (e) {
      var seg = e.target.closest('.game-chart__seg[data-tip-name]');
      if (!seg) return;
      tip.innerHTML = '<span class="game-tip__chip" style="background:'
        + seg.style.background + '"></span>'
        + '<span class="game-tip__name">' + esc(seg.getAttribute('data-tip-name')) + '</span>'
        + '<span class="game-tip__pts">' + esc(seg.getAttribute('data-tip-pts')) + ' PTS</span>';
      tip.classList.add('is-visible');
      move(e);
    });
    chart.addEventListener('mousemove', function (e) {
      if (tip.classList.contains('is-visible')) move(e);
    });
    chart.addEventListener('mouseout', function (e) {
      if (!e.relatedTarget || !e.relatedTarget.closest('.game-chart__seg')) {
        tip.classList.remove('is-visible');
      }
    });
  }

  // ---- victory conditions --------------------------------------------------
  // Five categories from the 2026-27 playbook. Highest Points and Most
  // Undervalued Prospect compute from live data; the other three wait on
  // Oscar fields (season.results.bestPicture, film.oscarWins, film.bpNom).

  // Draft round from a pick label. "R6"/"S6" -> 6; numeric picks map by league
  // size; picks past 10 rounds are waiver adds (round null).
  function pickRound(pick, numPlayers) {
    if (pick == null || pick === '') return null;
    var s = String(pick).trim();
    var m = s.match(/^[RS](\d+)$/i);
    if (m) return parseInt(m[1], 10);
    if (/^\d+$/.test(s)) {
      var n = parseInt(s, 10);
      if (n > numPlayers * 10) return null; // waiver add
      return Math.ceil(n / numPlayers);
    }
    return null;
  }

  function computeConditions(league) {
    var players = league.players || [];
    var numPlayers = players.length || 1;
    var rows = players.map(function (p) { return { player: p, totals: playerTotals(p) }; });

    function leaderCard(title, desc, leader, value, tbd) {
      return { title: title, desc: desc, leader: leader, value: value, tbd: tbd || '' };
    }

    // 1. Highest Points
    var byPts = rows.slice().sort(function (a, b) { return b.totals.total - a.totals.total; });
    var c1 = leaderCard('Highest Points', 'The team with the highest overall point total.',
      byPts[0] ? byPts[0].player.name : '', byPts[0] ? byPts[0].totals.total.toLocaleString() + ' PTS' : '');

    // 2. Best Picture
    var bpSlug = (state.season.results && state.season.results.bestPicture) || '';
    var c2;
    if (!bpSlug) {
      c2 = leaderCard('Best Picture', 'The team holding the Best Picture winner.',
        '', '', 'Decided on Oscar night');
    } else {
      var holder = '';
      players.forEach(function (p) {
        (p.roster || []).forEach(function (slot) {
          if (slot.filmSlug === bpSlug) holder = p.name;
        });
      });
      var bpFilm = state.filmMap[bpSlug];
      c2 = holder
        ? leaderCard('Best Picture', 'The team holding the Best Picture winner.',
            holder, bpFilm ? bpFilm.title : bpSlug)
        : leaderCard('Best Picture', 'The team holding the Best Picture winner.',
            '', '', 'No team holds the winner');
    }

    // 3. Most Variety — most individual films winning Academy Awards
    var anyWins = Object.keys(state.filmMap).some(function (k) {
      return (state.filmMap[k].oscarWins || 0) > 0;
    });
    var c3;
    if (!anyWins) {
      c3 = leaderCard('Most Variety', 'The team with the most individual films to win Academy Awards.',
        '', '', 'Decided on Oscar night');
    } else {
      var best = null;
      rows.forEach(function (r) {
        var count = 0;
        (r.player.roster || []).forEach(function (slot) {
          var f = state.filmMap[slot.filmSlug];
          if (f && (f.oscarWins || 0) > 0) count++;
        });
        if (!best || count > best.count) best = { name: r.player.name, count: count };
      });
      c3 = leaderCard('Most Variety', 'The team with the most individual films to win Academy Awards.',
        best.name, best.count + ' winning films');
    }

    // 4. Bench Performance — highest average among films NOT BP-nominated
    var anyNoms = Object.keys(state.filmMap).some(function (k) {
      return state.filmMap[k].bpNom === true;
    });
    var c4;
    if (!anyNoms) {
      c4 = leaderCard('Bench Performance', 'The team with the highest average score among films not nominated for Best Picture.',
        '', '', 'Waits on the Oscar nominations');
    } else {
      var bestBench = null;
      rows.forEach(function (r) {
        var sum = 0, n = 0;
        (r.player.roster || []).forEach(function (slot) {
          var f = state.filmMap[slot.filmSlug];
          if (f && f.bpNom !== true) { sum += filmBreakdown(f).total; n++; }
        });
        var avg = n ? sum / n : 0;
        if (!bestBench || avg > bestBench.avg) bestBench = { name: r.player.name, avg: avg };
      });
      c4 = leaderCard('Bench Performance', 'The team with the highest average score among films not nominated for Best Picture.',
        bestBench.name, Math.round(bestBench.avg).toLocaleString() + ' AVG');
    }

    // 5. Most Undervalued Prospect — highest-scoring film drafted rounds 6-10
    var bestProspect = null;
    rows.forEach(function (r) {
      (r.player.roster || []).forEach(function (slot) {
        var round = pickRound(slot.pick, numPlayers);
        if (round == null || round < 6 || round > 10) return;
        var f = state.filmMap[slot.filmSlug];
        if (!f) return;
        var total = filmBreakdown(f).total;
        if (!bestProspect || total > bestProspect.total) {
          bestProspect = { name: r.player.name, film: f.title, total: total };
        }
      });
    });
    var c5 = bestProspect
      ? leaderCard('Most Undervalued Prospect', 'The team with the highest-scoring film drafted between rounds 6\u201310 (waiver adds excluded).',
          bestProspect.name, bestProspect.film + ' \u2014 ' + bestProspect.total.toLocaleString() + ' PTS')
      : leaderCard('Most Undervalued Prospect', 'The team with the highest-scoring film drafted between rounds 6\u201310 (waiver adds excluded).',
          '', '', 'No round 6\u201310 picks yet');

    return [c1, c2, c3, c4, c5];
  }

  function renderVictoryConditions(league) {
    var el = $('[data-game-vc]');
    if (!el) return;

    el.innerHTML = computeConditions(league).map(function (c, i) {
      var status = c.leader
        ? '<span class="game-vc__leader">' + esc(c.leader) + '</span>'
          + '<span class="game-vc__value">' + esc(c.value) + '</span>'
        : '<span class="game-vc__tbd">' + esc(c.tbd) + '</span>';
      return '<article class="game-vc__card">'
        + '<span class="game-vc__num">' + (i + 1) + '</span>'
        + '<h3 class="game-vc__title">' + esc(c.title) + '</h3>'
        + '<p class="game-vc__desc">' + esc(c.desc) + '</p>'
        + status
        + '</article>';
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
    renderVictoryConditions(league);
    renderRosters(league);
    renderScoringChart(league);
    wireChartTooltip();
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
