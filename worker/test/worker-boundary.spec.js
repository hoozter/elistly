import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";

const allowedOrigins = "https://app.example.test,https://admin.example.test";

async function request(path, { method = "GET", origin, env = {}, headers = {} } = {}) {
  const requestHeaders = new Headers(headers);
  if (origin) requestHeaders.set("Origin", origin);
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://api.example.test${path}`, { method, headers: requestHeaders }),
    {
      ELISTLY_ALLOWED_ORIGINS: allowedOrigins,
      ...env,
    },
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

describe("Elistly Worker public boundary", () => {
  it("returns health to originless callers without credentialed CORS", async () => {
    const response = await request("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("only grants credentialed CORS to configured origins on normal and preflight responses", async () => {
    const origin = "https://app.example.test";
    const normal = await request("/health", { origin });
    const preflight = await request("/health", { method: "OPTIONS", origin });

    for (const response of [normal, preflight]) {
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
      expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
      expect(response.headers.get("Vary")).toContain("Origin");
    }
  });

  it("rejects unconfigured origins without granting CORS", async () => {
    const response = await request("/health", { origin: "https://untrusted.example.test" });

    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(await response.json()).toEqual({ error: "Forbidden origin" });
  });

  it("fails closed when the configured origin list is malformed", async () => {
    const response = await request("/health", {
      origin: "https://app.example.test",
      env: { ELISTLY_ALLOWED_ORIGINS: "not-an-origin" },
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await response.json()).toEqual({ error: "Worker configuration error" });
  });

  it("fails closed when no frontend origin allowlist is configured", async () => {
    const response = await request("/health", {
      env: { ELISTLY_ALLOWED_ORIGINS: undefined },
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await response.json()).toEqual({ error: "Worker configuration error" });
  });

  it("does not expose the debug environment endpoint", async () => {
    const response = await request("/debug-env");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });
});
