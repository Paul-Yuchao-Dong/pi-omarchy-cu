/**
 * Goal-loop planning and stepping for `cu_run`.
 *
 * The loop is I/O-free: observation, execution, confirmation, and decision
 * calls arrive through `GoalLoopDeps`, so the tool module owns the
 * `agent-desktop` subprocess and Pi UI while the decision policy lives here.
 *
 * One turn offers every Wayland-safe Operation with its own target list in a
 * single System One request (Jev's 254-option Choice limit is shared across
 * those lists), then routes the chosen pairing through the deterministic
 * Route Decision.
 */

import {
  collectCandidates,
  screenFingerprint,
  truncatedRegions,
  type WalkedNode,
} from "../desktop/tree.js";
import {
  RUN_ELEMENT_OPERATIONS,
  RUN_TERMINAL_OPERATIONS,
  supportsOperation,
} from "../policy/operations.js";
import {
  CONFIDENCE_FLOOR,
  DESTRUCTIVE_BAR,
  decideRoute,
  isProbability,
  validateChoice,
} from "../policy/route.js";
import { TextQueue, type TextSupply } from "../text/queue.js";
import type {
  AdNode,
  AdSnapshotData,
  DecisionRequest,
  DecisionResponse,
  QuestionSpec,
  RouteDecision,
  RunOperation,
} from "../types.js";
import { describeCandidate, TARGET_NONE, type ActWindow } from "./act.js";

/** Default Operation budget for one Goal. */
export const DEFAULT_MAX_OPERATIONS = 40;
/** Default decision-model call budget for one Goal (every evaluate counts). */
export const DEFAULT_MAX_JEV_CALLS = 80;
/** Consecutive non-WAIT turns allowed without a fingerprint change. */
export const DEFAULT_MAX_UNCHANGED_TURNS = 3;
/** Jev's 254-option Choice limit, shared across all `<operation>_target` questions. */
export const MAX_TARGET_OPTIONS = 254;
/** Target Ref offered by `WIDEN`: the whole Window root. */
export const WINDOW_TARGET = "window";

export interface RunLimits {
  operations: number;
  jevCalls: number;
  unchangedTurns: number;
}

export function runLimits(params: {
  maxOperations?: number;
  maxJevCalls?: number;
  maxUnchangedTurns?: number;
}): RunLimits {
  return {
    operations: params.maxOperations ?? DEFAULT_MAX_OPERATIONS,
    jevCalls: params.maxJevCalls ?? DEFAULT_MAX_JEV_CALLS,
    unchangedTurns: params.maxUnchangedTurns ?? DEFAULT_MAX_UNCHANGED_TURNS,
  };
}

/** Canonical Operation glosses, offered as the `operation` choice descriptions. */
export const RUN_OPERATION_DESCRIPTIONS: Record<RunOperation, string> = {
  CLICK: "Press an element that advertises Click: buttons, tabs, and list items.",
  RIGHT_CLICK: "Open the context menu of an element that advertises RightClick.",
  TYPE_TEXT: "Type the next caller-supplied string into an element that advertises SetValue (executes set-value).",
  CLEAR: "Erase the text of an element that advertises SetValue.",
  SELECT: "Choose the next caller-supplied label in an element that advertises Select.",
  CHECK: "Check a check box or toggle button that advertises Toggle.",
  UNCHECK: "Uncheck a check box or toggle button that advertises Toggle.",
  EXPAND: "Expand a collapsed tree item, combo box, or disclosure.",
  COLLAPSE: "Collapse an expanded tree item, combo box, or disclosure.",
  SCROLL_TO: "Scroll an element that advertises Scroll into view.",
  DRILL: "Look deeper into a truncated Region by re-rooting the observation at it.",
  WIDEN: "Return to the whole Window after drilling into a Region.",
  WAIT: "Look again without acting, so the application can settle.",
  DONE: "The Goal is visibly satisfied; stop the loop.",
  BLOCKED: "The Goal cannot be completed from the current screen; stop the loop.",
};

const ELEMENT_OPERATIONS: ReadonlySet<RunOperation> = new Set(RUN_ELEMENT_OPERATIONS);

export function isElementOperation(operation: RunOperation): boolean {
  return ELEMENT_OPERATIONS.has(operation);
}

/* -------------------------------------------------------------------------- */
/* Target lists                                                                */
/* -------------------------------------------------------------------------- */

/** One offered target: an element Ref or the whole-Window `WIDEN` target. */
export interface RunTarget {
  ref: string;
  role: string;
  name: string;
  description: string;
  node: AdNode;
}

