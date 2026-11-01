/**
 * Deterministic Route Decision, choice validation, and confirmation text.
 *
 * The decision model supplies probabilities; these thresholds are policy and
 * never negotiable at runtime.
 */

import type {
  DecisionAnswer,
  RouteDecision,
  RouteDecisionInput,
  RouteDecisionResult,
} from "../types.js";

/** Hard confidence floor: below this, never touch the UI. */
export const CONFIDENCE_FLOOR = 0.55;
/** Ordinary action bar. */
export const ACTION_BAR = 0.70;
/** Destructive action bar, applied when destructive risk is material. */
export const DESTRUCTIVE_BAR = 0.90;
/** Destructive risk is material from here. */
export const DESTRUCTIVE_RISK = 0.5;
/** Below this presence probability the target is not on screen. */
export const PRESENT_FLOOR = 0.3;

export function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function clampProbability(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

export function decideRoute(input: RouteDecisionInput): RouteDecisionResult {
  const confidence = clampProbability(input.confidence);
  const present = clampProbability(input.present, 1);
  const destructive = input.destructive === null ? null : clampProbability(input.destructive);
  const destructiveBar =
    destructive !== null && destructive >= DESTRUCTIVE_RISK ? DESTRUCTIVE_BAR : ACTION_BAR;

  if (input.none) {
    return { decision: "abstain", why: "the decision model chose `none`: no offered target matches", bar: destructiveBar };
  }
  if (present < PRESENT_FLOOR) {
    return {
      decision: "abstain",
      why: `target presence probability ${present.toFixed(2)} is below ${PRESENT_FLOOR}`,
      bar: destructiveBar,
    };
  }
  if (confidence < CONFIDENCE_FLOOR) {
    return {
      decision: "abstain",
      why: `target confidence ${confidence.toFixed(2)} is below the ${CONFIDENCE_FLOOR} floor`,
      bar: destructiveBar,
    };
  }
  if (input.needsText) {
    return {
      decision: "needs_text",
      why: "the resolved Operation needs caller-supplied text and `text` was omitted",
      bar: destructiveBar,
    };
  }
  if (input.confirmDestructive) {
    return {
      decision: "confirm",
      why: "confirmDestructive was requested",
      bar: destructiveBar,
    };
  }
  if (destructive !== null && destructive >= DESTRUCTIVE_RISK) {
    if (confidence >= DESTRUCTIVE_BAR) {
      return {
        decision: "act",
        why: `destructive risk ${destructive.toFixed(2)} with confidence ${confidence.toFixed(2)} clears the ${DESTRUCTIVE_BAR} destructive bar`,
        bar: destructiveBar,
      };
    }
    return {
      decision: "confirm",
      why: `destructive risk ${destructive.toFixed(2)} with confidence ${confidence.toFixed(2)} needs the ${DESTRUCTIVE_BAR} bar`,
      bar: destructiveBar,
    };
  }
  if (confidence >= ACTION_BAR) {
    return {
      decision: "act",
      why: `confidence ${confidence.toFixed(2)} clears the ${ACTION_BAR} action bar`,
      bar: destructiveBar,
    };
  }
  return {
    decision: "confirm",
    why: `confidence ${confidence.toFixed(2)} is between ${CONFIDENCE_FLOOR} and the ${ACTION_BAR} action bar`,
    bar: destructiveBar,
  };
}

export interface ChoiceValidation {
  ok: boolean;
  problem: string | null;
  value: string | null;
  confidence: number | null;
  distribution: Record<string, number> | null;
}

/**
 * Validate a `choice` answer: the value must be in the offered set, every
 * probability finite in `[0,1]`, and a present distribution must sum to
 * `1.0 ± 0.02`.
 */
export function validateChoice(
  answer: DecisionAnswer | undefined,
  offered: readonly string[],
): ChoiceValidation {
  if (!answer) {
    return { ok: false, problem: "the decision model did not answer the question", value: null, confidence: null, distribution: null };
  }
  const value = typeof answer.value === "string" ? answer.value : null;
  if (value === null) {
    return { ok: false, problem: "choice answer is not a string", value: null, confidence: null, distribution: null };
  }
  if (!offered.includes(value)) {
    return {
      ok: false,
      problem: `chosen option ${JSON.stringify(value)} is not one of the offered options`,
      value,
      confidence: null,
      distribution: null,
    };
  }
  const confidence = answer.confidence;
  if (!isProbability(confidence)) {
    return { ok: false, problem: "choice confidence is not a finite probability in [0,1]", value, confidence: null, distribution: null };
  }
  let distribution: Record<string, number> | null = null;
  if (answer.distribution && typeof answer.distribution === "object") {
    distribution = {};
    let sum = 0;
    for (const [option, probability] of Object.entries(answer.distribution)) {
      if (!isProbability(probability)) {
        return { ok: false, problem: `distribution probability for ${option} is not in [0,1]`, value, confidence, distribution: null };
      }
      distribution[option] = probability;
      sum += probability;
    }
    if (Math.abs(sum - 1) > 0.02) {
      return { ok: false, problem: `distribution sums to ${sum.toFixed(4)}, outside 1.0 ± 0.02`, value, confidence, distribution };
    }
  }
  return { ok: true, problem: null, value, confidence, distribution };
}

export function probability(answer: DecisionAnswer | undefined, fallback = 0): number {
  if (!answer) return fallback;
  return clampProbability(answer.value, fallback);
}

export interface ConfirmationDetails {
  window: string;
  operation: string;
  target: string;
  confidence: number;
  destructive: number | null;
  goal?: string;
  intent?: string;
  why?: string;
}

/** The `ctx.ui.confirm` body: Window, Operation, target, confidence, destructive risk. */
export function confirmationMessage(details: ConfirmationDetails): string {
  const lines: string[] = [];
  if (details.intent) lines.push(`Intent: ${details.intent}`);
  if (details.goal) lines.push(`Goal: ${details.goal}`);
  lines.push(`Window: ${details.window}`);
  lines.push(`Operation: ${details.operation}`);
  lines.push(`Target: ${details.target}`);
  lines.push(`Target confidence: ${details.confidence.toFixed(2)}`);
  lines.push(
    `Destructive risk: ${details.destructive === null ? "not rated" : details.destructive.toFixed(2)}`,
  );
  if (details.why) lines.push(`Reason: ${details.why}`);
  return lines.join("\n");
}

export function confirmationTitle(operation: string): string {
  return `Approve ${operation}?`;
}

export function isRouteDecision(value: string): value is RouteDecision {
  return value === "act" || value === "confirm" || value === "abstain" || value === "needs_text";
}
