/**
 * Intent resolution for `cu_act`: candidate collection, the five-question
 * System One request, top-5 reranking, Operation reconciliation, and the
 * deterministic Route Decision.
 *
 * Pure except for the injected `evaluate` call, so both `cu_act` and the
 * `cu_run` loop can drive the same resolution without duplicating policy.
 */

import { collectCandidates, describeNode, nodeActions, type WalkedNode } from "../desktop/tree.js";
import { ACT_OPERATIONS, reconcileOperation, TEXT_OPERATIONS } from "../policy/operations.js";
import {
  ACTION_BAR,
  decideRoute,
  isProbability,
  validateChoice,
} from "../policy/route.js";
import type {
  ActOperation,
  AdNode,
  DecisionRequest,
  DecisionResponse,
  QuestionSpec,
  RouteDecision,
} from "../types.js";
import {
  nodeIdentity,
  windowState,
  type ActWindow,
} from "./shared.js";

/** A first-pass target confidence below this triggers the richer top-5 rerank. */
export const RERANK_CONFIDENCE_BAR = 0.7;
/** How many candidates the rerank request offers. */
export const RERANK_LIMIT = 5;
/** The literal "no offered element matches" target option. */
export const TARGET_NONE = "none";

/** The noul threshold above which the Intent is treated as needing text entry. */
const TEXT_INTENT_THRESHOLD = 0.5;

/* -------------------------------------------------------------------------- */
/* Candidates                                                                  */
/* -------------------------------------------------------------------------- */

/** One offerable Ref offered to the decision model. */
export interface ActCandidate {
  ref: string;
  role: string;
  name: string;
  /** Model-facing description; rich after a rerank, value-free when `noValues`. */
  description: string;
  /** The node's Advertised Actions, used for reconciliation. */
  advertised: string[];
  /** The walked node, so the same candidate can be re-described richly. */
  walked: WalkedNode;
}

export interface ActCandidateCollection {
  candidates: ActCandidate[];
  /** Offerable nodes found before the cap. */
  total: number;
  truncated: number;
  note: string | null;
}

/**
 * Describe one candidate for the decision model.
 *
 * `values: false` (`noValues: true`) withholds live field values from both the
 * compact and rich descriptions, and from the name fallback, so a sensitive
 * input never reaches the model.
 */
export function describeCandidate(
  walked: WalkedNode,
  options: { rich?: boolean; values?: boolean } = {},
): string {
  const node = options.values === false ? { ...walked.node, value: undefined } : walked.node;
  return describeNode({ ...walked, node }, { rich: options.rich === true });
}

export function toActCandidate(
  walked: WalkedNode,
  options: { rich?: boolean; values?: boolean } = {},
): ActCandidate {
  return {
    ...nodeIdentity(walked.node),
    description: describeCandidate(walked, options),
    advertised: nodeActions(walked.node),
    walked,
  };
}

/** Collect offerable Ref candidates from a snapshot tree. */
export function collectActCandidates(
  tree: AdNode | undefined | null,
  options: { values?: boolean } = {},
): ActCandidateCollection {
  const collection = collectCandidates(tree);
  return {
    candidates: collection.candidates.map((walked) => toActCandidate(walked, options)),
    total: collection.total,
    truncated: collection.truncated,
    note: collection.note,
  };
}

/* -------------------------------------------------------------------------- */
/* Request state and questions                                                 */
/* -------------------------------------------------------------------------- */

export interface ActStateInput {
  intent: string;
  window: ActWindow;
  surface?: string | null;
  candidates: readonly ActCandidate[];
  /** The caller supplied at least one string for this Intent. */
  textSupplied: boolean;
}

/** Canonical Operation glosses, offered as the `command` choice descriptions. */
export const OPERATION_DESCRIPTIONS: Record<ActOperation, string> = {
  click: "Press the element: buttons, tabs, list items, and readonly combo boxes.",
  "right-click": "Open the element's context menu.",
  "set-value": "Write text into an element that advertises SetValue.",
  clear: "Erase the text of an element that advertises SetValue.",
  select: "Choose a menu or list option by its caller-supplied label.",
  toggle: "Flip a switch or toggle button.",
  check: "Check a checkbox.",
  uncheck: "Uncheck a checkbox.",
  expand: "Expand a collapsed tree item, combo box, or disclosure.",
  collapse: "Collapse an expanded tree item, combo box, or disclosure.",
  "scroll-to": "Scroll the element into view.",
};

