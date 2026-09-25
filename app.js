/**
 * elistly Application
 * Version 1.12.1
 * A modular system for managing entities, categories, and their relationships
 */

// Global version constant - update this value to trigger update checks
const CURRENT_VERSION = '1.12.1';

// Load version history on demand (changelog / update modal). Sets window.VERSION_CHANGES.
function loadVersionHistory() {
  if (window.VERSION_CHANGES) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'version-history.js';
    script.onload = () => resolve();
    script.onerror = () => {
      window.VERSION_CHANGES = [];
      resolve();
    };
    document.head.appendChild(script);
  });
}

// Available Material Design icons for use throughout the application
const MATERIAL_ICONS = [
  'computer', 'devices', 'phone_android', 'tablet_android', 'laptop',
  'desktop_windows', 'keyboard', 'mouse', 'speaker', 'router', 'hub',
  'memory', 'sd_card', 'sim_card', 'developer_board', 'dns', 'storage',
  'usb', 'wifi', 'bluetooth', 'phonelink', 'cast', 'headset', 'print',
  'scanner', 'security', 'settings', 'build', 'account_circle', 'group',
  'folder', 'description', 'assignment', 'bug_report', 'assessment',
  'help', 'info', 'warning', 'error', 'done', 'thumb_up', 'thumb_down',
  'person', 'person_outline', 'inventory_2', 'menu_book', 'local_library', 'book',
  'event', 'event_note', 'schedule', 'location_on', 'place', 'home', 'apartment', 'business',
  'work', 'meeting_room', 'add_circle', 'remove_circle', 'edit', 'delete', 'search', 'close',
  'expand_more', 'expand_less', 'chevron_right', 'chevron_left', 'dashboard', 'category',
  'list', 'grid_view', 'view_list', 'view_module', 'label', 'bookmark', 'star'
];

// API URL getter (used by apiRequest)
function getApiUrl() {
  if (typeof window === 'undefined') return '';
  return (window.ELISTLY_API_URL || '').trim();
}

// Elistly client is loaded from lib/db.js and backed by Neon Auth.
var backendClient = null;

async function ensureBackendClient() {
  if (backendClient) return backendClient;
  if (!getApiUrl() || !window.NEON_AUTH_URL) {
    console.error('Elistly: ELISTLY_API_URL and NEON_AUTH_URL must be configured.');
    return null;
  }
  if (typeof window.elistlyClient !== 'undefined') {
    backendClient = window.elistlyClient;
    return backendClient;
  }
  console.error('Elistly: Elistly client not loaded. Ensure lib/db.js is included before app.js.');
  return null;
}

async function getAuthSession() {
  if (!backendClient) return null;
  const { data: { session } } = await backendClient.auth.getSession();
  return session || null;
}

async function getAuthUser() {
  if (!backendClient) return null;
  const { data: { user } } = await backendClient.auth.getUser();
  return user || null;
}

function getAccessTokenClaims(accessToken) {
  if (typeof accessToken !== 'string') return null;
  const payload = accessToken.split('.')[1];
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(normalized.padEnd(normalized.length + (4 - normalized.length % 4) % 4, '='));
    const claims = JSON.parse(json);
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : null;
  } catch (_) {
    return null;
  }
}

function isImportSessionKnownExpired(session, claims) {
  const now = Math.floor(Date.now() / 1000);
  const sessionExpiry = Number(session && session.expires_at);
  const tokenExpiry = Number(claims && claims.exp);
  return (Number.isFinite(sessionExpiry) && sessionExpiry > 0 && sessionExpiry <= now)
    || (Number.isFinite(tokenExpiry) && tokenExpiry > 0 && tokenExpiry <= now);
}

async function apiRequest(path, options = {}) {
  const apiUrl = getApiUrl();
  if (!apiUrl) throw new Error('ELISTLY_API_URL is not configured.');
  const session = Object.prototype.hasOwnProperty.call(options, 'authSession') ? options.authSession : await getAuthSession();
  const headers = Object.assign({}, options.headers || {});
  if (session && session.access_token && !headers.Authorization) {
    headers.Authorization = `Bearer ${session.access_token}`;
  }
  let body = options.body;
  if (body && typeof body !== 'string' && !(body instanceof FormData) && !(body instanceof Blob)) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(`${apiUrl.replace(/\/$/, '')}${path}`, {
    method: options.method || 'GET',
    headers,
    body,
    credentials: 'include',
    signal: options.signal
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

function jsonValuesEqual(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && jsonValuesEqual(left[key], right[key]));
}

// Storage layer: localStorage or account-backed API (one row per user in app_data)
const Storage = {
  KEY: 'elistlyData',
  USER_CACHE_PREFIX: 'elistlyData:user:',
  USER_UPDATED_PREFIX: 'elistlyData:userUpdated:',
  USER_OUTBOX_PREFIX: 'elistlyData:outbox:',
  USER_RECOVERY_PREFIX: 'elistlyData:recovery:',
  _accountGeneration: 0,
  _cachedUpdatedAt: undefined,
  _accountVerified: undefined,
  _refreshPromise: null,
  _cached: null,
  _cachedUserId: null,
  _isDirty: false,
  _saveChains: {},
  _conflictRecovery: null,
  _syncStatus: { state: 'idle', message: '' },

  _getUserCacheKey(userId) {
    return `${this.USER_CACHE_PREFIX}${userId}`;
  },

  _getUserUpdatedKey(userId) {
    return `${this.USER_UPDATED_PREFIX}${userId}`;
  },

  _getUserOutboxKey(userId) {
    return `${this.USER_OUTBOX_PREFIX}${userId}`;
  },

  _getDurableAccountKeys() {
    try {
      const keys = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key === this.KEY || key.startsWith(this.USER_CACHE_PREFIX) || key.startsWith(this.USER_UPDATED_PREFIX) || key.startsWith(this.USER_OUTBOX_PREFIX) || key.startsWith(this.USER_RECOVERY_PREFIX)) keys.push(key);
      }
      return keys;
    } catch (error) {
      throw new Error('Local account data could not be checked. Sign out was not completed.');
    }
  },

  _removeDurableKey(key) {
    localStorage.removeItem(key);
  },

  _clearInMemoryAccountState() {
    this._accountGeneration += 1;
    this._cached = null;
    this._cachedUserId = null;
    this._cachedUpdatedAt = undefined;
    this._accountVerified = undefined;
    this._refreshPromise = null;
    this._onRemoteSync = null;
    this._isDirty = false;
    this._saveChains = {};
    this._conflictRecovery = null;
    this._setSyncStatus('idle', '');
  },

  handleExternalDurableRemoval(key) {
    const userId = this._cachedUserId;
    if (key === null || key === this.KEY || (userId && [
      this._getUserCacheKey(userId),
      this._getUserUpdatedKey(userId),
      this._getUserOutboxKey(userId)
    ].includes(key))) {
      this._clearInMemoryAccountState();
      return true;
    }
    return false;
  },

  _withStorageLock(action) {
    if (!navigator.locks) throw new Error('This browser cannot safely coordinate local sync. Use a browser with Web Locks support.');
    return navigator.locks.request('elistly-account-data', action);
  },

  async prepareForSignOut() {
    return this._withStorageLock(() => {
      const keys = this._getDurableAccountKeys();
      for (const key of keys.filter(key => key.startsWith(this.USER_OUTBOX_PREFIX) || key.startsWith(this.USER_RECOVERY_PREFIX))) {
        let outbox;
        try {
          outbox = JSON.parse(localStorage.getItem(key));
        } catch (_) {
          throw new Error('Local pending changes could not be verified. Sign out was not completed.');
        }
        if (!Array.isArray(outbox)) throw new Error('Local pending changes could not be verified. Sign out was not completed.');
        if (outbox.length) throw new Error('Unsynced changes are still stored on this browser. Sync or resolve them before signing out.');
      }

      const snapshots = [];
      try {
        for (const key of keys) snapshots.push([key, localStorage.getItem(key)]);
        for (const [key] of snapshots) this._removeDurableKey(key);
        if (keys.some(key => localStorage.getItem(key) !== null)) throw new Error('Local persistence verification failed.');
      } catch (_) {
        for (const [key, value] of snapshots) {
          try { if (value !== null) localStorage.setItem(key, value); } catch (_) {}
        }
        throw new Error('Local account data could not be cleared. Sign out was not completed.');
      }

      this._clearInMemoryAccountState();
    });
  },

  _readOutbox(userId) {
    try {
      const raw = localStorage.getItem(this._getUserOutboxKey(userId));
      if (raw === null) return [];
      const outbox = JSON.parse(raw);
      if (!Array.isArray(outbox) || outbox.some(entry => !entry || typeof entry !== 'object' || !entry.id || !entry.payload || typeof entry.payload !== 'object' || Array.isArray(entry.payload))) throw new Error('Invalid outbox');
      return outbox;
    } catch (_) {
      const message = 'Local pending changes could not be read and were retained for recovery.';
      this._setSyncStatus('failed', message);
      throw new Error(message);
    }
  },

  _writeOutbox(userId, outbox) {
    localStorage.setItem(this._getUserOutboxKey(userId), JSON.stringify(outbox));
  },

  _readRecovery(userId) {
    const raw = localStorage.getItem(this.USER_RECOVERY_PREFIX + userId);
    if (raw === null) return [];
    const records = JSON.parse(raw);
    if (!Array.isArray(records)) throw new Error('Local recovery data could not be read. It has been retained.');
    return records;
  },

  _preserveConflict(userId, outbox, remote) {
    const records = this._readRecovery(userId);
    const recovery = {
      userId, outbox, localPayload: outbox[outbox.length - 1].payload,
      remotePayload: remote.payload, remoteUpdatedAt: remote.updated_at || null,
      detectedAt: new Date().toISOString(), archived: true
    };
    // Archive first. A quota/write failure leaves the original outbox intact.
    // A crash before clearing it is harmless: the archive is deduplicated on retry.
    if (!records.some(record => jsonValuesEqual(record.outbox, outbox))) records.push(recovery);
    const raw = JSON.stringify(records);
    const key = this.USER_RECOVERY_PREFIX + userId;
    localStorage.setItem(key, raw);
    if (localStorage.getItem(key) !== raw) throw new Error('Local recovery could not be verified. Pending changes are retained.');
    this._writeOutbox(userId, []);
    this._conflictRecovery = recovery;
    this._isDirty = false;
    this._setSyncStatus('conflict', 'Account data loaded. Unsynced local changes are preserved for review.');
  },

  async previewRecovery(userId, reviewedRecords) {
    const identity = await this.getImportIdentity();
    if (!identity || identity.userId !== userId || !jsonValuesEqual(this._readRecovery(userId), reviewedRecords)) throw new Error('Account or recovery archive changed. Review it again.');
    if (this._readOutbox(userId).length) throw new Error('Sync current pending edits before restoring an older copy.');
    const response = await apiRequest('/app-data', { authSession: { access_token: identity.accessToken } });
    if (!response.ok || !Object.hasOwn(response.data, 'payload') || !Object.hasOwn(response.data, 'updated_at')) throw new Error('Current account data could not be read. No changes were made.');
    return { payload: response.data.payload, updated_at: response.data.updated_at };
  },

  async restoreRecovery(userId, reviewedRecords, preview) {
    const generation = this._accountGeneration;
    const identity = await this.getImportIdentity();
    if (!identity || identity.userId !== userId) throw new Error('Signed-in account changed. No changes were made.');
    return this._withStorageLock(async () => {
      if (generation !== this._accountGeneration || !jsonValuesEqual(this._readRecovery(userId), reviewedRecords) || this._readOutbox(userId).length) throw new Error('Recovery or pending changes changed. Review again; nothing was overwritten.');
      const latest = await this.previewRecovery(userId, reviewedRecords);
      if (!preview || !jsonValuesEqual(latest, preview)) throw new Error('Account data changed since comparison. Review the newest account copy before restoring.');
      const record = reviewedRecords.at(-1);
      const payload = record?.localPayload || record?.outbox?.at(-1)?.payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Preserved local copy is invalid.');
      const response = await apiRequest('/app-data', { method: 'PUT', authSession: { access_token: identity.accessToken }, body: { payload, expectedUpdatedAt: latest.updated_at || null } });
      if (!response.ok) throw new Error((response.data && response.data.error) || 'Account changed during restore. Local and server copies are retained.');
      if (!response.data?.updated_at || !jsonValuesEqual(response.data.payload, payload)) throw new Error('Restore acknowledgement could not be verified. Reload and compare both copies.');
      if (generation !== this._accountGeneration) throw new Error('Account changed after restore. Reload before editing.');
      this._writeUserCache(userId, payload, response.data.updated_at);
      this._cached = structuredClone(payload);
      this._cachedUpdatedAt = response.data.updated_at;
      this._accountVerified = true;
      this._isDirty = false;
      // Keep the archive: even a successful restore must not destroy provenance.
      this._setSyncStatus('archived', 'Local copy restored to account. Recovery archive remains available for review.');
      return response.data;
    });
  },

  async resolveDownloadedRecovery(userId, reviewedRecords) {
    const generation = this._accountGeneration;
    const user = await getAuthUser();
    return this._withStorageLock(() => {
      if (generation !== this._accountGeneration || user?.id !== userId || !jsonValuesEqual(this._readRecovery(userId), reviewedRecords)) throw new Error('Recovery data changed. Download and review the current archive first.');
      localStorage.removeItem(this.USER_RECOVERY_PREFIX + userId);
      if (localStorage.getItem(this.USER_RECOVERY_PREFIX + userId) !== null) throw new Error('The recovery copy could not be removed.');
      this._conflictRecovery = null;
      const pending = this._readOutbox(userId).length > 0;
      this._setSyncStatus(pending ? 'pending' : 'idle', pending ? 'Changes are waiting to sync.' : '');
    });
  },

  async _saveNextOutboxEntry(userId, generation = this._accountGeneration) {
    if (!navigator.locks) throw new Error('This browser cannot safely coordinate local sync.');
    return navigator.locks.request(`elistly-send:${userId}`, async () => {
      if (generation !== this._accountGeneration) return;
      const next = this._readOutbox(userId)[0];
      if (!next) return;
      if (!Object.hasOwn(next, 'expectedUpdatedAt')) throw new Error('Pending changes have no verified base revision. Reload to preserve and review them.');
      const durableRevision = this._readUserUpdatedAt(userId);
      const session = await getAuthSession();
      const sessionUserId = session?.user?.id || getAccessTokenClaims(session?.access_token)?.sub;
      if (generation !== this._accountGeneration || (sessionUserId && sessionUserId !== userId)) throw new Error('Account changed before syncing. Local changes are retained.');
      const res = await apiRequest('/app-data', { method: 'PUT', authSession: session, body: { payload: next.payload, expectedUpdatedAt: next.expectedUpdatedAt } });
      if (!res.ok) throw new Error((res.data && res.data.error) || 'Failed to save app data');
      return this._withStorageLock(() => {
        if (generation !== this._accountGeneration) return;
        const outbox = this._readOutbox(userId);
        if (!jsonValuesEqual(outbox[0], next) || durableRevision !== this._readUserUpdatedAt(userId)) throw new Error('Local state changed while syncing. Reload to confirm the saved data.');
        const row = res.data || {};
        if (!row.updated_at) throw new Error('Save acknowledgement is missing its revision. Local changes are retained.');
        const updatedAt = row.updated_at;
        this._writeUserCache(userId, next.payload, updatedAt);
        if (!jsonValuesEqual(this._readUserCache(userId), next.payload) || this._readUserUpdatedAt(userId) !== updatedAt) throw new Error('Local save acknowledgement could not be persisted. Pending changes are retained.');
        const pending = outbox.filter(entry => entry.id !== next.id).map(entry => entry.parentId === next.id ? { ...entry, expectedUpdatedAt: updatedAt, parentId: null } : entry);
        this._writeOutbox(userId, pending);
        if (jsonValuesEqual(this._cached, next.payload)) this._cachedUpdatedAt = updatedAt;
        this._isDirty = pending.length > 0;
        this._setSyncStatus(pending.length ? 'pending' : 'synced', pending.length ? 'Changes are waiting to sync.' : 'Changes are synced.');
      });
    });
  },

  _setSyncStatus(state, message) {
    this._syncStatus = { state, message };
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('elistly:sync-status', { detail: this.getSyncStatus() }));
      if (window.App && typeof window.App.renderSyncStatus === 'function') window.App.renderSyncStatus();
    }
  },

  getSyncStatus() {
    return { ...this._syncStatus };
  },

  getConflictRecovery() {
    return this._conflictRecovery ? structuredClone(this._conflictRecovery) : null;
  },

  _readUserCache(userId) {
    try {
      const raw = localStorage.getItem(this._getUserCacheKey(userId));
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  },

  _readUserUpdatedAt(userId) {
    try {
      return localStorage.getItem(this._getUserUpdatedKey(userId)) || '';
    } catch (e) {
      return '';
    }
  },

  _writeUserCache(userId, payload, updatedAt) {
    try {
      localStorage.setItem(this._getUserCacheKey(userId), JSON.stringify(payload || {}));
      if (updatedAt) localStorage.setItem(this._getUserUpdatedKey(userId), String(updatedAt));
      else if (localStorage.getItem(this._getUserUpdatedKey(userId)) !== null) localStorage.setItem(this._getUserUpdatedKey(userId), '');
    } catch (e) {
      console.error('Storage._writeUserCache failed', e);
    }
  },

  async getImportIdentity() {
    if (!backendClient) return null;
    if (this._accountVerified === false) throw new Error('Wait for account refresh before importing or restoring data.');
    const session = await getAuthSession();
    const user = await getAuthUser();
    const accessToken = session && session.access_token;
    const userId = user && user.id;
    const claims = getAccessTokenClaims(accessToken);
    const bearerUserId = typeof claims?.sub === 'string' && claims.sub ? claims.sub : null;
    const sessionUserId = session && session.user && session.user.id;
    if (!accessToken || !userId) throw new Error('No signed-in account is available to save this import.');
    if (isImportSessionKnownExpired(session, claims)) throw new Error('Signed-in session has expired. Sign in and review this import again.');
    if (!bearerUserId || bearerUserId !== userId || (sessionUserId && sessionUserId !== bearerUserId)) {
      throw new Error('Signed-in account identity could not be confirmed.');
    }
    return Object.freeze({ userId: bearerUserId, accessToken, expectedUpdatedAt: this._readUserUpdatedAt(bearerUserId) || null });
  },

  getAppData(options = {}) {
    if (backendClient) return this.getAppDataAsync(options);
    try {
      const raw = localStorage.getItem(this.KEY);
      return Promise.resolve(raw ? JSON.parse(raw) : null);
    } catch (e) {
      return Promise.resolve(null);
    }
  },

  async getAppDataAsync(options = {}) {
    const generation = this._accountGeneration;
    const session = await getAuthSession();
    const user = session?.user || await getAuthUser();
    if (!user || generation !== this._accountGeneration) throw new Error('Signed-in account data could not be confirmed.');
    if (this._cachedUserId && this._cachedUserId !== user.id) this._clearInMemoryAccountState();
    const outbox = this._readOutbox(user.id);
    const cached = this._readUserCache(user.id);
    const local = outbox.length ? outbox.at(-1).payload : cached;
    const revision = this._readUserUpdatedAt(user.id);
    this._conflictRecovery = this._readRecovery(user.id).at(-1) || null;
    this._cached = structuredClone(local);
    this._cachedUserId = user.id;
    this._cachedUpdatedAt = outbox.length ? outbox[0].expectedUpdatedAt || '' : revision;
    this._isDirty = outbox.length > 0;
    this._accountVerified = false;
    this._setSyncStatus('refreshing', outbox.length ? 'Checking account data. Local changes are waiting to sync.' : 'Refreshing account data…');
    // Start the account request before returning cached data; profile/admin work is independent.
    this._onRemoteSync = options.onRemoteSync;
    this._refreshPromise = this.syncRemoteInBackground(user.id, revision, options.onRemoteSync, session);
    void this._refreshPromise.catch(() => {});
    return local !== null ? structuredClone(local) : await this._refreshPromise;
  },

  async syncRemoteInBackground(userId, cachedUpdatedAt, onRemoteSync, session) {
    const generation = this._accountGeneration;
    const outbox = this._readOutbox(userId);
    const hadUnqueuedEdit = this._isDirty && !outbox.length;
    try {
      const res = await apiRequest('/app-data', { ...(session ? { authSession: session } : {}), signal: AbortSignal.timeout(15000) });
      if (generation !== this._accountGeneration) throw new Error('Account changed while loading inventory.');
      if (!res.ok) throw new Error((res.data && res.data.error) || 'Account data could not be refreshed.');
      const remote = res.data;
      if (!remote || !Object.hasOwn(remote, 'payload') || !Object.hasOwn(remote, 'updated_at') || (remote.payload !== null && (typeof remote.payload !== 'object' || Array.isArray(remote.payload)))) throw new Error('Invalid account response. Local changes are retained.');
      return await this._withStorageLock(() => {
        if (generation !== this._accountGeneration) throw new Error('Account changed while loading inventory.');
        if (cachedUpdatedAt !== this._readUserUpdatedAt(userId) || !jsonValuesEqual(outbox, this._readOutbox(userId)) || hadUnqueuedEdit) {
          this._setSyncStatus('stale', 'Inventory changed during refresh. Reload to check the latest account data.');
          return this._cached;
        }
        const pending = outbox.at(-1)?.payload;
        const remoteRevision = remote.updated_at || null;
        const confirmedIndex = outbox.findIndex((entry, index) =>
          jsonValuesEqual(entry.payload, remote.payload) &&
          (index === 0 || outbox.slice(1, index + 1).every((child, offset) => child.parentId === outbox[offset].id)));
        let remaining = outbox;
        if (confirmedIndex >= 0) {
          remaining = outbox.slice(confirmedIndex + 1);
          if (remaining.length && remaining[0].parentId === outbox[confirmedIndex].id) {
            remaining = remaining.map((entry, index) => index === 0 ? { ...entry, expectedUpdatedAt: remoteRevision, parentId: null } : entry);
          }
        }
        const currentBase = remaining.length && Object.hasOwn(remaining[0], 'expectedUpdatedAt') && remaining[0].expectedUpdatedAt === remoteRevision;
        const next = currentBase ? remaining.at(-1).payload : remote.payload;
        const changed = !jsonValuesEqual(next, this._cached);
        // The editor/model and its revision must advance together, or neither may advance.
        if (changed && this._cached !== null && onRemoteSync && onRemoteSync(structuredClone(next)) === false) {
          this._setSyncStatus('stale', 'Newer account data is available. Close the editor and reload to refresh.');
          return this._cached;
        }
        if (remaining.length && !currentBase) this._preserveConflict(userId, remaining, remote);
        else if (confirmedIndex >= 0) this._writeOutbox(userId, remaining);
        this._cached = structuredClone(next);
        this._cachedUserId = userId;
        this._cachedUpdatedAt = remote.updated_at || '';
        this._writeUserCache(userId, remote.payload, remote.updated_at || '');
        this._isDirty = !!currentBase;
        this._accountVerified = true;
        this._setSyncStatus(this._isDirty ? 'pending' : this._conflictRecovery ? 'archived' : 'synced', this._isDirty ? 'Changes are waiting to sync.' : this._conflictRecovery ? 'An older local copy is preserved for optional review; account data is current.' : 'Changes are synced.');
        return structuredClone(next);
      });
    } catch (error) {
      if (generation === this._accountGeneration) this._setSyncStatus('failed', 'Refresh failed. Showing unverified local data; local changes are retained. Reload to retry.');
      throw error;
    }
  },

  setAppData(data) {
    if (backendClient) return this.setAppDataAsync(data);
    try {
      localStorage.setItem(this.KEY, JSON.stringify(data));
    } catch (e) {
      console.error('Storage.setAppData failed', e);
    }
    return Promise.resolve();
  },

  async setAppDataAsync(data) {
    // Account data crosses JSON persistence boundaries (outbox, cache, and API).
    // Keep the in-memory payload in that same representable shape so omitted
    // optional fields cannot make an acknowledgement look unrelated.
    data = JSON.parse(JSON.stringify(data));
    if (backendClient) {
      if (this._accountVerified === false) throw new Error('Account data is still unverified. Wait for refresh or reload before editing.');
      const generation = this._accountGeneration;
      const user = await getAuthUser();
      if (!user || generation !== this._accountGeneration) return;
      const baseRevision = this._cachedUpdatedAt === undefined ? this._readUserUpdatedAt(user.id) : this._cachedUpdatedAt;
      await this._withStorageLock(() => {
        if (generation !== this._accountGeneration) throw new Error('Account changed before saving.');
        const previousPayload = this._cached;
        this._cached = structuredClone(data);
        this._cachedUserId = user.id;
        this._isDirty = true;
        const entry = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, payload: structuredClone(data), expectedUpdatedAt: baseRevision || null, createdAt: new Date().toISOString() };
        const outbox = this._readOutbox(user.id);
        if (outbox.length && jsonValuesEqual(previousPayload, outbox[outbox.length - 1].payload)) entry.parentId = outbox[outbox.length - 1].id;
        outbox.push(entry);
        this._writeOutbox(user.id, outbox);
        this._setSyncStatus('pending', 'Changes are syncing.');
      });
      const previous = this._saveChains[user.id] || Promise.resolve();
      const save = previous.catch(() => {}).then(async () => {
        await this._saveNextOutboxEntry(user.id, generation);
      }).catch(async error => {
        if (generation === this._accountGeneration && this._accountVerified === true) {
          try {
            await this.syncRemoteInBackground(user.id, this._readUserUpdatedAt(user.id), this._onRemoteSync);
            // A recovered acknowledgement updates state, but the attempted save still failed.
            // Do not report a competing edit as successful to its caller.
          } catch (_) { /* Keep the original save error and durable queue. */ }
        }
        if (generation === this._accountGeneration) {
          const pending = this._readOutbox(user.id).length > 0;
          this._isDirty = pending;
          if (pending) this._setSyncStatus('failed', 'Changes could not be synced. Local changes are retained.');
          else if (this._conflictRecovery) this._setSyncStatus('archived', 'An older local copy is preserved for review; account data is current.');
        }
        throw error;
      });
      this._saveChains[user.id] = save;
      return save;
    }
    try {
      localStorage.setItem(this.KEY, JSON.stringify(data));
    } catch (e) {
      console.error('Storage.setAppData failed', e);
    }
  },

  async retryPendingSaves() {
    if (!backendClient) return;
    if (this._accountVerified === false) throw new Error('Refresh account data before retrying pending changes.');
    const generation = this._accountGeneration;
    const user = await getAuthUser();
    if (!user || generation !== this._accountGeneration) return;
    const pending = this._readOutbox(user.id);
    if (!pending.length) return;
    this._isDirty = true;
    this._setSyncStatus('pending', 'Changes are syncing.');
    const previous = this._saveChains[user.id] || Promise.resolve();
    const save = previous.catch(() => {}).then(async () => {
      for (let remaining = pending.length; remaining > 0 && generation === this._accountGeneration && this._readOutbox(user.id).length; remaining -= 1) {
        await this._saveNextOutboxEntry(user.id, generation);
      }
    }).catch(error => {
      if (generation === this._accountGeneration) {
        this._isDirty = true;
        this._setSyncStatus(error && error.message === 'App data changed since preview' ? 'conflict' : 'failed', error && error.message === 'App data changed since preview' ? 'Changes conflict with newer app data. Local changes are retained.' : 'Changes could not be synced. Local changes are retained.');
      }
      throw error;
    });
    this._saveChains[user.id] = save;
    return save;
  },

  async setAppDataForImport(data, identity) {
    if (backendClient) {
      const generation = this._accountGeneration;
      if (!identity || !identity.userId || !identity.accessToken || this._cachedUserId !== identity.userId) throw new Error('Signed-in account identity could not be confirmed.');
      if (this._readOutbox(identity.userId).length) throw new Error('Unsynced local changes must be synced or resolved before restoring a full backup.');
      const res = await apiRequest('/app-data', { method: 'PUT', body: { payload: data, expectedUpdatedAt: identity.expectedUpdatedAt ?? null }, authSession: { access_token: identity.accessToken } });
      if (!res || !res.ok) throw new Error((res && res.data && res.data.error) || 'Failed to save imported data');
      const row = res.data || {};
      if (!row.payload || !jsonValuesEqual(row.payload, data)) throw new Error('Imported data acknowledgement did not match the reviewed data.');
      if (generation !== this._accountGeneration) {
        const error = new Error('The signed-in account changed while the import was saved. Reload before continuing.');
        error.accountInvalidated = true;
        throw error;
      }
      const updatedAt = row.updated_at ? row.updated_at : new Date().toISOString();
      try {
        this._cached = structuredClone(data);
        this._cachedUserId = identity.userId;
        this._cachedUpdatedAt = updatedAt;
        this._accountVerified = true;
        this._writeUserCache(identity.userId, data, updatedAt);
        const serialized = JSON.stringify(data);
        if (localStorage.getItem(this._getUserCacheKey(identity.userId)) !== serialized || localStorage.getItem(this._getUserUpdatedKey(identity.userId)) !== String(updatedAt)) {
          throw new Error('Account cache persistence verification failed.');
        }
      } catch (cacheError) {
        const error = new Error('The import was saved remotely, but the local cache could not be updated. Reload before continuing.');
        error.remoteCommitted = true;
        error.cause = cacheError;
        throw error;
      }
      return true;
    }
    localStorage.setItem(this.KEY, JSON.stringify(data));
    if (localStorage.getItem(this.KEY) !== JSON.stringify(data)) throw new Error('Local persistence verification failed.');
    return true;
  },

  getOnboardingDone() {
    if (this._cached && 'onboardingDone' in this._cached) return !!this._cached.onboardingDone;
    if (backendClient) return false;
    try {
      const raw = localStorage.getItem(this.KEY);
      const data = raw ? JSON.parse(raw) : null;
      return !!(data && data.onboardingDone);
    } catch (e) {
      return false;
    }
  },

  setOnboardingDone() {
    const data = this._cached || { version: CURRENT_VERSION, settings: {}, categories: {}, entityTypes: {}, entities: {} };
    data.onboardingDone = true;
    this._cached = data;
    return this.setAppData(data);
  }
};

window.addEventListener('online', () => {
  Storage.retryPendingSaves().catch(() => {});
});

window.addEventListener('storage', event => {
  if (event.storageArea === localStorage && event.key === 'elistly_token') {
    Storage._clearInMemoryAccountState();
    App.clearAccountRuntime();
    return;
  }
  if (event.storageArea === localStorage && event.newValue === null && Storage.handleExternalDurableRemoval(event.key)) App.clearAccountRuntime();
});

// Setups: add preset IDs here; each setup-<id>.js registers into window.ELISTLY_PRESETS (loaded before app.js)
const SETUP_IDS = ['blank', 'library', 'it', 'staff', 'property'];
const PRESETS = (function () {
  const out = {};
  const source = typeof window !== 'undefined' && window.ELISTLY_PRESETS ? window.ELISTLY_PRESETS : {};
  SETUP_IDS.forEach(function (id) { if (source[id]) out[id] = source[id]; });
  return out;
})();

// Default data = IT preset (version merge, entity-type templates, restore defaults). Fallback empty if setup not loaded.
const defaultData = {
  categories: (PRESETS.it && PRESETS.it.categories) ? PRESETS.it.categories : {},
  entityTypes: (PRESETS.it && PRESETS.it.entityTypes) ? PRESETS.it.entityTypes : {},
  entities: (PRESETS.it && PRESETS.it.entities) ? PRESETS.it.entities : {}
};

const FULL_BACKUP_EXCLUDED_TOP_LEVEL_KEYS = new Set([
  'isAdmin', 'auth', 'accessToken', 'refreshToken', 'runtimeConfig', 'outbox', 'cache'
]);

// Sample data is loaded from sample-data.js (optional). Fallback if not loaded.
if (typeof window.SAMPLE_ENTITIES === 'undefined') {
  window.SAMPLE_ENTITIES = { library: {}, it: {}, staff: {}, property: {}, blank: {} };
}

const App = {
  data: {
    version: CURRENT_VERSION,
    settings: {
      defaultView: 'dashboard',
      materialIcons: MATERIAL_ICONS
    },
    categories: {},
    entityTypes: {},
    entities: {}
  },
  defaultData,
  _presets: PRESETS,
  _isReady: false,
  _pendingRemoteData: null,

  clearAccountRuntime() {
    document.getElementById('syncRecoveryModal')?.remove();
    document.getElementById('svkImportModal')?.remove();
    document.getElementById('svkHistoryModal')?.remove();
    this._pendingRemoteData = null;
    this.data = {
      version: CURRENT_VERSION,
      settings: { defaultView: 'dashboard', materialIcons: MATERIAL_ICONS },
      categories: {},
      entityTypes: {},
      entities: {}
    };
  },
      
      async init() {
        this._isReady = false;
        this._pendingRemoteData = null;
        await ensureBackendClient();

        this.data = {
          version: CURRENT_VERSION,
          settings: { defaultView: 'dashboard', materialIcons: MATERIAL_ICONS },
          categories: {},
          entityTypes: {},
          entities: {},
          workspaces: { default: { name: 'Default', categories: {}, entityTypes: {}, entities: {} } },
          currentWorkspaceId: 'default'
        };

        if (!backendClient) {
          const main = document.getElementById('mainContent');
          const hasConfigKeys = !!(getApiUrl() && window.NEON_AUTH_URL);
          const hasClientShim = typeof window.elistlyClient !== 'undefined';
          let setupHtml = `
                <p class="setup-required-copy">Elistly requires an account, a database, and a configured backend provider.</p>
                <ol class="setup-required-list">
                  <li>Copy <code>config.example.js</code> to <code>config.js</code></li>
                  <li>Set <code>ELISTLY_API_URL</code> and <code>NEON_AUTH_URL</code> in <code>config.js</code></li>
                  <li>Run the SQL in <code>neon/schema.sql</code> against your Neon database</li>
                  <li>Set the Worker secrets from <code>CLOUDFLARE_DEPLOY.md</code></li>
                  <li>Reload this page</li>
                </ol>
                <p class="setup-required-note">See the README for full instructions.</p>`;
          if (hasConfigKeys && !hasClientShim) {
            setupHtml = `
                <p class="setup-required-copy">Backend configuration was found, but the browser client did not load.</p>
                <ol class="setup-required-list">
                  <li>Check your internet connection</li>
                  <li>Confirm <code>lib/db.js</code> is included before <code>app.js</code></li>
                  <li>Hard reload the page</li>
                </ol>
                <p class="setup-required-note">Tip: open DevTools → Network and verify <code>lib/db.js</code> is loading.</p>`;
          }
          if (main) {
            main.innerHTML = `
              <div class="card setup-required-card">
                <div class="card-header"><h2><span class="material-icons">settings</span> Setup required</h2></div>
                ${setupHtml}
              </div>`;
          }
          return;
        }

        if (backendClient) {
          const session = await getAuthSession();
          if (!session) {
            const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
            document.documentElement.setAttribute('data-theme', systemTheme);
            this.updateAccentColor('#2a7ebf', false);
            this.updateHeaderColor('#1a1b1e', false);
            this.applyLogoStyle('color');
            this.showSignInModal();
            return;
          }
          this.data.isAdmin = false;
          const profileGeneration = Storage._accountGeneration;
          void (async () => {
            const apiUrl = typeof window !== 'undefined' && window.ELISTLY_API_URL;
            if (!apiUrl || !apiUrl.trim()) {
              if (typeof console !== 'undefined' && console.warn) {
                console.warn('Elistly: ELISTLY_API_URL is not set. Admin and Delete account will not appear. Set it in config or (on Cloudflare Pages) as env var ELISTLY_API_URL.');
              }
            } else {
              try {
                const r = await apiRequest('/admin/me', { authSession: session });
                if (profileGeneration !== Storage._accountGeneration) return;
                this.data.isAdmin = !!(r.data && r.data.admin);
                if (r.status !== 200 && typeof console !== 'undefined' && console.warn) {
                  console.warn('Elistly: /admin/me returned non-200.', r.status, r.data);
                }
              } catch (e) {
                if (typeof console !== 'undefined' && console.warn) {
                  console.warn('Elistly: /admin/me request failed (check Worker URL, CORS, or Network tab).', e);
                }
              }
            }
            if (profileGeneration === Storage._accountGeneration) await this.initProfileDropdown(session.user);
          })().catch(error => console.warn('Profile could not be initialized.', error));

        }

        var savedTheme = localStorage.getItem('theme');
        if (!savedTheme || savedTheme === 'system') {
          savedTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        }
        document.documentElement.setAttribute('data-theme', savedTheme);
        this.updateAccentColor(localStorage.getItem('accentColor') || '#2a7ebf', false);
        this.updateHeaderColor(localStorage.getItem('headerColor') || '#1a1b1e', false);
        this.applyLogoStyle(localStorage.getItem('logoStyle') || 'color');

        let dataMutatedDuringInit = false;
        let stored;
        try {
          stored = await Storage.getAppData({
            onRemoteSync: (remoteData) => {
              if (!this._isReady) {
                this._pendingRemoteData = { data: remoteData };
                return true;
              }
              return this.applyRemoteSyncData(remoteData);
            }
          });
        } catch (error) {
          this.showAccountLoadError(error);
          return;
        }

        // Hydration and onboarding are independent: an existing blank active
        // workspace can still carry account settings or populated inactive workspaces.
        if (stored) {
          try {
            const userData = stored;
            const storedVersion = userData.version || '1.0.0';
            this.data = { ...this.data, ...userData };
            this.data.settings = this.normalizeSettings(userData.settings, this.data.settings);
            if (userData.workspaces && typeof userData.currentWorkspaceId === 'string') {
              this.data.workspaces = userData.workspaces;
              this.data.currentWorkspaceId = userData.currentWorkspaceId;
              const w = this.data.workspaces[this.data.currentWorkspaceId];
              if (w) {
                this.data.categories = { ...(w.categories || {}) };
                this.data.entityTypes = { ...(w.entityTypes || {}) };
                this.data.entities = { ...(w.entities || {}) };
              } else {
                this.data.categories = {};
                this.data.entityTypes = {};
                this.data.entities = {};
              }
            } else {
              this.data.categories = { ...(userData.categories || {}) };
              this.data.entityTypes = { ...(userData.entityTypes || {}) };
              this.data.entities = { ...(userData.entities || {}) };
              this.data.workspaces = {
                default: {
                  name: 'Default',
                  categories: { ...this.data.categories },
                  entityTypes: { ...this.data.entityTypes },
                  entities: { ...this.data.entities }
                }
              };
              this.data.currentWorkspaceId = 'default';
              dataMutatedDuringInit = true;
            }
              const fontSize = this.getSafeFontSize();
              document.documentElement.setAttribute('data-font-size', ['small','normal','large','larger'].includes(fontSize) ? fontSize : 'normal');

            if (this.compareVersions(CURRENT_VERSION, storedVersion) > 0) {
              const updateChanges = { newEntityTypes: [], updatedEntityTypes: [], newFields: {}, askToRestoreTypes: [] };
              const defaultTypeIds = Object.keys(this.defaultData.entityTypes);
              const userTypeIds = Object.keys(this.data.entityTypes);
              const removedDefaultTypes = defaultTypeIds.filter(id => !userTypeIds.includes(id));

              for (const [typeId, defaultType] of Object.entries(this.defaultData.entityTypes)) {
                if (this.data.entityTypes[typeId]) {
                  const userType = this.data.entityTypes[typeId];
                  const userFieldNames = (userType.fields || []).map(f => f.name);
                  const newDefaultFields = (defaultType.fields || []).filter(f => !userFieldNames.includes(f.name));
                  if (newDefaultFields.length > 0) {
                    if (!this.data.entityTypes[typeId].fields) this.data.entityTypes[typeId].fields = [];
                    this.data.entityTypes[typeId].fields = [...this.data.entityTypes[typeId].fields, ...newDefaultFields];
                    updateChanges.updatedEntityTypes.push(typeId);
                    dataMutatedDuringInit = true;
                  }
                  (userType.fields || []).forEach((uf, i) => {
                    if (uf.type === 'dropdown') {
                      const df = defaultType.fields.find(f => f.name === uf.name);
                      if (df && df.options && (!uf.options || uf.options.length === 0))
                        this.data.entityTypes[typeId].fields[i].options = JSON.parse(JSON.stringify(df.options));
                      if (df && df.options && (!uf.options || uf.options.length === 0)) dataMutatedDuringInit = true;
                    }
                  });
                  const userAssocNames = (userType.associations || []).map(a => a.name);
                  const newAssocs = (defaultType.associations || []).filter(a => !userAssocNames.includes(a.name));
                  if (newAssocs.length > 0) {
                    if (!this.data.entityTypes[typeId].associations) this.data.entityTypes[typeId].associations = [];
                    this.data.entityTypes[typeId].associations = [...this.data.entityTypes[typeId].associations, ...newAssocs];
                    if (!updateChanges.updatedEntityTypes.includes(typeId)) updateChanges.updatedEntityTypes.push(typeId);
                    dataMutatedDuringInit = true;
                  }
                } else if (!removedDefaultTypes.includes(typeId)) {
                  this.data.entityTypes[typeId] = JSON.parse(JSON.stringify(defaultType));
                  updateChanges.newEntityTypes.push(typeId);
                  dataMutatedDuringInit = true;
                } else {
                  updateChanges.askToRestoreTypes.push({ id: typeId, label: defaultType.label });
                }
              }
              if (updateChanges.askToRestoreTypes.length > 0) localStorage.setItem('removedDefaultTypes', JSON.stringify(updateChanges.askToRestoreTypes));
              if (updateChanges.newEntityTypes.length > 0 || updateChanges.updatedEntityTypes.length > 0) localStorage.setItem('lastUpdateChanges', JSON.stringify(updateChanges));
              loadVersionHistory().then(() => this.showWhatsNew());
              if (updateChanges.askToRestoreTypes.length > 0) setTimeout(() => this.showRestoreTypesPrompt(), 1000);
            }
          } catch (e) {
            console.error('Error loading user data:', e);
          }
        }

        // The built-in catalog is part of every workspace, including a blank first run.
        // Presets select from it; they are not the source of discoverability.
        if (this.normalizeActivationState()) dataMutatedDuringInit = true;

          const personType = this.data.entityTypes && this.data.entityTypes.person;
          if (personType && Array.isArray(personType.fields)) {
            const hasFirst = personType.fields.some(f => f.name === 'firstName');
            const hasLast = personType.fields.some(f => f.name === 'lastName');
            const hasOrder = Array.isArray(personType.nameGen?.componentsOrder) && personType.nameGen.componentsOrder.length > 0;
            if (hasFirst && hasLast && (!personType.enableNameGen || !hasOrder)) {
              personType.enableNameGen = true;
              personType.nameGen = {
                prefix: personType.nameGen?.prefix || '',
                partOfNamePrefix: personType.nameGen?.partOfNamePrefix ?? false,
                suffixType: personType.nameGen?.suffixType || 'number',
                componentsOrder: [
                  { type: 'field', name: 'firstName' },
                  { type: 'separator', value: ' ' },
                  { type: 'field', name: 'lastName' }
                ]
              };
              personType.fields = personType.fields.map(field => {
                if (field.name === 'firstName' || field.name === 'lastName') {
                  return { ...field, partOfName: true, visibleInCard: false };
                }
                return field;
              });
              dataMutatedDuringInit = true;
            }
          }

        const componentsChanged = this.normalizeNameComponents();
        const schemaChanged = this.normalizeEntityTypeSchema();
        document.documentElement.setAttribute('data-font-size', this.getSafeFontSize());
        if (componentsChanged || schemaChanged) dataMutatedDuringInit = true;
        if (dataMutatedDuringInit && !Storage.getConflictRecovery() && Storage._accountVerified !== false) this.saveData();
        this.buildIconGrid();
        this.renderSidebar();
        this.loadView('dashboard');
        this.ensureMainContentScrollable();

        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
          searchInput.addEventListener('input', (e) => {
            if (this._advancedFilterCategoryId) {
              this.updateAdvancedFilterResults();
            } else if (e.target.value) {
              this.handleSearch(e.target.value);
            } else {
              this.loadView('dashboard');
            }
          });
        }
        this.setupEventListeners();
        this.setupMobileNav();
        this._isReady = true;
        const startupGeneration = Storage._accountGeneration;
        void (Storage._refreshPromise || Promise.resolve(stored)).then(fresh => {
          if (startupGeneration !== Storage._accountGeneration || Storage._accountVerified === false) return;
          const hasInventory = data => !!data && ['categories', 'entityTypes', 'entities'].some(domain =>
            data[domain] && typeof data[domain] === 'object' && Object.keys(data[domain]).length > 0
          );
          const populated = hasInventory(fresh) || Object.values(fresh?.workspaces || {}).some(hasInventory);
          if (!populated && !fresh?.onboardingDone && !Storage.getConflictRecovery()) this.showOnboarding();
          return Storage.retryPendingSaves();
        }).catch(() => {});
        // Archived recovery stays discoverable in sync status, without interrupting every reload.
        if (this._pendingRemoteData) {
          this.applyRemoteSyncData(this._pendingRemoteData.data);
          this._pendingRemoteData = null;
        }

      },
      
      showModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
          modal.classList.remove('hidden');
          modal.style.display = 'flex';
          modal.classList.add('show');
        }
      },

      showSyncConflictRecovery() {
        const recovery = Storage.getConflictRecovery();
        if (!recovery || document.getElementById('syncRecoveryModal')) return;
        const modal = document.createElement('div');
        modal.id = 'syncRecoveryModal';
        modal.className = 'modal hidden';
        const card = document.createElement('div');
        card.className = 'modal-content';
        const title = document.createElement('h3');
        title.textContent = 'Local changes need review';
        const message = document.createElement('p');
        message.textContent = 'Both copies are preserved. The account data is shown; archived local changes are not replayed automatically. Compare both copies before choosing whether to restore the local snapshot. Restoring replaces the whole account snapshot, not just individual records.';
        const comparison = document.createElement('div');
        comparison.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;max-height:45vh;overflow:auto';
        const localPane = document.createElement('section');
        const remotePane = document.createElement('section');
        const renderPane = (pane, label, payload) => {
          pane.replaceChildren();
          const heading = document.createElement('h4'); heading.textContent = label;
          const summary = document.createElement('p');
          summary.textContent = `Entities: ${Object.keys(payload?.entities || {}).length}; workspaces: ${Object.keys(payload?.workspaces || {}).length}`;
          const detail = document.createElement('pre');
          detail.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:30vh;overflow:auto';
          detail.textContent = JSON.stringify(payload, null, 2);
          pane.append(heading, summary, detail);
        };
        renderPane(localPane, 'Preserved local copy', recovery.localPayload || recovery.outbox?.at(-1)?.payload);
        renderPane(remotePane, 'Account copy at conflict detection (refreshing…)', recovery.remotePayload);
        comparison.append(localPane, remotePane);
        let reviewedRecords = null;
        let preview = null;
        const notice = document.createElement('p');
        notice.setAttribute('role', 'status');
        const refreshComparison = async () => {
          try {
            const records = Storage._readRecovery(recovery.userId);
            const latest = await Storage.previewRecovery(recovery.userId, records);
            reviewedRecords = records;
            preview = latest;
            renderPane(remotePane, 'Current account copy', latest.payload);
            notice.textContent = 'Current account data loaded. Download its backup before restoring the local snapshot.';
            backupRemote.disabled = false;
            restore.disabled = true;
          } catch (error) {
            notice.textContent = error.message;
            backupRemote.disabled = true;
            restore.disabled = true;
          }
        };
        const actions = document.createElement('div');
        actions.className = 'modal-actions';
        actions.style.flexWrap = 'wrap';
        actions.style.justifyContent = 'center';
        const download = document.createElement('button');
        download.type = 'button';
        download.className = 'btn btn-primary';
        download.textContent = 'Download local backup';
        let downloadedRecords = null;
        download.onclick = () => {
          downloadedRecords = Storage._readRecovery(recovery.userId);
          const blob = new Blob([JSON.stringify({ format: 'elistly-sync-recovery', version: 1, records: downloadedRecords }, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = 'elistly-local-changes-backup.json';
          link.click();
          resolve.disabled = false;
          setTimeout(() => URL.revokeObjectURL(url), 0);
        };
        const backupRemote = document.createElement('button');
        backupRemote.type = 'button';
        backupRemote.className = 'btn btn-secondary';
        backupRemote.textContent = 'Download current account backup';
        backupRemote.disabled = true;
        backupRemote.onclick = () => {
          if (!preview) return;
          const blob = new Blob([JSON.stringify({ format: 'elistly-account-before-recovery', payload: preview.payload, updated_at: preview.updated_at }, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url; link.download = 'elistly-account-before-restore.json'; link.click();
          restore.disabled = false;
          setTimeout(() => URL.revokeObjectURL(url), 0);
        };
        const restore = document.createElement('button');
        restore.type = 'button';
        restore.className = 'btn btn-primary';
        restore.textContent = 'Restore local copy to account';
        restore.disabled = true;
        restore.onclick = () => this.showConfirmModal({
          title: 'Replace current account with preserved local copy?',
          message: 'This replaces the complete current account snapshot. Check the comparison and keep both downloaded backups. If the account changed since comparison, restore will be refused. The local archive is retained.',
          confirmLabel: 'Restore reviewed local snapshot',
          onConfirm: async () => {
            try {
              const saved = await Storage.restoreRecovery(recovery.userId, reviewedRecords, preview);
              if (this.applyRemoteSyncData(saved.payload) === false) {
                this.showNotification('Restore saved to account. Close the editor and reload to see it.', 'error');
              } else this.showNotification('Preserved local copy restored to account.', 'success');
              this.closeModal(modal.id);
            } catch (error) {
              notice.textContent = error.message;
              restore.disabled = true;
              this.showNotification(error.message, 'error');
            }
          }
        });
        const resolve = document.createElement('button');
        resolve.type = 'button';
        resolve.className = 'btn btn-secondary';
        resolve.textContent = 'Remove downloaded browser copy';
        resolve.disabled = true;
        resolve.onclick = () => this.showConfirmModal({
          title: 'Remove the local recovery copy?',
          message: 'First confirm that the downloaded archive opens and contains your saved changes. This removes only this browser’s recovery archive, leaves account data unchanged, and allows sign-out. Keep the downloaded file.',
          confirmLabel: 'I saved the archive — remove browser copy',
          onConfirm: async () => {
            try { await Storage.resolveDownloadedRecovery(recovery.userId, downloadedRecords); this.closeModal(modal.id); }
            catch (error) { this.showNotification(error.message, 'error'); }
          }
        });
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'btn btn-secondary';
        close.textContent = 'Keep both copies';
        close.onclick = () => this.closeModal(modal.id);
        actions.append(download, backupRemote, restore, resolve, close);
        card.append(title, message, comparison, notice, actions);
        modal.append(card);
        document.body.append(modal);
        this.showModal(modal.id);
        void refreshComparison();
      },

      ensureMainContentScrollable() {
        const main = document.getElementById('mainContent');
        if (!main) return;
        if (main.style.overflowY !== 'auto') main.style.overflowY = 'auto';
        if (main.style.minHeight !== '0px') main.style.minHeight = '0';
      },

      showConfirmModal({ title, message, confirmLabel, cancelLabel, confirmVariant, onConfirm, onCancel }) {
        const modal = document.getElementById('confirmModal');
        if (!modal) return;
        const titleEl = document.getElementById('confirmTitle');
        const messageEl = document.getElementById('confirmMessage');
        const confirmBtn = document.getElementById('confirmButton');
        const cancelBtn = modal.querySelector('.btn.btn-secondary');
        if (titleEl) titleEl.textContent = title || 'Confirm Action';
        if (messageEl) messageEl.textContent = message || '';
        if (confirmBtn) {
          confirmBtn.textContent = confirmLabel || 'Confirm';
          confirmBtn.className = `btn btn-${confirmVariant === 'primary' ? 'primary' : 'danger'}`;
          confirmBtn.onclick = () => {
            this.closeConfirmModal();
            if (onConfirm) onConfirm();
          };
        }
        if (cancelBtn) {
          cancelBtn.textContent = cancelLabel || 'Cancel';
          cancelBtn.onclick = () => {
            this.closeConfirmModal();
            if (onCancel) onCancel();
          };
        }
        this.showModal('confirmModal');
      },

      closeConfirmModal() {
        this.closeModal('confirmModal');
      },

      closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
          modal.classList.remove('show');
          setTimeout(() => {
            if (document.body.contains(modal)) {
              modal.style.display = 'none';
              if (!modal.hasAttribute('data-persistent')) {
                modal.remove();
              }
            }
          }, 200);
        }
      },

      showSignInModal() {
        const existing = document.getElementById('authSignInModal');
        if (existing) existing.remove();
        const html = `
<div class="modal auth-modal inline-flex-display" id="authSignInModal" data-persistent>
  <div class="auth-modal-card">
    <div class="auth-modal-brand">
      <img src="img/elistly-logo-white.svg" alt="" class="auth-modal-logo">
      <h2 class="auth-modal-title">Sign in</h2>
      <p class="auth-modal-tagline">Modular inventory. Endlessly flexible.</p>
    </div>
    <form id="authSignInForm" class="auth-form" onsubmit="event.preventDefault(); App.handleSignIn(document.getElementById('authSignInEmail').value, document.getElementById('authSignInPassword').value);">
      <div class="form-group">
        <label for="authSignInEmail">Email</label>
        <input type="email" id="authSignInEmail" class="auth-input" required placeholder="you@example.com" autocomplete="email">
      </div>
      <div class="form-group auth-password-row">
        <label for="authSignInPassword">Password</label>
        <input type="password" id="authSignInPassword" class="auth-input" required placeholder="••••••••" autocomplete="current-password">

      </div>
      <div id="authSignInError" class="auth-error hidden"></div>
      <div id="authSignInResendBlock" class="auth-resend-block hidden">
        <p class="auth-resend-text">Didn't get the email? <button type="button" class="btn-link" id="authSignInResendBtn">Resend confirmation email</button></p>
      </div>
      <button type="submit" class="btn btn-primary auth-submit" id="authSignInBtn">Sign in</button>
    </form>
    <p class="auth-modal-footer">Don't have an account? <button type="button" class="btn-link" onclick="App.closeModal('authSignInModal'); App.showSignUpModal();">Create account</button></p>
  </div>
</div>`;
        const div = document.createElement('div');
        div.innerHTML = html.trim();
        document.body.appendChild(div.firstElementChild);
        this.showModal('authSignInModal');
      },

      showSignUpModal() {
        const existing = document.getElementById('authSignUpModal');
        if (existing) existing.remove();
        const html = `
<div class="modal auth-modal inline-flex-display" id="authSignUpModal" data-persistent>
  <div class="auth-modal-card">
    <div class="auth-modal-brand">
      <img src="img/elistly-logo-white.svg" alt="" class="auth-modal-logo">
      <h2 class="auth-modal-title">Create account</h2>
      <p class="auth-modal-tagline">Modular inventory. Endlessly flexible.</p>
    </div>
    <form id="authSignUpForm" class="auth-form" onsubmit="event.preventDefault(); App.handleSignUp(document.getElementById('authSignUpDisplayName').value, document.getElementById('authSignUpEmail').value, document.getElementById('authSignUpPassword').value, document.getElementById('authSignUpConfirm').value);">
      <div class="form-group">
        <label for="authSignUpDisplayName">Display name</label>
        <input type="text" id="authSignUpDisplayName" class="auth-input" required placeholder="Your name (shown in the app)" autocomplete="name">
      </div>
      <div class="form-group">
        <label for="authSignUpEmail">Email</label>
        <input type="email" id="authSignUpEmail" class="auth-input" required placeholder="you@example.com" autocomplete="email">
      </div>
      <div class="form-group">
        <label for="authSignUpPassword">Password</label>
        <input type="password" id="authSignUpPassword" class="auth-input" required placeholder="At least 8 characters" autocomplete="new-password" minlength="8">
      </div>
      <div class="form-group">
        <label for="authSignUpConfirm">Confirm password</label>
        <input type="password" id="authSignUpConfirm" class="auth-input" required placeholder="••••••••" autocomplete="new-password">
      </div>
      <div id="authSignUpError" class="auth-error hidden"></div>
      <button type="submit" class="btn btn-primary auth-submit" id="authSignUpBtn">Create account</button>
    </form>
    <p class="auth-modal-footer">Already have an account? <button type="button" class="btn-link" onclick="App.closeModal('authSignUpModal'); App.showSignInModal();">Sign in</button></p>
  </div>
</div>`;
        const div = document.createElement('div');
        div.innerHTML = html.trim();
        document.body.appendChild(div.firstElementChild);
        this.showModal('authSignUpModal');
      },

      async handleSignIn(email, password) {
        if (!backendClient) return;
        const errEl = document.getElementById('authSignInError');
        const resendBlock = document.getElementById('authSignInResendBlock');
        const btn = document.getElementById('authSignInBtn');
        if (errEl) errEl.style.display = 'none';
        if (resendBlock) resendBlock.style.display = 'none';
        if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
        const { error } = await backendClient.auth.signInWithPassword({ email, password });
        if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
        if (error) {
          var lowerMessage = (error.message || '').toLowerCase();
          var isEmailNotConfirmed = lowerMessage.indexOf('email not confirmed') !== -1 || lowerMessage.indexOf('email not verified') !== -1 || lowerMessage.indexOf('verify') !== -1;
          if (errEl) { errEl.textContent = error.message || 'Sign in failed'; errEl.style.display = 'block'; }
          if (isEmailNotConfirmed && resendBlock) {
            resendBlock.style.display = 'block';
            resendBlock.dataset.email = email;
            var resendBtn = document.getElementById('authSignInResendBtn');
            if (resendBtn) resendBtn.onclick = function () { App.handleResendConfirmation(email); };
            this.closeModal('authSignInModal');
            this.showEmailConfirmationModal(email, false);
          }
          return;
        }
        this.closeModal('authSignInModal');
        window.location.reload();
      },

      async handleResendConfirmation(email) {
        if (!backendClient || !email) return;
        var btn = document.getElementById('authSignInResendBtn') || document.getElementById('authVerifyEmailResendBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
        var errEl = document.getElementById('authSignInError') || document.getElementById('authVerifyEmailError');
        if (errEl) errEl.style.display = 'none';
        var res = await backendClient.auth.resend({ type: 'signup', email: email });
        if (btn) { btn.disabled = false; btn.textContent = btn.id === 'authVerifyEmailResendBtn' ? 'Resend code' : 'Resend confirmation email'; }
        if (res.error) {
          if (errEl) { errEl.textContent = res.error.message || 'Could not resend email'; errEl.style.display = 'block'; }
          return;
        }
        this.showNotification('Verification code sent. Check your inbox.', 'success');
      },

      async handleSignUp(username, email, password, confirmPassword) {
        if (!backendClient) return;
        if (password !== confirmPassword) {
          const errEl = document.getElementById('authSignUpError');
          if (errEl) { errEl.textContent = 'Passwords do not match'; errEl.style.display = 'block'; }
          return;
        }
        const errEl = document.getElementById('authSignUpError');
        const btn = document.getElementById('authSignUpBtn');
        if (errEl) errEl.style.display = 'none';
        if (btn) { btn.disabled = true; btn.textContent = 'Creating account…'; }
        const { data, error } = await backendClient.auth.signUp({
          email,
          password,
          options: { data: { user_name: (username && username.trim()) || email.split('@')[0] } }
        });
        if (btn) { btn.disabled = false; btn.textContent = 'Create account'; }
        if (error) {
          if (errEl) { errEl.textContent = error.message || 'Sign up failed'; errEl.style.display = 'block'; }
          return;
        }
        this.closeModal('authSignUpModal');
        this.showEmailConfirmationModal(email, !!(data.session));
      },

      showEmailConfirmationModal(email, alreadyConfirmed) {
        const existing = document.getElementById('authConfirmEmailModal');
        if (existing) existing.remove();
        if (alreadyConfirmed) {
          window.location.reload();
          return;
        }
        const safeEmail = (email || '').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        const html = `
<div class="modal auth-modal inline-flex-display" id="authConfirmEmailModal" data-persistent>
  <div class="auth-modal-card">
    <div class="auth-modal-brand">
      <span class="material-icons auth-modal-icon">mark_email_read</span>
      <h2 class="auth-modal-title">Verify your email</h2>
      <p class="auth-modal-tagline">Enter the verification code sent to <strong>${safeEmail}</strong></p>
    </div>
    <form id="authVerifyEmailForm" class="auth-form">
      <div class="form-group">
        <label for="authVerifyEmailCode">Verification code</label>
        <input type="text" id="authVerifyEmailCode" class="auth-input" required placeholder="123456" inputmode="numeric" autocomplete="one-time-code">
      </div>
      <div id="authVerifyEmailError" class="auth-error hidden"></div>
      <button type="submit" class="btn btn-primary auth-submit" id="authVerifyEmailBtn">Verify email</button>
      <p class="auth-modal-footer">Didn't get it? <button type="button" class="btn-link" id="authVerifyEmailResendBtn">Resend code</button></p>
      <p class="auth-modal-footer"><button type="button" class="btn-link" onclick="App.closeModal('authConfirmEmailModal'); App.showSignInModal();">Back to sign in</button></p>
    </form>
  </div>
</div>`;
        const div = document.createElement('div');
        div.innerHTML = html.trim();
        document.body.appendChild(div.firstElementChild);
        var form = document.getElementById('authVerifyEmailForm');
        if (form) {
          form.addEventListener('submit', function (event) {
            event.preventDefault();
            App.handleVerifyEmailCode(email, document.getElementById('authVerifyEmailCode').value);
          });
        }
        var resendBtn = document.getElementById('authVerifyEmailResendBtn');
        if (resendBtn) resendBtn.onclick = function () { App.handleResendConfirmation(email); };
        this.showModal('authConfirmEmailModal');
      },

      async handleVerifyEmailCode(email, code) {
        if (!backendClient) return;
        const errEl = document.getElementById('authVerifyEmailError');
        const btn = document.getElementById('authVerifyEmailBtn');
        const cleanCode = (code || '').trim();
        if (errEl) errEl.style.display = 'none';
        if (!cleanCode) {
          if (errEl) { errEl.textContent = 'Enter the verification code from your email.'; errEl.style.display = 'block'; }
          return;
        }
        if (btn) { btn.disabled = true; btn.textContent = 'Verifying…'; }
        const { data, error } = await backendClient.auth.verifyOtp({ email, token: cleanCode, type: 'signup' });
        if (btn) { btn.disabled = false; btn.textContent = 'Verify email'; }
        if (error) {
          if (errEl) { errEl.textContent = error.message || 'Invalid verification code'; errEl.style.display = 'block'; }
          return;
        }
        this.closeModal('authConfirmEmailModal');
        if (data && data.session) {
          window.location.reload();
          return;
        }
        this.showNotification('Email verified. Please sign in.', 'success');
        this.showSignInModal();
      },

      async getDisplayName(userId) {
        if (!backendClient || !userId) return null;
        try {
          const res = await apiRequest('/profile');
          const profile = res && res.data ? res.data.profile : null;
          return (profile && profile.display_name && profile.display_name.trim()) ? profile.display_name.trim() : null;
        } catch (_) {
          return null;
        }
      },

      async initProfileDropdown(user) {
        const generation = Storage._accountGeneration;
        const wrap = document.getElementById('profileDropdownWrap');
        const menu = document.getElementById('profileMenu');
        const btn = document.getElementById('profileBtn');
        if (!wrap || !menu || !btn) return;
        wrap.classList.remove('hidden');
        wrap.style.display = '';
        const fromProfile = await this.getDisplayName(user.id);
        if (generation !== Storage._accountGeneration) return;
        var rawDisplay = fromProfile || (user.user_metadata && user.user_metadata.user_name) || user.email || 'Signed in';
        var displayName = this.escapeHtmlText(rawDisplay) || 'Signed in';
        const adminLink = this.data.isAdmin ? `
            <a href="#" id="profileAdminLink"><span class="material-icons">admin_panel_settings</span>Admin</a>
          ` : '';
        menu.innerHTML = `
          <div class="profile-dropdown-user">
            <span class="material-icons">person</span>${displayName}
          </div>
          <div class="profile-dropdown-actions">
            <a href="#" id="profileModalLink"><span class="material-icons">manage_accounts</span>Profile</a>
            <a href="#" id="profileFaqLink"><span class="material-icons">help</span>Help</a>
            ${adminLink}
          </div>
          <div class="profile-dropdown-signout">
            <a href="#" id="profileSignOutLink"><span class="material-icons">logout</span>Sign out</a>
          </div>
        `;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleProfileDropdown();
        });
        menu.querySelector('#profileModalLink').addEventListener('click', (e) => {
          e.preventDefault();
          this.closeProfileDropdown();
          this.showProfileModal();
        });
        const faqLink = menu.querySelector('#profileFaqLink');
        if (faqLink) faqLink.addEventListener('click', (e) => {
          e.preventDefault();
          this.closeProfileDropdown();
          this.showFaqModal();
        });
        menu.querySelector('#profileSignOutLink').addEventListener('click', (e) => {
          e.preventDefault();
          this.handleSignOut();
        });
        const adminLinkEl = menu.querySelector('#profileAdminLink');
        if (adminLinkEl) adminLinkEl.addEventListener('click', (e) => {
          e.preventDefault();
          this.closeProfileDropdown();
          this.updateURL({ view: 'admin' });
          this.loadView('admin');
        });
        menu.style.display = 'none';
      },

      toggleProfileDropdown() {
        const menu = document.getElementById('profileMenu');
        const btn = document.getElementById('profileBtn');
        if (!menu || !btn) return;
        const all = document.querySelectorAll('.dropdown-menu');
        all.forEach(m => { if (m !== menu) m.style.display = 'none'; });
        menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
        btn.setAttribute('aria-expanded', menu.style.display === 'block');
      },

      closeProfileDropdown() {
        const menu = document.getElementById('profileMenu');
        if (menu) menu.style.display = 'none';
        const btn = document.getElementById('profileBtn');
        if (btn) btn.setAttribute('aria-expanded', 'false');
      },

      async handleSignOut() {
        if (!backendClient) return;
        this.closeProfileDropdown();
        this.closeModal('settingsModal');
        try {
          await Storage.prepareForSignOut();
        } catch (error) {
          this.showNotification(error.message || 'Local account data could not be cleared. Sign out was not completed.', 'error');
          return false;
        }
        try {
          const result = await backendClient.auth.signOut();
          if (result && result.error) throw result.error;
        } catch (error) {
          this.showNotification('Sign out did not complete. Local account data was cleared; reload or try again before sharing this browser.', 'error');
          return false;
        }
        window.location.reload();
        return true;
      },

      setupEventListeners() {
        // Handle URL routing
        window.addEventListener('popstate', (e) => this.handleRouting());

        document.addEventListener('keydown', (e) => {
          const editableTarget = e.target?.closest?.('input, textarea, select, [contenteditable="true"]');
          const searchShortcut = (e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !editableTarget);
          if (!searchShortcut) return;
          const searchInput = document.getElementById('searchInput');
          if (!searchInput) return;
          e.preventDefault();
          document.body.classList.add('search-expanded');
          searchInput.focus();
          searchInput.select();
        });
        
        // Settings button is wired via onclick in HTML
        // Profile dropdown is wired in initProfileDropdown when the auth session is ready.
        
        // Global modal click-outside-to-close
        document.addEventListener('click', (e) => {
          const modal = e.target.closest('.modal');
          if (modal && e.target === modal) {
            if (modal.id === 'entityModal') this.tryCloseEntityModal();
            else this.closeModal(modal.id);
          }
        });

        // Handle dropdown closing (click outside)
        document.addEventListener('click', (e) => {
          const dropdowns = document.querySelectorAll('.dropdown-menu');
          dropdowns.forEach(dropdown => {
            if (!dropdown.contains(e.target) && !dropdown.previousElementSibling.contains(e.target)) {
              dropdown.style.display = 'none';
              if (dropdown.id === 'profileMenu') {
                const btn = document.getElementById('profileBtn');
                if (btn) btn.setAttribute('aria-expanded', 'false');
              }
            }
          });
          if (!e.target.closest('.profile-email-menu-wrap') && !e.target.closest('.profile-email-dropdown')) {
            document.querySelectorAll('.profile-email-dropdown.open').forEach(d => d.classList.remove('open'));
          }
          if (document.body.classList.contains('search-expanded') && !e.target.closest('.search-container') && !e.target.closest('#searchToggle')) {
            document.body.classList.remove('search-expanded');
          }
        });
      },

      setupMobileNav() {
        const sidebarToggle = document.getElementById('sidebarToggle');
        const sidebarOverlay = document.getElementById('sidebarOverlay');
        const searchToggle = document.getElementById('searchToggle');
        const searchInput = document.getElementById('searchInput');

        if (sidebarToggle) {
          sidebarToggle.addEventListener('click', () => {
            const open = document.body.classList.toggle('sidebar-open');
            sidebarToggle.setAttribute('aria-expanded', open);
            sidebarToggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
            if (sidebarOverlay) sidebarOverlay.setAttribute('aria-hidden', !open);
          });
        }
        if (sidebarOverlay) {
          sidebarOverlay.addEventListener('click', () => this.closeSidebar());
        }
        if (searchToggle && searchInput) {
          searchToggle.addEventListener('click', () => {
            document.body.classList.add('search-expanded');
            searchInput.focus();
          });
        }
        window.addEventListener('resize', () => {
          if (window.innerWidth > 640) {
            this.closeSidebar();
            document.body.classList.remove('search-expanded');
          }
        });

        this.setupMobileFooterVisibility();
      },

      setupMobileFooterVisibility() {
        const footer = document.querySelector('.app-footer');
        const mainContent = document.getElementById('mainContent');
        const mediaQuery = window.matchMedia('(max-width: 640px)');
        if (!footer || !mainContent || !mediaQuery) return;

        let lastScrollTop = 0;
        let rafId = null;

        const isAtBottom = () => (mainContent.scrollTop + mainContent.clientHeight) >= (mainContent.scrollHeight - 4);

        const updateFooterState = () => {
          if (!mediaQuery.matches) {
            footer.classList.remove('mobile-footer-visible');
            lastScrollTop = Math.max(mainContent.scrollTop, 0);
            return;
          }
          const currentScrollTop = Math.max(mainContent.scrollTop, 0);
          const isScrollingUp = currentScrollTop < (lastScrollTop - 2);
          footer.classList.toggle('mobile-footer-visible', isAtBottom() && isScrollingUp);
          lastScrollTop = currentScrollTop;
        };

        const queueUpdate = () => {
          if (rafId !== null) return;
          rafId = window.requestAnimationFrame(() => {
            rafId = null;
            updateFooterState();
          });
        };

        mainContent.addEventListener('scroll', queueUpdate, { passive: true });
        window.addEventListener('resize', queueUpdate);
        if (typeof mediaQuery.addEventListener === 'function') {
          mediaQuery.addEventListener('change', queueUpdate);
        } else if (typeof mediaQuery.addListener === 'function') {
          mediaQuery.addListener(queueUpdate);
        }
        updateFooterState();
      },

      closeSidebar() {
        document.body.classList.remove('sidebar-open');
        const btn = document.getElementById('sidebarToggle');
        if (btn) {
          btn.setAttribute('aria-expanded', 'false');
          btn.setAttribute('aria-label', 'Open menu');
        }
        const overlay = document.getElementById('sidebarOverlay');
        if (overlay) overlay.setAttribute('aria-hidden', 'true');
      },
      
      handleRouting() {
        const url = new URL(window.location);
        const view = url.searchParams.get('view') || 'dashboard';
        const entityType = url.searchParams.get('entityType');
        const entityId = url.searchParams.get('entityId');
        const category = url.searchParams.get('category');
        
        if (entityType) {
          this.showEntityForm(entityType, entityId || '');
        } else if (category) {
          this.loadView(category);
        } else {
          this.loadView(view);
        }
      },
      
      updateURL(params) {
        const url = new URL(window.location);
        Object.entries(params).forEach(([key, value]) => {
          if (value) {
            url.searchParams.set(key, value);
          } else {
            url.searchParams.delete(key);
          }
        });
        window.history.pushState({}, '', url);
      },
      
      mergeData(target, source) {
        const result = JSON.parse(JSON.stringify(target));
        for (let key in source) {
          if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
            if (!result[key]) result[key] = {};
            result[key] = this.mergeData(result[key], source[key]);
          } else {
            result[key] = source[key];
          }
        }
        return result;
      },
      
      saveData() {
        this.normalizeEntityTypeSchema();
        const cid = this.data.currentWorkspaceId;
        if (this.data.workspaces && cid) {
          this.data.workspaces[cid] = {
            name: (this.data.workspaces[cid] && this.data.workspaces[cid].name) || (cid === 'default' ? 'Default' : 'Inventory'),
            categories: { ...this.data.categories },
            entityTypes: { ...this.data.entityTypes },
            entities: { ...this.data.entities }
          };
        }
        this.data.settings = this.normalizeSettings(this.data.settings);
        const dataToSave = { ...this.data, version: this.data.version };
        if (Storage.getOnboardingDone()) dataToSave.onboardingDone = true;
        Storage.setAppData(dataToSave).catch(error => {
          const message = error && error.message === 'App data changed since preview'
            ? 'Your changes were not saved because newer app data is available. Your local changes are still open.'
            : 'Your changes could not be saved. Your local changes are still open.';
          this.showNotification(message, 'error');
        });
      },

      renderSyncStatus() {
        const status = document.getElementById('syncStatus');
        if (!status) return;
        const sync = Storage.getSyncStatus();
        status.dataset.state = sync.state;
        for (const id of ['mainContent', 'categoryList', 'workspaceSwitcherBtn', 'settingsBtn']) {
          const element = document.getElementById(id);
          if (element) element.inert = Storage._accountVerified === false;
        }
        const isQuiet = sync.state === 'idle' || sync.state === 'synced';
        status.hidden = isQuiet;
        status.textContent = isQuiet ? '' : sync.message;
        if (Storage.getConflictRecovery()) {
          status.hidden = false;
          const review = document.createElement('button');
          review.type = 'button';
          review.className = 'btn btn-secondary';
          review.textContent = 'Review preserved local changes';
          review.onclick = () => this.showSyncConflictRecovery();
          status.append(review);
        }
      },

      showAccountLoadError(error) {
        const main = document.getElementById('mainContent');
        if (!main) return;
        main.innerHTML = `
          <div class="card account-load-error" role="alert">
            <div class="card-header"><h2><span class="material-icons">sync_problem</span> Account data unavailable</h2></div>
            <p>Your account data could not be loaded. Elistly has not created or saved any replacement data.</p>
            <p class="account-load-error-detail">Check your connection and reload. Any local changes remain on this device.</p>
          </div>`;
      },

      applyRemoteSyncData(remoteData) {
        if (document.getElementById('entityModal')) return false;
        if (remoteData === null) remoteData = { settings: {}, categories: {}, entityTypes: {}, entities: {}, workspaces: {}, currentWorkspaceId: '' };
        if (!remoteData || typeof remoteData !== 'object') return false;
        const current = new URL(window.location);
        const activeView = current.searchParams.get('category') || current.searchParams.get('view') || 'dashboard';

        this.data = { ...this.data, ...remoteData };
        this.data.settings = this.normalizeSettings(remoteData.settings, this.data.settings);
        if (remoteData.workspaces && typeof remoteData.currentWorkspaceId === 'string') {
          this.data.workspaces = remoteData.workspaces;
          this.data.currentWorkspaceId = remoteData.currentWorkspaceId;
          const w = this.data.workspaces[this.data.currentWorkspaceId];
          this.data.categories = { ...((w && w.categories) || {}) };
          this.data.entityTypes = { ...((w && w.entityTypes) || {}) };
          this.data.entities = { ...((w && w.entities) || {}) };
        } else {
          this.data.categories = { ...(remoteData.categories || {}) };
          this.data.entityTypes = { ...(remoteData.entityTypes || {}) };
          this.data.entities = { ...(remoteData.entities || {}) };
        }
        this.normalizeActivationState();
        this.renderSidebar();
        this.loadView(activeView);
        return true;
      },

      showOnboarding() {
        const presetIcons = { blank: 'add_circle_outline', library: 'menu_book', it: 'devices', staff: 'group', property: 'apartment' };
        const presets = SETUP_IDS.map(function (id) { return PRESETS[id]; }).filter(Boolean);
        const modalHtml = `
          <div class="modal onboarding-modal inline-flex-display" id="onboardingModal" data-persistent>
            <div class="modal-content">
              <div class="modal-header">
                <h3>Welcome to Elistly</h3>
              </div>
              <p class="onboarding-intro">Choose a setup to get started. You can change or remove anything later.</p>
              <div class="onboarding-options">
                ${presets.map(p => `
                  <button type="button" class="onboarding-option" onclick="App.applyPreset('${p.id}', true)">
                    <span class="onboarding-option-icon"><span class="material-icons">${presetIcons[p.id] || 'folder'}</span></span>
                    <div class="onboarding-option-body">
                      <div class="onboarding-option-title">${p.label}</div>
                      <p class="onboarding-option-desc">${p.description}</p>
                    </div>
                  </button>
                `).join('')}
              </div>
            </div>
          </div>`;
        const existing = document.getElementById('onboardingModal');
        if (existing) existing.remove();
        const div = document.createElement('div');
        div.innerHTML = modalHtml;
        document.body.appendChild(div.firstElementChild);
        this.showModal('onboardingModal');
      },

      applyPreset(presetId, fromOnboarding = false) {
        const preset = PRESETS[presetId];
        if (!preset) return;
        if (fromOnboarding) {
          this.data.categories = {};
          this.data.entityTypes = {};
          this.data.entities = {};
        }
        this.normalizeActivationState();
        const newlyEnabledTypeIds = [];
        Object.keys(preset.categories || {}).forEach(id => {
          if (this.data.categories[id]) this.data.categories[id].enabled = true;
        });
        Object.keys(preset.entityTypes || {}).forEach(id => {
          const type = this.data.entityTypes[id];
          if (!type) return;
          if (type.enabled === false) newlyEnabledTypeIds.push(id);
          type.enabled = true;
        });
        if (fromOnboarding) Storage.setOnboardingDone();
        this.saveData();
        const modal = document.getElementById('onboardingModal');
        if (modal) modal.remove();
        this.renderSidebar();
        this.loadView('dashboard');
        if (presetId !== 'blank') this.showNotification(`Enabled "${preset.label}" setup`, 'success');
        const samples = (window.SAMPLE_ENTITIES || {})[presetId];
        if (newlyEnabledTypeIds.length && samples && samples.order && samples.order.some(typeId => newlyEnabledTypeIds.includes(typeId) && Array.isArray(samples[typeId]) && samples[typeId].length)) {
          setTimeout(() => this.showSampleDataPrompt(presetId, newlyEnabledTypeIds), fromOnboarding ? 300 : 0);
        }
      },
      
      generateId() {
        return 'id-' + Math.random().toString(36).substring(2,9);
      },

      normalizeEntityTypeCategories() {
        Object.values(this.data.entityTypes || {}).forEach(type => {
          if (Array.isArray(type.categories)) {
            if (type.category) delete type.category;
            return;
          }
          type.categories = type.category ? [type.category] : [];
          if (type.category) delete type.category;
        });
      },

      getEntityTypeCategoryIds(type) {
        if (!type) return [];
        if (Array.isArray(type.categories) && type.categories.length) return type.categories;
        return type.category ? [type.category] : [];
      },

      normalizeActivationState() {
        let changed = false;
        this.data.categories = this.data.categories || {};
        this.data.entityTypes = this.data.entityTypes || {};
        Object.values(this.data.categories).forEach(category => { if (category.enabled == null) { category.enabled = true; changed = true; } });
        Object.values(this.data.entityTypes).forEach(type => { if (type.enabled == null) { type.enabled = true; changed = true; } });
        SETUP_IDS.filter(id => id !== 'blank').forEach(presetId => {
          const preset = PRESETS[presetId];
          if (!preset) return;
          Object.entries(preset.categories || {}).forEach(([categoryId, definition]) => {
            const current = this.data.categories[categoryId];
            if (!current) {
              this.data.categories[categoryId] = { ...structuredClone(definition), enabled: false, presetIds: [presetId] };
              changed = true;
            }
          });
          Object.entries(preset.entityTypes || {}).forEach(([typeId, definition]) => {
            const current = this.data.entityTypes[typeId];
            if (!current) {
              this.data.entityTypes[typeId] = { ...structuredClone(definition), enabled: false, presetIds: [presetId] };
              changed = true;
            }
          });
        });
        this.normalizeEntityTypeCategories();
        return changed;
      },

      getEnabledEntityTypes() {
        return Object.values(this.data.entityTypes || {}).filter(type => this.isEntityTypeAvailable(type));
      },

      isEntityTypeAvailable(typeOrId) {
        const type = typeof typeOrId === 'string'
          ? this.data.entityTypes?.[typeOrId]
          : typeOrId;
        if (!type || type.enabled === false) return false;
        const categoryIds = this.getEntityTypeCategoryIds(type);
        if (!categoryIds.length) return true;
        const categories = categoryIds.map(id => this.data.categories?.[id]).filter(Boolean);
        return !categories.length || categories.some(category => category.enabled !== false);
      },

      getEnabledCategories() {
        return Object.values(this.data.categories || {}).filter(category => category.enabled !== false);
      },

      setCategoryEnabled(categoryId, enabled) {
        const category = this.data.categories && this.data.categories[categoryId];
        if (!category) return false;
        category.enabled = !!enabled;
        this.saveData();
        this.renderSidebar();
        if (!enabled && this.currentView === categoryId) this.loadView('dashboard');
        this.showNotification(`${category.label || categoryId} ${enabled ? 'enabled' : 'disabled'}`, 'success');
        return true;
      },

      setEntityTypeEnabled(typeId, enabled, options = {}) {
        const type = this.data.entityTypes && this.data.entityTypes[typeId];
        if (!type) return false;
        type.enabled = !!enabled;
        this.getEntityTypeCategoryIds(type).forEach(categoryId => {
          const category = this.data.categories[categoryId];
          if (!category) return;
          if (enabled) {
            category.enabled = true;
          } else if (Array.isArray(category.presetIds) && category.presetIds.length) {
            const hasEnabledType = Object.values(this.data.entityTypes || {}).some(candidate =>
              candidate.enabled !== false && this.getEntityTypeCategoryIds(candidate).includes(categoryId)
            );
            if (!hasEnabledType) category.enabled = false;
          }
        });
        this.saveData();
        this.renderSidebar();
        if (!enabled && this.currentView && this.getEntityTypeCategoryIds(type).includes(this.currentView)) this.loadView('dashboard');
        const sampleList = enabled && Array.isArray(type.presetIds) && type.presetIds.length
          ? (window.SAMPLE_ENTITIES || {})[type.presetIds[0]]?.[typeId]
          : null;
        if (options.offerSamples !== false && Array.isArray(sampleList) && sampleList.length) this.showSampleDataPrompt(type.presetIds[0], [typeId]);
        this.showNotification(`${type.label || typeId} ${enabled ? 'enabled' : 'disabled'}`, 'success');
        return true;
      },

      showSampleDataPrompt(presetId, typeIds = null) {
        const preset = PRESETS[presetId];
        const label = preset ? preset.label : 'this setup';
        this._pendingSampleRequest = { presetId, typeIds: Array.isArray(typeIds) ? typeIds.slice() : null };
        const existing = document.getElementById('sampleDataModal');
        if (existing) existing.remove();
        const modalHtml = `
          <div class="modal" id="sampleDataModal">
            <div class="modal-content sample-data-modal-content">
              <button class="modal-close" onclick="App.closeModal('sampleDataModal'); App._pendingSampleRequest = null;" aria-label="Close">
                <span class="material-icons">close</span>
              </button>
              <div class="modal-header">
                <h3>Add example data?</h3>
              </div>
              <div class="modal-body">
                <p class="modal-description">The ${label} structure is enabled and empty. Would you like to add optional example items for the newly enabled asset types?</p>
              </div>
              <div class="modal-actions">
                <button type="button" class="btn btn-secondary" onclick="App.closeModal('sampleDataModal'); App._pendingSampleRequest = null;">No, keep it empty</button>
                <button type="button" class="btn btn-primary" onclick="App.confirmSampleData(); App.closeModal('sampleDataModal');">
                  <span class="material-icons">add</span> Add example data
                </button>
              </div>
            </div>
          </div>`;
        const div = document.createElement('div');
        div.innerHTML = modalHtml;
        document.body.appendChild(div.firstElementChild);
        this.showModal('sampleDataModal');
      },

      confirmSampleData() {
        const request = this._pendingSampleRequest;
        this._pendingSampleRequest = null;
        if (request) this.loadSampleData(request.presetId, request.typeIds);
      },

      loadSampleData(presetId, typeIds = null) {
        const samples = (window.SAMPLE_ENTITIES || {})[presetId];
        if (!samples || !samples.order) return;
        const allowedTypes = new Set(Array.isArray(typeIds) ? typeIds : samples.order);
        const createdIds = {};
        samples.order.forEach(typeId => {
          if (!allowedTypes.has(typeId)) return;
          const type = this.data.entityTypes[typeId];
          const list = samples[typeId];
          if (!type || !Array.isArray(list)) return;
          createdIds[typeId] = [];
          list.forEach((data, sampleIndex) => {
            const sampleSource = `${presetId}:${typeId}:${sampleIndex}`;
            const sampleScalarEntries = Object.entries(data).filter(([key]) => !key.endsWith('Index'));
            const existing = Object.values(this.data.entities).find(entity =>
              entity.type === typeId && (entity.sampleSource === sampleSource || sampleScalarEntries.every(([key, value]) => entity[key] === value))
            );
            if (existing) {
              createdIds[typeId].push(existing.id);
              return;
            }
            const id = this.generateId();
            const entity = { id, type: typeId, sampleSource };
            Object.keys(data).forEach(k => {
              if (k.endsWith('Index')) {
                const assocName = k.replace(/Index$/, '');
                const assoc = type.associations ? type.associations.find(a => a.name === assocName) : null;
                const refType = assoc && assoc.association ? assoc.association.targetType : null;
                entity[assocName] = refType && createdIds[refType] ? (createdIds[refType][data[k]] || '') : '';
              } else {
                entity[k] = data[k];
              }
            });
            if (type.enableNameGen) {
              entity.autoName = this.generateAutoName(typeId, entity);
              delete entity.name;
            } else if (type.fields && type.fields.some(f => f.name === 'firstName') && type.fields.some(f => f.name === 'lastName')) {
              entity.name = [entity.firstName, entity.lastName].filter(Boolean).join(' ').trim() || entity.name || '';
              delete entity.autoName;
            }
            this.data.entities[id] = entity;
            createdIds[typeId].push(id);
          });
        });
        this.saveData();
        this.renderSidebar();
        this.loadView('dashboard');
        this.showNotification('Example data added', 'success');
      },

      getEntityDisplayName(entityOrId) {
        const e = typeof entityOrId === 'string' ? this.data.entities[entityOrId] : entityOrId;
        if (!e) return '';
        const type = this.data.entityTypes[e.type];
        if (type?.enableNameGen) return e.autoName || e.name || e.id;
        return e.name || e.autoName || e.id;
      },

      getEntityTitleInfo(entity) {
        if (!entity) return { title: '', fieldName: null };
        const type = this.data.entityTypes[entity.type];
        if (type?.enableNameGen && entity.autoName) {
          return { title: String(entity.autoName), fieldName: null };
        }
        if (entity.name) {
          return { title: String(entity.name), fieldName: 'name' };
        }
        if (entity.autoName) {
          return { title: String(entity.autoName), fieldName: null };
        }
        if (entity.id) {
          return { title: String(entity.id), fieldName: null };
        }
        return { title: '', fieldName: null };
      },

      getEntityCardTitle(entity) {
        return this.getEntityTitleInfo(entity).title;
      },

      filterEntitiesForType(typeId, filters = {}, query = '') {
        const type = this.data.entityTypes[typeId];
        if (!type) return [];
        const normalizedQuery = String(query).toLocaleLowerCase();
        const matchesFilter = (entity, descriptor, filter) => {
          const value = entity[descriptor.name];
          if (filter.value === '__missing__') return value === undefined || value === null || value === '';
          if (value === undefined || value === null || value === '') return false;
          if (descriptor.type === 'number') {
            const actual = Number(value);
            const expected = Number(filter.value);
            if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
            return filter.operator === 'greater-than' ? actual > expected
              : filter.operator === 'less-than' ? actual < expected
              : actual === expected;
          }
          if (descriptor.type === 'date') {
            const actual = String(value);
            const expected = String(filter.value);
            return filter.operator === 'after' ? actual > expected
              : filter.operator === 'before' ? actual < expected
              : actual === expected;
          }
          if (descriptor.type === 'checkbox') return String(value === true || value === 'on' || value === '1' || value === 'yes') === String(filter.value);
          if (descriptor.advancedAssociation) return String(value) === String(filter.value);
          if (Array.isArray(value)) return value.some(item => String(item) === String(filter.value));
          if (descriptor.type === 'dropdown') return String(value) === String(filter.value);
          return String(value).toLocaleLowerCase().includes(String(filter.value).toLocaleLowerCase());
        };
        const descriptors = [
          ...(type.fields || []).filter(field => field && field.name && field.type !== 'qr'),
          ...(type.associations || []).filter(association => association && association.name && association.association).map(association => ({ ...association, advancedAssociation: true }))
        ];
        return Object.values(this.data.entities || {}).filter(entity => {
          if (!entity || entity.type !== typeId || !this.getEntityCardTitle(entity).toLocaleLowerCase().includes(normalizedQuery)) return false;
          return descriptors.every(descriptor => !filters[descriptor.name] || matchesFilter(entity, descriptor, filters[descriptor.name]));
        });
      },

      getSortDescriptors(typeId) {
        const type = this.data.entityTypes?.[typeId];
        if (!type) return [{ name: 'name', label: 'Generated name', type: 'text', generatedName: true }];
        return [
          { name: 'name', label: 'Generated name', type: 'text', generatedName: true },
          ...(type.fields || []).filter(field => field && field.name && ['text', 'dropdown', 'number', 'date', 'checkbox'].includes(field.type))
        ];
      },

      sortEntities(entities, typeId, sort = {}) {
        const descriptors = this.getSortDescriptors(typeId);
        const descriptor = descriptors.find(field => field.name === sort.field) || descriptors[0];
        if (!descriptor) return [...entities];
        const direction = sort.direction === 'desc' ? -1 : 1;
        const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
        const valueFor = entity => descriptor.generatedName ? this.getEntityCardTitle(entity) : entity[descriptor.name];
        const normalize = value => {
          if (value === undefined || value === null || value === '' || Array.isArray(value) || typeof value === 'object') return null;
          if (descriptor.type === 'number') return Number.isFinite(Number(value)) ? Number(value) : null;
          if (descriptor.type === 'date') {
            const text = String(value);
            const timestamp = /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T00:00:00Z`) : NaN;
            return Number.isFinite(timestamp) ? timestamp : null;
          }
          if (descriptor.type === 'checkbox') return value === true || value === 'true' || value === 'on' || value === 1 || value === '1' ? 1 : value === false || value === 'false' || value === 'off' || value === 0 || value === '0' ? 0 : null;
          return String(value);
        };
        return [...entities].sort((left, right) => {
          const a = normalize(valueFor(left));
          const b = normalize(valueFor(right));
          if (a === null || b === null) {
            if (a !== null) return -1;
            if (b !== null) return 1;
          } else {
            const result = typeof a === 'string' ? collator.compare(a, b) : a - b;
            if (result) return result * direction;
            const raw = String(valueFor(left)).localeCompare(String(valueFor(right)), 'en', { sensitivity: 'variant' });
            if (raw) return raw * direction;
          }
          return collator.compare(String(left.id), String(right.id));
        });
      },

      escapeHtmlText(value) {
        return String(value ?? '').replace(/[&<>"']/g, character => ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;'
        })[character]);
      },

      registerClickAction(action) {
        if (!this._clickActions) {
          this._clickActions = new Map();
          this._nextClickActionId = 0;
          const pruneClickActions = () => {
            this._clickActions.forEach((_, actionId) => {
              if (!document.querySelector(`[data-elistly-click-action="${actionId}"]`)) {
                this._clickActions.delete(actionId);
              }
            });
          };
          document.addEventListener('click', event => {
            const target = event.target.closest('[data-elistly-click-action]');
            const callback = target && this._clickActions.get(target.dataset.elistlyClickAction);
            if (!callback) return;
            event.preventDefault();
            callback();
          });
          new MutationObserver(pruneClickActions).observe(document.body, { childList: true, subtree: true });
        }
        const actionId = `elistly-action-${++this._nextClickActionId}`;
        this._clickActions.set(actionId, action);
        return actionId;
      },

      entityFormActionAttribute(entity) {
        const actionId = this.registerClickAction(() => this.showEntityForm(entity.type, entity.id));
        return `data-elistly-click-action="${actionId}"`;
      },

      newEntityFormActionAttribute(typeId) {
        const actionId = this.registerClickAction(() => this.showEntityForm(typeId));
        return `data-elistly-click-action="${actionId}"`;
      },

      categoryCsvExportActionAttribute(categoryId, typeId) {
        const actionId = this.registerClickAction(() => this.downloadCategoryCsvExport(categoryId, typeId));
        return `data-elistly-click-action="${actionId}"`;
      },

      clearBulkSelection() {
        this._selectedEntityIds = new Set();
        this._bulkSelectionContext = null;
      },

      updateBulkSelection(categoryId, typeId, entities) {
        const context = `${categoryId}:${typeId}`;
        if (this._bulkSelectionContext !== context) {
          this._selectedEntityIds = new Set();
          this._bulkSelectionContext = context;
        }
        const visibleIds = new Set(entities.map(entity => entity.id));
        this._selectedEntityIds = new Set([...(this._selectedEntityIds || [])].filter(id => visibleIds.has(id)));
        this._visibleBulkSelectionEntities = entities;
      },

      renderBulkSelectionToolbar(typeId, entities) {
        const selectedCount = this._selectedEntityIds?.size || 0;
        const allSelected = entities.length > 0 && selectedCount === entities.length;
        return `<div class="bulk-selection-toolbar" data-bulk-selection-toolbar>
          <label><input type="checkbox" data-select-all-visible aria-label="Select all visible entities" ${allSelected ? 'checked' : ''} ${typeId ? '' : 'disabled'}> Select all visible</label>
          <span data-selected-count>${selectedCount} selected</span>
          <button type="button" class="btn btn-secondary" data-selected-csv-export ${selectedCount && typeId ? '' : 'disabled'}>Export selected CSV</button>
          <button type="button" class="btn btn-danger" data-selected-delete ${selectedCount && typeId ? '' : 'disabled'}>Delete selected</button>
        </div>`;
      },

      confirmDeleteSelectedEntities(categoryId) {
        const selectedIds = [...(this._selectedEntityIds || [])].filter(id => this.data.entities[id]);
        if (!selectedIds.length) return;
        this.showConfirmModal({
          title: `Delete ${selectedIds.length} selected item${selectedIds.length === 1 ? '' : 's'}?`,
          message: `Delete ${selectedIds.length} selected item${selectedIds.length === 1 ? '' : 's'}? This cannot be undone.`,
          confirmLabel: 'Delete selected',
          confirmVariant: 'danger',
          onConfirm: () => {
            selectedIds.forEach(id => delete this.data.entities[id]);
            this.saveData();
            this.clearBulkSelection();
            this.loadView(categoryId || 'dashboard');
            this.showNotification(`${selectedIds.length} item${selectedIds.length === 1 ? '' : 's'} deleted successfully`, 'success');
          }
        });
      },

      renderSelectableEntityMiniCard(entity) {
        const title = this.getEntityCardTitle(entity) || entity.id;
        const selected = this._selectedEntityIds?.has(entity.id);
        return `<div class="bulk-selectable-entity"><label class="bulk-entity-checkbox"><input type="checkbox" data-entity-selection value="${this.escapeHtmlText(entity.id)}" aria-label="Select ${this.escapeHtmlText(title)}" ${selected ? 'checked' : ''}> Select</label>${this.renderEntityMiniCard(entity)}</div>`;
      },

      viewActionAttribute(view) {
        const actionId = this.registerClickAction(() => this.loadView(view));
        return `data-elistly-click-action="${actionId}"`;
      },

      renderEntityMiniCard(entity) {
        const type = this.data.entityTypes[entity.type];
        const titleInfo = this.getEntityTitleInfo(entity);
        const title = titleInfo.title;
        if (!type) {
          return `<div class="mini-card" ${this.entityFormActionAttribute(entity)}>
            <div class="mini-card-icon"><span class="material-icons">folder</span></div>
            <div class="mini-card-fields"><div class="mini-field-label">${this.escapeHtmlText(title || entity.id)}</div></div>
          </div>`;
        }
        const visibleFields = (type.fields || [])
          .filter(f => f.visibleInCard && (f.name || '').trim())
          .filter(f => !titleInfo.fieldName || f.name !== titleInfo.fieldName);
        const assocLines = (type.associations || [])
          .filter(a => a.visibleInCard && entity[a.name])
          .map(a => {
            const name = this.getEntityDisplayName(entity[a.name]);
            return name ? `<div class="mini-field"><span class="mini-field-label">${this.escapeHtmlText(a.label)}:</span> <span>${this.escapeHtmlText(name)}</span></div>` : '';
          })
          .filter(Boolean)
          .join('');
        const fieldsHtml = visibleFields.map(field => {
          let value = entity[field.name];
          if (field.type === 'dropdown' && field.options && field.options.length > 0) {
            const opt = field.options.find(opt => opt.value === value);
            value = opt ? (opt.label || opt.value) : (value || '');
          } else if (field.type === 'date' && value) {
            value = new Date(value + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
          } else if (field.type === 'checkbox') {
            value = value === true || value === 'on' || value === '1' || value === 'yes' ? 'Yes' : 'No';
          } else if (field.type === 'qr') {
            const qr = this.createLocalQrDataUrl(value, 80);
            value = qr.src ? `<img src="${qr.src}" class="qr-preview qr-preview-inline" alt="QR code">` : '';
            const safeLabel = this.escapeHtmlText(field.label);
            return value
              ? `<div class="mini-field"><span class="mini-field-label">${safeLabel}:</span> ${value}</div>`
              : (qr.error ? `<div class="mini-field"><span class="mini-field-label">${safeLabel}:</span> <span>${qr.error}</span></div>` : '');
          } else {
            value = (value != null && value !== '') ? String(value) : '';
          }
          const safeLabel = this.escapeHtmlText(field.label);
          const safeValue = this.escapeHtmlText(value);
          return `<div class="mini-field"><span class="mini-field-label">${safeLabel}:</span> <span>${safeValue}</span></div>`;
        }).join('');
        return `<div class="mini-card" ${this.entityFormActionAttribute(entity)}>
          <div class="mini-card-icon"><span class="material-icons">${this.escapeHtmlText(type.icon)}</span></div>
          <div class="mini-card-fields">
            ${title ? `<div class="mini-card-title">${this.escapeHtmlText(title)}</div>` : ''}
            <div class="mini-card-properties">
              ${fieldsHtml}
              ${assocLines}
            </div>
          </div>
        </div>`;
      },

      formatFieldValue(field, value) {
        if (field.type === 'dropdown' && field.options && field.options.length > 0) {
          const opt = field.options.find(opt => opt.value === value);
          return opt ? (opt.label || opt.value) : (value || '');
        }
        if (field.type === 'date' && value) {
          return new Date(value + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        }
        if (field.type === 'checkbox') {
          return value === true || value === 'on' || value === '1' || value === 'yes' ? 'Yes' : 'No';
        }
        if (field.type === 'qr') return value || '';
        return (value != null && value !== '') ? String(value) : '';
      },

      createLocalQrDataUrl(value, targetSize) {
        if (value == null || value === '') return { src: '', error: '' };
        const payload = String(value);
        if (new TextEncoder().encode(payload).length > 1024) {
          return { src: '', error: 'QR value is too long to generate locally.' };
        }
        try {
          const qr = qrcode(0, 'M');
          qr.addData(payload, 'Byte');
          qr.make();
          const cellSize = Math.max(1, Math.floor(targetSize / (qr.getModuleCount() + 8)));
          return { src: qr.createDataURL(cellSize, cellSize * 4), error: '' };
        } catch (error) {
          return { src: '', error: 'QR value cannot be encoded locally.' };
        }
      },

      showEntityEditMode(show) {
        const view = document.getElementById('entityView');
        const edit = document.getElementById('entityEdit');
        const viewActions = document.getElementById('entityViewActions');
        const editActions = document.getElementById('entityEditActions');
        const titleEl = document.getElementById('entityModalTitle');
        const form = document.getElementById('entityForm');
        if (view) view.classList.toggle('hidden', show);
        if (edit) edit.classList.toggle('hidden', !show);
        if (viewActions) viewActions.classList.toggle('hidden', show);
        if (editActions) editActions.classList.toggle('hidden', !show);
        if (titleEl && form) {
          const typeId = form.getAttribute('data-type-id');
          const type = this.data.entityTypes[typeId];
          const entityId = form.getAttribute('data-entity-id');
          const entity = entityId ? this.data.entities[entityId] : null;
          const typeLabel = type ? type.label : '';
          if (show) {
            titleEl.textContent = typeLabel ? 'Edit ' + typeLabel : 'Edit';
          } else if (entity && type) {
            const info = this.getEntityTitleInfo(entity);
            titleEl.textContent = info.title || typeLabel;
          }
        }
      },
      
      showNotification(msg, type='info') {
        const sb = document.getElementById('snackbar');
        sb.textContent = msg;
        sb.className = `snackbar show ${type==='error' ? 'error' : type==='success' ? 'success' : ''}`;
        setTimeout(() => {
          sb.className = sb.className.replace('show','');
        }, this.data.settings.notifications?.duration || 3000);
      },

      /** Profile/account UI uses this; delegates to showNotification. */
      showSnackbar(msg, isError = false) {
        this.showNotification(msg, isError ? 'error' : 'success');
      },

      /* VERSION UPDATE MODAL */
      showUpdateModal() {
        loadVersionHistory().then(() => {
          const changes = window.VERSION_CHANGES || [];
          const storedVersion = (Storage._cached && Storage._cached.version) || this.data?.version || '1.0.0';
          const relevantVersions = changes
            .filter(v => this.compareVersions(v.version, storedVersion) > 0)
            .sort((a, b) => this.compareVersions(b.version, a.version));

          if (relevantVersions.length === 0) return;

          const modalHtml = `
          <div class="modal inline-flex-display" id="updateModal">
            <div class="modal-content">
              <h3>Update Available (v${CURRENT_VERSION})</h3>
              <p class="u-mb-150">A new version is available with improvements to the core application.</p>
              
              <div class="update-section update-section update-section-emphasis">
                <h4>What's New</h4>
                <ul class="update-list update-list-reset">
                  ${relevantVersions.map(v => `
                    <li class="u-mb-100">
                      <strong class="update-version-heading">Version ${v.version}</strong>
                      <ul class="update-list update-list-indented">
                        ${v.changes.map(change => `
                          <li class="update-list-item">
                            <span class="update-list-bullet">â€¢</span>
                            ${change}
                          </li>
                        `).join('')}
                      </ul>
                    </li>
                  `).join('')}
                </ul>
              </div>
              
              <div class="update-section update-section update-section-emphasis">
                <h4>Update Options</h4>
                <div class="form-group">
                  <label class="checkbox-label">
                    <input type="checkbox" class="elistly-checkbox" name="updateCore" checked disabled>
                    <span>Core System Updates</span>
                    <div class="help-text">Required system improvements and bug fixes</div>
                  </label>
                </div>
              </div>
              
              <div class="modal-actions">
                <button class="btn btn-primary" onclick="App.applyUpdate()">
                  <span class="material-icons">system_update_alt</span>
                  Update Now
                </button>
                <button class="btn btn-secondary" onclick="App.postponeUpdate()">
                  <span class="material-icons">schedule</span>
                  Remind me in 24h
                </button>
              </div>
            </div>
          </div>
        `;
          const existingModal = document.getElementById('updateModal');
          if (existingModal) existingModal.remove();
          const div = document.createElement('div');
          div.innerHTML = modalHtml;
          document.body.appendChild(div.firstElementChild);
        });
      },
      
      compareVersions(a, b) {
        const partsA = a.split('.').map(Number);
        const partsB = b.split('.').map(Number);
        for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
          const numA = partsA[i] || 0;
          const numB = partsB[i] || 0;
          if (numA > numB) return 1;
          if (numA < numB) return -1;
        }
        return 0;
      },
      
      closeUpdateModal() {
        this.closeModal('updateModal');
      },
      
      postponeUpdate() {
        localStorage.setItem('postponedUpdate', 'true');
        localStorage.setItem('lastPostponedTime', Date.now().toString());
        this.closeModal('updateModal');
        this.showNotification('Update postponed for 24 hours', 'info');
      },
      
      showUpdateSuccessModal(details) {
        const modalHtml = `
          <div class="modal inline-flex-display" id="updateSuccessModal">
            <div class="modal-content">
              <div class="update-success-header">
                <span class="material-icons update-success-icon">check_circle</span>
                <h3>Update Complete!</h3>
                <p>System successfully updated to v${CURRENT_VERSION}</p>
              </div>
              
              <div class="update-section">
                <h4>Changes Applied</h4>
                <ul>
                  ${details.map(detail => `<li>${detail}</li>`).join('')}
                </ul>
              </div>
              
              <div class="modal-actions">
                <button class="btn btn-primary" onclick="document.getElementById('updateSuccessModal').remove()">
                  <span class="material-icons">done</span>
                  Got it
                </button>
              </div>
            </div>
          </div>
        `;
        
        // Remove existing modal if present
        const existingModal = document.getElementById('updateSuccessModal');
        if (existingModal) {
          existingModal.remove();
        }
        
        // Add new modal
        const div = document.createElement('div');
        div.innerHTML = modalHtml;
        document.body.appendChild(div.firstElementChild);
      },
      
      applyUpdate(options) {
        // Show loading state
        const updateBtn = document.querySelector('#updateModal .btn-primary');
        if (updateBtn) {
          updateBtn.disabled = true;
          updateBtn.innerHTML = '<span class="material-icons">sync</span> Updating...';
        }
        
        // Clear any postponed update status
        localStorage.removeItem('postponedUpdate');
        localStorage.removeItem('lastPostponedTime');
        
        // Get all changes being applied (VERSION_CHANGES loaded when update modal was shown)
        const storedVersion = this.data.version || '1.0.0';
        const changes = window.VERSION_CHANGES || [];
        const relevantVersions = changes
          .filter(v => this.compareVersions(v.version, storedVersion) > 0)
          .sort((a, b) => this.compareVersions(b.version, a.version));
        
        // Update version
        this.data.version = CURRENT_VERSION;
        this.saveData();
        
        // Show success message with details
        const updateDetails = [];
        updateDetails.push(`Core system updated to v${CURRENT_VERSION}`);
        
        // Add all changes from relevant versions
        relevantVersions.forEach(v => {
          updateDetails.push(...v.changes);
        });
        
        // Close update modal and show success notification
        setTimeout(() => {
          this.closeUpdateModal();
          this.showUpdateSuccessModal(updateDetails);
          this.showNotification(`System updated to v${CURRENT_VERSION}`, 'success');
        }, 1000);
      },
      
      updateAccentColor(color, save = true) {
        const normalized = this.normalizeHex(color);
        if (!normalized) return;
        var rgb = this.hexToRgb(normalized);
        document.documentElement.style.setProperty('--accent-color', normalized);
        document.documentElement.style.setProperty('--accent-color-rgb', rgb.r + ', ' + rgb.g + ', ' + rgb.b);
        if (save) localStorage.setItem('accentColor', normalized);
        const hexEl = document.querySelector('.accent-color-hex');
        if (hexEl) hexEl.textContent = normalized;
        const swatchEl = document.querySelector('.accent-color-swatch');
        if (swatchEl) swatchEl.style.backgroundColor = normalized;
      },

      updateHeaderColor(color, save = true) {
        const normalized = this.normalizeHex(color);
        if (!normalized) return;
        document.documentElement.style.setProperty('--header-bg', normalized);
        var rgb = this.hexToRgb(normalized);
        var luminance = rgb.r * 0.299 + rgb.g * 0.587 + rgb.b * 0.114;
        document.documentElement.style.setProperty('--header-text', luminance > 186 ? '#202124' : '#ffffff');
        if (save) localStorage.setItem('headerColor', normalized);
        const hexEl = document.querySelector('.header-color-hex');
        if (hexEl) hexEl.textContent = normalized;
        const swatchEl = document.querySelector('.header-color-swatch');
        if (swatchEl) swatchEl.style.backgroundColor = normalized;
      },

      applyLogoStyle(style) {
        style = (style || 'color').toLowerCase();
        if (style !== 'color' && style !== 'white' && style !== 'black') style = 'color';
        document.documentElement.setAttribute('data-logo-style', style);
        var img = document.getElementById('appLogo');
        if (img) img.src = style === 'color' ? 'img/elistly-logo.svg' : 'img/elistly-logo-' + style + '.svg';
      },

      setLogoStyle(style) {
        style = (style || 'color').toLowerCase();
        if (style !== 'color' && style !== 'white' && style !== 'black') style = 'color';
        this.applyLogoStyle(style);
        localStorage.setItem('logoStyle', style);
        document.querySelectorAll('.logo-style-btn').forEach(function (b) {
          b.classList.toggle('active', b.getAttribute('data-logo-style') === style);
        });
      },

      hexToRgb(hex) {
        // Remove # if present
        hex = hex.replace('#', '');
        
        // Parse the hex values
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        
        return { r, g, b };
      },

      rgbToHex(r, g, b) {
        const toHex = (v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
      },

      rgbToHsv(r, g, b) {
        const rn = r / 255;
        const gn = g / 255;
        const bn = b / 255;
        const max = Math.max(rn, gn, bn);
        const min = Math.min(rn, gn, bn);
        const delta = max - min;
        let h = 0;
        if (delta !== 0) {
          if (max === rn) h = ((gn - bn) / delta) % 6;
          else if (max === gn) h = (bn - rn) / delta + 2;
          else h = (rn - gn) / delta + 4;
          h = Math.round(h * 60);
          if (h < 0) h += 360;
        }
        const s = max === 0 ? 0 : delta / max;
        const v = max;
        return { h, s, v };
      },

      hsvToRgb(h, s, v) {
        const c = v * s;
        const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
        const m = v - c;
        let r1 = 0, g1 = 0, b1 = 0;
        if (h >= 0 && h < 60) { r1 = c; g1 = x; b1 = 0; }
        else if (h >= 60 && h < 120) { r1 = x; g1 = c; b1 = 0; }
        else if (h >= 120 && h < 180) { r1 = 0; g1 = c; b1 = x; }
        else if (h >= 180 && h < 240) { r1 = 0; g1 = x; b1 = c; }
        else if (h >= 240 && h < 300) { r1 = x; g1 = 0; b1 = c; }
        else { r1 = c; g1 = 0; b1 = x; }
        return {
          r: Math.round((r1 + m) * 255),
          g: Math.round((g1 + m) * 255),
          b: Math.round((b1 + m) * 255)
        };
      },

      normalizeHex(value) {
        if (!value) return null;
        let hex = String(value).trim();
        if (!hex) return null;
        if (hex[0] !== '#') hex = '#' + hex;
        if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
          hex = '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
        }
        if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
        return hex.toLowerCase();
      },

      resetAccentColor() {
        this.setColorPickerHex('#2a7ebf', true);
      },

      resetHeaderColor() {
        this.setColorPickerHex('#1a1b1e', true);
      },

      resetColorPickerDefault() {
        const defaultHex = this._colorPickerTarget === 'header' ? '#1a1b1e' : '#2a7ebf';
        this.setColorPickerHex(defaultHex, true);
      },

      openColorPicker(target) {
        const current = target === 'header'
          ? (localStorage.getItem('headerColor') || '#1a1b1e')
          : (localStorage.getItem('accentColor') || '#2a7ebf');
        this._colorPickerTarget = target === 'header' ? 'header' : 'accent';
        this.showColorPickerModal(current);
      },

      showColorPickerModal(hex) {
        let modal = document.getElementById('colorPickerModal');
        if (!modal) {
          const html = `
            <div class="modal" id="colorPickerModal">
              <div class="modal-content color-picker-modal">
                <button class="modal-close" onclick="App.closeModal('colorPickerModal')">
                  <span class="material-icons">close</span>
                </button>
                <div class="modal-header">
                  <h3 id="colorPickerTitle">Pick a color</h3>
                </div>
                <div class="modal-body">
                  <div class="color-picker-preview">
                    <div class="color-picker-swatch" id="colorPickerSwatch"></div>
                    <div class="color-picker-hex" id="colorPickerHex"></div>
                  </div>
                  <div class="color-picker-body">
                    <div class="color-picker-square" id="colorPickerSquare">
                      <div class="color-picker-white"></div>
                      <div class="color-picker-black"></div>
                      <div class="color-picker-handle" id="colorPickerHandle"></div>
                    </div>
                    <div class="color-picker-hue" id="colorPickerHue">
                      <div class="color-picker-hue-handle" id="colorPickerHueHandle"></div>
                    </div>
                  </div>
                  <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" onclick="App.resetAccentColor()" id="colorPickerDefaultBtn">Default</button>
                    <button type="button" class="btn btn-primary" onclick="App.closeModal('colorPickerModal')">Done</button>
                  </div>
                </div>
              </div>
            </div>
          `;
          const div = document.createElement('div');
          div.innerHTML = html.trim();
          document.body.appendChild(div.firstElementChild);
          modal = document.getElementById('colorPickerModal');
        }
        const title = document.getElementById('colorPickerTitle');
        if (title) title.textContent = this._colorPickerTarget === 'header' ? 'Header color' : 'Accent color';
        const defaultBtn = document.getElementById('colorPickerDefaultBtn');
        if (defaultBtn) defaultBtn.onclick = () => this.resetColorPickerDefault();
        this.initColorPickerHandlers();
        this.setColorPickerHex(hex, false);
        this.showModal('colorPickerModal');
      },

      initColorPickerHandlers() {
        if (this._colorPickerBound) return;
        const square = document.getElementById('colorPickerSquare');
        const hue = document.getElementById('colorPickerHue');
        if (!square || !hue) return;
        const onSquare = (event) => {
          const rect = square.getBoundingClientRect();
          const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
          const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
          const s = rect.width === 0 ? 0 : x / rect.width;
          const v = rect.height === 0 ? 0 : 1 - (y / rect.height);
          if (!this._colorPickerState) this._colorPickerState = { h: 0, s, v };
          this._colorPickerState.s = s;
          this._colorPickerState.v = v;
          this.updateColorPickerFromState(true);
        };
        const onHue = (event) => {
          const rect = hue.getBoundingClientRect();
          const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
          const h = rect.height === 0 ? 0 : Math.round((1 - y / rect.height) * 360);
          if (!this._colorPickerState) this._colorPickerState = { h, s: 0, v: 0 };
          this._colorPickerState.h = h >= 360 ? 359 : h;
          this.updateColorPickerFromState(true);
        };
        const bindDrag = (el, handler) => {
          const start = (e) => {
            handler(e);
            const move = (ev) => handler(ev);
            const stop = () => {
              window.removeEventListener('pointermove', move);
              window.removeEventListener('pointerup', stop);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', stop);
          };
          el.addEventListener('pointerdown', start);
        };
        bindDrag(square, onSquare);
        bindDrag(hue, onHue);
        this._colorPickerBound = true;
      },

      setColorPickerHex(value, save) {
        const normalized = this.normalizeHex(value);
        if (!normalized) return;
        const rgb = this.hexToRgb(normalized);
        const hsv = this.rgbToHsv(rgb.r, rgb.g, rgb.b);
        this._colorPickerState = { h: hsv.h, s: hsv.s, v: hsv.v };
        this.updateColorPickerFromState(save);
      },

      updateColorPickerFromState(save) {
        const state = this._colorPickerState || { h: 0, s: 0, v: 0 };
        const rgb = this.hsvToRgb(state.h, state.s, state.v);
        const hex = this.rgbToHex(rgb.r, rgb.g, rgb.b);
        const swatch = document.getElementById('colorPickerSwatch');
        const hexEl = document.getElementById('colorPickerHex');
        const square = document.getElementById('colorPickerSquare');
        const handle = document.getElementById('colorPickerHandle');
        const hue = document.getElementById('colorPickerHue');
        const hueHandle = document.getElementById('colorPickerHueHandle');
        if (swatch) swatch.style.backgroundColor = hex;
        if (hexEl) hexEl.textContent = hex;
        if (square) square.style.backgroundColor = `hsl(${state.h}, 100%, 50%)`;
        if (handle && square) {
          const width = square.clientWidth;
          const height = square.clientHeight;
          const x = Math.round(state.s * width);
          const y = Math.round((1 - state.v) * height);
          handle.style.transform = `translate(${x}px, ${y}px)`;
        }
        if (hueHandle && hue) {
          const height = hue.clientHeight;
          const y = Math.round((1 - state.h / 360) * height);
          hueHandle.style.transform = `translate(-50%, ${y}px)`;
        }
        if (save) {
          if (this._colorPickerTarget === 'header') this.updateHeaderColor(hex, true);
          else this.updateAccentColor(hex, true);
        }
      },
      
      buildIconGrid() {
        const iconGrid = document.getElementById('iconGrid');
        if (!iconGrid) return;
        const icons = Array.isArray(this.data.settings?.materialIcons) ? this.data.settings.materialIcons : MATERIAL_ICONS;
        iconGrid.replaceChildren(...icons.map(icon => {
          const option = document.createElement('div');
          option.className = 'icon-option';
          option.dataset.icon = icon;
          const glyph = document.createElement('span');
          glyph.className = 'material-icons';
          glyph.textContent = icon;
          const label = document.createElement('span');
          label.className = 'icon-label';
          label.textContent = icon;
          option.append(glyph, label);
          return option;
        }));
      },
      
      getCurrentWorkspaceName() {
        const w = this.data.workspaces && this.data.workspaces[this.data.currentWorkspaceId];
        return (w && w.name) || (this.data.currentWorkspaceId === 'default' ? 'Default' : 'Inventory');
      },

      async showSvkInventoryImport() {
        return window.ElistlySvkInventory.open(this, apiRequest, Storage, await getAuthSession());
      },

      async showSvkInventoryHistory(deviceId) {
        return window.ElistlySvkInventory.history(this, apiRequest, Storage, await getAuthSession(), deviceId);
      },

      async showDeviceRegistrationModal() {
        const workspaceId = this.data.currentWorkspaceId;
        if (!workspaceId) return this.showNotification('Choose a workspace first.', 'error');
        const modal = document.createElement('div');
        modal.id = 'deviceRegistrationModal'; modal.className = 'modal';
        modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'deviceRegistrationTitle');
        modal.innerHTML = `<div class="modal-content">
          <div class="modal-header"><h3 id="deviceRegistrationTitle">Windows device collector</h3></div>
          <div class="modal-body">
            <p id="collectorWorkspace"></p>
            <p>Download one PowerShell script and run it on the Windows computer. It collects hardware and Windows facts and registers the computer. Existing manual records and person assignments are preserved.</p>
            <div class="form-group"><label for="collectorName">Collector name (optional)</label><input id="collectorName" type="text" maxlength="100"><p class="help-text">A name for this download, such as Office PCs. The computer is named from its Windows hostname.</p></div>
            <div class="form-group"><label for="collectorAutomatic"><input id="collectorAutomatic" type="checkbox"> Keep updated automatically</label>
              <p class="help-text">Unchecked: collect and register once, without installing anything. Checked: register and install reporting on this computer; run the script in administrator PowerShell. Reports update collected facts, not your manual fields. No remote code updates.</p></div>
            <fieldset id="collectorSchedule" hidden><legend>Reporting schedule</legend>
              <div class="form-group"><label for="collectorDay">Day of week</label><select id="collectorDay">${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map(day => `<option>${day}</option>`).join('')}</select></div>
              <div class="form-group"><label for="collectorTime">Time on the Windows computer</label><input id="collectorTime" type="time" value="09:00"></div>
              <label for="collectorLogon"><input id="collectorLogon" type="checkbox" checked> Also after sign-in</label>
              <p class="help-text">Runs immediately after installation, then weekly at the local time above. Missed runs catch up. Existing installed tasks are never replaced by this script.</p>
            </fieldset>
            <div class="form-group"><label for="registrationExpiry">Optional expiry (local time) — leave blank for no expiry</label><input id="registrationExpiry" type="datetime-local"></div>
            <p class="help-text">The download contains a private workspace enrollment secret, available only in this download. Store it securely and delete it from the target after use. Expiry or revocation stops future registrations; it does not stop already installed reporting. Revoke reporting separately below.</p>
            <p id="collectorStatus" role="status" aria-live="polite"></p>
            <details><summary>Created collectors and reporting</summary><div class="device-registration-tokens" aria-live="polite"></div><button type="button" class="btn btn-secondary" id="manageDeviceReporting">Manage installed reporting</button></details>
          </div>
          <div class="modal-actions"><button type="button" class="btn btn-primary" id="saveCollector">Save and download</button><button type="button" class="btn btn-secondary" id="closeCollector">Done</button></div>
        </div>`;
        modal.querySelector('#collectorWorkspace').textContent = `Workspace: ${this.getCurrentWorkspaceName()}. To use another workspace, close this form and switch workspace first.`;
        const status = modal.querySelector('#collectorStatus');
        const tokens = modal.querySelector('.device-registration-tokens');
        const automatic = modal.querySelector('#collectorAutomatic');
        automatic.onchange = () => { modal.querySelector('#collectorSchedule').hidden = !automatic.checked; };
        const refresh = async () => {
          tokens.textContent = 'Loading collectors…';
          try {
            const result = await apiRequest('/device-registration/tokens');
            if (!result.ok) { tokens.textContent = result.data.error || 'Could not load collectors.'; return; }
            this.renderDeviceRegistrationTokens(tokens, (result.data.tokens || []).filter(record => record.workspace_id === workspaceId), refresh);
          } catch { tokens.textContent = 'Could not load collectors. Close and reopen to retry.'; }
        };
        const create = modal.querySelector('#saveCollector');
        create.onclick = async () => {
          const expiry = modal.querySelector('#registrationExpiry').value;
          if (expiry && (!Number.isFinite(new Date(expiry).getTime()) || new Date(expiry) <= new Date())) { status.textContent = 'Choose a future expiry time or leave it blank.'; return; }
          const options = { automaticReporting: automatic.checked, day: modal.querySelector('#collectorDay').value, time: modal.querySelector('#collectorTime').value, atLogon: modal.querySelector('#collectorLogon').checked };
          create.disabled = true;
          status.textContent = 'Creating collector…';
          let issued = false;
          try {
            const apiUrl = getApiUrl().replace(/\/$/, '');
            // Validate configuration before issuing a secret.
            this.buildDeviceCollectorScript(apiUrl, '', options);
            const result = await apiRequest('/device-registration/tokens', { method: 'POST', body: { workspaceId, label: modal.querySelector('#collectorName').value.trim(), expiresAt: expiry ? new Date(expiry).toISOString() : null, automaticReporting: options.automaticReporting } });
            if (!result.ok) { status.textContent = result.data.error || 'Could not create collector. Try again.'; return; }
            issued = true;
            const script = this.buildDeviceCollectorScript(apiUrl, result.data.token, options);
            const url = URL.createObjectURL(new Blob(['\ufeff', script], { type: 'text/plain;charset=utf-8' }));
            const download = document.createElement('a'); download.href = url; download.download = 'Collect-ElistlyDevice.ps1'; download.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            status.textContent = options.automaticReporting
              ? 'Collector saved and download started. Run in administrator PowerShell to register and install reporting. No computer has been changed yet. Delete the download from the target after use.'
              : 'Collector saved and download started. Run in PowerShell to collect and register once. Nothing will be installed. No computer has been changed yet.';
            await refresh();
          } catch (error) {
            status.textContent = issued ? 'Collector was created, but the download could not be started. Revoke it below and create another download.' : (error.message || 'Could not create collector. Try again.');
            if (issued) await refresh();
          } finally { create.disabled = false; }
        };
        modal.querySelector('#closeCollector').onclick = () => this.closeModal(modal.id);
        modal.querySelector('#manageDeviceReporting').onclick = () => { this.closeModal(modal.id); this.showDeviceReportingModal(); };
        document.body.appendChild(modal); this.showModal(modal.id); await refresh();
      },

      async showDeviceReportingModal() {
        const workspaceId = this.data.currentWorkspaceId;
        const modal = document.createElement('div'); modal.id = 'deviceReportingModal'; modal.className = 'modal';
        modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'deviceReportingTitle');
        const card = document.createElement('div'); card.className = 'modal-content';
        const header = document.createElement('div'); header.className = 'modal-header';
        const heading = document.createElement('h3'); heading.id = 'deviceReportingTitle'; heading.textContent = 'Installed Windows reporting'; header.append(heading);
        const body = document.createElement('div'); body.className = 'modal-body';
        const note = document.createElement('p'); note.textContent = 'Inspect registered computers and revoke reporting access here. Refresh the app after a report to see new facts. Revoking access stops future reports but does not remove the Windows task or delete inventory. On the computer, run the installed Remove-ElistlyReporting.ps1 to remove its task and local credential.';
        const label = document.createElement('label'); label.textContent = 'Registered computer'; label.htmlFor = 'reportingDevice';
        const select = document.createElement('select'); select.id = 'reportingDevice';
        const devices = Object.values(this.data.entities || {}).filter(e => e._elistlyRegistration?.hardwareIdentity);
        devices.forEach(e => { const option = document.createElement('option'); option.value = e.id; option.textContent = e.hostname || e.name || e.serialNumber || e.id; select.append(option); });
        const snapshot = document.createElement('pre'); snapshot.style.whiteSpace = 'pre-wrap'; snapshot.style.overflowWrap = 'anywhere';
        const showSnapshot = () => { const e = this.data.entities[select.value]; snapshot.textContent = e ? JSON.stringify(e._elistlyRegistration, null, 2) : 'No registered computer in this workspace yet. Register it and refresh the app.'; };
        select.onchange = showSnapshot; showSnapshot();
        const details = document.createElement('details'); details.append(Object.assign(document.createElement('summary'), { textContent: 'Last collected facts (refresh app after a report)' }), snapshot);
        const records = document.createElement('div'); records.setAttribute('aria-live', 'polite');
        const refresh = async () => {
          let result;
          try { result = await apiRequest('/device-reporting/tokens'); }
          catch { records.textContent = 'Could not load reporting credentials. Close and reopen to retry.'; return; }
          records.replaceChildren();
          if (!result.ok) { records.textContent = result.data.error || 'Could not load reporting credentials.'; return; }
          const reportingRecords = (result.data.tokens || []).filter(record => record.workspace_id === workspaceId);
          if (!reportingRecords.length) records.textContent = 'No reporting credentials in this workspace yet.';
          for (const record of reportingRecords) {
            const row = document.createElement('p');
            const device = this.data.entities[record.device_id];
            row.textContent = `${device?.hostname || device?.name || record.device_id} — ${record.revoked_at ? 'Revoked' : 'Active'}${record.last_used_at ? `; last report ${new Date(record.last_used_at).toLocaleString()}` : '; not used yet'} `;
            if (!record.revoked_at) { const revoke = document.createElement('button'); revoke.type = 'button'; revoke.className = 'btn btn-danger btn-sm'; revoke.textContent = 'Revoke reporting'; revoke.onclick = () => this.showConfirmModal({ title: 'Revoke reporting?', message: 'This stops future reports from this credential. The Windows task and inventory remain. Other reporting credentials are unchanged.', confirmLabel: 'Revoke reporting', onConfirm: async () => {
              try {
                const response = await apiRequest(`/device-reporting/tokens/${encodeURIComponent(record.id)}`, { method: 'DELETE' });
                if (!response.ok) return this.showNotification(response.data.error || 'Could not revoke reporting.', 'error');
                await refresh();
              } catch { this.showNotification('Could not revoke reporting. Check your connection and try again.', 'error'); }
            } }); row.append(revoke); }
            records.append(row);
          }
        };
        const actions = document.createElement('div'); actions.className = 'modal-actions';
        const close = document.createElement('button'); close.className = 'btn btn-secondary'; close.textContent = 'Done'; close.onclick = () => this.closeModal(modal.id);
        body.append(note, label, select, details, records); actions.append(close); card.append(header, body, actions); modal.append(card); document.body.append(modal); this.showModal(modal.id); await refresh();
      },

      buildDeviceReportingInstaller(apiUrl, token, options = {}) {
        if (!/^https:\/\//i.test(apiUrl)) throw new Error('Scheduled reporting requires an HTTPS API base URL.');
        const day = options.day ?? 'Monday';
        const time = options.time ?? '09:00';
        const atLogon = options.atLogon !== false;
        if (!['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].includes(day) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Choose a valid reporting schedule.');
        const script = this.buildDeviceRegistrationScript(apiUrl, options.registrationToken ? '__ELISTLY_DEVICE_TOKEN__' : token, true);
        const enrollment = options.registrationToken ? `$enrollment = & {
${this.buildDeviceRegistrationScript(apiUrl, options.registrationToken, false, true)}
}
if ($enrollment.reportingToken -notmatch '^dp_[A-Za-z0-9_-]{32,}$') { throw 'Registration did not return a reporting credential. No task was installed.' }
` : '';
        const installer = `# Elistly scheduled inventory reporting. No self-updating code or policy changes.
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$taskName = 'Elistly Inventory Report'
$root = Join-Path $env:ProgramData 'Elistly'
$scriptPath = Join-Path $root 'Report-ElistlyDevice.ps1'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Open PowerShell as administrator to install or remove the task.' }
if ((Test-Path -LiteralPath $root) -and ((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Refusing an Elistly directory that is a link.' }
if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $taskName }
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while ((Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue).State -eq 'Running') { if ([DateTime]::UtcNow -gt $deadline) { throw 'Task is still stopping. Retry removal.' }; Start-Sleep -Milliseconds 250 }
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
  foreach ($name in @('Report-ElistlyDevice.ps1', 'last-result.json', 'Remove-ElistlyReporting.ps1')) { $p = Join-Path $root $name; if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force } }
  Write-Host 'Elistly task and local reporting credential removed. Revoke its credential in Elistly as well. Inventory records were not deleted.'
  return
}
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw 'Elistly reporting is already installed. Remove it with -Uninstall before installing a replacement.' }
[void][IO.Directory]::CreateDirectory($root)
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
  $identity = New-Object Security.Principal.SecurityIdentifier($sid)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
$acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
Set-Acl -LiteralPath $root -AclObject $acl
foreach ($name in @('Report-ElistlyDevice.ps1', 'last-result.json', 'Remove-ElistlyReporting.ps1')) { if (Test-Path -LiteralPath (Join-Path $root $name)) { throw 'Existing Elistly reporting files must be removed using -Uninstall first.' } }
${enrollment}$reportScript = @'
${script}
'@
${options.registrationToken ? "$reportScript = $reportScript.Replace('__ELISTLY_DEVICE_TOKEN__', $enrollment.reportingToken)" : ''}
[IO.File]::WriteAllText($scriptPath, $reportScript, (New-Object Text.UTF8Encoding($true)))
$exe = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$action = New-ScheduledTaskAction -Execute $exe -Argument ('-NoProfile -NonInteractive -File "' + $scriptPath + '"')
$weekly = New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${day} -At '${time}'
${atLogon ? "$logon = New-ScheduledTaskTrigger -AtLogOn\n$logon.Delay = 'PT1M'" : ''}
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$runAs = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
try {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($weekly${atLogon ? ', $logon' : ''}) -Settings $settings -Principal $runAs -Description 'Reports this computer inventory to Elistly weekly${atLogon ? ' and after sign-in' : ''}. No remote code updates.' -ErrorAction Stop | Out-Null
} catch { Remove-Item -LiteralPath $scriptPath -Force; throw }
Start-ScheduledTask -TaskName $taskName
Write-Host 'Installed Elistly Inventory Report and started its first run. Weekly ${day} ${time}${atLogon ? ' and after sign-in' : ''}; missed runs catch up.'
Write-Host 'Check Task Scheduler or, in this administrator window: Get-Content "$env:ProgramData\\Elistly\\last-result.json"'
Write-Host 'Delete this downloaded installer after installation: it contains ${options.registrationToken ? 'a workspace enrollment secret' : 'a device-scoped credential'}.'
Write-Host 'Remove using: & "$env:ProgramData\\Elistly\\Remove-ElistlyReporting.ps1"'
`;
        const removal = installer.slice(0, installer.indexOf('if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw')).replace('param([switch]$Uninstall)', '$Uninstall = $true');
        return installer.replace('[IO.File]::WriteAllText($scriptPath,', `[IO.File]::WriteAllText((Join-Path $root 'Remove-ElistlyReporting.ps1'), @'
${removal}
'@, (New-Object Text.UTF8Encoding($true)))
[IO.File]::WriteAllText($scriptPath,`);
      },

      buildDeviceCollectorScript(apiUrl, token, options = {}) {
        if (!/^https:\/\//i.test(apiUrl)) throw new Error('Windows collection requires an HTTPS API base URL.');
        if (!options.automaticReporting) return this.buildDeviceRegistrationScript(apiUrl, token);
        return this.buildDeviceReportingInstaller(apiUrl, '', { ...options, registrationToken: token });
      },

      buildDeviceRegistrationScript(apiUrl, token, reporting = false, returnResponse = false) {
        const ps = value => `'${String(value).replace(/'/g, "''")}'`;
        const lines = [
          reporting ? '# Elistly device-scoped inventory report. Installed locally; no self-updates or security-setting changes.' : '# Elistly one-time Windows device registration. This script has no persistence, scheduler, self-update, or security-setting changes.',
          `param([string]$RegistrationToken = ${ps(token)}, [switch]$Preview)`,
          "$ErrorActionPreference = 'Stop'",
          "if (-not $RegistrationToken) { throw 'RegistrationToken is required.' }",
          "function Test-ElistlyStableIdentifier([string]$Value) {",
          "  $normalized = if ($null -eq $Value) { '' } else { $Value.Trim() }",
          "  return [bool]($normalized -and $normalized -notmatch '^(?i:(to be filled by o\\.?e\\.?m\\.?|default string|none|unknown|system serial number|0+|f+))$')",
          "}",
          "function Get-ElistlyCim([string]$ClassName, [string]$Namespace = 'root/cimv2', [string]$Filter) {",
          "  try { if ($Filter) { Get-CimInstance -Namespace $Namespace -ClassName $ClassName -Filter $Filter -ErrorAction Stop } else { Get-CimInstance -Namespace $Namespace -ClassName $ClassName -ErrorAction Stop } } catch { $null }",
          "}",
          "function Get-ElistlyFirstCim([string]$ClassName, [string]$Namespace = 'root/cimv2', [string]$Filter) { Get-ElistlyCim $ClassName $Namespace $Filter | Select-Object -First 1 }",
          "function Get-ElistlyIsoDate($Value) { try { if ($null -eq $Value) { return $null }; if ($Value -is [datetime]) { return ([datetime]$Value).ToUniversalTime().ToString('o') }; [System.Management.ManagementDateTimeConverter]::ToDateTime([string]$Value).ToUniversalTime().ToString('o') } catch { $null } }",
          "$collectedAt = [DateTime]::UtcNow.ToString('o')",
          "$availability = [ordered]@{ tpm = $null; secureBoot = $null; bitLocker = $null; battery = $null; networkAdapters = $null; lastInteractiveUser = $null }",
          "$bios = Get-ElistlyFirstCim 'Win32_BIOS'; $product = Get-ElistlyFirstCim 'Win32_ComputerSystemProduct'; $computer = Get-ElistlyFirstCim 'Win32_ComputerSystem'; $os = Get-ElistlyFirstCim 'Win32_OperatingSystem'; $cpu = Get-ElistlyFirstCim 'Win32_Processor'",
          "$serialNumber = if ($bios) { [string]$bios.SerialNumber } else { $null }; $biosUuid = if ($product) { [string]$product.UUID } else { $null }",
          "if (-not (Test-ElistlyStableIdentifier $serialNumber) -or -not (Test-ElistlyStableIdentifier $biosUuid)) { throw 'A non-generic BIOS serial number and BIOS UUID are required for stable registration.' }",
          "$identityMaterial = \"$biosUuid|$serialNumber\"; $hardwareIdentity = ([System.BitConverter]::ToString(([System.Security.Cryptography.SHA256]::Create()).ComputeHash([System.Text.Encoding]::UTF8.GetBytes($identityMaterial)))).Replace('-', '').ToLowerInvariant()",
          "$disks = @(Get-ElistlyCim 'Win32_LogicalDisk' 'root/cimv2' 'DriveType = 3' | Select-Object -First 32 | ForEach-Object { [ordered]@{ capacityBytes = if ($_.Size -ne $null) { [uint64]$_.Size } else { $null }; freeBytes = if ($_.FreeSpace -ne $null) { [uint64]$_.FreeSpace } else { $null } } })",
          "$networkAdapters = @(); try { $networkAdapters = @(Get-NetAdapter -Physical -ErrorAction Stop | Where-Object { $_.Status -eq 'Up' -and $_.MacAddress } | Select-Object -First 32 | ForEach-Object { $adapter = $_; $addresses = @(Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4,IPv6 -ErrorAction Stop | Where-Object { $_.IPAddress -and $_.IPAddress -notin @('127.0.0.1', '::1') } | Select-Object -First 16); [ordered]@{ name = [string]$adapter.Name; macAddress = [string]$adapter.MacAddress; ipv4Addresses = @($addresses | Where-Object AddressFamily -eq 'IPv4' | Select-Object -First 8 -ExpandProperty IPAddress); ipv6Addresses = @($addresses | Where-Object AddressFamily -eq 'IPv6' | Select-Object -First 8 -ExpandProperty IPAddress) } }) } catch { $availability.networkAdapters = 'Unavailable: local network adapter query is not permitted or supported.' }",
          "$tpm = [ordered]@{ present = $null; version = $null; ready = $null }; try { $tpmInfo = Get-Tpm -ErrorAction Stop; $tpm.present = [bool]$tpmInfo.TpmPresent; $tpm.ready = [bool]$tpmInfo.TpmReady; $tpmCim = Get-ElistlyFirstCim 'Win32_Tpm' 'root/cimv2/security/microsofttpm'; $tpm.version = if ($tpmCim -and $tpmCim.SpecVersion) { [string]$tpmCim.SpecVersion } else { $null } } catch { $availability.tpm = 'Unavailable: TPM query is not permitted or supported.' }",
          "$secureBoot = $null; try { $secureBoot = [bool](Confirm-SecureBootUEFI -ErrorAction Stop) } catch { $availability.secureBoot = 'Unavailable: Secure Boot query is not permitted or supported.' }",
          "$bitLocker = $null; try { $bitLocker = [string](Get-BitLockerVolume -MountPoint $env:SystemDrive -ErrorAction Stop | Select-Object -ExpandProperty ProtectionStatus); if (-not $bitLocker) { $bitLocker = $null } } catch { $availability.bitLocker = 'Unavailable: BitLocker query is not permitted or supported.' }",
          "$battery = [ordered]@{ designCapacityMWh = $null; fullChargeCapacityMWh = $null; healthPercent = $null }; try { $staticBattery = Get-ElistlyFirstCim 'BatteryStaticData' 'root/wmi'; $fullBattery = Get-ElistlyFirstCim 'BatteryFullChargedCapacity' 'root/wmi'; if ($staticBattery -and $staticBattery.DesignedCapacity) { $battery.designCapacityMWh = [uint64]$staticBattery.DesignedCapacity }; if ($fullBattery -and $fullBattery.FullChargedCapacity) { $battery.fullChargeCapacityMWh = [uint64]$fullBattery.FullChargedCapacity }; if ($battery.designCapacityMWh -and $battery.fullChargeCapacityMWh) { $battery.healthPercent = [Math]::Round((100 * $battery.fullChargeCapacityMWh) / $battery.designCapacityMWh) } } catch { $availability.battery = 'Unavailable: battery query is not permitted or supported.' }",
          "$lastBootAt = if ($os) { Get-ElistlyIsoDate $os.LastBootUpTime } else { $null }; $uptimeSeconds = if ($lastBootAt) { [Math]::Max(0, [Math]::Floor(([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse($lastBootAt)).TotalSeconds)) } else { $null }",
          "$displayRelease = $null; try { $displayRelease = (Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion' -Name DisplayVersion -ErrorAction Stop).DisplayVersion } catch { $null }",
          "$interactiveUser = if ($computer -and $computer.UserName -and [string]$computer.UserName -notmatch '(?i)^(NT AUTHORITY\\\\SYSTEM|SYSTEM)$') { [string]$computer.UserName } else { $null }; if (-not $interactiveUser) { $availability.lastInteractiveUser = 'Unavailable: no interactive user was observed.' }; $lastInteractiveUser = [ordered]@{ username = $interactiveUser; time = if ($interactiveUser) { $collectedAt } else { $null }; source = 'Win32_ComputerSystem.UserName'; observation = 'current interactive session' }",
          "$inventorySnapshot = [ordered]@{ schemaVersion = 'elistly.windows-device-registration.v1'; collectedAt = $collectedAt; device = [ordered]@{ manufacturer = if ($computer) { [string]$computer.Manufacturer } else { $null }; model = if ($computer) { [string]$computer.Model } else { $null }; serialNumber = $serialNumber; uuid = $biosUuid }; windows = [ordered]@{ edition = if ($os) { [string]$os.Caption } else { $null }; version = if ($os) { [string]$os.Version } else { $null }; build = if ($os) { [string]$os.BuildNumber } else { $null }; displayRelease = if ($displayRelease) { [string]$displayRelease } else { $null }; installDate = if ($os) { Get-ElistlyIsoDate $os.InstallDate } else { $null } }; cpu = [ordered]@{ model = if ($cpu) { [string]$cpu.Name } else { $null }; cores = if ($cpu -and $cpu.NumberOfCores -ne $null) { [int]$cpu.NumberOfCores } else { $null }; logicalProcessors = if ($cpu -and $cpu.NumberOfLogicalProcessors -ne $null) { [int]$cpu.NumberOfLogicalProcessors } else { $null } }; ramBytes = if ($computer -and $computer.TotalPhysicalMemory -ne $null) { [uint64]$computer.TotalPhysicalMemory } else { $null }; graphicsAdapters = @(Get-ElistlyCim 'Win32_VideoController' | ForEach-Object { if ($_.Name) { ([string]$_.Name).Trim() } } | Select-Object -Unique | Select-Object -First 8); fixedDisks = $disks; networkAdapters = $networkAdapters; biosVersion = if ($bios) { [string]$bios.SMBIOSBIOSVersion } else { $null }; tpm = $tpm; secureBoot = $secureBoot; bitLockerProtectionStatus = $bitLocker; battery = $battery; lastBootAt = $lastBootAt; uptimeSeconds = $uptimeSeconds; lastInteractiveUser = $lastInteractiveUser; availability = $availability }",
          "$payload = [ordered]@{ hardwareIdentity = $hardwareIdentity; hostname = $env:COMPUTERNAME; serialNumber = $serialNumber; manufacturer = $inventorySnapshot.device.manufacturer; model = $inventorySnapshot.device.model; windowsEdition = $inventorySnapshot.windows.edition; inventorySnapshot = $inventorySnapshot }",
          "if ($Preview) { Write-Output ($payload | ConvertTo-Json -Depth 8); Write-Host 'Preview only: no data was transmitted.'; return }",
          "$body = $payload | ConvertTo-Json -Depth 8 -Compress",
          `if ([System.Text.Encoding]::UTF8.GetByteCount($body) -gt 65536) { throw 'Registration payload exceeds 64KB.' }`,
          `$utf8Body = [System.Text.Encoding]::UTF8.GetBytes($body); $response = Invoke-RestMethod -TimeoutSec 45 -Method Post -Uri ${ps(`${apiUrl}${reporting ? '/device-reporting/report' : '/device-registration/register'}`)} -Headers @{ Authorization = \"Bearer $RegistrationToken\"; 'Content-Type' = 'application/json; charset=utf-8' } -ContentType 'application/json; charset=utf-8' -Body $utf8Body`,
          "if ($response.created) { Write-Host \"Registered Elistly device $($response.deviceId)\" } else { Write-Host \"Elistly device already registered: $($response.deviceId). Existing registration was not changed.\" }"
        ];
        if (returnResponse) lines.push('Write-Output $response');
        if (reporting) {
          lines[lines.length - 1] = "[ordered]@{ success = $true; completedAt = [DateTime]::UtcNow.ToString('o'); deviceId = $response.deviceId } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'last-result.json') -Encoding UTF8";
          lines.splice(4, 0, 'try {');
          lines.push("} catch { [ordered]@{ success = $false; completedAt = [DateTime]::UtcNow.ToString('o'); message = 'Report failed. Check network, device credential and Task Scheduler result; no security policy was changed.' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'last-result.json') -Encoding UTF8; exit 1 }");
        }
        return lines.join('\n');
      },

      renderDeviceRegistrationTokens(container, records, refresh) {
        container.replaceChildren();
        if (!records.length) return container.appendChild(Object.assign(document.createElement('p'), { className: 'help-text', textContent: 'No registration scripts have been created for this account.' }));
        const list = document.createElement('ul'); list.className = 'device-registration-token-list';
        records.forEach(record => {
          const item = document.createElement('li');
          const status = record.revoked_at ? 'Revoked' : record.expires_at && new Date(record.expires_at) <= new Date() ? 'Expired' : 'Active';
          const summary = document.createElement('span'); summary.textContent = `${record.label || record.workspace_id} — ${status}; ${record.expires_at ? `expires ${new Date(record.expires_at).toLocaleString()}` : 'no automatic expiry'}${record.last_used_at ? `; last used ${new Date(record.last_used_at).toLocaleString()}` : ''}`;
          item.appendChild(summary);
          if (!record.revoked_at && status === 'Active') {
            const revoke = document.createElement('button'); revoke.className = 'btn btn-danger btn-sm'; revoke.type = 'button'; revoke.textContent = 'Revoke';
            revoke.onclick = () => this.showConfirmModal({ title: 'Revoke collector?', message: 'This download will no longer register computers or enroll reporting. Already installed reporting and inventory remain unchanged.', confirmLabel: 'Revoke collector', onConfirm: async () => {
              try {
                const result = await apiRequest(`/device-registration/tokens/${encodeURIComponent(record.id)}`, { method: 'DELETE' });
                if (!result.ok) return this.showNotification(result.data.error || 'Could not revoke collector.', 'error');
                await refresh();
              } catch { this.showNotification('Could not revoke collector. Check your connection and try again.', 'error'); }
            } });
            item.appendChild(revoke);
          }
          list.appendChild(item);
        });
        container.appendChild(list);
      },

      switchWorkspace(workspaceId) {
        if (workspaceId === this.data.currentWorkspaceId) return;
        this.saveData();
        const w = this.data.workspaces && this.data.workspaces[workspaceId];
        if (!w) return;
        this.data.currentWorkspaceId = workspaceId;
        this.data.categories = { ...(w.categories || {}) };
        this.data.entityTypes = { ...(w.entityTypes || {}) };
        this.data.entities = { ...(w.entities || {}) };
        this.normalizeActivationState();
        this.saveData();
        this.renderSidebar();
        this.loadView('dashboard');
        if (!this._switchWorkspaceSilent) this.showNotification(`Switched to "${this.getCurrentWorkspaceName()}"`, 'success');
        this._switchWorkspaceSilent = false;
      },

      showAddInventoryPresetModal() {
        const presetIcons = { blank: 'add_circle_outline', library: 'menu_book', it: 'devices', staff: 'group', property: 'apartment' };
        const presets = SETUP_IDS.map(id => PRESETS[id]).filter(Boolean);
        const html = `
          <div class="modal onboarding-modal" id="addInventoryPresetModal">
            <div class="modal-content">
              <button class="modal-close" onclick="App.closeModal('addInventoryPresetModal')"><span class="material-icons">close</span></button>
              <div class="modal-header">
                <h3>New inventory</h3>
              </div>
              <p class="onboarding-intro">Choose a setup for this inventory. You can change or remove anything later.</p>
              <div class="onboarding-options">
                ${presets.map(p => `
                  <button type="button" class="onboarding-option" onclick="App.applyPresetToNewWorkspace('${p.id}'); App.closeModal('addInventoryPresetModal');">
                    <span class="onboarding-option-icon"><span class="material-icons">${presetIcons[p.id] || 'folder'}</span></span>
                    <div class="onboarding-option-body">
                      <div class="onboarding-option-title">${p.label}</div>
                      <p class="onboarding-option-desc">${p.description}</p>
                    </div>
                  </button>
                `).join('')}
              </div>
            </div>
          </div>`;
        const existing = document.getElementById('addInventoryPresetModal');
        if (existing) existing.remove();
        const div = document.createElement('div');
        div.innerHTML = html;
        document.body.appendChild(div.firstElementChild);
        this.showModal('addInventoryPresetModal');
      },

      applyPresetToNewWorkspace(presetId) {
        const preset = PRESETS[presetId];
        if (!preset) return;
        const id = 'id-' + Math.random().toString(36).substring(2, 9);
        const names = Object.values(this.data.workspaces || {}).map(w => w.name);
        let name = preset.label || 'Inventory';
        for (let n = 2; names.includes(name); n++) name = `${preset.label || 'Inventory'} ${n}`;
        const entityTypes = JSON.parse(JSON.stringify(preset.entityTypes || {}));
        Object.values(entityTypes).forEach(t => {
          if (t.category && !Array.isArray(t.categories)) t.categories = [t.category];
          t.presetIds = [presetId];
          t.enabled = true;
        });
        const categories = JSON.parse(JSON.stringify(preset.categories || {}));
        Object.values(categories).forEach(category => {
          category.presetIds = [presetId];
          category.enabled = true;
        });
        this.data.workspaces[id] = {
          name,
          categories,
          entityTypes,
          entities: {}
        };
        this._switchWorkspaceSilent = true;
        this.switchWorkspace(id);
        this.showNotification(`Created "${name}"`, 'success');
        const samples = (window.SAMPLE_ENTITIES || {})[presetId];
        if (samples && samples.order && samples.order.some(t => Array.isArray(samples[t]) && samples[t].length > 0)) {
          setTimeout(() => this.showSampleDataPrompt(presetId), 300);
        }
      },

      addWorkspace() {
        this.showAddInventoryPresetModal();
      },

      showRenameWorkspaceModal() {
        const cid = this.data.currentWorkspaceId;
        const w = this.data.workspaces && this.data.workspaces[cid];
        const currentName = (w && w.name) || 'Inventory';
        const html = `
          <div class="modal" id="renameWorkspaceModal">
            <div class="modal-content modal-content-compact">
              <button class="modal-close" onclick="App.closeModal('renameWorkspaceModal')"><span class="material-icons">close</span></button>
              <div class="modal-header"><h3>Rename inventory</h3></div>
              <div class="modal-body">
                <div class="form-group">
                  <label for="renameWorkspaceInput">Name</label>
                  <input type="text" id="renameWorkspaceInput" class="profile-input" value="${this.escapeHtmlText(currentName)}" placeholder="e.g. Business A">
                </div>
              </div>
              <div class="modal-actions">
                <button type="button" class="btn btn-secondary" onclick="App.closeModal('renameWorkspaceModal')">Cancel</button>
                <button type="button" class="btn btn-primary" onclick="App.renameCurrentWorkspace()">Save</button>
              </div>
            </div>
          </div>`;
        const div = document.createElement('div');
        div.innerHTML = html;
        document.body.appendChild(div.firstElementChild);
        this.showModal('renameWorkspaceModal');
        const input = document.getElementById('renameWorkspaceInput');
        if (input) { input.focus(); input.select(); }
      },

      renameCurrentWorkspace() {
        const input = document.getElementById('renameWorkspaceInput');
        const name = (input && input.value && input.value.trim()) ? input.value.trim() : '';
        if (!name) return;
        const cid = this.data.currentWorkspaceId;
        if (this.data.workspaces && this.data.workspaces[cid]) {
          this.data.workspaces[cid].name = name;
          this.saveData();
          this.closeModal('renameWorkspaceModal');
          this.renderSidebar();
          this.showNotification('Inventory renamed', 'success');
        }
      },

      renderSidebar() {
        const categoryList = document.getElementById('categoryList');
        const workspaceWrap = document.getElementById('workspaceSwitcherWrap');
        if (!categoryList) return;
        
        if (workspaceWrap && this.data.workspaces && this.data.currentWorkspaceId) {
          const currentName = this.getCurrentWorkspaceName();
          const workspaces = Object.entries(this.data.workspaces).map(([id, w]) => ({ id, name: w.name || id }));
          workspaceWrap.innerHTML = `
            <div class="workspace-switcher" role="group" aria-label="Inventory">
              <button type="button" class="workspace-switcher-btn" id="workspaceSwitcherBtn" aria-haspopup="true" aria-expanded="false">
                <span class="material-icons">inventory_2</span>
                <span class="workspace-switcher-label">${this.escapeHtmlText(currentName)}</span>
                <span class="material-icons workspace-switcher-chevron">expand_more</span>
              </button>
              <div class="workspace-switcher-dropdown" id="workspaceSwitcherDropdown" hidden>
                ${workspaces.map(w => `
                  <button type="button" class="workspace-switcher-option ${w.id === this.data.currentWorkspaceId ? 'active' : ''}" data-workspace-id="${this.escapeHtmlText(w.id)}">
                    ${this.escapeHtmlText(w.name || w.id)}
                  </button>
                `).join('')}
                <button type="button" class="workspace-switcher-option workspace-switcher-add" id="workspaceAddBtn">
                  <span class="material-icons">add</span> Add inventory
                </button>
              </div>
            </div>`;
          workspaceWrap.style.display = '';
          const btn = document.getElementById('workspaceSwitcherBtn');
          const dropdown = document.getElementById('workspaceSwitcherDropdown');
          const close = () => { if (dropdown) dropdown.hidden = true; if (btn) btn.setAttribute('aria-expanded', 'false'); };
          if (btn && dropdown) {
            btn.onclick = () => {
              const open = dropdown.hidden;
              dropdown.hidden = !open;
              btn.setAttribute('aria-expanded', open ? 'true' : 'false');
            };
            dropdown.querySelectorAll('.workspace-switcher-option[data-workspace-id]').forEach(opt => {
              opt.onclick = () => { this.switchWorkspace(opt.dataset.workspaceId); close(); };
            });
            const addBtn = document.getElementById('workspaceAddBtn');
            if (addBtn) addBtn.onclick = () => { this.addWorkspace(); close(); };
          }
        } else if (workspaceWrap) {
          workspaceWrap.innerHTML = '';
          workspaceWrap.style.display = 'none';
        }
        
        // Get current URL parameters
        const url = new URL(window.location);
        const currentView = url.searchParams.get('view') || 'dashboard';
        const currentCategory = url.searchParams.get('category');
        
        const showDueView = this.hasDueDateTypes();
        const dashboardHtml = `
          <li>
            <a href="#" class="${currentView === 'dashboard' ? 'active' : ''}" 
               onclick="App.loadView('dashboard'); return false;">
              <span class="material-icons">dashboard</span>
              Dashboard
            </a>
          </li>
          ${showDueView ? `
            <li>
              <a href="#" class="${currentView === 'overdue' ? 'active' : ''}" 
                 onclick="App.loadView('overdue'); return false;">
                <span class="material-icons">event_busy</span>
                Due & overdue
              </a>
            </li>
          ` : ''}
        `;
        
        const categoriesHtml = this.getEnabledCategories()
          .map(category => `
            <li>
              <a href="#" class="${currentCategory === category.id ? 'active' : ''}"
                 ${this.viewActionAttribute(category.id)}>
                <span class="material-icons">${this.escapeHtmlText(category.icon)}</span>
                ${this.escapeHtmlText(category.label)}
              </a>
            </li>
          `).join('');
        
        categoryList.innerHTML = dashboardHtml + categoriesHtml;
      },
      
      loadView(view) {
        this.closeSidebar();
        if (view === 'admin') {
          if (!this.data.isAdmin) {
            this.loadView('dashboard');
            return;
          }
          this.updateURL({ view: 'admin', category: null });
          const mainContent = document.getElementById('mainContent');
          if (mainContent) this.renderAdminPage();
          this.ensureMainContentScrollable();
          this.renderSidebar();
          return;
        }
        if (view === 'overdue' && !this.hasDueDateTypes()) view = 'dashboard';
        if (this.data.categories?.[view]?.enabled === false) view = 'dashboard';
        this.updateURL({ view: view === 'dashboard' ? null : view, category: view === 'dashboard' ? null : view });
        const mainContent = document.getElementById('mainContent');
        if (!mainContent) return;
        if (view === 'dashboard') {
          this._advancedFilterCategoryId = null;
          this.renderDashboard();
        } else if (view === 'overdue') {
          this._advancedFilterCategoryId = null;
          this.renderOverdueView();
        } else {
          this.renderCategoryView(view);
        }
        this.ensureMainContentScrollable();
        this.renderSidebar();
      },

      hasDueDateTypes() {
        return this.getEnabledEntityTypes().some(type =>
          Array.isArray(type.fields) && type.fields.some(f => f.type === 'date' && /due/i.test(f.name))
        );
      },

      getDueDateFieldName(entityType) {
        const type = this.data.entityTypes[entityType];
        if (!type || !type.fields) return null;
        const dueField = type.fields.find(f => f.type === 'date' && /due/i.test(f.name));
        return dueField ? dueField.name : null;
      },

      getOverdueEntities() {
        const today = new Date().toISOString().slice(0, 10);
        return Object.values(this.data.entities).filter(entity => {
          if (!this.isEntityTypeAvailable(entity.type)) return false;
          const dueField = this.getDueDateFieldName(entity.type);
          if (!dueField || !entity[dueField]) return false;
          return entity[dueField] < today;
        }).sort((a, b) => {
          const dueA = a[this.getDueDateFieldName(a.type)] || '';
          const dueB = b[this.getDueDateFieldName(b.type)] || '';
          return dueA.localeCompare(dueB);
        });
      },

      getDueSoonEntities() {
        const today = new Date();
        const in7 = new Date(today);
        in7.setDate(in7.getDate() + 7);
        const todayStr = today.toISOString().slice(0, 10);
        const in7Str = in7.toISOString().slice(0, 10);
        return Object.values(this.data.entities).filter(entity => {
          if (!this.isEntityTypeAvailable(entity.type)) return false;
          const dueField = this.getDueDateFieldName(entity.type);
          if (!dueField || !entity[dueField]) return false;
          const d = entity[dueField];
          return d >= todayStr && d <= in7Str;
        }).sort((a, b) => {
          const dueA = a[this.getDueDateFieldName(a.type)] || '';
          const dueB = b[this.getDueDateFieldName(b.type)] || '';
          return dueA.localeCompare(dueB);
        });
      },

      renderOverdueView() {
        const mainContent = document.getElementById('mainContent');
        if (!mainContent) return;
        const overdue = this.getOverdueEntities();
        const dueSoon = this.getDueSoonEntities();
        const formatDate = (d) => d ? new Date(d + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : '';
        const dueField = (e) => this.getDueDateFieldName(e.type);
        const renderRow = (entity) => {
          const type = this.data.entityTypes[entity.type];
          const dueVal = entity[dueField(entity)];
          let lentToName = '';
          if (type && type.associations) {
            const linkAssoc = type.associations.find(a => entity[a.name]);
            if (linkAssoc) lentToName = this.getEntityDisplayName(entity[linkAssoc.name]);
          }
          return `
            <div class="entity-list-item">
              <div class="entity-info">
                <span class="material-icons">${this.escapeHtmlText(type?.icon || 'folder')}</span>
                <div>
                  <div>${this.escapeHtmlText(this.getEntityCardTitle(entity))}</div>
                  ${lentToName ? `<div class="mini-field-desc">${this.escapeHtmlText(lentToName)} · Due ${formatDate(dueVal)}</div>` : `<div class="mini-field-desc">Due ${formatDate(dueVal)}</div>`}
                </div>
              </div>
              <div class="entity-actions">
                <button class="btn btn-secondary" ${this.entityFormActionAttribute(entity)}>
                  <span class="material-icons">edit</span>
                </button>
              </div>
            </div>`;
        };
        const html = `
          <div class="category-view">
            <div class="card">
              <div class="card-header">
                <h2><span class="material-icons">event_busy</span> Due & overdue</h2>
              </div>
              ${overdue.length > 0 ? `
                <h3 class="overdue-section-title"><span class="material-icons text-danger">warning</span> Overdue</h3>
                <div class="entity-list">${overdue.map(e => renderRow(e)).join('')}</div>
              ` : ''}
              ${dueSoon.length > 0 ? `
                <h3 class="overdue-section-title"><span class="material-icons text-warning">schedule</span> Due in the next 7 days</h3>
                <div class="entity-list">${dueSoon.map(e => renderRow(e)).join('')}</div>
              ` : ''}
              ${overdue.length === 0 && dueSoon.length === 0 ? `
                <p class="empty-state">Nothing overdue or due soon. Items with a due date will appear here.</p>
              ` : ''}
            </div>
          </div>`;
        mainContent.innerHTML = html;
        this.ensureMainContentScrollable();
      },

      /** Admin page: list accounts and delete. Requires this.data.isAdmin and apiUrl. */
      async renderAdminPage() {
        const mainContent = document.getElementById('mainContent');
        if (!mainContent) return;
        const apiUrl = typeof window !== 'undefined' && window.ELISTLY_API_URL;
        if (!apiUrl || !apiUrl.trim()) {
          mainContent.innerHTML = `
            <div class="card">
              <div class="card-header"><h2><span class="material-icons">admin_panel_settings</span> Admin</h2></div>
              <p class="empty-state">API URL is not configured. Set <code>ELISTLY_API_URL</code> in config (or in Cloudflare Pages env) to use admin features.</p>
            </div>`;
          return;
        }
        const { data: { session } } = await backendClient.auth.getSession();
        const token = session && session.access_token;
        if (!token) {
          mainContent.innerHTML = `
            <div class="card">
              <div class="card-header"><h2><span class="material-icons">admin_panel_settings</span> Admin</h2></div>
              <p class="empty-state">Not signed in.</p>
            </div>`;
          return;
        }
        mainContent.innerHTML = `
          <div class="card">
            <div class="card-header">
              <h2><span class="material-icons">admin_panel_settings</span> Admin – Accounts</h2>
              <button type="button" class="btn btn-secondary" onclick="App.loadView('admin')">
                <span class="material-icons">refresh</span> Refresh
              </button>
            </div>
            <div class="card-body">
              <p class="profile-help u-mb-100">List of user accounts. Deleting an account removes their auth user and app data permanently.</p>
              <div id="adminUsersList"><p class="empty-state">Loading…</p></div>
            </div>
          </div>`;
        const base = apiUrl.replace(/\/$/, '');
        try {
          const r = await fetch(`${base}/admin/users`, { headers: { Authorization: `Bearer ${token}` } });
          const body = await r.json();
          const listEl = document.getElementById('adminUsersList');
          if (!listEl) return;
          if (!r.ok) {
            listEl.innerHTML = `<p class="empty-state text-danger">${this.escapeHtmlText(body.error || 'Failed to load users')}</p>`;
            return;
          }
          const users = body.users || [];
          if (users.length === 0) {
            listEl.innerHTML = '<p class="empty-state">No accounts yet.</p>';
            return;
          }
          const formatDate = (s) => s ? new Date(s).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—';
          listEl.innerHTML = `
            <div class="admin-users-table-wrap">
              <table class="admin-users-table">
                <thead>
                  <tr><th>Email</th><th>User ID</th><th>Created</th><th></th></tr>
                </thead>
                <tbody>
                  ${users.map(u => `
                    <tr>
                      <td>${this.escapeHtmlText(u.email || '—')}</td>
                      <td><code class="admin-user-id">${this.escapeHtmlText((u.id || '').slice(0, 8))}…</code></td>
                      <td>${formatDate(u.created_at)}</td>
                      <td>
                        <button type="button" class="btn btn-danger btn-sm" data-user-id="${this.escapeHtmlText(u.id)}" data-admin-delete>Delete</button>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>`;
          listEl.querySelectorAll('[data-admin-delete]').forEach(btn => {
            btn.addEventListener('click', () => this.confirmAdminDeleteUser(btn.dataset.userId));
          });
        } catch (e) {
          const listEl = document.getElementById('adminUsersList');
          if (listEl) listEl.innerHTML = `<p class="empty-state text-danger">${this.escapeHtmlText(e.message || 'Request failed')}</p>`;
        }
      },

      async confirmAdminDeleteUser(userId) {
        if (!userId) return;
        const apiUrl = typeof window !== 'undefined' && window.ELISTLY_API_URL;
        if (!apiUrl || !apiUrl.trim()) return;
        const { data: { session } } = await backendClient.auth.getSession();
        const token = session && session.access_token;
        if (!token) return;
        this.showConfirmModal({
          title: 'Delete this account?',
          message: 'This will permanently remove the user and all their data. This cannot be undone.',
          confirmLabel: 'Delete account',
          confirmVariant: 'danger',
          onConfirm: async () => {
            const base = apiUrl.replace(/\/$/, '');
            const res = await fetch(`${base}/admin/users/${userId}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${token}` }
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
              this.showSnackbar(body.error || 'Failed to delete user', true);
              return;
            }
            this.showSnackbar('Account deleted.');
            this.renderAdminPage();
          }
        });
      },

      getItemsPerCategoryLimit() {
        const raw = this.data.settings.dashboard?.itemsPerCategory;
        if (raw === undefined || raw === null || raw === -1) return -1;
        const n = parseInt(raw, 10);
        return Number.isFinite(n) && n >= 1 ? Math.min(n, 100) : -1;
      },

      renderDashboard() {
        const mainContent = document.getElementById('mainContent');
        if (!mainContent) return;

        const settings = this.data.settings.dashboard || {};
        const viewMode = settings.viewMode || 'categoryCards';
        const groupByCategory = settings.groupByCategory !== false; // Default to true
        const itemsLimit = this.getItemsPerCategoryLimit();

        // Get all entities and sort them (guard against missing name/autoName)
        let allEntities = Object.values(this.data.entities)
          .filter(entity => this.isEntityTypeAvailable(entity.type))
          .sort((a, b) => this.getEntityDisplayName(a).localeCompare(this.getEntityDisplayName(b)));

        // Visible categories (used by gallery and category cards)
        let visibleCategories = this.getEnabledCategories()
          .filter(cat => cat.visibleInDashboard !== false);
        if (Array.isArray(settings.categoryOrder)) {
          const ordered = [];
          settings.categoryOrder.forEach(id => {
            const cat = visibleCategories.find(c => c.id === id);
            if (cat) ordered.push(cat);
          });
          visibleCategories.forEach(c => {
            if (!settings.categoryOrder.includes(c.id)) ordered.push(c);
          });
          visibleCategories = ordered;
        }

        // Handle different view modes
        if (viewMode === 'gallery') {
          if (groupByCategory) {
            let html = '';
            visibleCategories.forEach(category => {
              let categoryEntities = allEntities.filter(
                entity => this.getEntityTypeCategoryIds(this.data.entityTypes[entity.type]).includes(category.id)
              );
              if (itemsLimit >= 1) categoryEntities = categoryEntities.slice(0, itemsLimit);
              const emptyState = '<p class="empty-state">No items yet</p>';
              html += `
                <section class="icon-group">
                  <h3><span class="material-icons">${this.escapeHtmlText(category.icon)}</span> ${this.escapeHtmlText(category.label)}</h3>
                  <div class="gallery-cards">
                    ${categoryEntities.length > 0
                      ? categoryEntities.map(entity => this.renderEntityMiniCard(entity)).join('')
                      : emptyState}
                  </div>
                </section>
              `;
            });
            if (visibleCategories.length === 0) {
              html = '<div class="card empty-dashboard-card"><div class="card-header"><h2>Dashboard</h2></div><p class="empty-dashboard-message">No categories yet. Add a preset or create categories in Settings.</p><div class="empty-dashboard-actions"><button type="button" class="btn btn-primary" onclick="App.showSettingsModal()"><span class="material-icons">settings</span> Settings</button></div></div>';
            }
            mainContent.innerHTML = html;
          } else {
            const letterGroups = allEntities.reduce((acc, entity) => {
              const name = this.getEntityCardTitle(entity);
              const letter = name.charAt(0).toUpperCase() || '#';
              (acc[letter] = acc[letter] || []).push(entity);
              return acc;
            }, {});
            const letters = Object.keys(letterGroups).sort();
            let html = letters.length > 0 ? '' : '<div class="card empty-dashboard-card"><div class="card-header"><h2>Dashboard</h2></div><p class="empty-dashboard-message">No items yet. Add items from the sidebar or Settings.</p></div>';
            letters.forEach(letter => {
              html += `
                <section class="icon-group">
                  <h3>${this.escapeHtmlText(letter)}</h3>
                  <div class="gallery-cards">
                    ${letterGroups[letter].map(entity => this.renderEntityMiniCard(entity)).join('')}
                  </div>
                </section>
              `;
            });
            mainContent.innerHTML = html;
          }
          return;
        }

        // Handle Category Cards and List views (visibleCategories already computed above)
        if (viewMode === 'list' && !groupByCategory) {
          const letterGroups = allEntities.reduce((acc, entity) => {
            const name = this.getEntityCardTitle(entity);
            const letter = name.charAt(0).toUpperCase() || '#';
            (acc[letter] = acc[letter] || []).push(entity);
            return acc;
          }, {});
          const letters = Object.keys(letterGroups).sort();
          if (letters.length === 0) {
            mainContent.innerHTML = `
              <div class="card empty-dashboard-card">
                <div class="card-header"><h2>Dashboard</h2></div>
                <p class="empty-dashboard-message">No items yet. Add items from a category in the sidebar or from Settings.</p>
              </div>`;
            return;
          }
          let html = `<div class="dashboard-list"><div class="card">`;
          letters.forEach(letter => {
            html += `<div class="entity-list-letter">${this.escapeHtmlText(letter)}</div><div class="entity-list">` +
              letterGroups[letter].map(entity => `
                <div class="entity-list-item">
                  <div class="entity-info">
                    <span class="material-icons">${this.escapeHtmlText(this.data.entityTypes[entity.type]?.icon || 'folder')}</span>
                    ${this.escapeHtmlText(this.getEntityCardTitle(entity))}
                  </div>
                  <div class="entity-actions">
                    <button class="btn btn-secondary" ${this.entityFormActionAttribute(entity)}>
                      <span class="material-icons">edit</span>
                    </button>
                  </div>
                </div>
              `).join('') + `</div>`;
          });
          html += `</div></div>`;
          mainContent.innerHTML = html;
          return;
        }

        if (visibleCategories.length === 0) {
          mainContent.innerHTML = `
            <div class="card empty-dashboard-card">
              <div class="card-header"><h2>Dashboard</h2></div>
              <p class="empty-dashboard-message">No categories yet. Add a preset or create categories in Settings.</p>
              <div class="empty-dashboard-actions">
                <button type="button" class="btn btn-primary" onclick="App.showSettingsModal()">
                  <span class="material-icons">settings</span> Settings
                </button>
              </div>
            </div>`;
          return;
        }

        // Render category-based view (Category Cards or grouped List)
        const cardsHtml = visibleCategories.map(category => {
          let entities = Object.values(this.data.entities)
            .filter(entity => this.isEntityTypeAvailable(entity.type))
            .filter(entity => this.getEntityTypeCategoryIds(this.data.entityTypes[entity.type]).includes(category.id));
          if (itemsLimit >= 1) entities = entities.slice(0, itemsLimit);

          return `
            <div class="card">
              <div class="card-header">
                <h2><span class="material-icons">${this.escapeHtmlText(category.icon)}</span> ${this.escapeHtmlText(category.label)}</h2>
              </div>
              ${
                viewMode === 'list'
                ? (() => {
                    // Group by letter inside each category
                    const letterGroups = entities.reduce((acc, entity) => {
                      const name = this.getEntityCardTitle(entity);
                      const letter = name.charAt(0).toUpperCase() || '#';
                      (acc[letter] = acc[letter] || []).push(entity);
                      return acc;
                    }, {});
                    return Object.keys(letterGroups).sort().map(letter =>
                      `<div class="entity-list-letter">${this.escapeHtmlText(letter)}</div>
                      <div class="entity-list">
                        ${
                          letterGroups[letter].map(entity => `
                            <div class="entity-list-item">
                              <div class="entity-info">
                                <span class="material-icons">${this.escapeHtmlText(this.data.entityTypes[entity.type]?.icon || 'folder')}</span>
                                ${this.escapeHtmlText(this.getEntityCardTitle(entity))}
                              </div>
                              <div class="entity-actions">
                                <button class="btn btn-secondary" ${this.entityFormActionAttribute(entity)}>
                                  <span class="material-icons">edit</span>
                                </button>
                              </div>
                            </div>
                          `).join('')
                        }
                      </div>`
                    ).join('');
                  })()
                : `<div class="gallery-cards">${
                    entities.length > 0
                      ? entities.map(entity => this.renderEntityMiniCard(entity)).join('')
                      : '<p class="empty-state">No items yet</p>'
                  }</div>`
              }
            </div>
          `;
        }).join('');

        const containerClass = viewMode === 'list' ? 'dashboard-list' : 'dashboard-grid';
        mainContent.innerHTML = `<div class="${containerClass}">${cardsHtml}</div>`;
      },
      
      renderEntityList(categoryId, typeId = '', filters = {}, query = '') {
        const entities = Object.values(this.data.entities)
          .filter(entity => this.isEntityTypeAvailable(entity.type))
          .filter(entity => this.getEntityTypeCategoryIds(this.data.entityTypes[entity.type]).includes(categoryId))
          .filter(entity => !typeId || entity.type === typeId)
          .filter(entity => typeId ? this.filterEntitiesForType(typeId, filters, query).includes(entity) : this.getEntityCardTitle(entity).toLocaleLowerCase().includes(String(query).toLocaleLowerCase()))
          .sort((a, b) => this.getEntityCardTitle(a).localeCompare(this.getEntityCardTitle(b)));

        return entities;
      },

      getAdvancedFilterDescriptors(typeId) {
        const type = this.data.entityTypes[typeId];
        if (!type) return [];
        return [
          ...(type.fields || []).filter(field => field && field.name && field.type !== 'qr'),
          ...(type.associations || []).filter(association => association && association.name && association.association).map(association => ({ ...association, advancedAssociation: true }))
        ];
      },

      renderAdvancedFilterControls(categoryId) {
        const types = this.getEnabledEntityTypes().filter(type => this.getEntityTypeCategoryIds(type).includes(categoryId));
        return `<div class="advanced-filters" data-advanced-filters>
          <label>Filter type <select data-filter-type><option value="">All types</option>${types.map(type => `<option value="${this.escapeHtmlText(type.id)}">${this.escapeHtmlText(type.label)}</option>`).join('')}</select></label>
          <label>Sort by <select data-sort-field><option value="name">Generated name</option></select></label>
          <label>Direction <select data-sort-direction><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>
          <div data-filter-controls></div>
          <button type="button" class="btn btn-secondary" data-clear-advanced-filters>Clear filters</button>
          <p class="help-text" data-filter-result-count></p>
        </div>`;
      },

      updateAdvancedFilterControls() {
        const typeId = document.querySelector('[data-filter-type]')?.value || '';
        const host = document.querySelector('[data-filter-controls]');
        const sortField = document.querySelector('[data-sort-field]');
        if (!host || !sortField) return;
        const previousSort = sortField.value;
        sortField.replaceChildren(...(typeId ? this.getSortDescriptors(typeId) : [{ name: 'name', label: 'Generated name' }]).map(field => new Option(field.label, field.name)));
        if ([...sortField.options].some(option => option.value === previousSort)) sortField.value = previousSort;
        host.replaceChildren();
        this._advancedFilters = {};
        if (!typeId) return this.updateAdvancedFilterResults();
        this.getAdvancedFilterDescriptors(typeId).forEach(descriptor => {
          const label = document.createElement('label');
          label.textContent = descriptor.label || descriptor.name;
          const control = document.createElement('select');
          control.dataset.filterName = descriptor.name;
          control.append(new Option('Any value', ''), new Option('Missing', '__missing__'));
          if (descriptor.type === 'checkbox') {
            control.append(new Option('Yes', 'true'), new Option('No', 'false'));
          } else if (descriptor.advancedAssociation) {
            if (this.isEntityTypeAvailable(descriptor.association.targetType)) {
              Object.values(this.data.entities || {}).filter(entity => entity.type === descriptor.association.targetType).forEach(entity => control.appendChild(new Option(this.getEntityDisplayName(entity), entity.id)));
            }
          } else if (descriptor.type === 'dropdown') {
            (descriptor.options || []).forEach(option => control.appendChild(new Option(option.label || option.value, option.value)));
          } else {
            control.remove();
            const input = document.createElement('input');
            input.dataset.filterName = descriptor.name;
            input.type = descriptor.type === 'number' ? 'number' : descriptor.type === 'date' ? 'date' : 'text';
            input.placeholder = descriptor.type === 'number' || descriptor.type === 'date' ? 'Value' : 'Contains';
            if (descriptor.type === 'number' || descriptor.type === 'date') {
              const operator = document.createElement('select');
              operator.dataset.filterOperator = descriptor.name;
              operator.append(new Option('Equals', 'equals'), new Option(descriptor.type === 'number' ? 'Greater than' : 'After', descriptor.type === 'number' ? 'greater-than' : 'after'), new Option(descriptor.type === 'number' ? 'Less than' : 'Before', descriptor.type === 'number' ? 'less-than' : 'before'));
              operator.addEventListener('change', () => this.updateAdvancedFilterResults());
              label.appendChild(operator);
            }
            label.appendChild(input);
            input.addEventListener('input', () => this.updateAdvancedFilterResults());
            host.appendChild(label);
            return;
          }
          label.appendChild(control);
          control.addEventListener('change', () => this.updateAdvancedFilterResults());
          host.appendChild(label);
        });
        this.updateAdvancedFilterResults();
      },

      updateAdvancedFilterResults() {
        const categoryId = this._advancedFilterCategoryId;
        const typeId = document.querySelector('[data-filter-type]')?.value || '';
        const filters = {};
        document.querySelectorAll('[data-filter-name]').forEach(control => {
          if (control.value) filters[control.dataset.filterName] = { value: control.value, operator: document.querySelector(`[data-filter-operator="${CSS.escape(control.dataset.filterName)}"]`)?.value || 'equals' };
        });
        const query = document.getElementById('searchInput')?.value || '';
        const sort = { field: document.querySelector('[data-sort-field]')?.value || 'name', direction: document.querySelector('[data-sort-direction]')?.value || 'asc' };
        const entities = this.sortEntities(this.renderEntityList(categoryId, typeId, filters, query), typeId, sort);
        const results = document.querySelector('[data-filter-results]');
        const count = document.querySelector('[data-filter-result-count]');
        this.updateBulkSelection(categoryId, typeId, entities);
        const toolbar = document.querySelector('[data-bulk-selection-toolbar]');
        if (toolbar) toolbar.outerHTML = this.renderBulkSelectionToolbar(typeId, entities);
        if (results) results.innerHTML = entities.length ? `<div class="gallery-cards">${entities.map(entity => this.renderSelectableEntityMiniCard(entity)).join('')}</div>` : '<p class="empty-state">No matching items found</p>';
        if (count) count.textContent = `${entities.length} item${entities.length === 1 ? '' : 's'}`;
      },
      
      renderCategoryView(categoryId) {
        const category = this.data.categories[categoryId];
        if (!category) return;
        
        const mainContent = document.getElementById('mainContent');
        if (!mainContent) return;
        
        // Get entity types for this category
        const categoryEntityTypes = this.getEnabledEntityTypes()
          .filter(type => this.getEntityTypeCategoryIds(type).includes(categoryId));
        
        const html = `
          <div class="category-view">
            <div class="card">
              <div class="card-header">
                <h2>
                  <span class="material-icons">${this.escapeHtmlText(category.icon)}</span>
                  ${this.escapeHtmlText(category.label)}
                </h2>
                <div class="button-group button-group-row">
                  <button type="button" class="btn btn-secondary" data-toggle-filters aria-label="Filters" title="Filters" aria-expanded="false" aria-controls="inventoryFilters"><span class="material-icons" aria-hidden="true">filter_list</span></button>
                  ${categoryEntityTypes.length > 0 ? (
                    categoryEntityTypes.length === 1
                      ? `
                    <button class="btn btn-primary" ${this.newEntityFormActionAttribute(categoryEntityTypes[0].id)}>
                      <span class="material-icons">add</span>
                      Add ${this.escapeHtmlText(categoryEntityTypes[0].label)}
                    </button>
                  `
                      : `
                    <div class="dropdown">
                      <button class="btn btn-primary" onclick="App.toggleDropdown(event, this)">
                        <span class="material-icons">add</span>
                        Add New
                      </button>
                      <div class="dropdown-menu hidden">
                        ${categoryEntityTypes.map(type => `
                          <a href="#" ${this.newEntityFormActionAttribute(type.id)}>
                            <span class="material-icons">${this.escapeHtmlText(type.icon)}</span>
                            ${this.escapeHtmlText(type.label)}
                          </a>
                        `).join('')}
                      </div>
                    </div>
                  `
                  ) : ''}
                  ${categoryEntityTypes.length > 0 ? `
                    <div class="dropdown">
                      <button type="button" class="btn btn-secondary" onclick="App.toggleDropdown(event, this)">
                        <span class="material-icons">download</span>
                        Export CSV
                      </button>
                      <div class="dropdown-menu hidden">
                        ${categoryEntityTypes.map(type => `
                          <a href="#" ${this.categoryCsvExportActionAttribute(category.id, type.id)}>
                            ${this.escapeHtmlText(type.label)} inventory CSV
                          </a>
                        `).join('')}
                      </div>
                    </div>
                  ` : ''}
                </div>
              </div>
              <div class="entity-list">
                <div id="inventoryFilters" class="hidden">${this.renderAdvancedFilterControls(categoryId)}</div>
                ${this.renderBulkSelectionToolbar('', [])}
                <div data-filter-results></div>
              </div>
            </div>
          </div>
        `;
        
        mainContent.innerHTML = html;
        this._advancedFilterCategoryId = categoryId;
        const filterToggle = mainContent.querySelector('[data-toggle-filters]');
        const filterPanel = mainContent.querySelector('#inventoryFilters');
        filterToggle.addEventListener('click', () => {
          const collapsed = filterPanel.classList.toggle('hidden');
          filterToggle.setAttribute('aria-expanded', String(!collapsed));
        });
        const typeControl = mainContent.querySelector('[data-filter-type]');
        const sortField = mainContent.querySelector('[data-sort-field]');
        const sortDirection = mainContent.querySelector('[data-sort-direction]');
        const clearButton = mainContent.querySelector('[data-clear-advanced-filters]');
        if (typeControl) typeControl.addEventListener('change', () => this.updateAdvancedFilterControls());
        if (sortField) sortField.addEventListener('change', () => this.updateAdvancedFilterResults());
        if (sortDirection) sortDirection.addEventListener('change', () => this.updateAdvancedFilterResults());
        if (clearButton) clearButton.addEventListener('click', () => {
          if (typeControl) typeControl.value = '';
          this.updateAdvancedFilterControls();
        });
        mainContent.addEventListener('change', event => {
          const entitySelection = event.target.closest('[data-entity-selection]');
          if (entitySelection) {
            if (!this._selectedEntityIds) this._selectedEntityIds = new Set();
            if (entitySelection.checked) this._selectedEntityIds.add(entitySelection.value);
            else this._selectedEntityIds.delete(entitySelection.value);
            this.updateAdvancedFilterResults();
            return;
          }
          if (event.target.matches('[data-select-all-visible]')) {
            this._selectedEntityIds = event.target.checked ? new Set((this._visibleBulkSelectionEntities || []).map(entity => entity.id)) : new Set();
            this.updateAdvancedFilterResults();
          }
        });
        mainContent.addEventListener('click', event => {
          if (event.target.closest('[data-selected-csv-export]')) {
            const typeId = typeControl?.value || '';
            if (typeId && this._selectedEntityIds?.size) this.downloadSelectedCategoryCsvExport(categoryId, typeId, this._visibleBulkSelectionEntities || []);
          } else if (event.target.closest('[data-selected-delete]')) {
            this.confirmDeleteSelectedEntities(categoryId);
          }
        });
        this.updateAdvancedFilterResults();
        this.ensureMainContentScrollable();
      },
      
      handleSearch(query) {
        const mainContent = document.getElementById('mainContent');
        if (!mainContent) return;
        
        query = query.toLowerCase();
        
        const matchingEntities = Object.values(this.data.entities)
          .filter(entity => this.isEntityTypeAvailable(entity.type))
          .filter(entity => {
            const name = this.getEntityCardTitle(entity).toLowerCase();
            return name.includes(query);
          });
        
        const html = `
          <div class="search-results">
            <div class="card">
              <div class="card-header">
                <h2>Search Results</h2>
              </div>
              ${matchingEntities.length > 0 ? matchingEntities.map(entity => {
                const et = this.data.entityTypes[entity.type];
                const icon = et ? et.icon : 'folder';
                return `
                <div class="entity-list-item">
                  <div class="entity-info">
                    <span class="material-icons">${this.escapeHtmlText(icon)}</span>
                    ${this.escapeHtmlText(this.getEntityCardTitle(entity))}
                  </div>
                  <div class="entity-actions">
                    <button class="btn btn-secondary" ${this.entityFormActionAttribute(entity)}>
                      <span class="material-icons">edit</span>
                    </button>
                  </div>
                </div>`;
              }).join('') : '<p class="empty-state">No matching items found</p>'}
            </div>
          </div>
        `;
        
        mainContent.innerHTML = html;
      },
      
      showSettingsModal() {
        var currentTheme = document.documentElement.getAttribute('data-theme');
        if (!currentTheme) currentTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        const modalHtml = `
          <div class="modal" id="settingsModal">
            <div class="modal-content">
              <button class="modal-close" onclick="App.closeModal('settingsModal')">
                <span class="material-icons">close</span>
              </button>
              <div class="modal-header">
                <h3>Settings</h3>
              </div>
              
              <div class="settings-container">
                <!-- Left Column: Main Settings -->
                <div class="settings-main">
                  <!-- Appearance Section -->
                  <div class="settings-section">
                    <div class="section-header">
                      <span class="material-icons">palette</span>
                      <h4>Appearance</h4>
                    </div>
                    <div class="section-content">
                      <div class="form-group">
                        <label>Theme</label>
                        <div class="theme-toggle" data-theme="${this.escapeHtmlText(currentTheme)}">
                          <div class="theme-toggle-slider"></div>
                          <button type="button" class="theme-toggle-option" onclick="App.setTheme('light')" aria-pressed="${currentTheme === 'light'}" aria-label="Light">
                            <span class="material-icons">light_mode</span>
                          </button>
                          <button type="button" class="theme-toggle-option" onclick="App.setTheme('dark')" aria-pressed="${currentTheme === 'dark'}" aria-label="Dark">
                            <span class="material-icons">dark_mode</span>
                          </button>
                        </div>
                      </div>
                      <div class="form-group">
                        <label>Accent color</label>
                        <div class="color-control">
                          <button type="button" class="color-swatch-btn" onclick="App.openColorPicker('accent')">
                            <span class="color-swatch accent-color-swatch accent-color-swatch-inline"></span>
                          </button>
                          <span class="color-hex accent-color-hex">${this.escapeHtmlText(localStorage.getItem('accentColor') || '#2a7ebf')}</span>
                        </div>
                      </div>
                      <div class="form-group">
                        <label>Header color</label>
                        <div class="color-control">
                          <button type="button" class="color-swatch-btn" onclick="App.openColorPicker('header')">
                            <span class="color-swatch header-color-swatch header-color-swatch-inline"></span>
                          </button>
                          <span class="color-hex header-color-hex">${this.escapeHtmlText(localStorage.getItem('headerColor') || '#1a1b1e')}</span>
                        </div>
                      </div>
                      <div class="form-group">
                        <label>Logo style</label>
                        <div class="logo-style-options">
                          <button type="button" class="btn btn-secondary logo-style-btn ${(localStorage.getItem('logoStyle') || 'color') === 'color' ? 'active' : ''}" data-logo-style="color" onclick="App.setLogoStyle('color')">Color</button>
                          <button type="button" class="btn btn-secondary logo-style-btn ${(localStorage.getItem('logoStyle') || '') === 'white' ? 'active' : ''}" data-logo-style="white" onclick="App.setLogoStyle('white')">White</button>
                          <button type="button" class="btn btn-secondary logo-style-btn ${(localStorage.getItem('logoStyle') || '') === 'black' ? 'active' : ''}" data-logo-style="black" onclick="App.setLogoStyle('black')">Black</button>
                        </div>
                      </div>
                      <div class="form-group">
                        <label>Text size</label>
                        <div class="text-size-control" role="group" aria-label="Text size">
                          <button type="button" class="btn btn-text-size" onclick="App.setFontSizeStep(-1)" title="Smaller text" aria-label="Smaller text">
                            <span class="text-size-a">A</span>
                          </button>
                          <button type="button" class="btn btn-text-size" onclick="App.setFontSizeStep(1)" title="Larger text" aria-label="Larger text">
                            <span class="text-size-a text-size-a-large">A</span>
                          </button>
                        </div>
                        <div class="help-text text-size-label">Normal</div>
                      </div>
                    </div>
                  </div>

                  <!-- Dashboard Layout -->
                  <div class="settings-section">
                    <div class="section-header">
                      <span class="material-icons">dashboard</span>
                      <h4>Dashboard Layout</h4>
                    </div>
                    <div class="section-content">
                      <p class="help-text u-mb-075">Choose how the main dashboard and category views show items. What appears on each card is set per entity type under Manage entity types → Visible in card.</p>
                      <div class="form-group">
                        <label>View mode</label>
                        <select name="dashboardViewMode" onchange="App.updateDashboardSettings('viewMode', this.value); App.updateGroupByVisibility(this.value); App.updateViewModeHint(this.value)">
                          <option value="categoryCards" ${this.data.settings.dashboard?.viewMode === 'categoryCards' ? 'selected' : ''}>Category Cards</option>
                          <option value="list" ${this.data.settings.dashboard?.viewMode === 'list' ? 'selected' : ''}>List</option>
                          <option value="gallery" ${this.data.settings.dashboard?.viewMode === 'gallery' ? 'selected' : ''}>Gallery</option>
                        </select>
                        <div class="view-mode-hints" aria-live="polite">
                          <div class="view-mode-hint" data-mode="categoryCards">
                            <div class="view-mode-preview view-mode-preview-cards" aria-hidden="true">
                              <div class="preview-category-card">
                                <div class="preview-category-header">Books</div>
                                <div class="preview-category-inner">
                                  <div class="preview-item-card"></div>
                                  <div class="preview-item-card"></div>
                                  <div class="preview-item-card"></div>
                                </div>
                              </div>
                            </div>
                            <p><strong>Category Cards</strong> — One card per category (e.g. Books, People) with item cards inside. Best for: libraries, asset types, anything grouped by kind.</p>
                          </div>
                          <div class="view-mode-hint" data-mode="list">
                            <div class="view-mode-preview view-mode-preview-list" aria-hidden="true">
                              <div class="preview-list-section">A</div>
                              <div class="preview-list-row"></div>
                              <div class="preview-list-row"></div>
                              <div class="preview-list-section">B</div>
                              <div class="preview-list-row"></div>
                            </div>
                            <p><strong>List</strong> — Rows grouped by first letter (A–Z). Best for: long lists of people, devices, or items where you scan by name.</p>
                          </div>
                          <div class="view-mode-hint" data-mode="gallery">
                            <div class="view-mode-preview view-mode-preview-gallery" aria-hidden="true">
                              <div class="preview-gallery-grid">
                                <div class="preview-gallery-card"></div>
                                <div class="preview-gallery-card"></div>
                                <div class="preview-gallery-card"></div>
                                <div class="preview-gallery-card"></div>
                                <div class="preview-gallery-card"></div>
                                <div class="preview-gallery-card"></div>
                              </div>
                            </div>
                            <p><strong>Gallery</strong> — Same cards as Category Cards but in a grid. Use "Group by category" for one section per category, or off for one A–Z grid. Best for: visual skim of everything.</p>
                          </div>
                        </div>
                        <p class="help-text view-mode-note">A book-store style (cover image + title + author) would need an image field type; for now cards show the fields you mark as Visible in card.</p>
                      </div>
                      <div class="form-group group-by-category">
                        <label class="checkbox-label">
                          <input type="checkbox" class="elistly-checkbox" 
                                 name="groupByCategory" 
                                 onchange="App.updateDashboardSettings('groupByCategory', this.checked)"
                                 ${this.data.settings.dashboard?.groupByCategory ? 'checked' : ''}>
                          Group by Category
                        </label>
                      </div>
                      <div class="form-group items-per-category-settings">
                        <label>Items per Category</label>
                        <div class="items-per-category-number-row">
                          <input type="range" name="dashboardItemsPerCategorySlider" min="0" max="100" value="${(() => { const v = this.data.settings.dashboard?.itemsPerCategory; return (v === undefined || v === null || v === -1) ? 0 : Math.min(100, Math.max(1, parseInt(v, 10) || 10)); })()}" oninput="App.syncItemsPerCategoryFromSlider(this.value)">
                          <input type="number" name="dashboardItemsPerCategoryNumber" min="0" max="100" value="${(() => { const v = this.data.settings.dashboard?.itemsPerCategory; return (v === undefined || v === null || v === -1) ? 0 : Math.min(100, Math.max(1, parseInt(v, 10) || 10)); })()}" onchange="App.syncItemsPerCategoryFromNumber(this)">
                        </div>
                        <div class="items-per-category-hint">0 = show all</div>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- Right: Data & About -->
                <div class="settings-sidebar">
                  <div class="settings-section">
                    <div class="section-header">
                      <span class="material-icons">folder</span>
                      <h4>Data</h4>
                    </div>
                    <div class="section-content">
                      <div class="button-stack">
                        <button class="btn btn-secondary" onclick="App.showEntityTypeManager()">
                          <span class="material-icons">schema</span>
                          Entity types
                        </button>
                        <button class="btn btn-secondary" onclick="App.showCategoryManager()">
                          <span class="material-icons">category</span>
                          Categories
                        </button>
                        <button class="btn btn-secondary" onclick="App.showExportModal()">
                          <span class="material-icons">download</span>
                          Export selected data
                        </button>
                        <p class="help-text">Selected exports exclude account settings. For all inventories, settings and theme, <button type="button" class="btn btn-secondary" onclick="App.closeModal('settingsModal'); App.showProfileModal()">Open Profile backup</button>.</p>
                        <button class="btn btn-secondary" onclick="App.showImportModal()">
                          <span class="material-icons">download</span>
                          Import
                        </button>
                        <button class="btn btn-secondary" onclick="App.showCsvImportModal()">
                          <span class="material-icons">table_view</span>
                          Import CSV
                        </button>
                        <button class="btn btn-secondary" onclick="App.showSvkInventoryImport()">
                          <span class="material-icons">folder_open</span>
                          Import inventory from folder
                        </button>
                        <div class="device-collector-card">
                          <strong>Windows device collector</strong>
                          <p class="help-text">Create one workspace-bound PowerShell script to register a Windows computer. Choose Keep updated automatically to install scheduled reporting too. No automatic expiry by default; choose an expiry or revoke the collector when finished.</p>
                          <button type="button" class="btn btn-secondary" onclick="App.showDeviceRegistrationModal()">
                            <span class="material-icons" aria-hidden="true">laptop_windows</span>
                            Create
                          </button>
                          <button type="button" class="btn btn-secondary" onclick="App.showRecommendedWindowsFieldsConfirm()">
                            <span class="material-icons">playlist_add</span>
                            Add recommended Windows fields
                          </button>
                          <details class="device-collector-details">
                            <summary>Deployment and safety details</summary>
                            <p class="help-text">Run the downloaded script on the target computer. Automatic reporting requires administrator PowerShell. Keep the registration secret private. There is no automatic expiry unless you choose an expiry date and time when creating the script. You can revoke it manually at any time. A repeat uses the same hardware identity and does not overwrite manual records or assign a person.</p>
                          </details>
                        </div>
                        <button class="btn btn-secondary" onclick="App.showAddPresetModal()">
                          <span class="material-icons">add_circle_outline</span>
                          Enable preset
                        </button>
                        ${this.data.workspaces && Object.keys(this.data.workspaces).length ? `
                        <button class="btn btn-secondary" onclick="App.showRenameWorkspaceModal()">
                          <span class="material-icons">inventory_2</span>
                          Inventory: ${this.escapeHtmlText(this.getCurrentWorkspaceName() || 'Default')}
                        </button>
                        ` : ''}
                      </div>
                    </div>
                  </div>

                  <!-- About -->
                  <div class="settings-section">
                    <div class="section-header">
                      <span class="material-icons">info</span>
                      <h4>About</h4>
                    </div>
                    <div class="section-content">
                      <div class="version-info">
                        <span>Version ${CURRENT_VERSION}</span>
                        <button class="btn btn-secondary" onclick="App.showChangelog()">
                          <span class="material-icons">history</span>
                          View Changelog
                        </button>
                        <button class="btn btn-secondary" onclick="App.showFaqModal()">
                          <span class="material-icons">help</span>
                          Help
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        `;
        
        const div = document.createElement('div');
        div.innerHTML = modalHtml;
        document.body.appendChild(div.firstElementChild);
        const textSizeLabel = document.querySelector('#settingsModal .text-size-label');
        const fontSize = this.getSafeFontSize();
        if (textSizeLabel) textSizeLabel.textContent = fontSize.charAt(0).toUpperCase() + fontSize.slice(1);
        this.showModal('settingsModal');
        this.initDashboardSettings();
      },
      
      closeSettingsModal() {
        this.closeModal('settingsModal');
      },

      showRecommendedWindowsFieldsConfirm() {
        const intake = window.ElistlyDeviceIntake;
        const computer = this.data.entityTypes?.computer;
        if (!intake || !computer || !intake.isCompatibleEntityType(computer)) {
          this.showNotification('No compatible Computer type is configured.', 'error');
          return;
        }
        const proposal = intake.addRecommendedWindowsFields(computer);
        if (proposal.added.length === 0) {
          this.showNotification('All recommended Windows fields are already configured.', 'info');
          return;
        }
        const labels = proposal.added.map(field => field.label).join(', ');
        this.showConfirmModal({
          title: 'Add recommended Windows fields?',
          message: `This adds optional fields to Computer without changing existing fields, records, or Persons: ${labels}.`,
          confirmLabel: 'Add fields',
          confirmVariant: 'primary',
          onConfirm: () => {
            this.data.entityTypes.computer = proposal.entityType;
            this.saveData();
            this.showNotification(`Added ${proposal.added.length} Windows collection fields`, 'success');
          }
        });
      },

      async showProfileModal() {
        if (!backendClient) return;
        const { data: { user } } = await backendClient.auth.getUser();
        if (!user) return;
        const meta = user.user_metadata || {};
        const fromProfile = await this.getDisplayName(user.id);
        const userName = fromProfile || meta.user_name || '';

        const modalHtml = `
          <div class="modal" id="profileModal">
            <div class="modal-content profile-modal-content">
              <button class="modal-close" onclick="App.closeModal('profileModal')">
                <span class="material-icons">close</span>
              </button>
              <div class="modal-header">
                <h3>Profile</h3>
              </div>
              <div class="modal-body">

                <section class="profile-section">
                  <h4 class="profile-section-heading">Display name</h4>
                  <div class="profile-section-content">
                    <input type="text" id="profileUserName" class="profile-input" value="${this.escapeHtmlText(userName)}" placeholder="Name shown in the app">
                    <p class="profile-help">Shown in the header and when your account is referenced.</p>
                  </div>
                </section>

                <section class="profile-section profile-section-data">
                  <h4 class="profile-section-heading">Data &amp; account</h4>
                  <p class="profile-help">Back up all inventories, app settings and theme. This is not a full account backup: profile details, authentication, collector credentials, pending local edits, recovery archives, and separate offline source reports and receipts are excluded. Download local recovery separately and keep original report files. Reset clears editable inventory, while saved reports remain. Delete account removes everything permanently.</p>
                  <div class="profile-inline-actions profile-data-actions">
                    <button type="button" class="btn btn-secondary" id="profileExportAllBtn">
                      <span class="material-icons">download</span> Download inventory backup
                    </button>
                    <button type="button" class="btn btn-secondary" id="profileRestoreAllBtn">
                      <span class="material-icons">upload</span> Restore inventory backup
                    </button>
                    <button type="button" class="btn btn-secondary" id="profileResetDataBtn">
                      <span class="material-icons">refresh</span> Reset data
                    </button>
                    <button type="button" class="btn btn-danger" id="profileDeleteAccountBtn">
                      <span class="material-icons">person_remove</span> Delete account
                    </button>
                  </div>
                </section>
              </div>
              <div class="modal-actions">
                <button type="button" class="btn btn-primary" id="profileSaveBtn">Save</button>
              </div>
            </div>
          </div>
        `;
        const existing = document.getElementById('profileModal');
        if (existing) existing.remove();
        const div = document.createElement('div');
        div.innerHTML = modalHtml;
        document.body.appendChild(div.firstElementChild);
        this.showModal('profileModal');
        this.bindProfileModal(user);
      },

      bindProfileModal(user) {
        const saveBtn = document.getElementById('profileSaveBtn');
        if (saveBtn) saveBtn.addEventListener('click', () => this.saveProfile());
        const exportAllBtn = document.getElementById('profileExportAllBtn');
        const restoreAllBtn = document.getElementById('profileRestoreAllBtn');
        const resetDataBtn = document.getElementById('profileResetDataBtn');
        const deleteAccountBtn = document.getElementById('profileDeleteAccountBtn');
        if (exportAllBtn) exportAllBtn.addEventListener('click', () => this.exportAllData());
        if (restoreAllBtn) restoreAllBtn.addEventListener('click', () => this.showFullBackupRestoreModal());
        if (resetDataBtn) resetDataBtn.addEventListener('click', () => this.showResetDataModal());
        if (deleteAccountBtn) deleteAccountBtn.addEventListener('click', () => this.showDeleteAccountModal());
      },

      async saveProfile() {
        const userName = (document.getElementById('profileUserName') && document.getElementById('profileUserName').value) || '';
        const trimmedName = userName.trim();
        const user = await getAuthUser();
        if (!user) return;
        const res = await apiRequest('/profile', { method: 'PUT', body: { display_name: trimmedName || null } });
        if (!res.ok) {
          this.showSnackbar((res.data && res.data.error) || 'Failed to save display name', true);
          return;
        }
        this.showSnackbar('Profile saved.');
        this.closeModal('profileModal');
        const display = trimmedName || (user.user_metadata && user.user_metadata.user_name) || user.email || 'Signed in';
        const menu = document.getElementById('profileMenu');
        const userLine = menu && menu.querySelector('.profile-dropdown-user');
        if (userLine) {
          userLine.innerHTML = '<span class="material-icons">person</span>' + this.escapeHtmlText(display);
        }
      },

      setTheme(theme) {
        if (theme !== 'light' && theme !== 'dark') return;
        localStorage.setItem('theme', theme);
        document.documentElement.setAttribute('data-theme', theme);
        var themeToggle = document.querySelector('.theme-toggle');
        if (themeToggle) themeToggle.setAttribute('data-theme', theme);
      },

      getSafeFontSize() {
        const fontSize = this.data?.settings?.fontSize;
        return ['small', 'normal', 'large', 'larger'].includes(fontSize) ? fontSize : 'normal';
      },

      normalizeSettings(incoming, existing = {}) {
        const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
        const source = isPlainObject(incoming) ? incoming : {};
        const fallback = isPlainObject(existing) ? existing : {};
        const result = {};
        const supportedDefaultViews = ['dashboard'];
        const normalizeMaterialIcons = value => Array.isArray(value)
          ? value.filter(icon => typeof icon === 'string' && MATERIAL_ICONS.includes(icon))
          : null;
        const normalizeDashboard = value => {
          if (!isPlainObject(value)) return null;
          const dashboard = {};
          if (['categoryCards', 'list', 'gallery'].includes(value.viewMode)) dashboard.viewMode = value.viewMode;
          if (typeof value.groupByCategory === 'boolean') dashboard.groupByCategory = value.groupByCategory;
          if (Number.isInteger(value.itemsPerCategory) && (value.itemsPerCategory === -1 || (value.itemsPerCategory >= 1 && value.itemsPerCategory <= 100))) dashboard.itemsPerCategory = value.itemsPerCategory;
          if (Array.isArray(value.categoryOrder)) dashboard.categoryOrder = value.categoryOrder.filter(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id));
          return dashboard;
        };
        const normalizeNotifications = value => {
          if (!isPlainObject(value)) return null;
          const notifications = {};
          if (Number.isInteger(value.duration) && value.duration >= 0 && value.duration <= 300000) notifications.duration = value.duration;
          return notifications;
        };

        result.defaultView = supportedDefaultViews.includes(source.defaultView)
          ? source.defaultView
          : (supportedDefaultViews.includes(fallback.defaultView) ? fallback.defaultView : 'dashboard');
        const fontSize = ['small', 'normal', 'large', 'larger'].includes(source.fontSize)
          ? source.fontSize
          : (['small', 'normal', 'large', 'larger'].includes(fallback.fontSize) ? fallback.fontSize : 'normal');
        result.fontSize = fontSize;
        const materialIcons = normalizeMaterialIcons(source.materialIcons) || normalizeMaterialIcons(fallback.materialIcons) || MATERIAL_ICONS;
        result.materialIcons = materialIcons.length ? materialIcons : MATERIAL_ICONS.slice();
        const dashboard = normalizeDashboard(source.dashboard) || normalizeDashboard(fallback.dashboard);
        if (dashboard) result.dashboard = dashboard;
        const notifications = normalizeNotifications(source.notifications) || normalizeNotifications(fallback.notifications);
        if (notifications) result.notifications = notifications;
        return result;
      },

      setFontSizeStep(delta) {
        const steps = ['small', 'normal', 'large', 'larger'];
        const current = this.getSafeFontSize();
        let idx = steps.indexOf(current);
        if (idx < 0) idx = 1;
        idx = Math.max(0, Math.min(steps.length - 1, idx + delta));
        const next = steps[idx];
        this.data.settings.fontSize = next;
        document.documentElement.setAttribute('data-font-size', next);
        this.saveData();
        const label = document.querySelector('.text-size-label');
        if (label) label.textContent = next.charAt(0).toUpperCase() + next.slice(1);
      },
      
      showEntityForm(entityType, entityId = '') {
        const type = this.data.entityTypes[entityType];
        if (!type) {
          console.error('Entity type not found:', entityType);
          return;
        }
        if (!this.isEntityTypeAvailable(type)) {
          this.showNotification(`${type.label || entityType} is disabled. Enable it from Manage entity types first.`, 'error');
          return;
        }

        const entity = entityId ? this.data.entities[entityId] : null;
        if (entityId && !entity) {
          console.error('Entity not found:', entityId);
          return;
        }

        const isEdit = !!entity;
        
        // Close any open dropdowns
        document.querySelectorAll('.dropdown-menu').forEach(menu => {
          menu.style.display = 'none';
        });
        const makeElement = (tag, className, text) => {
          const element = document.createElement(tag);
          if (className) element.className = className;
          if (text !== undefined) element.textContent = text;
          return element;
        };
        const addIcon = (parent, icon) => parent.appendChild(makeElement('span', 'material-icons', icon));
        const modal = makeElement('div', 'modal');
        modal.id = 'entityModal';
        const content = makeElement('div', 'modal-content');
        modal.appendChild(content);
        const close = makeElement('button', 'modal-close');
        close.type = 'button';
        close.addEventListener('click', () => this.closeModal('entityModal'));
        addIcon(close, 'close');
        content.appendChild(close);
        const titleInfo = isEdit ? this.getEntityTitleInfo(entity) : { title: '' };
        const viewTitle = isEdit ? titleInfo.title : '';
        const header = makeElement('div', 'modal-header');
        const heading = makeElement('h3', '', isEdit ? (viewTitle || type.label || '') : `New ${type.label || ''}`);
        heading.id = 'entityModalTitle';
        header.appendChild(heading);
        content.appendChild(header);
        if (isEdit) {
          const view = makeElement('div', 'modal-body entity-detail-view');
          view.id = 'entityView';
          const card = makeElement('div', 'entity-detail-card');
          const head = makeElement('div', 'entity-detail-head');
          const icon = makeElement('span', 'material-icons entity-detail-icon', type.icon || 'folder');
          icon.setAttribute('aria-hidden', 'true');
          head.append(icon, makeElement('div', 'entity-detail-title', viewTitle));
          card.appendChild(head);
          const properties = makeElement('div', 'entity-detail-properties');
          const appendDetail = (label, value) => {
            if (!value) return;
            const detail = makeElement('div', 'entity-detail-field');
            detail.append(makeElement('span', 'entity-detail-label', label), document.createTextNode(' '), makeElement('span', 'entity-detail-value', value));
            properties.appendChild(detail);
          };
          (type.fields || []).forEach(field => appendDetail(field.label || '', this.formatFieldValue(field, entity[field.name])));
          (type.associations || []).forEach(assoc => appendDetail(assoc.label || '', this.getEntityDisplayName(entity[assoc.name])));
          card.appendChild(properties);
          view.appendChild(card);
          content.appendChild(view);
        }
        if (entityType === 'computer') {
          const inventory = makeElement('button', 'btn btn-secondary', isEdit ? 'Saved offline observations' : 'Import inventory from folder');
          inventory.type = 'button';
          inventory.onclick = () => {
            if (isEdit) this.showSvkInventoryHistory(entityId);
            else { this.closeModal('entityModal'); this.showSvkInventoryImport(); }
          };
          content.append(inventory);
        }
        const form = makeElement('form');
        form.id = 'entityForm';
        form.dataset.typeId = entityType;
        form.dataset.entityId = entityId || '';
        form.autocomplete = 'off';
        form.addEventListener('submit', event => {
          if (Number(form.dataset.deviceIntakePendingConflicts) > 0) {
            event.preventDefault();
            form.querySelector('.device-intake-conflict[data-resolved="false"] button')?.focus();
            this.showNotification('Choose a value for every imported field conflict before saving.', 'error');
            return;
          }
          this.saveEntity(event, entityType, entityId);
        });
        const sections = makeElement('div', `form-sections${isEdit ? ' hidden' : ''}`);
        sections.id = 'entityEdit';
        const basic = makeElement('div', 'modal-group carded-section');
        basic.appendChild(makeElement('h4', '', 'Basic Information'));
        if (type.enableNameGen) {
          const group = makeElement('div', 'form-group');
          group.appendChild(makeElement('label', '', 'Name'));
          const lockRow = makeElement('div', 'name-lock-row');
          const nameInput = document.createElement('input');
          nameInput.type = 'text'; nameInput.name = 'name'; nameInput.id = 'nameInput'; nameInput.value = entity?.autoName || entity?.name || '';
          nameInput.dataset.unlocked = 'false'; nameInput.readOnly = true; nameInput.className = 'name-lock-input';
          const unlock = makeElement('button', 'btn btn-secondary');
          unlock.type = 'button'; unlock.title = 'Unlock to edit name manually';
          unlock.addEventListener('click', () => this.toggleNameLock(unlock));
          addIcon(unlock, 'lock');
          lockRow.append(nameInput, unlock);
          group.append(lockRow, makeElement('div', 'help-text', isEdit ? 'Saved name stays unchanged unless you unlock and edit it' : 'Name will be generated from the current naming settings'));
          group.lastElementChild.id = 'nameGenStatus';
          basic.appendChild(group);
        }
        (type.fields || []).forEach(field => basic.appendChild(this.createEntityFormField(field, entity ? entity[field.name] : '')));
        if (!isEdit && ElistlyDeviceIntake.isCompatibleEntityType(type)) {
          sections.appendChild(this.createDeviceIntakeDraftSection(type, form));
        }
        sections.appendChild(basic);
        if (type.associations && type.associations.length) {
          const associations = makeElement('div', 'modal-group carded-section');
          associations.appendChild(makeElement('h4', '', 'Links'));
          type.associations.forEach(assoc => associations.appendChild(this.createEntityAssociationField(assoc, entity ? entity[assoc.name] : '')));
          sections.appendChild(associations);
        }
        form.appendChild(sections);
        const actions = makeElement('div', 'modal-actions');
        const viewActions = makeElement('div', ''); viewActions.id = 'entityViewActions'; if (!isEdit) viewActions.classList.add('hidden');
        const edit = makeElement('button', 'btn btn-primary', 'Edit'); edit.type = 'button'; edit.addEventListener('click', () => this.showEntityEditMode(true));
        edit.prepend(makeElement('span', 'material-icons', 'edit')); viewActions.appendChild(edit);
        const editActions = makeElement('div', ''); editActions.id = 'entityEditActions'; if (isEdit) editActions.classList.add('hidden');
        const cancel = makeElement('button', 'btn btn-secondary', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', () => this.tryCloseEntityModal()); editActions.appendChild(cancel);
        if (isEdit) {
          const remove = makeElement('button', 'btn btn-danger', 'Delete'); remove.type = 'button'; remove.addEventListener('click', () => this.confirmDelete(entityId));
          remove.prepend(makeElement('span', 'material-icons', 'delete')); editActions.appendChild(remove);
        }
        const save = makeElement('button', 'btn btn-primary', 'Save'); save.type = 'submit'; save.prepend(makeElement('span', 'material-icons', 'save')); editActions.appendChild(save);
        actions.append(viewActions, editActions); form.appendChild(actions); content.appendChild(form);
        document.body.appendChild(modal);
        this.showModal('entityModal');
        
        // Initialize name generation if needed
        if (type.enableNameGen) {
          this.initEntityFormNameGen();
        }

        const snapshot = this.serializeFormData(form);
        form.dataset.initialSnapshot = snapshot;
        form.dataset.dirty = 'false';
        form.addEventListener('input', () => {
          form.dataset.dirty = this.serializeFormData(form) !== form.dataset.initialSnapshot ? 'true' : 'false';
        });
        form.addEventListener('change', () => {
          form.dataset.dirty = this.serializeFormData(form) !== form.dataset.initialSnapshot ? 'true' : 'false';
        });
      },

      createDeviceIntakeDraftSection(type, form) {
        const make = (tag, className, text) => {
          const element = document.createElement(tag);
          if (className) element.className = className;
          if (text !== undefined) element.textContent = text;
          return element;
        };
        const section = make('section', 'modal-group carded-section device-intake-draft');
        section.appendChild(make('h4', '', 'Import collected information'));
        section.appendChild(make('p', 'help-text', 'Select a local Elistly Windows collector report to fill compatible empty fields. Review and edit the ordinary form before saving.'));
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.id = 'deviceIntakeFile';
        input.className = 'device-intake-file';
        const result = make('div', 'device-intake-result');
        result.setAttribute('aria-live', 'polite');
        input.addEventListener('change', event => this.readDeviceIntakeDraftReport(event, type, form, result));
        section.append(input, result);
        return section;
      },

      setDeviceIntakeDraftValue(form, item) {
        const control = form.elements.namedItem(item.field);
        if (!control || typeof control.value === 'undefined') return false;
        control.value = item.value;
        control.closest('.form-group')?.classList.add('device-intake-imported');
        control.dispatchEvent(new Event('input', { bubbles: true }));
        control.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      },

      setDeviceIntakePendingConflictCount(form, count) {
        const pending = Math.max(0, Number(count) || 0);
        form.dataset.deviceIntakePendingConflicts = String(pending);
        const save = form.querySelector('button[type="submit"]');
        if (save) save.disabled = pending > 0;
      },

      async readDeviceIntakeDraftReport(event, type, form, result) {
        const readId = String(Number(result.dataset.deviceIntakeRead || 0) + 1);
        result.dataset.deviceIntakeRead = readId;
        result.replaceChildren();
        this.setDeviceIntakePendingConflictCount(form, 0);
        try {
          const file = event.target.files?.[0];
          if (!file) return;
          if (file.size > ElistlyDeviceIntake.limits.maxBytes) throw new Error('Report exceeds the 256 KiB limit.');
          const text = await file.text();
          if (result.dataset.deviceIntakeRead !== readId) return;
          const report = ElistlyDeviceIntake.parseReport(text);
          const draft = Object.fromEntries(new FormData(form).entries());
          const proposal = ElistlyDeviceIntake.createDraftProposal(report, type, draft);
          proposal.mapped.forEach(item => this.setDeviceIntakeDraftValue(form, item));
          this.renderDeviceIntakeDraftResult(result, form, report, type, proposal);
        } catch (error) {
          if (result.dataset.deviceIntakeRead !== readId) return;
          const message = document.createElement('p');
          message.className = 'error-message';
          message.textContent = error.message || 'The report could not be read.';
          result.appendChild(message);
        }
      },

      renderDeviceIntakeDraftResult(result, form, report, type, proposal) {
        const make = (tag, className, text) => {
          const element = document.createElement(tag);
          if (className) element.className = className;
          if (text !== undefined) element.textContent = text;
          return element;
        };
        result.replaceChildren();
        result.appendChild(make('p', 'device-intake-summary', `Imported ${proposal.mapped.length} field${proposal.mapped.length === 1 ? '' : 's'} from collector ${report.collector.version}.`));

        if (proposal.conflicts.length) {
          const conflicts = make('section', 'device-intake-conflicts');
          conflicts.appendChild(make('h5', '', 'Choose values for existing draft fields'));
          conflicts.appendChild(make('p', 'help-text device-intake-conflict-guidance', 'Resolve every conflict to make Save available.'));
          for (const item of proposal.conflicts) {
            const row = make('div', 'device-intake-conflict');
            row.dataset.field = item.field;
            row.dataset.resolved = 'false';
            const field = (type.fields || []).find(candidate => candidate.name === item.field);
            row.appendChild(make('p', '', `${field?.label || item.field}: current “${item.current}”; collected “${item.value}”.`));
            const actions = make('div', 'device-intake-conflict-actions');
            const keep = make('button', 'btn btn-secondary btn-sm', 'Keep current');
            keep.type = 'button';
            const use = make('button', 'btn btn-secondary btn-sm', 'Use collected');
            use.type = 'button';
            const resolution = make('span', 'help-text');
            const resolve = text => {
              row.dataset.resolved = 'true';
              keep.disabled = true;
              use.disabled = true;
              resolution.textContent = text;
              const pending = conflicts.querySelectorAll('.device-intake-conflict[data-resolved="false"]').length;
              this.setDeviceIntakePendingConflictCount(form, pending);
            };
            keep.addEventListener('click', () => resolve('Kept current value.'));
            use.addEventListener('click', () => {
              this.setDeviceIntakeDraftValue(form, item);
              resolve('Using collected value.');
            });
            actions.append(keep, use, resolution);
            row.appendChild(actions);
            conflicts.appendChild(row);
          }
          result.appendChild(conflicts);
        }
        this.setDeviceIntakePendingConflictCount(form, proposal.conflicts.length);

        if (Object.keys(proposal.accountContext).length) {
          const context = make('section', 'device-intake-account-context');
          context.appendChild(make('h5', '', 'Collected account context (not assigned)'));
          const list = document.createElement('dl');
          for (const [key, value] of Object.entries(proposal.accountContext)) {
            const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, character => character.toUpperCase());
            list.append(make('dt', '', label), make('dd', '', String(value)));
          }
          context.appendChild(list);
          result.appendChild(context);
        }

        if (proposal.unmapped.length) {
          const details = make('details', 'device-intake-unmapped');
          details.appendChild(make('summary', '', `Not imported (${proposal.unmapped.length})`));
          const list = document.createElement('ul');
          proposal.unmapped.forEach(item => list.appendChild(make('li', '', `${item.fact}: ${item.reason}`)));
          details.appendChild(list);
          result.appendChild(details);
        }
        proposal.warnings.forEach(warning => result.appendChild(make('p', 'help-text', warning)));
      },

      createEntityFormField(field, value) {
        const group = document.createElement('div');
        group.className = 'form-group';
        const label = document.createElement('label');
        label.htmlFor = field.name;
        label.textContent = `${field.label || ''}${field.required ? ' *' : ''}`;
        group.appendChild(label);
        let input;
        if (field.type === 'dropdown') {
          input = document.createElement('select');
          const placeholder = new Option(`Select ${field.label || ''}`, '');
          input.appendChild(placeholder);
          (field.options || []).forEach(option => input.appendChild(new Option(option.label || option.value || '', option.value || '', false, value === option.value)));
        } else if (field.type === 'textarea') {
          input = document.createElement('textarea'); input.textContent = value || '';
        } else if (field.type === 'checkbox') {
          input = document.createElement('input'); input.type = 'checkbox'; input.className = 'elistly-checkbox'; input.value = 'yes'; input.checked = value === true || value === 'on' || value === '1' || value === 'yes';
        } else {
          input = document.createElement('input'); input.type = field.type === 'date' || field.type === 'number' ? field.type : 'text'; input.value = value != null ? value : '';
          if (field.type === 'qr') {
            input.readOnly = true;
            const wrapper = document.createElement('div');
            wrapper.className = 'qr-field-wrap';
            input.id = field.name; input.name = field.name;
            wrapper.appendChild(input);
            const qr = this.createLocalQrDataUrl(value || '', 160);
            if (qr.src) {
              const image = document.createElement('img');
              image.src = qr.src; image.className = 'qr-preview'; image.alt = 'QR code'; wrapper.appendChild(image);
            }
            group.appendChild(wrapper);
            group.appendChild(Object.assign(document.createElement('div'), { className: 'help-text', textContent: qr.error || 'QR code is generated on save and stays unique to this item.' }));
            return group;
          }
        }
        input.id = field.name; input.name = field.name; input.autocomplete = 'off'; if (field.required) input.required = true;
        group.appendChild(input);
        return group;
      },

      createEntityAssociationField(assoc, value) {
        const group = document.createElement('div'); group.className = 'form-group association-field-wrap'; group.dataset.assocName = assoc.name;
        const label = document.createElement('label'); label.htmlFor = assoc.name; label.textContent = assoc.label || ''; group.appendChild(label);
        const row = document.createElement('div'); row.className = 'association-field-row';
        const select = document.createElement('select'); select.id = assoc.name; select.name = assoc.name; if (assoc.required) select.required = true; select.appendChild(new Option('— None —', ''));
        const targetType = assoc.association.targetType;
        const targetTypeAvailable = this.isEntityTypeAvailable(targetType);
        if (targetTypeAvailable) {
          Object.values(this.data.entities).filter(entity => entity.type === targetType).forEach(entity => select.appendChild(new Option(this.getEntityDisplayName(entity), entity.id, false, value === entity.id)));
        }
        const link = document.createElement('a'); link.href = '#'; link.className = 'association-add-link'; link.dataset.targetType = targetType; link.dataset.assocName = assoc.name; link.dataset.targetLabel = this.data.entityTypes[targetType]?.label || targetType;
        if (targetTypeAvailable) {
          link.append(document.createTextNode('Add '), document.createTextNode(link.dataset.targetLabel));
          link.addEventListener('click', event => this.showInlineAddEntity(event, link));
          row.append(select, link);
        } else {
          row.append(select);
        }
        group.appendChild(row); return group;
      },
      renderFieldInput(field, value) {
        const host = document.createElement('div');
        host.appendChild(this.createEntityFormField(field, value));
        return host.innerHTML;
      },

      showInlineAddEntity(event, linkEl) {
        event.preventDefault();
        const link = linkEl && linkEl.dataset ? linkEl : event.target.closest('.association-add-link');
        if (!link || !link.dataset) return;
        const targetType = link.dataset.targetType;
        const assocName = link.dataset.assocName;
        const targetLabel = link.dataset.targetLabel || targetType;
        const wrap = link.closest('.association-field-wrap');
        if (wrap.querySelector('.inline-add-entity')) return;
        const type = this.data.entityTypes[targetType];
        if (!this.isEntityTypeAvailable(type) || !type.fields) return;
        const inlineEl = document.createElement('div');
        inlineEl.className = 'inline-add-entity';
        const title = document.createElement('div'); title.className = 'inline-add-title'; title.textContent = `New ${targetLabel}`;
        const form = document.createElement('form'); form.className = 'inline-add-form'; form.dataset.targetType = targetType; form.dataset.assocName = assocName;
        type.fields.forEach(field => {
          const group = this.createEntityFormField({ ...field, name: field.name }, '');
          const control = group.querySelector('[name]');
          if (control) control.id = `inline_${targetType}_${field.name}`;
          const label = group.querySelector('label');
          if (label && control) label.htmlFor = control.id;
          form.appendChild(group);
        });
        const actions = document.createElement('div'); actions.className = 'inline-add-actions';
        const add = document.createElement('button'); add.type = 'submit'; add.className = 'btn btn-primary'; add.textContent = 'Add';
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-secondary'; cancel.textContent = 'Cancel'; cancel.addEventListener('click', () => inlineEl.remove());
        actions.append(add, cancel); form.appendChild(actions); inlineEl.append(title, form);
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          const formData = new FormData(e.target);
          const data = { id: this.generateId(), type: targetType };
          formData.forEach((val, key) => { if (val !== '') data[key] = val; });
          const t = this.data.entityTypes[targetType];
          t.fields.filter(f => f.type === 'checkbox').forEach(f => { data[f.name] = formData.get(f.name) === 'yes'; });
          if (t.enableNameGen) data.autoName = this.generateAutoName(targetType, data);
          else if (t.fields.some(f => f.name === 'firstName') && t.fields.some(f => f.name === 'lastName')) data.name = [data.firstName, data.lastName].filter(Boolean).join(' ').trim() || '';
          else if (t.fields.some(f => f.name === 'name')) data.name = data.name || '';
          this.data.entities[data.id] = data;
          this.saveData();
          const select = wrap.querySelector('select');
          if (select) {
            const opt = document.createElement('option');
            opt.value = data.id;
            opt.textContent = this.getEntityDisplayName(data);
            opt.selected = true;
            select.appendChild(opt);
          }
          inlineEl.remove();
          this.showNotification(`${targetLabel} added`, 'success');
        });
        wrap.appendChild(inlineEl);
      },
      
      saveEntity(event, entityType, entityId) {
        event.preventDefault();
        const form = event.target;
        const formData = new FormData(form);
        const type = this.data.entityTypes[entityType];
        
        // Start with existing data if editing
        const data = entityId ? { ...this.data.entities[entityId] } : { id: this.generateId(), type: entityType };
        
        for (let [key, value] of formData.entries()) {
          if (key === 'name' && type.enableNameGen) continue;
          if (value !== '') data[key] = value;
        }
        type.fields.filter(f => f.type === 'checkbox').forEach(f => {
          data[f.name] = formData.get(f.name) === 'yes';
        });

        // Naming settings are prospective: generate once on creation, then preserve the saved name.
        if (type.enableNameGen) {
          const nameInput = form.querySelector('#nameInput');
          const unlocked = nameInput && nameInput.dataset.unlocked === 'true';
          const requestedName = (formData.get('name') || '').trim();
          if (!entityId) {
            data.autoName = unlocked && requestedName
              ? requestedName
              : this.generateAutoName(entityType, data, data.id);
            delete data.name;
          } else if (unlocked && requestedName) {
            data.autoName = requestedName;
            delete data.name;
          }
        } else if (type.fields.some(f => f.name === 'firstName') && type.fields.some(f => f.name === 'lastName')) {
          data.name = [data.firstName, data.lastName].filter(Boolean).join(' ').trim() || data.name || '';
        } else if (data.name) {
          data.name = data.name;
        }

        type.fields.filter(f => f.type === 'qr').forEach(f => {
          if (!data[f.name]) data[f.name] = data.id;
        });
        
        // Save the entity
        this.data.entities[data.id] = data;
        
        this.saveData();
        this.closeEntityModal();
        const url = new URL(window.location);
        const activeView = url.searchParams.get('category') || url.searchParams.get('view') || 'dashboard';
        const categoryIds = this.getEntityTypeCategoryIds(type);
        const fallbackView = categoryIds.length ? categoryIds[0] : 'dashboard';
        this.loadView(activeView || fallbackView);
        this.showNotification(`Entity ${entityId ? 'updated' : 'created'} successfully`, 'success');
      },
      
      deleteEntity(entityId) {
        const entity = this.data.entities[entityId];
        if (!entity) return;
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.id = 'confirmDeleteModal';
        const content = document.createElement('div');
        content.className = 'modal-content';
        const close = document.createElement('button');
        close.type = 'button'; close.className = 'modal-close'; close.textContent = '×';
        close.addEventListener('click', () => this.closeModal('confirmDeleteModal'));
        const header = document.createElement('div'); header.className = 'modal-header';
        const heading = document.createElement('h3'); heading.textContent = 'Confirm Delete'; header.appendChild(heading);
        const message = document.createElement('p'); message.textContent = 'Are you sure you want to delete this item?';
        const actions = document.createElement('div'); actions.className = 'modal-actions';
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-secondary'; cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => this.closeModal('confirmDeleteModal'));
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-danger'; remove.textContent = 'Delete';
        remove.addEventListener('click', () => this.confirmDelete(entityId));
        actions.append(cancel, remove); content.append(close, header, message, actions); modal.appendChild(content);
        document.body.appendChild(modal);
        this.showModal('confirmDeleteModal');
      },
      
      confirmDelete(entityId) {
        const entity = this.data.entities[entityId];
        const type = this.data.entityTypes[entity.type];
        const catIds = this.getEntityTypeCategoryIds(type);
        const category = catIds.length ? catIds[0] : null;
        
        delete this.data.entities[entityId];
        this.saveData();
        
        this.closeModal('confirmDeleteModal');
        this.closeEntityModal();
        this.loadView(category || 'dashboard');
        this.showNotification('Entity deleted successfully', 'success');
      },
      
      closeEntityModal() {
        this.closeModal('entityModal');
      },

      tryCloseEntityModal() {
        const form = document.getElementById('entityForm');
        if (!form || !document.getElementById('entityModal')) return;
        const dirty = form.dataset.dirty === 'true';
        if (!dirty) {
          this.closeModal('entityModal');
          return;
        }
        this.showConfirmModal({
          title: 'Save changes?',
          message: 'Save changes before closing this item?',
          confirmLabel: 'Save changes',
          cancelLabel: 'Discard',
          confirmVariant: 'primary',
          onConfirm: () => form.requestSubmit(),
          onCancel: () => this.closeModal('entityModal')
        });
      },

      serializeFormData(form) {
        const data = [];
        const formData = new FormData(form);
        formData.forEach((value, key) => {
          data.push([key, String(value)]);
        });
        return JSON.stringify(data.sort((a, b) => a[0].localeCompare(b[0])));
      },
      
      showCategoryManager() {
        const make = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = text; return el; };
        const icon = (name) => make('span', 'material-icons', name);
        const modal = make('div', 'modal'); modal.id = 'categoryManagerModal';
        const content = make('div', 'modal-content');
        const close = make('button', 'modal-close', '×'); close.type = 'button'; close.addEventListener('click', () => this.closeModal('categoryManagerModal'));
        const header = make('div', 'modal-header'); header.appendChild(make('h3', '', 'Manage Categories'));
        const body = make('div', 'modal-body modal-body-no-top'); const list = make('div', 'category-list');
        Object.values(this.data.categories || {}).forEach(category => {
          const row = make('div', 'category-item'); const info = make('div', 'category-info');
          info.append(icon(category.icon || 'folder'), make('span', '', category.label || category.id || ''));
          const actions = make('div', 'category-actions');
          const edit = make('button', 'btn btn-secondary'); edit.type = 'button'; edit.title = 'Edit'; edit.appendChild(icon('edit')); edit.addEventListener('click', () => this.editCategory(category.id));
          const isBuiltIn = Array.isArray(category.presetIds) && category.presetIds.length > 0;
          const remove = make('button', isBuiltIn ? 'btn btn-secondary' : 'btn btn-danger'); remove.type = 'button';
          if (isBuiltIn) {
            const enabling = category.enabled === false;
            remove.title = enabling ? 'Enable' : 'Disable';
            remove.appendChild(icon(enabling ? 'visibility' : 'visibility_off'));
            remove.addEventListener('click', () => {
              this.closeModal('categoryManagerModal');
              this.setCategoryEnabled(category.id, enabling);
              this.showCategoryManager();
            });
          } else {
            remove.title = 'Delete';
            remove.appendChild(icon('delete'));
            remove.addEventListener('click', () => this.deleteCategory(category.id));
          }
          actions.append(edit, remove); row.append(info, actions); list.appendChild(row);
        });
        body.appendChild(list); const footer = make('div', 'modal-actions'); const add = make('button', 'btn btn-primary', 'New Category'); add.type = 'button'; add.prepend(icon('add')); add.addEventListener('click', () => this.showCategoryForm()); footer.appendChild(add);
        content.append(close, header, body, footer); modal.appendChild(content); document.body.appendChild(modal);
        this.showModal('categoryManagerModal');
      },
            
      closeCategoryManager() {
        this.closeModal('categoryManagerModal');
      },

      showCategoryForm(categoryId = '') {
        const category = categoryId ? this.data.categories[categoryId] : null;
        const make = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = text; return el; };
        const modal = make('div', 'modal'); modal.id = 'categoryFormModal';
        const content = make('div', 'modal-content'); const close = make('button', 'modal-close', '×'); close.type = 'button'; close.addEventListener('click', () => this.closeModal('categoryFormModal'));
        const header = make('div', 'modal-header'); header.appendChild(make('h3', '', category ? 'Edit Category' : 'New Category'));
        const form = make('form'); form.id = 'categoryForm'; form.addEventListener('submit', event => this.saveCategory(event, categoryId));
        const labelGroup = make('div', 'form-group'); const label = document.createElement('input'); label.type = 'text'; label.name = 'label'; label.value = category?.label || ''; label.required = true; labelGroup.append(make('label', '', 'Category Name *'), label);
        const iconGroup = make('div', 'form-group'); const iconInput = document.createElement('input'); iconInput.type = 'text'; iconInput.name = 'icon'; iconInput.id = 'categoryIcon'; iconInput.value = category?.icon || 'folder'; iconGroup.append(make('label', '', 'Icon'), iconInput);
        const visible = make('label', 'checkbox-label'); const visibleInput = document.createElement('input'); visibleInput.type = 'checkbox'; visibleInput.className = 'elistly-checkbox'; visibleInput.name = 'visibleInDashboard'; visibleInput.checked = category?.visibleInDashboard !== false; visible.append(visibleInput, make('span', '', 'Show in Dashboard'));
        form.append(labelGroup, iconGroup, visible);
        if (category) {
          const types = make('div', 'category-entity-types-checkboxes');
          types.appendChild(make('h4', '', 'Entity types in this category'));
          Object.values(this.data.entityTypes || {}).forEach(type => { const row = make('label', 'checkbox-label category-entity-type-option'); const input = document.createElement('input'); input.type = 'checkbox'; input.className = 'elistly-checkbox'; input.name = `entityType_${type.id}`; input.value = '1'; input.checked = this.getEntityTypeCategoryIds(type).includes(categoryId); row.append(input, make('span', '', type.label || type.id || '')); types.appendChild(row); });
          form.appendChild(types);
        }
        const actions = make('div', 'modal-actions'); const cancel = make('button', 'btn btn-secondary', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', () => this.closeCategoryForm()); const save = make('button', 'btn btn-primary', category ? 'Save' : 'Create'); save.type = 'submit'; actions.append(cancel, save); form.appendChild(actions); content.append(close, header, form); modal.appendChild(content); document.body.appendChild(modal); this.showModal('categoryFormModal');
      },
      
      closeCategoryForm() {
        this.closeModal('categoryFormModal');
      },
      
      saveCategory(event, categoryId) {
        event.preventDefault();
        const form = event.target;
        const formData = new FormData(form);
        const data = {
          label: formData.get('label'),
          icon: formData.get('icon'),
          visibleInDashboard: formData.get('visibleInDashboard') === 'on'
        };
        
        let resolvedCategoryId = categoryId;
        if (categoryId) {
          this.data.categories[categoryId] = { ...this.data.categories[categoryId], ...data };
        } else {
          resolvedCategoryId = this.generateId();
          this.data.categories[resolvedCategoryId] = { id: resolvedCategoryId, ...data };
        }
        
        Object.keys(this.data.entityTypes || {}).forEach(typeId => {
          const type = this.data.entityTypes[typeId];
          let cats = this.getEntityTypeCategoryIds(type);
          const checked = formData.get(`entityType_${typeId}`) === '1';
          if (checked && !cats.includes(resolvedCategoryId)) type.categories = [...cats, resolvedCategoryId];
          else if (!checked && cats.includes(resolvedCategoryId)) type.categories = cats.filter(c => c !== resolvedCategoryId);
        });
        
        this.saveData();
        this.closeCategoryForm();
        this.closeCategoryManager();
        this.renderSidebar();
        this.loadView('dashboard');
        this.showNotification(`Category ${categoryId ? 'updated' : 'created'} successfully`, 'success');
      },
      
      editCategory(categoryId) {
        this.showCategoryForm(categoryId);
      },
      
      deleteCategory(categoryId) {
        const currentCategory = this.data.categories[categoryId];
        if (Array.isArray(currentCategory?.presetIds) && currentCategory.presetIds.length) {
          return this.setCategoryEnabled(categoryId, false);
        }
        const category = this.data.categories[categoryId]; if (!category) return;
        const make = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = text; return el; };
        const modal = make('div', 'modal'); modal.id = 'confirmDeleteCategoryModal'; const content = make('div', 'modal-content'); const close = make('button', 'modal-close', '×'); close.type = 'button'; close.addEventListener('click', () => this.closeModal('confirmDeleteCategoryModal'));
        const header = make('div', 'modal-header'); header.appendChild(make('h3', '', 'Confirm Delete Category')); const message = make('p', '', `Are you sure you want to delete the category "${category.label || category.id || ''}"?`);
        const actions = make('div', 'modal-actions'); const cancel = make('button', 'btn btn-secondary', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', () => this.closeModal('confirmDeleteCategoryModal')); const remove = make('button', 'btn btn-danger', 'Delete'); remove.type = 'button'; remove.addEventListener('click', () => this.confirmDeleteCategory(categoryId)); actions.append(cancel, remove); content.append(close, header, message, actions); modal.appendChild(content); document.body.appendChild(modal); this.showModal('confirmDeleteCategoryModal');
      },
      
      confirmDeleteCategory(categoryId) {
        const category = this.data.categories[categoryId];
        if (Array.isArray(category?.presetIds) && category.presetIds.length) {
          const modal = document.getElementById('confirmDeleteCategoryModal');
          if (modal) modal.remove();
          return this.setCategoryEnabled(categoryId, false);
        }
        // Delete all entities in this category
        Object.entries(this.data.entities).forEach(([entityId, entity]) => {
          if (this.getEntityTypeCategoryIds(this.data.entityTypes[entity.type]).includes(categoryId)) {
            delete this.data.entities[entityId];
          }
        });
        
        // Delete the category
        delete this.data.categories[categoryId];
        
        this.saveData();
        document.getElementById('confirmDeleteCategoryModal').remove();
        this.closeCategoryManager();
        this.renderSidebar();
        this.loadView('dashboard');
        this.showNotification('Category deleted successfully', 'success');
      },
      
      showIconPicker(targetInputId) {
        const iconPickerModal = document.getElementById('iconPickerModal');
        if (iconPickerModal) {
          iconPickerModal.style.display = 'flex';
          
          // Add click handlers to icon options
          const iconOptions = iconPickerModal.querySelectorAll('.icon-option');
          iconOptions.forEach(option => {
            option.onclick = () => {
              const icon = option.dataset.icon;
              document.getElementById(targetInputId).value = icon;
              const iconPreview = document.querySelector('.icon-select .material-icons');
              if (iconPreview) {
                iconPreview.textContent = icon;
              }
              this.closeIconPicker();
            };
          });
        }
      },
      
      closeIconPicker() {
        this.closeModal('iconPickerModal');
      },
      
      generateAutoName(entityType, data, currentId) {
        const type = this.data.entityTypes[entityType];
        if (!type || !type.enableNameGen) return '';

        let name = this.buildAutoNameBase(entityType, data);
        if (!name) return '';
        const excludeId = currentId || data.id;

        // Check if we need to add a suffix (exclude current entity)
        const baseNameEntities = Object.values(this.data.entities)
          .filter(e => e.type === entityType && e.id !== excludeId && this.buildAutoNameBase(entityType, e) === name);

        if (baseNameEntities.length > 0) {
          // We need to add a suffix
          if (type.nameGen.suffixType === 'number') {
            let suffix = 1;
            let suffixName;
            do {
              suffixName = name + suffix.toString().padStart(2, '0');
              suffix++;
            } while (baseNameEntities.some(e => e.autoName === suffixName));
            name = suffixName;
          } else if (type.nameGen.suffixType === 'letter') {
            let suffix = 'A';
            let suffixName;
            do {
              suffixName = name + suffix;
              suffix = String.fromCharCode(suffix.charCodeAt(0) + 1);
            } while (baseNameEntities.some(e => e.autoName === suffixName) && suffix <= 'Z');
            name = suffixName;
          }
        }

        return name;
      },

      buildAutoNameBase(entityType, data) {
        const type = this.data.entityTypes[entityType];
        if (!type || !type.enableNameGen) return '';

        const prefixEnabled = type.nameGen?.prefixEnabled !== false;
        const prefix = prefixEnabled ? (type.nameGen?.prefix || '') : '';
        const componentsOrder = Array.isArray(type.nameGen?.componentsOrder) ? type.nameGen.componentsOrder : [];
        const fields = Array.isArray(type.fields) ? type.fields : [];
        const associations = Array.isArray(type.associations) ? type.associations : [];
        const fieldMap = new Map(fields.map(f => [f.name, f]));
        const assocMap = new Map(associations.map(a => [a.name, a]));
        const components = componentsOrder.length
          ? componentsOrder
          : [
              ...fields.filter(f => f.partOfName).map(f => ({ type: 'field', name: f.name })),
              ...associations.filter(a => a.partOfName).map(a => ({ type: 'association', name: a.name }))
            ];

        const parts = [];
        let pendingSeparator = null;
        components.forEach((component) => {
          if (typeof component === 'string') {
            const field = fieldMap.get(component);
            const value = field && field.partOfName ? data[field.name] : '';
            if (value) {
              if (parts.length > 0 && pendingSeparator != null) {
                parts.push(pendingSeparator);
              }
              pendingSeparator = null;
              const option = field.options?.find(opt => opt.value === value);
              parts.push(option && option.nameValue ? option.nameValue : value);
            }
            return;
          }
          if (component && component.type === 'separator') {
            pendingSeparator = component.value != null ? String(component.value) : '';
            return;
          }
          if (component && component.type === 'field') {
            const field = fieldMap.get(component.name);
            if (!field || !field.partOfName) return;
            const value = data[field.name];
            if (!value) return;
            if (parts.length > 0 && pendingSeparator != null) {
              parts.push(pendingSeparator);
            }
            pendingSeparator = null;
            const option = field.options?.find(opt => opt.value === value);
            parts.push(option && option.nameValue ? option.nameValue : value);
            return;
          }
          if (component && component.type === 'association') {
            const assoc = assocMap.get(component.name);
            if (!assoc || !assoc.partOfName) return;
            const linkedId = data[component.name];
            if (!linkedId) return;
            const linkedName = this.getEntityDisplayName(linkedId);
            if (!linkedName) return;
            if (parts.length > 0 && pendingSeparator != null) {
              parts.push(pendingSeparator);
            }
            pendingSeparator = null;
            parts.push(linkedName);
          }
        });

        return prefix + parts.join('');
      },

      normalizeNameComponents() {
        let changed = false;
        Object.values(this.data.entityTypes || {}).forEach(type => {
          if (!Array.isArray(type.fields)) return;
          const entities = Object.values(this.data.entities || {}).filter(entity => entity.type === type.id);
          const toCamel = (label) => {
            const parts = (label || '').toString().trim().split(/[^a-zA-Z0-9]+/).filter(Boolean);
            if (!parts.length) return '';
            return parts
              .map((part, idx) => {
                const lower = part.toLowerCase();
                if (idx === 0) return lower;
                return lower.charAt(0).toUpperCase() + lower.slice(1);
              })
              .join('');
          };
          const hasAnyValue = (key) => entities.some(entity => entity[key] != null && entity[key] !== '');
          const moveEntityField = (fromKey, toKey) => {
            entities.forEach(entity => {
              if (entity[fromKey] != null && entity[fromKey] !== '' && (entity[toKey] == null || entity[toKey] === '')) {
                entity[toKey] = entity[fromKey];
                delete entity[fromKey];
                changed = true;
              }
            });
          };
          const nameSet = new Set(type.fields.map(field => field.name).filter(Boolean));
          type.fields.forEach(field => {
            const current = (field.name || '').toString();
            const candidate = toCamel(field.label);
            if (!current && candidate && !nameSet.has(candidate)) {
              field.name = candidate;
              nameSet.add(candidate);
              changed = true;
              return;
            }
            if (current && !hasAnyValue(current) && candidate && candidate !== current && !nameSet.has(candidate) && hasAnyValue(candidate)) {
              const oldName = current;
              field.name = candidate;
              nameSet.delete(oldName);
              nameSet.add(candidate);
              if (Array.isArray(type.nameGen?.componentsOrder)) {
                type.nameGen.componentsOrder = type.nameGen.componentsOrder.map(item => {
                  if (typeof item === 'string' && item === oldName) return candidate;
                  if (item && item.type === 'field' && item.name === oldName) return { ...item, name: candidate };
                  return item;
                });
              }
              moveEntityField(oldName, candidate);
              changed = true;
            }
          });
          if (!type.enableNameGen) return;
          const fields = type.fields.filter(f => f.partOfName);
          const associations = (type.associations || []).filter(a => a.partOfName && a.name);
          const fieldNames = new Set(fields.map(f => f.name));
          const associationNames = new Set(associations.map(a => a.name));
          const order = Array.isArray(type.nameGen?.componentsOrder) ? type.nameGen.componentsOrder : [];
          if (order.length === 0) return;

          const remainingFields = new Set(fieldNames);
          const remainingAssociations = new Set(associationNames);
          const normalized = [];
          for (let i = 0; i < order.length; i++) {
            const item = order[i];
            const nextFieldExists = (() => {
              for (let j = i + 1; j < order.length; j++) {
                const next = order[j];
                if (next && next.type === 'field' && fieldNames.has(next.name)) return true;
                if (typeof next === 'string' && fieldNames.has(next)) return true;
                if (next && next.type === 'association' && associationNames.has(next.name)) return true;
              }
              return remainingFields.size > 0 || remainingAssociations.size > 0;
            })();
            if (item && item.type === 'separator') {
              const last = normalized[normalized.length - 1];
              if (!last || (last.type !== 'field' && last.type !== 'association') || !nextFieldExists) continue;
              normalized.push({ type: 'separator', value: item.value });
              continue;
            }
            if (item && item.type === 'association') {
              if (item.name && associationNames.has(item.name)) {
                normalized.push({ type: 'association', name: item.name });
                remainingAssociations.delete(item.name);
              }
              continue;
            }
            const fieldName = typeof item === 'string' ? item : item?.name;
            if (fieldName && fieldNames.has(fieldName)) {
              normalized.push({ type: 'field', name: fieldName });
              remainingFields.delete(fieldName);
            }
          }
          fields.forEach(field => {
            if (remainingFields.has(field.name)) {
              normalized.push({ type: 'field', name: field.name });
            }
          });
          associations.forEach(assoc => {
            if (remainingAssociations.has(assoc.name)) {
              normalized.push({ type: 'association', name: assoc.name });
            }
          });
          if (!normalized.some(item => item.type === 'field' || item.type === 'association') && (fields.length > 0 || associations.length > 0)) {
            normalized.length = 0;
            fields.forEach(field => normalized.push({ type: 'field', name: field.name }));
            associations.forEach(assoc => normalized.push({ type: 'association', name: assoc.name }));
          }
          if (fieldNames.has('firstName') && fieldNames.has('lastName')) {
            const firstIdx = normalized.findIndex(i => i.type === 'field' && i.name === 'firstName');
            const lastIdx = normalized.findIndex(i => i.type === 'field' && i.name === 'lastName');
            if (firstIdx !== -1 && lastIdx !== -1) {
              const between = normalized.slice(Math.min(firstIdx, lastIdx) + 1, Math.max(firstIdx, lastIdx));
              const hasSeparatorBetween = between.some(i => i.type === 'separator');
              if (!hasSeparatorBetween) {
                normalized.splice(firstIdx + 1, 0, { type: 'separator', value: ' ' });
              }
            }
          }
          if (normalized.length && normalized[0]?.type === 'separator') {
            normalized.shift();
          }
          if (normalized.length && normalized[normalized.length - 1]?.type === 'separator') {
            normalized.pop();
          }
          if (JSON.stringify(type.nameGen.componentsOrder) !== JSON.stringify(normalized)) {
            type.nameGen.componentsOrder = normalized;
            changed = true;
          }
        });
        return changed;
      },

      normalizeEntityTypeSchema() {
        let changed = false;
        Object.values(this.data.entityTypes || {}).forEach(type => {
          if (!type || typeof type !== 'object') return;
          if (!type.nameGen || typeof type.nameGen !== 'object') {
            type.nameGen = { prefix: '', prefixEnabled: false, partOfNamePrefix: false, suffixType: 'number', componentsOrder: [] };
            changed = true;
          }
          if (type.nameGen.prefixEnabled === undefined) {
            type.nameGen.prefixEnabled = !!(type.nameGen.prefix && String(type.nameGen.prefix).trim());
            changed = true;
          }
          if ('useAutoNameAsTitle' in type) {
            delete type.useAutoNameAsTitle;
            changed = true;
          }
          if (Array.isArray(type.fields)) {
            type.fields = type.fields.map(field => {
              if (!field || typeof field !== 'object') return field;
              const next = { ...field };
              if ('useAsTitle' in next) {
                delete next.useAsTitle;
                changed = true;
              }
              return next;
            });
          }
          if (Array.isArray(type.associations)) {
            type.associations = type.associations.map(assoc => {
              if (!assoc || typeof assoc !== 'object') return assoc;
              const next = { ...assoc };
              if (next.required === undefined) {
                next.required = false;
                changed = true;
              }
              if (next.visibleInCard === undefined) {
                next.visibleInCard = false;
                changed = true;
              }
              if (next.partOfName === undefined) {
                next.partOfName = false;
                changed = true;
              }
              return next;
            });
          }
        });
        return changed;
      },
      
      showEntityTypeManager() {
        // Remote/legacy blank workspaces may not have catalog entries materialized yet.
        // Populate them before rendering so this screen is always the source of truth.
        if (this.normalizeActivationState()) this.saveData();
        const make = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = text; return el; };
        const icon = (name) => make('span', 'material-icons', name);
        const modal = make('div', 'modal'); modal.id = 'entityTypeManagerModal'; const content = make('div', 'modal-content');
        const close = make('button', 'modal-close', '×'); close.type = 'button'; close.addEventListener('click', () => this.closeModal('entityTypeManagerModal'));
        const header = make('div', 'modal-header'); header.appendChild(make('h3', '', 'Manage Entity Types'));
        const body = make('div', 'modal-body modal-body-no-top'); const list = make('div', 'entity-type-list');
        Object.values(this.data.entityTypes || {}).forEach(type => {
          const row = make('div', 'category-item entity-type-row'); const info = make('div', 'category-info'); info.append(icon(type.icon || 'folder'), make('span', '', type.label || type.id || ''));
          const actions = make('div', 'category-actions');
          const edit = make('button', 'btn btn-secondary'); edit.type = 'button'; edit.title = 'Edit'; edit.appendChild(icon('edit')); edit.addEventListener('click', () => this.editEntityType(type.id));
          const isBuiltIn = Array.isArray(type.presetIds) && type.presetIds.length > 0;
          const remove = make('button', isBuiltIn ? 'btn btn-secondary' : 'btn btn-danger'); remove.type = 'button';
          if (isBuiltIn) {
            const enabling = type.enabled === false;
            remove.title = enabling ? 'Enable' : 'Disable';
            remove.append(icon(enabling ? 'visibility' : 'visibility_off'), make('span', '', enabling ? 'Enable' : 'Disable'));
            remove.addEventListener('click', () => {
              this.closeModal('entityTypeManagerModal');
              this.setEntityTypeEnabled(type.id, enabling);
              if (!enabling) this.showEntityTypeManager();
            });
          } else {
            remove.title = 'Delete';
            remove.appendChild(icon('delete'));
            remove.addEventListener('click', () => this.deleteEntityType(type.id));
          }
          actions.append(edit, remove); row.append(info, actions); list.appendChild(row);
        });
        body.appendChild(list); const footer = make('div', 'modal-actions modal-actions-wrap');
        const templateMenu = make('div', 'dropdown-menu dropdown-menu-scroll hidden');
        ['it', 'library', 'staff', 'property'].forEach(presetKey => {
          const preset = this._presets[presetKey];
          Object.entries(preset?.entityTypes || {}).forEach(([typeId, template]) => { const link = make('button', 'template-type-link', template.label || typeId); link.type = 'button'; link.addEventListener('click', () => this.addEntityTypeFromTemplate(presetKey, typeId)); templateMenu.appendChild(link); });
        });
        const templateToggle = make('button', 'btn btn-secondary', 'Add from template'); templateToggle.type = 'button'; templateToggle.prepend(icon('content_copy')); templateToggle.addEventListener('click', () => templateMenu.classList.toggle('hidden'));
        const templateWrap = make('div', 'dropdown'); templateWrap.append(templateToggle, templateMenu);
        const add = make('button', 'btn btn-primary', 'New entity type'); add.type = 'button'; add.prepend(icon('add')); add.addEventListener('click', () => this.showEntityTypeForm()); footer.append(templateWrap, add);
        content.append(close, header, body, footer); modal.appendChild(content); document.body.appendChild(modal);
        this.showModal('entityTypeManagerModal');
      },

      
      showEntityTypeForm() {
        const categoryIds = Object.keys(this.data.categories);
        if (categoryIds.length === 0) {
          this.showNotification('Add a category first (Settings → Manage Categories)', 'info');
          return;
        }
        const firstCategoryId = categoryIds[0];
        const emptyType = {
          label: '',
          category: firstCategoryId,
          icon: 'folder',
          enableNameGen: false,
          nameGen: { prefix: '', prefixEnabled: false, partOfNamePrefix: false, suffixType: 'number', componentsOrder: [] },
          fields: [],
          associations: []
        };
        this.editEntityType('', emptyType);
      },

      addEntityTypeFromTemplate(presetKey, typeId) {
        const preset = this._presets[presetKey];
        const type = preset && preset.entityTypes && preset.entityTypes[typeId];
        if (!type) return;
        const cloned = JSON.parse(JSON.stringify(type));
        cloned.id = this.generateId();
        const targetCategoryId = this.data.categories[type.category] ? type.category : null;
        if (targetCategoryId) {
          cloned.category = targetCategoryId;
        } else if (preset.categories && preset.categories[type.category]) {
          this.data.categories[type.category] = JSON.parse(JSON.stringify(preset.categories[type.category]));
          cloned.category = type.category;
        } else {
          const categoryIds = Object.keys(this.data.categories);
          if (categoryIds.length === 0) {
            this.showNotification('Add a category first (Settings → Manage Categories)', 'info');
            return;
          }
          cloned.category = categoryIds[0];
        }
        cloned.label = cloned.label + ' (copy)';
        this.data.entityTypes[cloned.id] = cloned;
        this.saveData();
        this.closeModal('entityTypeManagerModal');
        this.renderSidebar();
        this.loadView('dashboard');
        this.showNotification(`Added "${type.label}" from template`, 'success');
      },

      editEntityType(typeId, typeDataOverride) {
        const type = typeDataOverride || this.data.entityTypes[typeId];
        if (!type) return;
        if (!type.nameGen) type.nameGen = { prefix: '', prefixEnabled: false, partOfNamePrefix: false, suffixType: 'number', componentsOrder: [] };
        if (type.nameGen.prefixEnabled === undefined) type.nameGen.prefixEnabled = !!(type.nameGen.prefix && String(type.nameGen.prefix).trim());
        this._editingEntityType = typeDataOverride || null;
        if (!typeDataOverride) {
          const changed = this.normalizeNameComponents();
          if (changed) this.saveData();
        }
        const make = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = text; return el; };
        const input = (name, value, typeName = 'text') => { const el = document.createElement('input'); el.type = typeName; el.name = name; el.value = value == null ? '' : String(value); return el; };
        const checkbox = (name, checked, text, disabled = false) => { const label = make('label', 'checkbox-label'); const el = input(name, 'on', 'checkbox'); el.className = 'elistly-checkbox'; el.checked = !!checked; el.disabled = disabled; label.append(el, make('span', '', text)); return label; };
        const button = (text, className = 'btn btn-secondary') => { const el = make('button', className, text); el.type = 'button'; return el; };
        const modal = make('div', 'modal'); modal.id = 'entityTypeFormModal'; const content = make('div', 'modal-content'); const body = make('div', 'modal-body');
        const form = make('form'); form.id = 'entityTypeForm'; form.dataset.typeId = typeId || ''; form.addEventListener('submit', event => this.saveEntityType(event, typeId));
        const fields = make('div', 'sortable-list'); fields.id = 'fieldsContainer'; const associations = make('div', 'sortable-list'); associations.id = 'associationsContainer';
        const components = make('div', 'sortable-list'); components.id = 'nameComponentsList'; const preview = make('div', 'preview-value'); preview.id = 'namePreview'; const suffixPreview = make('div', 'preview-value'); suffixPreview.id = 'suffixPreview';
        const renumber = (container, prefix) => container.querySelectorAll(prefix === 'fields' ? '.field-card' : '.assoc-card').forEach((card, index) => { card.dataset.index = index; card.querySelectorAll('[name]').forEach(el => { el.name = el.name.replace(new RegExp(`${prefix}\\[\\d+\\]`), `${prefix}[${index}]`); }); });
        const updatePreview = () => {
          const prefixEnabled = form.querySelector('[name="prefixEnabled"]').checked;
          const prefix = prefixEnabled ? form.querySelector('[name="namePrefix"]').value : '';
          const values = [];
          components.querySelectorAll('.name-component-item').forEach(item => {
            if (item.dataset.componentType === 'separator') values.push(decodeURIComponent(item.dataset.separatorValue || ''));
            else values.push(item.querySelector('.name-component-label').textContent);
          });
          const value = prefix + values.join(''); preview.textContent = value || 'No name components selected'; suffixPreview.textContent = value ? value + (form.querySelector('[name="suffixType"]').value === 'letter' ? 'A' : '01') : 'No name components selected';
        };
        const syncComponents = () => {
          const prior = [...components.querySelectorAll('.name-component-item')].map(item => ({ type: item.dataset.componentType, name: item.dataset.fieldName || item.dataset.associationName, value: item.dataset.separatorValue }));
          const fieldCards = [...fields.querySelectorAll('.field-card')].filter(card => card.querySelector('input[name$=".partOfName"]').checked);
          const assocCards = [...associations.querySelectorAll('.assoc-card')].filter(card => card.querySelector('input[name$=".partOfName"]').checked);
          const candidates = new Map([...fieldCards.map(card => [`field:${card.querySelector('input[name$=".name"]').value}`, card]), ...assocCards.map(card => [`association:${card.querySelector('input[name$=".name"]').value}`, card])]);
          components.replaceChildren();
          const appendComponent = (kind, card) => { const row = make('div', 'name-component-item sortable-item'); row.dataset.componentType = kind; const nameInput = card.querySelector(`input[name$=".name"]`); const labelInput = card.querySelector(`input[name$=".label"]`); const name = nameInput.value || labelInput.value.toLowerCase().replace(/[^a-z0-9]+/g, '_'); nameInput.value = name; if (kind === 'field') row.dataset.fieldName = name; else row.dataset.associationName = name; row.append(make('span', 'material-icons drag-handle', 'drag_indicator'), make('span', 'name-component-label', labelInput.value || name)); components.appendChild(row); };
          prior.forEach(item => { if (item.type === 'separator') addSeparator(decodeURIComponent(item.value || '')); else { const card = candidates.get(`${item.type}:${item.name}`); if (card) { appendComponent(item.type, card); candidates.delete(`${item.type}:${item.name}`); } } });
          candidates.forEach((card, key) => appendComponent(key.split(':')[0], card)); updatePreview();
        };
        const addSeparator = value => { if (!value) return; const row = make('div', 'name-component-item name-separator-item sortable-item'); row.dataset.componentType = 'separator'; row.dataset.separatorValue = encodeURIComponent(value); const remove = button('Remove', 'btn btn-secondary btn-sm'); remove.addEventListener('click', () => { row.remove(); updatePreview(); }); row.append(make('span', 'material-icons drag-handle', 'drag_indicator'), make('span', 'separator-pill', value === ' ' ? 'Space' : value), remove); const fieldComponents = [...components.querySelectorAll('[data-component-type="field"]')]; if (fieldComponents.length >= 2) components.insertBefore(row, fieldComponents[1]); else if (fieldComponents.length === 1) components.insertBefore(row, fieldComponents[0].nextSibling); else components.appendChild(row); };
        const renderOptions = (card, index, options = []) => {
          card.querySelector('.field-options')?.remove(); if (card.querySelector('select[name$=".type"]').value !== 'dropdown') return;
          const group = make('div', 'form-group field-options'); group.appendChild(make('label', '', 'Options')); const container = make('div', 'option-rows-container'); container.dataset.fieldIndex = index;
          const appendOption = option => { const row = make('div', 'option-row'); const value = input(`fields[${index}].options[0].value`, option.value || ''); const nameValue = input(`fields[${index}].options[0].nameValue`, option.nameValue || ''); const remove = button('Remove', 'btn btn-danger'); remove.addEventListener('click', () => { row.remove(); renumberOptions(); }); row.append(value, nameValue, remove); container.appendChild(row); };
          const renumberOptions = () => container.querySelectorAll('.option-row').forEach((row, optionIndex) => { row.dataset.optionIndex = optionIndex; row.querySelectorAll('[name]').forEach(el => { el.name = el.name.replace(/options\[\d+\]/, `options[${optionIndex}]`); }); });
          (options.length ? options : [{ value: '', nameValue: '' }]).forEach(appendOption); const add = button('Add Option', 'btn btn-secondary btn-add-field'); add.addEventListener('click', () => { appendOption({}); renumberOptions(); }); group.append(container, add); card.appendChild(group); renumberOptions();
        };
        const nameGenerationEnabled = () => form.querySelector('[name="enableNameGen"]')?.checked ?? !!type.enableNameGen;
        const addField = field => { const index = fields.querySelectorAll('.field-card').length; const card = make('div', 'field-card sortable-item'); card.dataset.index = index; const fieldLabel = input(`fields[${index}].label`, field.label || ''); fieldLabel.required = true; const fieldName = input(`fields[${index}].name`, field.name || '', 'hidden'); const kind = document.createElement('select'); kind.name = `fields[${index}].type`; ['text','number','dropdown','textarea','date','checkbox','qr'].forEach(value => kind.appendChild(new Option(value, value, false, (field.type || 'text') === value))); const part = checkbox(`fields[${index}].partOfName`, field.partOfName, 'In title', !nameGenerationEnabled()); part.querySelector('input').addEventListener('change', syncComponents); const remove = button('Remove Field', 'btn btn-danger'); remove.addEventListener('click', () => { card.remove(); renumber(fields, 'fields'); syncComponents(); }); kind.addEventListener('change', () => renderOptions(card, Number(card.dataset.index))); fieldLabel.addEventListener('input', () => { if (!fieldName.value) fieldName.value = fieldLabel.value.toLowerCase().replace(/[^a-z0-9]+/g, '_'); syncComponents(); }); card.append(make('div', 'form-group', 'Label *'), fieldLabel, fieldName, kind, checkbox(`fields[${index}].required`, field.required, 'Required'), checkbox(`fields[${index}].visibleInCard`, field.visibleInCard, 'Visible in card'), part, remove); fields.appendChild(card); renderOptions(card, index, field.options || []); };
        const addAssociation = assoc => { const index = associations.querySelectorAll('.assoc-card').length; const card = make('div', 'assoc-card association-editor sortable-item'); card.dataset.index = index; const label = input(`associations[${index}].label`, assoc.label || ''); label.required = true; const name = input(`associations[${index}].name`, assoc.name || '', 'hidden'); const kind = document.createElement('select'); kind.name = `associations[${index}].association.kind`; ['belongs_to','has_many','hierarchy'].forEach(value => kind.appendChild(new Option(value, value, false, (assoc.association?.kind || 'belongs_to') === value))); const target = document.createElement('select'); target.name = `associations[${index}].association.targetType`; Object.values(this.data.entityTypes || {}).forEach(candidate => target.appendChild(new Option(candidate.label || candidate.id || '', candidate.id || '', false, assoc.association?.targetType === candidate.id))); const part = checkbox(`associations[${index}].partOfName`, assoc.partOfName, 'In title', !nameGenerationEnabled()); part.querySelector('input').addEventListener('change', syncComponents); const remove = button('Remove link', 'btn btn-danger'); remove.addEventListener('click', () => { card.remove(); renumber(associations, 'associations'); syncComponents(); }); label.addEventListener('input', () => { if (!name.value) name.value = label.value.toLowerCase().replace(/[^a-z0-9]+/g, '_'); syncComponents(); }); card.append(make('div', 'form-group', 'Label *'), label, name, kind, target, checkbox(`associations[${index}].required`, assoc.required, 'Required'), checkbox(`associations[${index}].visibleInCard`, assoc.visibleInCard, 'Visible in card'), part, remove); associations.appendChild(card); };
        const close = button('×', 'modal-close'); close.addEventListener('click', () => this.closeEntityTypeForm()); const header = make('div', 'modal-header'); header.appendChild(make('h3', '', typeId ? type.label || '' : 'New entity type'));
        const basics = make('div', 'entity-type-editor carded-section'); const label = input('label', type.label || ''); label.required = true; const iconInput = input('icon', type.icon || 'folder', 'hidden'); iconInput.id = 'entityTypeIcon'; const iconPicker = button('Choose icon'); iconPicker.addEventListener('click', () => this.showIconPicker('entityTypeIcon')); basics.append(make('label', '', 'Label *'), label, iconInput, iconPicker);
        Object.values(this.data.categories || {}).forEach(category => basics.appendChild(checkbox(`category_${category.id}`, this.getEntityTypeCategoryIds(type).includes(category.id), category.label || category.id || '')));
        const nameEnabled = checkbox('enableNameGen', type.enableNameGen, 'Enable title generator'); nameEnabled.querySelector('input').setAttribute('role', 'switch'); const nameSection = make('div', `name-generation-settings${type.enableNameGen ? '' : ' hidden'}`); const prefixEnabled = checkbox('prefixEnabled', type.nameGen?.prefixEnabled, 'Use prefix'); const prefix = input('namePrefix', type.nameGen?.prefix || ''); prefix.disabled = !type.nameGen?.prefixEnabled; const suffix = document.createElement('select'); suffix.name = 'suffixType'; ['number','letter'].forEach(value => suffix.appendChild(new Option(value === 'number' ? 'Numbers (1, 2, 3...)' : 'Letters (A, B, C...)', value, false, type.nameGen?.suffixType === value))); const separatorActions = make('div', 'name-separator-actions'); [' ','-','_','.'].forEach(value => { const add = button(value === ' ' ? 'Space' : value, 'btn btn-secondary btn-sm'); add.addEventListener('click', () => { addSeparator(value); updatePreview(); }); separatorActions.appendChild(add); }); const customSeparator = input('', ''); customSeparator.id = 'customSeparatorInput'; customSeparator.placeholder = 'Custom separator'; const insertCustomSeparator = button('Insert', 'btn btn-secondary btn-sm'); insertCustomSeparator.addEventListener('click', () => { const value = customSeparator.value; addSeparator(value); customSeparator.value = ''; updatePreview(); }); const customSeparatorControls = make('div', 'custom-separator'); customSeparatorControls.append(customSeparator, insertCustomSeparator); separatorActions.appendChild(customSeparatorControls); nameSection.append(prefixEnabled, prefix, suffix, components, separatorActions, preview, suffixPreview); nameEnabled.querySelector('input').addEventListener('change', event => { nameSection.classList.toggle('hidden', !event.target.checked); fields.querySelectorAll('input[name$=".partOfName"], input[name$=".partOfName"]').forEach(el => { el.disabled = !event.target.checked; }); associations.querySelectorAll('input[name$=".partOfName"]').forEach(el => { el.disabled = !event.target.checked; }); syncComponents(); }); prefixEnabled.querySelector('input').addEventListener('change', event => { prefix.disabled = !event.target.checked; updatePreview(); }); prefix.addEventListener('input', updatePreview); suffix.addEventListener('change', updatePreview);
        const fieldSection = make('div', 'modal-group carded-section'); fieldSection.append(make('h4', '', 'Fields'), fields); const addFieldButton = button('Add Field', 'btn btn-add-field'); addFieldButton.addEventListener('click', () => addField({ type: 'text', visibleInCard: true })); fieldSection.appendChild(addFieldButton); const assocSection = make('div', 'modal-group carded-section'); assocSection.append(make('h4', '', 'Links'), associations); const addAssociationButton = button('Add link', 'btn btn-add-field'); addAssociationButton.addEventListener('click', () => addAssociation({ association: { kind: 'belongs_to', targetType: Object.keys(this.data.entityTypes || {})[0] || '' } })); assocSection.appendChild(addAssociationButton);
        (type.fields || []).forEach(addField); (type.associations || []).forEach(addAssociation); (type.nameGen?.componentsOrder || []).forEach(component => { const row = make('div', 'name-component-item sortable-item'); row.dataset.componentType = component.type || 'field'; if (component.type === 'separator') row.dataset.separatorValue = encodeURIComponent(component.value || ''); else if (component.type === 'association') row.dataset.associationName = component.name || ''; else row.dataset.fieldName = component.name || component || ''; components.appendChild(row); }); basics.append(nameEnabled, nameSection); form.append(basics, fieldSection, assocSection); const footer = make('div', 'modal-actions'); const cancel = button('Cancel'); cancel.addEventListener('click', () => this.closeEntityTypeForm()); const save = button('Save Changes', 'btn btn-primary'); save.type = 'submit'; save.setAttribute('form', form.id); footer.append(cancel, save); content.append(close, header, body); body.append(form, footer); modal.appendChild(content); document.body.appendChild(modal); syncComponents(); this.showModal('entityTypeFormModal'); if (window.Sortable) this.initNameComponentsDragDrop();
      },

      saveEntityType(event, typeId) {
        event.preventDefault();
        const form = event.target;
        const formData = new FormData(form);
        
        // Process fields and associations separately
        const fields = this.processFieldsData(formData, this.data.entityTypes[typeId]?.fields || []);
        const associations = this.processAssociationsData(formData);
        
        const categories = Object.keys(this.data.categories || {}).filter(catId => formData.has(`category_${catId}`));
        const data = {
          label: formData.get('label'),
          categories: categories,
          icon: formData.get('icon'),
          enableNameGen: formData.get('enableNameGen') === 'on',
          nameGen: {
            prefixEnabled: formData.get('prefixEnabled') === 'on',
            prefix: formData.get('namePrefix') || '',
            partOfNamePrefix: true,
            suffixType: formData.get('suffixType') || 'number',
            componentsOrder: []
          },
          fields: fields, 
          associations: associations
        };

        if (data.enableNameGen) {
          const list = form.querySelector('#nameComponentsList');
          if (list) {
            const rawItems = Array.from(list.querySelectorAll('.name-component-item')).map(item => {
              const type = item.dataset.componentType;
              if (type === 'field') {
                const name = item.dataset.fieldName;
                return name ? { type: 'field', name } : null;
              }
              if (type === 'separator') {
                const encoded = item.dataset.separatorValue != null ? String(item.dataset.separatorValue) : '';
                const value = encoded ? decodeURIComponent(encoded) : '';
                return value ? { type: 'separator', value } : null;
              }
              if (type === 'association') {
                const name = item.dataset.associationName;
                return name ? { type: 'association', name } : null;
              }
              return null;
            }).filter(Boolean);
            const normalized = [];
            let lastWasComponent = false;
            let sawSeparator = false;
            rawItems.forEach((item, idx) => {
              if (item.type === 'field' || item.type === 'association') {
                normalized.push(item);
                lastWasComponent = true;
                return;
              }
              if (item.type === 'separator') {
                sawSeparator = true;
                if (!lastWasComponent) return;
                const hasComponentAhead = rawItems.slice(idx + 1).some(next => next.type === 'field' || next.type === 'association');
                if (!hasComponentAhead) return;
                normalized.push(item);
                lastWasComponent = false;
              }
            });
            if (sawSeparator && !normalized.some(i => i.type === 'separator')) {
              const componentCount = normalized.filter(i => i.type === 'field' || i.type === 'association').length;
              if (componentCount >= 2) {
                const firstComponentIdx = normalized.findIndex(i => i.type === 'field' || i.type === 'association');
                normalized.splice(firstComponentIdx + 1, 0, { type: 'separator', value: ' ' });
              }
            }
            data.nameGen.componentsOrder = normalized;
          }
        }
        
        if (typeId) {
          // Update existing type
          this.data.entityTypes[typeId] = {
            ...this.data.entityTypes[typeId],
            ...data
          };
        } else {
          // Create new type
          const newId = this.generateId();
          this.data.entityTypes[newId] = {
            id: newId,
            enabled: true,
            ...data
          };
        }
        this.normalizeEntityTypeCategories();
        this.saveData();
        this.closeEntityTypeForm();
        this.closeEntityTypeManager();
        this.loadView('dashboard');
        this.showNotification(`Entity type ${typeId ? 'updated' : 'created'} successfully`, 'success');
      },
      
      processFieldsData(formData, existingFields = []) {
        const fields = [];
        const entries = Array.from(formData.entries());
        
        // Group entries by field index
        const fieldGroups = {};
        entries.forEach(([key, value]) => {
          if (key.startsWith('fields[')) {
            const match = key.match(/fields\[(\d+)\]\.(.+)/);
            if (match) {
              const [, index, prop] = match;
              if (!fieldGroups[index]) fieldGroups[index] = {};
              fieldGroups[index][prop] = value;
            }
          }
        });
        
        // Process each field group (preserve index order)
        const sortedIndices = Object.keys(fieldGroups).map(Number).sort((a, b) => a - b);
        sortedIndices.forEach(i => {
          const group = fieldGroups[i];
          if (!group) return;
          const explicitName = (group.name || '').toString().trim();
          const rawName = (group.label || '').toString().toLowerCase().replace(/[^a-z0-9]+/g, '_').trim();
          const name = explicitName || rawName || ('field_' + fields.length);
          
          const field = {
            name: name,
            label: group.label,
            type: group.type,
            required: group.required === 'on',
            visibleInCard: group.visibleInCard === 'on',
            partOfName: group.partOfName === 'on'
          };

          const existingField = existingFields.find(candidate => candidate.name === name);
          if (existingField?.collection) {
            field.collection = JSON.parse(JSON.stringify(existingField.collection));
          }
          
          if (field.type === 'dropdown') {
            field.options = [];
            // Process options if they exist
            const optionEntries = entries.filter(([key]) => 
              key.startsWith(`fields[${i}].options[`));
            
            const optionGroups = {};
            optionEntries.forEach(([key, value]) => {
              const match = key.match(/options\[(\d+)\]\.(.+)/);
              if (match) {
                const [, index, prop] = match;
                if (!optionGroups[index]) optionGroups[index] = {};
                optionGroups[index][prop] = value;
              }
            });
            
            field.options = Object.values(optionGroups)
              .filter(opt => opt.value)
              .map(opt => ({
                value: opt.value,
                nameValue: opt.nameValue || opt.value
              }));
          }
          
          fields.push(field);
        });
        
        return fields;
      },
      
      processAssociationsData(formData) {
        const associations = [];
        const entries = Array.from(formData.entries());
        
        // Process associations
        const associationEntries = entries.filter(([key]) => key.startsWith('associations['));
        
        const associationGroups = {};
        associationEntries.forEach(([key, value]) => {
          const match = key.match(/associations\[(\d+)\]\.(.+)/);
          if (match) {
            const [, index, prop] = match;
            if (!associationGroups[index]) associationGroups[index] = { association: {} };
            if (prop.startsWith('association.')) {
              associationGroups[index].association[prop.split('.')[1]] = value;
            } else {
              associationGroups[index][prop] = value;
            }
          }
        });
        
        const sortedIndices = Object.keys(associationGroups).map(Number).sort((a, b) => a - b);
        sortedIndices.forEach(i => {
          const group = associationGroups[i];
          if (group.name && group.label) {
            associations.push({
              name: group.name,
              label: group.label,
              type: 'association',
              required: group.required === 'on',
              visibleInCard: group.visibleInCard === 'on',
              partOfName: group.partOfName === 'on',
              association: group.association
            });
          }
        });
        
        return associations;
      },
      
      closeEntityTypeForm() {
        this._editingEntityType = null;
        this.closeModal('entityTypeFormModal');
      },

      closeEntityTypeManager() {
        this.closeModal('entityTypeManagerModal');
      },
      
      deleteEntityType(typeId) {
        const type = this.data.entityTypes[typeId];
        if (Array.isArray(type?.presetIds) && type.presetIds.length) {
          this.setEntityTypeEnabled(typeId, false, { offerSamples: false });
          this.closeEntityTypeManager();
          return;
        }
        if (!type) return;
        const make = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = text; return el; };
        const modal = make('div', 'modal'); modal.id = 'confirmDeleteTypeModal'; const content = make('div', 'modal-content'); const close = make('button', 'modal-close', '×'); close.type = 'button'; close.addEventListener('click', () => this.closeModal('confirmDeleteTypeModal'));
        const header = make('div', 'modal-header'); header.appendChild(make('h3', '', 'Confirm Delete Type')); const message = make('p', '', `Are you sure you want to delete the entity type "${type.label || type.id || ''}"?`);
        const actions = make('div', 'modal-actions'); const cancel = make('button', 'btn btn-secondary', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', () => this.closeModal('confirmDeleteTypeModal')); const remove = make('button', 'btn btn-danger', 'Delete'); remove.type = 'button'; remove.addEventListener('click', () => this.confirmDeleteEntityType(typeId)); actions.append(cancel, remove); content.append(close, header, message, actions); modal.appendChild(content); document.body.appendChild(modal); this.showModal('confirmDeleteTypeModal');
      },

      confirmDeleteEntityType(typeId) {
        const type = this.data.entityTypes[typeId];
        if (Array.isArray(type?.presetIds) && type.presetIds.length) {
          this.closeModal('confirmDeleteTypeModal');
          this.setEntityTypeEnabled(typeId, false, { offerSamples: false });
          return;
        }
        // Delete all entities of this type
        Object.entries(this.data.entities).forEach(([entityId, entity]) => {
          if (entity.type === typeId) {
            delete this.data.entities[entityId];
          }
        });
        
        // Delete the entity type
        delete this.data.entityTypes[typeId];
        
        this.saveData();
        document.getElementById('confirmDeleteTypeModal').remove();
        this.closeEntityTypeManager();
        this.loadView('dashboard');
        this.showNotification('Entity type deleted successfully', 'success');
      },
      
      initNameComponentsDragDrop() {
        const nameComponentsList = document.getElementById('nameComponentsList');
        if (nameComponentsList) {
          new Sortable(nameComponentsList, {
            animation: 150,
            handle: '.drag-handle',
            onEnd: () => this.updateNamePreview()
          });
        }
      },

      updateNamePreview() {
        const preview = document.getElementById('namePreview');
        const suffixPreview = document.getElementById('suffixPreview');
        if (!preview || !suffixPreview) return;

        const prefixEnabled = !!document.querySelector('[name="prefixEnabled"]')?.checked;
        const prefix = prefixEnabled ? (document.querySelector('[name="namePrefix"]')?.value || '') : '';
        const suffixType = document.querySelector('[name="suffixType"]')?.value || 'number';
        const type = this.getCurrentEditingType();
        if (!type) return;

        const list = document.getElementById('nameComponentsList');
        if (!list) return;

        const fieldCards = Array.from(document.querySelectorAll('.field-card, .field-editor'));
        const activeFields = new Map();

        fieldCards.forEach((fieldCard) => {
          const partOfNameCheckbox = fieldCard.querySelector('input[name^="fields"][name$=".partOfName"]');
          if (!partOfNameCheckbox?.checked) return;
          const nameInput = fieldCard.querySelector('input[name^="fields"][name$=".name"]');
          const labelInput = fieldCard.querySelector('input[name^="fields"][name$=".label"]');
          const typeSelect = fieldCard.querySelector('select[name^="fields"][name$=".type"]');
          const fieldName = nameInput?.value || fieldCard.dataset.fieldName || '';
          if (!fieldName) return;
          activeFields.set(fieldName, {
            label: labelInput?.value || fieldName,
            type: typeSelect?.value || 'text',
            card: fieldCard
          });
        });

        const assocCards = Array.from(document.querySelectorAll('.assoc-card, .association-editor'));
        const activeAssociations = new Map();
        assocCards.forEach((assocCard) => {
          const partOfNameCheckbox = assocCard.querySelector('input[name^="associations"][name$=".partOfName"]');
          if (!partOfNameCheckbox?.checked) return;
          const nameInput = assocCard.querySelector('input[name^="associations"][name$=".name"]');
          const labelInput = assocCard.querySelector('input[name^="associations"][name$=".label"]');
          const assocName = nameInput?.value || '';
          if (!assocName) return;
          const assocLabel = (labelInput?.value || assocName).trim();
          activeAssociations.set(assocName, {
            label: assocLabel,
            sampleValue: `<${assocLabel}>`
          });
        });

        const existingFieldItems = new Map();
        list.querySelectorAll('[data-component-type="field"]').forEach(item => {
          existingFieldItems.set(item.dataset.fieldName, item);
        });
        const existingAssocItems = new Map();
        list.querySelectorAll('[data-component-type="association"]').forEach(item => {
          existingAssocItems.set(item.dataset.associationName, item);
        });

        existingFieldItems.forEach((item, fieldName) => {
          if (!activeFields.has(fieldName)) item.remove();
        });

        activeFields.forEach((field, fieldName) => {
          const item = existingFieldItems.get(fieldName);
          if (!item) {
            const div = document.createElement('div');
            div.className = 'name-component-item sortable-item';
            div.dataset.componentType = 'field';
            div.dataset.fieldName = fieldName;
            div.innerHTML = `
              <span class="material-icons drag-handle" title="Drag to reorder">drag_indicator</span>
              <span class="name-component-label">${this.escapeHtmlText(field.label)}</span>
            `;
            list.appendChild(div);
          } else {
            const labelEl = item.querySelector('.name-component-label');
            if (labelEl) labelEl.textContent = field.label;
          }
        });
        existingAssocItems.forEach((item, assocName) => {
          if (!activeAssociations.has(assocName)) item.remove();
        });
        activeAssociations.forEach((assoc, assocName) => {
          const item = existingAssocItems.get(assocName);
          if (!item) {
            const div = document.createElement('div');
            div.className = 'name-component-item sortable-item';
            div.dataset.componentType = 'association';
            div.dataset.associationName = assocName;
            div.innerHTML = `
              <span class="material-icons drag-handle" title="Drag to reorder">drag_indicator</span>
              <span class="name-component-label">${this.escapeHtmlText(assoc.label)}</span>
            `;
            list.appendChild(div);
          } else {
            const labelEl = item.querySelector('.name-component-label');
            if (labelEl) labelEl.textContent = assoc.label;
          }
        });

        const listItems = Array.from(list.querySelectorAll('.name-component-item'));
        const isComponentItem = (item) => (
          (item.dataset.componentType === 'field' && item.dataset.fieldName)
          || (item.dataset.componentType === 'association' && item.dataset.associationName)
        );
        const isSeparatorItem = (item) => item.dataset.componentType === 'separator';
        const hasComponentAhead = (startIdx) => {
          for (let i = startIdx + 1; i < listItems.length; i += 1) {
            if (isComponentItem(listItems[i])) return true;
          }
          return false;
        };
        const normalizedItems = [];
        const pendingLeadingSeparators = [];
        let seenField = false;
        listItems.forEach((item, idx) => {
          if (isComponentItem(item)) {
            normalizedItems.push(item);
            seenField = true;
            if (pendingLeadingSeparators.length && hasComponentAhead(idx)) {
              pendingLeadingSeparators.forEach(sep => normalizedItems.push(sep));
            }
            pendingLeadingSeparators.length = 0;
            return;
          }
          if (isSeparatorItem(item)) {
            if (!seenField) {
              pendingLeadingSeparators.push(item);
              return;
            }
            if (!hasComponentAhead(idx)) return;
            normalizedItems.push(item);
          }
        });
        const needsReorder = normalizedItems.length !== listItems.length
          || normalizedItems.some((item, idx) => item !== listItems[idx]);
        if (normalizedItems.length && needsReorder) {
          list.innerHTML = '';
          normalizedItems.forEach(item => list.appendChild(item));
        }
        const components = Array.from(list.querySelectorAll('.name-component-item')).map(item => {
          if (item.dataset.componentType === 'separator') {
            const encoded = item.dataset.separatorValue || '';
            return { type: 'separator', value: encoded ? decodeURIComponent(encoded) : '' };
          }
          if (item.dataset.componentType === 'association') {
            return { type: 'association', name: item.dataset.associationName };
          }
          return { type: 'field', name: item.dataset.fieldName };
        });

        const parts = [];
        let pendingSeparator = null;

        components.forEach((component) => {
          if (component.type === 'separator') {
            pendingSeparator = component.value != null ? String(component.value) : '';
            return;
          }
          let sampleValue = '';
          if (component.type === 'field') {
            const field = activeFields.get(component.name);
            if (!field) return;
            sampleValue = field.label || '';
            if (field.type === 'dropdown') {
              const optionRows = field.card.querySelectorAll('.option-row');
              if (optionRows.length > 0) {
                const lastOptionRow = optionRows[optionRows.length - 1];
                const nameValueInput = lastOptionRow?.querySelector('input[name$=".nameValue"]');
                const valueInput = lastOptionRow?.querySelector('input[name$=".value"]');
                sampleValue = (nameValueInput && nameValueInput.value) || (valueInput && valueInput.value) || sampleValue;
              }
            }
          } else if (component.type === 'association') {
            sampleValue = activeAssociations.get(component.name)?.sampleValue || '';
          }
          if (!sampleValue) return;
          if (parts.length > 0 && pendingSeparator != null) {
            parts.push(pendingSeparator);
          }
          pendingSeparator = null;
          parts.push(sampleValue);
        });

        const previewText = (prefix || '') + parts.join('');
        preview.textContent = previewText || 'No name components selected';

        const suffix = suffixType === 'number' ? '01' : 'A';
        suffixPreview.textContent = previewText ? (previewText + suffix) : 'No name components selected';
      },
      
      getCurrentEditingType() {
        if (this._editingEntityType) return this._editingEntityType;
        const form = document.getElementById('entityTypeForm');
        if (!form) return null;
        const typeId = form.getAttribute('data-type-id');
        return this.data.entityTypes[typeId];
      },

      toggleDropdown(event, button) {
        event.stopPropagation();
        const dropdown = button.nextElementSibling;
        if (!dropdown || !dropdown.classList.contains('dropdown-menu')) return;
        const allDropdowns = document.querySelectorAll('.dropdown-menu');
        allDropdowns.forEach(menu => {
          if (menu !== dropdown) menu.style.display = 'none';
        });
        dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
        if (dropdown.style.display === 'block') {
          dropdown.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', () => { dropdown.style.display = 'none'; }, { once: true });
          });
        }
      },

      showWhatsNew() {
        loadVersionHistory().then(() => {
          const changes = window.VERSION_CHANGES || [];
          const modalHtml = `
          <div class="modal" id="whatsNewModal">
            <div class="modal-content">
              <button class="modal-close" onclick="App.closeModal('whatsNewModal')">
                <span class="material-icons">close</span>
              </button>
              <div class="modal-header">
                <h3>What's New</h3>
              </div>
              <div class="changelog-container">
                ${changes.map(v => `
                  <div class="update-section update-section update-section-emphasis update-section-tight">
                    <div class="update-version-row">
                      <strong class="text-accent">Version ${v.version}</strong>
                      <span class="text-secondary">${v.date}</span>
                    </div>
                    <ul class="update-list update-list-indented update-list-no-margin">
                      ${v.changes.map(change => `
                        <li class="update-list-item">
                          <span class="update-list-bullet">•</span>
                          ${change}
                        </li>
                      `).join('')}
                    </ul>
                  </div>
                `).join('')}
              </div>
              <div class="modal-actions">
                <button class="btn btn-primary" onclick="document.getElementById('whatsNewModal').remove()">
                  Got it
                </button>
              </div>
            </div>
          </div>
        `;
          const div = document.createElement('div');
          div.innerHTML = modalHtml;
          document.body.appendChild(div.firstElementChild);
          this.showModal('whatsNewModal');
        });
      },

      showChangelog() {
        loadVersionHistory().then(() => {
          const changes = window.VERSION_CHANGES || [];
          const modalHtml = `
          <div class="modal" id="changelogModal">
            <div class="modal-content">
              <button class="modal-close" onclick="App.closeModal('changelogModal')">
                <span class="material-icons">close</span>
              </button>
              <div class="modal-header">
                <h3>Changelog</h3>
              </div>
              <div class="changelog-container">
                ${changes.map(v => `
                  <div class="update-section">
                    <div>
                      <strong>Version ${v.version}</strong>
                      <span>${v.date}</span>
                    </div>
                    <ul>
                      ${v.changes.map(change => `
                        <li>
                          <span>•</span>
                          ${change}
                        </li>
                      `).join('')}
                    </ul>
                  </div>
                `).join('')}
              </div>
            </div>
          </div>
        `;
          const div = document.createElement('div');
          div.innerHTML = modalHtml;
          document.body.appendChild(div.firstElementChild);
          this.showModal('changelogModal');
        });
      },

      showFaqModal() {
        const faq = typeof window.ELISTLY_FAQ !== 'undefined' ? window.ELISTLY_FAQ : [];
        const bodyHtml = faq.length === 0
          ? '<p class="empty-state">No FAQ content available.</p>'
          : faq.map(section => `
            <div class="faq-section">
              <h4 class="faq-section-title">${section.section}</h4>
              ${(section.items || []).map(item => `
                <div class="faq-item">
                  <div class="faq-q">${item.q}</div>
                  <div class="faq-a">${item.a}</div>
                </div>
              `).join('')}
            </div>
          `).join('');
        const modalHtml = `
          <div class="modal" id="faqModal">
            <div class="modal-content">
              <button class="modal-close" onclick="App.closeModal('faqModal')">
                <span class="material-icons">close</span>
              </button>
              <div class="modal-header">
                <h3>Help</h3>
              </div>
              <div class="faq-container">${bodyHtml}</div>
            </div>
          </div>
        `;
        const existing = document.getElementById('faqModal');
        if (existing) existing.remove();
        const div = document.createElement('div');
        div.innerHTML = modalHtml;
        document.body.appendChild(div.firstElementChild);
        this.showModal('faqModal');
      },

      showLegalModal() {
        const modalHtml = `
          <div class="modal" id="legalModal">
            <div class="modal-content legal-modal-content">
              <button class="modal-close" onclick="App.closeModal('legalModal')">
                <span class="material-icons">close</span>
              </button>
              <div class="modal-header">
                <h3>Legal &amp; policies</h3>
              </div>
              <div class="legal-tabs" role="tablist" aria-label="Legal information">
                <button type="button" role="tab" id="privacyTab" aria-selected="true" aria-controls="privacyPanel">Privacy</button>
                <button type="button" role="tab" id="termsTab" aria-selected="false" aria-controls="termsPanel" tabindex="-1">Terms</button>
                <button type="button" role="tab" id="noticesTab" aria-selected="false" aria-controls="noticesPanel" tabindex="-1">Third-party notices</button>
              </div>
              <div class="legal-modal-body">
                <div role="tabpanel" id="privacyPanel" aria-labelledby="privacyTab">
                <section class="legal-section">
                  <h4>What the app handles</h4>
                  <p>Account details include your email and display name. Inventory data includes the categories, types, items, settings, and other content you enter. The browser also keeps an account cache and unsent edits locally to support reloads and reconnecting.</p>
                </section>
                <section class="legal-section">
                  <h4>Where your information is stored</h4>
                  <p>Elistly uses Cloudflare to run the service and Neon to manage accounts and store your inventory. Your information is not end-to-end encrypted. This means authorised Elistly administrators and service providers may be able to access it when needed to operate, support, protect, or maintain the service.</p>
                  <p>When you create an account or sign in, your password is sent to Neon to verify your identity. Your password is not stored with your inventory. Neon stores password credentials as a one-way hash rather than as readable plain text.</p>
                </section>
                <section class="legal-section">
                  <h4>Your choices</h4>
                  <p>You can export account data in Profile. The Profile menu provides account deletion. Browser-held cache or queued changes are controlled by the browser and device you use.</p>
                  <p>Deleting your account removes it from the service. Any information still stored in your browser is managed by you through your browser or device settings.</p>
                </section>
                </div>
                <div role="tabpanel" id="termsPanel" aria-labelledby="termsTab" hidden>
                <section class="legal-section">
                  <h4>Using Elistly</h4>
                  <p>Elistly is provided free to use in its current form and is in <strong>beta</strong>. Features and behaviour may change. Do not use it as the only copy of important information.</p>
                  <p>Use the service lawfully and do not attempt to interfere with it or access another account. You are responsible for the content you enter and for keeping access to your account and devices secure.</p>
                </section>
                <section class="legal-section">
                  <h4>No warranty</h4>
                  <p>We do not guarantee availability, correctness, security, or fitness for a particular purpose. Use the service and store data at your own risk.</p>
                </section>
                <section class="legal-section">
                  <h4>Source code</h4>
                  <p>The source code is available for review on <a href="https://github.com/hoozter/elistly" target="_blank" rel="noopener noreferrer">GitHub</a>.</p>
                </section>
                </div>
                <div role="tabpanel" id="noticesPanel" aria-labelledby="noticesTab" hidden>
                <section class="legal-section">
                  <p>Full third-party copyright and license notices for the shipped browser assets and production Worker dependencies.</p>
                  <iframe class="third-party-notices-frame" src="THIRD_PARTY_NOTICES.html?v=652590665d5e9baba36d973d16969c4d158de09209c70dbfcdebccdb05ae5e02" title="Full third-party notices"></iframe>
                </section>
                </div>
              </div>
            </div>
          </div>
        `;
        const existing = document.getElementById('legalModal');
        if (existing) existing.remove();
        const div = document.createElement('div');
        div.innerHTML = modalHtml;
        document.body.appendChild(div.firstElementChild);
        this.initLegalTabs(document.getElementById('legalModal'));
        this.showModal('legalModal');
      },

      initLegalTabs(modal) {
        const tabs = Array.from(modal.querySelectorAll('[role="tab"]'));
        const activateTab = (tab, focus) => {
          tabs.forEach(candidate => {
            const selected = candidate === tab;
            candidate.setAttribute('aria-selected', String(selected));
            candidate.tabIndex = selected ? 0 : -1;
            document.getElementById(candidate.getAttribute('aria-controls')).hidden = !selected;
          });
          if (focus) tab.focus();
        };
        tabs.forEach((tab, index) => {
          tab.addEventListener('click', () => activateTab(tab, false));
          tab.addEventListener('keydown', event => {
            let next = null;
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % tabs.length;
            if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + tabs.length - 1) % tabs.length;
            if (event.key === 'Home') next = 0;
            if (event.key === 'End') next = tabs.length - 1;
            if (next !== null) { event.preventDefault(); activateTab(tabs[next], true); }
          });
        });
      },

      toggleNameLock(button) {
        const input = document.getElementById('nameInput');
        const isLocked = button.querySelector('.material-icons').textContent === 'lock';
        
        if (isLocked) {
          // Unlock
          input.removeAttribute('readonly');
          button.querySelector('.material-icons').textContent = 'lock_open';
          button.title = 'Lock name generation';
          input.closest('.form-group').querySelector('.help-text').textContent = 'Manual name entry enabled';
          input.dataset.unlocked = 'true';
        } else {
          // Lock
          input.setAttribute('readonly', '');
          button.querySelector('.material-icons').textContent = 'lock';
          button.title = 'Unlock to edit name manually';
          input.dataset.unlocked = 'false';
          
          // Existing entities return to their saved name; only new drafts regenerate.
          const form = button.closest('form');
          const typeId = form.getAttribute('data-type-id');
          const formData = new FormData(form);
          const data = Object.fromEntries(formData.entries());
          const entityId = form.getAttribute('data-entity-id');
          input.closest('.form-group').querySelector('.help-text').textContent = entityId
            ? 'Saved name stays unchanged unless you unlock and edit it'
            : 'Name will be generated from the current naming settings';
          input.value = entityId
            ? this.getEntityDisplayName(this.data.entities[entityId])
            : this.generateAutoName(typeId, data);
        }
      },
      
      syncItemsPerCategoryFromSlider(value) {
        const raw = parseInt(value, 10);
        const n = Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : 0;
        const stored = n === 0 ? -1 : n;
        const numInput = document.querySelector('input[name="dashboardItemsPerCategoryNumber"]');
        if (numInput) numInput.value = n;
        this.updateDashboardSettings('itemsPerCategory', stored);
      },
      syncItemsPerCategoryFromNumber(inputEl) {
        const raw = parseInt(inputEl.value, 10);
        const n = Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : 0;
        const stored = n === 0 ? -1 : n;
        inputEl.value = n;
        const slider = document.querySelector('input[name="dashboardItemsPerCategorySlider"]');
        if (slider) slider.value = n;
        this.updateDashboardSettings('itemsPerCategory', stored);
      },
      updateDashboardSettings(setting, value) {
        if (!this.data.settings.dashboard) {
          this.data.settings.dashboard = {};
        }
        if (setting === 'itemsPerCategory') value = value === -1 ? -1 : Math.min(100, Math.max(1, parseInt(value, 10) || 1));
        this.data.settings.dashboard[setting] = value;
        
        // If changing view mode to categoryCards, force groupByCategory to true
        if (setting === 'viewMode' && value === 'categoryCards') {
          this.data.settings.dashboard.groupByCategory = true;
        }
        
        this.saveData();
        
        // Refresh dashboard if we're on it
        const url = new URL(window.location);
        const currentView = url.searchParams.get('view') || 'dashboard';
        if (currentView === 'dashboard') {
          this.loadView('dashboard');
        }
      },
      
      updateGroupByVisibility(viewMode) {
        const groupByCategory = document.querySelector('.group-by-category');
        const checkbox = groupByCategory.querySelector('input');
        
        if (viewMode === 'categoryCards') {
          groupByCategory.style.opacity = '0.5';
          checkbox.disabled = true;
          checkbox.checked = true;
        } else {
          groupByCategory.style.opacity = '1';
          checkbox.disabled = false;
        }
      },
      
      initDashboardSettings() {
        // Initialize category order sorting
        const categoryOrderList = document.getElementById('categoryOrderList');
        if (categoryOrderList) {
          new Sortable(categoryOrderList, {
            animation: 150,
            handle: '.material-icons',
            onEnd: (evt) => {
              const items = categoryOrderList.querySelectorAll('.category-order-item');
              const order = Array.from(items).map(item => item.dataset.categoryId);
              this.updateDashboardSettings('categoryOrder', order);
            }
          });
        }
        
        // Initialize group by category visibility
        const viewModeSelect = document.querySelector('select[name="dashboardViewMode"]');
        if (viewModeSelect) {
          const currentViewMode = viewModeSelect.value;
          this.updateGroupByVisibility(currentViewMode);
          this.updateViewModeHint(currentViewMode);
        }
      },

      updateViewModeHint(mode) {
        const container = document.querySelector('.view-mode-hints');
        if (!container) return;
        container.querySelectorAll('.view-mode-hint').forEach(el => {
          el.style.display = el.dataset.mode === mode ? 'block' : 'none';
        });
      },
      initEntityFormNameGen() {
        const input = document.getElementById('nameInput');
        if (!input) return;
        const form = input.closest('form');
        const typeId = form.getAttribute('data-type-id');
        if (form.getAttribute('data-entity-id')) return;
        // initial generation
        const formData = new FormData(form);
        const data = Object.fromEntries(formData.entries());
        const entityId = form.getAttribute('data-entity-id');
        input.value = this.generateAutoName(typeId, data, entityId);
        // attach listeners to regenerate on field changes
        form.querySelectorAll('input[name], select[name]').forEach(elem => {
          if (elem.name !== 'name') {
            elem.addEventListener('change', () => {
              if (input.dataset.unlocked !== 'true') {
                const fd = new FormData(form);
                const d = Object.fromEntries(fd.entries());
                const entityId = form.getAttribute('data-entity-id');
                input.value = this.generateAutoName(typeId, d, entityId);
              }
            });
          }
        });
      },

      createFullBackupEnvelope() {
        if (!this.data || typeof this.data !== 'object' || Array.isArray(this.data)) {
          throw new Error('Current app data cannot be backed up safely.');
        }
        let data;
        try {
          data = JSON.parse(JSON.stringify(this.data));
        } catch (_) {
          throw new Error('Current app data cannot be backed up safely.');
        }
        if (!data || typeof data.settings !== 'object' || !data.settings || Array.isArray(data.settings)
          || typeof data.workspaces !== 'object' || !data.workspaces || Array.isArray(data.workspaces)
          || typeof data.currentWorkspaceId !== 'string') {
          throw new Error('Current app data cannot be backed up safely.');
        }
        for (const key of FULL_BACKUP_EXCLUDED_TOP_LEVEL_KEYS) delete data[key];
        return {
          schema: 'elistly.full-backup',
          schemaVersion: 1,
          appVersion: typeof data.version === 'string' ? data.version : CURRENT_VERSION,
          exportedAt: new Date().toISOString(),
          metadata: {
            theme: typeof localStorage === 'undefined' ? null : localStorage.getItem('theme')
          },
          data
        };
      },

      parseFullBackupRestore(source) {
        const parsed = this.parseImportJson(source);
        if (parsed.duplicates.length) throw new Error('Invalid full backup: duplicate JSON members are not allowed.');
        const envelope = parsed.value;
        const invalid = message => { throw new Error(`Invalid full backup: ${message}`); };
        const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
        const assertSafeValue = (value, path = '$') => {
          if (Array.isArray(value)) return value.forEach((item, index) => assertSafeValue(item, `${path}[${index}]`));
          if (!isObject(value)) return;
          for (const [key, item] of Object.entries(value)) {
            if (key === '__proto__' || key === 'prototype' || key === 'constructor') invalid(`reserved key at ${path}.`);
            assertSafeValue(item, `${path}.${key}`);
          }
        };
        if (!isObject(envelope) || envelope.schema !== 'elistly.full-backup' || envelope.schemaVersion !== 1) invalid('unsupported schema or version.');
        assertSafeValue(envelope);
        if (!isObject(envelope.data)) invalid('data must be an object.');
        const data = envelope.data;
        if (!isObject(data.settings) || !isObject(data.workspaces) || typeof data.currentWorkspaceId !== 'string' || !data.currentWorkspaceId) invalid('required top-level domains are missing.');
        if (!Object.prototype.hasOwnProperty.call(data.workspaces, data.currentWorkspaceId)) invalid('current workspace does not exist.');
        for (const [workspaceId, workspace] of Object.entries(data.workspaces)) {
          if (!workspaceId || !isObject(workspace)) invalid('workspace is invalid.');
          for (const domain of ['categories', 'entityTypes', 'entities']) if (!isObject(workspace[domain])) invalid(`workspace ${workspaceId} is missing ${domain}.`);
          const types = workspace.entityTypes;
          for (const [typeId, type] of Object.entries(types)) {
            if (!typeId || !isObject(type) || !Array.isArray(type.fields)) invalid(`entity type ${typeId} is invalid.`);
            for (const field of type.fields) if (!isObject(field)) invalid(`entity type ${typeId} has an invalid field.`);
            if (typeof type.categoryId === 'string' && !Object.prototype.hasOwnProperty.call(workspace.categories, type.categoryId)) invalid(`entity type ${typeId} references a missing category.`);
          }
          for (const [entityId, entity] of Object.entries(workspace.entities)) {
            if (!entityId || !isObject(entity) || entity.id !== entityId || typeof entity.type !== 'string' || !Object.prototype.hasOwnProperty.call(types, entity.type)) invalid(`entity ${entityId} is invalid or references a missing type.`);
            const associations = types[entity.type].associations;
            if (Array.isArray(associations)) for (const association of associations) {
              const name = association && association.name;
              const targetType = association && association.association && association.association.targetType;
              if (typeof name === 'string' && typeof targetType === 'string' && entity[name] != null) {
                const target = workspace.entities[entity[name]];
                if (!target || target.type !== targetType) invalid(`entity ${entityId} has a dangling association.`);
              }
            }
          }
        }
        return JSON.parse(JSON.stringify(data));
      },

      fullBackupRestoreSummary(data) {
        let categories = 0, types = 0, entities = 0;
        for (const workspace of Object.values(data.workspaces)) {
          categories += Object.keys(workspace.categories).length;
          types += Object.keys(workspace.entityTypes).length;
          entities += Object.keys(workspace.entities).length;
        }
        const count = (value, singular) => `${value} ${singular}${value === 1 ? '' : 's'}`;
        return `${count(Object.keys(data.workspaces).length, 'workspace')}, ${count(categories, 'category')}, ${count(types, 'entity type')}, and ${count(entities, 'entity')}`;
      },

      async applyFullBackupRestore(candidate, identity) {
        if (!candidate || typeof candidate !== 'object') throw new Error('The backup preview is no longer valid.');
        await Storage.setAppDataForImport(candidate, identity);
        this.data = candidate;
        return true;
      },

      /** Download a complete, versioned account-data backup without account identity or runtime state. */
      exportAllData() {
        let payload;
        try {
          payload = this.createFullBackupEnvelope();
        } catch (error) {
          this.showNotification(error.message, 'error');
          return false;
        }
        const data = JSON.stringify(payload, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `elistly-full-backup-v1-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        this.showSnackbar('Inventory backup downloaded.');
        return true;
      },

      csvExportLimits: { maxRows: 10000, maxColumns: 200, maxCellLength: 100000, maxBytes: 10 * 1024 * 1024 },

      csvExportSlug(value) {
        const slug = String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        return slug || 'inventory';
      },

      csvExportCell(value) {
        if (value === null || value === undefined || value === '') return '';
        if (Array.isArray(value)) return value.map(item => this.csvExportCell(item)).join('; ');
        if (typeof value === 'object') return this.csvExportStableJson(value);
        const text = String(value);
        return /^[=+\-@]/.test(text) ? `'${text}` : text;
      },

      csvExportStableJson(value) {
        if (value === null || typeof value !== 'object') return JSON.stringify(value);
        if (Array.isArray(value)) return `[${value.map(item => this.csvExportStableJson(item)).join(',')}]`;
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${this.csvExportStableJson(value[key])}`).join(',')}}`;
      },

      csvExportQuote(value) {
        const text = String(value);
        return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      },

      createCategoryCsvExport(categoryId, typeId, entitySource) {
        const category = this.data?.categories?.[categoryId];
        const type = this.data?.entityTypes?.[typeId];
        if (!category || !type || !this.getEntityTypeCategoryIds(type).includes(categoryId)) throw new Error('Choose a category and entity type to export.');
        const limits = this.csvExportLimits;
        const fields = Array.isArray(type.fields) ? type.fields.filter(field => field && field.name) : [];
        const associations = Array.isArray(type.associations) ? type.associations.filter(association => association && association.name) : [];
        const columns = [
          { name: 'id', label: 'ID' }, { name: 'type', label: 'Type' }, { name: 'name', label: 'Name' },
          ...fields.map(field => ({ name: field.name, label: field.label || field.name })),
          ...associations.map(association => ({ name: association.name, label: association.label || association.name, association: true }))
        ];
        if (columns.length > limits.maxColumns) throw new Error(`CSV export exceeds the ${limits.maxColumns}-column limit.`);
        const entities = (entitySource || Object.values(this.data.entities || {})).filter(entity => entity && entity.type === typeId);
        if (entities.length > limits.maxRows) throw new Error(`CSV export exceeds the ${limits.maxRows}-row limit.`);
        const associationCell = (entity, association) => {
          const ids = Array.isArray(entity[association.name]) ? entity[association.name] : [entity[association.name]];
          return ids.filter(id => id !== null && id !== undefined && id !== '').map(id => {
            const target = this.data.entities?.[id];
            return target ? `${this.getEntityDisplayName(target)} (${id})` : `[missing: ${id}]`;
          });
        };
        const rows = [columns.map(column => column.label)];
        for (const entity of entities) rows.push(columns.map(column => this.csvExportCell(column.association ? associationCell(entity, column) : entity[column.name])));
        for (const row of rows) for (const cell of row) if (cell.length > limits.maxCellLength) throw new Error(`CSV export exceeds the ${limits.maxCellLength}-character cell limit.`);
        const content = `\uFEFF${rows.map(row => row.map(cell => this.csvExportQuote(cell)).join(',')).join('\r\n')}\r\n`;
        if (new TextEncoder().encode(content).length > limits.maxBytes) throw new Error(`CSV export exceeds the ${limits.maxBytes}-byte limit.`);
        return { filename: `elistly-${this.csvExportSlug(category.label || category.id)}-${this.csvExportSlug(type.label || type.id)}-inventory.csv`, mimeType: 'text/csv;charset=utf-8', content };
      },

      createSelectedCategoryCsvExport(categoryId, typeId, visibleEntities) {
        const selectedIds = this._selectedEntityIds || new Set();
        const entities = (visibleEntities || []).filter(entity => selectedIds.has(entity.id));
        const exportFile = this.createCategoryCsvExport(categoryId, typeId, entities);
        return { ...exportFile, filename: exportFile.filename.replace(/-inventory\.csv$/, '-selected.csv') };
      },

      downloadCsvExport(exportFile, successMessage) {
        const url = URL.createObjectURL(new Blob([exportFile.content], { type: exportFile.mimeType }));
        const link = document.createElement('a');
        link.href = url;
        link.download = exportFile.filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        this.showSnackbar(successMessage);
        return true;
      },

      downloadCategoryCsvExport(categoryId, typeId) {
        let exportFile;
        try { exportFile = this.createCategoryCsvExport(categoryId, typeId); } catch (error) { this.showNotification(error.message, 'error'); return false; }
        return this.downloadCsvExport(exportFile, 'Inventory CSV downloaded.');
      },

      downloadSelectedCategoryCsvExport(categoryId, typeId, visibleEntities) {
        let exportFile;
        try { exportFile = this.createSelectedCategoryCsvExport(categoryId, typeId, visibleEntities); } catch (error) { this.showNotification(error.message, 'error'); return false; }
        return this.downloadCsvExport(exportFile, 'Selected inventory CSV downloaded.');
      },

      csvImportLimits: { maxBytes: 10 * 1024 * 1024, maxCharacters: 10 * 1024 * 1024, maxRows: 10000, maxColumns: 200, maxCellLength: 100000, maxCells: 2000000 },

      parseCsvImport(source) {
        const limits = this.csvImportLimits;
        if (typeof source !== 'string' || source.length > limits.maxCharacters) throw new Error(`CSV import exceeds the ${limits.maxCharacters}-character limit.`);
        if (new TextEncoder().encode(source).length > limits.maxBytes) throw new Error(`CSV import exceeds the ${limits.maxBytes}-byte limit.`);
        let index = source.charCodeAt(0) === 0xFEFF ? 1 : 0;
        const rows = [];
        let row = [];
        let cell = '';
        let quoted = false;
        let atCellStart = true;
        const appendCell = () => {
          if (cell.length > limits.maxCellLength) throw new Error(`CSV import exceeds the ${limits.maxCellLength}-character cell limit.`);
          row.push(cell);
          if (row.length > limits.maxColumns) throw new Error(`CSV import exceeds the ${limits.maxColumns}-column limit.`);
          if (rows.length * limits.maxColumns + row.length > limits.maxCells) throw new Error(`CSV import exceeds the ${limits.maxCells}-cell limit.`);
          cell = '';
          atCellStart = true;
        };
        const appendRow = () => {
          appendCell();
          if (rows.length >= limits.maxRows + 1) throw new Error(`CSV import exceeds the ${limits.maxRows}-row limit.`);
          rows.push(row);
          row = [];
        };
        while (index < source.length) {
          const char = source[index++];
          if (quoted) {
            if (char === '"') {
              if (source[index] === '"') { cell += '"'; index++; }
              else quoted = false;
            } else cell += char;
            continue;
          }
          if (char === '"' && atCellStart) { quoted = true; atCellStart = false; continue; }
          if (char === ',') { appendCell(); continue; }
          if (char === '\r' || char === '\n') {
            if (char === '\r' && source[index] === '\n') index++;
            appendRow();
            continue;
          }
          if (char === '"') throw new Error('CSV import contains an unexpected quote.');
          cell += char;
          atCellStart = false;
        }
        if (quoted) throw new Error('CSV import contains an unterminated quoted cell.');
        if (cell !== '' || row.length) appendRow();
        if (!rows.length) throw new Error('CSV import must contain a header row.');
        const headers = rows.shift();
        if (!headers.some(header => header !== '')) throw new Error('CSV import must contain a header row.');
        return { headers, rows };
      },

      csvImportValue(value) {
        return typeof value === 'string' && /^'[=+\-@]/.test(value) ? value.slice(1) : value;
      },

      createCsvImportPreview(typeId, source, mappings) {
        const type = this.data?.entityTypes?.[typeId];
        if (!type) throw new Error('Choose an existing entity type before mapping CSV columns.');
        const parsed = this.parseCsvImport(source);
        const fields = Array.isArray(type.fields) ? type.fields.filter(field => field && field.name) : [];
        const associations = Array.isArray(type.associations) ? type.associations.filter(association => association && association.name && association.association?.targetType) : [];
        const available = new Map([...fields.map(field => [field.name, { ...field, kind: 'field' }]), ...associations.map(association => [association.name, { ...association, kind: 'association' }])]);
        const mapped = new Map();
        Object.entries(mappings || {}).forEach(([column, name]) => {
          if (name === '' || name === null || name === undefined) return;
          const index = Number(column);
          if (!Number.isInteger(index) || index < 0 || index >= parsed.headers.length) throw new Error('CSV import contains an invalid column mapping.');
          if (!available.has(name)) throw new Error(`CSV column ${parsed.headers[index]} is mapped to an incompatible field.`);
          if (mapped.has(name)) throw new Error(`CSV field ${name} is mapped more than once.`);
          mapped.set(name, index);
        });
        if (!mapped.size) throw new Error('Map at least one CSV column before previewing the import.');
        const ignored = parsed.headers.filter((_, index) => ![...mapped.values()].includes(index));
        const decode = (descriptor, raw, errors) => {
          const value = this.csvImportValue(raw);
          if (value === '') return undefined;
          if (descriptor.kind === 'association') {
            const targetType = descriptor.association.targetType;
            const display = /^(.+) \(([^()]+)\)$/.exec(value);
            const candidates = Object.values(this.data.entities || {}).filter(entity => entity && entity.type === targetType && (entity.id === value || (display && entity.id === display[2] && this.getEntityDisplayName(entity) === display[1]) || this.getEntityDisplayName(entity) === value));
            if (candidates.length !== 1) errors.push(`${descriptor.label || descriptor.name} does not identify an existing ${this.data.entityTypes[targetType]?.label || targetType}.`);
            return candidates.length === 1 ? candidates[0].id : undefined;
          }
          if (descriptor.type === 'number' && !Number.isFinite(Number(value))) errors.push(`${descriptor.label || descriptor.name} must be a number.`);
          if (descriptor.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) errors.push(`${descriptor.label || descriptor.name} must be an ISO date.`);
          if (descriptor.type === 'dropdown') {
            const option = (descriptor.options || []).find(item => item && (item.value === value || item.label === value));
            if (!option) errors.push(`${descriptor.label || descriptor.name} must match a configured option.`);
            return option ? option.value : undefined;
          }
          if (descriptor.type === 'checkbox') return /^(true|yes|1|on)$/i.test(value);
          return descriptor.type === 'text' && value.includes('; ') ? value.split('; ').map(item => this.csvImportValue(item)) : value;
        };
        const rows = parsed.rows.map((cells, index) => {
          const errors = [];
          if (cells.length !== parsed.headers.length) errors.push(`Row has ${cells.length} columns; expected ${parsed.headers.length}.`);
          const values = {};
          mapped.forEach((column, name) => { values[name] = decode(available.get(name), cells[column] ?? '', errors); });
          fields.filter(field => field.required && (values[field.name] === undefined || values[field.name] === '')).forEach(field => errors.push(`${field.label || field.name} is required.`));
          return { number: index + 2, values, errors };
        });
        return Object.freeze({ typeId, headers: parsed.headers, ignored, mappings: Object.fromEntries(mapped), rows, revision: JSON.stringify(this.data) });
      },

      async confirmCsvImport(preview, identity) {
        if (!preview || !this.data?.entityTypes?.[preview.typeId] || preview.revision !== JSON.stringify(this.data)) throw new Error('CSV import preview is stale. Review the file again.');
        if (preview.rows.some(row => row.errors.length)) throw new Error('CSV import has validation errors. Correct the mapping or file before creating rows.');
        const validRows = preview.rows.filter(row => !row.errors.length);
        if (!validRows.length) throw new Error('CSV import has no valid rows to create.');
        const candidate = JSON.parse(JSON.stringify(this.data));
        validRows.forEach(row => {
          const id = this.generateId();
          candidate.entities[id] = { id, type: preview.typeId, ...row.values };
        });
        await Storage.setAppDataForImport(candidate, identity);
        this.data = candidate;
        return { created: validRows.length, rejected: preview.rows.length - validRows.length };
      },

      showCsvImportModal() {
        const existing = document.getElementById('csvImportModal');
        if (existing) existing.remove();
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.id = 'csvImportModal';
        const content = document.createElement('div');
        content.className = 'modal-content';
        const close = document.createElement('button'); close.type = 'button'; close.className = 'modal-close'; close.textContent = '×'; close.addEventListener('click', () => this.closeModal('csvImportModal'));
        const heading = document.createElement('h3'); heading.textContent = 'Import CSV';
        const type = document.createElement('select'); type.id = 'csvImportType';
        type.appendChild(new Option('Select an entity type', ''));
        Object.values(this.data.entityTypes || {}).forEach(item => type.appendChild(new Option(item.label || item.id, item.id)));
        const file = document.createElement('input'); file.type = 'file'; file.accept = '.csv,text/csv';
        const preview = document.createElement('div'); preview.id = 'csvImportPreview'; preview.className = 'import-preview-area';
        const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'btn btn-primary'; confirm.textContent = 'Create valid rows'; confirm.disabled = true;
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-secondary'; cancel.textContent = 'Cancel'; cancel.addEventListener('click', () => this.closeModal('csvImportModal'));
        const render = () => {
          preview.replaceChildren(); confirm.disabled = true;
          const selectedType = type.value;
          const source = file._csvImportSource;
          if (!selectedType || typeof source !== 'string') return;
          try {
            const parsed = this.parseCsvImport(source);
            const schema = this.data.entityTypes[selectedType];
            const choices = [...(schema.fields || []), ...(schema.associations || [])].filter(item => item?.name);
            const mapping = document.createElement('section'); mapping.appendChild(Object.assign(document.createElement('h4'), { textContent: 'Map columns' }));
            parsed.headers.forEach((header, index) => {
              const label = document.createElement('label'); label.textContent = header || `Column ${index + 1}`;
              const select = document.createElement('select'); select.dataset.csvColumn = String(index); select.appendChild(new Option('Ignore this column', ''));
              choices.forEach(item => select.appendChild(new Option(item.label || item.name, item.name)));
              label.appendChild(select); mapping.appendChild(label);
            });
            const review = () => {
              try {
                const mappings = Object.fromEntries([...mapping.querySelectorAll('select')].map(select => [select.dataset.csvColumn, select.value]));
                const candidate = this.createCsvImportPreview(selectedType, source, mappings);
                this._csvImportPreview = candidate;
                const rows = document.createElement('p'); rows.textContent = `${candidate.rows.length} row(s): ${candidate.rows.filter(row => !row.errors.length).length} valid, ${candidate.rows.filter(row => row.errors.length).length} rejected. Ignored columns: ${candidate.ignored.join(', ') || 'none'}.`;
                const errors = document.createElement('ul'); candidate.rows.filter(row => row.errors.length).forEach(row => errors.appendChild(Object.assign(document.createElement('li'), { textContent: `Row ${row.number}: ${row.errors.join(' ')}` })));
                preview.querySelector('[data-csv-review]')?.remove();
                const output = document.createElement('div'); output.dataset.csvReview = 'true'; output.append(rows, errors); preview.appendChild(output);
                confirm.disabled = !candidate.rows.length || candidate.rows.some(row => row.errors.length);
              } catch (error) {
                preview.querySelector('[data-csv-review]')?.remove();
                const output = document.createElement('div'); output.dataset.csvReview = 'true'; output.textContent = error.message; preview.appendChild(output);
                confirm.disabled = true;
              }
            };
            mapping.querySelectorAll('select').forEach(select => select.addEventListener('change', review));
            preview.appendChild(mapping); review();
          } catch (error) { preview.textContent = error.message; }
        };
        file.addEventListener('change', async () => {
          const selected = file.files?.[0];
          if (!selected) return;
          if (selected.size > this.csvImportLimits.maxBytes) { preview.textContent = `CSV import exceeds the ${this.csvImportLimits.maxBytes}-byte limit.`; return; }
          try {
            file._csvImportSource = await selected.text();
            this._csvImportPreviewIdentity = await Storage.getImportIdentity();
            render();
          } catch (error) { preview.textContent = error.message || 'CSV import could not be read.'; }
        });
        type.addEventListener('change', render);
        confirm.addEventListener('click', async () => {
          if (!this._csvImportPreview) return;
          confirm.disabled = true;
          try {
            const activeIdentity = await Storage.getImportIdentity();
            const identity = this._csvImportPreviewIdentity;
            if (backendClient && (!identity || activeIdentity.userId !== identity.userId || activeIdentity.accessToken !== identity.accessToken || Storage._readOutbox(identity.userId).length)) throw new Error('CSV import is stale or pending changes need resolution. Review the file again.');
            const result = await this.confirmCsvImport(this._csvImportPreview, identity);
            this.closeModal('csvImportModal'); this.loadView('dashboard'); this.showNotification(`CSV import complete: created ${result.created}; rejected ${result.rejected}.`, 'success');
          } catch (error) { preview.textContent = error.message || 'CSV import was not saved.'; }
        });
        const actions = document.createElement('div'); actions.className = 'modal-actions'; actions.append(cancel, confirm);
        content.append(close, heading, Object.assign(document.createElement('p'), { textContent: 'Choose one existing entity type, map CSV columns, and review every proposed row before creating valid rows. The import never changes schema, options, People, or association targets.' }), type, file, preview, actions);
        modal.appendChild(content); document.body.appendChild(modal); this.showModal('csvImportModal');
      },

      showFullBackupRestoreModal() {
        this.closeModal('profileModal');
        const existing = document.getElementById('fullBackupRestoreModal');
        if (existing) existing.remove();
        const div = document.createElement('div');
        div.innerHTML = `
          <div class="modal" id="fullBackupRestoreModal" data-persistent>
            <div class="modal-content modal-content-narrow">
              <button class="modal-close" onclick="App.closeModal('fullBackupRestoreModal')"><span class="material-icons">close</span></button>
              <div class="modal-header"><h3>Restore inventory backup</h3></div>
              <div class="modal-body">
                <p>Select an Elistly full-backup v1 file. The preview is read-only. Replacing inventory cannot be undone. Saved offline reports and receipts remain separate and are not replaced.</p>
                <input type="file" id="fullBackupRestoreInput" accept="application/json,.json">
                <div id="fullBackupRestorePreview" class="import-preview-area u-mt-100"></div>
              </div>
              <div class="modal-actions">
                <button type="button" class="btn btn-secondary" onclick="App.closeModal('fullBackupRestoreModal')">Cancel</button>
                <button type="button" class="btn btn-danger" id="fullBackupRestoreReplaceBtn" disabled>Replace account data</button>
              </div>
            </div>
          </div>`;
        document.body.appendChild(div.firstElementChild);
        const input = document.getElementById('fullBackupRestoreInput');
        const preview = document.getElementById('fullBackupRestorePreview');
        const replace = document.getElementById('fullBackupRestoreReplaceBtn');
        let candidate = null;
        let identity = null;
        const reject = message => { candidate = null; identity = null; replace.disabled = true; preview.textContent = message; };
        input.addEventListener('change', () => {
          const file = input.files[0];
          if (!file) return;
          if (file.size > this.importLimits.maxBytes) return reject('Backup file exceeds the 1 MiB limit.');
          const reader = new FileReader();
          reader.onerror = () => reject('Backup file could not be read.');
          reader.onload = async () => {
            try {
              candidate = this.parseFullBackupRestore(reader.result);
              if (backendClient) {
                identity = await Storage.getImportIdentity();
                if (Storage._readOutbox(identity.userId).length) throw new Error('Resolve pending account changes before restoring a backup.');
              }
              preview.textContent = `Ready to replace account data: ${this.fullBackupRestoreSummary(candidate)}.`;
              replace.disabled = false;
            } catch (error) { reject(error.message || 'Backup is invalid.'); }
          };
          reader.readAsText(file);
        });
        replace.addEventListener('click', async () => {
          if (!candidate || replace.disabled) return;
          replace.disabled = true;
          try {
            if (backendClient) {
              const activeIdentity = await Storage.getImportIdentity();
              if (!identity || activeIdentity.userId !== identity.userId || activeIdentity.accessToken !== identity.accessToken || Storage._readOutbox(identity.userId).length) throw new Error('Restore is stale or pending changes need resolution. Review the backup again.');
            }
            await this.applyFullBackupRestore(candidate, identity);
            this.closeModal('fullBackupRestoreModal');
            this.loadView('dashboard');
            this.showNotification('Full backup restored.', 'success');
          } catch (error) {
            replace.disabled = false;
            preview.textContent = `Restore was not saved; current data is unchanged. ${error.message || ''}`;
          }
        });
        this.showModal('fullBackupRestoreModal');
      },

      /** Reset data modal: type RESET to clear all app data (categories, entities, settings). */
      showResetDataModal() {
        this.closeModal('profileModal');
        const existing = document.getElementById('resetDataModal');
        if (existing) existing.remove();
        const modalHtml = `
          <div class="modal" id="resetDataModal" data-persistent>
            <div class="modal-content modal-content-narrow">
              <button class="modal-close" onclick="document.getElementById('resetDataModal').remove()">
                <span class="material-icons">close</span>
              </button>
              <div class="modal-header">
                <h3>Reset data</h3>
              </div>
              <div class="modal-body">
                <p class="u-mb-100 u-mt-0">This will <strong>permanently delete all your app data</strong>—categories, entity types, entities, and settings—from this device and from your account in the database. Your account will remain. This cannot be undone.</p>
                <p class="confirm-helper-text">To continue, type <strong>RESET</strong> below.</p>
                <input type="text" id="resetDataConfirmInput" class="reset-confirm-input" placeholder="Type RESET to reset your data" autocomplete="off">
              </div>
              <div class="modal-actions">
                <button type="button" class="btn btn-secondary" onclick="document.getElementById('resetDataModal').remove()">Cancel</button>
                <button type="button" class="btn btn-danger" id="resetDataConfirmBtn" disabled>Reset data</button>
              </div>
            </div>
          </div>`;
        const div = document.createElement('div');
        div.innerHTML = modalHtml.trim();
        document.body.appendChild(div.firstElementChild);
        const input = document.getElementById('resetDataConfirmInput');
        const btn = document.getElementById('resetDataConfirmBtn');
	        const doReset = async () => {
	          if (backendClient) {
	            await Storage.setAppDataAsync({});
	            Storage._cached = null;
	          }
	          localStorage.removeItem(Storage.KEY);
          location.reload();
        };
        input.addEventListener('input', () => {
          btn.disabled = input.value.trim() !== 'RESET';
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && input.value.trim() === 'RESET') doReset();
        });
        btn.addEventListener('click', doReset);
        this.showModal('resetDataModal');
        setTimeout(() => input.focus(), 100);
      },

      /** Delete account modal: type DELETE to confirm; calls API to remove account and all data. */
      showDeleteAccountModal() {
        const apiUrl = typeof window !== 'undefined' && window.ELISTLY_API_URL;
        if (!apiUrl || !apiUrl.trim()) {
          this.showSnackbar('Delete account is not configured. Set ELISTLY_API_URL in config (or in Cloudflare Pages env).', true);
          return;
        }
        this.closeModal('profileModal');
        const existing = document.getElementById('deleteAccountModal');
        if (existing) existing.remove();
        const modalHtml = `
          <div class="modal" id="deleteAccountModal" data-persistent>
            <div class="modal-content modal-content-narrow">
              <button class="modal-close" onclick="document.getElementById('deleteAccountModal').remove()">
                <span class="material-icons">close</span>
              </button>
              <div class="modal-header">
                <h3>Delete account</h3>
              </div>
              <div class="modal-body">
                <p class="u-mb-100 u-mt-0">This will <strong>permanently delete your account</strong> and all your data. You will not be able to sign in again. This cannot be undone.</p>
                <p class="confirm-helper-text">To continue, type <strong>DELETE</strong> below.</p>
                <input type="text" id="deleteAccountConfirmInput" class="reset-confirm-input" placeholder="Type DELETE to confirm" autocomplete="off">
              </div>
              <div class="modal-actions">
                <button type="button" class="btn btn-secondary" onclick="document.getElementById('deleteAccountModal').remove()">Cancel</button>
                <button type="button" class="btn btn-danger" id="deleteAccountConfirmBtn" disabled>Delete account</button>
              </div>
            </div>
          </div>`;
        const div = document.createElement('div');
        div.innerHTML = modalHtml.trim();
        document.body.appendChild(div.firstElementChild);
        const input = document.getElementById('deleteAccountConfirmInput');
        const btn = document.getElementById('deleteAccountConfirmBtn');
	        const doDelete = async () => {
	          const session = await getAuthSession();
	          const token = session && session.access_token;
	          if (!token) {
	            this.showSnackbar('Session expired. Please sign in again.', true);
	            return;
          }
          btn.disabled = true;
          try {
            const base = apiUrl.replace(/\/$/, '');
            const res = await fetch(`${base}/users/me`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${token}` }
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
              this.showSnackbar(body.error || 'Failed to delete account', true);
              btn.disabled = false;
              return;
            }
            await backendClient.auth.signOut();
            window.location.href = window.location.origin + (window.location.pathname || '/');
          } catch (e) {
            this.showSnackbar(e.message || 'Request failed', true);
            btn.disabled = false;
          }
        };
        input.addEventListener('input', () => {
          btn.disabled = input.value.trim() !== 'DELETE';
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && input.value.trim() === 'DELETE') doDelete();
        });
        btn.addEventListener('click', doDelete);
        this.showModal('deleteAccountModal');
        setTimeout(() => input.focus(), 100);
      },

      resetApp() {
        this.showResetDataModal();
      },

      showAddPresetModal() {
        this.closeModal('settingsModal');
        const presets = SETUP_IDS.filter(function (id) { return id !== 'blank'; }).map(function (id) { return PRESETS[id]; }).filter(Boolean);
        const modalHtml = `
          <div class="modal" id="addPresetModal">
            <div class="modal-content modal-content-narrow">
              <button class="modal-close" onclick="App.closeModal('addPresetModal')">
                <span class="material-icons">close</span>
              </button>
              <div class="modal-header">
                <h3>Enable preset</h3>
              </div>
              <p class="preset-modal-copy">Enable the preset's built-in categories and entity types. Existing data and customizations are kept; example data is optional.</p>
              <div class="button-stack u-m-0">
                ${presets.map(p => {
                  const typeIds = Object.keys(p.entityTypes || {});
                  const disabledCount = typeIds.filter(id => this.data.entityTypes[id]?.enabled === false).length;
                  const allEnabled = typeIds.length > 0 && disabledCount === 0;
                  return `
                  <button type="button" class="btn btn-secondary btn-left" ${allEnabled ? 'disabled' : ''} onclick="App.applyPreset('${p.id}', false); App.closeModal('addPresetModal');">
                    <span class="material-icons u-mr-050">${allEnabled ? 'check_circle' : 'visibility'}</span>
                    <span>${p.label}${allEnabled ? ' — enabled' : ` — enable ${disabledCount}`}</span>
                  </button>`;
                }).join('')}
              </div>
            </div>
          </div>`;
        const existing = document.getElementById('addPresetModal');
        if (existing) existing.remove();
        const div = document.createElement('div');
        div.innerHTML = modalHtml;
        document.body.appendChild(div.firstElementChild);
        this.showModal('addPresetModal');
      },

      showRestoreDefaultsModal() {
        this.closeModal('settingsModal');
        const defaultEntityTypes = Object.keys(this.defaultData.entityTypes);
        const modifiedEntityTypes = defaultEntityTypes.filter(typeId => {
          if (!this.data.entityTypes[typeId]) return true;
          const defaultType = this.defaultData.entityTypes[typeId];
          const userType = this.data.entityTypes[typeId];
          const defaultFieldNames = defaultType.fields.map(f => f.name);
          const userFieldNames = userType.fields.map(f => f.name);
          if (defaultFieldNames.length !== userFieldNames.length || defaultFieldNames.some(name => !userFieldNames.includes(name))) return true;
          for (const defaultField of defaultType.fields) {
            if (defaultField.type === 'dropdown') {
              const userField = userType.fields.find(f => f.name === defaultField.name);
              if (!userField || !userField.options) return true;
              if (defaultField.options.length !== userField.options.length) return true;
              for (let i = 0; i < defaultField.options.length; i++) {
                if (defaultField.options[i].value !== userField.options[i].value || defaultField.options[i].nameValue !== userField.options[i].nameValue) return true;
              }
            }
          }
          return false;
        });
        const modalHtml = `
          <div class="modal" id="restoreDefaultsModal">
            <div class="modal-content">
              <button class="modal-close" onclick="App.closeModal('restoreDefaultsModal')">
                <span class="material-icons">close</span>
              </button>
              <div class="modal-header">
                <h3>Restore Defaults</h3>
              </div>
              <div class="modal-body modal-body-scroll">
                <p>Select the default elements you want to restore to their original state. This will overwrite any customizations you've made to these elements.</p>
                <form id="restoreDefaultsForm">
                  <div class="restore-defaults-section">
                    <h4>Entity Types</h4>
                    <div class="u-pb-8">
                      <label class="checkbox-label">
                        <input type="checkbox" class="elistly-checkbox" id="selectAllEntityTypes" onclick="App.toggleAllCheckboxes('entity-type-checkbox', this.checked)">
                        <span>Select All Entity Types</span>
                      </label>
                    </div>
                    <div class="restore-defaults-grid">
                      ${defaultEntityTypes.map(typeId => {
                        const defaultType = this.defaultData.entityTypes[typeId];
                        const isModified = modifiedEntityTypes.includes(typeId);
                        const isDeleted = !this.data.entityTypes[typeId];
                        return `<div class="restore-item entity-type-card u-pos-relative ${isModified ? 'modified' : ''}" data-entity-type="${typeId}">
                          <div class="entity-type-header u-flex-between-center">
                            <div class="u-flex-center-gap-07">
                              <span class="material-icons">${defaultType.icon}</span>
                              <label class="checkbox-label u-mb-0">
                                <input type="checkbox" class="elistly-checkbox entity-type-checkbox" name="restoreEntityTypes" value="${typeId}">
                                <span>${defaultType.label}</span>
                              </label>
                              ${isDeleted ? '<span class="modify-badge deleted">Deleted</span>' : isModified ? '<span class="modify-badge">Modified</span>' : '<span class="modify-badge original">Original</span>'}
                            </div>
                            <span class="material-icons expand-entity-type expand-toggle" data-entity-type="${typeId}">expand_more</span>
                          </div>
                          <div class="entity-fields-list hidden u-mt-050" data-entity-type-fields="${typeId}"></div>
                        </div>`;
                      }).join('')}
                    </div>
                  </div>
                  <div class="restore-defaults-section">
                    <h4>Categories</h4>
                    <div class="u-pb-8">
                      <label class="checkbox-label">
                        <input type="checkbox" class="elistly-checkbox" id="selectAllCategories" onclick="App.toggleAllCheckboxes('category-checkbox', this.checked)">
                        <span>Select All Categories</span>
                      </label>
                    </div>
                    <div class="restore-defaults-grid">
                      ${Object.keys(this.defaultData.categories).map(catId => {
                        const defaultCat = this.defaultData.categories[catId];
                        const userCat = this.data.categories[catId];
                        const isModified = !userCat || userCat.label !== defaultCat.label || userCat.icon !== defaultCat.icon;
                        return `<div class="restore-item ${isModified ? 'modified' : ''}">
                          <label class="checkbox-label">
                            <input type="checkbox" class="elistly-checkbox category-checkbox" name="restoreCategories" value="${catId}">
                            <span>${defaultCat.label}</span>
                          </label>
                          ${!userCat ? '<span class="modify-badge deleted">Deleted</span>' : isModified ? '<span class="modify-badge">Modified</span>' : '<span class="modify-badge original">Original</span>'}
                        </div>`;
                      }).join('')}
                    </div>
                  </div>
                  <div class="restore-defaults-section">
                    <h4>Default Entities</h4>
                    <div class="u-pb-8">
                      <label class="checkbox-label">
                        <input type="checkbox" class="elistly-checkbox" id="selectAllEntities" onclick="App.toggleAllCheckboxes('entity-checkbox', this.checked)">
                        <span>Select All Example Entities</span>
                      </label>
                    </div>
                    <div class="restore-defaults-grid">
                      ${Object.keys(this.defaultData.entities).map(entityId => {
                        const defaultEntity = this.defaultData.entities[entityId];
                        const userEntity = this.data.entities[entityId];
                        const entityType = this.defaultData.entityTypes[defaultEntity.type];
                        const isModified = !userEntity;
                        return `<div class="restore-item ${isModified ? 'modified' : ''}">
                          <label class="checkbox-label">
                            <input type="checkbox" class="elistly-checkbox entity-checkbox" name="restoreEntities" value="${entityId}">
                            <span>${defaultEntity.name || defaultEntity.autoName}</span>
                          </label>
                          ${!userEntity ? '<span class="modify-badge deleted">Deleted</span>' : '<span class="modify-badge original">Original</span>'}
                        </div>`;
                      }).join('')}
                    </div>
                  </div>
                </form>
              </div>
              <div class="modal-actions">
                <button class="btn btn-secondary" onclick="App.closeModal('restoreDefaultsModal')">Cancel</button>
                <button class="btn btn-primary" onclick="App.processRestoreDefaults()">
                  <span class="material-icons">settings_backup_restore</span>Restore Selected
                </button>
              </div>
            </div>
          </div>
        `;
        const div = document.createElement('div');
        div.innerHTML = modalHtml;
        document.body.appendChild(div.firstElementChild);
        this.showModal('restoreDefaultsModal');

        // Add expand/collapse logic for entity type cards
        document.querySelectorAll('.expand-entity-type').forEach(icon => {
          icon.addEventListener('click', function(e) {
            const typeId = this.dataset.entityType;
            const fieldsList = document.querySelector(`.entity-fields-list[data-entity-type-fields="${typeId}"]`);
            if (!fieldsList) return;
            if (fieldsList.style.display === 'none' || !fieldsList.style.display) {
              // Populate fields if not already
              if (!fieldsList.innerHTML) {
                App.renderRestoreFieldsList(typeId, fieldsList);
              }
              fieldsList.style.display = 'block';
              this.textContent = 'expand_less';
            } else {
              fieldsList.style.display = 'none';
              this.textContent = 'expand_more';
            }
          });
        });
      },
      processRestoreDefaults() {
        const form = document.getElementById('restoreDefaultsForm');
        if (!form) return;
        // Restore entity types, fields, and options
        const selectedEntityTypes = Array.from(form.querySelectorAll('input[name="restoreEntityTypes"]:checked')).map(input => input.value);
        for (const typeId of selectedEntityTypes) {
          if (this.defaultData.entityTypes[typeId]) {
            this.data.entityTypes[typeId] = JSON.parse(JSON.stringify(this.defaultData.entityTypes[typeId]));
          }
        }
        // Restore fields within entity types
        const fieldCheckboxes = Array.from(form.querySelectorAll('input[class="field-checkbox"]:checked'));
        for (const fieldCheckbox of fieldCheckboxes) {
          const [_, typeId] = fieldCheckbox.name.match(/^restoreField_(.+)$/) || [];
          const fieldName = fieldCheckbox.value;
          if (typeId && fieldName && this.defaultData.entityTypes[typeId]) {
            const defaultField = this.defaultData.entityTypes[typeId].fields.find(f => f.name === fieldName);
            if (defaultField) {
              const userType = this.data.entityTypes[typeId];
              if (userType) {
                const idx = userType.fields.findIndex(f => f.name === fieldName);
                if (idx !== -1) {
                  userType.fields[idx] = JSON.parse(JSON.stringify(defaultField));
                } else {
                  userType.fields.push(JSON.parse(JSON.stringify(defaultField)));
                }
              }
            }
          }
        }
        // Restore options within dropdown fields
        const optionCheckboxes = Array.from(form.querySelectorAll('input[class="option-checkbox"]:checked'));
        for (const optionCheckbox of optionCheckboxes) {
          const match = optionCheckbox.name.match(/^restoreOption_(.+)_(.+)$/);
          if (match) {
            const typeId = match[1];
            const fieldName = match[2];
            const optionIdx = parseInt(optionCheckbox.value, 10);
            const defaultField = this.defaultData.entityTypes[typeId]?.fields.find(f => f.name === fieldName);
            const userType = this.data.entityTypes[typeId];
            if (defaultField && userType) {
              const userField = userType.fields.find(f => f.name === fieldName);
              if (userField && defaultField.options && defaultField.options[optionIdx]) {
                if (!userField.options) userField.options = [];
                userField.options[optionIdx] = JSON.parse(JSON.stringify(defaultField.options[optionIdx]));
              }
            }
          }
        }
        // Restore categories
        const selectedCategories = Array.from(form.querySelectorAll('input[name="restoreCategories"]:checked')).map(input => input.value);
        for (const catId of selectedCategories) {
          if (this.defaultData.categories[catId]) {
            this.data.categories[catId] = JSON.parse(JSON.stringify(this.defaultData.categories[catId]));
          }
        }
        // Restore entities
        const selectedEntities = Array.from(form.querySelectorAll('input[name="restoreEntities"]:checked')).map(input => input.value);
        for (const entityId of selectedEntities) {
          if (this.defaultData.entities[entityId]) {
            this.data.entities[entityId] = JSON.parse(JSON.stringify(this.defaultData.entities[entityId]));
          }
        }
        this.saveData();
        this.closeModal('restoreDefaultsModal');
        const totalRestored = selectedEntityTypes.length + fieldCheckboxes.length + optionCheckboxes.length + selectedCategories.length + selectedEntities.length;
        this.showNotification(`Restored ${totalRestored} default ${totalRestored === 1 ? 'item' : 'items'} successfully`, 'success');
        this.loadView('dashboard');
      },
      toggleAllCheckboxes(className, checked) {
        document.querySelectorAll(`.${className}`).forEach(checkbox => {
          checkbox.checked = checked;
        });
      },
      renderRestoreFieldsList(typeId, container) {
        const defaultType = this.defaultData.entityTypes[typeId];
        const userType = this.data.entityTypes[typeId];
        if (!defaultType || !userType) return;
        container.innerHTML = defaultType.fields.map((field, fIdx) => {
          const userField = userType.fields.find(f => f.name === field.name);
          let badgeHtml = '';
          if (!userField) {
            badgeHtml = `<span class='modify-badge deleted'>Removed</span>`;
          } else if (JSON.stringify(userField) !== JSON.stringify(field)) {
            badgeHtml = `<span class='modify-badge'>Modified</span>`;
          } else {
            badgeHtml = `<span class='modify-badge original'>Original</span>`;
          }
          let optionHtml = '';
          if (field.type === 'dropdown') {
            optionHtml = `<div class='restore-dropdown-options u-ml-150 u-mt-030'>
              <div class='expand-dropdown-options u-flex-center-gap-05 expand-toggle' data-field-name='${field.name}'>
                <span class='material-icons'>expand_more</span>
                <span class='u-fs-095'>Dropdown Options</span>
              </div>
              <div class='restore-options-list' data-options-list='${field.name}' class='hidden'>
                ${field.options.map((opt, oIdx) => {
                  const userOpt = userField && userField.options ? userField.options[oIdx] : undefined;
                  let optBadge = '';
                  if (!userOpt) {
                    optBadge = `<span class='modify-badge deleted'>Removed</span>`;
                  } else if (userOpt.value !== opt.value || userOpt.nameValue !== opt.nameValue) {
                    optBadge = `<span class='modify-badge'>Modified</span>`;
                  } else {
                    optBadge = `<span class='modify-badge original'>Original</span>`;
                  }
                  return `<div class='restore-option-item u-ml-150'>
                    <label class='checkbox-label'>
                      <input type='checkbox' name='restoreOption_${typeId}_${field.name}' value='${oIdx}' class='elistly-checkbox option-checkbox'>
                      <span>${opt.value} (${opt.nameValue})</span>
                    </label>
                    ${optBadge}
                  </div>`;
                }).join('')}
              </div>
            </div>`;
          }
          return `<div class='restore-field-item restore-field-item-card'>
            <div class='u-flex-center-gap-07'>
              <label class='checkbox-label u-mb-0'>
                <input type='checkbox' name='restoreField_${typeId}' value='${field.name}' class='elistly-checkbox field-checkbox'>
                <span>${field.label}</span>
              </label>
              ${badgeHtml}
            </div>
            ${optionHtml}
          </div>`;
        }).join('');
        // Add expand/collapse for dropdown options
        container.querySelectorAll('.expand-dropdown-options').forEach(expand => {
          expand.addEventListener('click', function() {
            const fieldName = this.dataset.fieldName;
            const optionsList = container.querySelector(`[data-options-list='${fieldName}']`);
            const icon = this.querySelector('.material-icons');
            if (optionsList.style.display === 'none' || !optionsList.style.display) {
              optionsList.style.display = 'block';
              icon.textContent = 'expand_less';
            } else {
              optionsList.style.display = 'none';
              icon.textContent = 'expand_more';
            }
          });
        });
      },

      showExportModal() {
        const make = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = text; return el; };
        const checkbox = (name, value, className, checked = false) => { const input = document.createElement('input'); input.type = 'checkbox'; input.name = name; input.value = value; input.className = `elistly-checkbox ${className}`; input.checked = checked; return input; };
        const modal = make('div', 'modal'); modal.id = 'exportModal'; const content = make('div', 'modal-content'); const close = make('button', 'modal-close', '×'); close.type = 'button'; close.addEventListener('click', () => this.closeModal('exportModal'));
        const header = make('div', 'modal-header'); header.appendChild(make('h3', '', 'Export selected data')); const body = make('div', 'modal-body modal-body-scroll'); body.appendChild(make('p', '', 'Select entities, entity types and categories from this inventory. Account settings are not included. For all inventories, settings and theme, use the inventory backup in Profile.')); const form = make('form'); form.id = 'exportForm';
        const section = title => { const el = make('div', 'restore-defaults-section'); el.appendChild(make('h4', '', title)); return el; };
        const typeSection = section('Entity Types'); const typeGrid = make('div', 'restore-defaults-grid');
        Object.entries(this.data.entityTypes || {}).forEach(([typeId, type]) => { const item = make('div', 'restore-item entity-type-card u-pos-relative'); const top = make('div', 'entity-type-header u-flex-between-center'); const details = make('div', 'u-flex-center-gap-07'); details.append(make('span', 'material-icons', type.icon || 'folder')); const label = make('label', 'checkbox-label u-mb-0'); label.append(checkbox('exportEntityTypes', typeId, 'export-entity-type-checkbox'), make('span', '', type.label || typeId || '')); details.appendChild(label); const expand = make('button', 'expand-entity-type expand-toggle material-icons', 'expand_more'); expand.type = 'button'; const fields = make('div', 'entity-fields-list hidden u-mt-050'); expand.addEventListener('click', () => { if (!fields.childNodes.length) this.renderExportFieldsList(typeId, fields); const visible = fields.style.display === 'block'; fields.style.display = visible ? 'none' : 'block'; expand.textContent = visible ? 'expand_more' : 'expand_less'; }); top.append(details, expand); item.append(top, fields); typeGrid.appendChild(item); }); typeSection.appendChild(typeGrid);
        const categorySection = section('Categories'); const categoryGrid = make('div', 'restore-defaults-grid'); Object.entries(this.data.categories || {}).forEach(([categoryId, category]) => { const item = make('div', 'restore-item'); const label = make('label', 'checkbox-label'); label.append(checkbox('exportCategories', categoryId, 'export-category-checkbox'), make('span', '', category.label || categoryId || '')); item.appendChild(label); categoryGrid.appendChild(item); }); categorySection.appendChild(categoryGrid);
        const entitySection = section('Entities'); const entityGrid = make('div', 'restore-defaults-grid'); Object.entries(this.data.entities || {}).forEach(([entityId, entity]) => { const item = make('div', 'restore-item'); const label = make('label', 'checkbox-label'); label.append(checkbox('exportEntities', entityId, 'export-entity-checkbox'), make('span', '', this.getEntityCardTitle(entity))); item.appendChild(label); entityGrid.appendChild(item); }); entitySection.appendChild(entityGrid);
        const backupLink = make('button', 'btn btn-secondary', 'Open Profile backup');
        backupLink.type = 'button';
        backupLink.onclick = () => { this.closeModal('exportModal'); this.closeModal('settingsModal'); this.showProfileModal(); };
        body.appendChild(backupLink);
        form.append(typeSection, categorySection, entitySection); body.appendChild(form); const actions = make('div', 'modal-actions'); const cancel = make('button', 'btn btn-secondary', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', () => this.closeModal('exportModal')); const exportButton = make('button', 'btn btn-primary', 'Export Selected'); exportButton.type = 'button'; exportButton.addEventListener('click', () => this.processExport()); actions.append(cancel, exportButton); content.append(close, header, body, actions); modal.appendChild(content); document.body.appendChild(modal); this.showModal('exportModal');
      },

      renderExportFieldsList(typeId, container) {
        const type = this.data.entityTypes[typeId]; if (!type) return;
        container.replaceChildren();
        const make = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = text; return el; };
        const checkbox = (name, value, className) => { const input = document.createElement('input'); input.type = 'checkbox'; input.name = name; input.value = value; input.checked = true; input.className = `elistly-checkbox ${className}`; input.dataset.typeId = typeId; return input; };
        (type.fields || []).forEach(field => { const item = make('div', 'restore-field-item restore-field-item-card'); const label = make('label', 'checkbox-label u-mb-0'); label.append(checkbox('exportField', field.name || '', 'export-field-checkbox'), make('span', '', field.label || field.name || '')); item.appendChild(label); if (field.type === 'dropdown') { const options = make('div', 'restore-options-list'); (field.options || []).forEach((option, index) => { const row = make('label', 'checkbox-label restore-option-item u-ml-150'); const input = checkbox('exportOption', String(index), 'export-option-checkbox'); input.dataset.fieldName = field.name || ''; row.append(input, make('span', '', `${option.value || ''} (${option.nameValue || ''})`)); options.appendChild(row); }); item.appendChild(options); } container.appendChild(item); });
      },

      processExport() {
        const form = document.getElementById('exportForm');
        if (!form) return;
        // Gather selected entity types, fields, options
        const selectedEntityTypes = Array.from(form.querySelectorAll('input[name="exportEntityTypes"]:checked')).map(input => input.value);
        const selectedCategories = Array.from(form.querySelectorAll('input[name="exportCategories"]:checked')).map(input => input.value);
        const selectedEntities = Array.from(form.querySelectorAll('input[name="exportEntities"]:checked')).map(input => input.value);

        // For entity types, also check for selected fields/options
        const exportEntityTypes = {};
        selectedEntityTypes.forEach(typeId => {
          const type = JSON.parse(JSON.stringify(this.data.entityTypes[typeId]));
          // Only include selected fields
          const fieldCheckboxes = Array.from(form.querySelectorAll('.export-field-checkbox:checked')).filter(input => input.dataset.typeId === typeId);
          if (fieldCheckboxes.length > 0) {
            type.fields = type.fields.filter(f => fieldCheckboxes.some(cb => cb.value === f.name));
            // For dropdown fields, filter options
            type.fields.forEach(field => {
              if (field.type === 'dropdown') {
                const optionCheckboxes = Array.from(form.querySelectorAll('.export-option-checkbox:checked')).filter(input => input.dataset.typeId === typeId && input.dataset.fieldName === field.name);
                if (optionCheckboxes.length > 0) {
                  field.options = field.options.filter((opt, idx) => optionCheckboxes.some(cb => parseInt(cb.value) === idx));
                }
              }
            });
          }
          exportEntityTypes[typeId] = type;
        });

        // Build export object
        const exportObj = {
          version: this.data.version,
          entityTypes: exportEntityTypes,
          categories: {},
          entities: {}
        };
        selectedCategories.forEach(catId => {
          exportObj.categories[catId] = JSON.parse(JSON.stringify(this.data.categories[catId]));
        });
        selectedEntities.forEach(entityId => {
          exportObj.entities[entityId] = JSON.parse(JSON.stringify(this.data.entities[entityId]));
        });

        // Remove empty sections
        if (Object.keys(exportObj.categories).length === 0) delete exportObj.categories;
        if (Object.keys(exportObj.entities).length === 0) delete exportObj.entities;
        if (Object.keys(exportObj.entityTypes).length === 0) delete exportObj.entityTypes;

        // Download
        const data = JSON.stringify(exportObj, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `entity-manager-export-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        this.closeModal('exportModal');
      },
      showImportModal() {
        // Modal HTML for modular import
        const modalHtml = `
          <div class="modal" id="importModal">
            <div class="modal-content">
              <button class="modal-close" onclick="App.closeModal('importModal')">
                <span class="material-icons">close</span>
              </button>
              <div class="modal-header">
                <h3>Import Data</h3>
              </div>
              <div class="modal-body modal-body-scroll">
                <p>Select a JSON file to preview and import data. You can choose which items to import.</p>
                <input type="file" id="importFileInput" accept=".json" class="u-mb-100">
                <div id="importPreviewArea" class="import-preview-area u-mt-100"></div>
              </div>
              <div class="modal-actions">
                <button class="btn btn-secondary" onclick="App.closeModal('importModal')">Cancel</button>
                <button class="btn btn-primary" id="processImportBtn" disabled onclick="App.processImport()">
                  <span class="material-icons">download</span>Import Selected
                </button>
              </div>
            </div>
          </div>
        `;
        const div = document.createElement('div');
        div.innerHTML = modalHtml;
        document.body.appendChild(div.firstElementChild);
        this.showModal('importModal');

        // File input logic
        const fileInput = document.getElementById('importFileInput');
        fileInput.addEventListener('change', function(e) {
          const file = e.target.files[0];
          if (!file) return;
          if (file.size > App.importLimits.maxBytes) return App.showImportError('Import file exceeds the 1 MiB limit.');
          const reader = new FileReader();
          reader.onload = async function(ev) {
            try {
              const parsed = App.parseImportJson(ev.target.result);
              App._importRawText = ev.target.result;
              App._importDuplicateConflicts = parsed.duplicates;
              App._importDataPreview = parsed.value;
              try { App._importPreviewIdentity = await Storage.getImportIdentity(); } catch (_) { App._importPreviewIdentity = null; }
              App.renderImportPreview(parsed.value);
            } catch (err) {
              App.showImportError(err.message || 'Invalid JSON file.');
            }
          };
          reader.readAsText(file);
        });
      },

      importLimits: { maxBytes: 1024 * 1024, maxDepth: 32, maxMembers: 5000, maxConflicts: 200, maxPreviewText: 500 },

      showImportError(message) {
        const preview = document.getElementById('importPreviewArea');
        preview.replaceChildren();
        const error = document.createElement('div');
        error.className = 'text-danger';
        error.textContent = message;
        preview.appendChild(error);
        document.getElementById('processImportBtn').disabled = true;
        this._importDataPreview = null;
        this._importDuplicateConflicts = [];
        this._importRawText = null;
        this._importPreviewIdentity = null;
      },

      parseImportJson(source) {
        if (typeof source !== 'string' || source.length > this.importLimits.maxBytes) throw new Error('Import file exceeds the 1 MiB limit.');
        let index = 0;
        let members = 0;
        const duplicates = [];
        const fail = message => { throw new Error(`Invalid JSON: ${message}`); };
        const whitespace = () => { while (source[index] === ' ' || source[index] === '\t' || source[index] === '\r' || source[index] === '\n') index++; };
        const string = () => {
          if (source[index++] !== '"') fail('expected string');
          let out = '';
          while (index < source.length) {
            const char = source[index++];
            if (char === '"') return out;
            if (char === '\\') {
              const escape = source[index++];
              const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
              if (escape === 'u') {
                const hex = source.slice(index, index + 4);
                if (!/^[0-9a-f]{4}$/i.test(hex)) fail('bad unicode escape');
                out += String.fromCharCode(parseInt(hex, 16)); index += 4;
              } else if (Object.prototype.hasOwnProperty.call(map, escape)) out += map[escape];
              else fail('bad escape');
            } else {
              if (char < ' ') fail('control character in string');
              out += char;
            }
          }
          fail('unterminated string');
        };
        const scalar = () => {
          const start = index;
          while (index < source.length && !/[\s,\]}]/.test(source[index])) index++;
          const token = source.slice(start, index);
          if (token === 'true') return true;
          if (token === 'false') return false;
          if (token === 'null') return null;
          if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) return Number(token);
          fail('invalid value');
        };
        const value = (path, depth) => {
          if (depth > this.importLimits.maxDepth) throw new Error('Import JSON exceeds the nesting limit.');
          whitespace();
          if (source[index] === '"') return string();
          if (source[index] === '[') {
            index++; const array = []; whitespace();
            if (source[index] === ']') { index++; return array; }
            while (true) {
              if (array.length >= this.importLimits.maxMembers) throw new Error('Import JSON exceeds the collection limit.');
              array.push(value(`${path}[${array.length}]`, depth + 1)); whitespace();
              if (source[index] === ']') { index++; return array; }
              if (source[index++] !== ',') fail('expected comma in array'); whitespace();
            }
          }
          if (source[index] === '{') {
            index++; const object = Object.create(null); const seen = new Map(); whitespace();
            if (source[index] === '}') { index++; return object; }
            while (true) {
              whitespace(); if (source[index] !== '"') fail('expected object key');
              const key = string(); whitespace(); if (source[index++] !== ':') fail('expected colon');
              if (++members > this.importLimits.maxMembers) throw new Error('Import JSON exceeds the member limit.');
              const childPath = `${path}[${JSON.stringify(key)}]`;
              const child = value(childPath, depth + 1);
              if (seen.has(key)) {
                if (duplicates.length >= this.importLimits.maxConflicts) throw new Error('Import JSON exceeds the conflict limit.');
                duplicates.push({ id: `duplicate:${childPath}:${duplicates.length}`, kind: 'duplicate', path: childPath, key, earlier: seen.get(key), later: child, owner: object });
                seen.set(key, child);
              } else {
                seen.set(key, child);
                Object.defineProperty(object, key, { value: child, writable: true, enumerable: true, configurable: true });
              }
              whitespace(); if (source[index] === '}') { index++; return object; }
              if (source[index++] !== ',') fail('expected comma in object'); whitespace();
            }
          }
          return scalar();
        };
        const result = value('$', 0); whitespace();
        if (index !== source.length) fail('unexpected trailing data');
        if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error('Import JSON must contain an object.');
        return { value: result, duplicates };
      },

      renderImportPreview(imported) {
        const previewArea = document.getElementById('importPreviewArea');
        previewArea.replaceChildren();
        let hasImportableData = false;

        const appendBadge = (item, existing, incoming) => {
          const badge = document.createElement('span');
          badge.classList.add('modify-badge');
          if (!existing) {
            badge.classList.add('original', 'modify-badge-new');
            badge.textContent = 'New';
          } else if (JSON.stringify(existing) !== JSON.stringify(incoming)) {
            badge.classList.add('modify-badge-overwrite');
            badge.textContent = 'Will Overwrite';
          } else {
            badge.classList.add('original');
            badge.textContent = 'Unchanged';
          }
          item.appendChild(badge);
        };

        const appendSection = (heading, entries, inputName, inputClass, labelForEntry, existingEntries) => {
          if (!entries || Object.keys(entries).length === 0) return;
          hasImportableData = true;
          const section = document.createElement('div');
          section.className = 'restore-defaults-section';
          const title = document.createElement('h4');
          title.textContent = heading;
          const grid = document.createElement('div');
          grid.className = 'restore-defaults-grid';
          for (const [id, incoming] of Object.entries(entries)) {
            const item = document.createElement('div');
            item.className = 'restore-item';
            const label = document.createElement('label');
            label.className = 'checkbox-label';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.name = inputName;
            input.value = id;
            input.checked = true;
            input.className = `elistly-checkbox ${inputClass}`;
            const text = document.createElement('span');
            text.textContent = labelForEntry(incoming, id);
            label.append(input, text);
            item.appendChild(label);
            appendBadge(item, existingEntries[id], incoming);
            grid.appendChild(item);
          }
          section.append(title, grid);
          previewArea.appendChild(section);
        };

        appendSection('Entity Types', imported.entityTypes, 'importEntityTypes', 'import-entity-type-checkbox', type => type?.label ?? '', this.data.entityTypes);
        appendSection('Categories', imported.categories, 'importCategories', 'import-category-checkbox', category => category?.label ?? '', this.data.categories);
        appendSection('Entities', imported.entities, 'importEntities', 'import-entity-checkbox', entity => this.getEntityCardTitle(entity), this.data.entities);

        if (imported.settings) {
          hasImportableData = true;
          const section = document.createElement('div');
          section.className = 'restore-defaults-section';
          const title = document.createElement('h4');
          title.textContent = 'Settings';
          const item = document.createElement('div');
          item.className = 'restore-item';
          const label = document.createElement('label');
          label.className = 'checkbox-label';
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.name = 'importSettings';
          input.value = 'settings';
          input.checked = true;
          input.className = 'elistly-checkbox import-settings-checkbox';
          const text = document.createElement('span');
          text.textContent = 'Settings';
          label.append(input, text);
          item.appendChild(label);
          appendBadge(item, this.data.settings, imported.settings);
          section.append(title, item);
          previewArea.appendChild(section);
        }

        this.assertSafeImportIds(imported);
        const conflicts = this.collectImportConflicts(imported, this._importDuplicateConflicts || []);
        this._importConflicts = conflicts;
        if (conflicts.length) {
          const section = document.createElement('div');
          section.className = 'restore-defaults-section';
          const title = document.createElement('h4');
          title.textContent = 'Import conflicts — choose Skip or Overwrite for every conflict';
          section.appendChild(title);
          const duplicates = conflicts.filter(conflict => conflict.kind === 'duplicate');
          if (duplicates.length) {
            const duplicateTitle = document.createElement('h5');
            duplicateTitle.textContent = 'Duplicate JSON members';
            section.appendChild(duplicateTitle);
            for (const conflict of duplicates) section.appendChild(this.renderImportConflict(conflict));
          }
          const idConflicts = conflicts.filter(conflict => conflict.kind === 'id');
          if (idConflicts.length) {
            const idTitle = document.createElement('h5');
            idTitle.textContent = 'Existing record IDs';
            section.appendChild(idTitle);
            for (const conflict of idConflicts) section.appendChild(this.renderImportConflict(conflict));
          }
          previewArea.appendChild(section);
        }
        if (!hasImportableData) previewArea.textContent = 'No importable data found in file.';
        this.updateImportApplyState();
      },

      importSafeText(value) {
        let text;
        try { text = JSON.stringify(value); } catch (_) { text = String(value); }
        return text.length > this.importLimits.maxPreviewText ? `${text.slice(0, this.importLimits.maxPreviewText)}…` : text;
      },

      importFingerprint(value) {
        const text = JSON.stringify(value);
        if (typeof text !== 'string') throw new Error('Import conflict state cannot be fingerprinted safely.');
        return text;
      },

      assertSafeImportIds(imported) {
        const reserved = new Set(['__proto__', 'prototype', 'constructor']);
        for (const collection of ['entityTypes', 'categories', 'entities']) {
          for (const id of Object.keys(imported[collection] || {})) {
            if (reserved.has(id)) throw new Error(`Import contains reserved ${collection} ID: ${id}.`);
          }
        }
      },

      captureImportStorageState() {
        const entries = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key !== null) entries.push([key, localStorage.getItem(key)]);
        }
        return { entries, cached: Storage._cached, cachedUserId: Storage._cachedUserId };
      },

      restoreImportStorageState(snapshot) {
        localStorage.clear();
        for (const [key, value] of snapshot.entries) localStorage.setItem(key, value);
        Storage._cached = snapshot.cached;
        Storage._cachedUserId = snapshot.cachedUserId;
      },

      renderImportConflict(conflict) {
        const item = document.createElement('div');
        item.className = 'restore-item';
        item.dataset.importConflict = conflict.id;
        const description = document.createElement('p');
        description.dataset.importConflictDescription = conflict.id;
        description.textContent = this.importConflictDescription(conflict);
        item.appendChild(description);
        for (const choice of ['skip', 'overwrite']) {
          const label = document.createElement('label');
          label.className = 'checkbox-label';
          const input = document.createElement('input');
          input.type = 'radio'; input.name = `import-conflict-${conflict.id}`; input.value = choice;
          input.addEventListener('change', () => this.updateImportApplyState());
          const text = document.createElement('span');
          text.textContent = choice === 'skip' ? 'Skip' : 'Overwrite';
          label.append(input, text); item.appendChild(label);
        }
        return item;
      },

      importConflictDescription(conflict) {
        return conflict.kind === 'duplicate'
          ? `${conflict.path}: earlier ${this.importSafeText(conflict.earlier)}; later ${this.importSafeText(conflict.later)}`
          : `${conflict.collection} ID ${conflict.idValue}: current ${this.importSafeText(conflict.current)}; incoming ${this.importSafeText(conflict.incoming)}`;
      },

      readImportConflictDecisions() {
        return new Map((this._importConflicts || []).map(conflict => [conflict.id, document.querySelector(`[data-import-conflict="${CSS.escape(conflict.id)}"] input[type="radio"]:checked`)?.value]));
      },

      resolveImportDuplicateConflicts(duplicates, decisions = new Map()) {
        const effectiveByOwner = new Map();
        return duplicates.map(duplicate => {
          let effectiveByKey = effectiveByOwner.get(duplicate.owner);
          if (!effectiveByKey) {
            effectiveByKey = new Map();
            effectiveByOwner.set(duplicate.owner, effectiveByKey);
          }
          const earlier = effectiveByKey.has(duplicate.key) ? effectiveByKey.get(duplicate.key) : duplicate.owner[duplicate.key];
          const effective = decisions.get(duplicate.id) === 'overwrite' ? duplicate.later : earlier;
          effectiveByKey.set(duplicate.key, effective);
          return { ...duplicate, earlier, effective, signature: `${duplicate.path}\n${this.importFingerprint(earlier)}\n${this.importFingerprint(duplicate.later)}` };
        });
      },

      refreshImportDuplicateConflicts() {
        const duplicates = this.resolveImportDuplicateConflicts(this._importDuplicateConflicts || [], this.readImportConflictDecisions());
        const byId = new Map(duplicates.map(conflict => [conflict.id, conflict]));
        this._importConflicts = (this._importConflicts || []).map(conflict => byId.get(conflict.id) || conflict);
        for (const conflict of duplicates) {
          const description = document.querySelector(`[data-import-conflict-description="${CSS.escape(conflict.id)}"]`);
          if (description) description.textContent = this.importConflictDescription(conflict);
        }
      },

      collectImportConflicts(imported, duplicates, decisions = new Map()) {
        const conflicts = this.resolveImportDuplicateConflicts(duplicates, decisions);
        const collections = [['entityTypes', this.data.entityTypes], ['categories', this.data.categories], ['entities', this.data.entities]];
        for (const [collection, current] of collections) {
          for (const [id, incoming] of Object.entries(imported[collection] || {})) {
            if (Object.prototype.hasOwnProperty.call(current || {}, id)) conflicts.push({ id: `id:${collection}:${id}`, kind: 'id', collection, idValue: id, current: current[id], incoming, signature: `${collection}\n${id}\n${this.importFingerprint(current[id])}\n${this.importFingerprint(incoming)}` });
          }
        }
        if (imported.settings && this.data.settings && Object.keys(this.data.settings).length) conflicts.push({ id: 'id:settings:settings', kind: 'id', collection: 'settings', idValue: 'settings', current: this.data.settings, incoming: imported.settings, signature: `settings\n${this.importFingerprint(this.data.settings)}\n${this.importFingerprint(imported.settings)}` });
        if (conflicts.length > this.importLimits.maxConflicts) throw new Error('Import JSON exceeds the conflict limit.');
        return conflicts;
      },

      updateImportApplyState() {
        const button = document.getElementById('processImportBtn');
        if (!button) return;
        this.refreshImportDuplicateConflicts();
        const unresolved = (this._importConflicts || []).some(conflict => !document.querySelector(`[data-import-conflict="${CSS.escape(conflict.id)}"] input[type="radio"]:checked`));
        button.disabled = !this._importDataPreview || unresolved;
      },

      async processImport() {
        if (!this._importDataPreview) return;
        // Get selected checkboxes
        const selectedEntityTypes = Array.from(document.querySelectorAll('input[name="importEntityTypes"]:checked')).map(input => input.value);
        const selectedCategories = Array.from(document.querySelectorAll('input[name="importCategories"]:checked')).map(input => input.value);
        const selectedEntities = Array.from(document.querySelectorAll('input[name="importEntities"]:checked')).map(input => input.value);
        const importSettings = document.querySelector('input[name="importSettings"]:checked');
        let parsed;
        try { parsed = this.parseImportJson(this._importRawText); this.assertSafeImportIds(parsed.value); } catch (err) { return this.showImportError(err.message || 'Invalid JSON file.'); }
        const decisions = this.readImportConflictDecisions();
        const freshConflicts = this.collectImportConflicts(parsed.value, parsed.duplicates, decisions);
        const oldSignatures = (this._importConflicts || []).map(conflict => `${conflict.id}\n${conflict.signature}`).join('\u0000');
        const freshSignatures = freshConflicts.map(conflict => `${conflict.id}\n${conflict.signature}`).join('\u0000');
        if (oldSignatures !== freshSignatures) {
          this._importDuplicateConflicts = parsed.duplicates;
          this._importDataPreview = parsed.value;
          this.renderImportPreview(parsed.value);
          return this.showNotification('Import conflicts changed. Review every choice again before applying.', 'error');
        }
        if ([...decisions.values()].some(choice => !choice)) return this.updateImportApplyState();
        let importIdentity;
        try {
          importIdentity = await Storage.getImportIdentity();
        } catch (err) {
          return this.showImportError(`Import was not saved; original data was restored. ${err.message || ''}`);
        }
        if (backendClient && (!this._importPreviewIdentity || this._importPreviewIdentity.userId !== importIdentity.userId || Storage._cachedUserId !== importIdentity.userId)) {
          return this.showImportError('Signed-in account changed. Reload and review this import again.');
        }
        if (backendClient && this._importPreviewIdentity.accessToken !== importIdentity.accessToken) {
          return this.showImportError('Signed-in session changed. Reload and review this import again.');
        }
        if (backendClient) importIdentity = this._importPreviewIdentity;
        let duplicateSkipped = 0, duplicateOverwritten = 0;
        for (const duplicate of freshConflicts.filter(conflict => conflict.kind === 'duplicate')) {
          if (decisions.get(duplicate.id) === 'overwrite') duplicateOverwritten++; else duplicateSkipped++;
          Object.defineProperty(duplicate.owner, duplicate.key, { value: duplicate.effective, writable: true, enumerable: true, configurable: true });
        }
        const imported = parsed.value;
        const beforeData = this.data;
        const beforeStorage = this.captureImportStorageState();
        const candidate = JSON.parse(JSON.stringify(this.data));
        let created = 0, overwritten = 0, skipped = 0;
        const applyCollection = (collection, selected) => {
          for (const id of selected) {
            if (!Object.prototype.hasOwnProperty.call(imported[collection] || {}, id)) continue;
            const collision = freshConflicts.find(conflict => conflict.kind === 'id' && conflict.collection === collection && conflict.idValue === id);
            if (collision && decisions.get(collision.id) === 'skip') { skipped++; continue; }
            if (collision) overwritten++; else created++;
            Object.defineProperty(candidate[collection], id, { value: JSON.parse(JSON.stringify(imported[collection][id])), writable: true, enumerable: true, configurable: true });
          }
        };
        // Entity Types
        applyCollection('entityTypes', selectedEntityTypes);
        applyCollection('categories', selectedCategories);
        applyCollection('entities', selectedEntities);
        if (importSettings && imported.settings) {
          const settingsConflict = freshConflicts.find(conflict => conflict.collection === 'settings');
          if (settingsConflict && decisions.get(settingsConflict.id) === 'skip') skipped++;
          else { candidate.settings = this.normalizeSettings(imported.settings, candidate.settings); settingsConflict ? overwritten++ : created++; }
        }
        try {
          this.data = candidate;
          this.normalizeEntityTypeSchema();
          this.data.settings = this.normalizeSettings(this.data.settings);
          const dataToSave = { ...this.data, version: this.data.version };
          if (Storage.getOnboardingDone()) dataToSave.onboardingDone = true;
          if (await Storage.setAppDataForImport(dataToSave, importIdentity) !== true) throw new Error('Import persistence was not confirmed.');
        } catch (err) {
          if (err.accountInvalidated) {
            this._importDataPreview = null;
            this._importPreviewIdentity = null;
            this.closeModal('importModal');
            this.showNotification(err.message, 'error');
            return;
          }
          if (err.remoteCommitted) {
            this.data = candidate;
            this._importDataPreview = null;
            this._importPreviewIdentity = null;
            this.closeModal('importModal');
            this.loadView('dashboard');
            this.showNotification(err.message, 'error');
            return;
          }
          this.data = beforeData;
          this.restoreImportStorageState(beforeStorage);
          return this.showImportError(`Import was not saved; original data was restored. ${err.message || ''}`);
        }
        if (backendClient) {
          let activeIdentity = null;
          try { activeIdentity = await Storage.getImportIdentity(); } catch (_) {}
          if (!activeIdentity || activeIdentity.userId !== importIdentity.userId || activeIdentity.accessToken !== importIdentity.accessToken) {
            localStorage.removeItem(Storage.KEY);
            Storage._cached = null;
            Storage._cachedUserId = null;
            this._importDataPreview = null;
            this._importPreviewIdentity = null;
            this.closeModal('importModal');
            this.showNotification('Import was saved using the preview session, but the active session changed. Reload before continuing.', 'error');
            return;
          }
        }
        this.closeModal('importModal');
        this.loadView('dashboard');
        this.showNotification(`Import complete: created ${created}; overwritten ${overwritten}; skipped ${skipped}; rejected 0; duplicate members skipped ${duplicateSkipped}; duplicate members overwritten ${duplicateOverwritten}.`, 'success');
        this._importDataPreview = null;
        this._importPreviewIdentity = null;
      }
    };

  window.ElistlyStorage = Storage;
  window.App = App;

  // Kick off the app once scripts and DOM are ready
  document.addEventListener('DOMContentLoaded', () => App.init());
