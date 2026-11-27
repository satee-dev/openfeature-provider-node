import { createHash } from "node:crypto";
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
import {
  changedKeys,
  FlagFileError,
  type FlagSet,
  flagFilePath,
  parseFlagFile,
  readBody,
  type Sha256Hex,
} from "./flag-file.ts";
import { VERSION } from "./version.ts";

const KEY_PREFIX = "satee_server_";
const BROWSER_KEY_PREFIX = "satee_client_";
const SECRET_FORMAT = /^[1-9A-HJ-NP-Za-km-z]{24}$/;
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
type Timing = {
  minPollMs: number;
  startupMs: number;
  startupRetryMs: number;
  staleAfterMs: number;
  refusedPollMs: number;
};
const DEFAULT_TIMING: Timing = {
  minPollMs: 1000,
  startupMs: 5000,
  startupRetryMs: 1000,
  staleAfterMs: 60_000,
  refusedPollMs: 60_000,
};

const REFUSED_MESSAGE = "Request refused (403). Check SATEE_SDK_KEY and the base URL.";

const consoleLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

type PollResult =
  | { kind: "loaded"; changed: string[] }
  | { kind: "unchanged" }
  | { kind: "refused"; status: 403 | 404 }
  | { kind: "failed"; reason: string; ignoredFile?: boolean };

type Episode = { kind: "error" | "stale"; message: string };

export const sha256Hex: Sha256Hex = async (text) => createHash("sha256").update(text).digest("hex");

