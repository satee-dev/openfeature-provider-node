import { isDeepStrictEqual } from "node:util";
import { FlagdCore } from "@openfeature/flagd-core";
import type { Logger } from "@openfeature/server-sdk";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

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

const FLAG_FIELDS = ["state", "variants", "defaultVariant", "metadata"];

export function parseFlagFile(body: string, logger: Logger): FlagdCore {
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
  const flags = new FlagdCore(undefined, {
    debug: () => {},
    info: () => {},
    warn: (...args) => logger.warn("Satee: flagd:", ...args),
    error: (...args) => logger.error("Satee: flagd:", ...args),
  });
  flags.setConfigurations(JSON.stringify({ flags: flagsOnly, metadata: file.metadata }));
  return flags;
}