/** The structured `state` sent to System One. Never includes caller text or live values. */
export function actState(input: ActStateInput): Record<string, unknown> {
  return {
    intent: input.intent,
    window: windowState(input.window),
    ...(input.surface ? { surface: input.surface } : {}),
    text_supplied: input.textSupplied,
    candidates: input.candidates.map((candidate) => ({
      ref: candidate.ref,
      description: candidate.description,
    })),
  };
}

/** The five questions asked for one Intent step. */
export function actQuestions(candidates: readonly ActCandidate[]): Record<string, QuestionSpec> {
  const target: Record<string, string> = {};
  for (const candidate of candidates) target[candidate.ref] = candidate.description;
  target[TARGET_NONE] = "no offered element matches the Intent";

  const command: Record<string, string> = {};
  for (const operation of ACT_OPERATIONS) command[operation] = OPERATION_DESCRIPTIONS[operation];

  return {
    target: {
      type: "choice",
      instructions: "Which offered element is the target of the Intent? Choose `none` when no element matches.",
      criteria: target,
    },
    command: {
      type: "choice",
      instructions: "Which Wayland-safe Operation performs the Intent on that element?",
      criteria: command,
    },
    present: {
      type: "noul",
      instructions: "Is the chosen target present and visible on the current screen?",
    },
    destructive: {
      type: "noul",
      instructions: "Would this Operation delete, overwrite, or otherwise irreversibly change user data or settings?",
    },
    needs_text: {
      type: "noul",
      instructions: "Does this Intent require caller-supplied text to type or select?",
    },
  };
}

export function offeredTargets(candidates: readonly ActCandidate[]): string[] {
  return [...candidates.map((candidate) => candidate.ref), TARGET_NONE];
}

/* -------------------------------------------------------------------------- */
/* Answer validation                                                           */
/* -------------------------------------------------------------------------- */

export interface ActAnswers {
  target: string;
  targetConfidence: number;
  targetDistribution: Record<string, number> | null;
  command: ActOperation;
  present: number;
  destructive: number;
  needsText: number;
}

export type ActAnswerValidation =
  | { ok: true; answers: ActAnswers }
  | { ok: false; problem: string };

function isActOperation(value: string | null): value is ActOperation {
  return value !== null && (ACT_OPERATIONS as readonly string[]).includes(value);
}

function noulProbability(response: DecisionResponse, id: string): number | null {
  const answer = response.answers[id];
  if (!answer || answer.type !== "noul" || !isProbability(answer.value)) return null;
  return answer.value;
}

/**
 * Validate one System One response: the target and command choices must be
 * offered options with a finite confidence and a coherent distribution, and
 * every noul answer must be a finite probability. Any failure abstains.
 */