function toRunTarget(walked: WalkedNode, values?: boolean): RunTarget {
  return {
    ref: String(walked.node.ref_id ?? ""),
    role: String(walked.node.role ?? "element"),
    name: String(walked.node.name ?? walked.node.title ?? ""),
    description: describeCandidate(walked, { rich: true, values }),
    node: walked.node,
  };
}

const windowTarget = (): RunTarget => ({
  ref: WINDOW_TARGET,
  role: "window",
  name: "Window",
  description: `${WINDOW_TARGET} | the whole Window root (clears the drilled Region)`,
  node: { role: "window", name: "Window" },
});

export interface RunTargetList {
  operation: RunOperation;
  question: string;
  targets: RunTarget[];
}

export interface RunTargetPlan {
  /** Operations offered in the `operation` question, in canonical order. */
  offered: RunOperation[];
  targets: RunTargetList[];
  /** Every offerable element, for the decision state. */
  candidates: RunTarget[];
  truncated: number;
  notes: string[];
}

export function targetQuestionId(operation: RunOperation): string {
  return `${operation.toLowerCase()}_target`;
}

export interface BuildRunTargetPlanInput {
  tree: AdNode | null | undefined;
  /** Region Ref the observation is rooted at, or `null` for the whole Window. */
  root: string | null;
  /** The caller still has text queued, so TYPE_TEXT and SELECT can be offered. */
  textSupplied: boolean;
  /** `false` withholds live field values from candidate descriptions. */
  values?: boolean;
}

/**
 * Build the per-Operation target lists.
 *
 * A list exists only when at least one offerable element advertises the
 * Operation's required action; DRILL lists the truncated Regions of the read
 * and WIDEN exists only while drilled in. Offers are cut once the shared
 * 254-option budget is spent, and the cut is recorded as a note.
 */
export function buildRunTargetPlan(input: BuildRunTargetPlanInput): RunTargetPlan {
  const collection = collectCandidates(input.tree);
  const candidates = collection.candidates.map((walked) => toRunTarget(walked, input.values));
  const notes: string[] = collection.note ? [collection.note] : [];
  const targets: RunTargetList[] = [];
  let remaining = MAX_TARGET_OPTIONS;
  let truncated = 0;

  const offer = (operation: RunOperation, pool: RunTarget[]): void => {
    if (pool.length === 0) return;
    const taken = pool.length <= remaining ? pool : pool.slice(0, remaining);
    truncated += pool.length - taken.length;
    remaining -= taken.length;
    if (taken.length === 0) return;
    targets.push({ operation, question: targetQuestionId(operation), targets: taken });
  };

  for (const operation of RUN_ELEMENT_OPERATIONS) {
    if (!input.textSupplied && (operation === "TYPE_TEXT" || operation === "SELECT")) continue;
    offer(operation, candidates.filter((candidate) => supportsOperation(candidate.node, operation)));
  }
  offer("DRILL", truncatedRegions(input.tree).map((walked) => toRunTarget(walked, input.values)));
  if (input.root !== null) offer("WIDEN", [windowTarget()]);

  if (truncated > 0) {
    notes.push(
      `target options were capped at ${MAX_TARGET_OPTIONS} across all Operation lists; ` +
        `${truncated} offered elements were withheld until the view narrows`,
    );
  }

  return {
    offered: [...targets.map((list) => list.operation), ...RUN_TERMINAL_OPERATIONS],
    targets,
    candidates,
    truncated,
    notes,
  };
}

/* -------------------------------------------------------------------------- */
/* Request state and questions                                                 */
/* -------------------------------------------------------------------------- */

export interface RunRecentAction {
  turn: number;
  operation: RunOperation;
  target: { ref: string; role: string; name: string } | null;
  /** Caller-supplied string consumed by TYPE_TEXT or SELECT. */
  text?: string;
  decision: RouteDecision;
  delivery: string | null;
  changed: boolean | null;
  confirmedByUser?: boolean;
}

export interface RunStateInput {
  goal: string;
  turn: number;
  window: ActWindow;
  surface: string | null;
  root: string | null;
  textSupplied: boolean;
  candidates: readonly RunTarget[];
  recent: readonly RunRecentAction[];
}

function windowState(window: ActWindow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (window.app) out.app = window.app;
  if (window.id) out.id = window.id;
  if (window.title) out.title = window.title;
  return out;
}

