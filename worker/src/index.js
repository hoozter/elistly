/**
 * Elistly API Worker – JWT Authentication with Neon
 *
 * Endpoints:
 * Auth: /auth/signup, /auth/login, /auth/refresh, /auth/logout
 * MFA: /auth/mfa/factors, /auth/mfa/enroll, /auth/mfa/verify, /auth/mfa/challenge, /auth/mfa/unenroll, /auth/mfa/status
 * DB: /db/query (for QueryBuilder)
 * App: /me, /app-data, /profile, /admin/*, /users/me, etc.
 *
 * Required env: NEON_DATABASE_URL, JWT_SECRET
 */

import { neon } from "@neondatabase/serverless";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { authenticator } from "otplib";

const sql = neon(env.NEON_DATABASE_URL);
const JWT_SECRET = env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("Missing JWT_SECRET environment variable");
}

const TOKEN_COOKIE_NAME = "elistly_token";
const TOKEN_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

function generateId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function verifyJwt(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

function getAuthUser(bearerToken) {
  if (!bearerToken?.startsWith("Bearer ")) return null;
  const token = bearerToken.slice(7).trim();
  const payload = verifyJwt(token);
  if (!payload || !payload.sub) return null;
  // Return payload plus convenience fields
  return {
    id: payload.sub,
    email: payload.email,
    mfa_verified: payload.mfa_verified,
    ...payload,
  };
}

function getTokenFromCookies(req) {
  const cookieHeader = req.headers.get("Cookie") || "";
  const match = cookieHeader.match(new RegExp(`(^| )${TOKEN_COOKIE_NAME}=([^;]+)`));
  return match ? match[2] : null;
}

function getAuthenticatedUser(req) {
  const authHeader = req.headers.get("Authorization");
  const tokenFromHeader = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  const tokenFromCookie = getTokenFromCookies(req);
  const token = tokenFromHeader || tokenFromCookie;
  if (!token) return null;
  const payload = verifyJwt(token);
  if (!payload || !payload.sub) return null;
  return {
    id: payload.sub,
    email: payload.email,
    mfa_verified: payload.mfa_verified,
    ...payload,
  };
}

async function readJsonBody(req) {
  try {
    return await req.json();
  } catch (_) {
    return null;
  }
}

function setCookie(response, name, value, options = { httpOnly: true, secure: true, sameSite: "Strict", maxAge: TOKEN_TTL }) {
  const { path = "/", ...rest } = options;
  let cookie = `${name}=${value}; Path=${path}`;
  if (rest.httpOnly) cookie += "; HttpOnly";
  if (rest.secure) cookie += "; Secure";
  if (rest.sameSite) cookie += `; SameSite=${rest.sameSite}`;
  if (rest.maxAge) cookie += `; Max-Age=${rest.maxAge}`;
  response.headers.append("Set-Cookie", cookie);
}

function clearCookie(response, name, options = { path: "/" }) {
  setCookie(response, name, "", { ...options, maxAge: 0 });
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
  if (exposeAuth) {
    headers["Access-Control-Expose-Headers"] = "Set-Cookie";
  }
  return headers;
}

function jsonResponse(body, status = 200, origin = null, opts = {}) {
  return new Response(JSON.stringify(body), {
    headers: corsHeaders(origin, opts.exposeAuth),
    status,
  });
}

// Helper to check if MFA is required for user (has verified factor and session not mfa_verified)
async function checkMfaRequired(user) {
  if (!user) return false;
  // If user has mfa_verified flag true, ok
  if (user.mfa_verified === true) return false;
  // Check if user has any verified MFA factor
  const rows = await sql`SELECT 1 FROM user_mfa WHERE user_id = ${user.id} AND factor_type = 'totp' AND verified_at IS NOT NULL`;
  if (rows.length > 0) {
    // Has MFA but not verified in this session => required
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

async function handleSignup(req, env, ctx, origin) {
  const body = await readJsonBody(req);
  if (!body || !body.email || !body.password) {
    return jsonResponse({ error: "Email and password required" }, 400, origin);
  }
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password;

  if (password.length < 6) {
    return jsonResponse({ error: "Password must be at least 6 characters" }, 400, origin);
  }

  try {
    const existing = await sql`SELECT id FROM user_auth WHERE email_lower = ${email}`;
    if (existing.length > 0) {
      return jsonResponse({ error: "User already exists" }, 400, origin);
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const userId = generateId();
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

    // Since no MFA yet, mfa_verified true
    const payload = {
      sub: userId,
      email: email,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL,
      mfa_verified: true,
    };
    const token = jwt.sign(payload, JWT_SECRET);
    const response = jsonResponse(
      { token, user: { id: userId, email } },
      201,
      origin,
      { exposeAuth: true }
    );
    setCookie(response, TOKEN_COOKIE_NAME, token);
    return response;
  } catch (e) {
    console.error("Signup error:", e);
    return jsonResponse(
      { error: "Internal server error", detail: e.message },
      500,
      origin
    );
  }
}

async function handleLogin(req, env, ctx, origin) {
  const body = await readJsonBody(req);
  if (!body || !body.email || !body.password) {
    return jsonResponse({ error: "Email and password required" }, 400, origin);
  }
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password;
  const totpToken = body.totp_token || null;

  try {
    const userRows = await sql`
      SELECT id, email, password_hash FROM user_auth WHERE email_lower = ${email}
    `;
    const userAuth = userRows[0];
    if (!userAuth) {
      return jsonResponse({ error: "Invalid credentials" }, 401, origin);
    }

    const valid = await bcrypt.compare(password, userAuth.password_hash);
    if (!valid) {
      return jsonResponse({ error: "Invalid credentials" }, 401, origin);
    }

    // Check for verified MFA factor
    const mfaRows = await sql`
      SELECT id FROM user_mfa
      WHERE user_id = ${userAuth.id} AND factor_type = 'totp' AND verified_at IS NOT NULL
    `;
    const hasMfa = mfaRows.length > 0;
    let mfa_verified = false;
    let factorId = null;

    if (hasMFA) {
      if (!totpToken) {
        // Return temporary token with mfa_verified=false and flag to trigger MFA
        factorId = mfaRows[0].id;
        mfa_verified = false;
        const payload = {
          sub: userAuth.id,
          email: userAuth.email,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + TOKEN_TTL,
          mfa_verified: false,
        };
        const token = jwt.sign(payload, JWT_SECRET);
        return jsonResponse(
          { token, user: { id: userAuth.id, email: userAuth.email }, totp_required: true, factor_id: factorId },
          200,
          origin,
          { exposeAuth: true }
        );
      }
      // Verify TOTP
      const secretRow = await sql`SELECT secret_encrypted FROM user_mfa WHERE id = ${mfaRows[0].id}`;
      const secret = secretRow[0].secret_encrypted;
      const isValid = authenticator.verify({ secret, token: totpToken });
      if (!isValid) {
        return jsonResponse({ error: "Invalid verification code" }, 401, origin);
      }
      mfa_verified = true;
    } else {
      mfa_verified = true;
    }

    // Update last_sign_in_at
    await sql`UPDATE user_auth SET last_sign_in_at = NOW() WHERE id = ${userAuth.id}`;

    // Issue final token
    const payload = {
      sub: userAuth.id,
      email: userAuth.email,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL,
      mfa_verified: mfa_verified,
    };
    const token = jwt.sign(payload, JWT_SECRET);
    const response = jsonResponse(
      { token, user: { id: userAuth.id, email: userAuth.email } },
      200,
      origin,
      { exposeAuth: true }
    );
    setCookie(response, TOKEN_COOKIE_NAME, token);
    return response;
  } catch (e) {
    console.error("Login error:", e);
    return jsonResponse(
      { error: "Internal server error", detail: e.message },
      500,
      origin
    );
  }
}

async function handleRefresh(req, env, ctx, origin) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ error: "Unauthorized" }, 401, origin);
  }
  const token = authHeader.slice(7).trim();
  const payload = verifyJwt(token);
  if (!payload || !payload.sub) {
    return jsonResponse({ error: "Invalid token" }, 401, origin);
  }

  // Re-issue token with new exp, preserving mfa_verified
  const newPayload = {
    sub: payload.sub,
    email: payload.email,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL,
    mfa_verified: payload.mfa_verified === true,
  };
  const newToken = jwt.sign(newPayload, JWT_SECRET);
  const response = jsonResponse({ token: newToken }, 200, origin, { exposeAuth: true });
  setCookie(response, TOKEN_COOKIE_NAME, newToken);
  return response;
}

