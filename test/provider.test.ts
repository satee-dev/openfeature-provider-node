import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { ErrorCode, OpenFeature } from "@openfeature/server-sdk";
import { SateeProvider } from "../src/index.ts";
import { testTiming } from "../src/provider.ts";
import { VERSION } from "../src/version.ts";
import {
  exampleFlags,
  FIXTURE_PATH,
  FIXTURE_PATH_ID,
  FIXTURE_SDK_KEY,
  type FixtureServer,
  startFixtureServer,
} from "./fixture-server.ts";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe("constructor", () => {
  for (const sdkKey of [undefined, "", "abcd1234", "satee_sdk_abcd1234", "satee_server_"]) {
    it(`rejects ${JSON.stringify(sdkKey)} with a message naming SATEE_SDK_KEY`, () => {
      assert.throws(() => new SateeProvider({ sdkKey }), /SATEE_SDK_KEY.*satee_server_|satee_server_.*SATEE_SDK_KEY/);
    });
  }

  it("accepts any key with the prefix", () => {
    assert.doesNotThrow(() => new SateeProvider({ sdkKey: "satee_server_anything-goes" }));
  });

  it("rejects a browser key with a message saying so", () => {
    assert.throws(
      () => new SateeProvider({ sdkKey: "satee_client_7Rq2mXv9KpL4nTz8WbY3cHd6" }),
      /^Error: This is a browser key\. Use the server key from the Setup page\.$/,
    );
  });
});

describe("evaluation against the shared fixture", () => {
  let server: FixtureServer;
  const domain = "fixture";
  before(async () => {
    server = await startFixtureServer();
    await OpenFeature.setProviderAndWait(
      domain,
      new SateeProvider({ sdkKey: FIXTURE_SDK_KEY, baseUrl: server.baseUrl, logger: silent }),
    );
  });
  after(async () => {
    await OpenFeature.close();
    await server.close();
  });

  it("returns true for an on flag", async () => {
    assert.equal(await OpenFeature.getClient(domain).getBooleanValue("new-checkout", false), true);
  });

  it("returns false for an off flag whatever the caller's default", async () => {
    assert.equal(await OpenFeature.getClient(domain).getBooleanValue("beta-banner", true), false);
  });

  it("returns the caller's default for a missing flag", async () => {
    const details = await OpenFeature.getClient(domain).getBooleanDetails("no-such-flag", true);
    assert.equal(details.value, true);
    assert.equal(details.errorCode, ErrorCode.FLAG_NOT_FOUND);
  });

  it("returns the caller's default for a non-boolean getter", async () => {
    const details = await OpenFeature.getClient(domain).getStringDetails("new-checkout", "fallback");
    assert.equal(details.value, "fallback");
    assert.equal(details.errorCode, ErrorCode.TYPE_MISMATCH);
  });

  it("requests the key's file with a User-Agent naming the provider", () => {
    const [request] = server.requests;
    assert.equal(request?.url, FIXTURE_PATH);
    assert.equal(request?.headers["user-agent"], `satee-openfeature-node/${VERSION}`);
  });
});

