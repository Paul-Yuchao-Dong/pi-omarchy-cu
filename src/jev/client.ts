/**
 * In-process TypeSafe Jev System One client (ADR-0001).
 *
 * Uses `@typesafe-ai/sdk` directly: a Pi tool cannot synchronously invoke
 * another extension's `jev_evaluate` tool, and structured object
 * `instructions`/`criteria` are first-class in the SDK.
 */

import { TypeSafeClient, choice, noul, score } from "@typesafe-ai/sdk";
import type {
  DecisionAnswer,
  DecisionClient,
  DecisionRequest,
  DecisionResponse,
  JevConfigSummary,
  QuestionSpec,
} from "../types.js";
import { resolveJevConfig, type JevConfig, type ResolveJevConfigOptions } from "./config.js";

/** Statuses that are worth retrying, per the spec. */
const RETRYABLE_STATUS = new Set([429, 503, 529]);
const RETRY_DELAYS_MS = [500, 1000];

export interface SdkDecisionClientOptions extends ResolveJevConfigOptions {
  /** Override retry backoff, for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable SDK factory, for tests. */
  createClient?: (config: JevConfig) => { systemOne: (request: any, options?: any) => Promise<any> };
}

export function errorStatus(error: unknown): number | undefined {
  const err = error as any;
  const candidates = [err?.status, err?.statusCode, err?.response?.status, err?.cause?.status];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  const message = String(err?.message ?? "");
  const match = message.match(/\b(429|503|529)\b/);
  return match ? Number(match[1]) : undefined;
}

export class SdkDecisionClient implements DecisionClient {
  private readonly options: SdkDecisionClientOptions;
  private config: JevConfig;
  private sdkClient: { systemOne: (request: any, options?: any) => Promise<any> } | null = null;
  /** Set when the caller passed an explicit model. */
  private explicitModel: string | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: SdkDecisionClientOptions = {}) {
    this.options = options;
    this.explicitModel = options.model;
    this.config = resolveJevConfig(options);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  isConfigured(): boolean {
    return this.config.configured;
  }

  describe(): JevConfigSummary {
    return {
      configured: this.config.configured,
      baseURL: this.config.baseURL,
      model: this.config.model,
      keyOrigin: this.config.keyOrigin,
      openrouter: this.config.openrouter,
      problem: this.config.problem,
    };
  }

  /** Re-resolve configuration (used by `/cu status` after the environment changes). */
  refresh(): JevConfigSummary {
    this.config = resolveJevConfig(this.options);
    this.sdkClient = null;
    return this.describe();
  }

  private client(): { systemOne: (request: any, options?: any) => Promise<any> } {
    if (this.sdkClient) return this.sdkClient;
    if (this.config.problem || !this.config.baseURL) {
      throw new Error(this.config.problem ?? "Jev is not configured.");
    }
    if (this.options.createClient) {
      this.sdkClient = this.options.createClient(this.config);
      return this.sdkClient;
    }
    this.sdkClient = new TypeSafeClient({
      apiKey: this.config.apiKey ?? "",
      baseURL: this.config.baseURL,
      defaultModel: this.config.model,
    }) as unknown as { systemOne: (request: any, options?: any) => Promise<any> };
    return this.sdkClient;
  }

  private formatQuestions(questions: Record<string, QuestionSpec>): Record<string, unknown> {
    const formatted: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(questions)) {
      if (question.type === "choice") {
        formatted[id] = choice(question.instructions as any, question.criteria as any);
      } else if (question.type === "noul") {
        formatted[id] = noul(question.instructions as any);
      } else {
        formatted[id] = score(question.instructions as any, question.criteria as any);
      }
    }
    return formatted;
  }

  private normalizeAnswer(type: QuestionSpec["type"], raw: any): DecisionAnswer {
    if (type === "choice") {
      const value = raw?.choice ?? raw?.value ?? "";
      return {
        type,
        value,
        confidence: raw?.confidence,
        // The SDK reports per-label probabilities as `probabilities`; older
        // transports used `distribution`.
        distribution: raw?.probabilities ?? raw?.distribution,
        raw,
      };
    }
    if (type === "noul") {
      const value = raw?.noul ?? raw?.probability ?? raw?.value ?? 0;
      return { type, value, raw };
    }
    const value = raw?.score ?? raw?.value ?? 0;
    return { type, value, confidence: raw?.confidence, raw };
  }

  async evaluate(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse> {
    const started = Date.now();
    const client = this.client();
    const questions = this.formatQuestions(request.questions);
    const model = request.model?.trim() || this.explicitModel || this.config.model;

    let attempt = 0;
    for (;;) {
      if (signal?.aborted) throw abortError();
      try {
        const response: any = await client.systemOne(
          { state: request.state, questions, model },
          { signal },
        );
        const answers: Record<string, DecisionAnswer> = {};
        for (const [id, raw] of Object.entries(response?.answers ?? {})) {
          const spec = request.questions[id];
          if (!spec) continue;
          answers[id] = this.normalizeAnswer(spec.type, raw);
        }
        return {
          answers,
          model: response?.model || model,
          usage: response?.usage,
          elapsedMs: Date.now() - started,
        };
      } catch (error) {
        const status = errorStatus(error);
        const retryable = status !== undefined && RETRYABLE_STATUS.has(status);
        if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw error;
        await this.sleep(RETRY_DELAYS_MS[attempt]);
        attempt += 1;
      }
    }
  }
}

function abortError(): Error {
  const error = new Error("Jev request aborted");
  error.name = "AbortError";
  return error;
}
