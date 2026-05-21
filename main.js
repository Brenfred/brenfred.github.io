/* ==========================================================================
   FANTASY FILMBALL — main.js
   Lightweight interactivity: mobile nav toggle.
   ========================================================================== */

(function () {
  'use strict';

  // -- Mobile nav toggle -----------------------------------------------------
  var toggle = document.querySelector('.nav__toggle');
  var links  = document.querySelector('.nav__links');

  if (toggle && links) {
    toggle.addEventListener('click', function () {
      var open = links.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = open ? 'Close' : 'Menu';
    });
  }

  // -- Pause ticker on tab inactive (perf) -----------------------------------
  var ticker = document.querySelector('.ticker__inner');
  if (ticker) {
    document.addEventListener('visibilitychange', function () {
      ticker.style.animationPlayState = document.hidden ? 'paused' : 'running';
    });
  }

  // -- Race view toggle (Films / Categories) ---------------------------------
  // Lives on /oscar-race.html. The chosen view is mirrored to the URL hash
  // so it survives reloads and links shared between people.
  var viewToggle = document.querySelector('[data-view-toggle]');
  if (viewToggle) {
    var panes = document.querySelectorAll('[data-race-pane]');
    var buttons = viewToggle.querySelectorAll('[data-view]');

    function setView(view) {
      if (view !== 'films' && view !== 'categories') view = 'films';
      panes.forEach(function (p) {
        var match = p.getAttribute('data-race-pane') === view;
        if (match) p.removeAttribute('hidden');
        else p.setAttribute('hidden', '');
      });
      buttons.forEach(function (b) {
        var match = b.getAttribute('data-view') === view;
        b.classList.toggle('is-active', match);
        b.setAttribute('aria-pressed', String(match));
      });
      // Mirror to URL hash without scrolling
      if (window.history && window.history.replaceState) {
        var newHash = '#' + view;
        if (window.location.hash !== newHash) {
          window.history.replaceState(null, '', window.location.pathname + window.location.search + newHash);
        }
      }
    }

    // Init from hash. Default = films.
    var initial = (window.location.hash || '').replace('#', '');
    setView(initial || 'films');

    buttons.forEach(function (b) {
      b.addEventListener('click', function () {
        setView(b.getAttribute('data-view'));
      });
    });

    // Also respond to back/forward navigation
    window.addEventListener('hashchange', function () {
      setView((window.location.hash || '').replace('#', ''));
    });
  }
})();
