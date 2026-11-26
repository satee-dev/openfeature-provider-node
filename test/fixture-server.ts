import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export const FIXTURE_SDK_KEY = "satee_sdk_fixture0001";
const FIXTURE_PATH_KEY = FIXTURE_SDK_KEY.slice("satee_sdk_".length);

export const exampleFlags = readFileSync(new URL("./fixtures/flags.example.json", import.meta.url), "utf8");

type FlagFile = {
  metadata: Record<string, unknown>;
  flags: Record<string, { state: string; variants: Record<string, unknown>; defaultVariant: string }>;
};

function editExample(edit: (file: FlagFile) => void): string {
  const file = JSON.parse(exampleFlags) as FlagFile;
  edit(file);
  return JSON.stringify(file, null, 2);
}

export const payloads = {
  brokenJson: exampleFlags.slice(0, exampleFlags.length / 2),
  flagWithoutVariant: editExample((file) => {
    file.flags["beta-banner"] = { state: "ENABLED", variants: { on: true }, defaultVariant: "off" };
  }),
  withoutRevision: editExample((file) => {
    delete file.metadata.revision;
  }),
  lowerRevision: editExample((file) => {
    file.metadata.revision = 41;
  }),
  revision: (revision: number, edit: (file: FlagFile) => void = () => {}) =>
    editExample((file) => {
      file.metadata.revision = revision;
      edit(file);
    }),
};

export type RecordedRequest = { url: string; headers: IncomingHttpHeaders };

type Behavior = { kind: "serve" } | { kind: "status"; status: number } | { kind: "slow"; delayMs: number };

export type FixtureServer = {
  readonly baseUrl: string;
  readonly requests: RecordedRequest[];
  serve(body: string): void;
  respondWith(status: 404 | 403 | 429 | 500): void;
  respondSlowly(delayMs: number): void;
  close(): Promise<void>;
};

function etagOf(body: string): string {
  return `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;
}

export async function startFixtureServer(initialBody: string = exampleFlags): Promise<FixtureServer> {
  let current = { body: initialBody, etag: etagOf(initialBody) };
  let behavior: Behavior = { kind: "serve" };
  const requests: RecordedRequest[] = [];
  const pending = new Set<NodeJS.Timeout>();

  const server = createServer((req, res) => {
    requests.push({ url: req.url ?? "", headers: req.headers });
    const match = /^\/([^/?]+)\/flags\.json$/.exec(req.url ?? "");
    if (!match) {
      res.writeHead(403).end();
      return;
    }
    if (match[1] !== FIXTURE_PATH_KEY) {
      res.writeHead(404).end();
      return;
    }
    if (behavior.kind === "status") {
      res.writeHead(behavior.status).end();
      return;
    }
    const { body, etag } = current;
    const send = () => {
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { ETag: etag }).end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json", ETag: etag }).end(body);
      }
    };
    if (behavior.kind === "slow") {
      const timer = setTimeout(() => {
        pending.delete(timer);
        send();
      }, behavior.delayMs);
      pending.add(timer);
    } else {
      send();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    serve(body) {
      current = { body, etag: etagOf(body) };
      behavior = { kind: "serve" };
    },
    respondWith(status) {
      behavior = { kind: "status", status };
    },
    respondSlowly(delayMs) {
      behavior = { kind: "slow", delayMs };
    },
    async close() {
      for (const timer of pending) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
