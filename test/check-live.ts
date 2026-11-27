import { OpenFeature } from "@openfeature/server-sdk";
import { flagFilePath, parseFlagFile, readBody } from "../src/flag-file.ts";
import { SateeProvider } from "../src/index.ts";
import { sha256Hex } from "../src/provider.ts";

const PREFIX = "satee_server_";
const sdkKey = process.env.SATEE_SDK_KEY;
const baseUrl = process.env.SATEE_BASE_URL ?? "https://flags.satee.dev";
if (!sdkKey?.startsWith(PREFIX)) fail("Set SATEE_SDK_KEY to a key for the test host.");
const secret = sdkKey.slice(PREFIX.length);
const keyHint = secret.length > 8 ? `the key ending ${secret.slice(-4)}` : "the key";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? `${error.name}: ${code}` : error.name;
}

let response: Response;
try {
  response = await fetch(`${baseUrl}${await flagFilePath(secret, sha256Hex)}`, {
    signal: AbortSignal.timeout(10_000),
  });
} catch (error) {
  fail(`Could not reach the test host for ${keyHint} (${describe(error)}).`);
}
if (response.status !== 200) fail(`The test host answered HTTP ${response.status} for ${keyHint}.`);
const file = parseFlagFile(await readBody(response), undefined, console);
const keys = Object.keys(file.flags);
console.log(`Read revision ${file.revision} with ${keys.length} flags.`);

await OpenFeature.setProviderAndWait(new SateeProvider({ sdkKey, baseUrl, logger: console }));
const [firstKey] = keys;
const details = firstKey ? await OpenFeature.getClient().getBooleanDetails(firstKey, false) : undefined;
await OpenFeature.close();
if (details?.errorCode) fail(`The provider did not serve ${firstKey} (${details.errorCode}).`);
console.log(
  firstKey
    ? `The provider serves ${firstKey} as ${details?.value}.`
    : "The file has no flags, so the provider was not checked.",
);
