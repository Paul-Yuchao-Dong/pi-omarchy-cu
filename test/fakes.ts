/**
 * Test fakes for the two injectable boundaries plus a fake Pi tool context.
 *
 * Every tool test goes through the real tool definitions, so these fakes are
 * the only stand-ins for the outside world.
 */

import type {
  AdEnvelope,
  BinaryResolution,
  CliRunOptions,
  CliRunResult,
  CliRunner,
  CuContext,
  CuDeps,
  DecisionAnswer,
  DecisionClient,
  DecisionRequest,
  DecisionResponse,
  JevConfigSummary,
  QuestionSpec,
  StateRootInfo,
} from "../src/types.js";
import { SdkDecisionClient } from "../src/jev/client.js";

export function okEnvelope<T>(command: string, data: T): AdEnvelope<T> {
  return { version: "2.5", ok: true, command, data };
}

export function errEnvelope(
  command: string,
  code: string,
  message = code,
  details?: Record<string, unknown>,
): AdEnvelope {
  return {
    version: "2.5",
    ok: false,
    command,
    error: {
      code,
      message,
      suggestion: undefined,
      details,
      disposition: { delivery: "not_delivered", retry: "safe" },
    },
  };
}

export type CliHandler = (args: string[], options?: CliRunOptions) => AdEnvelope | Promise<AdEnvelope>;

export interface RecordedCommand {
  args: string[];
  options?: CliRunOptions;
}

export class FakeCliRunner implements CliRunner {
  readonly calls: RecordedCommand[] = [];
  ensures = 0;
  binary: BinaryResolution | null = { binary: "/fake/agent-desktop", source: "env" };
  root: string;
  private handler: CliHandler;

  constructor(handler?: CliHandler, root = "/tmp/cu-fake-agent-desktop") {
    this.handler = handler ?? ((args) => okEnvelope(args[0] ?? "unknown", {}));
    this.root = root;
  }

  /** Replace the canned behavior mid-test (e.g. after the first turn). */
  respond(handler: CliHandler): void {
    this.handler = handler;
  }

  /** Convenience: answer by command name. */
  respondByCommand(handlers: Record<string, CliHandler>): void {
    this.handler = (args, options) => {
      const handler = handlers[args[0] ?? ""];
      if (!handler) return okEnvelope(args[0] ?? "unknown", {});
      return handler(args, options);
    };
  }

  resolve(): BinaryResolution | null {
    return this.binary;
  }

  stateRoot(): string {
    return this.root;
  }

  async ensureStateRoot(): Promise<StateRootInfo> {
    this.ensures += 1;
    return { path: this.root, mode: 0o700, created: false };
  }

  async run(args: string[], options: CliRunOptions = {}): Promise<CliRunResult> {
    this.calls.push({ args, options });
    const envelope = await this.handler(args, options);
    return {
      envelope,
      stdout: JSON.stringify(envelope),
      stderr: "",
      exitCode: envelope.ok ? 0 : 1,
      durationMs: 1,
      binary: this.binary?.binary ?? "",
      args,
      timedOut: false,
      aborted: Boolean(options.signal?.aborted),
    };
  }

  /** Every invocation of one command, oldest first. */
  invocations(command: string): RecordedCommand[] {
    return this.calls.filter((call) => call.args[0] === command);
  }

  /** Argument lists of one command, flattened for easy assertions. */
  argLists(command: string): string[][] {
    return this.invocations(command).map((call) => call.args);
  }

  reset(): void {
    this.calls.length = 0;
  }
}

export type DecisionHandler = (
  request: DecisionRequest,
  signal?: AbortSignal,
) => DecisionResponse | Promise<DecisionResponse>;

export function choiceAnswer(
  value: string,
  confidence: number,
  distribution?: Record<string, number>,
): DecisionAnswer {
  return {
    type: "choice",
    value,
    confidence,
    distribution: distribution ?? { [value]: confidence },
  };
}

export function noulAnswer(value: number): DecisionAnswer {
  return { type: "noul", value };
}

export function decision(
  answers: Record<string, DecisionAnswer>,
  options: { usage?: { input_tokens?: number; output_tokens?: number } } = {},
): DecisionResponse {
  return {
    answers,
    model: "fake-jev",
    usage: options.usage ?? { input_tokens: 10, output_tokens: 2 },
    elapsedMs: 1,
  };
}

export class FakeDecisionClient implements DecisionClient {
  readonly requests: DecisionRequest[] = [];
  private handler: DecisionHandler;
  configured: boolean;
  summary: JevConfigSummary;