export function validateActAnswers(
  response: DecisionResponse,
  offered: readonly string[],
): ActAnswerValidation {
  const target = validateChoice(response.answers.target, offered);
  if (!target.ok) return { ok: false, problem: `target: ${target.problem}` };
  const command = validateChoice(response.answers.command, ACT_OPERATIONS);
  if (!command.ok || !isActOperation(command.value)) {
    return { ok: false, problem: `command: ${command.problem ?? "no Wayland-safe Operation was chosen"}` };
  }
  const present = noulProbability(response, "present");
  if (present === null) return { ok: false, problem: "present: answer is not a finite probability in [0,1]" };
  const destructive = noulProbability(response, "destructive");
  if (destructive === null) {
    return { ok: false, problem: "destructive: answer is not a finite probability in [0,1]" };
  }
  const needsText = noulProbability(response, "needs_text");
  if (needsText === null) return { ok: false, problem: "needs_text: answer is not a finite probability in [0,1]" };

  return {
    ok: true,
    answers: {
      target: target.value as string,
      targetConfidence: target.confidence as number,
      targetDistribution: target.distribution,
      command: command.value,
      present,
      destructive,
      needsText,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Reranking                                                                   */
/* -------------------------------------------------------------------------- */

/** The five most probable candidates from the first-pass distribution. */
export function topCandidates(
  candidates: readonly ActCandidate[],
  distribution: Record<string, number> | null,
  limit = RERANK_LIMIT,
): ActCandidate[] {
  if (!distribution) return candidates.slice(0, limit);
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      probability: distribution[candidate.ref] ?? 0,
    }))
    .sort((left, right) => right.probability - left.probability || left.index - right.index)
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

export interface ActStepResolution {
  target: ActCandidate | null;
  operation: ActOperation | null;
  reconciled: boolean;
  reconciledNote: string | null;
  reranked: boolean;
  confidence: number;
  present: number;
  destructive: number | null;
  needsText: boolean;
  decision: RouteDecision;
  why: string;
  bar: number;
  notes: string[];
}

export interface ResolveActStepInput {
  intent: string;
  window: ActWindow;
  surface?: string | null;
  candidates: readonly ActCandidate[];
  textSupplied: boolean;
  /** Withhold live field values from rerank descriptions (`noValues`). */
  noValues?: boolean;
  confirmDestructive?: boolean;
  signal?: AbortSignal;
  evaluate(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse>;
}

function abstention(why: string, extras: Partial<ActStepResolution> = {}): ActStepResolution {
  return {
    target: null,
    operation: null,
    reconciled: false,
    reconciledNote: null,
    reranked: false,
    confidence: 0,
    present: 0,
    destructive: null,
    needsText: false,
    decision: "abstain",
    why,
    bar: ACTION_BAR,
    notes: [],
    ...extras,
  };
}

/**
 * Resolve one Intent against the offered candidates.
 *
 * 1. Ask the five-question System One request.
 * 2. When the target confidence is below `0.70`, rerank the top 5 with rich
 *    descriptions (Advertised Actions, hidden child counts, parent role, states).
 * 3. Reconcile the chosen Operation against the target's Advertised Actions.
 * 4. Apply the deterministic Route Decision.
 */
export async function resolveActStep(input: ResolveActStepInput): Promise<ActStepResolution> {
  const offered = offeredTargets(input.candidates);
  const state = actState({ ...input, candidates: input.candidates });
  const first = await input.evaluate({ state, questions: actQuestions(input.candidates) }, input.signal);
  const firstValidation = validateActAnswers(first, offered);
  if (!firstValidation.ok) return abstention(firstValidation.problem);

  let answers = firstValidation.answers;
  let considered = input.candidates;
  let reranked = false;
  const notes: string[] = [];

  if (answers.target !== TARGET_NONE && answers.targetConfidence < RERANK_CONFIDENCE_BAR) {
    const shortlist = topCandidates(input.candidates, answers.targetDistribution);
    if (shortlist.length > 1) {
      reranked = true;
      notes.push(
        `target confidence ${answers.targetConfidence.toFixed(2)} is below ${RERANK_CONFIDENCE_BAR}; ` +
          `reranked the top ${shortlist.length} candidates with richer descriptions`,
      );
      const rich = shortlist.map((candidate) => ({
        ...candidate,
        description: describeCandidate(candidate.walked, { rich: true, values: input.noValues !== true }),
      }));
      const second = await input.evaluate(
        { state: actState({ ...input, candidates: rich }), questions: actQuestions(rich) },
        input.signal,
      );
      const secondValidation = validateActAnswers(second, offeredTargets(rich));
      if (!secondValidation.ok) {
        return abstention(`rerank: ${secondValidation.problem}`, { reranked, notes, confidence: answers.targetConfidence });
      }
      answers = secondValidation.answers;
      considered = rich;
    }
  }

  const target =
    answers.target === TARGET_NONE
      ? null
      : considered.find((candidate) => candidate.ref === answers.target) ?? null;
  if (answers.target !== TARGET_NONE && target === null) {
    return abstention("the decision model chose a target that was not offered", { reranked, notes });
  }

  const gate = decideRoute({
    confidence: answers.targetConfidence,
    present: answers.present,
    destructive: answers.destructive,
    none: target === null,
  });
  const base = {
    target,
    reranked,
    confidence: answers.targetConfidence,
    present: answers.present,
    destructive: answers.destructive,
    notes,
  };
  if (gate.decision === "abstain") {
    return { ...base, operation: null, reconciled: false, reconciledNote: null, needsText: false, decision: "abstain", why: gate.why, bar: gate.bar };
  }

  const textIntent = answers.needsText >= TEXT_INTENT_THRESHOLD || input.textSupplied;
  const reconciled = reconcileOperation({
    desired: answers.command,
    advertised: target!.advertised,
    textIntent,
  });
  if (reconciled.abstain || reconciled.operation === null) {
    return {
      ...base,
      operation: null,
      reconciled: false,
      reconciledNote: null,
      needsText: false,
      decision: "abstain",
      why: reconciled.why ?? "target advertises no Wayland-safe Operation",
      bar: gate.bar,
    };
  }
  const operation = reconciled.operation as ActOperation;
  const reconciledNote = reconciled.why;
  if (reconciledNote) notes.push(reconciledNote);

  const needsText = TEXT_OPERATIONS.has(operation) && !input.textSupplied;
  const route = decideRoute({
    confidence: answers.targetConfidence,
    present: answers.present,
    destructive: answers.destructive,
    confirmDestructive: input.confirmDestructive,
    needsText,
  });

  return {
    ...base,
    operation,
    reconciled: reconciled.reconciled,
    reconciledNote,
    needsText,
    decision: route.decision,
    why: route.why,
    bar: route.bar,
  };
}
