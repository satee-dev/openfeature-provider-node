import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { it } from "node:test";
import { promisify } from "node:util";
import { FlagFileError, flagFilePath, readBody } from "../src/flag-file.ts";
import { sha256Hex } from "../src/provider.ts";
import { exampleFlags } from "./fixture-server.ts";

it("derives the file path from the key as the published test vector says", async () => {
  assert.equal(
    await flagFilePath("7Rq2mXv9KpL4nTz8WbY3cHd6", sha256Hex),
    "/v1/b0c0c965477220edb232a9cabcfb54fc/flags.json",
  );
});

it("refuses a hash that is not SHA-256 hex rather than putting it in the path", async () => {
  await assert.rejects(
    flagFilePath("secret", async (text) => text),
    FlagFileError,
  );
});

function streamOf(chunks: Uint8Array[]) {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { response: new Response(body), cancelled: () => cancelled };
}

it("stops reading and cancels a body without a length once it passes 4 MiB", async () => {
  const mebibyte = new Uint8Array(1024 * 1024).fill(0x20);
  const { response, cancelled } = streamOf([mebibyte, mebibyte, mebibyte, mebibyte, new Uint8Array(1), mebibyte]);
  await assert.rejects(readBody(response), /larger than 4 MiB/);
  assert.ok(cancelled());
});

it("decodes a character split across chunks, and keeps a leading byte order mark", async () => {
  const { response } = streamOf([new Uint8Array([0xef, 0xbb, 0xbf, 0x22, 0xe2]), new Uint8Array([0x82, 0xac, 0x22])]);
  assert.equal(await readBody(response), '\ufeff"€"');
});

const blockBuiltins = `
  import { isBuiltin } from "node:module";
  export async function resolve(specifier, context, next) {
    if (isBuiltin(specifier)) throw new Error("imports the Node built-in " + specifier);
    return next(specifier, context);
  }`;
const registerHooks = `import { register } from "node:module"; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(blockBuiltins)}`)});`;

it("imports no Node built-ins of its own and runs on a Web Crypto hash without Buffer", async () => {
  const script = `
    const { changedKeys, flagFilePath, parseFlagFile, readBody } = await import(${JSON.stringify(new URL("../src/flag-file.ts", import.meta.url).href)});
    const response = new Response(process.env.FLAGS);
    // Node's own Response needs Buffer the first time it reads a body.
    await response.clone().text();
    delete globalThis.Buffer;
    const sha256Hex = async (text) =>
      Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    const file = parseFlagFile(await readBody(response), undefined, console);
    console.log(JSON.stringify({
      path: await flagFilePath("7Rq2mXv9KpL4nTz8WbY3cHd6", sha256Hex),
      revision: file.revision,
      changed: changedKeys(file.flags, {}),
    }));
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", `data:text/javascript,${encodeURIComponent(registerHooks)}`, "--input-type=module", "-e", script],
    { env: { FLAGS: exampleFlags, NODE_OPTIONS: process.env.NODE_OPTIONS ?? "" }, timeout: 10_000 },
  );
  assert.deepEqual(JSON.parse(stdout), {
    path: "/v1/b0c0c965477220edb232a9cabcfb54fc/flags.json",
    revision: 42,
    changed: ["beta-banner", "new-checkout"],
  });
});
