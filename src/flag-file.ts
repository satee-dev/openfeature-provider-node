import { FlagdCore } from "@openfeature/flagd-core";
import type { Logger } from "@openfeature/server-sdk";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

type Flag = { state?: unknown; variants: Record<string, unknown>; defaultVariant: string; metadata?: unknown };

export type FlagSet = {
  readonly revision: number;
  readonly flags: Readonly<Record<string, Flag>>;
  readonly evaluator: FlagdCore;
};

export class FlagFileError extends Error {
  override name = "FlagFileError";
}

export type Sha256Hex = (text: string) => Promise<string>;

// The URL carries a hash rather than the key, so the key stays out of access logs and bucket listings.
export async function flagFilePath(secret: string, sha256Hex: Sha256Hex): Promise<string> {
  const hash = await sha256Hex(`satee-flags-v1:${secret}`);
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new FlagFileError("hash is not SHA-256 hex");
  const pathId = hash.slice(0, 32);
  return `/v1/${pathId}/flags.json`;
}

export async function readBody(response: Response): Promise<string> {
  if (Number(response.headers.get("content-length")) > MAX_BODY_BYTES) {
    await response.body?.cancel();
    throw new FlagFileError("file is larger than 4 MiB");
  }
  if (!response.body) return "";
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let text = "";
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new FlagFileError("file is larger than 4 MiB");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Compares values as JSON.parse produces them, so key order does not matter.
function jsonEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (!isObject(a) || !isObject(b)) return Object.is(a, b);
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
}

const hasTargeting = (flag: unknown) =>
  isObject(flag) && Object.hasOwn(flag, "targeting") && !jsonEqual(flag.targeting, {});

const isFlag = (flag: unknown): flag is Flag =>
  isObject(flag) &&
  isObject(flag.variants) &&
  typeof flag.defaultVariant === "string" &&
  Object.hasOwn(flag.variants, flag.defaultVariant);

const FLAG_FIELDS = ["state", "variants", "defaultVariant", "metadata"];

export function parseFlagFile(body: string, heldRevision: number | undefined, logger: Logger): FlagSet {
  let file: unknown;
  try {
    file = JSON.parse(body);
  } catch {
    throw new FlagFileError("file is not valid JSON");
  }
  if (!isObject(file) || !isObject(file.flags) || "$evaluators" in file) {
    throw new FlagFileError("file is not a Satee flag file");
  }
  if (Object.values(file.flags).some(hasTargeting)) throw new FlagFileError("file carries targeting rules");
  // Targeting is JSON Logic that flagd-core runs on the event loop, where a few hundred bytes can
  // block it for minutes. flagd-core reads keys this check cannot see (inherited through a flag's
  // "__proto__"), so it gets a body holding only the fields copied here.
  const flagsOnly = Object.fromEntries(
    Object.entries(file.flags).map(([key, flag]) => [
      key,
      isObject(flag)
        ? Object.fromEntries(FLAG_FIELDS.filter((f) => Object.hasOwn(flag, f)).map((f) => [f, flag[f]]))
        : flag,
    ]),
  );
  const invalid = Object.keys(flagsOnly).find((key) => !isFlag(flagsOnly[key]));
  if (invalid !== undefined)
    throw new FlagFileError(`flag "${invalid}" needs variants and a defaultVariant among them`);
  const revision = isObject(file.metadata) ? file.metadata.revision : undefined;
  if (typeof revision !== "number" || !Number.isInteger(revision)) {
    throw new FlagFileError("file has no integer metadata.revision");
  }
  if (heldRevision !== undefined && revision < heldRevision) {
    throw new FlagFileError(`revision ${revision} is older than the held revision ${heldRevision}`);
  }
  const evaluator = new FlagdCore(undefined, {
    debug: () => {},
    info: () => {},
    warn: (...args) => logger.warn("Satee: flagd:", ...args),
    error: (...args) => logger.error("Satee: flagd:", ...args),
  });
  try {
    evaluator.setConfigurations(JSON.stringify({ flags: flagsOnly, metadata: file.metadata }));
  } catch {
    throw new FlagFileError("file is not a valid flagd configuration");
  }
  return { revision, flags: flagsOnly as Record<string, Flag>, evaluator };
}

export function changedKeys(before: FlagSet["flags"], after: FlagSet["flags"]): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => {
    const was = Object.hasOwn(before, key) ? before[key] : undefined;
    const now = Object.hasOwn(after, key) ? after[key] : undefined;
    return !jsonEqual(was, now);
  });
}
