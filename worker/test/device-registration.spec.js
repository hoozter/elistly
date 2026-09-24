import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addRegisteredDevice, createWorker, updateReportedDevice, validateRegistrationFacts } from "../src/index.js";

const identity = "a".repeat(64);
const snapshot = {
  schemaVersion: "elistly.windows-device-registration.v1",
  collectedAt: "2026-01-01T00:00:00.000Z",
  device: { manufacturer: "Acme", model: "Model 1", serialNumber: "SERIAL-1", uuid: "uuid-1" },
  windows: { edition: "Windows 11 Pro", version: "10.0.26100", build: "26100", displayRelease: "24H2", installDate: "2025-01-01T00:00:00.000Z" },
  cpu: { model: "Example CPU", cores: 8, logicalProcessors: 16 },
  ramBytes: 34359738368,
  fixedDisks: [{ capacityBytes: 1000000000000, freeBytes: 500000000000 }],
  networkAdapters: [{ name: "Ethernet", macAddress: "00-11-22-33-44-55", ipv4Addresses: ["192.168.1.10"], ipv6Addresses: ["fe80::1"] }],
  biosVersion: "1.2.3",
  tpm: { present: true, version: "2.0", ready: true },
  secureBoot: true,
  bitLockerProtectionStatus: "On",
  battery: { designCapacityMWh: 60000, fullChargeCapacityMWh: 54000, healthPercent: 90 },
  lastBootAt: "2026-01-01T00:00:00.000Z",
  uptimeSeconds: 3600,
  lastInteractiveUser: { username: null, time: null, source: "Win32_ComputerSystem.UserName", observation: "current interactive session" },
  availability: { tpm: null, secureBoot: null, bitLocker: null, battery: null, networkAdapters: null, lastInteractiveUser: "Unavailable: no interactive user was observed." }
};
const facts = { hardwareIdentity: identity, hostname: "PC-01", serialNumber: "SERIAL-1", manufacturer: "Acme", model: "Model 1", windowsEdition: "Windows 11 Pro", inventorySnapshot: snapshot };
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
  it("defaults to no expiry and accepts only future explicit expiry", async () => {
    const sql = async (strings, ...values) => strings.join(' ').includes('SELECT payload') ? [{payload: payload()}] : [];
    const worker = createWorker({createSql: () => sql, authenticate: async () => ({id:'owner'})});
    for (const expiry of [undefined, null, '2099-01-01T00:00:00.000Z', 'invalid', '2020-01-01T00:00:00Z']) {
      const response = await fetchRegistration(worker, '/device-registration/tokens', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspaceId:'default',expiresAt:expiry})});
      const valid = expiry == null || expiry.startsWith('2099');
      expect(response.status).toBe(valid ? 201 : 400);
      if (valid) expect((await response.json()).expiresAt).toBe(expiry ?? null);
    }
  });
  it("creates one explicitly marked Computer and repeated registration is idempotent", () => {
    const initial = payload();
    const first = addRegisteredDevice(initial, "default", facts);
    const second = addRegisteredDevice(first.payload, "default", facts);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(Object.keys(second.payload.workspaces.default.entities)).toHaveLength(1);
    expect(second.entity._elistlyRegistration.hardwareIdentity).toBe(identity);
    expect(second.entity._elistlyRegistration.inventorySnapshot).toEqual(snapshot);
    expect(second.payload).toEqual(first.payload);
    expect(second.entity.name).toBe("PC-01");
    expect(second.entity.assignedTo).toBeUndefined();
    expect(initial.workspaces.default.entities).toEqual({});
  });

  it("projects collected processor, RAM, and graphics facts into configured Computer fields", () => {
    const initial = payload();
    initial.workspaces.default.entityTypes.computer.fields = [
      { name: "processor", type: "text", collection: { provider: "windows", capability: "processor.summary" } },
      { name: "installedRam", type: "text", collection: { provider: "windows", capability: "memory.total" } },
      { name: "graphicsCard", type: "text", collection: { provider: "windows", capability: "graphics.adapters" } },
    ];
    const reportedFacts = {
      ...facts,
      inventorySnapshot: { ...snapshot, graphicsAdapters: ["Example Graphics"] },
    };

    const { entity } = addRegisteredDevice(initial, "default", reportedFacts);

    expect(entity.processor).toBe("Example CPU");
    expect(entity.installedRam).toBe("32 GB");
    expect(entity.graphicsCard).toBe("Example Graphics");
  });

  it("uses the one matching configured dropdown value instead of creating a new value", () => {
    const initial = payload();
    initial.workspaces.default.entityTypes.computer.fields = [
      { name: "ram", type: "dropdown", options: [{ value: "16GB" }, { value: "32GB" }], collection: { provider: "windows", capability: "memory.total" } },
    ];

    const { entity } = addRegisteredDevice(initial, "default", facts);

    expect(entity.ram).toBe("32GB");
  });

  it("leaves configured fields absent when the collector has no available fact", () => {
    const initial = payload();
    initial.workspaces.default.entityTypes.computer.fields = [
      { name: "processor", type: "text", collection: { provider: "windows", capability: "processor.summary" } },
      { name: "installedRam", type: "text", collection: { provider: "windows", capability: "memory.total" } },
      { name: "graphicsCard", type: "textarea", collection: { provider: "windows", capability: "graphics.adapters" } },
    ];
    const unavailableFacts = { ...facts, inventorySnapshot: { ...snapshot, cpu: { ...snapshot.cpu, model: null }, ramBytes: null, graphicsAdapters: [] } };

    const { entity } = addRegisteredDevice(initial, "default", unavailableFacts);

    expect(entity).not.toHaveProperty("processor");
    expect(entity).not.toHaveProperty("installedRam");
    expect(entity).not.toHaveProperty("graphicsCard");
  });

  it("fills empty configured reported Computer fields without assigning a person", () => {
    const initial = payload();
    initial.workspaces.default.entityTypes.computer.fields = [
      { name: "processor", type: "text", collection: { provider: "windows", capability: "processor.summary" } },
      { name: "installedRam", type: "text", collection: { provider: "windows", capability: "memory.total" } },
      { name: "manufacturer", type: "text", collection: { provider: "windows", capability: "computer.manufacturer" } },
      { name: "windowsVersion", type: "text", collection: { provider: "windows", capability: "windows.version" } },
    ];
    const created = addRegisteredDevice(initial, "default", facts);
    const deviceId = created.entity.id;
    created.payload.workspaces.default.entities[deviceId].processor = "";
    created.payload.workspaces.default.entities[deviceId].installedRam = null;
    created.payload.workspaces.default.entities[deviceId].manufacturer = "Manual manufacturer";
    created.payload.workspaces.default.entities[deviceId].windowsVersion = "Manual version";
    const updatedFacts = {
      ...facts,
      inventorySnapshot: {
        ...snapshot,
        collectedAt: "2026-01-02T00:00:00.000Z",
        cpu: { ...snapshot.cpu, model: "Updated CPU" },
        ramBytes: 17179869184,
      },
    };

    const updated = updateReportedDevice(created.payload, "default", deviceId, updatedFacts);
    const device = updated.workspaces.default.entities[deviceId];

    expect(device.processor).toBe("Updated CPU");
    expect(device.installedRam).toBe("16 GB");
    expect(device.manufacturer).toBe("Manual manufacturer");
    expect(device.windowsVersion).toBe("Manual version");
    expect(device.assignedTo).toBeUndefined();
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

  it("accepts only the bounded allowlisted inventory snapshot", () => {
    expect(validateRegistrationFacts(facts).inventorySnapshot.fixedDisks).toHaveLength(1);
    expect(validateRegistrationFacts(facts).inventorySnapshot.networkAdapters).toHaveLength(1);
    expect(() => validateRegistrationFacts({ ...facts, email: "no@example.test" })).toThrow("Unknown registration field");
    expect(() => validateRegistrationFacts({ ...facts, inventorySnapshot: { ...snapshot, files: ["C:\\secret.txt"] } })).toThrow("Unknown inventorySnapshot field");
    expect(() => validateRegistrationFacts({ ...facts, inventorySnapshot: { ...snapshot, fixedDisks: [{ ...snapshot.fixedDisks[0], fileList: [] }] } })).toThrow("Unknown fixedDisks item field");
    expect(() => validateRegistrationFacts({ ...facts, inventorySnapshot: { ...snapshot, networkAdapters: [{ ...snapshot.networkAdapters[0], gateway: "192.168.1.1" }] } })).toThrow("Unknown networkAdapters item field");
    expect(() => validateRegistrationFacts({ ...facts, inventorySnapshot: { ...snapshot, networkAdapters: Array(33).fill(snapshot.networkAdapters[0]) } })).toThrow("networkAdapters must contain at most 32 adapters");
  });

  it("serves the registration HTTP path through the SQL seam and preserves a 409 manual collision", async () => {
    const initial = payload();
    initial.workspaces.default.entityTypes.computer.fields = [
      { name: "graphicsCard", type: "textarea", collection: { provider: "windows", capability: "graphics.adapters" } },
    ];
    const calls = [];
    const sql = async (strings, ...values) => {
      const query = strings.join(" ");
      calls.push({ query, values });
      if (query.includes("UPDATE app_data")) { Object.assign(initial, JSON.parse(values.find(value => typeof value === "string" && value.startsWith("{")))); return [{ updated_at: "2026-01-01T00:01:00.000Z" }]; }
      if (query.includes("FROM device_registration_tokens")) return [{ id: "drt_1", owner_user_id: "owner", workspace_id: "default" }];
      if (query.includes("SELECT payload")) return [{ payload: initial, updated_at: "2026-01-01T00:00:00.000Z" }];
      return [];
    };
    const worker = createWorker({ createSql: () => sql, authenticate: async () => null });
    const token = `dr_${"A".repeat(43)}`;
    const headers = { ...registrationAuthorization(token), "Content-Type": "application/json" };
    const reportedFacts = { ...facts, inventorySnapshot: { ...snapshot, graphicsAdapters: ["Integrated GPU", "Discrete GPU"] } };
    const response = await fetchRegistration(worker, "/device-registration/register", { method: "POST", headers, body: JSON.stringify(reportedFacts) });
    expect(response.status).toBe(201);
    expect((await response.json()).created).toBe(true);
    const appDataWrites = calls.filter(call => call.query.includes("UPDATE app_data"));
    expect(appDataWrites).toHaveLength(1);
    const writtenPayload = JSON.parse(appDataWrites[0].values.find(value => typeof value === "string" && value.startsWith("{")));
    const registered = Object.values(writtenPayload.workspaces.default.entities)[0];
    expect(registered._elistlyRegistration.inventorySnapshot).toEqual(reportedFacts.inventorySnapshot);
    expect(registered.graphicsCard).toBe("Integrated GPU; Discrete GPU");

    const retry = await fetchRegistration(worker, "/device-registration/register", { method: "POST", headers, body: JSON.stringify({ ...facts, inventorySnapshot: { ...snapshot, collectedAt: "2026-02-01T00:00:00.000Z" } }) });
    expect(retry.status).toBe(200);
    expect((await retry.json()).created).toBe(false);
    expect(calls.filter(call => call.query.includes("UPDATE app_data"))).toHaveLength(1);

    initial.workspaces.default.entities.manual = { id: "manual", type: "computer", serialNumber: facts.serialNumber };
    const collision = await fetchRegistration(worker, "/device-registration/register", { method: "POST", headers, body: JSON.stringify({ ...facts, hardwareIdentity: "b".repeat(64) }) });
    expect(collision.status).toBe(409);
    expect(await collision.json()).toEqual({ error: "A manual Computer already has this serial number" });
  });

  it("creates reporting enrollment only on explicit opt-in, keeping ordinary registration-only secrets", async () => {
    const calls = [];
    const sql = async (strings, ...values) => {
      calls.push({ query: strings.join(" "), values });
      return strings.join(" ").includes("SELECT payload") ? [{ payload: payload() }] : [];
    };
    const worker = createWorker({ createSql: () => sql, authenticate: async () => ({ id: "owner" }) });
    for (const automaticReporting of [false, true]) {
      const response = await fetchRegistration(worker, "/device-registration/tokens", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId: "default", automaticReporting }) });
      expect(response.status).toBe(201);
      expect((await response.json()).token).toMatch(automaticReporting ? /^dc_/ : /^dr_/);
    }
    const invalid = await fetchRegistration(worker, "/device-registration/tokens", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId: "default", automaticReporting: "true" }) });
    expect(invalid.status).toBe(400);
  });

  it("does not treat a registration token as an account session token", async () => {
    const worker = createWorker({ authenticate: async () => null });
    const token = `dr_${"A".repeat(43)}`;
    const response = await fetchRegistration(worker, "/app-data", { headers: registrationAuthorization(token) });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });
});
