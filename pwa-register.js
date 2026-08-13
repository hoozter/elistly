(function () {
  'use strict';

  if (!('serviceWorker' in navigator)) return;
  var isLocalhost = ['localhost', '127.0.0.1', '[::1]'].indexOf(window.location.hostname) >= 0;
  if (window.location.protocol !== 'https:' && !isLocalhost) return;

  var reloadingForUpdate = false;
  var wasControlled = !!navigator.serviceWorker.controller;

  function hasPendingLocalWrites() {
    if (!window.ElistlyStorage || typeof window.ElistlyStorage.getSyncStatus !== 'function') return false;
    var sync = window.ElistlyStorage.getSyncStatus();
    return !(sync.state === 'synced');
  }

  function activateWhenSafe(registration) {
    if (!registration.waiting || hasPendingLocalWrites()) return;
    registration.waiting.postMessage('SKIP_WAITING');
  }

  window.addEventListener('load', function () {
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!wasControlled || reloadingForUpdate) return;
      reloadingForUpdate = true;
      window.location.reload();
    });

    navigator.serviceWorker.register('./sw.js').then(function (registration) {
      activateWhenSafe(registration);
      registration.addEventListener('updatefound', function () {
        var installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', function () {
          if (installing.state === 'installed') activateWhenSafe(registration);
        });
      });
      window.addEventListener('online', function () { activateWhenSafe(registration); });
      window.addEventListener('elistly:sync-status', function () { activateWhenSafe(registration); });
    }).catch(function (err) {
      console.warn('Service worker registration failed:', err);
    });
  });
})();
