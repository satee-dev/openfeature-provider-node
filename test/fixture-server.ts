import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export const FIXTURE_SDK_KEY = "satee_server_Fx7Tz3Qm9Kw2Rb5Nc8Hd4Pj6";
export const FIXTURE_PATH_ID = "e87ce875c863429f8b36180a6e0c3ab3";
export const FIXTURE_PATH = `/v1/${FIXTURE_PATH_ID}/flags.json`;

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
    file.flags["beta-banner"] = { state: "ENABLED", variants: { on: true, off: false }, defaultVariant: "on" };
  }),
  lowerRevision: editExample((file) => {
    file.metadata.revision = 41;
    file.flags["beta-banner"] = { state: "ENABLED", variants: { on: true, off: false }, defaultVariant: "on" };
  }),
  revision: (revision: number, edit: (file: FlagFile) => void = () => {}) =>
    editExample((file) => {
      file.metadata.revision = revision;
      edit(file);
    }),
};

export type RecordedRequest = { url: string; headers: IncomingHttpHeaders; abandoned: boolean };

type Behavior = { kind: "serve" } | { kind: "status"; status: number } | { kind: "slow"; delayMs: number };

export type FixtureServer = {
  readonly baseUrl: string;
  readonly requests: RecordedRequest[];
  /** `etag` replaces the computed one; `ignoreIfNoneMatch` answers 200 even when it matches. */
  serve(body: string, options?: { etag?: string; ignoreIfNoneMatch?: boolean }): void;
  respondWith(status: 404 | 403 | 429 | 500): void;
  respondSlowly(delayMs: number): void;
  close(): Promise<void>;
};

function etagOf(body: string): string {
  return `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;
}

export async function startFixtureServer(
  initialBody: string = exampleFlags,
  { port: requestedPort = 0 }: { port?: number } = {},
): Promise<FixtureServer> {
  let current = { body: initialBody, etag: etagOf(initialBody), ignoreIfNoneMatch: false };
  let behavior: Behavior = { kind: "serve" };
  const requests: RecordedRequest[] = [];
  const pending = new Set<NodeJS.Timeout>();

  const server = createServer((req, res) => {
    const recorded = { url: req.url ?? "", headers: req.headers, abandoned: false };
    requests.push(recorded);
    res.on("close", () => {
      recorded.abandoned = !res.writableFinished;
    });
    if (!/^\/v1\/[0-9a-f]{32}\/flags\.json$/.test(req.url ?? "")) {
      res.writeHead(403).end();
      return;
    }
    if (req.url !== FIXTURE_PATH) {
      res.writeHead(404).end();
      return;
    }
    if (behavior.kind === "status") {
      res.writeHead(behavior.status).end();
      return;
    }
    const { body, etag, ignoreIfNoneMatch } = current;
    const send = () => {
      if (!ignoreIfNoneMatch && req.headers["if-none-match"] === etag) {
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

  await new Promise<void>((resolve) => server.listen(requestedPort, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    serve(body, { etag = etagOf(body), ignoreIfNoneMatch = false } = {}) {
      current = { body, etag, ignoreIfNoneMatch };
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
