import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { exampleFlags, FIXTURE_SDK_KEY, payloads, startFixtureServer } from "./fixture-server.ts";

const server = await startFixtureServer();
const running = new Set<ChildProcess>();

function run(example: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [`examples/${example}`], {
    env: { ...process.env, SATEE_SDK_KEY: FIXTURE_SDK_KEY, SATEE_BASE_URL: server.baseUrl, ...env },
  });
  running.add(child);
  child.on("exit", () => running.delete(child));
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const waitFor = async (pattern: RegExp, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!pattern.test(output)) {
      if (Date.now() > deadline) throw new Error(`${example} never printed ${pattern}; it printed:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return output.match(pattern);
  };
  return { child, waitFor };
}

try {
  const quickstart = run("quickstart.js");
  await quickstart.waitFor(/new-checkout: true\n[\s\S]*new-checkout: true\n/);
  quickstart.child.kill();

  const events = run("events.js");
  await events.waitFor(/Satee provider is ready/);
  const checkoutOff = payloads.revision(43, (file) => {
    const flag = file.flags["new-checkout"];
    if (flag) flag.defaultVariant = "off";
  });
  server.serve(checkoutOff);
  await events.waitFor(/Satee flags changed: new-checkout/);
  server.respondWith(404);
  await events.waitFor(/Satee flags are unavailable: SDK key no longer valid/);
  events.child.kill();
  server.serve(exampleFlags);

  const shutdown = run("shutdown.js", { PORT: "0" });
  const [, port] = (await shutdown.waitFor(/listening on port (\d+)/)) ?? [];
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "new checkout\n");
  const stoppedAt = Date.now();
  shutdown.child.kill("SIGTERM");
  const [code] = await once(shutdown.child, "exit", { signal: AbortSignal.timeout(5000) });
  assert.equal(code, 0, "shutdown.js should exit cleanly on SIGTERM");
  assert.ok(Date.now() - stoppedAt < 2000, "shutdown.js should exit promptly on SIGTERM");
  console.log("All examples ran as expected.");
} finally {
  for (const child of running) child.kill();
  await server.close();
}
