import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addRegisteredDevice, createWorker, validateRegistrationFacts } from "../src/index.js";

const identity = "a".repeat(64);
const facts = { hardwareIdentity: identity, hostname: "PC-01", serialNumber: "SERIAL-1" };
const registrationAuthorization = token => ({ Authorization: ["Bear", "er"].join("") + ` ${token}` });

function payload(owner = "default") {
  return {
    currentWorkspaceId: owner,
    workspaces: {
      [owner]: { name: owner, categories: {}, entityTypes: { computer: { id: "computer", name: "Computer" } }, entities: {} },
      other: { name: "other", categories: {}, entityTypes: { computer: { id: "computer", name: "Computer" } }, entities: {} },
    },
    entities: {},
  };
}

async function fetchRegistration(worker, path, options = {}) {
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(`https://api.example.test${path}`, options), {
    ELISTLY_ALLOWED_ORIGINS: "https://app.example.test",
    NEON_DATABASE_URL: "unused-by-sql-seam",
  }, context);
  await waitOnExecutionContext(context);
  return response;
}

describe("device registration boundary", () => {
  it("creates one explicitly marked Computer and repeated registration is idempotent", () => {
    const initial = payload();
    const first = addRegisteredDevice(initial, "default", facts);
    const second = addRegisteredDevice(first.payload, "default", facts);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(Object.keys(second.payload.workspaces.default.entities)).toHaveLength(1);
    expect(second.entity._elistlyRegistration.hardwareIdentity).toBe(identity);
    expect(second.entity.name).toBe("PC-01");
    expect(second.entity.assignedTo).toBeUndefined();
    expect(initial.workspaces.default.entities).toEqual({});
  });

  it("keeps an identical identity isolated to its selected workspace", () => {
    const first = addRegisteredDevice(payload(), "default", facts);
    const second = addRegisteredDevice(first.payload, "other", facts);
    expect(second.created).toBe(true);
    expect(Object.keys(second.payload.workspaces.default.entities)).toHaveLength(1);
    expect(Object.keys(second.payload.workspaces.other.entities)).toHaveLength(1);
  });

  it("rejects a serial collision with a manual Computer instead of duplicating it", () => {
    const state = payload();
    state.workspaces.default.entities.manual = { id: "manual", type: "computer", name: "PC-01", serialNumber: "SERIAL-1" };
    expect(() => addRegisteredDevice(state, "default", facts)).toThrow("manual Computer already has this serial number");
  });

  it("requires a hashed stable identity and an existing Computer type", () => {
    expect(() => validateRegistrationFacts({ ...facts, hardwareIdentity: "serial-number" })).toThrow("SHA-256");
    const state = payload(); delete state.workspaces.default.entityTypes.computer;
    expect(() => addRegisteredDevice(state, "default", facts)).toThrow("Computer entity type");
  });

  it("serves the registration HTTP path through the SQL seam and preserves a 409 manual collision", async () => {
    const initial = payload();
    const calls = [];
    const sql = async (strings, ...values) => {
      const query = strings.join(" ");
      calls.push({ query, values });
      if (query.includes("FROM device_registration_tokens")) return [{ id: "drt_1", owner_user_id: "owner", workspace_id: "default" }];
      if (query.includes("SELECT payload")) return [{ payload: initial, updated_at: "2026-01-01T00:00:00.000Z" }];
      if (query.includes("UPDATE app_data")) return [{ updated_at: "2026-01-01T00:01:00.000Z" }];
      return [];
    };
    const worker = createWorker({ createSql: () => sql, authenticate: async () => null });
    const token = `dr_${"A".repeat(43)}`;
    const headers = { ...registrationAuthorization(token), "Content-Type": "application/json" };
    const response = await fetchRegistration(worker, "/device-registration/register", { method: "POST", headers, body: JSON.stringify(facts) });
    expect(response.status).toBe(201);
    expect((await response.json()).created).toBe(true);
    expect(calls.some(call => call.query.includes("UPDATE app_data"))).toBe(true);

    initial.workspaces.default.entities.manual = { id: "manual", type: "computer", serialNumber: facts.serialNumber };
    const collision = await fetchRegistration(worker, "/device-registration/register", { method: "POST", headers, body: JSON.stringify(facts) });
    expect(collision.status).toBe(409);
    expect(await collision.json()).toEqual({ error: "A manual Computer already has this serial number" });
  });

  it("does not treat a registration token as an account session token", async () => {
    const worker = createWorker({ authenticate: async () => null });
    const token = `dr_${"A".repeat(43)}`;
    const response = await fetchRegistration(worker, "/app-data", { headers: registrationAuthorization(token) });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });
});