describe("a file it refuses to load", () => {
  const load = async (body: string, sdkKey = FIXTURE_SDK_KEY, startupMs = 1000) => {
    const server = await startFixtureServer(body);
    const logs: string[] = [];
    const record =
      (level: string) =>
      (...args: unknown[]) =>
        logs.push(`${level}: ${args.join(" ")}`);
    const logger = { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") };
    const domain = "refused";
    const options = { sdkKey, baseUrl: server.baseUrl, logger, [testTiming]: { startupMs, startupRetryMs: startupMs } };
    await OpenFeature.setProviderAndWait(domain, new SateeProvider(options));
    await new Promise((resolve) => setImmediate(resolve));
    const details = await OpenFeature.getClient(domain).getBooleanDetails("new-checkout", false);
    await OpenFeature.close();
    await server.close();
    return { details, logs, server };
  };

  it("never hands $evaluators to the evaluator", async () => {
    const withEvaluators = JSON.stringify({ ...JSON.parse(exampleFlags), $evaluators: { e: { "==": [1, 1] } } });
    const { details, logs } = await load(withEvaluators);
    assert.equal(details.errorCode, ErrorCode.PROVIDER_NOT_READY);
    assert.match(logs.join("\n"), /^warn: .*not a Satee flag file/m);
  });

  it("never hands targeting to the evaluator", async () => {
    const file = JSON.parse(exampleFlags);
    file.flags["new-checkout"].targeting = { if: [true, "on", "off"] };
    const { details, logs } = await load(JSON.stringify(file));
    assert.equal(details.errorCode, ErrorCode.PROVIDER_NOT_READY);
    assert.match(logs.join("\n"), /^warn: .*carries targeting rules/m);
  });

  it("refuses flags that are not an object", async () => {
    const flag = { state: "ENABLED", variants: { on: true, off: false }, defaultVariant: "on" };
    const { details, logs } = await load(JSON.stringify({ flags: [flag] }));
    assert.equal(details.errorCode, ErrorCode.PROVIDER_NOT_READY);
    assert.match(logs.join("\n"), /^warn: .*not a Satee flag file/m);
  });

  it("drops targeting hidden behind a flag's __proto__", async () => {
    const body = `{"metadata":{"revision":1},"flags":{"new-checkout":{"__proto__":{"targeting":{"if":[true,"off","on"]}},
      "state":"ENABLED","variants":{"on":true,"off":false},"defaultVariant":"on"}}}`;
    const { details } = await load(body);
    assert.equal(details.value, true);
    assert.equal(details.reason, "STATIC");
  });

  it("stops reading a body larger than 4 MiB", async () => {
    const { details, logs } = await load(`${" ".repeat(5 * 1024 * 1024)}{}`, FIXTURE_SDK_KEY, 2000);
    assert.equal(details.errorCode, ErrorCode.PROVIDER_NOT_READY);
    assert.match(logs.join("\n"), /^warn: .*larger than 4 MiB/m);
  });

  it("keeps the key out of the URL and the key and path id out of the log", async () => {
    const sdkKey = "satee_server_../other?x#9876";
    const { logs, server } = await load(exampleFlags, sdkKey);
    const url = server.requests[0]?.url ?? "";
    const pathId = /^\/v1\/([0-9a-f]{32})\/flags\.json$/.exec(url)?.[1];
    assert.ok(pathId, url);
    assert.match(logs.join("\n"), /^error: .*SDK key not found\. Check SATEE_SDK_KEY\. \(key ending 9876\)/m);
    for (const line of logs) {
      assert.ok(![sdkKey.slice("satee_server_".length), pathId, server.baseUrl].some((leak) => line.includes(leak)));
    }
  });
});

it("keeps the key and path id out of the log when the fetch error names the URL", async () => {
  const logs: string[] = [];
  const record = (...args: unknown[]) => logs.push(args.join(" "));
  const logger = { debug: record, info: record, warn: record, error: record };
  const timing = { startupMs: 20, startupRetryMs: 20 };
  const provider = new SateeProvider({
    sdkKey: FIXTURE_SDK_KEY,
    baseUrl: "http://exa mple",
    logger,
    [testTiming]: timing,
  } as never);
  await OpenFeature.setProviderAndWait("bad-url", provider);
  await new Promise((resolve) => setImmediate(resolve));
  await OpenFeature.close();
  assert.match(logs.join("\n"), /Could not load flags yet .*TypeError/);
  for (const line of logs) {
    assert.ok(
      ![FIXTURE_SDK_KEY.slice("satee_server_".length), FIXTURE_PATH_ID].some((leak) => line.includes(leak)),
      line,
    );
  }
});

it("reports the version from package.json", () => {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(VERSION, version);
});
