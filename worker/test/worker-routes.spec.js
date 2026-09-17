import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createWorker } from "../src/index.js";

const env = {
  ELISTLY_ALLOWED_ORIGINS: "https://app.example.test",
  NEON_DATABASE_URL: "test-database-url",
};
const user = { id: "user-1", email: "member@example.test", name: "Member" };

function mockSql(calls = []) {
  return async (strings, ...values) => {
    const query = strings.join(" ");
    calls.push({ query, values });
    if (query.includes("FROM app_data")) return [{ payload: { lists: ["mine"] }, updated_at: "2026-01-01" }];
    if (query.includes("FROM profiles")) return [{ display_name: "Member", updated_at: "2026-01-01" }];
    if (query.includes("FROM neon_auth")) return [{ id: "user-2", email: "other@example.test", name: "Other", created_at: "2026-01-01" }];
    return [];
  };
}

async function fetchFrom(worker, path, { method = "GET", body, rawBody } = {}) {
  const context = createExecutionContext();
  const requestBody = rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined;
  const response = await worker.fetch(
    new Request(`https://api.example.test${path}`, {
      method,
      body: requestBody,
      headers: requestBody !== undefined ? { "Content-Type": "application/json" } : undefined,
    }),
    env,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

describe("Elistly Worker route seams", () => {
  it("returns app-data revisions as lossless database text", async () => {
    const calls = [];
    const worker = createWorker({
      createSql: () => mockSql(calls),
      authenticate: async () => user,
      checkAdmin: async () => false,
    });

    const appData = await fetchFrom(worker, "/app-data");
    const profile = await fetchFrom(worker, "/profile");

    expect(await appData.json()).toEqual({ payload: { lists: ["mine"] }, updated_at: "2026-01-01" });
    expect(await profile.json()).toEqual({ profile: { display_name: "Member", updated_at: "2026-01-01" } });
    expect(calls[0].query).toContain("updated_at::text AS updated_at");
  });

  it("creates the database client with the configured URL without request-context options", async () => {
    const urls = [];
    const worker = createWorker({
      createSql: url => { urls.push(url); return mockSql(); },
      authenticate: async () => user,
      checkAdmin: async () => false,
    });

    const response = await fetchFrom(worker, "/app-data");

    expect(response.status).toBe(200);
    expect(urls).toEqual([env.NEON_DATABASE_URL]);
  });

  it("rejects unauthenticated application data requests through the injected auth boundary", async () => {
    const worker = createWorker({
      createSql: () => mockSql(),
      authenticate: async () => null,
      checkAdmin: async () => false,
    });

    const response = await fetchFrom(worker, "/app-data");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("rejects malformed bearer tokens as unauthenticated", async () => {
    const worker = createWorker({ createSql: () => mockSql(), checkAdmin: async () => false });
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://api.example.test/app-data", { headers: { Authorization: "Bearer malformed.token.value" } }),
      env,
      context,
    );
    await waitOnExecutionContext(context);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("allows admin listing but forbids non-admin listing", async () => {
    const sql = mockSql();
    const adminWorker = createWorker({ createSql: () => sql, authenticate: async () => user, checkAdmin: async () => true });
    const memberWorker = createWorker({ createSql: () => sql, authenticate: async () => user, checkAdmin: async () => false });

    const allowed = await fetchFrom(adminWorker, "/admin/users");
    const forbidden = await fetchFrom(memberWorker, "/admin/users");

    expect(await allowed.json()).toEqual({ users: [{ id: "user-2", email: "other@example.test", name: "Other", created_at: "2026-01-01" }] });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "Forbidden" });
  });

  it("returns method and not-found responses after authentication", async () => {
    const worker = createWorker({ createSql: () => mockSql(), authenticate: async () => user, checkAdmin: async () => true });

    const method = await fetchFrom(worker, "/admin/users", { method: "POST" });
    const missing = await fetchFrom(worker, "/does-not-exist");

    expect(method.status).toBe(405);
    expect(await method.json()).toEqual({ error: "Method not allowed" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Not found" });
  });

  it("does not return internal exception details", async () => {
    const worker = createWorker({
      createSql: () => { throw new Error("database password leaked"); },
      authenticate: async () => user,
      checkAdmin: async () => false,
    });

    const response = await fetchFrom(worker, "/app-data");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error" });
  });

  it("rejects malformed or structurally invalid app-data writes before SQL mutation", async () => {
    const calls = [];
    const worker = createWorker({
      createSql: () => mockSql(calls),
      authenticate: async () => user,
      checkAdmin: async () => false,
    });

    const malformed = await fetchFrom(worker, "/app-data", { method: "PUT", rawBody: "{" });
    const missingPayload = await fetchFrom(worker, "/app-data", { method: "PUT", body: { unexpected: {} } });
    const arrayPayload = await fetchFrom(worker, "/app-data", { method: "PUT", body: { payload: [] } });

    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "Invalid JSON body" });
    expect(missingPayload.status).toBe(400);
    expect(await missingPayload.json()).toEqual({ error: "Payload object required" });
    expect(arrayPayload.status).toBe(400);
    expect(await arrayPayload.json()).toEqual({ error: "Payload object required" });
    expect(calls).toEqual([]);
  });

  it("rejects oversized JSON before SQL mutation", async () => {
    const calls = [];
    const worker = createWorker({
      createSql: () => mockSql(calls),
      authenticate: async () => user,
      checkAdmin: async () => false,
    });
    const response = await fetchFrom(worker, "/app-data", {
      method: "PUT",
      rawBody: JSON.stringify({ payload: { value: "x".repeat(5 * 1024 * 1024) } }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Request body too large" });
    expect(calls).toEqual([]);
  });

  it("requires a revision precondition for every app-data write", async () => {
    const calls = [];
    const worker = createWorker({
      createSql: () => mockSql(calls),
      authenticate: async () => user,
      checkAdmin: async () => false,
    });

    const response = await fetchFrom(worker, "/app-data", {
      method: "PUT",
      body: { payload: { entities: {} } },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "App data revision required" });
    expect(calls).toEqual([]);
  });

  it("accepts a matching revision and returns the advanced revision", async () => {
    const calls = [];
    const sql = async (strings, ...values) => {
      calls.push({ query: strings.join(" "), values });
      return [{ payload: { entities: { updated: true } }, updated_at: "2026-08-12T00:01:00.000Z" }];
    };
    const worker = createWorker({ createSql: () => sql, authenticate: async () => user, checkAdmin: async () => false });

    const response = await fetchFrom(worker, "/app-data", {
      method: "PUT",
      body: { payload: { entities: { updated: true } }, expectedUpdatedAt: "2026-08-12T00:00:00.000Z" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ payload: { entities: { updated: true } }, updated_at: "2026-08-12T00:01:00.000Z" });
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("app_data.updated_at =");
    expect(calls[0].query).toContain("updated_at::text AS updated_at");
    expect(calls[0].values).toContain("2026-08-12T00:00:00.000Z");
  });

  it("rejects a stale revision without returning a replacement row", async () => {
    const calls = [];
    const sql = async (strings, ...values) => {
      calls.push({ query: strings.join(" "), values });
      return [];
    };
    const worker = createWorker({ createSql: () => sql, authenticate: async () => user, checkAdmin: async () => false });

    const response = await fetchFrom(worker, "/app-data", {
      method: "PUT",
      body: { payload: { entities: { stale: true } }, expectedUpdatedAt: "2026-08-12T00:00:00.000Z" },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "App data changed since preview" });
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("app_data.updated_at =");
  });

  it("validates profile writes before SQL mutation", async () => {
    const calls = [];
    const worker = createWorker({
      createSql: () => mockSql(calls),
      authenticate: async () => user,
      checkAdmin: async () => false,
    });
    const response = await fetchFrom(worker, "/profile", { method: "PUT", body: { display_name: {} } });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "display_name must be a string or null" });
    expect(calls).toEqual([]);
  });

  it("performs account deletion as one atomic SQL statement", async () => {
    const calls = [];
    const worker = createWorker({
      createSql: () => mockSql(calls),
      authenticate: async () => user,
      checkAdmin: async () => false,
    });
    const response = await fetchFrom(worker, "/users/me", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("DELETE FROM device_registration_tokens");
    expect(calls[0].query).toContain("DELETE FROM device_reporting_tokens");
    expect(calls[0].query).toContain("DELETE FROM app_data");
    expect(calls[0].query).toContain("DELETE FROM profiles");
    expect(calls[0].query).toContain("DELETE FROM admin_users");
    expect(calls[0].query).toContain('DELETE FROM neon_auth."user"');
    expect(calls[0].values).toEqual([user.id, user.id, user.id, user.id, user.id, user.id]);
  });

  it("forbids non-admin account deletion before SQL mutation", async () => {
    const calls = [];
    const worker = createWorker({
      createSql: () => mockSql(calls),
      authenticate: async () => user,
      checkAdmin: async () => false,
    });
    const response = await fetchFrom(worker, "/admin/users/user-2", { method: "DELETE" });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(calls).toEqual([]);
  });
});

function encodeJwtPart(value) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signedJwt({ privateKey, kid, payload }) {
  const header = encodeJwtPart({ alg: "EdDSA", kid, typ: "JWT" });
  const body = encodeJwtPart(payload);
  const signature = await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(`${header}.${body}`));
  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${header}.${body}.${encodedSignature}`;
}

describe("JWT claim boundary", () => {
  it("rejects trusted-key JWTs without expiry or with wrong issuer, audience, or expiry", async () => {
    const kid = `claims-${crypto.randomUUID()}`;
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async url => String(url) === "https://jwks.example.test/current"
      ? new Response(JSON.stringify({ keys: [{ ...jwk, kid }] })) : originalFetch(url);
    try {
      const worker = createWorker({ createSql: () => mockSql(), checkAdmin: async () => false });
      const now = Math.floor(Date.now() / 1000);
      const rejectedPayloads = [
        { sub: "user-1", iss: "https://auth.example.test", aud: "elistly-api" },
        { sub: "user-1", exp: now + 60, iss: "https://wrong-issuer.example.test", aud: "elistly-api" },
        { sub: "user-1", exp: now + 60, iss: "https://auth.example.test", aud: "wrong-audience" },
        { sub: "user-1", exp: now - 1, iss: "https://auth.example.test", aud: "elistly-api" },
      ];
      for (const payload of rejectedPayloads) {
        const token = await signedJwt({ privateKey: pair.privateKey, kid, payload });
        const context = createExecutionContext();
        const response = await worker.fetch(new Request("https://api.example.test/app-data", { headers: { Authorization: `Bearer ${token}` } }), {
          ...env,
          NEON_AUTH_URL: "https://auth.example.test",
          NEON_AUTH_JWKS_URL: "https://jwks.example.test/current",
          NEON_AUTH_JWT_ISSUER: "https://auth.example.test",
          NEON_AUTH_JWT_AUDIENCE: "elistly-api",
        }, context);
        await waitOnExecutionContext(context);
        expect(response.status).toBe(401);
      }

      const validToken = await signedJwt({ privateKey: pair.privateKey, kid, payload: {
        sub: "user-1", exp: now + 60, iss: "https://auth.example.test", aud: ["other-service", "elistly-api"],
      } });
      const context = createExecutionContext();
      const accepted = await worker.fetch(new Request("https://api.example.test/app-data", { headers: { Authorization: `Bearer ${validToken}` } }), {
        ...env,
        NEON_AUTH_URL: "https://auth.example.test",
        NEON_AUTH_JWKS_URL: "https://jwks.example.test/current",
        NEON_AUTH_JWT_ISSUER: "https://auth.example.test",
        NEON_AUTH_JWT_AUDIENCE: "elistly-api",
      }, context);
      await waitOnExecutionContext(context);
      expect(accepted.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
