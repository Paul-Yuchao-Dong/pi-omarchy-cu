/**
 * Shared contracts for `pi-omarchy-cu`.
 *
 * Two external boundaries are injectable so the whole extension can be tested
 * through the Pi tool-execution seam:
 *
 * - `CliRunner`: the `agent-desktop` subprocess boundary.
 * - `DecisionClient`: the in-process TypeSafe Jev System One boundary.
 *
 * Nothing in this file may import from Pi or from a transport library.
 */

/* -------------------------------------------------------------------------- */
/* agent-desktop envelopes                                                     */
/* -------------------------------------------------------------------------- */

/** One `agent-desktop` JSON envelope. */
export interface AdEnvelope<TData = unknown> {
  version?: string;
  ok: boolean;
  command?: string;
  data?: TData;
  error?: AdError;
}

export interface AdDisposition {
  delivery?: "delivered_verified" | "delivered_unverified" | "not_delivered" | string;
  retry?: "safe" | "unsafe" | string;
}

export interface AdError {
  code: string;
  message?: string;
  suggestion?: string;
  details?: Record<string, unknown>;
  disposition?: AdDisposition;
}

export interface AdBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A node in an AT-SPI accessibility tree as reported by `agent-desktop`. */
export interface AdNode {
  ref_id?: string;
  role?: string;
  name?: string;
  value?: string;
  title?: string;
  description?: string;
  states?: string[];
  available_actions?: string[];
  bounds?: AdBounds;
  children?: AdNode[];
  children_count?: number;
  subtree_truncated?: boolean;
  [key: string]: unknown;
}

export interface AdWindowRef {
  id?: string;
  title?: string;
  app_name?: string;
  pid?: number;
  bounds?: AdBounds;
  is_focused?: boolean;
  accessible?: boolean;
}

export interface AdApp {
  name?: string;
  pid?: number;
  bundle_id?: string;
  presentation?: string;
}

export interface AdSurface {
  kind?: string;
  role?: string;
  surface?: string;
  title?: string;
  app?: string;
  window_id?: string;
  [key: string]: unknown;
}

/**
 * `snapshot` data. Only the fields this extension consumes are typed; the
 * envelope is deliberately open because `agent-desktop` may add fields.
 */
export interface AdSnapshotData extends Record<string, unknown> {
  app?: string;
  window?: AdWindowRef;
  snapshot_id?: string;
  ref_count?: number;
  complete?: boolean;
  truncated?: boolean;
  nodes_observed?: number;
  tree?: AdNode;
  surfaces?: Array<AdSurface | string>;
  surface?: AdSurface | string;
}

export interface AdStatusData extends Record<string, unknown> {
  version?: string;
  platform?: string;
  ref_count?: number;
  session_id?: string | null;
  snapshot_id?: string;
  state_root?: string;
  supported_surfaces?: string[];
  tracing?: boolean;
  permissions?: Record<string, { state?: string } & Record<string, unknown>>;
}

export interface AdListAppsData extends Record<string, unknown> {
  apps?: AdApp[];
}

export interface AdListWindowsData extends Record<string, unknown> {
  windows?: AdWindowRef[];
}

export interface AdListSurfacesData extends Record<string, unknown> {
  surfaces?: Array<AdSurface | string>;
  windows?: AdWindowRef[];
}

/* -------------------------------------------------------------------------- */
/* CLI runner boundary                                                         */
/* -------------------------------------------------------------------------- */

export type BinarySource = "env" | "package" | "probe" | "path";

export interface BinaryResolution {
  binary: string;
  source: BinarySource;
}