/** The structured `state` sent to System One. Never includes caller text or live values. */
export function runState(input: RunStateInput): Record<string, unknown> {
  return {
    goal: input.goal,
    turn: input.turn,
    window: windowState(input.window),
    ...(input.surface ? { surface: input.surface } : {}),
    ...(input.root ? { region_root: input.root } : {}),
    text_supplied: input.textSupplied,
    recent_actions: input.recent.slice(-5).map((action) => ({
      turn: action.turn,
      operation: action.operation,
      target: action.target?.ref ?? null,
      delivery: action.delivery,
    })),
    candidates: input.candidates.map((candidate) => ({
      ref: candidate.ref,
      description: candidate.description,
    })),
  };
}

export function runQuestions(plan: RunTargetPlan): Record<string, QuestionSpec> {
  const operations: Record<string, string> = {};
  for (const operation of plan.offered) operations[operation] = RUN_OPERATION_DESCRIPTIONS[operation];

  const questions: Record<string, QuestionSpec> = {
    operation: {
      type: "choice",
      instructions:
        "Which Operation moves the Goal forward from this screen? Choose DONE when the Goal is visibly met and BLOCKED when it cannot be completed.",
      criteria: operations,
    },
  };
  for (const list of plan.targets) {
    const criteria: Record<string, string> = {};
    for (const target of list.targets) criteria[target.ref] = target.description;
    criteria[TARGET_NONE] = `no offered element matches ${list.operation}`;
    questions[list.question] = {
      type: "choice",
      instructions: `Which offered element should ${list.operation} act on? Choose \`none\` when nothing matches.`,
      criteria,
    };
  }
  questions.present = {
    type: "noul",
    instructions: "Is the chosen target present and visible on the current screen?",
  };
  return questions;
}

/* -------------------------------------------------------------------------- */
/* Answer validation                                                           */
/* -------------------------------------------------------------------------- */

export interface RunAnswers {
  operation: RunOperation;
  operationConfidence: number;
  target: RunTarget | null;
  targetConfidence: number | null;
  /** Confidence that routes the step: the target's when one was chosen. */
  confidence: number;
  present: number;
}

export type RunAnswerValidation =
  | { ok: true; answers: RunAnswers }
  | { ok: false; problem: string };

function isRunOperation(value: string | null): value is RunOperation {
  return value !== null && value in RUN_OPERATION_DESCRIPTIONS;
}

/**
 * Validate one System One response: the Operation must be offered, its own
 * target answer must be an offered option with a coherent distribution, and
 * presence must be a finite probability. A target answer belonging to another
 * Operation is never read.
 */
export function validateRunAnswers(
  response: DecisionResponse,
  plan: RunTargetPlan,
): RunAnswerValidation {
  const operation = validateChoice(response.answers.operation, plan.offered);
  if (!operation.ok || !isRunOperation(operation.value)) {
    return { ok: false, problem: `operation: ${operation.problem ?? "no Wayland-safe Operation was chosen"}` };
  }
  const present = response.answers.present;
  if (!present || present.type !== "noul" || !isProbability(present.value)) {
    return { ok: false, problem: "present: answer is not a finite probability in [0,1]" };
  }
  const chosen = operation.value;
  const base = {
    operation: chosen,
    operationConfidence: operation.confidence as number,
    present: present.value,
  };

  const list = plan.targets.find((entry) => entry.operation === chosen);
  if (!list) {
    return {
      ok: true,
      answers: { ...base, target: null, targetConfidence: null, confidence: operation.confidence as number },
    };
  }

  const offered = [...list.targets.map((target) => target.ref), TARGET_NONE];
  const target = validateChoice(response.answers[list.question], offered);
  if (!target.ok) return { ok: false, problem: `${list.question}: ${target.problem}` };
  if (target.value === TARGET_NONE) {
    return {
      ok: true,
      answers: { ...base, target: null, targetConfidence: target.confidence, confidence: target.confidence as number },
    };
  }
  const match = list.targets.find((entry) => entry.ref === target.value);
  if (!match) return { ok: false, problem: `${list.question}: chosen target was not offered` };
  return {
    ok: true,
    answers: { ...base, target: match, targetConfidence: target.confidence, confidence: target.confidence as number },
  };
}

/* -------------------------------------------------------------------------- */
/* Risk rating                                                                 */
/* -------------------------------------------------------------------------- */

export interface RunRiskInput {
  goal: string;
  window: ActWindow;
  surface: string | null;
  root: string | null;
  operation: RunOperation;
  target: RunTarget;
  confidence: number;
}

