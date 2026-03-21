(function () {
  'use strict';

  var SUPABASE_CDNS = [
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
    'https://unpkg.com/@supabase/supabase-js@2'
  ];

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[src="' + src + '"]');
      if (existing) {
        if (existing.dataset.loaded === 'true') return resolve();
        existing.addEventListener('load', function () { resolve(); }, { once: true });
        existing.addEventListener('error', function () { reject(new Error('Failed to load ' + src)); }, { once: true });
        return;
      }
      var script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.onload = function () {
        script.dataset.loaded = 'true';
        resolve();
      };
      script.onerror = function () { reject(new Error('Failed to load ' + src)); };
      document.head.appendChild(script);
    });
  }

  async function ensureSupabase() {
    if (typeof window.supabase !== 'undefined') return true;
    for (var i = 0; i < SUPABASE_CDNS.length; i += 1) {
      try {
        await loadScript(SUPABASE_CDNS[i]);
        if (typeof window.supabase !== 'undefined') return true;
      } catch (_) {}
    }
    return false;
  }

  async function redirectIfLoggedIn() {
    var url = window.SUPABASE_URL;
    var anonKey = window.SUPABASE_ANON_KEY;
    if (!url || !anonKey) return;

    var hasSupabase = await ensureSupabase();
    if (!hasSupabase) return;

    try {
      var client = window.supabase.createClient(url, anonKey);
      var sessionResult = await client.auth.getSession();
      var session = sessionResult && sessionResult.data && sessionResult.data.session;
      if (session) {
        window.location.replace('app.html');
      }
    } catch (_) {
      // Landing page should stay usable even if auth check fails.
    }
  }

  redirectIfLoggedIn();
})();
