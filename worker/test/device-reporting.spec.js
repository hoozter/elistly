import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createWorker } from "../src/index.js";

const token = `dp_${"A".repeat(43)}`;
const identity = "a".repeat(64);
const snapshot = {
  schemaVersion: "elistly.windows-device-registration.v1", collectedAt: "2026-02-01T00:00:00.000Z",
  device: { manufacturer: "Acme", model: "Model 1", serialNumber: "SERIAL-1", uuid: "uuid-1" },
  windows: { edition: "Windows 11 Pro", version: "10.0", build: "1", displayRelease: "24H2", installDate: null },
  cpu: { model: "CPU", cores: 8, logicalProcessors: 16 }, ramBytes: 1, fixedDisks: [], networkAdapters: [], biosVersion: null,
  tpm: { present: true, version: "2.0", ready: true }, secureBoot: true, bitLockerProtectionStatus: null,
  battery: { designCapacityMWh: null, fullChargeCapacityMWh: null, healthPercent: null }, lastBootAt: null, uptimeSeconds: 1,
  lastInteractiveUser: { username: null, time: null, source: "source", observation: "none" },
  availability: { tpm: null, secureBoot: null, bitLocker: null, battery: null, networkAdapters: null, lastInteractiveUser: null },
};
const facts = { hardwareIdentity: identity, hostname: "PC-01", serialNumber: "SERIAL-1", manufacturer: "Acme", model: "Model 1", windowsEdition: "Windows 11 Pro", inventorySnapshot: snapshot };
const env = { ELISTLY_ALLOWED_ORIGINS: "https://app.example.test", NEON_DATABASE_URL: "unused" };

function account({ hardwareIdentity = identity, snapshot: priorSnapshot = { ...snapshot, collectedAt: "2026-01-01T00:00:00.000Z", lastInteractiveUser: { ...snapshot.lastInteractiveUser, username: "prior-user" } }, workspace = "main" } = {}) {
  return { currentWorkspaceId: workspace, workspaces: { [workspace]: { entityTypes: { computer: { fields: [{ name: "processor", type: "text", collection: { provider: "windows", capability: "processor.summary" } }, { name: "ram", type: "text", collection: { provider: "windows", capability: "memory.total" } }] } }, entities: { "device-1": { id: "device-1", type: "computer", name: "Manual name", assignedTo: "Alice", _elistlyRegistration: { hardwareIdentity, inventorySnapshot: priorSnapshot, lastObservedUsername: "prior-user" } } } }, other: { entityTypes: { computer: {} }, entities: {} } }, entities: {} };
}

async function request(worker, path, { method = "POST", body, authorization } = {}) {
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(`https://api.example.test${path}`, { method, headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}) }, body: body && JSON.stringify(body) }), env, context);
  await waitOnExecutionContext(context);
  return response;
}

function reportingSql({ state = account(), tokenRow = { id: "dpt_1", owner_user_id: "owner", workspace_id: "main", device_id: "device-1" }, writeResult = [{ updated_at: "2026-02-01T00:01:00.000Z" }] } = {}) {
  const calls = [];
  const sql = async (strings, ...values) => {
    const query = strings.join(" "); calls.push({ query, values });
    if (query.includes("WITH active_token")) return writeResult;
    if (query.includes("FROM device_reporting_tokens")) return tokenRow ? [tokenRow] : [];
    if (query.includes("SELECT payload")) return [{ payload: state, updated_at: "2026-02-01T00:00:00.000Z" }];
    return [];
  };
  return { sql, calls };
}

