/**
 * Elistly API Worker – Neon Auth + Neon Postgres.
 *
 * Auth is delegated to Neon Auth. App data stays behind this Worker so the
 * browser never receives a database connection string.
 *
 * Required env secrets:
 *   NEON_DATABASE_URL
 *   NEON_AUTH_URL
 *   NEON_AUTH_JWKS_URL
 *   ELISTLY_ADMIN_EMAILS (optional comma-separated admin email allowlist)
 */

import { neon } from "@neondatabase/serverless";

const AUTH_COOKIE_NAME = "__Secure-neon-auth.session_token";
const jwksCache = { keys: null, expiresAt: 0 };

let sql;

async function readJsonBody(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function corsHeaders(origin) {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Cache-Control": "no-store, no-cache",
  };
}

function jsonResponse(body, status = 200, origin = null, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders(origin), ...extraHeaders },
    status,
  });
}

function copySetCookie(source, target) {
  const setCookie = source.headers.get("set-cookie");
  if (setCookie) target.headers.append("Set-Cookie", setCookie);
}

function cookieHeaderFromSetCookie(setCookie) {
  if (!setCookie) return "";
  return setCookie
    .split(/,(?=\s*[^;,=\s]+=[^;,]+)/)
    .map(cookie => cookie.trim().split(";")[0])
    .filter(Boolean)
    .join("; ");
}

function base64urlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function decodeJwtPart(value) {
  return JSON.parse(new TextDecoder().decode(base64urlDecode(value)));
}

async function getJwks(env) {
  if (jwksCache.keys && Date.now() < jwksCache.expiresAt) return jwksCache.keys;
  const jwksUrl = env.NEON_AUTH_JWKS_URL || `${env.NEON_AUTH_URL.replace(/\/$/, "")}/.well-known/jwks.json`;
  const response = await fetch(jwksUrl);
  if (!response.ok) throw new Error("Failed to load Neon Auth JWKS");
  const body = await response.json();
  jwksCache.keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache.expiresAt = Date.now() + 10 * 60 * 1000;
  return jwksCache.keys;
}

async function verifyNeonJwt(token, env) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const header = decodeJwtPart(parts[0]);
  const payload = decodeJwtPart(parts[1]);
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
  if (!payload.sub) return null;

  const keys = await getJwks(env);
  const jwk = keys.find(key => key.kid === header.kid);
  if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519") return null;

  const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
  const valid = await crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    base64urlDecode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  return valid ? payload : null;
}

function getBearerToken(req) {
  const auth = req.headers.get("Authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
}

async function getAuthenticatedUser(req, env) {
  const payload = await verifyNeonJwt(getBearerToken(req), env);
  if (!payload) return null;
  return {
    id: payload.sub,
    email: payload.email || null,
    name: payload.name || null,
    role: payload.role || null,
    ...payload,
  };
}

function getAuthUrl(env, path) {
  return `${env.NEON_AUTH_URL.replace(/\/$/, "")}${path}`;
}

function configuredAdminEmails(env) {
  return String(env.ELISTLY_ADMIN_EMAILS || "")
    .split(",")
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
}

async function isAdmin(user, env) {
  if (!user) return false;
  const adminEmails = configuredAdminEmails(env);
  if (user.email && adminEmails.includes(String(user.email).toLowerCase())) {
    await sql`
      INSERT INTO admin_users (user_id)
      VALUES (${user.id})
      ON CONFLICT (user_id) DO NOTHING
    `;
    return true;
  }

  const activeAdmins = await sql`
    SELECT au.user_id
    FROM admin_users au
    JOIN neon_auth."user" u ON u.id::text = au.user_id
    LIMIT 1
  `;
  if (activeAdmins.length === 0) {
    const firstUsers = await sql`
      SELECT id::text AS id
      FROM neon_auth."user"
      ORDER BY "createdAt" ASC, id ASC
      LIMIT 1
    `;
    if (firstUsers[0]?.id === user.id) {
      await sql`
        INSERT INTO admin_users (user_id)
        VALUES (${user.id})
        ON CONFLICT (user_id) DO NOTHING
      `;
      return true;
    }
  }

  const rows = await sql`SELECT user_id FROM admin_users WHERE user_id = ${user.id}`;
  return rows.length > 0;
}

async function callNeonAuth(env, path, options = {}) {
  return fetch(getAuthUrl(env, path), {
    method: options.method || "GET",
    headers: options.headers || {},
    body: options.body,
  });
}

async function fetchSessionFromCookie(env, origin, cookieHeader) {
  if (!cookieHeader) return { jwt: null, session: null, user: null };
  const response = await callNeonAuth(env, "/get-session", {
    headers: {
      "Origin": origin || "",
      "Cookie": cookieHeader,
    },
  });
  const body = await response.json().catch(() => null);
  return {
    jwt: response.headers.get("set-auth-jwt"),
    session: body && body.session ? body.session : null,
    user: body && body.user ? body.user : null,
    response,
  };
}

async function handleAuthStart(req, env, origin, kind) {
  const body = await readJsonBody(req);
  if (!body?.email || !body?.password) {
    return jsonResponse({ error: "Email and password required" }, 400, origin);
  }

  const authBody = {
    email: body.email,
    password: body.password,
  };
  if (kind === "signup") {
    authBody.name = body.name || body.email.split("@")[0];
  } else {
    authBody.rememberMe = true;
  }

  const authResponse = await callNeonAuth(env, kind === "signup" ? "/sign-up/email" : "/sign-in/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": origin || "",
    },
    body: JSON.stringify(authBody),
  });

  const authResult = await authResponse.json().catch(() => ({}));
  if (!authResponse.ok) {
    return jsonResponse({ error: authResult.message || authResult.error || "Authentication failed" }, authResponse.status, origin);
  }

  const cookieHeader = cookieHeaderFromSetCookie(authResponse.headers.get("set-cookie"));
  const sessionResult = await fetchSessionFromCookie(env, origin, cookieHeader);
  if (!sessionResult.jwt) {
    return jsonResponse({ error: "Authentication succeeded, but no JWT was issued" }, 502, origin);
  }

  const response = jsonResponse({
    token: sessionResult.jwt,
    user: {
      id: sessionResult.user?.id || authResult.user?.id,
      email: sessionResult.user?.email || authResult.user?.email,
      name: sessionResult.user?.name || authResult.user?.name || null,
    },
  }, kind === "signup" ? 201 : 200, origin);
  copySetCookie(authResponse, response);
  return response;
}

