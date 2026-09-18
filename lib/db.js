/**
 * Elistly browser client using Neon Auth and the Elistly Worker API.
 *
 * Load this before app.js in index.html.
 *
 * Exposes window.elistlyClient.
 */

(function() {
  // Get API URL from global config (set by config.js)
  const API_URL = (window.ELISTLY_API_URL || '').replace(/\/$/, '');
  const AUTH_URL = (window.NEON_AUTH_URL || '').replace(/\/$/, '');
  if (!API_URL) {
    console.warn('Elistly: ELISTLY_API_URL is not set. API calls will fail.');
  }
  if (!AUTH_URL) {
    console.warn('Elistly: NEON_AUTH_URL is not set. Auth calls will fail.');
  }

  const TOKEN_KEY = 'elistly_token';
  let sessionGeneration = 0;
  let pendingSignOuts = 0;
  const authenticationRequests = new Set();

  async function requestAuthentication(path, body) {
    if (pendingSignOuts) throw new Error('Sign out is still in progress.');
    const generation = sessionGeneration;
    const request = fetch(`${AUTH_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    authenticationRequests.add(request);
    try {
      const res = await request;
      const json = await res.json().catch(() => ({}));
      if (generation !== sessionGeneration) throw new Error('Session changed while authentication was in progress.');
      return { res, json, generation };
    } finally {
      authenticationRequests.delete(request);
    }
  }

  // Token storage
  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  }
  function setToken(token) {
    try { localStorage.setItem(TOKEN_KEY, token); } catch {}
  }
  function clearToken() {
    try { localStorage.removeItem(TOKEN_KEY); } catch {}
  }

  async function loadNeonSession(generation = sessionGeneration) {
    if (generation !== sessionGeneration || pendingSignOuts) return { error: new Error('Session changed while authentication was in progress.'), data: null };
    const previousToken = getToken();
    if (!AUTH_URL) return { error: new Error('Neon Auth URL not configured'), data: null };
    const res = await fetch(`${AUTH_URL}/get-session`, {
      method: 'GET',
      credentials: 'include',
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || !json.user) {
      return { error: new Error((json && (json.message || json.error)) || 'No active auth session'), data: null };
    }
    const jwt = res.headers.get('set-auth-jwt');
    if (!jwt) {
      return { error: new Error('Neon Auth did not return a JWT'), data: null };
    }
    if (generation !== sessionGeneration || getToken() !== previousToken) {
      return { error: new Error('Session changed while authentication was in progress.'), data: null };
    }
    setToken(jwt);
    return {
      data: {
        user: {
          id: json.user.id,
          email: json.user.email,
          name: json.user.name,
        },
        session: {
          access_token: jwt,
          user: {
            id: json.user.id,
            email: json.user.email,
          },
        },
      },
      error: null,
    };
  }

  // Decode JWT payload without verification (signature verified by Worker on each request)
  function decodeToken(token) {
    if (!token) return null;
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      // Replace URL-safe base64
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      // Pad
      const pad = base64.length % 4;
      const base64padded = pad ? base64 + '==='.slice(0, 4 - pad) : base64;
      const json = atob(base64padded);
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  // The adapter contract is intentionally explicit: only flows backed by the
  // deployed Neon Auth endpoints belong here.
  const ACCOUNT_CAPABILITIES = Object.freeze({
    passwordReset: false,
    emailManagement: false,
    mfa: false,
  });

  // Auth module used by app.js.
  const Auth = {
    async getSession() {
      const token = getToken();
      if (!token) return { data: { session: null } };
      const payload = decodeToken(token);
      if (!payload || !payload.sub) {
        clearToken();
        return { data: { session: null } };
      }
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp && now > payload.exp) {
        const refreshed = await this.refreshSession();
        if (refreshed && !refreshed.error && refreshed.data && refreshed.data.session) {
          return this.getSession();
        }
        if (getToken() !== token) return this.getSession();
        clearToken();
        return { data: { session: null } };
      }
      return {
        data: {
          session: {
            access_token: token,
            token_type: 'bearer',
            expires_at: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
            user: {
              id: payload.sub,
              email: payload.email,
            },
          },
        },
      };
    },

    async getUser() {
      const { data: { session } } = await this.getSession();
      if (!session) return { data: { user: null } };
      // We could fetch user preferences/profile from Worker, but include minimal
      return {
        data: {
          user: {
            id: session.user.id,
            email: session.user.email,
          },
        },
      };
    },

    async signInWithPassword({ email, password }) {
      if (!AUTH_URL) return { error: new Error('Neon Auth URL not configured'), data: null };
      try {
        const { res, json, generation } = await requestAuthentication('/sign-in/email', { email, password, rememberMe: true, callbackURL: '/app' });
        if (!res.ok) {
          return { error: new Error(json.message || json.error || 'Login failed'), data: null };
        }
        return loadNeonSession(generation);
      } catch (e) {
        return { error: e, data: null };
      }
    },

    async signUp({ email, password, options = {} }) {
      if (!AUTH_URL) return { error: new Error('Neon Auth URL not configured'), data: null };
      try {
        const name = options.data && options.data.user_name ? options.data.user_name : email.split('@')[0];
        const { res, json, generation } = await requestAuthentication('/sign-up/email', { email, password, name, callbackURL: '/app' });
        if (!res.ok) {
          return { error: new Error(json.message || json.error || 'Signup failed'), data: null };
        }
        const sessionResult = await loadNeonSession(generation);
        if (!sessionResult.error || generation !== sessionGeneration) return sessionResult;
        return {
          data: {
            user: json.user || null,
            session: null,
          },
          error: null,
        };
      } catch (e) {
        return { error: e, data: null };
      }
    },

    async signOut() {
      sessionGeneration += 1;
      pendingSignOuts += 1;
      let cleanupError = null;
      try {
        localStorage.removeItem(TOKEN_KEY);
        if (localStorage.getItem(TOKEN_KEY) !== null) throw new Error('Local session could not be cleared.');
      } catch (error) { cleanupError = error; }
      // Revoke the Neon cookie session even if local token cleanup failed.
      try {
        await Promise.allSettled([...authenticationRequests]);
        if (!AUTH_URL) throw new Error('Neon Auth URL not configured');
        const res = await fetch(`${AUTH_URL}/sign-out`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: '{}',
        });
        if (!res.ok) throw new Error('Auth session could not be revoked.');
      } catch (error) { return { error: cleanupError || error }; }
      finally { pendingSignOuts -= 1; }
      return { error: cleanupError };
    },


    async resend({ type, email }) {
      if (!AUTH_URL) return { error: new Error('Neon Auth URL not configured'), data: null };
      if (type !== 'signup') return { error: new Error('Only signup email verification can be resent'), data: null };
      try {
        const res = await fetch(`${AUTH_URL}/email-otp/send-verification-otp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email, type: 'email-verification' }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          return { error: new Error(json.message || json.error || 'Could not resend email'), data: null };
        }
        return { data: json, error: null };
      } catch (e) {
        return { error: e, data: null };
      }
    },

    async verifyOtp({ email, token, otp, type }) {
      if (!AUTH_URL) return { error: new Error('Neon Auth URL not configured'), data: null };
      if (type && type !== 'signup' && type !== 'email') {
        return { error: new Error('Only email verification is supported'), data: null };
      }
      try {
        const { res, json, generation } = await requestAuthentication('/email-otp/verify-email', { email, otp: otp || token });
        if (!res.ok) {
          return { error: new Error(json.message || json.error || 'Could not verify email'), data: null };
        }
        const sessionResult = await loadNeonSession(generation);
        if (!sessionResult.error || generation !== sessionGeneration) return sessionResult;
        return { data: json, error: null };
      } catch (e) {
        return { error: e, data: null };
      }
    },


    async refreshSession() {
      const token = getToken();
      if (!token) return { error: new Error('Not authenticated'), data: null };
      try {
        return loadNeonSession();
      } catch (e) {
        return { error: e, data: null };
      }
    },


  };

  // Build Elistly client
  function createElistlyClient() {
    const client = {
      async getSession() {
        return Auth.getSession();
      },
      async getUser() {
        return Auth.getUser();
      },
      signInWithPassword: Auth.signInWithPassword.bind(Auth),
      signUp: Auth.signUp.bind(Auth),
      signOut: Auth.signOut.bind(Auth),
      auth: {
        capabilities: ACCOUNT_CAPABILITIES,
        signInWithPassword: Auth.signInWithPassword.bind(Auth),
        signUp: Auth.signUp.bind(Auth),
        signOut: Auth.signOut.bind(Auth),
        getSession: Auth.getSession.bind(Auth),
        getUser: Auth.getUser.bind(Auth),
        refreshSession: Auth.refreshSession.bind(Auth),
        resend: Auth.resend.bind(Auth),
        verifyOtp: Auth.verifyOtp.bind(Auth),
      },
    };
    return client;
  }

  // Expose globally
  window.elistlyClient = createElistlyClient();
})();
