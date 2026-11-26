import type { FlagdCore } from "@openfeature/flagd-core";
import {
  ErrorCode,
  type EvaluationContext,
  type JsonValue,
  type Logger,
  type Provider,
  type ResolutionDetails,
  StandardResolutionReasons,
} from "@openfeature/server-sdk";
import { FlagFileError, parseFlagFile, readBody } from "./flag-file.ts";
import { VERSION } from "./version.ts";

const KEY_PREFIX = "satee_sdk_";
const REQUEST_TIMEOUT_MS = 5000;

export type SateeProviderOptions = {
  sdkKey: string | undefined;
  pollIntervalMs?: number;
  baseUrl?: string;
  logger?: Logger;
};

const consoleLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

function describeFailure(error: unknown): string {
  if (error instanceof FlagFileError) return error.message;
  if (!(error instanceof Error)) return "unknown error";
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? `${error.name}: ${code}` : error.name;
}

export class SateeProvider implements Provider {
  readonly metadata = { name: "Satee" } as const;
  readonly runsOn = "server";

  readonly #url: string;
  readonly #keyHint: string;
  readonly #logger: Logger;
  #flags: FlagdCore | undefined;

  constructor(options: SateeProviderOptions) {
    const { sdkKey } = options;
    if (!sdkKey?.startsWith(KEY_PREFIX) || sdkKey.length === KEY_PREFIX.length) {
      throw new Error(
        `Satee SDK key is missing or does not start with "${KEY_PREFIX}". Set SATEE_SDK_KEY to the key from the Setup page.`,
      );
    }
    const baseUrl = (options.baseUrl ?? "https://flags.satee.dev").replace(/\/+$/, "");
    const secret = sdkKey.slice(KEY_PREFIX.length);
    this.#url = `${baseUrl}/${encodeURIComponent(secret)}/flags.json`;
    this.#keyHint = secret.length > 8 ? `key ending ${secret.slice(-4)}` : "key";
    this.#logger = options.logger ?? consoleLogger;
  }

  async initialize(): Promise<void> {
    try {
      const response = await fetch(this.#url, {
        headers: { "User-Agent": `satee-openfeature-node/${VERSION}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        this.#logger.warn(`Satee: could not load flags for ${this.#keyHint} (HTTP ${response.status})`);
        return;
      }
      this.#flags = parseFlagFile(await readBody(response), this.#logger);
    } catch (error) {
      this.#logger.warn(`Satee: could not load flags for ${this.#keyHint} (${describeFailure(error)})`);
    }
  }

  resolveBooleanEvaluation(key: string, defaultValue: boolean, context: EvaluationContext, logger: Logger) {
    return this.#resolve((flags) => flags.resolveBooleanEvaluation(key, defaultValue, context, logger), defaultValue);
  }

  resolveStringEvaluation(key: string, defaultValue: string, context: EvaluationContext, logger: Logger) {
    return this.#resolve((flags) => flags.resolveStringEvaluation(key, defaultValue, context, logger), defaultValue);
  }

  resolveNumberEvaluation(key: string, defaultValue: number, context: EvaluationContext, logger: Logger) {
    return this.#resolve((flags) => flags.resolveNumberEvaluation(key, defaultValue, context, logger), defaultValue);
  }

  resolveObjectEvaluation<T extends JsonValue>(
    key: string,
    defaultValue: T,
    context: EvaluationContext,
    logger: Logger,
  ) {
    return this.#resolve((flags) => flags.resolveObjectEvaluation(key, defaultValue, context, logger), defaultValue);
  }

  async #resolve<T>(evaluate: (flags: FlagdCore) => ResolutionDetails<T>, defaultValue: T) {
    const flags = this.#flags;
    if (!flags) {
      return {
        value: defaultValue,
        reason: StandardResolutionReasons.ERROR,
        errorCode: ErrorCode.PROVIDER_NOT_READY,
        errorMessage: "Satee flags are not loaded yet",
      };
    }
    return evaluate(flags);
  }
}
