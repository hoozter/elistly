/**
 * Elistly API Worker – JWT Authentication with Neon
 *
 * Endpoints:
 * Auth: /auth/signup, /auth/login, /auth/refresh, /auth/logout
 * MFA: /auth/mfa/factors, /auth/mfa/enroll, /auth/mfa/verify, /auth/mfa/challenge, /auth/mfa/unenroll, /auth/mfa/status
 * DB: /db/query (for QueryBuilder)
 * App: /me, /app-data, /profile, /admin/*, /users/me, etc.
 *
 * Required env secrets: NEON_DATABASE_URL, JWT_SECRET
 * Uses Web Crypto for all crypto (JWT HS256, PBKDF2 passwords, TOTP RFC 6238).
 * No Node.js libraries — compatible with the standard Cloudflare Workers runtime.
 */

import { neon } from "@neondatabase/serverless";
import {
  signJwt,
  verifyJwt,
  hashPassword,
  verifyPassword,
  generateTotpSecret,
  verifyTotp,
  encryptTotpSecret,
  decryptTotpSecret,
  buildOtpauthUri,
  uuidv4,
} from "./auth.js";

const TOKEN_COOKIE_NAME = "elistly_token";

// sql is initialized per-request inside fetch() using env.NEON_DATABASE_URL.
// Do NOT call neon() at module scope — env is not available there.
let sql;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function readJsonBody(req) {
  try { return await req.json(); } catch { return null; }
}

function corsHeaders(origin, exposeAuth = false) {
  const o = origin || "*";
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Cache-Control": "no-store, no-cache",
  };
  if (exposeAuth) headers["Access-Control-Expose-Headers"] = "Set-Cookie";
  return headers;
}

function jsonResponse(body, status = 200, origin = null, opts = {}) {
  return new Response(JSON.stringify(body), {
    headers: corsHeaders(origin, opts.exposeAuth),
    status,
  });
}

function setCookie(response, name, value, maxAge = 7 * 24 * 60 * 60) {
  response.headers.append(
    "Set-Cookie",
    `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`
  );
}

