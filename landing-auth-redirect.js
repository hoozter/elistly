(function () {
  'use strict';

  async function redirectIfLoggedIn() {
    var authUrl = (window.NEON_AUTH_URL || '').replace(/\/$/, '');
    if (!authUrl) return;

    try {
      var response = await fetch(authUrl + '/get-session', {
        method: 'GET',
        credentials: 'include'
      });
      if (!response.ok) return;
      var body = await response.json().catch(function () { return null; });
      if (body && body.user) {
        window.location.replace('app.html');
      }
    } catch (_) {
      // Landing page should stay usable even if auth check fails.
    }
  }

  redirectIfLoggedIn();
})();
