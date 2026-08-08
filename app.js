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

async function apiRequest(path, options = {}) {
  const apiUrl = getApiUrl();
  if (!apiUrl) throw new Error('ELISTLY_API_URL is not configured.');
  const session = await getAuthSession();
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
    credentials: 'include'
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

// Storage layer: localStorage or account-backed API (one row per user in app_data)
const Storage = {
  KEY: 'elistlyData',
  USER_CACHE_PREFIX: 'elistlyData:user:',
  USER_UPDATED_PREFIX: 'elistlyData:userUpdated:',
  _cached: null,

  _getUserCacheKey(userId) {
    return `${this.USER_CACHE_PREFIX}${userId}`;
  },

  _getUserUpdatedKey(userId) {
    return `${this.USER_UPDATED_PREFIX}${userId}`;
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
      localStorage.setItem(this.KEY, JSON.stringify(payload || {}));
    } catch (e) {
      console.error('Storage._writeUserCache failed', e);
    }
  },

  _migrateLegacyCache(userId) {
    const existingUserCache = this._readUserCache(userId);
    if (existingUserCache) return;
    try {
      const raw = localStorage.getItem(this.KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        this._writeUserCache(userId, data, '');
      }
    } catch (_) {}
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
    if (backendClient) {
      try {
        const onRemoteSync = typeof options.onRemoteSync === 'function' ? options.onRemoteSync : null;
        const user = await getAuthUser();
        if (!user) return null;

        this._migrateLegacyCache(user.id);
        const cachedPayload = this._readUserCache(user.id);
        const cachedUpdatedAt = this._readUserUpdatedAt(user.id);

        if (cachedPayload) {
          this._cached = cachedPayload;
          this.syncRemoteInBackground(user.id, cachedUpdatedAt, onRemoteSync);
          return this._cached;
        }

        const res = await apiRequest('/app-data');
        if (!res.ok) {
          console.error('Storage.getAppData API error', res.data);
          return null;
        }
        const remote = res.data || {};
        this._cached = remote && remote.payload ? remote.payload : null;
        this._writeUserCache(user.id, this._cached || {}, remote && remote.updated_at ? remote.updated_at : '');
        return this._cached;
      } catch (e) {
        console.error('Storage.getAppData failed', e);
        return null;
      }
    }
    try {
      const raw = localStorage.getItem(this.KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  },

  async syncRemoteInBackground(userId, cachedUpdatedAt, onRemoteSync) {
    try {
      const res = await apiRequest('/app-data');
      if (!res.ok) return;
      const data = res.data || null;

      const remoteUpdatedAt = data && data.updated_at ? String(data.updated_at) : '';
      if (cachedUpdatedAt && remoteUpdatedAt && cachedUpdatedAt === remoteUpdatedAt) return;

      const remotePayload = data && data.payload ? data.payload : null;
      const changed = JSON.stringify(remotePayload || {}) !== JSON.stringify(this._cached || {});
      this._cached = remotePayload;
      this._writeUserCache(userId, remotePayload || {}, remoteUpdatedAt);

      if (changed && onRemoteSync) onRemoteSync(remotePayload);
    } catch (_) {}
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
    if (backendClient) {
      try {
        const user = await getAuthUser();
        if (!user) return;
        this._cached = data;
        const res = await apiRequest('/app-data', { method: 'PUT', body: { payload: data } });
        if (!res.ok) throw new Error((res.data && res.data.error) || 'Failed to save app data');
        const row = res.data || {};
        const updatedAt = row && row.updated_at ? row.updated_at : new Date().toISOString();
        this._writeUserCache(user.id, data, updatedAt);
      } catch (e) {
        console.error('Storage.setAppData failed', e);
      }
      return;
    }
    try {
      localStorage.setItem(this.KEY, JSON.stringify(data));
    } catch (e) {
      console.error('Storage.setAppData failed', e);
    }
  },

  getOnboardingDone() {
    if (this._cached && 'onboardingDone' in this._cached) return !!this._cached.onboardingDone;
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
          const apiUrl = typeof window !== 'undefined' && window.ELISTLY_API_URL;
          if (!apiUrl || !apiUrl.trim()) {
            if (typeof console !== 'undefined' && console.warn) {
              console.warn('Elistly: ELISTLY_API_URL is not set. Admin and Delete account will not appear. Set it in config or (on Cloudflare Pages) as env var ELISTLY_API_URL.');
            }
          } else {
            try {
              const r = await apiRequest('/admin/me');
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
          await this.initProfileDropdown(session.user);
          const params = new URLSearchParams(window.location.search);
          if (params.get('type') === 'verify_secondary_email' && params.get('token')) {
            await this.confirmSecondaryEmailVerification(params.get('token'));
          }
          if (await this.requiresMFAVerification()) {
            this.showMFAVerifyModal();
            return;
          }
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
        const stored = await Storage.getAppData({
          onRemoteSync: (remoteData) => {
            if (!this._isReady) {
              this._pendingRemoteData = remoteData || null;
              return;
            }
            this.applyRemoteSyncData(remoteData);
          }
        });
        const isFirstRun = !stored || (Object.keys(stored.categories || {}).length === 0 && Object.keys(stored.entityTypes || {}).length === 0);
        const onboardingDone = !!(stored && stored.onboardingDone);

        if (stored && !isFirstRun) {
          try {
            const userData = stored;
            const storedVersion = userData.version || '1.0.0';
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
            this.normalizeEntityTypeCategories();
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
        const namesChanged = this.normalizeAutoNames();
        document.documentElement.setAttribute('data-font-size', this.getSafeFontSize());
        if (componentsChanged || schemaChanged || namesChanged) dataMutatedDuringInit = true;
        if (dataMutatedDuringInit) this.saveData();
        this.buildIconGrid();
        this.renderSidebar();
        this.loadView('dashboard');
        this.ensureMainContentScrollable();

        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
          searchInput.addEventListener('input', (e) => {
            if (e.target.value) this.handleSearch(e.target.value);
            else this.loadView('dashboard');
          });
        }
        this.setupEventListeners();
        this.setupMobileNav();
        this._isReady = true;
        if (this._pendingRemoteData) {
          this.applyRemoteSyncData(this._pendingRemoteData);
          this._pendingRemoteData = null;
        }

        if (isFirstRun && !onboardingDone) {
          setTimeout(() => this.showOnboarding(), 100);
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
        <a href="#" class="auth-forgot" onclick="event.preventDefault(); App.showForgotPasswordModal();">Forgot password?</a>
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

      showForgotPasswordModal() {
        const existing = document.getElementById('authForgotModal');
        if (existing) existing.remove();
        const html = `
<div class="modal auth-modal inline-flex-display" id="authForgotModal" data-persistent>
  <div class="auth-modal-card">
    <div class="auth-modal-brand">
      <span class="material-icons auth-modal-icon">lock_reset</span>
      <h2 class="auth-modal-title">Reset password</h2>
      <p class="auth-modal-tagline">Enter your email and we'll send a reset link</p>
    </div>
    <form id="authForgotForm" class="auth-form" onsubmit="event.preventDefault(); App.handleForgotPassword(document.getElementById('authForgotEmail').value);">
      <div class="form-group">
        <label for="authForgotEmail">Email</label>
        <input type="email" id="authForgotEmail" class="auth-input" required placeholder="you@example.com" autocomplete="email">
      </div>
      <div id="authForgotError" class="auth-error hidden"></div>
      <div id="authForgotSuccess" class="auth-success hidden"></div>
      <button type="submit" class="btn btn-primary auth-submit" id="authForgotBtn">Send reset link</button>
    </form>
    <p class="auth-modal-footer"><button type="button" class="btn-link" onclick="App.closeModal('authForgotModal'); App.showSignInModal();">Back to sign in</button></p>
  </div>
</div>`;
        const div = document.createElement('div');
        div.innerHTML = html.trim();
        document.body.appendChild(div.firstElementChild);
        this.showModal('authForgotModal');
      },

      async handleForgotPassword(email) {
        if (!backendClient) return;
        const errEl = document.getElementById('authForgotError');
        const successEl = document.getElementById('authForgotSuccess');
        const btn = document.getElementById('authForgotBtn');
        if (errEl) errEl.style.display = 'none';
        if (successEl) successEl.style.display = 'none';
        if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
        const { error } = await backendClient.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + '/' });
        if (btn) { btn.disabled = false; btn.textContent = 'Send reset link'; }
        if (error) {
          if (errEl) { errEl.textContent = error.message || 'Something went wrong'; errEl.style.display = 'block'; }
          return;
        }
        if (successEl) { successEl.textContent = 'Check your email for the reset link.'; successEl.style.display = 'block'; }
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
        if (await this.requiresMFAVerification()) {
          this.closeModal('authSignInModal');
          this.showMFAVerifyModal();
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
        const wrap = document.getElementById('profileDropdownWrap');
        const menu = document.getElementById('profileMenu');
        const btn = document.getElementById('profileBtn');
        if (!wrap || !menu || !btn) return;
        wrap.classList.remove('hidden');
        wrap.style.display = '';
        const fromProfile = await this.getDisplayName(user.id);
        var rawDisplay = fromProfile || (user.user_metadata && user.user_metadata.user_name) || user.email || 'Signed in';
        var displayName = (rawDisplay || '').replace(/</g, '&lt;').replace(/"/g, '&quot;') || 'Signed in';
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
        await backendClient.auth.signOut();
        Storage._cached = null;
        window.location.reload();
      },

      setupEventListeners() {
        // Handle URL routing
        window.addEventListener('popstate', (e) => this.handleRouting());
        
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
        Storage.setAppData(dataToSave);
      },

      applyRemoteSyncData(remoteData) {
        if (!remoteData || typeof remoteData !== 'object') return;
        if (document.getElementById('entityModal')) return;
        const current = new URL(window.location);
        const activeView = current.searchParams.get('category') || current.searchParams.get('view') || 'dashboard';

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
        this.normalizeEntityTypeCategories();
        this.renderSidebar();
        this.loadView(activeView);
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
          this.data.categories = JSON.parse(JSON.stringify(preset.categories || {}));
          this.data.entityTypes = JSON.parse(JSON.stringify(preset.entityTypes || {}));
          this.data.entities = {};
          Storage.setOnboardingDone();
          this.saveData();
          const modal = document.getElementById('onboardingModal');
          if (modal) modal.remove();
          this.renderSidebar();
          this.loadView('dashboard');
          if (presetId !== 'blank') this.showNotification(`Added "${preset.label}" setup`, 'success');
          const samples = (window.SAMPLE_ENTITIES || {})[presetId];
          if (samples && samples.order && samples.order.some(function (t) { return Array.isArray(samples[t]) && samples[t].length > 0; })) {
            setTimeout(function () { App.showSampleDataPrompt(presetId); }, 300);
          }
        } else {
          Object.keys(preset.categories || {}).forEach(id => {
            if (!this.data.categories[id]) this.data.categories[id] = JSON.parse(JSON.stringify(preset.categories[id]));
          });
          Object.keys(preset.entityTypes || {}).forEach(id => {
            if (!this.data.entityTypes[id]) this.data.entityTypes[id] = JSON.parse(JSON.stringify(preset.entityTypes[id]));
          });
          this.normalizeEntityTypeCategories();
          this.saveData();
          this.renderSidebar();
          this.loadView('dashboard');
          this.showNotification(`Added "${preset.label}" preset (structure only; no sample items)`, 'success');
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

      showSampleDataPrompt(presetId) {
        const preset = PRESETS[presetId];
        const label = preset ? preset.label : 'this setup';
        const modalHtml = `
          <div class="modal" id="sampleDataModal">
            <div class="modal-content sample-data-modal-content">
              <button class="modal-close" onclick="App.closeModal('sampleDataModal')" aria-label="Close">
                <span class="material-icons">close</span>
              </button>
              <div class="modal-header">
                <h3>Load sample data?</h3>
              </div>
              <div class="modal-body">
                <p class="modal-description">Add example items so you can see how ${label} works. You can delete them anytime from the app.</p>
              </div>
              <div class="modal-actions">
                <button type="button" class="btn btn-secondary" onclick="App.closeModal('sampleDataModal')">No thanks</button>
                <button type="button" class="btn btn-primary" onclick="App.loadSampleData('${presetId}'); App.closeModal('sampleDataModal');">
                  <span class="material-icons">add</span> Yes, load samples
                </button>
              </div>
            </div>
          </div>`;
        const div = document.createElement('div');
        div.innerHTML = modalHtml;
        document.body.appendChild(div.firstElementChild);
        this.showModal('sampleDataModal');
      },

      loadSampleData(presetId) {
        const samples = (window.SAMPLE_ENTITIES || {})[presetId];
        if (!samples || !samples.order) return;
        const createdIds = {};
        samples.order.forEach(typeId => {
          const type = this.data.entityTypes[typeId];
          const list = samples[typeId];
          if (!Array.isArray(list)) return;
          createdIds[typeId] = [];
          list.forEach((data) => {
            const id = this.generateId();
            const entity = { id, type: typeId };
            Object.keys(data).forEach(k => {
              if (k.endsWith('Index')) {
                const assocName = k.replace(/Index$/, '');
                const assoc = type && type.associations ? type.associations.find(a => a.name === assocName) : null;
                const refType = assoc && assoc.association ? assoc.association.targetType : null;
                entity[assocName] = refType && createdIds[refType] ? (createdIds[refType][data[k]] || '') : '';
              } else {
                entity[k] = data[k];
              }
            });
            if (type && type.enableNameGen) {
              entity.autoName = this.generateAutoName(typeId, entity);
              delete entity.name;
            } else if (type && type.fields && type.fields.some(f => f.name === 'firstName') && type.fields.some(f => f.name === 'lastName')) {
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
        this.showNotification('Sample data added', 'success');
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

      switchWorkspace(workspaceId) {
        if (workspaceId === this.data.currentWorkspaceId) return;
        this.saveData();
        const w = this.data.workspaces && this.data.workspaces[workspaceId];
        if (!w) return;
        this.data.currentWorkspaceId = workspaceId;
        this.data.categories = { ...(w.categories || {}) };
        this.data.entityTypes = { ...(w.entityTypes || {}) };
        this.data.entities = { ...(w.entities || {}) };
        this.normalizeEntityTypeCategories();
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
        });
        this.data.workspaces[id] = {
          name,
          categories: JSON.parse(JSON.stringify(preset.categories || {})),
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
                  <input type="text" id="renameWorkspaceInput" class="profile-input" value="${(currentName || '').replace(/"/g, '&quot;')}" placeholder="e.g. Business A">
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
                <span class="workspace-switcher-label">${(currentName || '').replace(/</g, '&lt;')}</span>
                <span class="material-icons workspace-switcher-chevron">expand_more</span>
              </button>
              <div class="workspace-switcher-dropdown" id="workspaceSwitcherDropdown" hidden>
                ${workspaces.map(w => `
                  <button type="button" class="workspace-switcher-option ${w.id === this.data.currentWorkspaceId ? 'active' : ''}" data-workspace-id="${w.id}">
                    ${(w.name || w.id).replace(/</g, '&lt;')}
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
        
        const categoriesHtml = Object.values(this.data.categories)
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
        this.updateURL({ view: view === 'dashboard' ? null : view, category: view === 'dashboard' ? null : view });
        const mainContent = document.getElementById('mainContent');
        if (!mainContent) return;
        if (view === 'dashboard') {
          this.renderDashboard();
        } else if (view === 'overdue') {
          this.renderOverdueView();
        } else {
          this.renderCategoryView(view);
        }
        this.ensureMainContentScrollable();
        this.renderSidebar();
      },

      hasDueDateTypes() {
        return Object.values(this.data.entityTypes || {}).some(type =>
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
            listEl.innerHTML = `<p class="empty-state text-danger">${body.error || 'Failed to load users'}</p>`;
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
                      <td>${(u.email || '').replace(/</g, '&lt;') || '—'}</td>
                      <td><code class="admin-user-id">${(u.id || '').slice(0, 8)}…</code></td>
                      <td>${formatDate(u.created_at)}</td>
                      <td>
                        <button type="button" class="btn btn-danger btn-sm" data-user-id="${(u.id || '').replace(/"/g, '&quot;')}" data-admin-delete>Delete</button>
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
          if (listEl) listEl.innerHTML = `<p class="empty-state text-danger">${e.message || 'Request failed'}</p>`;
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
          .sort((a, b) => this.getEntityDisplayName(a).localeCompare(this.getEntityDisplayName(b)));

        // Visible categories (used by gallery and category cards)
        let visibleCategories = Object.values(this.data.categories)
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
      
      renderEntityList(categoryId) {
        const entities = Object.values(this.data.entities)
          .filter(entity => this.getEntityTypeCategoryIds(this.data.entityTypes[entity.type]).includes(categoryId))
          .sort((a, b) => this.getEntityCardTitle(a).localeCompare(this.getEntityCardTitle(b)));

        if (entities.length === 0) {
          return '<p class="empty-state">No items yet</p>';
        }

        return `<div class="gallery-cards">${entities.map(entity => this.renderEntityMiniCard(entity)).join('')}</div>`;
      },
      
      renderCategoryView(categoryId) {
        const category = this.data.categories[categoryId];
        if (!category) return;
        
        const mainContent = document.getElementById('mainContent');
        if (!mainContent) return;
        
        // Get entity types for this category
        const categoryEntityTypes = Object.values(this.data.entityTypes)
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
                </div>
              </div>
              <div class="entity-list">
                ${this.renderEntityList(categoryId)}
              </div>
            </div>
          </div>
        `;
        
        mainContent.innerHTML = html;
        this.ensureMainContentScrollable();
      },
      
      handleSearch(query) {
        const mainContent = document.getElementById('mainContent');
        if (!mainContent) return;
        
        query = query.toLowerCase();
        
        const matchingEntities = Object.values(this.data.entities)
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
                        <div class="theme-toggle" data-theme="${currentTheme}">
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
                          <span class="color-hex accent-color-hex">${localStorage.getItem('accentColor') || '#2a7ebf'}</span>
                        </div>
                      </div>
                      <div class="form-group">
                        <label>Header color</label>
                        <div class="color-control">
                          <button type="button" class="color-swatch-btn" onclick="App.openColorPicker('header')">
                            <span class="color-swatch header-color-swatch header-color-swatch-inline"></span>
                          </button>
                          <span class="color-hex header-color-hex">${localStorage.getItem('headerColor') || '#1a1b1e'}</span>
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
                          <span class="material-icons">upload</span>
                          Export
                        </button>
                        <button class="btn btn-secondary" onclick="App.showImportModal()">
                          <span class="material-icons">download</span>
                          Import
                        </button>
                        <button class="btn btn-secondary" onclick="App.showAddPresetModal()">
                          <span class="material-icons">add_circle_outline</span>
                          Add preset
                        </button>
                        ${this.data.workspaces && Object.keys(this.data.workspaces).length ? `
                        <button class="btn btn-secondary" onclick="App.showRenameWorkspaceModal()">
                          <span class="material-icons">inventory_2</span>
                          Inventory: ${(this.getCurrentWorkspaceName() || 'Default').replace(/</g, '&lt;')}
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

      async showProfileModal() {
        if (!backendClient) return;
        const { data: { user } } = await backendClient.auth.getUser();
        if (!user) return;
        let factors = { totp: [] };
        try {
          const f = await backendClient.auth.mfa.listFactors();
          if (f.data) factors = f.data;
        } catch (_) {}
        const meta = user.user_metadata || {};
        const fromProfile = await this.getDisplayName(user.id);
        const userName = fromProfile || meta.user_name || '';
        const hasTOTP = factors.totp && factors.totp.length > 0;
        const totpFactorId = hasTOTP ? factors.totp[0].id : null;
        let secondaryEmails = Array.isArray(meta.secondary_emails) ? meta.secondary_emails : [];
        if (secondaryEmails.length === 0 && meta.recovery_email) {
          secondaryEmails = [{ email: String(meta.recovery_email), verified: false }];
        }
        const primaryEmail = (user.email || '').replace(/</g, '&lt;');
        const secondaryRows = secondaryEmails.map((item, i) => {
          const email = (item.email || '').replace(/</g, '&lt;');
          const badge = item.verified ? 'Verified' : 'Unverified';
          const badgeClass = item.verified ? 'profile-email-badge profile-email-badge-verified' : 'profile-email-badge';
          const verifyItem = item.verified ? '' : '<button type="button" role="menuitem" class="profile-email-menuitem" data-action="send-verify">Send verification</button>';
          return `<div class="profile-email-row profile-email-secondary" data-index="${i}" data-email="${email.replace(/"/g, '&quot;')}">
  <span class="profile-email-value">${email}</span>
  <span class="${badgeClass}">${badge}</span>
  <div class="profile-email-menu-wrap">
    <button type="button" class="profile-email-menu-btn" aria-label="Options" aria-haspopup="true"><span class="material-icons">more_vert</span></button>
    <div class="profile-email-dropdown" role="menu">
      <button type="button" role="menuitem" class="profile-email-menuitem" data-action="set-default">Set as default</button>
      ${verifyItem}
      <button type="button" role="menuitem" class="profile-email-menuitem profile-email-menuitem-danger" data-action="delete">Delete</button>
    </div>
  </div>
</div>`;
        }).join('');

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
                <section class="profile-section profile-section-email">
                  <h4 class="profile-section-heading">Email</h4>
                  <p class="profile-help profile-email-intro">A secondary email lets you recover access if you lose your primary one. It must be verified before it can be used for password reset.</p>
                  <div class="profile-email-card">
                    <div class="profile-email-row profile-email-primary">
                      <span class="profile-email-value">${primaryEmail}</span>
                      <span class="profile-email-badge">Primary</span>
                      <div class="profile-email-menu-wrap">
                        <button type="button" class="profile-email-menu-btn" id="profilePrimaryMenuBtn" aria-label="Options" aria-haspopup="true"><span class="material-icons">more_vert</span></button>
                        <div class="profile-email-dropdown" id="profilePrimaryDropdown" role="menu">
                          <button type="button" role="menuitem" class="profile-email-menuitem" data-action="change-email">Change email</button>
                        </div>
                      </div>
                    </div>
                    ${secondaryRows}
                    <div id="profileChangeEmailBlock" class="profile-change-email-block hidden">
                      <input type="email" id="profileNewEmail" placeholder="New primary email" class="profile-input">
                      <div class="profile-inline-actions">
                        <button type="button" class="btn btn-primary btn-sm" id="profileConfirmNewEmail">Send confirmation</button>
                        <button type="button" class="btn btn-secondary btn-sm" id="profileCancelEmail">Cancel</button>
                      </div>
                    </div>
                    <div class="profile-add-email-block">
                      <button type="button" class="btn btn-primary btn-sm" id="profileAddEmailBtn">Add another email</button>
                    </div>
                    <div id="profileAddEmailForm" class="profile-add-email-form hidden">
                      <input type="email" id="profileNewSecondaryEmail" placeholder="Secondary email address" class="profile-input">
                      <div class="profile-inline-actions">
                        <button type="button" class="btn btn-primary btn-sm" id="profileAddSecondarySubmit">Add</button>
                        <button type="button" class="btn btn-secondary btn-sm" id="profileAddSecondaryCancel">Cancel</button>
                      </div>
                    </div>
                  </div>
                </section>
                <section class="profile-section">
                  <h4 class="profile-section-heading">Display name</h4>
                  <div class="profile-section-content">
                    <input type="text" id="profileUserName" class="profile-input" value="${(userName || '').replace(/"/g, '&quot;')}" placeholder="Name shown in the app">
                    <p class="profile-help">Shown in the header and when your account is referenced.</p>
                  </div>
                </section>
                <section class="profile-section" id="profile2FASection">
                  <h4 class="profile-section-heading">Two-factor authentication</h4>
                  ${hasTOTP ? `
                    <p class="profile-help">Two-factor authentication is on (authenticator app).</p>
                    <div class="profile-inline-actions">
                      <button type="button" class="btn btn-secondary btn-sm" id="profileDisableTOTPBtn">Disable authenticator</button>
                    </div>
                  ` : `
                    <p class="profile-help">Add an extra layer of security when signing in.</p>
                    <button type="button" class="btn btn-primary" id="profileEnable2FABtn">Enable two-factor authentication</button>
                  `}
                </section>
                <section class="profile-section profile-section-data">
                  <h4 class="profile-section-heading">Data &amp; account</h4>
                  <p class="profile-help">Export all your data (inventory, settings, theme). Reset clears only app data. Delete account removes your account and all data permanently.</p>
                  <div class="profile-inline-actions profile-data-actions">
                    <button type="button" class="btn btn-secondary" id="profileExportAllBtn">
                      <span class="material-icons">download</span> Export all data
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
        this.bindProfileModal(user, totpFactorId, secondaryEmails);
      },

      bindProfileModal(user, totpFactorId, secondaryEmails) {
        const saveBtn = document.getElementById('profileSaveBtn');
        const changeEmailBlock = document.getElementById('profileChangeEmailBlock');
        const newEmailInput = document.getElementById('profileNewEmail');
        const confirmNewEmailBtn = document.getElementById('profileConfirmNewEmail');
        const cancelEmailBtn = document.getElementById('profileCancelEmail');
        const primaryMenuBtn = document.getElementById('profilePrimaryMenuBtn');
        const primaryDropdown = document.getElementById('profilePrimaryDropdown');
        const addEmailBtn = document.getElementById('profileAddEmailBtn');
        const addEmailForm = document.getElementById('profileAddEmailForm');
        const newSecondaryInput = document.getElementById('profileNewSecondaryEmail');
        const addSecondarySubmit = document.getElementById('profileAddSecondarySubmit');
        const addSecondaryCancel = document.getElementById('profileAddSecondaryCancel');
        const disableTOTPBtn = document.getElementById('profileDisableTOTPBtn');

        const closeAllEmailDropdowns = () => {
          document.querySelectorAll('.profile-email-dropdown').forEach(d => d.classList.remove('open'));
        };

        if (primaryMenuBtn && primaryDropdown) {
          primaryMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            primaryDropdown.classList.toggle('open');
          });
          const changeItem = primaryDropdown.querySelector('[data-action="change-email"]');
          if (changeItem) changeItem.addEventListener('click', () => {
            primaryDropdown.classList.remove('open');
            if (changeEmailBlock) changeEmailBlock.style.display = 'block';
          });
        }
        if (cancelEmailBtn) {
          cancelEmailBtn.addEventListener('click', () => {
            if (changeEmailBlock) changeEmailBlock.style.display = 'none';
            if (newEmailInput) newEmailInput.value = '';
          });
        }
        if (confirmNewEmailBtn && newEmailInput) {
          confirmNewEmailBtn.addEventListener('click', async () => {
            const email = newEmailInput.value.trim();
            if (!email) return;
            const { error } = await backendClient.auth.updateUser({ email });
            if (error) {
              this.showSnackbar(error.message || 'Failed to update email', true);
              return;
            }
            this.showSnackbar('Confirmation sent to the new email address.');
            this.closeModal('profileModal');
            this.showProfileModal();
          });
        }

        if (addEmailBtn && addEmailForm) {
          addEmailBtn.addEventListener('click', () => {
            addEmailForm.style.display = 'block';
            if (newSecondaryInput) newSecondaryInput.value = '';
          });
        }
        if (addSecondaryCancel && addEmailForm) {
          addSecondaryCancel.addEventListener('click', () => { addEmailForm.style.display = 'none'; });
        }
        if (addSecondarySubmit && newSecondaryInput) {
          addSecondarySubmit.addEventListener('click', () => this.addSecondaryEmail(newSecondaryInput.value.trim(), addEmailForm));
        }

        document.querySelectorAll('.profile-email-secondary').forEach(row => {
          const menuBtn = row.querySelector('.profile-email-menu-btn');
          const dropdown = row.querySelector('.profile-email-dropdown');
          const index = parseInt(row.dataset.index, 10);
          const email = (row.dataset.email || '').replace(/&quot;/g, '"');
          if (!menuBtn || !dropdown) return;
          menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeAllEmailDropdowns();
            dropdown.classList.toggle('open');
          });
          dropdown.querySelectorAll('[data-action]').forEach(btn => {
            btn.addEventListener('click', async () => {
              dropdown.classList.remove('open');
              const action = btn.dataset.action;
              if (action === 'set-default') await this.setDefaultEmail(email);
              else if (action === 'send-verify') await this.sendSecondaryVerification(email);
              else if (action === 'delete') await this.removeSecondaryEmail(index);
            });
          });
        });

        const enable2FABtn = document.getElementById('profileEnable2FABtn');
        if (enable2FABtn) enable2FABtn.addEventListener('click', () => this.showTwoFAModal());

        if (saveBtn) saveBtn.addEventListener('click', () => this.saveProfile());
        const exportAllBtn = document.getElementById('profileExportAllBtn');
        const resetDataBtn = document.getElementById('profileResetDataBtn');
        const deleteAccountBtn = document.getElementById('profileDeleteAccountBtn');
        if (exportAllBtn) exportAllBtn.addEventListener('click', () => this.exportAllData());
        if (resetDataBtn) resetDataBtn.addEventListener('click', () => this.showResetDataModal());
        if (deleteAccountBtn) deleteAccountBtn.addEventListener('click', () => this.showDeleteAccountModal());
        if (disableTOTPBtn && totpFactorId) {
          disableTOTPBtn.addEventListener('click', () => {
            this.showConfirmModal({
              title: 'Disable authenticator?',
              message: 'You will no longer need a code to sign in.',
              confirmLabel: 'Disable',
              confirmVariant: 'danger',
              onConfirm: async () => {
                const { error } = await backendClient.auth.mfa.unenroll({ factorId: totpFactorId });
                if (error) {
                  this.showSnackbar(error.message || 'Failed to disable', true);
                  return;
                }
                this.closeModal('profileModal');
                this.showSnackbar('Two-factor authentication disabled.');
                this.showProfileModal();
              }
            });
          });
        }
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
          userLine.innerHTML = '<span class="material-icons">person</span>' + (display || '').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        }
      },

      async addSecondaryEmail(email, formEl) {
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          this.showSnackbar('Please enter a valid email address.', true);
          return;
        }
        const { data: { user } } = await backendClient.auth.getUser();
        if (!user) return;
        const primary = (user.email || '').toLowerCase();
        if (email.toLowerCase() === primary) {
          this.showSnackbar('This is already your primary email.', true);
          return;
        }
        const meta = user.user_metadata || {};
        let list = Array.isArray(meta.secondary_emails) ? meta.secondary_emails : [];
        if (meta.recovery_email && list.length === 0) list = [{ email: meta.recovery_email, verified: false }];
        if (list.some(item => (item.email || '').toLowerCase() === email.toLowerCase())) {
          this.showSnackbar('That email is already added.', true);
          return;
        }
        list.push({ email, verified: false });
        const { error } = await backendClient.auth.updateUser({ data: { user_metadata: { ...meta, secondary_emails: list } } });
        if (error) {
          this.showSnackbar(error.message || 'Failed to add email', true);
          return;
        }
        if (formEl) formEl.style.display = 'none';
        this.showSnackbar('Secondary email added. Send verification so it can be used for recovery.');
        this.closeModal('profileModal');
        this.showProfileModal();
      },

      async removeSecondaryEmail(index) {
        const { data: { user } } = await backendClient.auth.getUser();
        if (!user) return;
        const meta = user.user_metadata || {};
        let list = Array.isArray(meta.secondary_emails) ? [...meta.secondary_emails] : [];
        if (meta.recovery_email && list.length === 0) list = [{ email: meta.recovery_email, verified: false }];
        if (index < 0 || index >= list.length) return;
        list.splice(index, 1);
        const { error } = await backendClient.auth.updateUser({ data: { user_metadata: { ...meta, secondary_emails: list } } });
        if (error) {
          this.showSnackbar(error.message || 'Failed to remove email', true);
          return;
        }
        this.closeModal('profileModal');
        this.showProfileModal();
      },

      async setDefaultEmail(secondaryEmail) {
        const { data: { user } } = await backendClient.auth.getUser();
        if (!user) return;
        const primary = user.email || '';
        const meta = user.user_metadata || {};
        let list = Array.isArray(meta.secondary_emails) ? [...meta.secondary_emails] : [];
        if (meta.recovery_email && list.length === 0) list = [{ email: meta.recovery_email, verified: false }];
        const idx = list.findIndex(item => (item.email || '').toLowerCase() === (secondaryEmail || '').toLowerCase());
        if (idx < 0) return;
        const [removed] = list.splice(idx, 1);
        list.push({ email: primary, verified: false });
        const { error } = await backendClient.auth.updateUser({
          email: removed.email,
          data: { user_metadata: { ...meta, secondary_emails: list } }
        });
        if (error) {
          this.showSnackbar(error.message || 'Failed to set default email', true);
          return;
        }
        this.showSnackbar('Confirmation sent to the new primary email.');
        this.closeModal('profileModal');
        this.showProfileModal();
      },

      async sendSecondaryVerification(email) {
        try {
          const res = await apiRequest('/secondary-email/send', { method: 'POST', body: { email } });
          const data = res.data;
          if (!res.ok) throw new Error((res.data && res.data.error) || 'Failed to send verification');
          if (data && data.error) throw new Error(data.error);
          this.showSnackbar('Verification email sent. Check the inbox for that address.');
        } catch (e) {
          this.showSnackbar((e && e.message) || 'Failed to send verification.', true);
        }
        document.querySelectorAll('.profile-email-dropdown').forEach(d => d.classList.remove('open'));
      },

      async confirmSecondaryEmailVerification(token) {
        const url = new URL(window.location.href);
        url.searchParams.delete('type');
        url.searchParams.delete('token');
        window.history.replaceState({}, '', url.toString());
        try {
          const res = await apiRequest('/secondary-email/confirm', { method: 'POST', body: { token } });
          const data = res.data;
          if (!res.ok) throw new Error((res.data && res.data.error) || 'Verification failed');
          if (data && data.error) throw new Error(data.error);
          this.showSnackbar('Secondary email verified. You can use it for account recovery.');
        } catch (e) {
          this.showSnackbar('Verification could not be completed. The link may have expired.', true);
        }
      },

      async showTwoFAModal() {
        if (!backendClient) return;
        const modalHtml = `
          <div class="modal" id="twoFAModal">
            <div class="modal-content profile-modal-content">
              <button class="modal-close" onclick="App.closeModal('twoFAModal')">
                <span class="material-icons">close</span>
              </button>
              <div class="modal-header">
                <h3>Enable Two-Factor Authentication</h3>
              </div>
              <div class="modal-body">
                <div id="twoFAStepIntro" class="profile-2fa-step">
                  <p class="profile-help profile-2fa-intro">Two‑factor authentication uses an authenticator app to generate sign‑in codes.</p>
                  <button type="button" class="btn btn-primary" id="twoFAStartTotp">Start setup</button>
                </div>
                <div id="twoFAStepTotp" class="profile-2fa-step profile-2fa-totp-setup hidden">
                  <div id="twoFATOTPLoading" class="profile-2fa-totp-loading">
                    <span class="profile-2fa-spinner"></span>
                    <p class="profile-help">Setting up authenticator…</p>
                  </div>
                  <div id="twoFATOTPContent" class="profile-2fa-totp-content hidden">
                    <p class="profile-help">Scan the QR code with your authenticator app, or enter the code manually if you're on the same device.</p>
                    <div id="twoFATOTPQR" class="profile-totp-qr"></div>
                    <div class="profile-2fa-secret-row">
                      <label class="profile-help">Can't scan? Enter this code in your app:</label>
                      <div class="profile-2fa-secret-wrap">
                        <code id="twoFATOTPSecret" class="profile-totp-secret"></code>
                        <button type="button" class="btn btn-secondary btn-sm" id="twoFATOTPCopySecret">Copy</button>
                      </div>
                    </div>
                    <div class="profile-2fa-verify-row">
                      <label class="profile-help">Enter the 6-digit code from your app:</label>
                      <input type="text" id="twoFATOTPCode" class="profile-input profile-input-narrow" placeholder="000000" maxlength="6" autocomplete="one-time-code">
                      <button type="button" class="btn btn-primary" id="twoFATOTPVerify">Verify and enable</button>
                    </div>
                    <p id="twoFATOTPError" class="profile-error hidden"></p>
                    <button type="button" class="btn btn-secondary btn-sm profile-2fa-back" id="twoFABackFromTotp">Back</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        `;
        const existing = document.getElementById('twoFAModal');
        if (existing) existing.remove();
        const div = document.createElement('div');
        div.innerHTML = modalHtml;
        document.body.appendChild(div.firstElementChild);
        this.showModal('twoFAModal');

        const showStep = (stepId) => {
          ['twoFAStepIntro', 'twoFAStepTotp'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = id === stepId ? 'block' : 'none';
          });
        };
        showStep('twoFAStepIntro');

        const startTotp = document.getElementById('twoFAStartTotp');
        const backFromTotp = document.getElementById('twoFABackFromTotp');
        const copySecret = document.getElementById('twoFATOTPCopySecret');
        const verifyBtn = document.getElementById('twoFATOTPVerify');

        if (startTotp) startTotp.addEventListener('click', async () => {
          showStep('twoFAStepTotp');
          await this.startTwoFATOTPSetup();
        });
        if (backFromTotp) backFromTotp.addEventListener('click', () => {
          this._totpEnrollData = null;
          showStep('twoFAStepIntro');
        });

        if (copySecret) copySecret.addEventListener('click', () => {
          const secretEl = document.getElementById('twoFATOTPSecret');
          if (!secretEl || !secretEl.textContent) return;
          navigator.clipboard.writeText(secretEl.textContent).then(() => {
            copySecret.textContent = 'Copied';
            setTimeout(() => { copySecret.textContent = 'Copy'; }, 2000);
          }).catch(() => this.showSnackbar('Could not copy', true));
        });

        if (verifyBtn) verifyBtn.addEventListener('click', async () => {
          const codeEl = document.getElementById('twoFATOTPCode');
          const errEl = document.getElementById('twoFATOTPError');
          const code = codeEl && codeEl.value.trim();
          if (!code || code.length !== 6) {
            if (errEl) { errEl.textContent = 'Enter the 6-digit code from your app.'; errEl.style.display = 'block'; }
            return;
          }
          const d = this._totpEnrollData;
          if (!d) return;
          const { data: challengeData, error: challengeError } = await backendClient.auth.mfa.challenge({ factorId: d.factorId });
          if (challengeError) {
            if (errEl) { errEl.textContent = challengeError.message || 'Challenge failed.'; errEl.style.display = 'block'; }
            return;
          }
          const { error: verifyError } = await backendClient.auth.mfa.verify({ factorId: d.factorId, challengeId: challengeData.id, code });
          if (verifyError) {
            if (errEl) { errEl.textContent = verifyError.message || 'Invalid code.'; errEl.style.display = 'block'; }
            return;
          }
          this._totpEnrollData = null;
          await backendClient.auth.refreshSession();
          this.closeModal('twoFAModal');
          this.showSnackbar('Two-factor authentication is on.');
          this.closeModal('profileModal');
          setTimeout(() => this.showProfileModal(), 250);
        });
      },

      async startTwoFATOTPSetup() {
        const loadingEl = document.getElementById('twoFATOTPLoading');
        const contentEl = document.getElementById('twoFATOTPContent');
        const qrEl = document.getElementById('twoFATOTPQR');
        const secretEl = document.getElementById('twoFATOTPSecret');
        const codeInput = document.getElementById('twoFATOTPCode');
        const errEl = document.getElementById('twoFATOTPError');
        if (loadingEl) loadingEl.style.display = 'flex';
        if (contentEl) contentEl.style.display = 'none';
        if (codeInput) codeInput.value = '';
        if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

        const { data, error } = await backendClient.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Authenticator' });
        if (loadingEl) loadingEl.style.display = 'none';
        if (error) {
          this.showSnackbar(error.message || 'Failed to set up authenticator', true);
          return;
        }
        const secret = (data.totp && data.totp.secret) || '';
        this._totpEnrollData = { factorId: data.id, qrCode: data.totp && data.totp.qr_code, secret };
        if (contentEl) contentEl.style.display = 'flex';
        if (qrEl && data.totp && data.totp.qr_code) {
          qrEl.innerHTML = '';
          const img = document.createElement('img');
          img.src = data.totp.qr_code;
          img.alt = 'TOTP QR code';
          qrEl.appendChild(img);
        }
        if (secretEl) secretEl.textContent = secret || '(use QR code)';
      },

      async requiresMFAVerification() {
        if (!backendClient) return false;
        const { data, error } = await backendClient.auth.mfa.getAuthenticatorAssuranceLevel();
        if (error || !data) return false;
        return data.nextLevel === 'aal2' && data.currentLevel !== 'aal2';
      },

      showMFAVerifyModal() {
        const modalHtml = `
          <div class="modal" id="mfaVerifyModal">
            <div class="modal-content profile-modal-content">
              <button class="modal-close" onclick="App.closeModal('mfaVerifyModal')">
                <span class="material-icons">close</span>
              </button>
              <div class="modal-header">
                <h3>Two-Factor Verification</h3>
              </div>
              <div class="modal-body">
                <p class="profile-help">Enter the 6-digit code from your authenticator app to finish signing in.</p>
                <div class="profile-2fa-verify-row">
                  <label class="profile-help">Verification code</label>
                  <input type="text" id="mfaVerifyCode" class="profile-input profile-input-narrow" placeholder="000000" maxlength="6" autocomplete="one-time-code">
                  <button type="button" class="btn btn-primary" id="mfaVerifySubmit">Verify</button>
                </div>
                <p id="mfaVerifyError" class="profile-error hidden"></p>
              </div>
              <div class="modal-actions">
                <button type="button" class="btn btn-secondary" id="mfaVerifyCancel">Cancel</button>
              </div>
            </div>
          </div>
        `;
        const existing = document.getElementById('mfaVerifyModal');
        if (existing) existing.remove();
        const div = document.createElement('div');
        div.innerHTML = modalHtml;
        document.body.appendChild(div.firstElementChild);
        this.showModal('mfaVerifyModal');

        const submitBtn = document.getElementById('mfaVerifySubmit');
        const cancelBtn = document.getElementById('mfaVerifyCancel');
        const codeInput = document.getElementById('mfaVerifyCode');
        const errEl = document.getElementById('mfaVerifyError');

        if (cancelBtn) cancelBtn.addEventListener('click', async () => {
          await backendClient.auth.signOut();
          this.closeModal('mfaVerifyModal');
          this.showSignInModal();
        });

        if (submitBtn) submitBtn.addEventListener('click', async () => {
          const code = codeInput && codeInput.value.trim();
          if (!code || code.length !== 6) {
            if (errEl) { errEl.textContent = 'Enter the 6-digit code.'; errEl.style.display = 'block'; }
            return;
          }
          const factors = await backendClient.auth.mfa.listFactors();
          const totp = factors.data && factors.data.totp && factors.data.totp[0];
          if (!totp) {
            if (errEl) { errEl.textContent = 'No authenticator found.'; errEl.style.display = 'block'; }
            return;
          }
          const { data: challengeData, error: challengeError } = await backendClient.auth.mfa.challenge({ factorId: totp.id });
          if (challengeError) {
            if (errEl) { errEl.textContent = challengeError.message || 'Challenge failed.'; errEl.style.display = 'block'; }
            return;
          }
          const { error: verifyError } = await backendClient.auth.mfa.verify({ factorId: totp.id, challengeId: challengeData.id, code });
          if (verifyError) {
            if (errEl) { errEl.textContent = verifyError.message || 'Invalid code.'; errEl.style.display = 'block'; }
            return;
          }
          this.closeModal('mfaVerifyModal');
          window.location.reload();
        });
      },

      _totpEnrollData: null,

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
        
        const entity = entityId ? this.data.entities[entityId] : null;
        if (entityId && !entity) {
          console.error('Entity not found:', entityId);
          return;
        }
        
        const isEdit = !!entity;
        if (isEdit && type.enableNameGen) {
          const nextName = this.generateAutoName(entityType, entity);
          if (nextName && entity.autoName !== nextName) {
            entity.autoName = nextName;
            this.data.entities[entity.id] = entity;
            this.saveData();
          }
        }
        
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
        const form = makeElement('form');
        form.id = 'entityForm';
        form.dataset.typeId = entityType;
        form.dataset.entityId = entityId || '';
        form.autocomplete = 'off';
        form.addEventListener('submit', event => this.saveEntity(event, entityType, entityId));
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
          group.append(lockRow, makeElement('div', 'help-text', 'Name will be auto-generated based on fields'));
          group.lastElementChild.id = 'nameGenStatus';
          basic.appendChild(group);
        }
        (type.fields || []).forEach(field => basic.appendChild(this.createEntityFormField(field, entity ? entity[field.name] : '')));
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
        Object.values(this.data.entities).filter(entity => entity.type === targetType).forEach(entity => select.appendChild(new Option(this.getEntityDisplayName(entity), entity.id, false, value === entity.id)));
        const link = document.createElement('a'); link.href = '#'; link.className = 'association-add-link'; link.dataset.targetType = targetType; link.dataset.assocName = assoc.name; link.dataset.targetLabel = this.data.entityTypes[targetType]?.label || targetType;
        link.append(document.createTextNode('Add '), document.createTextNode(link.dataset.targetLabel));
        link.addEventListener('click', event => this.showInlineAddEntity(event, link));
        row.append(select, link); group.appendChild(row); return group;
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
        if (!type || !type.fields) return;
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
          if (value !== '') data[key] = value;
        }
        type.fields.filter(f => f.type === 'checkbox').forEach(f => {
          data[f.name] = formData.get(f.name) === 'yes';
        });

        // Generate auto name if needed
        if (type.enableNameGen) {
          const nameInput = form.querySelector('#nameInput');
          const unlocked = nameInput && nameInput.dataset.unlocked === 'true';
          data.autoName = this.generateAutoName(entityType, data, data.id);
          if (!unlocked) {
            delete data.name;
          } else if (formData.get('name')) {
            data.name = formData.get('name');
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
        
        document.getElementById('confirmDeleteModal').remove();
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
          const remove = make('button', 'btn btn-danger'); remove.type = 'button'; remove.title = 'Delete'; remove.appendChild(icon('delete')); remove.addEventListener('click', () => this.deleteCategory(category.id));
          actions.append(edit, remove); row.append(info, actions); list.appendChild(row);
        });
        body.appendChild(list); const footer = make('div', 'modal-actions'); const add = make('button', 'btn btn-primary', 'New Category'); add.type = 'button'; add.prepend(icon('add')); add.addEventListener('click', () => this.showCategoryForm()); footer.appendChild(add);
        content.append(close, header, body, footer); modal.appendChild(content); document.body.appendChild(modal);
        this.showModal('categoryManagerModal');
      },
            
      closeCategoryManager() {
        this.closeModal('categoryManagerModal');
      },

      showSafeCategoryForm(categoryId = '') {
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

      showSafeCategoryDelete(categoryId) {
        const category = this.data.categories[categoryId]; if (!category) return;
        const make = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = text; return el; };
        const modal = make('div', 'modal'); modal.id = 'confirmDeleteCategoryModal'; const content = make('div', 'modal-content'); const close = make('button', 'modal-close', '×'); close.type = 'button'; close.addEventListener('click', () => this.closeModal('confirmDeleteCategoryModal'));
        const header = make('div', 'modal-header'); header.appendChild(make('h3', '', 'Confirm Delete Category')); const message = make('p', '', `Are you sure you want to delete the category "${category.label || category.id || ''}"?`);
        const actions = make('div', 'modal-actions'); const cancel = make('button', 'btn btn-secondary', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', () => this.closeModal('confirmDeleteCategoryModal')); const remove = make('button', 'btn btn-danger', 'Delete'); remove.type = 'button'; remove.addEventListener('click', () => this.confirmDeleteCategory(categoryId)); actions.append(cancel, remove); content.append(close, header, message, actions); modal.appendChild(content); document.body.appendChild(modal); this.showModal('confirmDeleteCategoryModal');
      },
      
      showCategoryForm(categoryId = '') {
        return this.showSafeCategoryForm(categoryId);
        const category = categoryId ? this.data.categories[categoryId] : null;
        const isEdit = !!category;
        const entityTypes = Object.values(this.data.entityTypes || {});
        const entityTypesSection = isEdit && entityTypes.length ? `
                <div class="form-group modal-group carded-section">
                  <h4>Entity types in this category</h4>
                  <p class="profile-help u-mt-0">Select which entity types appear under this category. You can also assign categories from each entity type's settings.</p>
                  <div class="category-entity-types-checkboxes">
                    ${entityTypes.map(t => {
                      const checked = this.getEntityTypeCategoryIds(t).includes(categoryId);
                      return `<label class="checkbox-label category-entity-type-option">
                        <input type="checkbox" class="elistly-checkbox" name="entityType_${t.id}" value="1" ${checked ? 'checked' : ''}>
                        <span>${(t.label || t.id).replace(/</g, '&lt;')}</span>
                      </label>`;
                    }).join('')}
                  </div>
                </div>
                ` : '';
        
        const modalHtml = `
          <div class="modal" id="categoryFormModal">
            <div class="modal-content">
              <button class="modal-close" onclick="App.closeModal('categoryFormModal')">
                <span class="material-icons">close</span>
              </button>
              <div class="modal-header">
                <h3>${isEdit ? 'Edit' : 'New'} Category</h3>
              </div>
              <form id="categoryForm" onsubmit="App.saveCategory(event, '${categoryId}')">
                      <div class="form-group">
                  <label for="label">Category Name *</label>
                  <input type="text" name="label" value="${category?.label || ''}" required>
                          </div>
                
                      <div class="form-group">
                  <label for="icon">Icon</label>
                  <div class="icon-select" onclick="App.showIconPicker('categoryIcon')">
                    <span class="material-icons">${category?.icon || 'folder'}</span>
                    <input type="hidden" name="icon" id="categoryIcon" value="${category?.icon || 'folder'}">
                    <span class="icon-select-text">Click to change icon</span>
                    </div>
                  </div>

                      <div class="form-group">
                        <label class="checkbox-label">
                    <input type="checkbox" class="elistly-checkbox" name="visibleInDashboard" 
                           ${category?.visibleInDashboard !== false ? 'checked' : ''}>
                    <span>Show in Dashboard</span>
                        </label>
                </div>
                ${entityTypesSection}
                <div class="modal-actions">
                  <button type="button" class="btn btn-secondary" onclick="App.closeCategoryForm()">
                    Cancel
                    </button>
                  <button type="submit" class="btn btn-primary">
                    <span class="material-icons">${isEdit ? 'save' : 'add'}</span>
                    ${isEdit ? 'Save' : 'Create'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        `;
        
        const div = document.createElement('div');
        div.innerHTML = modalHtml;
        document.body.appendChild(div.firstElementChild);
        this.showModal('categoryFormModal');
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
        return this.showSafeCategoryDelete(categoryId);
        const category = this.data.categories[categoryId];
        if (!category) return;
        
        const hasEntities = Object.values(this.data.entities)
          .some(entity => this.getEntityTypeCategoryIds(this.data.entityTypes[entity.type]).includes(categoryId));
        
        const confirmModal = `
          <div class="modal" id="confirmDeleteCategoryModal">
            <div class="modal-content">
              <button class="modal-close" onclick="App.closeModal('confirmDeleteCategoryModal')">
                <span class="material-icons">close</span>
              </button>
              <div class="modal-header">
                <h3>Confirm Delete Category</h3>
              </div>
              ${hasEntities ? `
                <p class="text-danger">Warning: This category contains entities. Deleting it will also delete all associated entities.</p>
              ` : ''}
              <p>Are you sure you want to delete the category "${category.label}"?</p>
              <div class="modal-actions">
                <button class="btn btn-secondary" onclick="App.closeModal('confirmDeleteCategoryModal')">Cancel</button>
                <button class="btn btn-danger" onclick="App.confirmDeleteCategory('${categoryId}')">Delete</button>
              </div>
            </div>
          </div>
        `;
        
        const div = document.createElement('div');
        div.innerHTML = confirmModal;
        document.body.appendChild(div.firstElementChild);
        this.showModal('confirmDeleteCategoryModal');
      },
      
      confirmDeleteCategory(categoryId) {
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

      normalizeAutoNames() {
        let changed = false;
        const byType = {};
        Object.values(this.data.entities || {}).forEach(entity => {
          const type = this.data.entityTypes[entity.type];
          if (!type || !type.enableNameGen) return;
          const baseName = this.buildAutoNameBase(entity.type, entity) || '';
          if (!baseName) {
            if (entity.autoName) {
              entity.autoName = '';
              changed = true;
            }
            return;
          }
          if (!byType[entity.type]) byType[entity.type] = {};
          if (!byType[entity.type][baseName]) byType[entity.type][baseName] = [];
          byType[entity.type][baseName].push(entity);
        });

        Object.entries(byType).forEach(([typeId, groups]) => {
          const type = this.data.entityTypes[typeId];
          Object.entries(groups).forEach(([baseName, list]) => {
            if (!baseName) return;
            const sorted = list.slice().sort((a, b) => a.id.localeCompare(b.id));
            if (sorted.length === 1) {
              const single = sorted[0];
              if (single.autoName !== baseName) {
                single.autoName = baseName;
                changed = true;
              }
              if (single.name && single.name.startsWith(baseName)) {
                const tail = single.name.slice(baseName.length);
                const looksLikeSuffix = (tail.length === 2 && /^\d+$/.test(tail)) || (tail.length === 1 && /^[A-Z]$/.test(tail));
                if (looksLikeSuffix) {
                  delete single.name;
                  changed = true;
                }
              }
              return;
            }
            if (type.nameGen.suffixType === 'letter') {
              let suffix = 'A';
              sorted.forEach(entity => {
                const next = baseName + suffix;
                if (entity.autoName !== next) {
                  entity.autoName = next;
                  changed = true;
                }
                suffix = String.fromCharCode(suffix.charCodeAt(0) + 1);
              });
              return;
            }
            let idx = 1;
            sorted.forEach(entity => {
              const next = baseName + String(idx).padStart(2, '0');
              if (entity.autoName !== next) {
                entity.autoName = next;
                changed = true;
              }
              idx += 1;
            });
          });
        });
        return changed;
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
          const remove = make('button', 'btn btn-danger'); remove.type = 'button'; remove.title = 'Delete'; remove.appendChild(icon('delete')); remove.addEventListener('click', () => this.deleteEntityType(type.id));
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

      _getTemplateTypeOptions() {
        const out = [];
        ['it', 'library', 'staff', 'property'].forEach(presetKey => {
          const preset = this._presets[presetKey];
          if (!preset || !preset.entityTypes) return;
          Object.entries(preset.entityTypes).forEach(([typeId, type]) => {
            out.push(`<a href="#" class="template-type-link" data-preset="${presetKey}" data-type="${typeId}">${type.label}</a>`);
          });
        });
        return out.length ? out.join('') : '<span class="template-empty-state">No templates</span>';
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
        return this.showSafeEntityTypeEditor(typeId, type);
        const nameComponentsHtml = (() => {
          const fields = Array.isArray(type.fields) ? type.fields.filter(f => f.partOfName) : [];
          const associations = Array.isArray(type.associations) ? type.associations.filter(a => a.partOfName) : [];
          const fieldMap = new Map(fields.map(f => [f.name, f]));
          const associationMap = new Map(associations.map(a => [a.name, a]));
          const order = Array.isArray(type.nameGen?.componentsOrder) ? type.nameGen.componentsOrder : [];
          const hasFirstLast = fieldMap.has('firstName') && fieldMap.has('lastName');
          const used = new Set();
          const parts = [];
          const renderField = (field) => {
            used.add(field.name);
            return `
              <div class="name-component-item sortable-item" data-component-type="field" data-field-name="${field.name}">
                <span class="material-icons drag-handle" title="Drag to reorder">drag_indicator</span>
                <span class="name-component-label">${field.label}</span>
              </div>
            `;
          };
          const renderAssociation = (association) => {
            used.add(association.name);
            return `
              <div class="name-component-item sortable-item" data-component-type="association" data-association-name="${association.name}">
                <span class="material-icons drag-handle" title="Drag to reorder">drag_indicator</span>
                <span class="name-component-label">Link: ${association.label}</span>
              </div>
            `;
          };
          const renderSeparator = (value) => {
            const raw = value == null ? '' : String(value);
            if (!raw) return '';
            const label = raw === ' ' ? 'Space' : raw === '-' ? 'Dash' : raw === '_' ? 'Underscore' : raw === '.' ? 'Dot' : raw;
            return `
              <div class="name-component-item name-separator-item sortable-item" data-component-type="separator" data-separator-value="${encodeURIComponent(raw).replace(/"/g, '&quot;')}">
                <span class="material-icons drag-handle" title="Drag to reorder">drag_indicator</span>
                <span class="separator-pill">${label}</span>
                <button type="button" class="btn btn-secondary btn-sm" onclick="this.closest('.name-component-item').remove(); App.updateNamePreview();">Remove</button>
              </div>
            `;
          };
          if (order.length) {
            const normalizedOrder = [];
            let lastWasComponent = false;
            let sawSeparator = false;
            const hasComponentAhead = (startIdx) => {
              for (let i = startIdx + 1; i < order.length; i += 1) {
                const next = order[i];
                const nextName = typeof next === 'string' ? next : next?.name;
                if (next && next.type === 'field' && fieldMap.has(next.name)) return true;
                if (typeof next === 'string' && fieldMap.has(nextName)) return true;
                if (next && next.type === 'association' && associationMap.has(next.name)) return true;
              }
              return false;
            };
            order.forEach((item, idx) => {
              if (typeof item === 'string') {
                const field = fieldMap.get(item);
                if (field) {
                  normalizedOrder.push({ type: 'field', name: field.name });
                  lastWasComponent = true;
                }
                return;
              }
              if (item && item.type === 'field') {
                const field = fieldMap.get(item.name);
                if (field) {
                  normalizedOrder.push({ type: 'field', name: field.name });
                  lastWasComponent = true;
                }
              } else if (item && item.type === 'association') {
                const association = associationMap.get(item.name);
                if (association) {
                  normalizedOrder.push({ type: 'association', name: association.name });
                  lastWasComponent = true;
                }
              } else if (item && item.type === 'separator') {
                sawSeparator = true;
                if (!lastWasComponent) return;
                if (!hasComponentAhead(idx)) return;
                normalizedOrder.push({ type: 'separator', value: item.value });
                lastWasComponent = false;
              }
            });
            if (sawSeparator && !normalizedOrder.some(i => i.type === 'separator')) {
              const componentItems = normalizedOrder.filter(i => i.type === 'field' || i.type === 'association');
              if (componentItems.length >= 2) {
                const insertAt = normalizedOrder.findIndex(i => i.type === 'field' || i.type === 'association');
                normalizedOrder.splice(insertAt + 1, 0, { type: 'separator', value: ' ' });
              }
            }
            normalizedOrder.forEach((item) => {
              if (item.type === 'field') {
                const field = fieldMap.get(item.name);
                if (field) parts.push(renderField(field));
                return;
              }
              if (item.type === 'association') {
                const association = associationMap.get(item.name);
                if (association) parts.push(renderAssociation(association));
                return;
              }
              if (item.type === 'separator') {
                const sep = renderSeparator(item.value);
                if (sep) parts.push(sep);
              }
            });
          }
          if (!order.length && hasFirstLast) {
            parts.push(renderField(fieldMap.get('firstName')));
            parts.push(renderSeparator(' '));
            parts.push(renderField(fieldMap.get('lastName')));
          }
          fields.forEach(field => {
            if (!used.has(field.name)) parts.push(renderField(field));
          });
          associations.forEach(association => {
            if (!used.has(association.name)) parts.push(renderAssociation(association));
          });
          return parts.join('');
        })();

        const modalHtml = `
          <div class="modal" id="entityTypeFormModal">
            <div class="modal-content">
              <button class="modal-close" onclick="App.closeEntityTypeForm()">
                <span class="material-icons">close</span>
              </button>
              <div class="modal-header">
                <h3>${typeId ? type.label : 'New entity type'}</h3>
              </div>
              <div class="modal-body">
                <form id="entityTypeForm" data-type-id="${typeId || ''}" onsubmit="App.saveEntityType(event, '${typeId || ''}')">
                  <div class="entity-type-editor">
                    <div class="carded-section modal-group">
                      <div class="entity-type-header">
                        <div class="form-group">
                          <label for="label">Label *</label>
                          <input type="text" name="label" value="${type.label}" required>
                        </div>
                        <div class="form-group">
                          <label>Categories</label>
                          <p class="profile-help u-mt-0">Choose one or more categories where this entity type appears. You can also assign entity types from each category's settings.</p>
                          <div class="category-entity-types-checkboxes">
                            ${Object.values(this.data.categories).map(cat => {
                              const typeCatIds = this.getEntityTypeCategoryIds(type);
                              const checked = typeCatIds.includes(cat.id);
                              return `<label class="checkbox-label category-entity-type-option">
                                <input type="checkbox" class="elistly-checkbox" name="category_${cat.id}" value="1" ${checked ? 'checked' : ''}>
                                <span>${(cat.label || cat.id).replace(/</g, '&lt;')}</span>
                              </label>`;
                            }).join('')}
                          </div>
                        </div>
                        <div class="form-group">
                          <label for="icon">Icon</label>
                          <div class="icon-select" onclick="App.showIconPicker('entityTypeIcon')">
                            <span class="material-icons">${type.icon}</span>
                            <input type="hidden" name="icon" id="entityTypeIcon" value="${type.icon}">
                            <span class="icon-select-text">Click to change icon</span>
                          </div>
                        </div>
                        <div class="form-group name-gen-header">
                          <div class="name-gen-title">Title generator</div>
                          <label class="ui-switch">
                            <input type="checkbox" name="enableNameGen" role="switch" aria-checked="${type.enableNameGen ? 'true' : 'false'}" ${type.enableNameGen ? 'checked' : ''} onchange="App.toggleNameGenSection(this)">
                            <span class="ui-switch-slider" aria-hidden="true"></span>
                            <span class="ui-switch-label">Enable title generator</span>
                          </label>
                        </div>
                      </div>
                    </div>
                    <div class="modal-group carded-section name-generation-settings${type.enableNameGen ? '' : ' hidden'}">
                      <h4>Title Generator</h4>
                      <div class="name-generation-grid">
                        <div class="form-group">
                          <label class="ui-switch">
                            <input type="checkbox" name="prefixEnabled" role="switch" aria-checked="${type.nameGen?.prefixEnabled ? 'true' : 'false'}" ${type.nameGen?.prefixEnabled ? 'checked' : ''} onchange="App.togglePrefixInput(this)">
                            <span class="ui-switch-slider" aria-hidden="true"></span>
                            <span class="ui-switch-label">Use prefix</span>
                          </label>
                          <input type="text" name="namePrefix" value="${type.nameGen?.prefix || ''}" ${type.nameGen?.prefixEnabled ? '' : 'disabled'} onchange="App.updateNamePreview()">
                        </div>
                        <div class="form-group">
                          <label for="suffixType">Suffix Type</label>
                          <select name="suffixType" onchange="App.updateNamePreview()">
                            <option value="number" ${type.nameGen?.suffixType === 'number' ? 'selected' : ''}>Numbers (1, 2, 3...)</option>
                            <option value="letter" ${type.nameGen?.suffixType === 'letter' ? 'selected' : ''}>Letters (A, B, C...)</option>
                          </select>
                          <div class="help-text">Only added for duplicate names</div>
                        </div>
                      </div>
                      <div class="name-components-section">
                        <label>Name Components Order</label>
                        <div class="name-components-container">
                          <div id="nameComponentsList" class="sortable-list">
                            ${nameComponentsHtml}
                          </div>
                        </div>
                      </div>
                      <div class="name-separator-actions">
                        <label>Add separator</label>
                        <div class="separator-buttons">
                          <button type="button" class="btn btn-secondary btn-sm" onclick="App.addNameSeparator(' ')">Space</button>
                          <button type="button" class="btn btn-secondary btn-sm" onclick="App.addNameSeparator('-')">Dash</button>
                          <button type="button" class="btn btn-secondary btn-sm" onclick="App.addNameSeparator('_')">Underscore</button>
                          <button type="button" class="btn btn-secondary btn-sm" onclick="App.addNameSeparator('.')">Dot</button>
                        </div>
                        <div class="custom-separator">
                          <input type="text" id="customSeparatorInput" placeholder="Custom separator">
                          <button type="button" class="btn btn-secondary btn-sm" onclick="App.addNameSeparator(document.getElementById('customSeparatorInput').value)">Insert</button>
                        </div>
                        <p class="help-text">Separators appear where they sit in the list. Drag to place between name parts.</p>
                      </div>
                      <div class="name-preview">
                        <label>Preview</label>
                        <div class="preview-box">
                          <div class="preview-label">Example name</div>
                          <div id="namePreview" class="preview-value"></div>
                        </div>
                        <div class="preview-box preview-secondary">
                          <div class="preview-label">If duplicate (adds suffix)</div>
                          <div id="suffixPreview" class="preview-value"></div>
                        </div>
                      </div>
                    </div>
                    <div class="modal-group carded-section">
                      <h4>Fields</h4>
                      <div class="sortable-list" id="fieldsContainer">
                        ${type.fields.map((field, index) => `
                            <div class="field-card sortable-item" data-index="${index}" data-field-name="${field.name}">
                              <div class="field-label-row field-label-row-inline">
                                <span class="material-icons drag-handle drag-handle-tight" title="Drag to reorder">drag_indicator</span>
                                <strong class="field-label-strong">${field.label}</strong>
                                <button type="button" class="collapse-btn" title="Expand/collapse field" onclick="this.closest('.field-card').classList.toggle('collapsed');event.stopPropagation();">
                                    <span class="material-icons">unfold_less</span>
                                </button>
                              </div>
                              <div class="field-details">
                                <div class="form-group">
                                  <label>Label *</label>
                                  <input type="text" name="fields[${index}].label" value="${field.label}" required>
                                  <input type="hidden" name="fields[${index}].name" value="${field.label?.toLowerCase().replace(/\\s+/g, '_') || ''}">
                                </div>
                                <div class="form-group">
                                  <label>Type *</label>
                                  <select name="fields[${index}].type" onchange="App.handleFieldTypeChange(this)">
                                    <option value="text" ${field.type === 'text' ? 'selected' : ''}>Text</option>
                                    <option value="number" ${field.type === 'number' ? 'selected' : ''}>Number</option>
                                    <option value="dropdown" ${field.type === 'dropdown' ? 'selected' : ''}>Dropdown</option>
                                    <option value="textarea" ${field.type === 'textarea' ? 'selected' : ''}>Textarea</option>
                                    <option value="date" ${field.type === 'date' ? 'selected' : ''}>Date</option>
                                    <option value="checkbox" ${field.type === 'checkbox' ? 'selected' : ''}>Checkbox</option>
                                    <option value="qr" ${field.type === 'qr' ? 'selected' : ''}>QR Code</option>
                                  </select>
                                </div>
                                ${field.type === 'dropdown' ? `
                                  <div class="option-row option-header">
                                    <span>Display Value</span>
                                    <span>Name Value</span>
                                    <span></span>
                                  </div>
                                  <div class="option-rows-container" data-field-index="${index}">
                                  ${(field.options || []).map((opt, oIdx) => `
                                    <div class="option-row" data-option-index="${oIdx}">
                                      <span class="material-icons drag-handle" title="Drag to reorder">drag_indicator</span>
                                      <input type="text" name="fields[${index}].options[${oIdx}].value" value="${opt.value}">
                                      <input type="text" name="fields[${index}].options[${oIdx}].nameValue" value="${opt.nameValue || ''}">
                                      <button type="button" class="btn btn-danger" onclick="App.removeOption(${index}, ${oIdx})">
                                        <span class="material-icons">remove</span>
                                      </button>
                                    </div>
                                  `).join('')}
                                  </div>
                                  <button type="button" class="btn btn-secondary btn-add-field" onclick="App.addOption(${index})">Add Option</button>
                                ` : ''}
                                <div class="checkbox-group checkbox-group-inline">
                                  <label class="checkbox-label">
                                    <input type="checkbox" class="elistly-checkbox" name="fields[${index}].required" ${field.required ? 'checked' : ''}>
                                    <span>Required</span>
                                  </label>
                                  <label class="checkbox-label">
                                    <input type="checkbox" class="elistly-checkbox" name="fields[${index}].visibleInCard" ${field.visibleInCard ? 'checked' : ''}>
                                    <span>Visible in card</span>
                                  </label>
                                  <label class="checkbox-label">
                                    <input type="checkbox" class="elistly-checkbox" name="fields[${index}].partOfName" ${field.partOfName ? 'checked' : ''} ${!type.enableNameGen ? 'disabled' : ''} onchange="App.updateNamePreview()">
                                    <span>In title</span>
                                  </label>
                                </div>
                                <button type="button" class="btn btn-danger" onclick="App.removeField(${index})">
                                  <span class="material-icons">delete</span> Remove Field
                                </button>
                              </div>
                            </div>
                        `).join('')}
                        <button type="button" class="btn btn-add-field" onclick="App.addField()">
                          <span class="material-icons">add</span> Add Field
                        </button>
                      </div>
                    </div>
                    <div class="modal-group carded-section">
                      <h4>Links</h4>
                      <div class="sortable-list" id="associationsContainer">
                        ${type.associations?.map((assoc, idx) => `
                            <div class="assoc-card sortable-item" data-index="${idx}">
                              <span class="material-icons drag-handle" title="Drag to reorder">drag_indicator</span>
                              <div class="form-group">
                                <label>Label *</label>
                                <input type="text" name="associations[${idx}].label" value="${assoc?.label || ''}" required
                                  onchange="this.form.querySelector('[name=\'associations[${idx}].name\']').value = this.value?.toLowerCase().replace(/[^a-z0-9]+/g, '_') || ''">
                                <input type="hidden" name="associations[${idx}].name" value="${assoc?.name || ''}">
                              </div>
                              <div class="form-group">
                                <label>Link type *</label>
                                <select name="associations[${idx}].association.kind" class="association-kind-select" required onchange="App.updateAssociationKindHelp(this)">
                                  <option value="belongs_to" ${assoc?.association?.kind === 'belongs_to' ? 'selected' : ''}>Links to one</option>
                                  <option value="has_many" ${assoc?.association?.kind === 'has_many' ? 'selected' : ''}>Can have many</option>
                                  <option value="hierarchy" ${assoc?.association?.kind === 'hierarchy' ? 'selected' : ''}>Parent/child (same type)</option>
                                </select>
                                <div class="association-kind-help">
                                  <p class="help-text" data-kind="belongs_to">This item links to a single item of the target type (e.g. a Book is lent to one Borrower).</p>
                                  <p class="help-text" data-kind="has_many">This item can link to several items of the target type (e.g. one Person has many Devices).</p>
                                  <p class="help-text" data-kind="hierarchy">This item can have a parent or children of the same type (e.g. a folder inside a folder).</p>
                                </div>
                              </div>
                              <div class="form-group">
                                <label>Links to *</label>
                                <select name="associations[${idx}].association.targetType" required>
                                  ${Object.values(this.data.entityTypes).map(type => `
                                    <option value="${type.id}" ${assoc?.association?.targetType === type.id ? 'selected' : ''}>
                                      ${type.label}
                                    </option>
                                  `).join('')}
                                </select>
                              </div>
                              <div class="checkbox-group checkbox-group-inline">
                                <label class="checkbox-label">
                                  <input type="checkbox" class="elistly-checkbox" name="associations[${idx}].required" ${assoc?.required ? 'checked' : ''}>
                                  <span>Required</span>
                                </label>
                                <label class="checkbox-label">
                                  <input type="checkbox" class="elistly-checkbox" name="associations[${idx}].visibleInCard" ${assoc?.visibleInCard ? 'checked' : ''}>
                                  <span>Visible in card</span>
                                </label>
                                <label class="checkbox-label">
                                  <input type="checkbox" class="elistly-checkbox" name="associations[${idx}].partOfName" ${assoc?.partOfName ? 'checked' : ''} ${!type.enableNameGen ? 'disabled' : ''} onchange="App.updateNamePreview()">
                                  <span>In title</span>
                                </label>
                              </div>
                              <button type="button" class="btn btn-danger" onclick="App.removeAssociation(${idx})">
                                <span class="material-icons">delete</span> Remove link
                              </button>
                            </div>
                        `).join('')}
                        <button type="button" class="btn btn-add-field" onclick="App.addAssociation()">
                          <span class="material-icons">add</span> Add link
                        </button>
                      </div>
                    </div>
                  </div>
                </form>
              </div>

              <div class="modal-actions">
                <button type="button" class="btn btn-secondary" onclick="App.closeModal('entityTypeFormModal')">
                  Cancel
                </button>
                <button type="submit" form="entityTypeForm" class="btn btn-primary">
                  <span class="material-icons">save</span>
                  Save Changes
                </button>
              </div>
            </div>
          </div>
        `;
        
        const div = document.createElement('div');
        div.innerHTML = modalHtml;
        document.body.appendChild(div.firstElementChild);
        this.showModal('entityTypeFormModal');
        this.updateNamePreview();
        this.initNameComponentsDragDrop();
        document.querySelectorAll('#entityTypeFormModal .association-kind-select').forEach(s => this.updateAssociationKindHelp(s));
        
        // Initialize option containers sortable
        this.initAllOptionSortables();
      },

      showSafeEntityTypeEditor(typeId, type) {
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
      
      initAllOptionSortables() {
        // Initialize all option sortables
        document.querySelectorAll('.option-rows-container').forEach(container => {
          this.initOptionsSortable(container);
        });
      },
      
      renderFieldEditor(field, index, enableNameGen) {
        const partOfNameDisabled = enableNameGen === false;
        return `
          <div class="field-editor" data-index="${index}" data-field-name="${field.name || ''}">
            <div class="form-group">
              <label>Label *</label>
              <input type="text" name="fields[${index}].label" value="${field.label}" required>
              <input type="hidden" name="fields[${index}].name" value="${field.name || ''}">
            </div>
            
            <div class="form-group">
              <label>Type *</label>
              <select name="fields[${index}].type" onchange="App.handleFieldTypeChange(this)">
                <option value="text" ${field.type === 'text' ? 'selected' : ''}>Text</option>
                <option value="number" ${field.type === 'number' ? 'selected' : ''}>Number</option>
                <option value="dropdown" ${field.type === 'dropdown' ? 'selected' : ''}>Dropdown</option>
                <option value="textarea" ${field.type === 'textarea' ? 'selected' : ''}>Textarea</option>
                <option value="date" ${field.type === 'date' ? 'selected' : ''}>Date</option>
                <option value="checkbox" ${field.type === 'checkbox' ? 'selected' : ''}>Checkbox</option>
                <option value="qr" ${field.type === 'qr' ? 'selected' : ''}>QR Code</option>
              </select>
            </div>
            
            ${field.type === 'dropdown' ? `
              <div class="form-group field-options">
                <label>Options</label>
                <div class="option-row option-header">
                  <span>Display Value</span>
                  <span>Name Value</span>
                  <span></span>
                </div>
                <div class="option-rows-container" data-field-index="${index}">
                  ${(field.options && field.options.length ? field.options : [{ value: '', nameValue: '' }]).map((opt, optIndex) => `
                    <div class="option-row" data-option-index="${optIndex}">
                      <span class="material-icons drag-handle" title="Drag to reorder">drag_indicator</span>
                      <input type="text" name="fields[${index}].options[${optIndex}].value" placeholder="Value" value="${(opt.value || '').replace(/"/g, '&quot;')}">
                      <input type="text" name="fields[${index}].options[${optIndex}].nameValue" placeholder="Name Value" value="${(opt.nameValue || '').replace(/"/g, '&quot;')}" title="Value used in generated names">
                      <button type="button" class="btn btn-danger" onclick="App.removeOption(${index}, ${optIndex})">
                        <span class="material-icons">remove</span>
                      </button>
                    </div>
                  `).join('')}
                </div>
                <button type="button" class="btn btn-secondary btn-add-field" onclick="App.addOption(${index})">Add Option</button>
              </div>
            ` : ''}
            
            <div class="checkbox-group">
              <label class="checkbox-label">
                <input type="checkbox" class="elistly-checkbox" name="fields[${index}].required" 
                       ${field.required ? 'checked' : ''}>
                <span>Required</span>
              </label>
              
              <label class="checkbox-label">
                <input type="checkbox" class="elistly-checkbox" name="fields[${index}].visibleInCard" 
                       ${field.visibleInCard ? 'checked' : ''}>
                <span>Visible in card</span>
              </label>
              
              <label class="checkbox-label">
                <input type="checkbox" class="elistly-checkbox" name="fields[${index}].partOfName" 
                       ${field.partOfName ? 'checked' : ''} 
                       ${partOfNameDisabled ? 'disabled' : ''}
                       onchange="App.updateNamePreview()">
                <span>In title</span>
              </label>
            </div>
            
            <button type="button" class="btn btn-danger" onclick="App.removeField(${index})">
              <span class="material-icons">delete</span>
              Remove Field
            </button>
          </div>
        `;
      },
      
      saveEntityType(event, typeId) {
        event.preventDefault();
        const form = event.target;
        const formData = new FormData(form);
        
        // Process fields and associations separately
        const fields = this.processFieldsData(formData);
        const associations = this.processAssociationsData(formData);
        
        const categories = Object.keys(this.data.categories || {}).filter(catId => formData.get(`category_${catId}`) === '1');
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
      
      processFieldsData(formData) {
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

      updateAssociationKindHelp(selectEl) {
        const help = selectEl.closest('.form-group')?.querySelector('.association-kind-help');
        if (!help) return;
        help.querySelectorAll('.help-text').forEach(p => {
          p.classList.toggle('visible', p.dataset.kind === selectEl.value);
        });
      },
      
      closeEntityTypeManager() {
        this.closeModal('entityTypeManagerModal');
      },
      
      deleteEntityType(typeId) {
        return this.showSafeEntityTypeDelete(typeId);
        const type = this.data.entityTypes[typeId];
        if (!type) return;
        
        const hasEntities = Object.values(this.data.entities)
          .some(entity => entity.type === typeId);
        
        const confirmModal = `
          <div class="modal" id="confirmDeleteTypeModal">
            <div class="modal-content">
              <button class="modal-close" onclick="App.closeModal('confirmDeleteTypeModal')">
                <span class="material-icons">close</span>
              </button>
              <div class="modal-header">
                <h3>Confirm Delete Type</h3>
              </div>
              ${hasEntities ? `
                <p class="text-danger">Warning: There are entities of this type. Deleting it will also delete all associated entities.</p>
              ` : ''}
              <p>Are you sure you want to delete the entity type "${type.label}"?</p>
              <div class="modal-actions">
                <button class="btn btn-secondary" onclick="App.closeModal('confirmDeleteTypeModal')">Cancel</button>
                <button class="btn btn-danger" onclick="App.confirmDeleteEntityType('${typeId}')">Delete</button>
              </div>
            </div>
          </div>
        `;
        
        const div = document.createElement('div');
        div.innerHTML = confirmModal;
        document.body.appendChild(div.firstElementChild);
        this.showModal('confirmDeleteTypeModal');
      },

      showSafeEntityTypeDelete(typeId) {
        const type = this.data.entityTypes[typeId]; if (!type) return;
        const make = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = text; return el; };
        const modal = make('div', 'modal'); modal.id = 'confirmDeleteTypeModal'; const content = make('div', 'modal-content'); const close = make('button', 'modal-close', '×'); close.type = 'button'; close.addEventListener('click', () => this.closeModal('confirmDeleteTypeModal'));
        const header = make('div', 'modal-header'); header.appendChild(make('h3', '', 'Confirm Delete Type')); const message = make('p', '', `Are you sure you want to delete the entity type "${type.label || type.id || ''}"?`);
        const actions = make('div', 'modal-actions'); const cancel = make('button', 'btn btn-secondary', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', () => this.closeModal('confirmDeleteTypeModal')); const remove = make('button', 'btn btn-danger', 'Delete'); remove.type = 'button'; remove.addEventListener('click', () => this.confirmDeleteEntityType(typeId)); actions.append(cancel, remove); content.append(close, header, message, actions); modal.appendChild(content); document.body.appendChild(modal); this.showModal('confirmDeleteTypeModal');
      },
      
      confirmDeleteEntityType(typeId) {
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

      addNameSeparator(value) {
        const separator = value == null ? '' : String(value);
        if (!separator) return;
        const list = document.getElementById('nameComponentsList');
        if (!list) return;
        const label = separator === ' ' ? 'Space' : separator === '-' ? 'Dash' : separator === '_' ? 'Underscore' : separator === '.' ? 'Dot' : separator;
        const div = document.createElement('div');
        div.className = 'name-component-item name-separator-item sortable-item';
        div.dataset.componentType = 'separator';
        div.dataset.separatorValue = encodeURIComponent(separator);
        div.innerHTML = `
          <span class="material-icons drag-handle" title="Drag to reorder">drag_indicator</span>
          <span class="separator-pill">${label}</span>
          <button type="button" class="btn btn-secondary btn-sm" onclick="this.closest('.name-component-item').remove(); App.updateNamePreview();">Remove</button>
        `;
        const fields = list.querySelectorAll('[data-component-type="field"]');
        if (fields.length >= 2) {
          list.insertBefore(div, fields[1]);
        } else if (fields.length === 1) {
          list.insertBefore(div, fields[0].nextSibling);
        } else {
          list.appendChild(div);
        }
        const customInput = document.getElementById('customSeparatorInput');
        if (customInput) customInput.value = '';
        this.updateNamePreview();
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
              <span class="name-component-label">${field.label}</span>
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
              <span class="name-component-label">${assoc.label}</span>
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

      toggleNameGenSection(enableNameGenCheckbox) {
        const form = enableNameGenCheckbox?.closest('form');
        if (!form) return;
        const section = form.querySelector('.name-generation-settings');
        if (section) section.classList.toggle('hidden', !enableNameGenCheckbox.checked);
        form.querySelectorAll('input[name$=".partOfName"]').forEach(input => {
          input.disabled = !enableNameGenCheckbox.checked;
        });
        enableNameGenCheckbox.setAttribute('aria-checked', enableNameGenCheckbox.checked ? 'true' : 'false');
        this.updateNamePreview();
      },

      togglePrefixInput(checkbox) {
        const form = checkbox?.closest('form');
        if (!form) return;
        const prefixInput = form.querySelector('input[name="namePrefix"]');
        if (prefixInput) prefixInput.disabled = !checkbox.checked;
        checkbox.setAttribute('aria-checked', checkbox.checked ? 'true' : 'false');
        this.updateNamePreview();
      },
      
      addField() {
        const fieldsContainer = document.getElementById('fieldsContainer');
        if (!fieldsContainer) return;
        
        const newIndex = fieldsContainer.querySelectorAll('.field-card, .field-editor').length;
        
        const newField = {
          name: '',
          label: '',
          type: 'text',
          required: false,
          visibleInCard: true,
          partOfName: false
        };
        
        const form = document.getElementById('entityTypeForm');
        const enableNameGen = form?.querySelector('input[name=enableNameGen]')?.checked ?? false;
        const fieldHtml = this.renderFieldEditor(newField, newIndex, enableNameGen);
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = fieldHtml;
        const newFieldElement = tempDiv.firstElementChild;
        fieldsContainer.appendChild(newFieldElement);
        
        // Scroll the new field into view if it exists
        if (newFieldElement) {
          newFieldElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      },
      
      handleFieldTypeChange(select) {
        const fieldEditor = select.closest('.field-editor') || select.closest('.field-card');
        const fieldIndex = fieldEditor.dataset.index;
        const existingBlock = fieldEditor.querySelector('.field-options');
        
        if (select.value === 'dropdown') {
          if (!existingBlock) {
            const div = document.createElement('div');
            div.className = 'form-group field-options';
            div.innerHTML = `
              <label>Options</label>
              <div class="option-row option-header">
                <span>Display Value</span>
                <span>Name Value</span>
                <span></span>
              </div>
              <div class="option-rows-container" data-field-index="${fieldIndex}">
                <div class="option-row" data-option-index="0">
                  <span class="material-icons drag-handle" title="Drag to reorder">drag_indicator</span>
                  <input type="text" name="fields[${fieldIndex}].options[0].value" placeholder="Value">
                  <input type="text" name="fields[${fieldIndex}].options[0].nameValue" placeholder="Name Value" title="Value used in generated names">
                  <button type="button" class="btn btn-danger" onclick="App.removeOption(${fieldIndex}, 0)">
                    <span class="material-icons">remove</span>
                  </button>
                </div>
              </div>
              <button type="button" class="btn btn-secondary btn-add-field" onclick="App.addOption(${fieldIndex})">Add Option</button>
            `;
            select.closest('.form-group').insertAdjacentElement('afterend', div);
            const container = div.querySelector('.option-rows-container');
            if (container) this.initOptionsSortable(container);
          }
        } else if (existingBlock) {
          existingBlock.remove();
        }
      },
      
      addOption(fieldIndex) {
        const fieldEl = document.querySelector(`.field-card[data-index="${fieldIndex}"]`) ||
          document.querySelector(`.field-editor[data-index="${fieldIndex}"]`);
        if (!fieldEl) {
          console.error(`Could not find field with index: ${fieldIndex}`);
          return;
        }
        const optionsContainer = fieldEl.querySelector('.option-rows-container');
        if (!optionsContainer) {
          console.error(`Could not find options container in field with index: ${fieldIndex}`);
          return;
        }
        
        // Get all existing option rows to determine the next index
        const existingOptions = optionsContainer.querySelectorAll('.option-row');
        const newOptionIndex = existingOptions.length;
        
        // Create the new option row
        const optionRow = document.createElement('div');
        optionRow.className = 'option-row';
        optionRow.dataset.optionIndex = newOptionIndex;
        optionRow.innerHTML = `
          <span class="material-icons drag-handle" title="Drag to reorder">drag_indicator</span>
          <input type="text" name="fields[${fieldIndex}].options[${newOptionIndex}].value" placeholder="Value">
          <input type="text" name="fields[${fieldIndex}].options[${newOptionIndex}].nameValue" placeholder="Name Value" title="Value used in generated names">
          <button type="button" class="btn btn-danger" onclick="App.removeOption(${fieldIndex}, ${newOptionIndex})">
            <span class="material-icons">remove</span>
          </button>
        `;
        
        // Add the new row to the container
        optionsContainer.appendChild(optionRow);
        
        // Initialize or refresh sortable on this container
        this.initOptionsSortable(optionsContainer);
      },
      
      removeOption(fieldIndex, optionIndex) {
        const fieldEl = document.querySelector(`.field-card[data-index="${fieldIndex}"]`) ||
          document.querySelector(`.field-editor[data-index="${fieldIndex}"]`);
        if (!fieldEl) return;
        const optionsContainer = fieldEl.querySelector('.option-rows-container');
        if (!optionsContainer) {
          return;
        }
        
        const optionRows = optionsContainer.querySelectorAll('.option-row');
        // Find the option with matching data-option-index
        const optionToRemove = Array.from(optionRows).find(row => 
          row.dataset.optionIndex === optionIndex.toString());
          
        if (optionToRemove) {
          optionToRemove.remove();
          // Update indices
          this.updateOptionIndices(fieldIndex);
        }
      },
      
      initOptionsSortable(container) {
        if (!container || !window.Sortable) return;
        
        // Check if sortable is already initialized
        if (container._sortable) {
          // Refresh sortable instance
          container._sortable.option('onEnd', (evt) => this.handleOptionReorder(evt));
          return;
        }
        
        // Initialize sortable
        container._sortable = new Sortable(container, {
          animation: 150,
          handle: '.drag-handle',
          onEnd: (evt) => this.handleOptionReorder(evt)
        });
      },
      
      handleOptionReorder(evt) {
        const container = evt.to;
        const fieldIndex = container.dataset.fieldIndex;
        
        if (fieldIndex) {
          this.updateOptionIndices(fieldIndex);
        }
      },
      
      updateOptionIndices(fieldIndex) {
        const fieldEl = document.querySelector(`.field-card[data-index="${fieldIndex}"]`) ||
          document.querySelector(`.field-editor[data-index="${fieldIndex}"]`);
        if (!fieldEl) return;
        const optionsContainer = fieldEl.querySelector('.option-rows-container');
        if (!optionsContainer) return;
        
        // Update all input name attributes to match their new positions
        const optionRows = optionsContainer.querySelectorAll('.option-row');
        optionRows.forEach((row, idx) => {
          row.dataset.optionIndex = idx;
          
          // Update input names
          const inputs = row.querySelectorAll('input');
          inputs.forEach(input => {
            // Replace the option index in the name attribute
            const newName = input.name.replace(/options\[\d+\]/, `options[${idx}]`);
            input.name = newName;
          });
          
          // Update remove button onclick
          const removeBtn = row.querySelector('.btn-danger');
          if (removeBtn) {
            removeBtn.setAttribute('onclick', `App.removeOption(${fieldIndex}, ${idx})`);
          }
        });
      },
      
      renderAssociationEditor(assoc, index, enableNameGen = false) {
        return `
          <div class="assoc-card association-editor sortable-item" data-index="${index}">
            <span class="material-icons drag-handle" title="Drag to reorder">drag_indicator</span>
            <div class="form-group">
              <label>Label *</label>
              <input type="text" name="associations[${index}].label" value="${assoc?.label || ''}" required
                     onchange="this.form.querySelector('[name=\'associations[${index}].name\']').value = this.value?.toLowerCase().replace(/[^a-z0-9]+/g, '_') || ''">
              <input type="hidden" name="associations[${index}].name" value="${assoc?.name || ''}">
            </div>
            
            <div class="form-group">
              <label>Link type *</label>
              <select name="associations[${index}].association.kind" class="association-kind-select" required onchange="App.updateAssociationKindHelp(this)">
                <option value="belongs_to" ${assoc?.association?.kind === 'belongs_to' ? 'selected' : ''}>Links to one</option>
                <option value="has_many" ${assoc?.association?.kind === 'has_many' ? 'selected' : ''}>Can have many</option>
                <option value="hierarchy" ${assoc?.association?.kind === 'hierarchy' ? 'selected' : ''}>Parent/child (same type)</option>
              </select>
              <div class="association-kind-help">
                <p class="help-text" data-kind="belongs_to">This item links to a single item of the target type (e.g. a Book is lent to one Borrower).</p>
                <p class="help-text" data-kind="has_many">This item can link to several items of the target type (e.g. one Person has many Devices).</p>
                <p class="help-text" data-kind="hierarchy">This item can have a parent or children of the same type (e.g. a folder inside a folder).</p>
              </div>
            </div>
            
            <div class="form-group">
              <label>Links to *</label>
              <select name="associations[${index}].association.targetType" required>
                ${Object.values(this.data.entityTypes).map(type => `
                  <option value="${type.id}" ${assoc?.association?.targetType === type.id ? 'selected' : ''}>
                    ${type.label}
                  </option>
                `).join('')}
              </select>
            </div>
            <div class="checkbox-group checkbox-group-inline">
              <label class="checkbox-label">
                <input type="checkbox" class="elistly-checkbox" name="associations[${index}].required" ${assoc?.required ? 'checked' : ''}>
                <span>Required</span>
              </label>
              <label class="checkbox-label">
                <input type="checkbox" class="elistly-checkbox" name="associations[${index}].visibleInCard" ${assoc?.visibleInCard ? 'checked' : ''}>
                <span>Visible in card</span>
              </label>
              <label class="checkbox-label">
                <input type="checkbox" class="elistly-checkbox" name="associations[${index}].partOfName" ${assoc?.partOfName ? 'checked' : ''} ${!enableNameGen ? 'disabled' : ''} onchange="App.updateNamePreview()">
                <span>In title</span>
              </label>
            </div>
            
            <button type="button" class="btn btn-danger" onclick="App.removeAssociation(${index})">
              <span class="material-icons">delete</span>
              Remove link
            </button>
          </div>
        `;
      },
      
      addAssociation() {
        const container = document.getElementById('associationsContainer');
        if (!container) return;
        
        const newIndex = container.querySelectorAll('.assoc-card, .association-editor').length;
        const form = document.getElementById('entityTypeForm');
        const enableNameGen = form?.querySelector('input[name=enableNameGen]')?.checked ?? false;
        
        const newAssoc = {
          name: '',
          label: '',
          type: 'association',
          required: false,
          visibleInCard: false,
          partOfName: false,
          association: {
            kind: 'belongs_to',
            targetType: Object.keys(this.data.entityTypes)[0] || ''
          }
        };
        
        const assocHtml = this.renderAssociationEditor(newAssoc, newIndex, enableNameGen);
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = assocHtml;
        const newAssocElement = tempDiv.firstElementChild;
        const addBtn = container.querySelector('.btn-add-field');
        if (addBtn) {
          container.insertBefore(newAssocElement, addBtn);
        } else {
          container.appendChild(newAssocElement);
        }
        this.updateAssociationKindHelp(newAssocElement.querySelector('.association-kind-select'));
        
        // Scroll the new association into view if it exists
        if (newAssocElement) {
          newAssocElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        this.updateNamePreview();
      },
      
      removeAssociation(index) {
        const editor = document.querySelector(`#associationsContainer .assoc-card[data-index="${index}"], #associationsContainer .association-editor[data-index="${index}"], #associationsContainer .field-editor[data-index="${index}"]`);
        if (!editor) return;
        editor.remove();
        
        // Update indices for remaining associations
        document.querySelectorAll('#associationsContainer .assoc-card, #associationsContainer .association-editor, #associationsContainer .field-editor').forEach((assocEditor, newIndex) => {
          assocEditor.dataset.index = newIndex;
          assocEditor.querySelectorAll('[name^="associations["]').forEach(input => {
            input.name = input.name.replace(/associations\[\d+\]/, `associations[${newIndex}]`);
          });
          assocEditor.querySelectorAll('[onchange]').forEach(el => {
            const attr = el.getAttribute('onchange');
            if (attr) el.setAttribute('onchange', attr.replace(/associations\[\d+\]/g, `associations[${newIndex}]`));
          });
          const removeBtn = assocEditor.querySelector('button[onclick*="App.removeAssociation("]');
          if (removeBtn) removeBtn.setAttribute('onclick', `App.removeAssociation(${newIndex})`);
        });
        this.updateNamePreview();
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
              <div class="legal-modal-body">
                <section class="legal-section">
                  <h4>Disclaimer</h4>
                  <p>This software is provided free to use in its current form. Elistly is in <strong>beta</strong>: features and behaviour may change. We do not guarantee availability, correctness, or fitness for any purpose.</p>
                  <p>You use the service and store data at your own risk. We are not responsible for any data you store, any loss of data, or how you use the application. Do not rely on it as the only copy of important information.</p>
                </section>
                <section class="legal-section">
                  <h4>Data &amp; privacy</h4>
                  <p><strong>What we store</strong></p>
                  <p>When you use an account, we store your account data (email, authentication) and your app data: categories, entity types, entities, settings, and optionally theme preferences. Data is stored in the infrastructure configured for this app.</p>
                  <p><strong>Why</strong></p>
                  <p>To provide the app (inventory, workspaces, sync across devices) and to keep your account secure.</p>
                  <p><strong>Your rights</strong></p>
                  <ul class="legal-list">
                    <li><strong>Export</strong> your data: Profile → Export all data.</li>
                    <li><strong>Delete your account</strong>: Profile → Delete account. This removes your account and associated data.</li>
                  </ul>
                  <p>If you use a third-party auth or database provider, their terms also apply.</p>
                </section>
                <section class="legal-section">
                  <h4>Source code</h4>
                  <p>The source code is available for review and auditing on <a href="https://github.com/hoozter/elistly" target="_blank" rel="noopener noreferrer">GitHub</a>.</p>
                </section>
              </div>
            </div>
          </div>
        `;
        const existing = document.getElementById('legalModal');
        if (existing) existing.remove();
        const div = document.createElement('div');
        div.innerHTML = modalHtml;
        document.body.appendChild(div.firstElementChild);
        this.showModal('legalModal');
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
          input.closest('.form-group').querySelector('.help-text').textContent = 'Name will be auto-generated based on fields';
          input.dataset.unlocked = 'false';
          
          // Regenerate name
          const form = button.closest('form');
          const typeId = form.getAttribute('data-type-id');
          const formData = new FormData(form);
          const data = Object.fromEntries(formData.entries());
          const entityId = form.getAttribute('data-entity-id');
          input.value = App.generateAutoName(typeId, data, entityId);
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
      removeField(index) {
        const fieldEditor = document.querySelector(`.field-editor[data-index="${index}"]`) ||
                            document.querySelector(`.field-card[data-index="${index}"]`);
        if (!fieldEditor) return;
        
        fieldEditor.remove();
        
        // Update indices for remaining fields
        document.querySelectorAll('.field-editor, .field-card').forEach((editor, newIndex) => {
          editor.dataset.index = newIndex;
          editor.querySelectorAll('[name^="fields["]').forEach(input => {
            input.name = input.name.replace(/fields\[\d+\]/, `fields[${newIndex}]`);
          });
        });
      },
      /** Export full account data: user info, app data, theme. For backup or portability. */
      async exportAllData() {
        const { data: { user } } = await backendClient.auth.getUser();
        const theme = typeof localStorage !== 'undefined' ? localStorage.getItem('theme') : null;
        const payload = {
          version: this.data.version,
          exportedAt: new Date().toISOString(),
          user: user ? { id: user.id, email: user.email, user_metadata: user.user_metadata } : null,
          theme: theme || undefined,
          appData: {
            categories: this.data.categories,
            entityTypes: this.data.entityTypes,
            entities: this.data.entities,
            settings: this.data.settings
          }
        };
        const data = JSON.stringify(payload, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `elistly-full-export-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        this.showSnackbar('Export downloaded.');
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
                <h3>Add preset</h3>
              </div>
              <p class="preset-modal-copy">Add categories and entity types from a template. Your existing data is kept.</p>
              <div class="button-stack u-m-0">
                ${presets.map(p => `
                  <button type="button" class="btn btn-secondary btn-left" onclick="App.applyPreset('${p.id}', false); App.closeModal('addPresetModal');">
                    <span class="material-icons u-mr-050">folder</span>
                    <span>${p.label}</span>
                  </button>
                `).join('')}
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
      showSafeExportModal() {
        const make = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = text; return el; };
        const checkbox = (name, value, className, checked = false) => { const input = document.createElement('input'); input.type = 'checkbox'; input.name = name; input.value = value; input.className = `elistly-checkbox ${className}`; input.checked = checked; return input; };
        const modal = make('div', 'modal'); modal.id = 'exportModal'; const content = make('div', 'modal-content'); const close = make('button', 'modal-close', '×'); close.type = 'button'; close.addEventListener('click', () => this.closeModal('exportModal'));
        const header = make('div', 'modal-header'); header.appendChild(make('h3', '', 'Export Data')); const body = make('div', 'modal-body modal-body-scroll'); body.appendChild(make('p', '', 'Select the elements you want to export. Only selected items will be included in the export file.')); const form = make('form'); form.id = 'exportForm';
        const section = title => { const el = make('div', 'restore-defaults-section'); el.appendChild(make('h4', '', title)); return el; };
        const typeSection = section('Entity Types'); const typeGrid = make('div', 'restore-defaults-grid');
        Object.entries(this.data.entityTypes || {}).forEach(([typeId, type]) => { const item = make('div', 'restore-item entity-type-card u-pos-relative'); const top = make('div', 'entity-type-header u-flex-between-center'); const details = make('div', 'u-flex-center-gap-07'); details.append(make('span', 'material-icons', type.icon || 'folder')); const label = make('label', 'checkbox-label u-mb-0'); label.append(checkbox('exportEntityTypes', typeId, 'export-entity-type-checkbox'), make('span', '', type.label || typeId || '')); details.appendChild(label); const expand = make('button', 'expand-entity-type expand-toggle material-icons', 'expand_more'); expand.type = 'button'; const fields = make('div', 'entity-fields-list hidden u-mt-050'); expand.addEventListener('click', () => { if (!fields.childNodes.length) this.renderSafeExportFieldsList(typeId, fields); const visible = fields.style.display === 'block'; fields.style.display = visible ? 'none' : 'block'; expand.textContent = visible ? 'expand_more' : 'expand_less'; }); top.append(details, expand); item.append(top, fields); typeGrid.appendChild(item); }); typeSection.appendChild(typeGrid);
        const categorySection = section('Categories'); const categoryGrid = make('div', 'restore-defaults-grid'); Object.entries(this.data.categories || {}).forEach(([categoryId, category]) => { const item = make('div', 'restore-item'); const label = make('label', 'checkbox-label'); label.append(checkbox('exportCategories', categoryId, 'export-category-checkbox'), make('span', '', category.label || categoryId || '')); item.appendChild(label); categoryGrid.appendChild(item); }); categorySection.appendChild(categoryGrid);
        const entitySection = section('Entities'); const entityGrid = make('div', 'restore-defaults-grid'); Object.entries(this.data.entities || {}).forEach(([entityId, entity]) => { const item = make('div', 'restore-item'); const label = make('label', 'checkbox-label'); label.append(checkbox('exportEntities', entityId, 'export-entity-checkbox'), make('span', '', this.getEntityCardTitle(entity))); item.appendChild(label); entityGrid.appendChild(item); }); entitySection.appendChild(entityGrid);
        const settingsSection = section('Settings'); const settingsItem = make('div', 'restore-item'); const settingsLabel = make('label', 'checkbox-label'); settingsLabel.append(checkbox('exportSettings', 'settings', 'export-settings-checkbox', true), make('span', '', 'Settings')); settingsItem.appendChild(settingsLabel); settingsSection.appendChild(settingsItem);
        form.append(typeSection, categorySection, entitySection, settingsSection); body.appendChild(form); const actions = make('div', 'modal-actions'); const cancel = make('button', 'btn btn-secondary', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', () => this.closeModal('exportModal')); const exportButton = make('button', 'btn btn-primary', 'Export Selected'); exportButton.type = 'button'; exportButton.addEventListener('click', () => this.processExport()); actions.append(cancel, exportButton); content.append(close, header, body, actions); modal.appendChild(content); document.body.appendChild(modal); this.showModal('exportModal');
      },

      renderSafeExportFieldsList(typeId, container) {
        const type = this.data.entityTypes[typeId]; if (!type) return;
        container.replaceChildren();
        const make = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = text; return el; };
        const checkbox = (name, value, className) => { const input = document.createElement('input'); input.type = 'checkbox'; input.name = name; input.value = value; input.checked = true; input.className = `elistly-checkbox ${className}`; input.dataset.typeId = typeId; return input; };
        (type.fields || []).forEach(field => { const item = make('div', 'restore-field-item restore-field-item-card'); const label = make('label', 'checkbox-label u-mb-0'); label.append(checkbox('exportField', field.name || '', 'export-field-checkbox'), make('span', '', field.label || field.name || '')); item.appendChild(label); if (field.type === 'dropdown') { const options = make('div', 'restore-options-list'); (field.options || []).forEach((option, index) => { const row = make('label', 'checkbox-label restore-option-item u-ml-150'); const input = checkbox('exportOption', String(index), 'export-option-checkbox'); input.dataset.fieldName = field.name || ''; row.append(input, make('span', '', `${option.value || ''} (${option.nameValue || ''})`)); options.appendChild(row); }); item.appendChild(options); } container.appendChild(item); });
      },
      showExportModal() {
        return this.showSafeExportModal();
        // Build export selection modal
        const defaultEntityTypes = Object.keys(this.data.entityTypes);
        const modalHtml = `
          <div class="modal" id="exportModal">
            <div class="modal-content">
              <button class="modal-close" onclick="App.closeModal('exportModal')">
                <span class="material-icons">close</span>
              </button>
              <div class="modal-header">
                <h3>Export Data</h3>
              </div>
              <div class="modal-body modal-body-scroll">
                <p>Select the elements you want to export. Only selected items will be included in the export file.</p>
                <form id="exportForm">
                  <div class="restore-defaults-section">
                    <h4>Entity Types</h4>
                    <div class="u-pb-8">
                      <label class="checkbox-label">
                        <input type="checkbox" class="elistly-checkbox" id="selectAllExportEntityTypes" onclick="App.toggleAllCheckboxes('export-entity-type-checkbox', this.checked)">
                        <span>Select All Entity Types</span>
                      </label>
                    </div>
                    <div class="restore-defaults-grid">
                      ${defaultEntityTypes.map(typeId => {
                        const type = this.data.entityTypes[typeId];
                        return `<div class="restore-item entity-type-card u-pos-relative" data-entity-type="${typeId}">
                          <div class="entity-type-header u-flex-between-center">
                            <div class="u-flex-center-gap-07">
                        <span class="material-icons">${type.icon}</span>
                              <label class="checkbox-label u-mb-0">
                                <input type="checkbox" class="elistly-checkbox export-entity-type-checkbox" name="exportEntityTypes" value="${typeId}">
                        <span>${type.label}</span>
                              </label>
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
                        <input type="checkbox" class="elistly-checkbox" id="selectAllExportCategories" onclick="App.toggleAllCheckboxes('export-category-checkbox', this.checked)">
                        <span>Select All Categories</span>
                      </label>
              </div>
                    <div class="restore-defaults-grid">
                      ${Object.keys(this.data.categories).map(catId => {
                        const cat = this.data.categories[catId];
                        return `<div class="restore-item">
                          <label class="checkbox-label">
                            <input type="checkbox" class="elistly-checkbox export-category-checkbox" name="exportCategories" value="${catId}">
                            <span>${cat.label}</span>
                          </label>
                        </div>`;
                      }).join('')}
                        </div>
                      </div>
                  <div class="restore-defaults-section">
                    <h4>Entities</h4>
                    <div class="u-pb-8">
                                  <label class="checkbox-label">
                        <input type="checkbox" class="elistly-checkbox" id="selectAllExportEntities" onclick="App.toggleAllCheckboxes('export-entity-checkbox', this.checked)">
                        <span>Select All Entities</span>
                                  </label>
                    </div>
                    <div class="restore-defaults-grid">
                      ${Object.keys(this.data.entities).map(entityId => {
                        const entity = this.data.entities[entityId];
                        return `<div class="restore-item">
                                  <label class="checkbox-label">
                            <input type="checkbox" class="elistly-checkbox export-entity-checkbox" name="exportEntities" value="${entityId}">
                            <span>${this.getEntityCardTitle(entity)}</span>
                                  </label>
                        </div>`;
                      }).join('')}
                    </div>
                  </div>
                  <div class="restore-defaults-section">
                    <h4>Settings</h4>
                    <div class="restore-item">
                                  <label class="checkbox-label">
                        <input type="checkbox" class="elistly-checkbox export-settings-checkbox" name="exportSettings" value="settings" checked>
                        <span>Settings</span>
                                  </label>
                    </div>
                  </div>
                </form>
              </div>
              <div class="modal-actions">
                <button class="btn btn-secondary" onclick="App.closeModal('exportModal')">Cancel</button>
                <button class="btn btn-primary" onclick="App.processExport()">
                  <span class="material-icons">download</span>Export Selected
                </button>
              </div>
            </div>
          </div>
        `;
        const div = document.createElement('div');
        div.innerHTML = modalHtml;
        document.body.appendChild(div.firstElementChild);
        this.showModal('exportModal');

        // Add expand/collapse logic for entity type cards
        document.querySelectorAll('.expand-entity-type').forEach(icon => {
          icon.addEventListener('click', function(e) {
            const typeId = this.dataset.entityType;
            const fieldsList = document.querySelector(`.entity-fields-list[data-entity-type-fields="${typeId}"]`);
            if (!fieldsList) return;
            if (fieldsList.style.display === 'none' || !fieldsList.style.display) {
              if (!fieldsList.innerHTML) {
                App.renderExportFieldsList(typeId, fieldsList);
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

      renderExportFieldsList(typeId, container) {
        return this.renderSafeExportFieldsList(typeId, container);
        const type = this.data.entityTypes[typeId];
        if (!type) return;
        container.innerHTML = (type.fields || []).map((field, fIdx) => {
          let optionHtml = '';
          if (field.type === 'dropdown') {
            optionHtml = `<div class='restore-dropdown-options u-ml-150 u-mt-030'>
              <div class='expand-dropdown-options u-flex-center-gap-05 expand-toggle' data-field-name='${field.name}'>
                <span class='material-icons'>expand_more</span>
                <span class='u-fs-095'>Dropdown Options</span>
              </div>
              <div class='restore-options-list' data-options-list='${field.name}' class='hidden'>
                ${(field.options || []).map((opt, oIdx) => {
                  return `<div class='restore-option-item u-ml-150'>
                    <label class='checkbox-label'>
                      <input type='checkbox' name='exportOption_${typeId}_${field.name}' value='${oIdx}' class='elistly-checkbox export-option-checkbox' checked>
                      <span>${opt.value} (${opt.nameValue})</span>
                    </label>
                  </div>`;
                }).join('')}
              </div>
            </div>`;
          }
          return `<div class='restore-field-item restore-field-item-card'>
            <div class='u-flex-center-gap-07'>
              <label class='checkbox-label u-mb-0'>
                <input type='checkbox' name='exportField_${typeId}' value='${field.name}' class='elistly-checkbox export-field-checkbox' checked>
                <span>${field.label}</span>
              </label>
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

      processExport() {
        const form = document.getElementById('exportForm');
        if (!form) return;
        // Gather selected entity types, fields, options
        const selectedEntityTypes = Array.from(form.querySelectorAll('input[name="exportEntityTypes"]:checked')).map(input => input.value);
        const selectedCategories = Array.from(form.querySelectorAll('input[name="exportCategories"]:checked')).map(input => input.value);
        const selectedEntities = Array.from(form.querySelectorAll('input[name="exportEntities"]:checked')).map(input => input.value);
        const exportSettings = form.querySelector('input[name="exportSettings"]:checked');

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
          entities: {},
          settings: exportSettings ? JSON.parse(JSON.stringify(this.data.settings)) : undefined
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
        if (!exportObj.settings) delete exportObj.settings;

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
          const reader = new FileReader();
          reader.onload = function(ev) {
            try {
              const imported = JSON.parse(ev.target.result);
              App.renderImportPreview(imported);
              document.getElementById('processImportBtn').disabled = false;
              App._importDataPreview = imported;
            } catch (err) {
              document.getElementById('importPreviewArea').innerHTML = '<div class="text-danger">Invalid JSON file.</div>';
              document.getElementById('processImportBtn').disabled = true;
              App._importDataPreview = null;
            }
          };
          reader.readAsText(file);
        });
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

        if (!hasImportableData) previewArea.textContent = 'No importable data found in file.';
      },

      processImport() {
        const form = document.getElementById('importModal');
        if (!this._importDataPreview) return;
        // Get selected checkboxes
        const selectedEntityTypes = Array.from(document.querySelectorAll('input[name="importEntityTypes"]:checked')).map(input => input.value);
        const selectedCategories = Array.from(document.querySelectorAll('input[name="importCategories"]:checked')).map(input => input.value);
        const selectedEntities = Array.from(document.querySelectorAll('input[name="importEntities"]:checked')).map(input => input.value);
        const importSettings = document.querySelector('input[name="importSettings"]:checked');
        const imported = this._importDataPreview;
        let importedCount = 0;
        // Entity Types
        if (imported.entityTypes) {
          for (const typeId of selectedEntityTypes) {
            if (imported.entityTypes[typeId]) {
              this.data.entityTypes[typeId] = JSON.parse(JSON.stringify(imported.entityTypes[typeId]));
              importedCount++;
            }
          }
        }
        // Categories
        if (imported.categories) {
          for (const catId of selectedCategories) {
            if (imported.categories[catId]) {
              this.data.categories[catId] = JSON.parse(JSON.stringify(imported.categories[catId]));
              importedCount++;
            }
          }
        }
        // Entities
        if (imported.entities) {
          for (const entityId of selectedEntities) {
            if (imported.entities[entityId]) {
              this.data.entities[entityId] = JSON.parse(JSON.stringify(imported.entities[entityId]));
              importedCount++;
            }
          }
        }
        // Settings
        if (importSettings && imported.settings) {
          this.data.settings = this.normalizeSettings(imported.settings, this.data.settings);
          importedCount++;
        }
        this.saveData();
        this.closeModal('importModal');
        this.loadView('dashboard');
        this.showNotification(`Imported ${importedCount} item${importedCount === 1 ? '' : 's'} successfully`, 'success');
        this._importDataPreview = null;
      }
    };

  window.App = App;

  // Kick off the app once scripts and DOM are ready
  document.addEventListener('DOMContentLoaded', () => App.init());