async function handleRefresh(req, env, origin) {
  const sessionResult = await fetchSessionFromCookie(env, origin, req.headers.get("Cookie") || "");
  if (!sessionResult.jwt) {
    return jsonResponse({ error: "Unauthorized" }, 401, origin);
  }
  const response = jsonResponse({ token: sessionResult.jwt }, 200, origin);
  if (sessionResult.response) copySetCookie(sessionResult.response, response);
  return response;
}

async function handleLogout(req, env, origin) {
  const authResponse = await callNeonAuth(env, "/sign-out", {
    method: "POST",
    headers: {
      "Origin": origin || "",
      "Cookie": req.headers.get("Cookie") || "",
    },
  });
  const response = jsonResponse({ ok: authResponse.ok }, authResponse.ok ? 200 : authResponse.status, origin);
  copySetCookie(authResponse, response);
  response.headers.append("Set-Cookie", `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`);
  return response;
}

function normalizeAppDataRow(row) {
  if (!row) return { payload: null, updated_at: null };
  return { payload: row.payload ?? null, updated_at: row.updated_at ?? null };
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "*";

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      if (!sql) sql = neon(env.NEON_DATABASE_URL);

      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/health" || path === "/") {
        return jsonResponse({ ok: true, service: "elistly-api", provider: "neon", auth: "neon-auth" }, 200, origin);
      }

      if (path === "/debug-env") {
        const keys = typeof env === "object" && env !== null ? Object.keys(env).filter(key => !key.startsWith("_")) : [];
        return jsonResponse({
          envKeys: keys,
          provider: "neon",
          auth: "neon-auth",
          hasDatabaseUrl: !!env.NEON_DATABASE_URL,
          hasAuthUrl: !!env.NEON_AUTH_URL,
          hasAuthJwksUrl: !!env.NEON_AUTH_JWKS_URL,
        }, 200, origin);
      }

      if (path === "/auth/signup" && req.method === "POST") return handleAuthStart(req, env, origin, "signup");
      if (path === "/auth/login" && req.method === "POST") return handleAuthStart(req, env, origin, "login");
      if (path === "/auth/refresh" && req.method === "POST") return handleRefresh(req, env, origin);
      if (path === "/auth/logout" && req.method === "POST") return handleLogout(req, env, origin);
      if (path === "/auth/mfa/status" && req.method === "GET") {
        return jsonResponse({ currentLevel: "aal1", nextLevel: "aal1" }, 200, origin);
      }
      if (path === "/auth/mfa/factors" && req.method === "GET") {
        return jsonResponse({ totp: [] }, 200, origin);
      }
      if (path.startsWith("/auth/mfa/")) {
        return jsonResponse({ error: "MFA is not implemented for Neon Auth yet" }, 501, origin);
      }

      const user = await getAuthenticatedUser(req, env);
      if (!user) return jsonResponse({ error: "Unauthorized" }, 401, origin);

      if (path === "/me" && req.method === "GET") {
        return jsonResponse({ user: { id: user.id, email: user.email, name: user.name } }, 200, origin);
      }

      if (path === "/app-data") {
        if (req.method === "GET") {
          const rows = await sql`SELECT payload, updated_at FROM app_data WHERE user_id = ${user.id}`;
          return jsonResponse(normalizeAppDataRow(rows[0]), 200, origin);
        }
        if (req.method === "PUT") {
          const body = await readJsonBody(req);
          const payload = body?.payload ?? body ?? {};
          const rows = await sql`
            INSERT INTO app_data (user_id, payload, updated_at)
            VALUES (${user.id}, ${JSON.stringify(payload)}::jsonb, NOW())
            ON CONFLICT (user_id) DO UPDATE
              SET payload = EXCLUDED.payload,
                  updated_at = EXCLUDED.updated_at
            RETURNING payload, updated_at
          `;
          return jsonResponse(normalizeAppDataRow(rows[0]), 200, origin);
        }
      }

      if (path === "/profile") {
        if (req.method === "GET") {
          const rows = await sql`SELECT display_name, updated_at FROM profiles WHERE user_id = ${user.id}`;
          return jsonResponse({ profile: rows[0] || null }, 200, origin);
        }
        if (req.method === "PUT") {
          const body = await readJsonBody(req);
          const rows = await sql`
            INSERT INTO profiles (user_id, email, display_name, updated_at)
            VALUES (${user.id}, ${user.email}, ${body?.display_name || user.name || null}, NOW())
            ON CONFLICT (user_id) DO UPDATE
              SET email = EXCLUDED.email,
                  display_name = EXCLUDED.display_name,
                  updated_at = EXCLUDED.updated_at
            RETURNING display_name, updated_at
          `;
          return jsonResponse({ profile: rows[0] || null }, 200, origin);
        }
      }

      if (path === "/secondary-email/send" || path === "/secondary-email/confirm") {
        return jsonResponse({ error: "Secondary email management is not implemented yet" }, 501, origin);
      }

      if (path === "/admin/me" && req.method === "GET") {
        return jsonResponse({ admin: await isAdmin(user, env) }, 200, origin);
      }

      if (path === "/users/me" && req.method === "DELETE") {
        await sql`DELETE FROM app_data WHERE user_id = ${user.id}`;
        await sql`DELETE FROM profiles WHERE user_id = ${user.id}`;
        await sql`DELETE FROM admin_users WHERE user_id = ${user.id}`;
        await sql`DELETE FROM neon_auth."user" WHERE id::text = ${user.id}`;
        return jsonResponse({ ok: true }, 200, origin);
      }

      if (path === "/admin/users") {
        if (!await isAdmin(user, env)) return jsonResponse({ error: "Forbidden" }, 403, origin);
        if (req.method === "GET") {
          const users = await sql`
            SELECT id::text AS id, email, name, "createdAt" AS created_at
            FROM neon_auth."user"
            ORDER BY "createdAt" DESC
          `;
          return jsonResponse({ users }, 200, origin);
        }
        return jsonResponse({ error: "Method not allowed" }, 405, origin);
      }

      const deleteUserMatch = path.match(/^\/admin\/users\/([a-zA-Z0-9-]+)$/);
      if (deleteUserMatch && req.method === "DELETE") {
        if (!await isAdmin(user, env)) return jsonResponse({ error: "Forbidden" }, 403, origin);
        const targetId = deleteUserMatch[1];
        await sql`DELETE FROM app_data WHERE user_id = ${targetId}`;
        await sql`DELETE FROM profiles WHERE user_id = ${targetId}`;
        await sql`DELETE FROM admin_users WHERE user_id = ${targetId}`;
        await sql`DELETE FROM neon_auth."user" WHERE id::text = ${targetId}`;
        return jsonResponse({ ok: true }, 200, origin);
      }

      return jsonResponse({ error: "Not found" }, 404, origin);
    } catch (error) {
      console.error("Unhandled Worker error:", error);
      return jsonResponse({ error: "Internal server error", detail: error?.message || String(error) }, 500, origin);
    }
  },
};