describe("per-device reporting", () => {
  it("reports only into its bound registration snapshot and retains the last observed username", async () => {
    const { sql, calls } = reportingSql();
    const worker = createWorker({ createSql: () => sql, authenticate: async () => null });
    const response = await request(worker, "/device-reporting/report", { body: facts, authorization: token });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, deviceId: "device-1", updatedAt: "2026-02-01T00:01:00.000Z" });
    const write = calls.find(call => call.query.includes("WITH active_token"));
    const saved = JSON.parse(write.values.find(value => typeof value === "string" && value.startsWith("{")));
    const device = saved.workspaces.main.entities["device-1"];
    expect(device.name).toBe("Manual name");
    expect(device.assignedTo).toBe("Alice");
    expect(device.processor).toBe("CPU");
    expect(device.ram).toBe("1 B");
    expect(device._elistlyRegistration.inventorySnapshot).toEqual(snapshot);
    expect(device._elistlyRegistration.lastObservedUsername).toBe("prior-user");
    expect(write.query).toContain("revoked_at IS NULL");
    expect(write.query).toContain("FOR UPDATE");
    expect(write.query).toContain("AND updated_at =");
  });

  it("refreshes a configured graphics field from a multi-GPU report", async () => {
    const state = account();
    state.workspaces.main.entityTypes.computer.fields.push({ name: "graphicsCard", type: "textarea", collection: { provider: "windows", capability: "graphics.adapters" } });
    const reportedFacts = { ...facts, inventorySnapshot: { ...snapshot, graphicsAdapters: ["Integrated GPU", "Discrete GPU"] } };
    const { sql, calls } = reportingSql({ state });
    const worker = createWorker({ createSql: () => sql, authenticate: async () => null });

    const response = await request(worker, "/device-reporting/report", { body: reportedFacts, authorization: token });

    expect(response.status).toBe(200);
    const write = calls.find(call => call.query.includes("WITH active_token"));
    const saved = JSON.parse(write.values.find(value => typeof value === "string" && value.startsWith("{")));
    const device = saved.workspaces.main.entities["device-1"];
    expect(device.graphicsCard).toBe("Integrated GPU; Discrete GPU");
    expect(device._elistlyRegistration.inventorySnapshot.graphicsAdapters).toEqual(["Integrated GPU", "Discrete GPU"]);
    expect(device.assignedTo).toBe("Alice");
  });

  it("retains authored Computer values while persisting a fresh report snapshot", async () => {
    const state = account();
    const workspace = state.workspaces.main;
    workspace.entityTypes.computer.fields.push({ name: "graphicsCard", type: "textarea", collection: { provider: "windows", capability: "graphics.adapters" } });
    Object.assign(workspace.entities["device-1"], { processor: "Authored CPU", ram: "Authored RAM", graphicsCard: "Authored graphics" });
    const reportedFacts = { ...facts, inventorySnapshot: { ...snapshot, graphicsAdapters: ["Reported GPU"] } };
    const { sql, calls } = reportingSql({ state });
    const worker = createWorker({ createSql: () => sql, authenticate: async () => null });

    expect((await request(worker, "/device-reporting/report", { body: reportedFacts, authorization: token })).status).toBe(200);

    const write = calls.find(call => call.query.includes("WITH active_token"));
    const saved = JSON.parse(write.values.find(value => typeof value === "string" && value.startsWith("{")));
    const device = saved.workspaces.main.entities["device-1"];
    expect(device).toMatchObject({ processor: "Authored CPU", ram: "Authored RAM", graphicsCard: "Authored graphics", name: "Manual name", assignedTo: "Alice" });
    expect(device._elistlyRegistration.inventorySnapshot).toEqual(reportedFacts.inventorySnapshot);
    expect(saved.workspaces.main.entityTypes).toEqual(workspace.entityTypes);
    expect(Object.keys(saved.workspaces.main.entities)).toEqual(["device-1"]);
    expect(saved.entities["device-1"]).toEqual(device);
    expect(saved.workspaces.other).toEqual(state.workspaces.other);
  });

  it("rejects stale reports, wrong identities, deleted or moved targets, revoked tokens, and CAS conflicts", async () => {
    const cases = [
      { name: "stale", facts: { ...facts, inventorySnapshot: { ...snapshot, collectedAt: "2025-01-01T00:00:00.000Z" } }, options: {}, status: 409 },
      { name: "identity", facts: { ...facts, hardwareIdentity: "b".repeat(64) }, options: {}, status: 403 },
      { name: "deleted", facts, options: { state: { ...account(), workspaces: { main: { entityTypes: { computer: {} }, entities: {} } } } }, status: 404 },
      { name: "moved", facts, options: { state: account({ workspace: "other" }) }, status: 404 },
      { name: "revoked", facts, options: { tokenRow: null }, status: 401 },
      { name: "conflict", facts, options: { writeResult: [] }, status: 409 },
    ];
    for (const scenario of cases) {
      const { sql } = reportingSql(scenario.options);
      const worker = createWorker({ createSql: () => sql, authenticate: async () => null });
      const response = await request(worker, "/device-reporting/report", { body: scenario.facts, authorization: token });
      expect(response.status, scenario.name).toBe(scenario.status);
    }
  });

  it("keeps reporting credentials out of account authentication and creates, lists, and revokes bound credentials", async () => {
    const state = account(); const calls = [];
    const sql = async (strings, ...values) => {
      const query = strings.join(" "); calls.push({ query, values });
      if (query.includes("SELECT payload")) return [{ payload: state }];
      if (query.includes("SELECT id, workspace_id, device_id")) return [{ id: "dpt_1", workspace_id: "main", device_id: "device-1", revoked_at: null, created_at: "2026-01-01", last_used_at: null }];
      if (query.includes("UPDATE device_reporting_tokens")) return [{ id: "dpt_1" }];
      return [];
    };
    const accountWorker = createWorker({ createSql: () => sql, authenticate: async () => ({ id: "owner" }) });
    const create = await request(accountWorker, "/device-reporting/tokens", { body: { deviceId: "device-1" } });
    expect(create.status).toBe(201); expect((await create.json()).token).toMatch(/^dp_/);
    const list = await request(accountWorker, "/device-reporting/tokens", { method: "GET" });
    expect(list.status).toBe(200); expect((await list.json()).tokens[0]).not.toHaveProperty("token_hash");
    const revoke = await request(accountWorker, "/device-reporting/tokens/dpt_1", { method: "DELETE" });
    expect(revoke.status).toBe(200);
    const unauthenticated = createWorker({ authenticate: async () => null });
    expect((await request(unauthenticated, "/app-data", { method: "GET", authorization: token })).status).toBe(401);
    expect(calls.some(call => call.query.includes("device_id"))).toBe(true);
  });
});
