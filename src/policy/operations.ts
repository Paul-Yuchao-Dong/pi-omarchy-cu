/**
 * Wayland-safe Operation vocabulary and Advertised Action reconciliation
 * (ADR-0002).
 *
 * Everything here is deterministic policy: the decision model picks an
 * Operation, and this module maps it onto what the target node actually
 * advertises over AT-SPI.
 */

import type { ActOperation, RunOperation } from "../types.js";
import { advertises } from "../desktop/tree.js";

export const ACT_OPERATIONS: readonly ActOperation[] = [
  "click",
  "right-click",
  "set-value",
  "clear",
  "select",
  "toggle",
  "check",
  "uncheck",
  "expand",
  "collapse",
  "scroll-to",
] as const;

/** Element Operations offered to the decision model in `cu_run`. */
export const RUN_ELEMENT_OPERATIONS: readonly RunOperation[] = [
  "CLICK",
  "RIGHT_CLICK",
  "TYPE_TEXT",
  "CLEAR",
  "SELECT",
  "CHECK",
  "UNCHECK",
  "EXPAND",
  "COLLAPSE",
  "SCROLL_TO",
] as const;

/** Non-mutating view Operations. */
export const RUN_VIEW_OPERATIONS: readonly RunOperation[] = ["DRILL", "WIDEN"] as const;
/** Terminal Operations. */
export const RUN_TERMINAL_OPERATIONS: readonly RunOperation[] = ["WAIT", "DONE", "BLOCKED"] as const;

export const RUN_OPERATIONS: readonly RunOperation[] = [
  ...RUN_ELEMENT_OPERATIONS,
  ...RUN_VIEW_OPERATIONS,
  ...RUN_TERMINAL_OPERATIONS,
] as const;

/** Operations that write caller-supplied text. */
export const TEXT_OPERATIONS: ReadonlySet<string> = new Set(["set-value", "select", "TYPE_TEXT", "SELECT"]);

export const SET_VALUE_ABSTAIN_REASON =
  "target does not advertise SetValue and keystroke typing is unsupported on Hyprland Wayland";

const ACT_REQUIREMENTS: Record<ActOperation, string> = {
  click: "Click",
  "right-click": "RightClick",
  "set-value": "SetValue",
  clear: "SetValue",
  select: "Select",
  toggle: "Toggle",
  check: "Toggle",
  uncheck: "Toggle",
  expand: "Expand",
  collapse: "Collapse",
  "scroll-to": "Scroll",
};

const RUN_REQUIREMENTS: Partial<Record<RunOperation, string>> = {
  CLICK: "Click",
  RIGHT_CLICK: "RightClick",
  TYPE_TEXT: "SetValue",
  CLEAR: "SetValue",
  SELECT: "Select",
  CHECK: "Toggle",
  UNCHECK: "Toggle",
  EXPAND: "Expand",
  COLLAPSE: "Collapse",
  SCROLL_TO: "Scroll",
};

/** The AT-SPI action a canonical Operation requires, or `null` for view/terminal Operations. */
export function requiredAction(operation: ActOperation | RunOperation): string | null {
  const op = operation as ActOperation;
  if (op in ACT_REQUIREMENTS) return ACT_REQUIREMENTS[op];
  return RUN_REQUIREMENTS[operation as RunOperation] ?? null;
}

/**
 * The `agent-desktop` command for an Operation. `set-value`, `select`, and
 * `clear` take a value argument; the caller appends it.
 */
export function cliCommandFor(operation: ActOperation | RunOperation): string | null {
  switch (operation) {
    case "TYPE_TEXT":
      return "set-value";
    case "RIGHT_CLICK":
      return "right-click";
    case "SCROLL_TO":
      return "scroll-to";
    case "DRILL":
    case "WIDEN":
    case "WAIT":
    case "DONE":
    case "BLOCKED":
      return null;
    default:
      return String(operation).toLowerCase();
  }
}

