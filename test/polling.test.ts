import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { afterEach, beforeEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { type EventDetails, OpenFeature, ProviderEvents } from "@openfeature/server-sdk";
import { SateeProvider } from "../src/index.ts";
import { testTiming } from "../src/provider.ts";
import { exampleFlags, FIXTURE_SDK_KEY, type FixtureServer, payloads, startFixtureServer } from "./fixture-server.ts";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const POLL_MS = 20;
const ON = { state: "ENABLED", variants: { on: true, off: false }, defaultVariant: "on" };

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("polling", () => {
  let server: FixtureServer;
  let changes: string[][];
  const client = () => OpenFeature.getClient("polling");
  const onChange = (details?: EventDetails) => changes.push((details?.flagsChanged as string[] | undefined) ?? []);
  const startProvider = async (options: Partial<ConstructorParameters<typeof SateeProvider>[0]> = {}) => {
    const provider = new SateeProvider({
      sdkKey: FIXTURE_SDK_KEY,
      baseUrl: server.baseUrl,
      pollIntervalMs: POLL_MS,
      logger: silent,
      [testTiming]: { minPollMs: POLL_MS, startupMs: 100, startupRetryMs: 20 },
      ...options,
    } as ConstructorParameters<typeof SateeProvider>[0]);
    await OpenFeature.setProviderAndWait("polling", provider);
    return provider;
  };
  const currentEtag = async () => (await fetch(`${server.baseUrl}/fixture0001/flags.json`)).headers.get("etag") ?? "";
  const pollsAfter = async (count: number) => {
    const target = server.requests.length + count;
    await until(() => server.requests.length >= target, `${count} more polls`);
  };

  beforeEach(async () => {
    server = await startFixtureServer();
    changes = [];
    client().addHandler(ProviderEvents.ConfigurationChanged, onChange);
  });

  afterEach(async () => {
    client().removeHandler(ProviderEvents.ConfigurationChanged, onChange);
    await OpenFeature.close();
    await server.close();
  });

  describe("once flags are loaded", () => {
    beforeEach(() => startProvider());

    it("revalidates with the held ETag and keeps the flags on 304", async () => {
      const etag = await currentEtag();
      await pollsAfter(2);
      assert.equal(server.requests.at(-1)?.headers["if-none-match"], etag);
      assert.equal(await client().getBooleanValue("new-checkout", false), true);
      assert.deepEqual(changes, []);
    });

    it("swaps in a higher revision and names exactly the flags that changed", async () => {
      server.serve(
        payloads.revision(43, (file) => {
          file.flags["beta-banner"] = ON;
          file.flags.added = { state: "ENABLED", variants: { on: true, off: false }, defaultVariant: "on" };
        }),
      );
      await until(() => changes.length > 0, "ConfigurationChanged");
      await pollsAfter(2);
      assert.equal(changes.length, 1);
      assert.deepEqual([...(changes[0] ?? [])].sort(), ["added", "beta-banner"]);
      assert.equal(await client().getBooleanValue("beta-banner", false), true);
    });

    for (const [name, edit] of [
      ["is removed", (file) => delete file.flags["beta-banner"]],
      ["is disabled", (file) => (file.flags["beta-banner"] = { ...ON, state: "DISABLED", defaultVariant: "off" })],
      [
        "has a variant's value changed",
        (file) => (file.flags["beta-banner"] = { ...ON, variants: { on: false, off: false }, defaultVariant: "off" }),
      ],
    ] as const satisfies readonly [string, Parameters<typeof payloads.revision>[1]][]) {
      it(`names a flag as changed when it ${name}`, async () => {
        server.serve(payloads.revision(43, edit));
        await until(() => changes.length > 0, "ConfigurationChanged");
        await pollsAfter(2);
        assert.deepEqual(changes, [["beta-banner"]]);
      });
    }

    it("accepts a file with the same revision", async () => {
      server.serve(payloads.revision(42, (file) => (file.flags["beta-banner"] = ON)));
      await until(() => changes.length > 0, "ConfigurationChanged");
      assert.equal(await client().getBooleanValue("beta-banner", false), true);
    });

    it("emits nothing when a new revision leaves every flag as it was", async () => {
      server.serve(payloads.revision(43));
      const etag = await currentEtag();
      await pollsAfter(3);
      assert.equal(server.requests.at(-1)?.headers["if-none-match"], etag);
      assert.deepEqual(changes, []);
    });

    it("ignores a 200 that carries the ETag it already holds", async () => {
      const etag = await currentEtag();
      server.serve(
        payloads.revision(43, (file) => {
          file.flags["new-checkout"] = { state: "ENABLED", variants: { on: true, off: false }, defaultVariant: "off" };
        }),
        { etag, ignoreIfNoneMatch: true },
      );
      await pollsAfter(3);
      assert.equal(await client().getBooleanValue("new-checkout", false), true);
      assert.deepEqual(changes, []);
    });

    for (const [name, body] of [
      ["broken JSON", payloads.brokenJson],
      ["a defaultVariant missing from variants", payloads.flagWithoutVariant],
      ["no revision", payloads.withoutRevision],
      ["a lower revision", payloads.lowerRevision],
      ["a fractional revision", payloads.revision(42.5, (file) => (file.flags["beta-banner"] = ON))],
      [
        "a revision given as a string",
        payloads.revision(43, (file) => {
          file.metadata.revision = "43";
          file.flags["beta-banner"] = ON;
        }),
      ],
    ] as const) {
      it(`keeps the held flags when the next file has ${name}`, async () => {
        server.serve(body);
        await pollsAfter(3);
        assert.equal(await client().getBooleanValue("beta-banner", true), false);
        assert.deepEqual(changes, []);
      });
    }

    it("keeps the held flags through a server error", async () => {
      server.respondWith(500);
      await pollsAfter(3);
      assert.equal(await client().getBooleanValue("new-checkout", false), true);
    });

    it("stops polling and abandons an in-flight request when closed", async () => {
      server.respondSlowly(10_000);
      await pollsAfter(1);
      await OpenFeature.close();
      await until(() => server.requests.at(-1)?.abandoned === true, "the request to be abandoned");
      const seen = server.requests.length;
      // Long enough for a timer that survived close to fire several times.
      await new Promise((resolve) => setTimeout(resolve, POLL_MS * 5));
      assert.equal(server.requests.length, seen);
    });
  });

  it("runs a single polling loop after a close and a restart", async () => {
    const provider = await startProvider();
    server.respondSlowly(10_000);
    await pollsAfter(1);
    server.serve(exampleFlags);
    provider.onClose();
    await provider.initialize();
    const seen = server.requests.length;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 10));
    const polls = server.requests.length - seen;
    assert.ok(polls >= 2 && polls <= 13, `${polls} polls in 10 intervals`);
  });

  it("keeps polling when the logger throws", async () => {
    const throwing = {
      ...silent,
      debug: () => {
        throw new Error("logger down");
      },
    };
    await startProvider({ logger: throwing });
    server.respondWith(500);
    await pollsAfter(3);
  });

  it("loads the flags on a later poll when start-up got none", async () => {
    server.respondWith(500);
    await startProvider();
    assert.equal((await client().getBooleanDetails("new-checkout", false)).errorCode, "PROVIDER_NOT_READY");
    server.serve(exampleFlags);
    await until(() => changes.length > 0, "ConfigurationChanged");
    assert.deepEqual([...(changes[0] ?? [])].sort(), ["beta-banner", "new-checkout"]);
    assert.equal(await client().getBooleanValue("new-checkout", false), true);
  });

  for (const [name, pollIntervalMs] of [
    ["an interval below the floor", 50],
    ["an interval that is not a number", Number.NaN],
    ["an interval beyond the timer limit", 2 ** 31],
  ] as const) {
    it(`polls no faster than once a second given ${name}`, async () => {
      await startProvider({ pollIntervalMs, [testTiming]: undefined } as never);
      const seen = server.requests.length;
      // An unclamped interval here fires within a few milliseconds; 300 ms leaves room for several polls.
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(server.requests.length, seen);
    });
  }
});

it("lets a process that only creates the provider exit by itself", async () => {
  const server = await startFixtureServer();
  const script = `
    import { OpenFeature } from "@openfeature/server-sdk";
    import { SateeProvider } from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)};
    await OpenFeature.setProviderAndWait(new SateeProvider({ sdkKey: process.env.KEY, baseUrl: process.env.URL }));
  `;
  try {
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, KEY: FIXTURE_SDK_KEY, URL: server.baseUrl },
      timeout: 10_000,
    });
  } finally {
    await server.close();
  }
});
