import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createWorker } from "../src/index.js";

const env = {
  ELISTLY_ALLOWED_ORIGINS: "https://app.example.test",
  NEON_DATABASE_URL: "test-database-url",
};
const user = { id: "user-1", email: "member@example.test", name: "Member" };

function mockSql() {
  return async (strings) => {
    const query = strings.join(" ");
    if (query.includes("FROM app_data")) return [{ payload: { lists: ["mine"] }, updated_at: "2026-01-01" }];
    if (query.includes("FROM profiles")) return [{ display_name: "Member", updated_at: "2026-01-01" }];
    if (query.includes("FROM neon_auth")) return [{ id: "user-2", email: "other@example.test", name: "Other", created_at: "2026-01-01" }];
    return [];
  };
}

async function fetchFrom(worker, path, { method = "GET", body } = {}) {
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://api.example.test${path}`, {
      method,
      body: body && JSON.stringify(body),
      headers: body ? { "Content-Type": "application/json" } : undefined,
    }),
    env,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

describe("Elistly Worker route seams", () => {
  it("serves representative app data and profile reads through injected dependencies", async () => {
    const worker = createWorker({
      createSql: mockSql,
      authenticate: async () => user,
      checkAdmin: async () => false,
    });

    const appData = await fetchFrom(worker, "/app-data");
    const profile = await fetchFrom(worker, "/profile");

    expect(await appData.json()).toEqual({ payload: { lists: ["mine"] }, updated_at: "2026-01-01" });
    expect(await profile.json()).toEqual({ profile: { display_name: "Member", updated_at: "2026-01-01" } });
  });

  it("rejects unauthenticated application data requests through the injected auth boundary", async () => {
    const worker = createWorker({
      createSql: mockSql,
      authenticate: async () => null,
      checkAdmin: async () => false,
    });

    const response = await fetchFrom(worker, "/app-data");

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
    const worker = createWorker({ createSql: mockSql, authenticate: async () => user, checkAdmin: async () => true });

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
});
