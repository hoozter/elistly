/**
 * Elistly - Supabase-compatible client using JWT auth via Worker
 *
 * This script sets window.supabase with an API compatible with @supabase/supabase-js
 * but backed by the Elistly Worker API instead of Supabase.
 *
 * Load this before app.js in index.html.
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

  function authHeaders(extra = {}) {
    const headers = { ...extra };
    const token = getToken();
    if (token && !headers.Authorization) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  async function loadNeonSession() {
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

  // Auth module - mimics Supabase auth API
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
        const res = await fetch(`${AUTH_URL}/sign-in/email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email, password, rememberMe: true, callbackURL: '/app' }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          return { error: new Error(json.message || json.error || 'Login failed'), data: null };
        }
        return loadNeonSession();
      } catch (e) {
        return { error: e, data: null };
      }
    },

    async signUp({ email, password, options = {} }) {
      if (!AUTH_URL) return { error: new Error('Neon Auth URL not configured'), data: null };
      try {
        const name = options.data && options.data.user_name ? options.data.user_name : email.split('@')[0];
        const res = await fetch(`${AUTH_URL}/sign-up/email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email, password, name, callbackURL: '/app' }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          return { error: new Error(json.message || json.error || 'Signup failed'), data: null };
        }
        const sessionResult = await loadNeonSession();
        if (!sessionResult.error) return sessionResult;
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
      clearToken();
      // Also tell Worker to clear cookie
      try {
        if (AUTH_URL) {
          await fetch(`${AUTH_URL}/sign-out`, { method: 'POST', credentials: 'include' });
        }
      } catch (_) {}
      return { error: null };
    },

    // Stubs for unimplemented Supabase auth methods
    async resetPasswordForEmail(email, options = {}) {
      return { error: new Error('Password reset is not implemented in this deployment'), data: null };
    },

    async resend({ type, email }) {
      if (!AUTH_URL) return { error: new Error('Neon Auth URL not configured'), data: null };
      if (type !== 'signup') return { error: new Error('Only signup email verification can be resent'), data: null };
      try {
        const res = await fetch(`${AUTH_URL}/send-verification-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email, callbackURL: '/app' }),
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

    async updateUser(attributes) {
      return { error: new Error('User update via auth is not implemented'), data: null };
    },

    // MFA
    async mfaListFactors() {
      return { data: { totp: [] }, error: null };
    },

    async mfaEnroll({ factorType }) {
      if (factorType !== 'totp') return { error: new Error('Only TOTP supported'), data: null };
      const { data: { session } } = await this.getSession();
      if (!session) return { error: new Error('Not authenticated'), data: null };
      try {
        const res = await fetch(`${API_URL}/auth/mfa/enroll`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          credentials: 'include',
          body: JSON.stringify({}),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          return { error: new Error(json.error || 'Enroll failed'), data: null };
        }
        return {
          data: {
            id: json.factor_id,
            totp: {
              qr_code: json.qr_code,
              secret: json.secret,
            },
          },
          error: null,
        };
      } catch (e) {
        return { error: e, data: null };
      }
    },

    async mfaChallenge({ factorId }) {
      const { data: { session } } = await this.getSession();
      if (!session) return { error: new Error('Not authenticated'), data: null };
      try {
        const res = await fetch(`${API_URL}/auth/mfa/challenge`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          credentials: 'include',
          body: JSON.stringify({ factorId }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          return { error: new Error(json.error || 'Challenge failed'), data: null };
        }
        return { data: { challenge: json.challenge }, error: null };
      } catch (e) {
        return { error: e, data: null };
      }
    },

    async mfaVerify({ factorId, code }) {
      const { data: { session } } = await this.getSession();
      if (!session) return { error: new Error('Not authenticated'), data: null };
      try {
        const res = await fetch(`${API_URL}/auth/mfa/verify`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          credentials: 'include',
          body: JSON.stringify({ factor_id: factorId, code }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          return { error: new Error(json.error || 'Verification failed'), data: null };
        }
        if (json.token) setToken(json.token); // upgrade token after MFA verify
        return { data: {}, error: null };
      } catch (e) {
        return { error: e, data: null };
      }
    },

    async mfaUnenroll({ factorId }) {
      const { data: { session } } = await this.getSession();
      if (!session) return { error: new Error('Not authenticated'), data: null };
      try {
        const res = await fetch(`${API_URL}/auth/mfa/unenroll`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          credentials: 'include',
          body: JSON.stringify({ factor_id: factorId }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          return { error: new Error(json.error || 'Unenroll failed'), data: null };
        }
        return { data: {}, error: null };
      } catch (e) {
        return { error: e, data: null };
      }
    },

    async mfaGetAuthenticatorAssuranceLevel() {
      return { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null };
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

  // QueryBuilder for direct DB access (when API_URL is set, it goes through /db/query)
  class QueryBuilder {
    constructor(table) {
      this.table = table;
      this.selects = '*';
      this.filters = [];
      this.params = [];
      this.orderList = [];
      this.limitCount = null;
      this.singleMode = false;
      this.isRpc = false;
    }

    select(...args) {
      if (args.length > 0 && typeof args[0] === 'string') {
        this.selects = args.join(', ');
      }
      return this;
    }

    eq(column, value) {
      this.filters.push(`"${column}" = $${this.params.length + 1}`);
      this.params.push(value);
      return this;
    }

    is(column, operator, value) {
      if (value === null) {
        this.filters.push(`"${column}" IS NULL`);
      } else {
        this.filters.push(`"${column}" IS ${operator} $${this.params.length + 1}`);
        this.params.push(value);
      }
      return this;
    }

    not(column, operator, value) {
      if (value === null) {
        this.filters.push(`"${column}" IS NOT NULL`);
      } else {
        this.filters.push(`NOT ("${column}" ${operator} $${this.params.length + 1})`);
        this.params.push(value);
      }
      return this;
    }

    lt(column, value) {
      this.filters.push(`"${column}" < $${this.params.length + 1}`);
      this.params.push(value);
      return this;
    }

    in(column, values) {
      const placeholders = values.map((_, i) => `$${this.params.length + i + 1}`).join(', ');
      this.filters.push(`"${column}" IN (${placeholders})`);
      this.params.push(...values);
      return this;
    }

    order(column, options = {}) {
      const direction = options.ascending === false ? 'DESC' : 'ASC';
      let sql = `"${column}" ${direction}`;
      if (options.nullsFirst) sql += ' NULLS FIRST';
      if (options.nullsLast) sql += ' NULLS LAST';
      this.orderList.push(sql);
      return this;
    }

    limit(count) {
      this.limitCount = count;
      return this;
    }

    maybeSingle() {
      this.singleMode = true;
      this.limitCount = 1;
      return this;
    }

    single() {
      this.singleMode = true;
      this.limitCount = 1;
      return this;
    }

    rpc(functionName, params = {}) {
      this.isRpc = true;
      this.table = functionName;
      this.params = Object.values(params);
      return this;
    }

    range() { return this; }

    or(filterStr) {
      if (!filterStr) return this;
      const conditions = filterStr.split(',');
      const orParts = [];
      let paramOffset = this.params.length;

      for (const cond of conditions) {
        const parts = cond.trim().split('.');
        if (parts.length < 3) continue;
        const col = parts[0];
        const op = parts[1].toLowerCase();
        const val = parts.slice(2).join('.');

        switch (op) {
          case 'eq':
            orParts.push(`"${col}" = $${paramOffset + 1}`);
            this.params.push(val);
            paramOffset++;
            break;
          case 'ne':
          case 'neq':
            orParts.push(`"${col}" != $${paramOffset + 1}`);
            this.params.push(val);
            paramOffset++;
            break;
          case 'gt':
            orParts.push(`"${col}" > $${paramOffset + 1}`);
            this.params.push(val);
            paramOffset++;
            break;
          case 'gte':
          case 'gteq':
            orParts.push(`"${col}" >= $${paramOffset + 1}`);
            this.params.push(val);
            paramOffset++;
            break;
          case 'lt':
            orParts.push(`"${col}" < $${paramOffset + 1}`);
            this.params.push(val);
            paramOffset++;
            break;
          case 'lte':
          case 'lteq':
            orParts.push(`"${col}" <= $${paramOffset + 1}`);
            this.params.push(val);
            paramOffset++;
            break;
          case 'is':
            if (val === 'null') {
              orParts.push(`"${col}" IS NULL`);
            } else if (val === 'not.null') {
              orParts.push(`"${col}" IS NOT NULL`);
            } else {
              orParts.push(`"${col}" IS $${paramOffset + 1}`);
              this.params.push(val);
              paramOffset++;
            }
            break;
          default:
            console.warn('Unsupported operator in .or():', op);
        }
      }

      if (orParts.length > 0) {
        this.filters.push(`(${orParts.join(' OR ')})`);
      }
      return this;
    }

    async execute() {
      let sql;
      if (this.isRpc) {
        const funcName = this.table;
        const paramPlaceholders = this.params.map((_, i) => `$${i + 1}`).join(', ');
        sql = `SELECT * FROM "${funcName}"(${paramPlaceholders})`;
      } else {
        let base = `SELECT ${this.selects} FROM "${this.table}"`;
        if (this.filters.length > 0) {
          base += ' WHERE ' + this.filters.join(' AND ');
        }
        if (this.orderList.length > 0) {
          base += ' ORDER BY ' + this.orderList.join(', ');
        }
        if (this.limitCount) {
          base += ` LIMIT ${this.limitCount}`;
        }
        sql = base;
      }

      try {
        const res = await fetch(`${API_URL}/db/query`, {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          credentials: 'include',
          body: JSON.stringify({ sql, params: this.params }),
        });
        const json = await res.json();
        if (!res.ok || json.error) {
          throw new Error(json.error?.message || 'Query failed');
        }
        const rows = json.data || [];
        return { data: this.singleMode ? (rows[0] || null) : rows, error: null };
      } catch (err) {
        console.error('DB query error:', err.message, sql, this.params);
        return { data: null, error: { message: err.message } };
      }
    }

    async insert(data) {
      const columns = Object.keys(data);
      const values = columns.map((_, i) => `$${i + 1}`);
      this.params.push(...Object.values(data));
      const quotedCols = columns.map(c => `"${c}"`).join(', ');
      const sql = `INSERT INTO "${this.table}" (${quotedCols}) VALUES (${values.join(', ')}) RETURNING *`;
      return this._execReturning(sql);
    }

    async update(data) {
      if (this.filters.length === 0) {
        throw new Error('Update without filter is not allowed');
      }
      const setClause = Object.entries(data).map(([k], i) => `"${k}" = $${this.params.length + i + 1}`).join(', ');
      this.params.push(...Object.values(data));
      const where = this.filters.join(' AND ');
      const sql = `UPDATE "${this.table}" SET ${setClause} WHERE ${where} RETURNING *`;
      return this._execReturning(sql);
    }

    async delete() {
      let sql = `DELETE FROM "${this.table}"`;
      if (this.filters.length > 0) {
        sql += ' WHERE ' + this.filters.join(' AND ');
      }
      sql += ' RETURNING *';
      return this._execReturning(sql);
    }

    async upsert(data, options = {}) {
      const conflictTarget = options.onConflict || '';
      const onConflictDo = options.onConflictDo || 'update';
      const columns = Object.keys(data);
      const values = columns.map((_, i) => `$${i + 1}`);
      this.params.push(...Object.values(data));
      const quotedCols = columns.map(c => `"${c}"`).join(', ');
      const quotedConflict = conflictTarget ? `"${conflictTarget}"` : '';

      let sql = `INSERT INTO "${this.table}" (${quotedCols}) VALUES (${values.join(', ')})`;
      if (conflictTarget) {
        sql += ` ON CONFLICT (${quotedConflict})`;
        if (onConflictDo === 'nothing') {
          sql += ' DO NOTHING';
        } else {
          const updates = columns.map(c => `"${c}" = EXCLUDED."${c}"`).join(', ');
          sql += ` DO UPDATE SET ${updates}`;
        }
      }
      sql += ' RETURNING *';
      return this._execReturning(sql);
    }

    async _execReturning(sql) {
      try {
        const res = await fetch(`${API_URL}/db/query`, {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          credentials: 'include',
          body: JSON.stringify({ sql, params: this.params }),
        });
        const json = await res.json();
        if (!res.ok || json.error) {
          throw new Error(json.error?.message || 'Query failed');
        }
        const rows = json.data || [];
        return { data: this.singleMode ? (rows[0] || null) : rows, error: null };
      } catch (err) {
        console.error('Query error:', err.message, sql, this.params);
        return { data: null, error: { message: err.message } };
      }
    }
  }

  // Build supabase client
  function createSupabaseClient() {
    const client = {
      from(table) {
        return new QueryBuilder(table);
      },
      rpc(fn, params) {
        return new QueryBuilder(null).rpc(fn, params);
      },
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
        signInWithPassword: Auth.signInWithPassword.bind(Auth),
        signUp: Auth.signUp.bind(Auth),
        signOut: Auth.signOut.bind(Auth),
        getSession: Auth.getSession.bind(Auth),
        getUser: Auth.getUser.bind(Auth),
        refreshSession: Auth.refreshSession.bind(Auth),
        resetPasswordForEmail: Auth.resetPasswordForEmail.bind(Auth),
        resend: Auth.resend.bind(Auth),
        updateUser: Auth.updateUser.bind(Auth),
        mfa: {
          listFactors: Auth.mfaListFactors.bind(Auth),
          enroll: Auth.mfaEnroll.bind(Auth),
          challenge: Auth.mfaChallenge.bind(Auth),
          verify: Auth.mfaVerify.bind(Auth),
          unenroll: Auth.mfaUnenroll.bind(Auth),
          getAuthenticatorAssuranceLevel: Auth.mfaGetAuthenticatorAssuranceLevel.bind(Auth),
        },
      },
    };
    return client;
  }

  // Expose globally
  window.supabase = createSupabaseClient();
})();