export function riskState(input: RunRiskInput): Record<string, unknown> {
  return {
    goal: input.goal,
    window: windowState(input.window),
    ...(input.surface ? { surface: input.surface } : {}),
    ...(input.root ? { region_root: input.root } : {}),
    operation: input.operation,
    target: { ref: input.target.ref, description: input.target.description },
    target_confidence: input.confidence,
  };
}

export function riskQuestions(): Record<string, QuestionSpec> {
  return {
    destructive: {
      type: "noul",
      instructions:
        "Would this Operation delete, overwrite, or otherwise irreversibly change user data or settings?",
    },
  };
}

/** Rate destructive risk whenever the prompt behind it must show a calibrated probability. */
export function needsRiskRating(input: { confidence: number; confirmDestructive: boolean }): boolean {
  if (input.confirmDestructive) return true;
  return input.confidence >= CONFIDENCE_FLOOR && input.confidence < DESTRUCTIVE_BAR;
}

/* -------------------------------------------------------------------------- */
/* The loop                                                                    */
/* -------------------------------------------------------------------------- */

export interface GoalObservation {
  data: AdSnapshotData;
  surface: string | null;
  fingerprint: string;
  notes: string[];
}

export type ObserveOutcome =
  | { ok: true; observation: GoalObservation }
  | { ok: false; stop: string; code?: string; message?: string };

export type MutationOutcome =
  | { ok: true; delivery: string }
  | { ok: false; delivery: string; code: string; message: string };

export interface ConfirmRequest {
  operation: RunOperation;
  target: RunTarget;
  window: ActWindow;
  confidence: number;
  destructive: number | null;
  why: string;
}

export interface ConfirmOutcome {
  /** A prompt was actually shown to the user. */
  prompted: boolean;
  approved: boolean;
}