// Never the message of other errors: fetch puts the whole URL, path id included, in some of them.
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

  readonly #url: Promise<string>;
  readonly #keyHint: string;
  readonly #logger: Logger;
  readonly #pollIntervalMs: number;
  readonly #timing: Timing;
  #closed = new AbortController();
  #held: FlagSet | undefined;
  #etag: string | null = null;
  #rejected: string | undefined;
  #timer: NodeJS.Timeout | undefined;
  #lastSuccessAt = 0;
  #refused = false;
  #episode: Episode | undefined;

  constructor(options: SateeProviderOptions) {
    const sdkKey = options?.sdkKey;
    if (typeof sdkKey === "string" && sdkKey.startsWith(BROWSER_KEY_PREFIX)) {
      throw new Error("This is a browser key. Use the server key from the Setup page.");
    }
    if (
      typeof sdkKey !== "string" ||
      !sdkKey.startsWith(KEY_PREFIX) ||
      !SECRET_FORMAT.test(sdkKey.slice(KEY_PREFIX.length))
    ) {
      throw new Error(
        `Satee SDK key is missing or is not a server key ("${KEY_PREFIX}" followed by 24 characters). Set SATEE_SDK_KEY to the key from the Setup page.`,
      );
    }
    const baseUrl = (options.baseUrl ?? "https://flags.satee.dev").replace(/\/+$/, "");
    const secret = sdkKey.slice(KEY_PREFIX.length);
    this.#url = flagFilePath(secret, sha256Hex).then((path) => `${baseUrl}${path}`);
    // The first poll reports a rejection; until then it must not reach Node as unhandled, with the key in it.
    this.#url.catch(() => {});
    this.#keyHint = `key ending ${secret.slice(-4)}`;
    this.#logger = neverThrowing(options.logger ?? consoleLogger);
    this.#timing = { ...DEFAULT_TIMING, ...(options as { [testTiming]?: Partial<Timing> })[testTiming] };
    const requested = options.pollIntervalMs;
    const interval = requested !== undefined && Number.isFinite(requested) ? requested : 5000;
    this.#pollIntervalMs = Math.min(MAX_TIMER_MS, Math.max(this.#timing.minPollMs, interval));
  }

  async initialize(): Promise<void> {
    this.#closed = new AbortController();
    const { signal } = this.#closed;
    this.#episode = undefined;
    this.#refused = false;
    const deadline = Date.now() + this.#timing.startupMs;
    let result: PollResult;
    for (;;) {
      const attemptAt = Date.now();
      result = await this.#poll(signal, Math.max(1, deadline - attemptAt));
      if (signal.aborted) return;
      const retryAt = Math.max(Date.now(), attemptAt + this.#timing.startupRetryMs);
      if (result.kind !== "failed" || retryAt >= deadline) break;
      this.#logFailedPoll(result);
      await sleep(Math.max(0, retryAt - Date.now()), undefined, { signal }).catch(() => {});
      if (signal.aborted) return;
    }
    // The SDK marks the provider ready once this resolves, so a start-up Error must come after that.
    setImmediate(() => this.#settle(result, signal, true));
  }

  async onClose(): Promise<void> {
    this.#closed.abort();
    clearTimeout(this.#timer);
  }

  // Each start owns its signal, so a poll that outlives a close cannot revive polling after a restart.
  #scheduleNextPoll(signal: AbortSignal): void {
    if (signal.aborted) return;
    const delay = this.#refused ? Math.max(this.#pollIntervalMs, this.#timing.refusedPollMs) : this.#pollIntervalMs;
    this.#timer = setTimeout(async () => {
      this.#settle(await this.#poll(signal), signal, false);
    }, delay).unref();
  }

  #settle(result: PollResult, signal: AbortSignal, atStartup: boolean): void {
    if (signal.aborted) return;
    try {
      this.#report(result, atStartup);
    } catch {
      // A throwing logger or event handler must not stop polling.
    } finally {
      this.#scheduleNextPoll(signal);
    }
  }

  #report(result: PollResult, atStartup: boolean): void {
    if (result.kind === "loaded" || result.kind === "unchanged") {
      this.#lastSuccessAt = Date.now();
      this.#refused = false;
      if (this.#episode) {
        this.#episode = undefined;
        this.#logger.info(`Satee: flags for ${this.#keyHint} are loading again`);
        this.events.emit(ProviderEvents.Ready);
      }
      if (result.kind === "loaded" && !atStartup && result.changed.length > 0) {
        this.events.emit(ProviderEvents.ConfigurationChanged, { flagsChanged: result.changed });
      }
      return;
    }
    if (result.kind === "refused") {
      this.#refused = true;
      if (result.status === 403) this.#begin("error", REFUSED_MESSAGE);
      else this.#begin("error", this.#held ? "SDK key no longer valid" : "SDK key not found. Check SATEE_SDK_KEY.");
      return;
    }
    this.#logFailedPoll(result);
    if (!this.#held) {
      if (atStartup) this.#begin("error", "Could not load flags yet", result.reason);
    } else if (Date.now() - this.#lastSuccessAt >= this.#timing.staleAfterMs) {
      this.#begin("stale", "Could not refresh flags; serving the last good values", result.reason);
    }
  }

  #logFailedPoll(result: { reason: string; ignoredFile?: boolean }): void {
    if (result.ignoredFile) this.#logger.warn(`Satee: ignored a flag file for ${this.#keyHint} (${result.reason})`);
    else this.#logger.debug(`Satee: poll failed for ${this.#keyHint} (${result.reason})`);
  }

  // An episode runs from the first failure to the next successful poll. A problem is not reported again while it
  // persists, and Stale never replaces an Error.
  #begin(kind: Episode["kind"], message: string, reason?: string): void {
    const current = this.#episode;
    if (current && (kind === "stale" || current.message === message)) return;
    this.#episode = { kind, message };
    const line = `Satee: ${message} (${this.#keyHint}${reason ? `, ${reason}` : ""})`;
    if (kind === "error") {
      this.#logger.error(line);
      this.events.emit(ProviderEvents.Error, { message });
    } else {
      this.#logger.warn(line);
      this.events.emit(ProviderEvents.Stale, { message });
    }
  }

  async #poll(signal: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): Promise<PollResult> {
    const headers: Record<string, string> = { "User-Agent": `satee-openfeature-node/${VERSION}` };
    if (this.#etag !== null) headers["If-None-Match"] = this.#etag;
    let etag: string | null = null;
    try {
      const response = await fetch(await this.#url, {
        headers,
        signal: AbortSignal.any([AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, timeoutMs)), signal]),
      });
      etag = response.headers.get("etag");
      if (response.status === 304 || (response.status === 200 && etag !== null && etag === this.#etag)) {
        await response.body?.cancel();
        return { kind: "unchanged" };
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        if (response.status === 403 || response.status === 404) return { kind: "refused", status: response.status };
        return { kind: "failed", reason: `HTTP ${response.status}` };
      }
      const next = parseFlagFile(await readBody(response), this.#held?.revision, this.#logger);
      if (signal.aborted) return { kind: "failed", reason: "closed" };
      const changed = changedKeys(this.#held?.flags ?? {}, next.flags);
      this.#held = next;
      this.#etag = etag;
      this.#rejected = undefined;
      return { kind: "loaded", changed };
    } catch (error) {
      const reason = describeFailure(error);
      const ignoredFile = error instanceof FlagFileError && this.#rejected !== (etag ?? reason);
      if (ignoredFile) this.#rejected = etag ?? reason;
      return { kind: "failed", reason, ignoredFile };
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

// A logger that throws must not cost the event that follows its line, so each call is contained.
function neverThrowing(logger: Logger): Logger {
  const contain =
    (write: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      try {
        write.apply(logger, args);
      } catch {}
    };
  return {
    debug: contain(logger.debug),
    info: contain(logger.info),
    warn: contain(logger.warn),
    error: contain(logger.error),
  };
}