function clearCookie(response, name) {
  response.headers.append(
    "Set-Cookie",
    `${name}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
  );
}

function getTokenFromRequest(req) {
  const auth = req.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const cookies = req.headers.get("Cookie") || "";
  const match = cookies.match(new RegExp(`(^| )${TOKEN_COOKIE_NAME}=([^;]+)`));
  return match ? match[2] : null;
}

async function getAuthenticatedUser(req, env) {
  const token = getTokenFromRequest(req);
  if (!token) return null;
  const payload = await verifyJwt(token, env.JWT_SECRET);
  if (!payload?.sub) return null;
  return { id: payload.sub, email: payload.email, mfa_verified: payload.mfa_verified, ...payload };
}

async function checkMfaRequired(userId) {
  const rows = await sql`
    SELECT 1 FROM user_mfa
    WHERE user_id = ${userId} AND factor_type = 'totp' AND verified_at IS NOT NULL
  `;
  return rows.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

async function handleSignup(req, env, origin) {
  const body = await readJsonBody(req);
  if (!body?.email || !body?.password) {
    return jsonResponse({ error: "Email and password required" }, 400, origin);
  }
  const email = body.email.trim().toLowerCase();
  if (body.password.length < 6) {
    return jsonResponse({ error: "Password must be at least 6 characters" }, 400, origin);
  }
  try {
    const existing = await sql`SELECT id FROM user_auth WHERE email_lower = ${email}`;
    if (existing.length > 0) {
      return jsonResponse({ error: "User already exists" }, 400, origin);
    }
    const passwordHash = await hashPassword(body.password);
    const userId = uuidv4();
    const now = new Date().toISOString();
    await sql`
      INSERT INTO user_auth (id, email, email_lower, password_hash, created_at, updated_at, email_confirmed_at)
      VALUES (${userId}, ${email}, ${email}, ${passwordHash}, ${now}, ${now}, ${now})
    `;
    await sql`
      INSERT INTO user_preferences (user_id, created_at, updated_at)
      VALUES (${userId}, ${now}, ${now})
      ON CONFLICT (user_id) DO NOTHING
    `;
    await sql`
      INSERT INTO profiles (user_id, display_name, updated_at)
      VALUES (${userId}, NULL, ${now})
      ON CONFLICT (user_id) DO NOTHING
    `;
    const token = await signJwt({ sub: userId, email, mfa_verified: true }, env.JWT_SECRET);
    const response = jsonResponse({ token, user: { id: userId, email } }, 201, origin, { exposeAuth: true });
    setCookie(response, TOKEN_COOKIE_NAME, token);
    return response;
  } catch (e) {
    console.error("Signup error:", e);
    return jsonResponse({ error: "Internal server error", detail: e.message }, 500, origin);
  }
}

async function handleLogin(req, env, origin) {
  const body = await readJsonBody(req);
  if (!body?.email || !body?.password) {
    return jsonResponse({ error: "Email and password required" }, 400, origin);
  }
  const email = body.email.trim().toLowerCase();
  const totpToken = body.totp_token || null;

  try {
    const userRows = await sql`SELECT id, email, password_hash FROM user_auth WHERE email_lower = ${email}`;
    const userAuth = userRows[0];
    if (!userAuth) return jsonResponse({ error: "Invalid credentials" }, 401, origin);

    const valid = await verifyPassword(body.password, userAuth.password_hash);
    if (!valid) return jsonResponse({ error: "Invalid credentials" }, 401, origin);

    const mfaRows = await sql`
      SELECT id, secret_encrypted FROM user_mfa
      WHERE user_id = ${userAuth.id} AND factor_type = 'totp' AND verified_at IS NOT NULL
    `;
    const hasMfa = mfaRows.length > 0;

    if (hasMfa) {
      const encKey = env.TOTP_ENCRYPTION_KEY || env.JWT_SECRET;
      if (!totpToken) {
        // Return partial token — client must supply TOTP to complete login
        const token = await signJwt({ sub: userAuth.id, email: userAuth.email, mfa_verified: false }, env.JWT_SECRET);
        return jsonResponse(
          { token, user: { id: userAuth.id, email: userAuth.email }, totp_required: true, factor_id: mfaRows[0].id },
          200, origin, { exposeAuth: true }
        );
      }
      // Decrypt and verify TOTP
      const secret = await decryptTotpSecret(mfaRows[0].secret_encrypted, encKey);
      if (!secret || !await verifyTotp(secret, totpToken)) {
        return jsonResponse({ error: "Invalid verification code" }, 401, origin);
      }
    }

    await sql`UPDATE user_auth SET last_sign_in_at = NOW() WHERE id = ${userAuth.id}`;
    const token = await signJwt({ sub: userAuth.id, email: userAuth.email, mfa_verified: true }, env.JWT_SECRET);
    const response = jsonResponse({ token, user: { id: userAuth.id, email: userAuth.email } }, 200, origin, { exposeAuth: true });
    setCookie(response, TOKEN_COOKIE_NAME, token);
    return response;
  } catch (e) {
    console.error("Login error:", e);
    return jsonResponse({ error: "Internal server error", detail: e.message }, 500, origin);
  }
}

async function handleRefresh(req, env, origin) {
  const token = getTokenFromRequest(req);
  if (!token) return jsonResponse({ error: "Unauthorized" }, 401, origin);
  // Allow refresh of expired tokens (skip exp check) by decoding directly
  const parts = token.split(".");
  if (parts.length !== 3) return jsonResponse({ error: "Invalid token" }, 401, origin);
  let payload;
  try {
    payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return jsonResponse({ error: "Invalid token" }, 401, origin);
  }
  if (!payload?.sub) return jsonResponse({ error: "Invalid token" }, 401, origin);
  const newToken = await signJwt({ sub: payload.sub, email: payload.email, mfa_verified: payload.mfa_verified === true }, env.JWT_SECRET);
  const response = jsonResponse({ token: newToken }, 200, origin, { exposeAuth: true });
  setCookie(response, TOKEN_COOKIE_NAME, newToken);
  return response;
}

async function handleLogout(req, env, origin) {
  const response = jsonResponse({ ok: true }, 200, origin);
  clearCookie(response, TOKEN_COOKIE_NAME);
  return response;
}

// ─────────────────────────────────────────────────────────────────────────────
// MFA ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

async function handleMfaFactors(req, env, origin) {
  const user = await getAuthenticatedUser(req, env);
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401, origin);
  const rows = await sql`
    SELECT id, factor_type, verified_at, created_at FROM user_mfa
    WHERE user_id = ${user.id} AND factor_type = 'totp'
  `;
  return jsonResponse({
    totp: rows.map(r => ({ id: r.id, factor_type: r.factor_type, status: r.verified_at ? "verified" : "unverified", created_at: r.created_at })),
  }, 200, origin);
}

async function handleMfaEnroll(req, env, origin) {
  const user = await getAuthenticatedUser(req, env);
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401, origin);

  const existing = await sql`
    SELECT id FROM user_mfa WHERE user_id = ${user.id} AND factor_type = 'totp' AND verified_at IS NOT NULL
  `;
  if (existing.length > 0) return jsonResponse({ error: "MFA already enrolled" }, 400, origin);

  const secret = generateTotpSecret();
  const encKey = env.TOTP_ENCRYPTION_KEY || env.JWT_SECRET;
  const secretEncrypted = await encryptTotpSecret(secret, encKey);
  const factorId = uuidv4();
  const now = new Date().toISOString();

  await sql`
    INSERT INTO user_mfa (id, user_id, factor_type, secret_encrypted, created_at, verified_at)
    VALUES (${factorId}, ${user.id}, 'totp', ${secretEncrypted}, ${now}, NULL)
    ON CONFLICT (user_id, factor_type) DO UPDATE
      SET secret_encrypted = EXCLUDED.secret_encrypted,
          updated_at = EXCLUDED.created_at,
          verified_at = NULL
  `;

  const otpAuthUrl = buildOtpauthUri(secret, user.email, "Elistly");
  return jsonResponse({ factor_id: factorId, secret, qr_code: otpAuthUrl }, 200, origin);
}

async function handleMfaVerify(req, env, origin) {
  const user = await getAuthenticatedUser(req, env);
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401, origin);
  const body = await readJsonBody(req);
  const factorId = body?.factor_id;
  const code = body?.code;
  if (!factorId || !code) return jsonResponse({ error: "factor_id and code required" }, 400, origin);

  const factorRows = await sql`
    SELECT secret_encrypted, verified_at FROM user_mfa
    WHERE id = ${factorId} AND user_id = ${user.id} AND factor_type = 'totp'
  `;
  if (factorRows.length === 0) return jsonResponse({ error: "Factor not found" }, 404, origin);

  const encKey = env.TOTP_ENCRYPTION_KEY || env.JWT_SECRET;
  const secret = await decryptTotpSecret(factorRows[0].secret_encrypted, encKey);
  if (!secret || !await verifyTotp(secret, code)) {
    return jsonResponse({ error: "Invalid verification code" }, 401, origin);
  }

  if (!factorRows[0].verified_at) {
    await sql`UPDATE user_mfa SET verified_at = NOW() WHERE id = ${factorId}`;
  }

  const token = await signJwt({ sub: user.id, email: user.email, mfa_verified: true }, env.JWT_SECRET);
  const response = jsonResponse({ token }, 200, origin);
  setCookie(response, TOKEN_COOKIE_NAME, token);
  return response;
}

async function handleMfaChallenge(req, env, origin) {
  const user = await getAuthenticatedUser(req, env);
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401, origin);
  const body = await readJsonBody(req);
  const factorId = body?.factorId;
  if (!factorId) return jsonResponse({ error: "factorId required" }, 400, origin);
  const rows = await sql`SELECT id FROM user_mfa WHERE id = ${factorId} AND user_id = ${user.id}`;
  if (rows.length === 0) return jsonResponse({ error: "Factor not found" }, 404, origin);
  return jsonResponse({ challenge: { id: factorId, expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString() } }, 200, origin);
}

async function handleMfaUnenroll(req, env, origin) {
  const user = await getAuthenticatedUser(req, env);
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401, origin);
  const body = await readJsonBody(req);
  const factorId = body?.factor_id;
  if (!factorId) return jsonResponse({ error: "factor_id required" }, 400, origin);
  await sql`DELETE FROM user_mfa WHERE id = ${factorId} AND user_id = ${user.id}`;
  return jsonResponse({ ok: true }, 200, origin);
}

async function handleMfaStatus(req, env, origin) {
  const user = await getAuthenticatedUser(req, env);
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401, origin);
  const mfaRows = await sql`
    SELECT 1 FROM user_mfa WHERE user_id = ${user.id} AND factor_type = 'totp' AND verified_at IS NOT NULL
  `;
  const hasMfa = mfaRows.length > 0;
  const mfaVerified = user.mfa_verified === true;
  const currentLevel = hasMfa && mfaVerified ? "aal2" : "aal1";
  return jsonResponse({ currentLevel, nextLevel: "aal2" }, 200, origin);
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERIC DB QUERY ENDPOINT (QueryBuilder passthrough)
// ─────────────────────────────────────────────────────────────────────────────

async function handleDbQuery(req, env, origin) {
  const user = await getAuthenticatedUser(req, env);
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401, origin);
  if (!user.mfa_verified && await checkMfaRequired(user.id)) {
    return jsonResponse({ error: "MFA verification required" }, 403, origin);
  }
  const body = await readJsonBody(req);
  const { sql: sqlText, params } = body || {};
  if (!sqlText || typeof sqlText !== "string") {
    return jsonResponse({ error: "Missing sql query" }, 400, origin);
  }
  try {
    const rows = await sql.query(sqlText, params || []);
    return jsonResponse({ data: rows.rows }, 200, origin);
  } catch (e) {
    console.error("DB query error:", e.message);
    return jsonResponse({ error: "Query failed", detail: e.message }, 500, origin);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FETCH
// ─────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(req, env, ctx) {
    // Initialize the Neon client from env (must be done inside fetch, not at module scope).
    if (!sql || !env._sqlInitialized) {
      sql = neon(env.NEON_DATABASE_URL);
      env._sqlInitialized = true;
    }

    const origin = req.headers.get("Origin") || "*";
    try {
      const url = new URL(req.url);
      const path = url.pathname;

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
      }

      // Health check
      if (path === "/health" || path === "/") {
        return jsonResponse({ ok: true, service: "elistly-api", provider: "neon" }, 200, origin);
      }

      // Debug env (remove or guard before production if desired)
      if (path === "/debug-env") {
        const keys = typeof env === "object" && env !== null ? Object.keys(env).filter(k => !k.startsWith("_")) : [];
        return jsonResponse({ envKeys: keys, provider: "neon", hasBackendUrl: !!env.NEON_DATABASE_URL }, 200, origin);
      }

      // ───── AUTH ROUTES ─────
      if (path === "/auth/signup" && req.method === "POST") return handleSignup(req, env, origin);
      if (path === "/auth/login" && req.method === "POST") return handleLogin(req, env, origin);
      if (path === "/auth/refresh" && req.method === "POST") return handleRefresh(req, env, origin);
      if (path === "/auth/logout" && req.method === "POST") return handleLogout(req, env, origin);

      // ───── MFA ROUTES ─────
      if (path === "/auth/mfa/factors" && req.method === "GET") return handleMfaFactors(req, env, origin);
      if (path === "/auth/mfa/enroll" && req.method === "POST") return handleMfaEnroll(req, env, origin);
      if (path === "/auth/mfa/verify" && req.method === "POST") return handleMfaVerify(req, env, origin);
      if (path === "/auth/mfa/challenge" && req.method === "POST") return handleMfaChallenge(req, env, origin);
      if (path === "/auth/mfa/unenroll" && req.method === "POST") return handleMfaUnenroll(req, env, origin);
      if (path === "/auth/mfa/status" && req.method === "GET") return handleMfaStatus(req, env, origin);

      // ───── DB QUERY ─────
      if (path === "/db/query" && req.method === "POST") return handleDbQuery(req, env, origin);

      // ───── AUTHENTICATED APP ROUTES ─────
      const user = await getAuthenticatedUser(req, env);
      if (!user) return jsonResponse({ error: "Unauthorized" }, 401, origin);
      if (!user.mfa_verified && await checkMfaRequired(user.id)) {
        return jsonResponse({ error: "MFA verification required", mfa_required: true }, 403, origin);
      }

      // GET /me
      if (path === "/me" && req.method === "GET") {
        return jsonResponse({ user: { id: user.id, email: user.email } }, 200, origin);
      }

      // GET/PUT /app-data
      if (path === "/app-data") {
        if (req.method === "GET") {
          const rows = await sql`SELECT payload, updated_at FROM app_data WHERE user_id = ${user.id}`;
          return jsonResponse({ data: rows[0]?.payload ?? null }, 200, origin);
        }
        if (req.method === "PUT") {
          const body = await readJsonBody(req);
          const payload = body?.payload ?? body ?? null;
          const now = new Date().toISOString();
          await sql`
            INSERT INTO app_data (user_id, payload, updated_at)
            VALUES (${user.id}, ${JSON.stringify(payload)}, ${now})
            ON CONFLICT (user_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at
          `;
          return jsonResponse({ ok: true }, 200, origin);
        }
      }

      // GET/PUT /profile
      if (path === "/profile") {
        if (req.method === "GET") {
          const rows = await sql`SELECT display_name, updated_at FROM profiles WHERE user_id = ${user.id}`;
          return jsonResponse({ profile: rows[0] ?? null }, 200, origin);
        }
        if (req.method === "PUT") {
          const body = await readJsonBody(req);
          const displayName = body?.display_name ?? null;
          const now = new Date().toISOString();
          const rows = await sql`
            INSERT INTO profiles (user_id, display_name, updated_at)
            VALUES (${user.id}, ${displayName}, ${now})
            ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = EXCLUDED.updated_at
            RETURNING display_name, updated_at
          `;
          return jsonResponse({ profile: rows[0] ?? null }, 200, origin);
        }
      }

      // Secondary email (not implemented)
      if (path === "/secondary-email/send" || path === "/secondary-email/confirm") {
        return jsonResponse({ error: "Not implemented" }, 501, origin);
      }

      // GET /admin/me
      if (path === "/admin/me") {
        const rows = await sql`SELECT user_id FROM admin_users WHERE user_id = ${user.id}`;
        return jsonResponse({ admin: rows.length > 0 }, 200, origin);
      }

      // DELETE /users/me
      if (path === "/users/me" && req.method === "DELETE") {
        await sql`DELETE FROM app_data WHERE user_id = ${user.id}`;
        await sql`DELETE FROM profiles WHERE user_id = ${user.id}`;
        await sql`DELETE FROM admin_users WHERE user_id = ${user.id}`;
        await sql`DELETE FROM user_preferences WHERE user_id = ${user.id}`;
        await sql`DELETE FROM user_mfa WHERE user_id = ${user.id}`;
        await sql`DELETE FROM user_auth WHERE id = ${user.id}`;
        return jsonResponse({ ok: true }, 200, origin);
      }

      // GET/DELETE /admin/users
      if (path === "/admin/users") {
        const adminCheck = await sql`SELECT user_id FROM admin_users WHERE user_id = ${user.id}`;
        if (adminCheck.length === 0) return jsonResponse({ error: "Forbidden" }, 403, origin);
        if (req.method === "GET") {
          const authUsers = await sql`
            SELECT ua.id, ua.email, ua.created_at, up.user_name
            FROM user_auth ua
            LEFT JOIN user_preferences up ON ua.id = up.user_id
            WHERE ua.email_confirmed_at IS NOT NULL
            ORDER BY ua.created_at DESC
          `;
          return jsonResponse({ users: authUsers.map(u => ({ id: u.id, email: u.email, created_at: u.created_at, user_name: u.user_name })) }, 200, origin);
        }
        return jsonResponse({ error: "Method not allowed" }, 405, origin);
      }

      // DELETE /admin/users/:id
      const deleteUserMatch = path.match(/^\/admin\/users\/([a-zA-Z0-9-]+)$/);
      if (deleteUserMatch && req.method === "DELETE") {
        const adminCheck = await sql`SELECT user_id FROM admin_users WHERE user_id = ${user.id}`;
        if (adminCheck.length === 0) return jsonResponse({ error: "Forbidden" }, 403, origin);
        const targetId = deleteUserMatch[1];
        await sql`DELETE FROM app_data WHERE user_id = ${targetId}`;
        await sql`DELETE FROM profiles WHERE user_id = ${targetId}`;
        await sql`DELETE FROM admin_users WHERE user_id = ${targetId}`;
        await sql`DELETE FROM user_preferences WHERE user_id = ${targetId}`;
        await sql`DELETE FROM user_mfa WHERE user_id = ${targetId}`;
        await sql`DELETE FROM user_auth WHERE id = ${targetId}`;
        return jsonResponse({ ok: true }, 200, origin);
      }

      return jsonResponse({ error: "Not found" }, 404, origin);
    } catch (e) {
      console.error("Unhandled error:", e);
      return jsonResponse({ error: "Internal server error", detail: e?.message ?? String(e) }, 500, origin);
    }
  },
};