async function handleLogout(req, env, ctx, origin) {
  const response = jsonResponse({ ok: true }, 200, origin);
  clearCookie(response, TOKEN_COOKIE_NAME);
  return response;
}

async function handleMfaFactors(req, env, ctx, origin) {
  const user = getAuthenticatedUser(req);
  if (!user) {
    return jsonResponse({ error: "Unauthorized" }, 401, origin);
  }
  const rows = await sql`
    SELECT id, factor_type, verified_at, created_at FROM user_mfa
    WHERE user_id = ${user.id} AND factor_type = 'totp'
  `;
  const factors = rows.map((r) => ({
    id: r.id,
    factor_type: r.factor_type,
    status: r.verified_at ? "verified" : "unverified",
    created_at: r.created_at,
  }));
  return jsonResponse({ totp: factors }, 200, origin);
}

async function handleMfaEnroll(req, env, ctx, origin) {
  const user = getAuthenticatedUser(req);
  if (!user) {
    return jsonResponse({ error: "Unauthorized" }, 401, origin);
  }
  // Check if already verified MFA exists
  const existing = await sql`
    SELECT id FROM user_mfa
    WHERE user_id = ${user.id} AND factor_type = 'totp' AND verified_at IS NOT NULL
  `;
  if (existing.length > 0) {
    return jsonResponse({ error: "MFA already enrolled" }, 400, origin);
  }

  const secret = authenticator.generateSecret();
  const factorId = generateId();
  const now = new Date().toISOString();

  await sql`
    INSERT INTO user_mfa (id, user_id, factor_type, secret_encrypted, created_at, verified_at)
    VALUES (${factorId}, ${user.id}, 'totp', ${secret}, ${now}, NULL)
    ON CONFLICT (user_id, factor_type) DO UPDATE
      SET secret_encrypted = EXCLUDED.secret_encrypted,
          updated_at = EXCLUDED.created_at,
          verified_at = NULL
  `;

  const otpAuthUrl = authenticator.keyuri(user.email, "Elistly", secret);
  return jsonResponse(
    { factor_id: factorId, secret, qr_code: otpAuthUrl },
    200,
    origin
  );
}

