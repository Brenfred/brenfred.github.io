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
})();
