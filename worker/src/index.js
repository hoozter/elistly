/**
 * Elistly API Worker – health, account delete, admin (list/delete users).
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY (for verifying user JWT), SUPABASE_SERVICE_ROLE_KEY.
 */

const SUPABASE_AUTH = '/auth/v1';
const SUPABASE_REST = '/rest/v1';

async function getAuthUser(env, bearerToken) {
  if (!bearerToken || !bearerToken.startsWith('Bearer ')) return null;
  const token = bearerToken.slice(7).trim();
  if (!token) return null;
  const url = `${env.SUPABASE_URL}${SUPABASE_AUTH}/user`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: env.SUPABASE_ANON_KEY
    }
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data && data.id ? data : null;
}

async function isAdmin(env, userId) {
  const url = `${env.SUPABASE_URL}${SUPABASE_REST}/admin_users?user_id=eq.${userId}&select=user_id`;
  const res = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) return false;
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0;
}

function corsHeaders(origin) {
  const o = origin || '*';
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': o,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store, no-cache'
  };
}

function jsonResponse(body, status = 200, origin = null) {
  return new Response(JSON.stringify(body), {
    headers: corsHeaders(origin),
    status
  });
}

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get('Origin') || '*';
    try {
      const url = new URL(req.url);
      const path = url.pathname;

      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
      }

      if (path === '/health' || path === '/') {
        return jsonResponse({ ok: true, service: 'elistly-api' }, 200, origin);
      }

      if (path === '/debug-env') {
        const keys = typeof env === 'object' && env !== null ? Object.keys(env) : [];
        return jsonResponse({ envKeys: keys, hasSupabaseUrl: !!env.SUPABASE_URL }, 200, origin);
      }

      const authHeader = req.headers.get('Authorization');

      if (path === '/admin/me') {
        const user = await getAuthUser(env, authHeader);
        if (!user) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
        const admin = await isAdmin(env, user.id);
        return jsonResponse({ admin }, 200, origin);
      }

    if (path === '/users/me' && req.method === 'DELETE') {
      const user = await getAuthUser(env, authHeader);
      if (!user) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
      const serviceUrl = env.SUPABASE_URL;
      const key = env.SUPABASE_SERVICE_ROLE_KEY;
      const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

      await fetch(`${serviceUrl}${SUPABASE_REST}/app_data?user_id=eq.${user.id}`, { method: 'DELETE', headers });
      const deleteAuthRes = await fetch(`${serviceUrl}${SUPABASE_AUTH}/admin/users/${user.id}`, {
        method: 'DELETE',
        headers: { apikey: key, Authorization: `Bearer ${key}` }
      });
      if (!deleteAuthRes.ok) {
        const err = await deleteAuthRes.text();
        return jsonResponse({ error: err || 'Failed to delete account' }, deleteAuthRes.status, origin);
      }
      return jsonResponse({ ok: true }, 200, origin);
    }

    if (path === '/admin/users') {
      const user = await getAuthUser(env, authHeader);
      if (!user) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
      if (!(await isAdmin(env, user.id))) return jsonResponse({ error: 'Forbidden' }, 403, origin);
      if (req.method === 'GET') {
        const listRes = await fetch(`${env.SUPABASE_URL}${SUPABASE_AUTH}/admin/users`, {
          headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }
        });
        if (!listRes.ok) return jsonResponse({ error: 'Failed to list users' }, listRes.status, origin);
        const list = await listRes.json();
        const users = (list.users || list).map(u => ({
          id: u.id,
          email: u.email,
          created_at: u.created_at,
          user_metadata: u.user_metadata
        }));
        return jsonResponse({ users }, 200, origin);
      }
      return jsonResponse({ error: 'Method not allowed' }, 405, origin);
    }

    const deleteUserMatch = path.match(/^\/admin\/users\/([a-f0-9-]+)$/);
    if (deleteUserMatch && req.method === 'DELETE') {
      const targetId = deleteUserMatch[1];
      const user = await getAuthUser(env, authHeader);
      if (!user) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
      if (!(await isAdmin(env, user.id))) return jsonResponse({ error: 'Forbidden' }, 403, origin);
      const serviceUrl = env.SUPABASE_URL;
      const key = env.SUPABASE_SERVICE_ROLE_KEY;
      const headers = { apikey: key, Authorization: `Bearer ${key}` };
      await fetch(`${serviceUrl}${SUPABASE_REST}/app_data?user_id=eq.${targetId}`, { method: 'DELETE', headers });
      const deleteRes = await fetch(`${serviceUrl}${SUPABASE_AUTH}/admin/users/${targetId}`, { method: 'DELETE', headers });
      if (!deleteRes.ok) return jsonResponse({ error: 'Failed to delete user' }, deleteRes.status, origin);
      return jsonResponse({ ok: true }, 200, origin);
    }

      return jsonResponse({ error: 'Not found' }, 404, origin);
    } catch (e) {
      return jsonResponse(
        { error: 'Internal server error', detail: e && e.message ? e.message : String(e) },
        500,
        origin
      );
    }
  }
};
