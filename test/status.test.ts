import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type EventDetails, type Logger, OpenFeature, ProviderEvents, ProviderStatus } from "@openfeature/server-sdk";
import { SateeProvider } from "../src/index.ts";
import { testTiming } from "../src/provider.ts";
import {
  exampleFlags,
  FIXTURE_PATH_ID,
  FIXTURE_SDK_KEY,
  type FixtureServer,
  startFixtureServer,
} from "./fixture-server.ts";

const POLL_MS = 20;
const timing = { minPollMs: POLL_MS, startupMs: 200, startupRetryMs: 50, staleAfterMs: 150, refusedPollMs: 100 };
const NOT_FOUND = "SDK key not found. Check SATEE_SDK_KEY.";
const NO_LONGER_VALID = "SDK key no longer valid";
const REFUSED = "Request refused (403). Check SATEE_SDK_KEY and the base URL.";
const NOT_LOADED = "Could not load flags yet";
const STALE = "Could not refresh flags; serving the last good values";
const watched = [ProviderEvents.Ready, ProviderEvents.Error, ProviderEvents.Stale] as const;

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("status and events", () => {
  let server: FixtureServer;
  let events: string[];
  let logs: string[];
  const client = () => OpenFeature.getClient("status");
  const handlers = watched.map(
    (type) => [type, (d?: EventDetails) => events.push(`${type}: ${d?.message ?? ""}`)] as const,
  );
  const record = (...args: unknown[]) => logs.push(args.join(" "));
  const recordingLogger = { debug: record, info: record, warn: record, error: record };
  const provider = (logger: Logger = recordingLogger, overrides = {}) =>
    new SateeProvider({
      sdkKey: FIXTURE_SDK_KEY,
      baseUrl: server.baseUrl,
      pollIntervalMs: POLL_MS,
      logger,
      [testTiming]: { ...timing, ...overrides },
    } as never);
  const start = async (logger?: Logger) => {
    await OpenFeature.setProviderAndWait("status", provider(logger));
    await new Promise((resolve) => setImmediate(resolve));
  };
  const value = () => client().getBooleanDetails("new-checkout", false);
  const eventsOf = (type: ProviderEvents) => events.filter((e) => e.startsWith(`${type}:`));
  const reported = (type: ProviderEvents, ...messages: string[]) => messages.map((m) => `${type}: ${m}`);
  // The SDK emits Ready once initialize resolves; the provider's Error follows on the next tick.
  const failedAtStart = (message: string) => [
    ...reported(ProviderEvents.Ready, ""),
    ...reported(ProviderEvents.Error, message),
  ];
  const morePolls = (count: number) => {
    const target = server.requests.length + count;
    return until(() => server.requests.length >= target, `${count} more polls`);
  };
  const recovered = () => until(() => eventsOf(ProviderEvents.Ready).length === 2, "Ready");

  beforeEach(async () => {
    server = await startFixtureServer();
    events = [];
    logs = [];
    for (const [type, handler] of handlers) client().addHandler(type, handler);
  });

  afterEach(async () => {
    for (const [type, handler] of handlers) client().removeHandler(type, handler);
    await OpenFeature.clearProviders();
    await server.close();
    const secret = FIXTURE_SDK_KEY.slice("satee_server_".length);
    for (const line of [...logs, ...events]) {
      const leaked = [secret, FIXTURE_PATH_ID, server.baseUrl].some((leak) => line.includes(leak));
      assert.ok(!leaked, `leaks the key, path id or URL: ${line}`);
    }
  });

  it("retries until the start-up window ends, then reports Error once and recovers to Ready", async () => {
    server.respondWith(500);
    const startedAt = Date.now();
    await start();
    assert.ok(Date.now() - startedAt >= timing.startupMs - timing.startupRetryMs);
    const attempts = server.requests.length;
    assert.ok(attempts >= 2 && attempts <= timing.startupMs / timing.startupRetryMs + 1, `${attempts} attempts`);
    assert.equal(client().providerStatus, ProviderStatus.ERROR);
    assert.equal((await value()).errorCode, "PROVIDER_NOT_READY");
    await morePolls(5);
    assert.deepEqual(events, failedAtStart(NOT_LOADED));
    server.serve(exampleFlags);
    await recovered();
    assert.equal(client().providerStatus, ProviderStatus.READY);
    assert.equal((await value()).value, true);
  });

  it("still reports Error and Ready when the logger throws", async () => {
    const fail = () => {
      throw new Error("logger down");
    };
    server.respondWith(500);
    await start({ debug: fail, info: fail, warn: fail, error: fail });
    assert.deepEqual(events, failedAtStart(NOT_LOADED));
    server.serve(exampleFlags);
    await recovered();
  });

  for (const [status, message] of [
    [404, NOT_FOUND],
    [403, REFUSED],
  ] as const) {
    it(`reports a ${status} at start without retrying, polls slowly, and recovers`, async () => {
      server.respondWith(status);
      await start();
      assert.equal(server.requests.length, 1);
      assert.deepEqual(events, failedAtStart(message));
      assert.equal((await value()).errorCode, "PROVIDER_NOT_READY");
      const startedAt = Date.now();
      await morePolls(2);
      assert.ok(Date.now() - startedAt >= timing.refusedPollMs * 1.5, "polls once per refusedPollMs");
      assert.deepEqual(events, failedAtStart(message));
      server.serve(exampleFlags);
      await recovered();
      assert.equal((await value()).value, true);
      const recoveredAt = Date.now();
      await morePolls(3);
      assert.ok(Date.now() - recoveredAt < timing.refusedPollMs * 2, "back to the normal interval");
    });
  }

  for (const [status, message] of [
    [404, NO_LONGER_VALID],
    [403, REFUSED],
  ] as const) {
    it(`keeps the last good flags through a ${status} once loaded`, async () => {
      await start();
      server.respondWith(status);
      await until(() => eventsOf(ProviderEvents.Error).length > 0, "Error");
      await morePolls(2);
      assert.deepEqual(eventsOf(ProviderEvents.Error), reported(ProviderEvents.Error, message));
      assert.equal(client().providerStatus, ProviderStatus.ERROR);
      assert.equal((await value()).value, true);
      server.serve(exampleFlags);
      await recovered();
    });
  }

  it("reports Stale once no poll has succeeded for a while, then recovers to Ready", async () => {
    await start();
    const failingSince = Date.now();
    server.respondWith(500);
    await until(() => eventsOf(ProviderEvents.Stale).length > 0, "Stale");
    assert.ok(Date.now() - failingSince >= timing.staleAfterMs - POLL_MS, "Stale came too early");
    await morePolls(3);
    assert.deepEqual(eventsOf(ProviderEvents.Stale), reported(ProviderEvents.Stale, STALE));
    assert.equal(client().providerStatus, ProviderStatus.STALE);
    assert.equal((await value()).value, true);
    server.serve(exampleFlags);
    await recovered();
    assert.equal(client().providerStatus, ProviderStatus.READY);
  });

  it("escalates Stale to Error, reports each new refusal, and never falls back to Stale", async () => {
    await start();
    server.respondWith(500);
    await until(() => eventsOf(ProviderEvents.Stale).length > 0, "Stale");
    server.respondWith(403);
    await until(() => eventsOf(ProviderEvents.Error).length === 1, "Error for the 403");
    server.respondWith(404);
    await until(() => eventsOf(ProviderEvents.Error).length === 2, "Error for the 404");
    server.respondWith(500);
    await morePolls(3);
    assert.deepEqual(events, [
      ...reported(ProviderEvents.Ready, ""),
      ...reported(ProviderEvents.Stale, STALE),
      ...reported(ProviderEvents.Error, REFUSED, NO_LONGER_VALID),
    ]);
  });

  it("reports an ignored file once, however often it is served, and keeps the last good flags", async () => {
    await start();
    server.serve("{ not json");
    await morePolls(4);
    assert.equal(logs.filter((line) => line.includes("ignored a flag file")).length, 1);
    assert.equal((await value()).value, true);
  });
});
