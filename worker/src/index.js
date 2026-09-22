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
import { importSvkBatch, InventoryError } from "./svk-inventory.js";
import { projectWindowsComputerFields } from "./computer-import.js";

const AUTH_COOKIE_NAME = "__Secure-neon-auth.session_token";
const MAX_JSON_BODY_BYTES = 5 * 1024 * 1024;
const jwksCache = { keys: null, expiresAt: 0 };


class RequestBodyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJsonBody(req) {
  const declaredLength = Number(req.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
    throw new RequestBodyError(413, "Request body too large");
  }

  const reader = req.body?.getReader();
  const chunks = [];
  let byteLength = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_JSON_BODY_BYTES) {
        await reader.cancel();
        throw new RequestBodyError(413, "Request body too large");
      }
      chunks.push(value);
    }
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new RequestBodyError(400, "Invalid JSON body");
  }
  if (!isJsonObject(body)) throw new RequestBodyError(400, "JSON object required");
  return body;
}

async function sha256Hex(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function randomBase64url(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const MAX_REGISTRATION_PAYLOAD_BYTES = 64 * 1024;
const registrationFields = new Set(["hardwareIdentity", "hostname", "serialNumber", "manufacturer", "model", "windowsEdition", "inventorySnapshot"]);
const snapshotFields = new Set(["schemaVersion", "collectedAt", "device", "windows", "cpu", "ramBytes", "graphicsAdapters", "fixedDisks", "networkAdapters", "biosVersion", "tpm", "secureBoot", "bitLockerProtectionStatus", "battery", "lastBootAt", "uptimeSeconds", "lastInteractiveUser", "availability"]);

function requireExactKeys(value, allowed, label) {
  if (!isJsonObject(value)) throw new RequestBodyError(400, `${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new RequestBodyError(400, `Unknown ${label} field: ${key}`);
}
function nullableString(value, label, max = 500) {
  if (value !== null && (typeof value !== "string" || value.length > max)) throw new RequestBodyError(400, `${label} must be null or a short string`);
}
function nullableInteger(value, label) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new RequestBodyError(400, `${label} must be null or a non-negative integer`);
}
function nullableBoolean(value, label) {
  if (value !== null && typeof value !== "boolean") throw new RequestBodyError(400, `${label} must be null or boolean`);
}
function nullableTimestamp(value, label) {
  if (value !== null && (typeof value !== "string" || !Number.isFinite(Date.parse(value)))) throw new RequestBodyError(400, `${label} must be null or an ISO timestamp`);
}

export function validateRegistrationFacts(body) {
  if (!isJsonObject(body)) throw new RequestBodyError(400, "JSON object required");
  requireExactKeys(body, registrationFields, "registration");
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > MAX_REGISTRATION_PAYLOAD_BYTES) throw new RequestBodyError(413, "Registration payload too large");
  if (typeof body.hardwareIdentity !== "string" || !/^[a-f0-9]{64}$/.test(body.hardwareIdentity)) throw new RequestBodyError(400, "hardwareIdentity must be a SHA-256 hex digest");
  if (typeof body.hostname !== "string" || !body.hostname.trim() || body.hostname.trim().length > 255) throw new RequestBodyError(400, "hostname is required");
  for (const field of ["serialNumber", "manufacturer", "model", "windowsEdition"]) nullableString(body[field], field);
  const snapshot = body.inventorySnapshot;
  requireExactKeys(snapshot, snapshotFields, "inventorySnapshot");
  if (snapshot.schemaVersion !== "elistly.windows-device-registration.v1") throw new RequestBodyError(400, "Unsupported inventory snapshot schema");
  nullableTimestamp(snapshot.collectedAt, "collectedAt");
  if (snapshot.collectedAt === null) throw new RequestBodyError(400, "collectedAt is required");
  requireExactKeys(snapshot.device, new Set(["manufacturer", "model", "serialNumber", "uuid"]), "device");
  requireExactKeys(snapshot.windows, new Set(["edition", "version", "build", "displayRelease", "installDate"]), "windows");
  requireExactKeys(snapshot.cpu, new Set(["model", "cores", "logicalProcessors"]), "cpu");
  for (const [label, value] of Object.entries({ ...snapshot.device, ...snapshot.windows, "cpu.model": snapshot.cpu.model, biosVersion: snapshot.biosVersion, bitLockerProtectionStatus: snapshot.bitLockerProtectionStatus })) nullableString(value, label);
  nullableTimestamp(snapshot.windows.installDate, "windows.installDate");
  nullableInteger(snapshot.cpu.cores, "cpu.cores"); nullableInteger(snapshot.cpu.logicalProcessors, "cpu.logicalProcessors"); nullableInteger(snapshot.ramBytes, "ramBytes");
  if (snapshot.graphicsAdapters !== undefined) {
    if (!Array.isArray(snapshot.graphicsAdapters) || snapshot.graphicsAdapters.length > 8) throw new RequestBodyError(400, "graphicsAdapters must contain at most 8 adapters");
    for (const adapter of snapshot.graphicsAdapters) nullableString(adapter, "graphicsAdapters item", 255);
  }
  if (!Array.isArray(snapshot.fixedDisks) || snapshot.fixedDisks.length > 32) throw new RequestBodyError(400, "fixedDisks must contain at most 32 disks");
  for (const disk of snapshot.fixedDisks) { requireExactKeys(disk, new Set(["capacityBytes", "freeBytes"]), "fixedDisks item"); nullableInteger(disk.capacityBytes, "fixedDisks.capacityBytes"); nullableInteger(disk.freeBytes, "fixedDisks.freeBytes"); }
  if (!Array.isArray(snapshot.networkAdapters) || snapshot.networkAdapters.length > 32) throw new RequestBodyError(400, "networkAdapters must contain at most 32 adapters");
  for (const adapter of snapshot.networkAdapters) {
    requireExactKeys(adapter, new Set(["name", "macAddress", "ipv4Addresses", "ipv6Addresses"]), "networkAdapters item");
    nullableString(adapter.name, "networkAdapters.name", 255); nullableString(adapter.macAddress, "networkAdapters.macAddress", 64);
    for (const [label, addresses] of [["networkAdapters.ipv4Addresses", adapter.ipv4Addresses], ["networkAdapters.ipv6Addresses", adapter.ipv6Addresses]]) {
      if (!Array.isArray(addresses) || addresses.length > 8) throw new RequestBodyError(400, `${label} must contain at most 8 addresses`);
      for (const address of addresses) nullableString(address, label, 64);
    }
  }
  requireExactKeys(snapshot.tpm, new Set(["present", "version", "ready"]), "tpm"); nullableBoolean(snapshot.tpm.present, "tpm.present"); nullableString(snapshot.tpm.version, "tpm.version"); nullableBoolean(snapshot.tpm.ready, "tpm.ready");
  nullableBoolean(snapshot.secureBoot, "secureBoot");
  requireExactKeys(snapshot.battery, new Set(["designCapacityMWh", "fullChargeCapacityMWh", "healthPercent"]), "battery");
  nullableInteger(snapshot.battery.designCapacityMWh, "battery.designCapacityMWh"); nullableInteger(snapshot.battery.fullChargeCapacityMWh, "battery.fullChargeCapacityMWh"); nullableInteger(snapshot.battery.healthPercent, "battery.healthPercent");
  nullableTimestamp(snapshot.lastBootAt, "lastBootAt"); nullableInteger(snapshot.uptimeSeconds, "uptimeSeconds");
  requireExactKeys(snapshot.lastInteractiveUser, new Set(["username", "time", "source", "observation"]), "lastInteractiveUser"); nullableString(snapshot.lastInteractiveUser.username, "lastInteractiveUser.username"); nullableTimestamp(snapshot.lastInteractiveUser.time, "lastInteractiveUser.time");
  nullableString(snapshot.lastInteractiveUser.source, "lastInteractiveUser.source", 200); nullableString(snapshot.lastInteractiveUser.observation, "lastInteractiveUser.observation", 200);
  const availabilityKeys = new Set(["tpm", "secureBoot", "bitLocker", "battery", "networkAdapters", "lastInteractiveUser"]);
  requireExactKeys(snapshot.availability, availabilityKeys, "availability");
  for (const key of availabilityKeys) nullableString(snapshot.availability[key], `availability.${key}`, 200);
  return body;
}

export function addRegisteredDevice(payload, workspaceId, facts) {
  const workspace = payload?.workspaces?.[workspaceId];
  if (!workspace || !isJsonObject(workspace.entities) || !isJsonObject(workspace.entityTypes?.computer)) throw new RequestBodyError(422, "The selected workspace needs a Computer entity type before registration");
  const existing = Object.values(workspace.entities).find(entity => isJsonObject(entity) && entity.type === "computer" && entity._elistlyRegistration?.hardwareIdentity === facts.hardwareIdentity);
  // Registration is creation-only: retries report the original device and never replace its snapshot.
  if (existing) return { payload, entity: existing, created: false };
  const normalizedSerial = typeof facts.serialNumber === "string" ? facts.serialNumber.trim().toLowerCase() : "";
  if (normalizedSerial && Object.values(workspace.entities).some(entity => isJsonObject(entity) && entity.type === "computer" && !entity._elistlyRegistration && typeof entity.serialNumber === "string" && entity.serialNumber.trim().toLowerCase() === normalizedSerial)) throw new RequestBodyError(409, "A manual Computer already has this serial number");
  const id = `device_${randomBase64url(12)}`;
  const entity = { id, type: "computer", name: facts.hostname.trim(), hostname: facts.hostname.trim(), _elistlyRegistration: { hardwareIdentity: facts.hardwareIdentity, registeredAt: new Date().toISOString(), inventorySnapshot: structuredClone(facts.inventorySnapshot) } };
  for (const field of ["serialNumber", "manufacturer", "model", "windowsEdition"]) if (typeof facts[field] === "string" && facts[field].trim()) entity[field] = facts[field].trim();
  projectWindowsComputerFields(entity, workspace.entityTypes.computer, facts);
  const nextPayload = structuredClone(payload);
  nextPayload.workspaces[workspaceId].entities[id] = entity;
  if (nextPayload.currentWorkspaceId === workspaceId) nextPayload.entities = { ...nextPayload.workspaces[workspaceId].entities };
  return { payload: nextPayload, entity, created: true };
}

function registeredDeviceInWorkspace(payload, workspaceId, deviceId) {
  const workspace = payload?.workspaces?.[workspaceId];
  const entity = workspace?.entities?.[deviceId];
  return isJsonObject(entity) && entity.type === "computer" && isJsonObject(entity._elistlyRegistration)
    ? { workspace, entity }
    : null;
}

function registeredDeviceById(payload, deviceId) {
  for (const [workspaceId] of Object.entries(payload?.workspaces || {})) {
    const found = registeredDeviceInWorkspace(payload, workspaceId, deviceId);
    if (found) return { workspaceId, ...found };
  }
  return null;
}

export function updateReportedDevice(payload, workspaceId, deviceId, facts) {
  const found = registeredDeviceInWorkspace(payload, workspaceId, deviceId);
  if (!found) throw new RequestBodyError(404, "Registered device not found");
  if (found.entity._elistlyRegistration.hardwareIdentity !== facts.hardwareIdentity) {
    throw new RequestBodyError(403, "Device identity does not match this reporting credential");
  }
  const previousCollectedAt = found.entity._elistlyRegistration.inventorySnapshot?.collectedAt;
  if (typeof previousCollectedAt === "string" && Date.parse(facts.inventorySnapshot.collectedAt) < Date.parse(previousCollectedAt)) {
    throw new RequestBodyError(409, "Report is older than the current device snapshot");
  }

  const nextPayload = structuredClone(payload);
  const registration = nextPayload.workspaces[workspaceId].entities[deviceId]._elistlyRegistration;
  const username = facts.inventorySnapshot.lastInteractiveUser.username;
  registration.inventorySnapshot = structuredClone(facts.inventorySnapshot);
  registration.lastReportedAt = new Date().toISOString();
  registration.lastObservedAt = facts.inventorySnapshot.collectedAt;
  if (typeof username === "string" && username.trim()) registration.lastObservedUsername = username.trim();
  // The deployed scheduled reporter refreshes only this established, safe subset.
  projectWindowsComputerFields(nextPayload.workspaces[workspaceId].entities[deviceId], found.workspace.entityTypes.computer, facts, {
    capabilities: new Set(['processor.summary', 'memory.total', 'graphics.adapters']),
  });
  if (nextPayload.currentWorkspaceId === workspaceId) nextPayload.entities = { ...nextPayload.workspaces[workspaceId].entities };
  return nextPayload;
}

function configuredCorsOrigin(env, requestOrigin) {
  const configuredOrigins = env.ELISTLY_ALLOWED_ORIGINS;
  if (typeof configuredOrigins !== "string" || !configuredOrigins.trim()) {
    throw new Error("ELISTLY_ALLOWED_ORIGINS must contain one or more origins");
  }

  const origins = configuredOrigins.split(",").map(value => value.trim());
  if (origins.some(value => !value)) {
    throw new Error("ELISTLY_ALLOWED_ORIGINS contains an empty origin");
  }

  for (const configuredOrigin of origins) {
    let parsed;
    try {
      parsed = new URL(configuredOrigin);
    } catch {
      throw new Error("ELISTLY_ALLOWED_ORIGINS contains an invalid origin");
    }
    if (!/^https?:$/.test(parsed.protocol) || parsed.origin !== configuredOrigin) {
      throw new Error("ELISTLY_ALLOWED_ORIGINS must contain exact HTTP origins");
    }
  }

  if (!requestOrigin) return null;
  return origins.includes(requestOrigin) ? requestOrigin : false;
}

function corsHeaders(origin) {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store, no-cache",
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
    headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    headers.Vary = "Origin";
  }
  return headers;
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

  let header;
  let payload;
  try {
    header = decodeJwtPart(parts[0]);
    payload = decodeJwtPart(parts[1]);
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  const issuer = typeof env.NEON_AUTH_JWT_ISSUER === "string" ? env.NEON_AUTH_JWT_ISSUER.trim() : "";
  const audience = typeof env.NEON_AUTH_JWT_AUDIENCE === "string" ? env.NEON_AUTH_JWT_AUDIENCE.trim() : "";
  const tokenAudiences = typeof payload.aud === "string" ? [payload.aud] : Array.isArray(payload.aud) ? payload.aud : [];
  // A trusted signature identifies its signer, not the application the token
  // was minted for. API authentication therefore binds every token to a
  // current expiry and this deployment's exact issuer and audience.
  if (header.alg !== "EdDSA" || !Number.isSafeInteger(payload.exp) || payload.exp <= now || !payload.sub
    || !issuer || payload.iss !== issuer || !audience || !tokenAudiences.includes(audience)) return null;

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

async function isAdmin(sql, user, env) {
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
  if (typeof body.email !== "string" || typeof body.password !== "string" || !body.email || !body.password) {
    return jsonResponse({ error: "Email and password required" }, 400, origin);
  }
  if (body.email.length > 320 || body.password.length > 1024 || (body.name != null && (typeof body.name !== "string" || body.name.length > 200))) {
    return jsonResponse({ error: "Authentication fields are too long" }, 400, origin);
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

export function createWorker({ createSql = neon, authenticate = getAuthenticatedUser, checkAdmin = isAdmin } = {}) {
  return {
  async fetch(req, env) {
    let origin;
    try {
      origin = configuredCorsOrigin(env, req.headers.get("Origin"));
    } catch {
      console.error("Invalid Worker configuration");
      return jsonResponse({ error: "Worker configuration error" }, 500);
    }

    if (origin === false) {
      return jsonResponse({ error: "Forbidden origin" }, 403);
    }

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/health" || path === "/") {
        return jsonResponse({ ok: true, service: "elistly-api", provider: "neon", auth: "neon-auth" }, 200, origin);
      }

      if (path === "/debug-env") return jsonResponse({ error: "Not found" }, 404, origin);

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

      // Reporting secrets are device-specific and can only refresh their own
      // registered inventory snapshot; they are never account session tokens.
      if (path === "/device-reporting/report") {
        if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, origin);
        const token = getBearerToken(req);
        if (!token || !/^dp_[A-Za-z0-9_-]{32,}$/.test(token)) return jsonResponse({ error: "Unauthorized" }, 401, origin);
        const facts = validateRegistrationFacts(await readJsonBody(req));
        const tokenHash = await sha256Hex(token);
        let sql = createSql(env.NEON_DATABASE_URL);
        const tokenRows = await sql`
          SELECT id, owner_user_id, workspace_id, device_id
          FROM device_reporting_tokens
          WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
          LIMIT 1
        `;
        const reportingToken = tokenRows[0];
        if (!reportingToken) return jsonResponse({ error: "Unauthorized" }, 401, origin);
        sql = createSql(env.NEON_DATABASE_URL);
        const currentRows = await sql`SELECT payload, updated_at::text AS updated_at FROM app_data WHERE user_id = ${reportingToken.owner_user_id}`;
        const current = normalizeAppDataRow(currentRows[0]);
        if (!current.payload || !current.updated_at) return jsonResponse({ error: "Account data is unavailable" }, 409, origin);
        const nextPayload = updateReportedDevice(current.payload, reportingToken.workspace_id, reportingToken.device_id, facts);
        // Recheck revocation in the write predicate so a concurrent revoke cannot
        // be followed by a stale credential mutating app_data.
        const updated = await sql`
          WITH active_token AS (
            SELECT id FROM device_reporting_tokens
            WHERE id = ${reportingToken.id} AND token_hash = ${tokenHash} AND revoked_at IS NULL
            FOR UPDATE
          )
          UPDATE app_data SET payload = ${JSON.stringify(nextPayload)}::jsonb, updated_at = NOW()
          WHERE user_id = ${reportingToken.owner_user_id}
            AND updated_at = ${current.updated_at}::timestamptz
            AND EXISTS (SELECT 1 FROM active_token)
          RETURNING updated_at::text AS updated_at
        `;
        if (!updated[0]) return jsonResponse({ error: "Report rejected because device data changed or the credential was revoked" }, 409, origin);
        await sql`UPDATE device_reporting_tokens SET last_used_at = NOW() WHERE id = ${reportingToken.id} AND revoked_at IS NULL`;
        return jsonResponse({ ok: true, deviceId: reportingToken.device_id, updatedAt: updated[0].updated_at }, 200, origin);
      }

      // This is intentionally the only route that accepts a device-registration
      // secret. It is checked before Neon Auth and never creates a user session.
      if (path === "/device-registration/register") {
        if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, origin);
        const token = getBearerToken(req);
        if (!token || !/^d[rc]_[A-Za-z0-9_-]{32,}$/.test(token)) return jsonResponse({ error: "Unauthorized" }, 401, origin);
        const facts = validateRegistrationFacts(await readJsonBody(req));
        const tokenHash = await sha256Hex(token);
        let sql = createSql(env.NEON_DATABASE_URL);
        const tokenRows = await sql`
          SELECT id, owner_user_id, workspace_id
          FROM device_registration_tokens
          WHERE token_hash = ${tokenHash}
            AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
          LIMIT 1
        `;
        const registrationToken = tokenRows[0];
        if (!registrationToken) return jsonResponse({ error: "Unauthorized" }, 401, origin);
        sql = createSql(env.NEON_DATABASE_URL);
        const currentRows = await sql`SELECT payload, updated_at::text AS updated_at FROM app_data WHERE user_id = ${registrationToken.owner_user_id}`;
        const current = normalizeAppDataRow(currentRows[0]);
        if (!current.payload || !current.updated_at) return jsonResponse({ error: "Account data is unavailable" }, 409, origin);
        const registration = addRegisteredDevice(current.payload, registrationToken.workspace_id, facts);
        // dc_ is explicitly issued for automatic enrollment. Existing dr_ secrets
        // retain their registration-only authority. The token lock, revision check,
        // registration and device credential issuance form one atomic statement.
        if (token.startsWith("dc_")) {
          const reportingToken = `dp_${randomBase64url(32)}`;
          const reportingTokenId = `dpt_${randomBase64url(12)}`;
          const enrolled = await sql`
            WITH active_token AS MATERIALIZED (
              SELECT id FROM device_registration_tokens
              WHERE id = ${registrationToken.id} AND token_hash = ${tokenHash}
                AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
              FOR UPDATE
            ), saved AS (
              UPDATE app_data SET payload = ${JSON.stringify(registration.payload)}::jsonb, updated_at = NOW()
              WHERE user_id = ${registrationToken.owner_user_id} AND updated_at = ${current.updated_at}::timestamptz
                AND EXISTS (SELECT 1 FROM active_token)
              RETURNING updated_at
            ), issued AS (
              INSERT INTO device_reporting_tokens (id, owner_user_id, workspace_id, device_id, token_hash)
              SELECT ${reportingTokenId}, ${registrationToken.owner_user_id}, ${registrationToken.workspace_id},
                     ${registration.entity.id}, ${await sha256Hex(reportingToken)} FROM saved
              RETURNING id
            ), used AS (
              UPDATE device_registration_tokens SET last_used_at = NOW()
              WHERE id IN (SELECT id FROM active_token) AND EXISTS (SELECT 1 FROM issued)
            )
            SELECT updated_at::text AS updated_at FROM saved
          `;
          if (!enrolled[0]) return jsonResponse({ error: "Collector authorization or account data changed. Retry with an active collector." }, 409, origin);
          return jsonResponse({ ok: true, created: registration.created, deviceId: registration.entity.id,
            updatedAt: enrolled[0].updated_at, reportingToken, reportingTokenId }, registration.created ? 201 : 200, origin);
        }
        if (!registration.created) {
          await sql`UPDATE device_registration_tokens SET last_used_at = NOW() WHERE id = ${registrationToken.id}`;
          return jsonResponse({ ok: true, created: false, deviceId: registration.entity.id }, 200, origin);
        }
        // Serialize one-time registration with owner revocation and recheck
        // expiry at the write boundary, just as automatic enrollment does.
        const updated = await sql`
          WITH active_token AS MATERIALIZED (
            SELECT id FROM device_registration_tokens
            WHERE id = ${registrationToken.id} AND token_hash = ${tokenHash}
              AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
            FOR UPDATE
          ), saved AS (
            UPDATE app_data SET payload = ${JSON.stringify(registration.payload)}::jsonb, updated_at = NOW()
            WHERE user_id = ${registrationToken.owner_user_id} AND updated_at = ${current.updated_at}::timestamptz
              AND EXISTS (SELECT 1 FROM active_token)
            RETURNING updated_at
          ), used AS (
            UPDATE device_registration_tokens SET last_used_at = NOW()
            WHERE id IN (SELECT id FROM active_token) AND EXISTS (SELECT 1 FROM saved)
          )
          SELECT updated_at::text AS updated_at FROM saved
        `;
        if (!updated[0]) return jsonResponse({ error: "App data changed since registration started; create a fresh script" }, 409, origin);
        return jsonResponse({ ok: true, created: true, deviceId: registration.entity.id, updatedAt: updated[0].updated_at }, 201, origin);
      }

      const user = await authenticate(req, env);
      if (!user) return jsonResponse({ error: "Unauthorized" }, 401, origin);
      const sql = createSql(env.NEON_DATABASE_URL);

      if (path === "/inventory-import" && req.method === "POST") {
        return jsonResponse(await importSvkBatch(sql, user.id, await readJsonBody(req)), 200, origin);
      }
      if (path === "/inventory-import/observations" && req.method === "GET") {
        const workspaceId = url.searchParams.get("workspaceId");
        const deviceId = url.searchParams.get("deviceId");
        const offset = Number(url.searchParams.get("offset") || 0);
        if (!workspaceId || !deviceId || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new InventoryError("Invalid history request", 400);
        const [account] = await sql`SELECT payload FROM app_data WHERE user_id = ${user.id}`;
        if (!Object.hasOwn(account?.payload?.workspaces || {}, workspaceId)) return jsonResponse({error:"Workspace not found"}, 404, origin);
        const rows = await sql`SELECT report_id, report, imported_at::text AS imported_at FROM inventory_import_reports
          WHERE owner_user_id = ${user.id} AND workspace_id = ${workspaceId} AND device_id = ${deviceId}
          ORDER BY collected_key DESC, report_id LIMIT 20 OFFSET ${offset}`;
        return jsonResponse({observations:rows}, 200, origin);
      }

      if (path === "/me" && req.method === "GET") {
        return jsonResponse({ user: { id: user.id, email: user.email, name: user.name } }, 200, origin);
      }

      if (path === "/device-registration/tokens") {
        if (req.method === "GET") {
          const rows = await sql`
            SELECT id, workspace_id, label, expires_at::text AS expires_at,
                   revoked_at::text AS revoked_at, created_at::text AS created_at, last_used_at::text AS last_used_at
            FROM device_registration_tokens WHERE owner_user_id = ${user.id}
            ORDER BY created_at DESC LIMIT 100
          `;
          return jsonResponse({ tokens: rows }, 200, origin);
        }
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          if (typeof body.workspaceId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(body.workspaceId)) {
            throw new RequestBodyError(400, "workspaceId is required");
          }
          if (body.label != null && (typeof body.label !== "string" || body.label.length > 100)) {
            throw new RequestBodyError(400, "label must be a short string");
          }
          const account = await sql`SELECT payload FROM app_data WHERE user_id = ${user.id}`;
          if (!account[0]?.payload?.workspaces?.[body.workspaceId]) {
            return jsonResponse({ error: "Workspace not found" }, 404, origin);
          }
          if (body.automaticReporting != null && typeof body.automaticReporting !== "boolean") {
            throw new RequestBodyError(400, "automaticReporting must be a boolean");
          }
          const token = `${body.automaticReporting === true ? 'dc' : 'dr'}_${randomBase64url(32)}`;
          const id = `drt_${randomBase64url(12)}`;
          let expiresAt = null;
          if (body.expiresAt != null) {
            if (typeof body.expiresAt !== 'string' || !/T.*(Z|[+-]\d{2}:\d{2})$/.test(body.expiresAt) || !Number.isFinite(Date.parse(body.expiresAt)) || Date.parse(body.expiresAt) <= Date.now()) {
              throw new RequestBodyError(400, "expiresAt must be a future timestamp with a timezone, or null");
            }
            expiresAt = new Date(body.expiresAt).toISOString();
          }
          await sql`
            INSERT INTO device_registration_tokens (id, owner_user_id, workspace_id, token_hash, label, expires_at)
            VALUES (${id}, ${user.id}, ${body.workspaceId}, ${await sha256Hex(token)}, ${body.label?.trim() || null}, ${expiresAt}::timestamptz)
          `;
          // The secret is deliberately only returned from this creation response.
          return jsonResponse({ token, tokenId: id, expiresAt }, 201, origin);
        }
        return jsonResponse({ error: "Method not allowed" }, 405, origin);
      }

      const revokeTokenMatch = path.match(/^\/device-registration\/tokens\/(drt_[A-Za-z0-9_-]+)$/);
      if (revokeTokenMatch && req.method === "DELETE") {
        const rows = await sql`
          UPDATE device_registration_tokens SET revoked_at = COALESCE(revoked_at, NOW())
          WHERE id = ${revokeTokenMatch[1]} AND owner_user_id = ${user.id}
          RETURNING id
        `;
        if (!rows[0]) return jsonResponse({ error: "Not found" }, 404, origin);
        return jsonResponse({ ok: true }, 200, origin);
      }

      if (path === "/device-reporting/tokens") {
        if (req.method === "GET") {
          const rows = await sql`
            SELECT id, workspace_id, device_id, revoked_at::text AS revoked_at,
                   created_at::text AS created_at, last_used_at::text AS last_used_at
            FROM device_reporting_tokens WHERE owner_user_id = ${user.id}
            ORDER BY created_at DESC LIMIT 100
          `;
          return jsonResponse({ tokens: rows }, 200, origin);
        }
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          if (!Object.hasOwn(body, "deviceId") || typeof body.deviceId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(body.deviceId) || Object.keys(body).length !== 1) {
            throw new RequestBodyError(400, "deviceId is required");
          }
          const account = await sql`SELECT payload FROM app_data WHERE user_id = ${user.id}`;
          const target = registeredDeviceById(account[0]?.payload, body.deviceId);
          if (!target) return jsonResponse({ error: "Registered device not found" }, 404, origin);
          const secret = `dp_${randomBase64url(32)}`;
          const id = `dpt_${randomBase64url(12)}`;
          await sql`
            INSERT INTO device_reporting_tokens (id, owner_user_id, workspace_id, device_id, token_hash)
            VALUES (${id}, ${user.id}, ${target.workspaceId}, ${body.deviceId}, ${await sha256Hex(secret)})
          `;
          return jsonResponse({ token: secret, tokenId: id, deviceId: body.deviceId }, 201, origin);
        }
        return jsonResponse({ error: "Method not allowed" }, 405, origin);
      }

      const revokeReportingTokenMatch = path.match(/^\/device-reporting\/tokens\/(dpt_[A-Za-z0-9_-]+)$/);
      if (revokeReportingTokenMatch && req.method === "DELETE") {
        const rows = await sql`
          UPDATE device_reporting_tokens SET revoked_at = COALESCE(revoked_at, NOW())
          WHERE id = ${revokeReportingTokenMatch[1]} AND owner_user_id = ${user.id}
          RETURNING id
        `;
        if (!rows[0]) return jsonResponse({ error: "Not found" }, 404, origin);
        return jsonResponse({ ok: true }, 200, origin);
      }

      if (path === "/app-data") {
        if (req.method === "GET") {
          const rows = await sql`SELECT payload, updated_at::text AS updated_at FROM app_data WHERE user_id = ${user.id}`;
          return jsonResponse(normalizeAppDataRow(rows[0]), 200, origin);
        }
        if (req.method === "PUT") {
          const body = await readJsonBody(req);
          if (!Object.hasOwn(body, "payload") || !isJsonObject(body.payload)) {
            throw new RequestBodyError(400, "Payload object required");
          }
          const payload = body.payload;
          if (!Object.hasOwn(body, "expectedUpdatedAt")) {
            throw new RequestBodyError(400, "App data revision required");
          }
          const expectedUpdatedAt = body.expectedUpdatedAt;
          if (expectedUpdatedAt !== null && (typeof expectedUpdatedAt !== "string" || Number.isNaN(Date.parse(expectedUpdatedAt)))) {
            throw new RequestBodyError(400, "expectedUpdatedAt must be a timestamp or null");
          }
          const rows = await sql`
            INSERT INTO app_data (user_id, payload, updated_at)
            VALUES (${user.id}, ${JSON.stringify(payload)}::jsonb, NOW())
            ON CONFLICT (user_id) DO UPDATE
              SET payload = EXCLUDED.payload,
                  updated_at = EXCLUDED.updated_at
              WHERE (${expectedUpdatedAt}::timestamptz IS NOT NULL AND app_data.updated_at = ${expectedUpdatedAt}::timestamptz)
            RETURNING payload, updated_at::text AS updated_at
          `;
          if (!rows[0]) return jsonResponse({ error: "App data changed since preview" }, 409, origin);
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
          if (!Object.hasOwn(body, "display_name") || (body.display_name !== null && typeof body.display_name !== "string")) {
            throw new RequestBodyError(400, "display_name must be a string or null");
          }
          if (typeof body.display_name === "string" && body.display_name.length > 200) {
            throw new RequestBodyError(400, "display_name is too long");
          }
          const rows = await sql`
            INSERT INTO profiles (user_id, email, display_name, updated_at)
            VALUES (${user.id}, ${user.email}, ${body.display_name?.trim() || user.name || null}, NOW())
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
        return jsonResponse({ admin: await checkAdmin(sql, user, env) }, 200, origin);
      }

      if (path === "/users/me" && req.method === "DELETE") {
        await sql`
          WITH deleted_registration_tokens AS (
            DELETE FROM device_registration_tokens WHERE owner_user_id = ${user.id}
          ), deleted_reporting_tokens AS (
            DELETE FROM device_reporting_tokens WHERE owner_user_id = ${user.id}
          ), deleted_app_data AS (
            DELETE FROM app_data WHERE user_id = ${user.id}
          ), deleted_profiles AS (
            DELETE FROM profiles WHERE user_id = ${user.id}
          ), deleted_admin AS (
            DELETE FROM admin_users WHERE user_id = ${user.id}
          )
          DELETE FROM neon_auth."user" WHERE id::text = ${user.id}
        `;
        return jsonResponse({ ok: true }, 200, origin);
      }

      if (path === "/admin/users") {
        if (!await checkAdmin(sql, user, env)) return jsonResponse({ error: "Forbidden" }, 403, origin);
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
        if (!await checkAdmin(sql, user, env)) return jsonResponse({ error: "Forbidden" }, 403, origin);
        const targetId = deleteUserMatch[1];
        await sql`
          WITH deleted_registration_tokens AS (
            DELETE FROM device_registration_tokens WHERE owner_user_id = ${targetId}
          ), deleted_reporting_tokens AS (
            DELETE FROM device_reporting_tokens WHERE owner_user_id = ${targetId}
          ), deleted_app_data AS (
            DELETE FROM app_data WHERE user_id = ${targetId}
          ), deleted_profiles AS (
            DELETE FROM profiles WHERE user_id = ${targetId}
          ), deleted_admin AS (
            DELETE FROM admin_users WHERE user_id = ${targetId}
          )
          DELETE FROM neon_auth."user" WHERE id::text = ${targetId}
        `;
        return jsonResponse({ ok: true }, 200, origin);
      }

      return jsonResponse({ error: "Not found" }, 404, origin);
    } catch (error) {
      if (error instanceof RequestBodyError || error instanceof InventoryError) {
        return jsonResponse({ error: error.message }, error.status, origin);
      }
      console.error("Unhandled Worker error");
      return jsonResponse({ error: "Internal server error" }, 500, origin);
    }
  },
  };
}

export default createWorker();
