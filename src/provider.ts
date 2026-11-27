import { setTimeout as sleep } from "node:timers/promises";
import {
  ErrorCode,
  type EvaluationContext,
  type JsonValue,
  type Logger,
  OpenFeatureEventEmitter,
  type Provider,
  ProviderEvents,
  type ResolutionDetails,
  StandardResolutionReasons,
} from "@openfeature/server-sdk";
import { changedKeys, FlagFileError, type FlagSet, parseFlagFile, readBody } from "./flag-file.ts";
import { VERSION } from "./version.ts";

const KEY_PREFIX = "satee_sdk_";
const REQUEST_TIMEOUT_MS = 5000;
const MAX_TIMER_MS = 2 ** 31 - 1;

export type SateeProviderOptions = {
  sdkKey: string | undefined;
  pollIntervalMs?: number;
  baseUrl?: string;
  logger?: Logger;
};

/** Lets tests shorten the waits that the public options do not expose. */
export const testTiming: unique symbol = Symbol("satee.testTiming");
type Timing = { minPollMs: number; startupMs: number; startupRetryMs: number };
const DEFAULT_TIMING: Timing = { minPollMs: 1000, startupMs: 5000, startupRetryMs: 1000 };

const consoleLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

type PollResult = { ok: true; changed: string[] } | { ok: false; reason: string };

function describeFailure(error: unknown): string {
  if (error instanceof FlagFileError) return error.message;
  if (!(error instanceof Error)) return "unknown error";
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? `${error.name}: ${code}` : error.name;
}

export class SateeProvider implements Provider {
  readonly metadata = { name: "Satee" } as const;
  readonly runsOn = "server";
  readonly events = new OpenFeatureEventEmitter();

  readonly #url: string;
  readonly #keyHint: string;
  readonly #logger: Logger;
  readonly #pollIntervalMs: number;
  readonly #timing: Timing;
  #closed = new AbortController();
  #held: FlagSet | undefined;
  #etag: string | null = null;
  #timer: NodeJS.Timeout | undefined;

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
    this.#timing = { ...DEFAULT_TIMING, ...(options as { [testTiming]?: Partial<Timing> })[testTiming] };
    const requested = options.pollIntervalMs;
    const interval = requested !== undefined && Number.isFinite(requested) ? requested : 5000;
    this.#pollIntervalMs = Math.min(MAX_TIMER_MS, Math.max(this.#timing.minPollMs, interval));
  }

  async initialize(): Promise<void> {
    this.#closed = new AbortController();
    const { signal } = this.#closed;
    const deadline = Date.now() + this.#timing.startupMs;
    let result: PollResult;
    for (;;) {
      const attemptAt = Date.now();
      result = await this.#poll(signal, Math.max(1, deadline - attemptAt));
      if (signal.aborted) return;
      const retryAt = Math.max(Date.now(), attemptAt + this.#timing.startupRetryMs);
      if (result.ok || retryAt >= deadline) break;
      await sleep(Math.max(0, retryAt - Date.now()), undefined, { signal }).catch(() => {});
      if (signal.aborted) return;
    }
    if (!result.ok) {
      this.#logger.warn(`Satee: could not load flags for ${this.#keyHint} (${result.reason})`);
    }
    this.#scheduleNextPoll(signal);
  }

  async onClose(): Promise<void> {
    this.#closed.abort();
    clearTimeout(this.#timer);
  }

  // Each start owns its signal, so a poll that outlives a close cannot revive polling after a restart.
  #scheduleNextPoll(signal: AbortSignal): void {
    if (signal.aborted) return;
    this.#timer = setTimeout(async () => {
      try {
        const result = await this.#poll(signal);
        if (signal.aborted) return;
        if (result.ok && result.changed.length > 0) {
          this.events.emit(ProviderEvents.ConfigurationChanged, { flagsChanged: result.changed });
        }
        if (!result.ok) this.#logger.debug(`Satee: poll failed for ${this.#keyHint} (${result.reason})`);
      } catch {
        // A throwing logger must not stop polling.
      } finally {
        this.#scheduleNextPoll(signal);
      }
    }, this.#pollIntervalMs).unref();
  }

  async #poll(signal: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): Promise<PollResult> {
    const headers: Record<string, string> = { "User-Agent": `satee-openfeature-node/${VERSION}` };
    if (this.#etag !== null) headers["If-None-Match"] = this.#etag;
    try {
      const response = await fetch(this.#url, {
        headers,
        signal: AbortSignal.any([AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, timeoutMs)), signal]),
      });
      const etag = response.headers.get("etag");
      if (response.status === 304 || (response.status === 200 && etag !== null && etag === this.#etag)) {
        await response.body?.cancel();
        return { ok: true, changed: [] };
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        return { ok: false, reason: `HTTP ${response.status}` };
      }
      const next = parseFlagFile(await readBody(response), this.#held?.revision, this.#logger);
      if (signal.aborted) return { ok: false, reason: "closed" };
      const changed = changedKeys(this.#held?.flags ?? {}, next.flags);
      this.#held = next;
      this.#etag = etag;
      return { ok: true, changed };
    } catch (error) {
      return { ok: false, reason: describeFailure(error) };
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

  async #resolve<T>(evaluate: (flags: FlagSet["evaluator"]) => ResolutionDetails<T>, defaultValue: T) {
    const held = this.#held;
    if (!held) {
      return {
        value: defaultValue,
        reason: StandardResolutionReasons.ERROR,
        errorCode: ErrorCode.PROVIDER_NOT_READY,
        errorMessage: "Satee flags are not loaded yet",
      };
    }
    return evaluate(held.evaluator);
  }
}