export interface GoalLoopDeps {
  /** Read the Window (or the drilled Region), auto-switching to an open Overlay Surface. */
  observe(root: string | null, signal?: AbortSignal): Promise<ObserveOutcome>;
  /** Execute one element Operation through `agent-desktop`. */
  mutate(
    operation: RunOperation,
    target: RunTarget,
    text: string | undefined,
    signal?: AbortSignal,
  ): Promise<MutationOutcome>;
  confirm(request: ConfirmRequest): Promise<ConfirmOutcome>;
  evaluate(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse>;
  onTurn?(turn: RunTurn): void;
}

export interface RunTurn {
  turn: number;
  operation: RunOperation | null;
  target: { ref: string; role: string; name: string } | null;
  decision: RouteDecision;
  delivery: string | null;
  changed: boolean | null;
  stop?: string;
  confirmedByUser?: boolean;
}

export interface RunConfirmCandidate {
  operation: RunOperation;
  target: { ref: string; role: string; name: string };
  confidence: number;
  destructive: number | null;
  why: string;
}

export interface GoalLoopInput {
  goal: string;
  window: ActWindow;
  text?: TextSupply;
  limits: RunLimits;
  confirmDestructive?: boolean;
  noValues?: boolean;
  signal?: AbortSignal;
}

export interface GoalLoopResult {
  stop: string;
  code: string | null;
  turns: RunTurn[];
  operations: number;
  jevCalls: number;
  recentActions: RunRecentAction[];
  notes: string[];
  confirm: RunConfirmCandidate | null;
  surface: string | null;
  root: string | null;
  window: ActWindow;
  secrets: readonly string[];
}

function targetPayload(target: RunTarget | null): { ref: string; role: string; name: string } | null {
  return target ? { ref: target.ref, role: target.role, name: target.name } : null;
}

export function targetLabel(target: RunTarget): string {
  const name = target.name ? ` "${target.name}"` : "";
  return `${target.role}${name} (${target.ref})`;
}

function windowFrom(data: AdSnapshotData, fallback: ActWindow): ActWindow {
  const id = data.window?.id;
  const title = data.window?.title;
  const app = data.app;
  return {
    app: typeof app === "string" ? app : fallback.app,
    id: typeof id === "string" ? id : fallback.id,
    title: typeof title === "string" ? title : fallback.title,
  };
}

/**
 * Drive the Goal until it is visibly met or a stop condition ends the loop.
 *
 * Every completed turn is streamed through `onTurn`; mutating turns re-read the
 * Window and compare screen fingerprints, and three consecutive non-WAIT turns
 * without a change stop the loop.
 */
export async function runGoalLoop(
  input: GoalLoopInput,
  deps: GoalLoopDeps,
): Promise<GoalLoopResult> {
  const queue = new TextQueue(input.text);
  const { limits } = input;
  const turns: RunTurn[] = [];
  const recentActions: RunRecentAction[] = [];
  const notes: string[] = [];
  let operations = 0;
  let jevCalls = 0;
  let unchangedTurns = 0;
  let nextTurn = 1;
  let root: string | null = null;
  let surface: string | null = null;
  let confirm: RunConfirmCandidate | null = null;
  let window: ActWindow = { ...input.window };

  const addNote = (note: string): void => {
    if (!notes.includes(note)) notes.push(note);
  };

  const result = (stop: string, code: string | null = null): GoalLoopResult => ({
    stop,
    code,
    turns,
    operations,
    jevCalls,
    recentActions,
    notes,
    confirm,
    surface,
    root,
    window,
    secrets: queue.secrets,
  });

  const complete = (turn: Omit<RunTurn, "turn">, stop?: string): void => {
    const record: RunTurn = { turn: nextTurn, ...turn, ...(stop === undefined ? {} : { stop }) };
    turns.push(record);
    deps.onTurn?.(record);
    nextTurn += 1;
  };

  const first = await deps.observe(null, input.signal);
  if (!first.ok) {
    if (first.message) addNote(first.message);
    return result(first.stop, first.code ?? null);
  }
  let observation = first.observation;
  window = windowFrom(observation.data, input.window);
  surface = observation.surface;
  for (const note of observation.notes) addNote(note);

  for (;;) {
    if (operations >= limits.operations) return result("budget: operations");
    if (jevCalls >= limits.jevCalls) return result("budget: jev calls");

    const plan = buildRunTargetPlan({
      tree: observation.data.tree,
      root,
      textSupplied: !queue.empty,
      values: input.noValues !== true,
    });
    for (const note of plan.notes) addNote(note);

    const request: DecisionRequest = {
      state: runState({
        goal: input.goal,
        turn: nextTurn,
        window,
        surface,
        root,
        textSupplied: !queue.empty,
        candidates: plan.candidates,
        recent: recentActions,
      }),
      questions: runQuestions(plan),
    };
    const response = await deps.evaluate(request, input.signal);
    jevCalls += 1;

    const validation = validateRunAnswers(response, plan);
    if (!validation.ok) {
      addNote(validation.problem);
      complete(
        { operation: null, target: null, decision: "abstain", delivery: null, changed: null },
        `abstain: ${validation.problem}`,
      );
      return result(`abstain: ${validation.problem}`);
    }
    const answers = validation.answers;
    const operation = answers.operation;
    const target = targetPayload(answers.target);

    if (operation === "DONE") {
      complete({ operation, target: null, decision: "act", delivery: null, changed: null }, "done");
      return result("done");
    }
    if (operation === "BLOCKED") {
      addNote("the decision model reported the Goal as blocked on the current screen");
      complete({ operation, target: null, decision: "act", delivery: null, changed: null }, "blocked");
      return result("blocked");
    }

    let destructive: number | null = null;
    const riskWanted =
      answers.target !== null &&
      needsRiskRating({
        confidence: answers.confidence,
        confirmDestructive: input.confirmDestructive === true,
      });
    if (riskWanted) {
      const risk = await deps.evaluate(
        {
          state: riskState({
            goal: input.goal,
            window,
            surface,
            root,
            operation,
            target: answers.target!,
            confidence: answers.confidence,
          }),
          questions: riskQuestions(),
        },
        input.signal,
      );
      jevCalls += 1;
      const rated = risk.answers.destructive;
      destructive = rated && isProbability(rated.value) ? rated.value : null;
      if (destructive === null) {
        addNote(`destructive risk could not be rated for ${operation}; the prompt reports it as not rated`);
      }
    }

    let decision: RouteDecision = "act";
    let confirmedByUser = false;
    if (isElementOperation(operation)) {
      const route = decideRoute({
        confidence: answers.confidence,
        present: answers.present,
        destructive,
        confirmDestructive: input.confirmDestructive === true,
        none: answers.target === null,
      });
      if (route.decision === "abstain") {
        addNote(route.why);
        complete({ operation, target, decision: "abstain", delivery: null, changed: null }, `abstain: ${route.why}`);
        return result(`abstain: ${route.why}`);
      }
      decision = route.decision;
      if (route.decision === "confirm") {
        const chosen = answers.target!;
        confirm = {
          operation,
          target: targetPayload(chosen)!,
          confidence: answers.confidence,
          destructive,
          why: route.why,
        };
        const stop = `confirm: ${operation} on ${targetLabel(chosen)}`;
        const outcome = await deps.confirm({
          operation,
          target: chosen,
          window,
          confidence: answers.confidence,
          destructive,
          why: route.why,
        });
        if (!outcome.prompted) {
          addNote("confirmation is required but no interactive prompt is available; no Operation was executed");
          complete({ operation, target, decision, delivery: null, changed: null }, stop);
          return result(stop);
        }
        if (!outcome.approved) {
          addNote("the confirmation prompt was declined; no Operation was executed");
          complete({ operation, target, decision, delivery: null, changed: null }, stop);
          return result(stop);
        }
        confirmedByUser = true;
      }
    }

    if (isElementOperation(operation)) {
      const chosen = answers.target!;
      let text: string | undefined;
      if (operation === "TYPE_TEXT") text = queue.take({ sensitive: true });
      else if (operation === "SELECT") text = queue.take();
      if ((operation === "TYPE_TEXT" || operation === "SELECT") && text === undefined) {
        const stop = `abstain: the caller-supplied text queue is empty for ${operation}`;
        addNote(stop);
        complete({ operation, target, decision, delivery: null, changed: null }, stop);
        return result(stop);
      }

      const execution = await deps.mutate(operation, chosen, text, input.signal);
      if (!execution.ok) {
        addNote(`agent-desktop ${operation} failed with ${execution.code}`);
        const stop = "error: action_failed";
        complete(
          {
            operation,
            target,
            decision,
            delivery: execution.delivery,
            changed: null,
            ...(confirmedByUser ? { confirmedByUser } : {}),
          },
          stop,
        );
        return result(stop, execution.code);
      }
      operations += 1;

      const after = await deps.observe(root, input.signal);
      if (!after.ok) {
        if (after.message) addNote(after.message);
        complete(
          { operation, target, decision, delivery: execution.delivery, changed: null },
          after.stop,
        );
        return result(after.stop, after.code ?? null);
      }
      const changed = after.observation.fingerprint !== observation.fingerprint;
      observation = after.observation;
      window = windowFrom(observation.data, window);
      surface = observation.surface;
      unchangedTurns = changed ? 0 : unchangedTurns + 1;
      const stop = unchangedTurns >= limits.unchangedTurns ? `unchanged: ${limits.unchangedTurns} turns` : undefined;
      recentActions.push({
        turn: nextTurn,
        operation,
        target,
        ...(text === undefined ? {} : { text }),
        decision,
        delivery: execution.delivery,
        changed,
        ...(confirmedByUser ? { confirmedByUser } : {}),
      });
      complete(
        {
          operation,
          target,
          decision,
          delivery: execution.delivery,
          changed,
          ...(confirmedByUser ? { confirmedByUser } : {}),
        },
        stop,
      );
      if (stop) {
        addNote(`the screen did not change for ${limits.unchangedTurns} consecutive turns; stopping`);
        return result(stop);
      }
      continue;
    }

    // View Operations: DRILL re-roots the observation, WIDEN clears the root,
    // WAIT only looks again. None of them mutates the application.
    if (operation === "DRILL") {
      if (!answers.target) {
        const stop = "abstain: DRILL was chosen without a truncated Region target";
        addNote(stop);
        complete({ operation, target, decision, delivery: null, changed: null }, stop);
        return result(stop);
      }
      root = answers.target.ref;
    } else if (operation === "WIDEN") {
      root = null;
    }

    const after = await deps.observe(root, input.signal);
    if (!after.ok) {
      if (after.message) addNote(after.message);
      complete({ operation, target, decision, delivery: null, changed: null }, after.stop);
      return result(after.stop, after.code ?? null);
    }
    const changed = operation === "WAIT" ? null : after.observation.fingerprint !== observation.fingerprint;
    observation = after.observation;
    window = windowFrom(observation.data, window);
    surface = observation.surface;
    if (changed === true) unchangedTurns = 0;
    else if (changed === false) unchangedTurns += 1;
    const stop = changed === false && unchangedTurns >= limits.unchangedTurns
      ? `unchanged: ${limits.unchangedTurns} turns`
      : undefined;
    recentActions.push({ turn: nextTurn, operation, target, decision, delivery: "looked", changed });
    complete({ operation, target, decision, delivery: "looked", changed }, stop);
    if (stop) {
      addNote(`the screen did not change for ${limits.unchangedTurns} consecutive turns; stopping`);
      return result(stop);
    }
  }
}