export interface CliRunOptions {
  signal?: AbortSignal;
  /** Hard timeout. When omitted the runner uses its own default. */
  timeoutMs?: number;
  /** Extra environment entries layered over the extension's base environment. */
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export interface CliRunResult {
  /** Parsed JSON envelope. A synthetic `ok: false` envelope is produced for transport failures. */
  envelope: AdEnvelope;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  binary: string;
  args: string[];
  timedOut: boolean;
  aborted: boolean;
}

export interface StateRootInfo {
  path: string;
  mode: number;
  created: boolean;
}

/** The `agent-desktop` subprocess boundary. */
export interface CliRunner {
  /** Resolve the executable, or `null` when no candidate exists. */
  resolve(): BinaryResolution | null;
  /** State directory that must be private (`0700`). */
  stateRoot(): string;
  /** Create (if needed) and enforce `0700` on the state root. */
  ensureStateRoot(): Promise<StateRootInfo>;
  /** Run one CLI command and parse its JSON envelope. Never throws for a non-zero exit. */
  run(args: string[], options?: CliRunOptions): Promise<CliRunResult>;
}

/* -------------------------------------------------------------------------- */
/* Jev decision boundary                                                       */
/* -------------------------------------------------------------------------- */

export type QuestionKind = "choice" | "noul" | "score";

export type QuestionInstructions = string | Record<string, unknown>;

export interface QuestionSpec {
  type: QuestionKind;
  /** Passed to the SDK `choice(instructions, criteria)` / `noul(instructions)` builder. */
  instructions: QuestionInstructions;
  /** Choice options or a structured score rubric. */
  criteria?: QuestionInstructions;
}

export interface DecisionRequest {
  state: QuestionInstructions;
  questions: Record<string, QuestionSpec>;
  model?: string;
}

export interface DecisionAnswer {
  type: QuestionKind;
  value: string | number | boolean;
  confidence?: number;
  distribution?: Record<string, number>;
  raw?: unknown;
}

export interface DecisionResponse {
  answers: Record<string, DecisionAnswer>;
  model: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  elapsedMs: number;
}

export interface JevConfigSummary {
  configured: boolean;
  /** SDK API root; `null` when the SDK's TypeSafe default root applies. */
  baseURL: string | null;
  /** The effective `/v1/systemone` request endpoint. */
  endpoint: string;
  model: string | null;
  keyOrigin: string | null;
  openrouter: boolean;
  problem: string | null;
}

export interface DecisionClient {
  isConfigured(): boolean;
  /** Human-readable configuration summary for `cu_status`. Never contains the key. */
  describe(): JevConfigSummary;
  evaluate(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse>;
}

/* -------------------------------------------------------------------------- */
/* Route decision policy                                                       */
/* -------------------------------------------------------------------------- */

export type RouteDecision = "act" | "confirm" | "abstain" | "needs_text";

export interface RouteDecisionInput {
  /** Target confidence from the decision model. */
  confidence: number;
  /** Probability that the target is present on screen. */
  present: number;
  /** Destructive-risk probability. `null` when not yet rated. */
  destructive: number | null;
  /** Caller forced confirmation. */
  confirmDestructive?: boolean;
  /** The resolved operation needs caller-supplied text that is missing. */
  needsText?: boolean;
  /** Target confidence is `none` (no offerable candidate matches). */
  none?: boolean;
}

export interface RouteDecisionResult {
  decision: RouteDecision;
  why: string;
  /** Confidence bar that applied to this step. */
  bar: number;
}

/* -------------------------------------------------------------------------- */
/* Wayland-safe operations                                                     */
/* -------------------------------------------------------------------------- */

/** The 11 Operations offered to the decision model in `cu_act`. */
export type ActOperation =
  | "click"
  | "right-click"
  | "set-value"
  | "clear"
  | "select"
  | "toggle"
  | "check"
  | "uncheck"
  | "expand"
  | "collapse"
  | "scroll-to";

/** The element/view/terminal Operations offered to the decision model in `cu_run`. */
export type RunOperation =
  | "CLICK"
  | "RIGHT_CLICK"
  | "TYPE_TEXT"
  | "CLEAR"
  | "SELECT"
  | "CHECK"
  | "UNCHECK"
  | "EXPAND"
  | "COLLAPSE"
  | "SCROLL_TO"
  | "DRILL"
  | "WIDEN"
  | "WAIT"
  | "DONE"
  | "BLOCKED";

/** Delivery Disposition as reported in tool output. */
export type DeliveryDisposition =
  | "delivered_verified"
  | "delivered_unverified"
  | "not_delivered"
  | "looked"
  | string;

/* -------------------------------------------------------------------------- */
/* Extension wiring                                                            */
/* -------------------------------------------------------------------------- */

export interface ProcessInfo {
  pid: number;
  command: string;
}

export interface CuDeps {
  runner: CliRunner;
  decision: DecisionClient;
  /** Base environment. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Home directory used for secret lookup. Defaults to `os.homedir()`. */
  homedir?: string;
  /** Injectable process listing for AT-SPI blind-spot diagnostics. */
  listProcesses?: () => Promise<ProcessInfo[]>;
  /** Clock, injected for deterministic tests. */
  now?: () => number;
}

/** Minimal context this extension needs from Pi; `ExtensionToolContext` satisfies it. */
export interface CuUi {
  confirm(title: string, message: string, opts?: unknown): Promise<boolean>;
  notify?(message: string, type?: "info" | "warning" | "error"): void;
  setStatus?(key: string, text: string | undefined): void;
}

export interface CuContext {
  hasUI?: boolean;
  ui?: CuUi;
  signal?: AbortSignal;
  cwd?: string;
}

export interface CuContentBlock {
  type: "text";
  text: string;
}

export interface CuToolResult<TDetails = unknown> {
  content: CuContentBlock[];
  details?: TDetails;
  isError?: boolean;
}
