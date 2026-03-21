/**
 * Elistly API Worker – stable app-owned API surface for auth-adjacent features,
 * user data, profile data, and admin actions.
 *
 * Backend: Neon (PostgreSQL via @neondatabase/serverless HTTP driver)
 * Auth: Neon Auth (Stack Auth) – JWT verified by decoding sub claim
 * Required env vars: NEON_DATABASE_URL
 */

import { neon } from "@neondatabase/serverless";

function getAuthUser(bearerToken) {
  if (!bearerToken?.startsWith("Bearer ")) return null;
  const token = bearerToken.slice(7).trim();
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.sub ? { id: payload.sub, ...payload } : null;
  } catch { return null; }
}

async function readJsonBody(req) {
  try {
    return await req.json();
  } catch (_) {
    return null;
  }
}

function corsHeaders(origin) {
  const o = origin || '*';
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': o,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
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
        return jsonResponse({ ok: true, service: 'elistly-api', provider: 'neon' }, 200, origin);
      }

      if (path === '/debug-env') {
        const keys = typeof env === 'object' && env !== null ? Object.keys(env) : [];
        return jsonResponse(
          { envKeys: keys, provider: 'neon', hasBackendUrl: !!env.NEON_DATABASE_URL },
          200,
          origin
        );
      }

      const authHeader = req.headers.get('Authorization');
      const sql = neon(env.NEON_DATABASE_URL);

      if (path === '/me' && req.method === 'GET') {
        const user = getAuthUser(authHeader);
        if (!user) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
        return jsonResponse({
          user: {
            id: user.id,
            email: user.email || null,
            user_metadata: user.user_metadata || {}
          }
        }, 200, origin);
      }

      if (path === '/app-data' && req.method === 'GET') {
        const user = getAuthUser(authHeader);
        if (!user) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
        const rows = await sql`SELECT payload, updated_at FROM app_data WHERE user_id = ${user.id}`;
        const row = rows[0] || null;
        return jsonResponse(
          { payload: row?.payload ?? null, updated_at: row?.updated_at ?? null },
          200,
          origin
        );
      }

      if (path === '/app-data' && req.method === 'PUT') {
        const user = getAuthUser(authHeader);
        if (!user) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object' || !('payload' in body)) {
          return jsonResponse({ error: 'Invalid payload' }, 400, origin);
        }
        const now = new Date().toISOString();
        const payloadJson = JSON.stringify(body.payload || {});
        const rows = await sql`
          INSERT INTO app_data (user_id, payload, updated_at)
          VALUES (${user.id}, ${payloadJson}::jsonb, ${now})
          ON CONFLICT (user_id) DO UPDATE
            SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at
          RETURNING payload, updated_at
        `;
        const row = rows[0] || {};
        return jsonResponse({ payload: row.payload ?? {}, updated_at: row.updated_at ?? null }, 200, origin);
      }

      if (path === '/profile' && req.method === 'GET') {
        const user = getAuthUser(authHeader);
        if (!user) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
        const rows = await sql`SELECT display_name, updated_at FROM profiles WHERE user_id = ${user.id}`;
        return jsonResponse({ profile: rows[0] || null }, 200, origin);
      }

      if (path === '/profile' && req.method === 'PUT') {
        const user = getAuthUser(authHeader);
        if (!user) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object') {
          return jsonResponse({ error: 'Invalid profile body' }, 400, origin);
        }
        const now = new Date().toISOString();
        const rows = await sql`
          INSERT INTO profiles (user_id, display_name, updated_at)
          VALUES (${user.id}, ${body.display_name || null}, ${now})
          ON CONFLICT (user_id) DO UPDATE
            SET display_name = EXCLUDED.display_name, updated_at = EXCLUDED.updated_at
          RETURNING display_name, updated_at
        `;
        return jsonResponse({ profile: rows[0] || null }, 200, origin);
      }

      if (path === '/secondary-email/send' && req.method === 'POST') {
        const user = getAuthUser(authHeader);
        if (!user) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
        return jsonResponse({ error: 'Not implemented with Neon Auth' }, 501, origin);
      }

      if (path === '/secondary-email/confirm' && req.method === 'POST') {
        const user = getAuthUser(authHeader);
        if (!user) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
        return jsonResponse({ error: 'Not implemented with Neon Auth' }, 501, origin);
      }

      if (path === '/admin/me') {
        const user = getAuthUser(authHeader);
        if (!user) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
        const rows = await sql`SELECT user_id FROM admin_users WHERE user_id = ${user.id}`;
        return jsonResponse({ admin: rows.length > 0 }, 200, origin);
      }

      if (path === '/users/me' && req.method === 'DELETE') {
        const user = getAuthUser(authHeader);
        if (!user) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
        await sql`DELETE FROM app_data WHERE user_id = ${user.id}`;
        await sql`DELETE FROM profiles WHERE user_id = ${user.id}`;
        await sql`DELETE FROM admin_users WHERE user_id = ${user.id}`;
        return jsonResponse({ ok: true }, 200, origin);
      }

      if (path === '/admin/users') {
        const user = getAuthUser(authHeader);
        if (!user) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
        const adminCheck = await sql`SELECT user_id FROM admin_users WHERE user_id = ${user.id}`;
        if (adminCheck.length === 0) return jsonResponse({ error: 'Forbidden' }, 403, origin);
        if (req.method === 'GET') {
          let users = [];
          try {
            const authUsers = await sql`SELECT id, email, created_at, raw_json FROM neon_auth.users_sync WHERE deleted_at IS NULL`;
            users = authUsers.map(u => ({
              id: u.id,
              email: u.email,
              created_at: u.created_at,
              user_metadata: u.raw_json ? (typeof u.raw_json === 'string' ? JSON.parse(u.raw_json) : u.raw_json) : {}
            }));
          } catch (_) {
            users = [];
          }
          return jsonResponse({ users }, 200, origin);
        }
        return jsonResponse({ error: 'Method not allowed' }, 405, origin);
      }

      const deleteUserMatch = path.match(/^\/admin\/users\/([a-zA-Z0-9_-]+)$/);
      if (deleteUserMatch && req.method === 'DELETE') {
        const targetId = deleteUserMatch[1];
        const user = getAuthUser(authHeader);
        if (!user) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
        const adminCheck = await sql`SELECT user_id FROM admin_users WHERE user_id = ${user.id}`;
        if (adminCheck.length === 0) return jsonResponse({ error: 'Forbidden' }, 403, origin);
        await sql`DELETE FROM app_data WHERE user_id = ${targetId}`;
        await sql`DELETE FROM profiles WHERE user_id = ${targetId}`;
        await sql`DELETE FROM admin_users WHERE user_id = ${targetId}`;
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
