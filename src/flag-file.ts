import { isDeepStrictEqual } from "node:util";
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

export async function readBody(response: Response): Promise<string> {
  if (Number(response.headers.get("content-length")) > MAX_BODY_BYTES) {
    await response.body?.cancel();
    throw new FlagFileError("file is larger than 4 MiB");
  }
  if (!response.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) throw new FlagFileError("file is larger than 4 MiB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasTargeting = (flag: unknown) =>
  isObject(flag) && Object.hasOwn(flag, "targeting") && !isDeepStrictEqual(flag.targeting, {});

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
  evaluator.setConfigurations(JSON.stringify({ flags: flagsOnly, metadata: file.metadata }));
  return { revision, flags: flagsOnly as Record<string, Flag>, evaluator };
}

export function changedKeys(before: FlagSet["flags"], after: FlagSet["flags"]): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => {
    const was = Object.hasOwn(before, key) ? before[key] : undefined;
    const now = Object.hasOwn(after, key) ? after[key] : undefined;
    return !isDeepStrictEqual(was, now);
  });
}