async function handleMfaChallenge(req, env, ctx, origin) {
  // For TOTP, challenge is not strictly needed. Return dummy.
  const user = getAuthenticatedUser(req);
  if (!user) {
    return jsonResponse({ error: "Unauthorized" }, 401, origin);
  }
  const body = await readJsonBody(req);
  const factorId = body?.factorId;
  if (!factorId) {
    return jsonResponse({ error: "factorId required" }, 400, origin);
  }
  const rows = await sql`
    SELECT id FROM user_mfa WHERE id = ${factorId} AND user_id = ${user.id}
  `;
  if (rows.length === 0) {
    return jsonResponse({ error: "Factor not found" }, 404, origin);
  }
  // Dummy challenge
  return jsonResponse({
    challenge: {
      id: factorId,
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    },
  });
}

async function handleMfaVerify(req, env, ctx, origin) {
  const user = getAuthenticatedUser(req);
  if (!user) {
    return jsonResponse({ error: "Unauthorized" }, 401, origin);
  }
  const body = await readJsonBody(req);
  const factorId = body?.factor_id;
  const code = body?.code;
  if (!factorId || !code) {
    return jsonResponse({ error: "factor_id and code required" }, 400, origin);
  }

  const factorRows = await sql`
    SELECT secret_encrypted, verified_at FROM user_mfa
    WHERE id = ${factorId} AND user_id = ${user.id} AND factor_type = 'totp'
  `;
  if (factorRows.length === 0) {
    return jsonResponse({ error: "Factor not found" }, 404, origin);
  }

  const secret = factorRows[0].secret_encrypted;
  const isValid = authenticator.verify({ secret, token: code });
  if (!isValid) {
    return jsonResponse({ error: "Invalid verification code" }, 401, origin);
  }

  // Mark as verified if not already
  let verifiedAt = factorRows[0].verified_at;
  if (!verifiedAt) {
    await sql`UPDATE user_mfa SET verified_at = NOW() WHERE id = ${factorId}`;
    verifiedAt = new Date().toISOString();
  }

  // Issue new token with mfa_verified: true
  const payload = {
    sub: user.id,
    email: user.email,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL,
    mfa_verified: true,
  };
  const newToken = jwt.sign(payload, JWT_SECRET);
  const response = jsonResponse({ token: newToken }, 200, origin);
  setCookie(response, TOKEN_COOKIE_NAME, newToken);
  return response;
}

async function handleMfaUnenroll(req, env, ctx, origin) {
  const user = getAuthenticatedUser(req);
  if (!user) {
    return jsonResponse({ error: "Unauthorized" }, 401, origin);
  }
  const body = await readJsonBody(req);
  const factorId = body?.factor_id;
  if (!factorId) {
    return jsonResponse({ error: "factor_id required" }, 400, origin);
  }
  await sql`
    DELETE FROM user_mfa
    WHERE id = ${factorId} AND user_id = ${user.id}
  `;
  return jsonResponse({ ok: true }, 200, origin);
}

