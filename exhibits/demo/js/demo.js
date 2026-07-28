/**
 * Demo exhibit script.
 *
 * Runs in the page's global scope; exhibit markup lives in a shadow root, so
 * query window.sacdaExhibitRoot instead of document (see exhibits/README.md).
 */
(function () {
  'use strict';
  var root = window.sacdaExhibitRoot || document;
  var el = root.querySelector('#demo-time');
  if (el) {
    el.textContent = new Date().toLocaleString();
  }
})();