const INFERENCE_PRIORITY: readonly ActOperation[] = [
  "click",
  "toggle",
  "check",
  "uncheck",
  "select",
  "set-value",
  "clear",
  "expand",
  "collapse",
  "scroll-to",
  "right-click",
];

export function inferOperation(advertised: readonly string[]): ActOperation | null {
  const lower = new Set(advertised.map((action) => action.toLowerCase()));
  for (const operation of INFERENCE_PRIORITY) {
    const requirement = requiredAction(operation);
    if (requirement && lower.has(requirement.toLowerCase())) return operation;
  }
  return null;
}

export interface ReconcileInput {
  /** Operation the decision model chose. */
  desired: ActOperation | RunOperation;
  /** The selected node's Advertised Actions. */
  advertised: readonly string[];
  /** The Intent/Goal needs text entry (from the decision model or supplied text). */
  textIntent?: boolean;
}

export interface ReconcileResult {
  operation: ActOperation | RunOperation | null;
  reconciled: boolean;
  why: string | null;
  /** True when policy must abstain because the target cannot receive text semantically. */
  abstain: boolean;
}

/**
 * Reconcile the chosen Operation against the target's Advertised Actions.
 *
 * Text entry is strict: a target that does not advertise `SetValue` can never
 * be typed into on Hyprland Wayland, so the step abstains instead of falling
 * back to an incompatible verb. Other operations are corrected to the best
 * action the node actually advertises (a readonly combobox receives `click`,
 * not `set-value`).
 */
export function reconcileOperation(input: ReconcileInput): ReconcileResult {
  const { desired, advertised, textIntent } = input;
  const requirement = requiredAction(desired);

  if (!requirement) {
    return { operation: desired, reconciled: false, why: null, abstain: false };
  }

  if (advertised.some((action) => action.toLowerCase() === requirement.toLowerCase())) {
    return { operation: desired, reconciled: false, why: null, abstain: false };
  }

  if (textIntent === true && !advertised.some((action) => action.toLowerCase() === "setvalue")) {
    return {
      operation: null,
      reconciled: false,
      why: SET_VALUE_ABSTAIN_REASON,
      abstain: true,
    };
  }

  const fallback = inferOperation(advertised);
  if (!fallback) {
    return {
      operation: null,
      reconciled: false,
      why: `target advertises no Wayland-safe Operation (offered: ${advertised.join(", ") || "none"})`,
      abstain: true,
    };
  }

  const asRun = mapActToRun(fallback);
  const operation = isRunOperation(desired) ? asRun : fallback;
  return {
    operation,
    reconciled: true,
    why: `${String(desired)} is not advertised; corrected to ${String(operation)} from [${advertised.join(", ")}]`,
    abstain: false,
  };
}

function isRunOperation(operation: string): operation is RunOperation {
  return (RUN_OPERATIONS as readonly string[]).includes(operation);
}

export function mapActToRun(operation: ActOperation): RunOperation {
  switch (operation) {
    case "right-click":
      return "RIGHT_CLICK";
    case "set-value":
      return "TYPE_TEXT";
    case "scroll-to":
      return "SCROLL_TO";
    default:
      return operation.toUpperCase() as RunOperation;
  }
}

export function mapRunToAct(operation: RunOperation): ActOperation | null {
  switch (operation) {
    case "RIGHT_CLICK":
      return "right-click";
    case "TYPE_TEXT":
      return "set-value";
    case "SCROLL_TO":
      return "scroll-to";
    case "CLICK":
      return "click";
    case "CLEAR":
      return "clear";
    case "SELECT":
      return "select";
    case "CHECK":
      return "check";
    case "UNCHECK":
      return "uncheck";
    case "EXPAND":
      return "expand";
    case "COLLAPSE":
      return "collapse";
    default:
      return null;
  }
}

/** True when the node advertises every action the Operation needs. */
export function supportsOperation(
  node: { available_actions?: string[] },
  operation: ActOperation | RunOperation,
): boolean {
  const requirement = requiredAction(operation);
  if (!requirement) return true;
  return advertises(node as any, requirement);
}