  constructor(handler?: DecisionHandler, options: { configured?: boolean } = {}) {
    this.handler =
      handler ??
      (() =>
        decision({
          target: choiceAnswer("none", 0.1),
        }));
    this.configured = options.configured ?? true;
    this.summary = {
      configured: this.configured,
      baseURL: "https://api.typesafe.ai/v1/systemone",
      model: "jev-latest",
      keyOrigin: "$TYPESAFE_API_KEY",
      openrouter: false,
      problem: this.configured ? null : "No Jev API key found",
    };
  }

  isConfigured(): boolean {
    return this.configured;
  }

  describe(): JevConfigSummary {
    return this.summary;
  }

  respond(handler: DecisionHandler): void {
    this.handler = handler;
  }

  /** Queue one response per call, in order. Falls back to the last response. */
  queue(...responses: Array<DecisionResponse | DecisionHandler>): void {
    const handlers = responses.map((response) =>
      typeof response === "function" ? response : () => response,
    );
    let index = 0;
    this.handler = (request, signal) => {
      const handler = handlers[Math.min(index, handlers.length - 1)];
      index += 1;
      return handler(request, signal);
    };
  }

  async evaluate(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse> {
    this.requests.push(request);
    return this.handler(request, signal);
  }
}

export interface FakeUi {
  confirms: Array<{ title: string; message: string }>;
  notifications: Array<{ message: string; type?: string }>;
  confirm: (title: string, message: string) => Promise<boolean>;
  notify: (message: string, type?: "info" | "warning" | "error") => void;
  setStatus: () => void;
}

export interface FakeContext extends CuContext {
  hasUI: boolean;
  ui: FakeUi;
  signal?: AbortSignal;
}

export function makeContext(
  options: {
    hasUI?: boolean;
    confirm?: boolean | ((title: string, message: string) => boolean | Promise<boolean>);
    signal?: AbortSignal;
  } = {},
): FakeContext {
  const confirms: Array<{ title: string; message: string }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const confirmOption = options.confirm ?? true;
  const ui: FakeUi = {
    confirms,
    notifications,
    async confirm(title, message) {
      confirms.push({ title, message });
      return typeof confirmOption === "function" ? await confirmOption(title, message) : confirmOption;
    },
    notify(message, type) {
      notifications.push({ message, type });
    },
    setStatus() {},
  };
  return {
    hasUI: options.hasUI ?? true,
    ui,
    signal: options.signal,
  };
}

export interface FakeDeps extends CuDeps {
  runner: FakeCliRunner;
  decision: FakeDecisionClient;
}

export function makeDeps(options: {
  cli?: FakeCliRunner;
  decision?: FakeDecisionClient;
  env?: NodeJS.ProcessEnv;
  processes?: Array<{ pid: number; command: string }>;
} = {}): FakeDeps {
  return {
    runner: options.cli ?? new FakeCliRunner(),
    decision: options.decision ?? new FakeDecisionClient(),
    env: options.env ?? {},
    homedir: "/home/fake",
    listProcesses: async () => options.processes ?? [],
    now: () => 1_700_000_000_000,
  };
}

/** A `DecisionClient` whose questions are answered from a per-question map. */
export function answeringDecision(
  answers: Record<string, DecisionAnswer | ((request: DecisionRequest) => DecisionAnswer)>,
): FakeDecisionClient {
  return new FakeDecisionClient((request) => {
    const resolved: Record<string, DecisionAnswer> = {};
    for (const [id, answer] of Object.entries(answers)) {
      resolved[id] = typeof answer === "function" ? answer(request) : answer;
    }
    return decision(resolved);
  });
}

export function questionIds(...ids: string[]): Record<string, QuestionSpec> {
  return Object.fromEntries(ids.map((id) => [id, { type: "noul", instructions: id }]));
}

/**
 * A real `SdkDecisionClient` with an injected transport, so retry and
 * abort behavior are tested without network access.
 */
export function sdkClientWithTransport(
  systemOne: (request: any, options?: any) => Promise<any>,
  options: { env?: NodeJS.ProcessEnv; sleep?: (ms: number) => Promise<void> } = {},
): SdkDecisionClient {
  return new SdkDecisionClient({
    env: {
      TYPESAFE_API_KEY: "test-key",
      TYPESAFE_BASE_URL: "https://api.typesafe.ai/v1/systemone",
      ...options.env,
    },
    homedir: "/home/fake",
    readFile: () => null,
    sleep: options.sleep ?? (async () => {}),
    createClient: () => ({ systemOne }),
  });
}
