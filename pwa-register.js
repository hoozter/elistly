(function () {
  'use strict';

  if (!('serviceWorker' in navigator)) return;
  var isLocalhost = ['localhost', '127.0.0.1', '[::1]'].indexOf(window.location.hostname) >= 0;
  if (window.location.protocol !== 'https:' && !isLocalhost) return;

  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./sw.js').catch(function (err) {
      console.warn('Service worker registration failed:', err);
    });
  });
})();