async function handleMfaStatus(req, env, ctx, origin) {
  const user = getAuthenticatedUser(req);
  if (!user) {
    return jsonResponse({ error: "Unauthorized" }, 401, origin);
  }
  // Check if user has any verified MFA factor
  const mfaRows = await sql`
    SELECT 1 FROM user_mfa
    WHERE user_id = ${user.id} AND factor_type = 'totp' AND verified_at IS NOT NULL
  `;
  const hasMfa = mfaRows.length > 0;
  const mfaVerified = user.mfa_verified === true;

  let currentLevel, nextLevel;
  if (!hasMfa) {
    currentLevel = "aal2";
    nextLevel = "aal2";
  } else {
    nextLevel = "aal2";
    currentLevel = mfaVerified ? "aal2" : "aal1";
  }
  return jsonResponse({ currentLevel, nextLevel }, 200, origin);
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERIC DB QUERY ENDPOINT
// ─────────────────────────────────────────────────────────────────────────────

async function handleDbQuery(req, env, ctx, origin) {
  const user = getAuthenticatedUser(req);
  if (!user) {
    return jsonResponse({ error: "Unauthorized" }, 401, origin);
  }
  // Enforce MFA if required for this user
  if (await checkMfaRequired(user)) {
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
    console.error("DB query error:", e.message, sqlText, params);
    return jsonResponse(
      { error: "Query failed", detail: e.message },
      500,
      origin
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FETCH
// ─────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get("Origin") || "*";
    try {
      const url = new URL(req.url);
      const path = url.pathname;

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
      }

      // Health & debug
      if (path === "/health" || path === "/") {
        return jsonResponse(
          { ok: true, service: "elistly-api", provider: "neon" },
          200,
          origin
        );
      }
      if (path === "/debug-env") {
        const keys = typeof env === "object" && env !== null ? Object.keys(env) : [];
        return jsonResponse(
          { envKeys: keys, provider: "neon", hasBackendUrl: !!env.NEON_DATABASE_URL },
          200,
          origin
        );
      }

      // ───── AUTH ROUTES ─────
      if (path === "/auth/signup" && req.method === "POST") {
        return handleSignup(req, env, ctx, origin);
      }
      if (path === "/auth/login" && req.method === "POST") {
        return handleLogin(req, env, ctx, origin);
      }
      if (path === "/auth/refresh" && req.method === "POST") {
        return handleRefresh(req, env, ctx, origin);
      }
      if (path === "/auth/logout" && req.method === "POST") {
        return handleLogout(req, env, ctx, origin);
      }
      if (path === "/auth/mfa/factors" && req.method === "GET") {
        return handleMfaFactors(req, env, ctx, origin);
      }
      if (path === "/auth/mfa/enroll" && req.method === "POST") {
        return handleMfaEnroll(req, env, ctx, origin);
      }
      if (path === "/auth/mfa/verify" && req.method === "POST") {
        return handleMfaVerify(req, env, ctx, origin);
      }
      if (path === "/auth/mfa/challenge" && req.method === "POST") {
        return handleMfaChallenge(req, env, ctx, origin);
      }
      if (path === "/auth/mfa/unenroll" && req.method === "POST") {
        return handleMfaUnenroll(req, env, ctx, origin);
      }
      if (path === "/auth/mfa/status" && req.method === "GET") {
        return handleMfaStatus(req, env, ctx, origin);
      }

      // ───── GENERIC DB QUERY ─────
      if (path === "/db/query" && req.method === "POST") {
        return handleDbQuery(req, env, ctx, origin);
      }

      // ───── APP ROUTES (require auth) ─────
      const user = getAuthenticatedUser(req);
      if (!user) {
        return jsonResponse({ error: "Unauthorized" }, 401, origin);
      }

      // For routes that access user data, enforce MFA if enrolled
      const mfaRequiredPaths = [
        "/app-data",
        "/profile",
        "/admin",
        "/users/me",
      ];
      const isMfaProtected = mfaRequiredPaths.some((p) => path.startsWith(p));
      if (isMfaProtected) {
        const mfaBlock = await checkMfaRequired(user);
        if (mfaBlock) {
          return jsonResponse({ error: "MFA verification required" }, 403, origin);
        }
      }

      // /me endpoint
      if (path === "/me" && req.method === "GET") {
        return jsonResponse({
          user: {
            id: user.id,
            email: user.email || null,
            user_metadata: user.user_metadata || {},
          },
        });
      }

      // /app-data GET
      if (path === "/app-data" && req.method === "GET") {
        const rows = await sql`SELECT payload, updated_at FROM app_data WHERE user_id = ${user.id}`;
        const row = rows[0] || null;
        return jsonResponse(
          {
            payload: row?.payload ?? null,
            updated_at: row?.updated_at ?? null,
          },
          200,
          origin
        );
      }

      // /app-data PUT
      if (path === "/app-data" && req.method === "PUT") {
        const body = await readJsonBody(req);
        if (!body || typeof body !== "object" || !("payload" in body)) {
          return jsonResponse({ error: "Invalid payload" }, 400, origin);
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
        return jsonResponse(
          {
            payload: row.payload ?? {},
            updated_at: row.updated_at ?? null,
          },
          200,
          origin
        );
      }

      // /profile GET
      if (path === "/profile" && req.method === "GET") {
        const rows = await sql`SELECT display_name, updated_at FROM profiles WHERE user_id = ${user.id}`;
        return jsonResponse({ profile: rows[0] || null }, 200, origin);
      }

      // /profile PUT
      if (path === "/profile" && req.method === "PUT") {
        const body = await readJsonBody(req);
        if (!body || typeof body !== "object") {
          return jsonResponse({ error: "Invalid profile body" }, 400, origin);
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

      // Secondary email not implemented
      if (
        (path === "/secondary-email/send" && req.method === "POST") ||
        (path === "/secondary-email/confirm" && req.method === "POST")
      ) {
        return jsonResponse({ error: "Not implemented with Neon Auth" }, 501, origin);
      }

      // /admin/me
      if (path === "/admin/me") {
        const rows = await sql`SELECT user_id FROM admin_users WHERE user_id = ${user.id}`;
        return jsonResponse({ admin: rows.length > 0 }, 200, origin);
      }

      // Delete own account
      if (path === "/users/me" && req.method === "DELETE") {
        await sql`DELETE FROM app_data WHERE user_id = ${user.id}`;
        await sql`DELETE FROM profiles WHERE user_id = ${user.id}`;
        await sql`DELETE FROM admin_users WHERE user_id = ${user.id}`;
        await sql`DELETE FROM user_preferences WHERE user_id = ${user.id}`;
        await sql`DELETE FROM user_auth WHERE id = ${user.id}`;
        await sql`DELETE FROM user_mfa WHERE user_id = ${user.id}`;
        return jsonResponse({ ok: true }, 200, origin);
      }

      // Admin: list users
      if (path === "/admin/users") {
        const adminCheck = await sql`SELECT user_id FROM admin_users WHERE user_id = ${user.id}`;
        if (adminCheck.length === 0) {
          return jsonResponse({ error: "Forbidden" }, 403, origin);
        }
        if (req.method === "GET") {
          let users = [];
          try {
            const authUsers = await sql`
              SELECT ua.id, ua.email, ua.created_at, up.user_name
              FROM user_auth ua
              LEFT JOIN user_preferences up ON ua.id = up.user_id
              WHERE ua.email_confirmed_at IS NOT NULL
              ORDER BY ua.created_at DESC
            `;
            users = authUsers.map((u) => ({
              id: u.id,
              email: u.email,
              created_at: u.created_at,
              user_name: u.user_name,
            }));
          } catch (e) {
            console.error("Admin users query failed:", e);
          }
          return jsonResponse({ users }, 200, origin);
        }
        return jsonResponse({ error: "Method not allowed" }, 405, origin);
      }

      // Admin: delete user
      const deleteUserMatch = path.match(/^\/admin\/users\/([a-zA-Z0-9-]+)$/);
      if (deleteUserMatch && req.method === "DELETE") {
        const targetId = deleteUserMatch[1];
        const adminCheck = await sql`SELECT user_id FROM admin_users WHERE user_id = ${user.id}`;
        if (adminCheck.length === 0) {
          return jsonResponse({ error: "Forbidden" }, 403, origin);
        }
        await sql`DELETE FROM app_data WHERE user_id = ${targetId}`;
        await sql`DELETE FROM profiles WHERE user_id = ${targetId}`;
        await sql`DELETE FROM admin_users WHERE user_id = ${targetId}`;
        await sql`DELETE FROM user_preferences WHERE user_id = ${targetId}`;
        await sql`DELETE FROM user_auth WHERE id = ${targetId}`;
        await sql`DELETE FROM user_mfa WHERE user_id = ${targetId}`;
        return jsonResponse({ ok: true }, 200, origin);
      }

      return jsonResponse({ error: "Not found" }, 404, origin);
    } catch (e) {
      console.error("Unhandled error:", e);
      return jsonResponse(
        { error: "Internal server error", detail: e && e.message ? e.message : String(e) },
        500,
        origin
      );
    }
  },
};