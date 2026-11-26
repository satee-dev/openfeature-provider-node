import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { exampleFlags, type FixtureServer, payloads, startFixtureServer } from "./fixture-server.ts";

const path = "/fixture0001/flags.json";

describe("fixture server", () => {
  let server: FixtureServer;
  before(async () => {
    server = await startFixtureServer();
  });
  beforeEach(() => server.serve(exampleFlags));
  after(() => server.close());

  const get = (url: string, headers: Record<string, string> = {}) => fetch(server.baseUrl + url, { headers });

  it("serves the shared fixture with a strong ETag", async () => {
    const res = await get(path);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("etag") ?? "", /^"[0-9a-f]+"$/);
    assert.equal(await res.text(), exampleFlags);
  });

  it("answers a matching If-None-Match with 304", async () => {
    const etag = (await get(path)).headers.get("etag") ?? "";
    assert.equal((await get(path, { "If-None-Match": etag })).status, 304);
  });

  it("sends a new ETag when the body changes", async () => {
    const before = (await get(path)).headers.get("etag");
    server.serve(payloads.revision(43));
    assert.notEqual((await get(path)).headers.get("etag"), before);
  });

  it("refuses a query string or another path shape with 403", async () => {
    assert.equal((await get(`${path}?x=1`)).status, 403);
    assert.equal((await get("/fixture0001/other.json")).status, 403);
  });

  it("answers an unknown key with 404", async () => {
    assert.equal((await get("/unknown/flags.json")).status, 404);
  });

  it("returns the status it is told to", async () => {
    for (const status of [404, 403, 429, 500] as const) {
      server.respondWith(status);
      assert.equal((await get(path)).status, status);
    }
  });

  it("delays the response when told to", async () => {
    server.respondSlowly(200);
    const started = Date.now();
    await get(path);
    assert.ok(Date.now() - started >= 190);
  });

  it("records each request with its headers", async () => {
    const seen = server.requests.length;
    await get(path, { "User-Agent": "probe" });
    assert.equal(server.requests.length, seen + 1);
    assert.equal(server.requests.at(-1)?.headers["user-agent"], "probe");
  });
});
