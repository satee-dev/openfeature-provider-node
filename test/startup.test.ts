import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { afterEach, beforeEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { OpenFeature } from "@openfeature/server-sdk";
import { SateeProvider } from "../src/index.ts";
import { testTiming } from "../src/provider.ts";
import { exampleFlags, FIXTURE_SDK_KEY, type FixtureServer, startFixtureServer } from "./fixture-server.ts";

const timing = { minPollMs: 20, startupMs: 200, startupRetryMs: 50 };

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("start-up", () => {
  let server: FixtureServer;
  let logs: string[];
  const client = () => OpenFeature.getClient("startup");
  const record = (...args: unknown[]) => logs.push(args.join(" "));
  const provider = (overrides = {}) =>
    new SateeProvider({
      sdkKey: FIXTURE_SDK_KEY,
      baseUrl: server.baseUrl,
      pollIntervalMs: 20,
      logger: { debug: record, info: record, warn: record, error: record },
      [testTiming]: { ...timing, ...overrides },
    } as never);
  const value = () => client().getBooleanDetails("new-checkout", false);

  beforeEach(async () => {
    server = await startFixtureServer();
    logs = [];
  });

  afterEach(async () => {
    await OpenFeature.clearProviders();
    await server.close();
  });

  it("retries until the window ends, then serves defaults until a file arrives", async () => {
    server.respondWith(500);
    const startedAt = Date.now();
    await OpenFeature.setProviderAndWait("startup", provider());
    assert.ok(Date.now() - startedAt >= timing.startupMs - timing.startupRetryMs);
    const attempts = server.requests.length;
    assert.ok(attempts >= 2 && attempts <= timing.startupMs / timing.startupRetryMs, `${attempts} attempts`);
    assert.equal((await value()).errorCode, "PROVIDER_NOT_READY");
    server.serve(exampleFlags);
    await until(async () => (await value()).value, "the file to load");
  });

  it("gives up on an attempt that outlasts the window instead of trying again", async () => {
    server.respondSlowly(timing.startupMs * 5);
    const startedAt = Date.now();
    await OpenFeature.setProviderAndWait("startup", provider());
    assert.equal(server.requests.length, 1);
    assert.ok(Date.now() - startedAt < timing.startupMs * 3, `took ${Date.now() - startedAt} ms`);
    await until(() => logs.some((line) => line.includes("TimeoutError")), "the timeout to be logged");
  });

  it("stops retrying at once when closed", async () => {
    server.respondWith(500);
    const starting = OpenFeature.setProviderAndWait("startup", provider({ startupMs: 5000 }));
    await until(() => server.requests.length > 0, "the first attempt");
    const closedAt = Date.now();
    await OpenFeature.clearProviders();
    await starting.catch(() => {});
    assert.ok(Date.now() - closedAt < timing.startupRetryMs * 4, `took ${Date.now() - closedAt} ms`);
    const seen = server.requests.length;
    await new Promise((resolve) => setTimeout(resolve, timing.startupRetryMs * 3));
    assert.equal(server.requests.length, seen);
  });

  it("loads the flags once a server that was down comes back", async () => {
    const port = Number(new URL(server.baseUrl).port);
    await server.close();
    await OpenFeature.setProviderAndWait("startup", provider());
    assert.equal((await value()).errorCode, "PROVIDER_NOT_READY");
    server = await startFixtureServer(undefined, { port });
    await until(async () => (await value()).value, "the file to load");
  });
});

it("runs the documented snippet to completion within about 5 seconds when Satee is down", async () => {
  const server = await startFixtureServer();
  await server.close();
  const script = `
    import { OpenFeature } from "@openfeature/server-sdk";
    import { SateeProvider } from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)};
    const sdkKey = process.env.SATEE_SDK_KEY;
    await OpenFeature.setProviderAndWait(new SateeProvider({ sdkKey, baseUrl: process.env.URL }));
    const flags = OpenFeature.getClient();
    console.log(await flags.getBooleanValue("new-checkout", false));
  `;
  const startedAt = Date.now();
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, SATEE_SDK_KEY: FIXTURE_SDK_KEY, URL: server.baseUrl },
    timeout: 15_000,
  });
  const elapsed = Date.now() - startedAt;
  assert.equal(stdout.trim(), "false");
  assert.ok(elapsed >= 4000 && elapsed < 7500, `took ${elapsed} ms`);
});
