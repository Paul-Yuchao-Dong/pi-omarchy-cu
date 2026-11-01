/**
 * `cu_run`: drive a multi-step Goal through observe-decide-act-verify turns.
 *
 * Observation, execution, and confirmation live here; the loop policy lives in
 * `src/decide/loop.ts`. The accessibility tree never leaves this module: only
 * compact per-turn evidence reaches the model.
 */

import type {
  AdSnapshotData,
  CuContext,
  CuDeps,
  CuToolResult,
  DecisionRequest,
  RunOperation,
} from "../types.js";
import { buildRefArgs, refDelivery } from "../agent-desktop/ref.js";
import { NO_ACTIONABLE_NODES } from "../agent-desktop/apps.js";
import { appAliasNote, autoScopeApp, autoScopeNote, resolveAppName } from "../agent-desktop/scope.js";
import { targetLabel } from "../decide/shared.js";
import {
  DEFAULT_MAX_JEV_CALLS,
  DEFAULT_MAX_OPERATIONS,
  DEFAULT_MAX_UNCHANGED_TURNS,
  runGoalLoop,
  runLimits,
  type ConfirmRequest,
  type GoalLoopResult,
  type MutationOutcome,
  type ObserveOutcome,
  type RunTarget,
  type RunTurn,
} from "../decide/loop.js";
import { detectOverlay, screenFingerprint, snapshotWindowId } from "../desktop/tree.js";
import { isAbortError } from "../jev/abort.js";
import { mapRunToAct } from "../policy/operations.js";
import { confirmationMessage, confirmationTitle } from "../policy/route.js";
import { redactDeep, type TextSupply } from "../text/queue.js";
import { RunParams, type RunInput } from "./schemas.js";
import { overlaySwitchedNote, overlayUnreadableNote, snapshotArgs } from "./snapshot-args.js";
import {
  desktopErrorMessage,
  errorResult,
  formatForModel,
  textResult,
  type CuOnUpdate,
  type CuTool,
} from "./shared.js";

export const RUN_DESCRIPTION =
  "Drive a multi-turn plain-language Goal against a Window: observe shallowly, decide the next Operation with Jev System One, " +
  "confirm risky steps, act, verify, and repeat until the Goal is visibly satisfied (`stop: \"done\"`) or a stop condition is " +
  "reached. Operations are the Wayland-safe element Operations (CLICK, RIGHT_CLICK, TYPE_TEXT, CLEAR, SELECT, CHECK, UNCHECK, " +
  "EXPAND, COLLAPSE, SCROLL_TO), the non-mutating view Operations (DRILL into a truncated Region, WIDEN back to the Window), and " +
  "the terminal Operations (WAIT, DONE, BLOCKED). Destructive risk is rated before any confirmation, each turn is streamed via " +
  "progress updates, and loops stop on done, blocked, action_failed, window_closed, root_outside_window, surface_outside_window, " +
  `${DEFAULT_MAX_OPERATIONS} operations, ${DEFAULT_MAX_JEV_CALLS} decision calls, or ${DEFAULT_MAX_UNCHANGED_TURNS} consecutive ` +
  "non-WAIT turns with an unchanged screen fingerprint. Unscoped Goals are auto-scoped to the only foreground " +
  "application, loosely-named apps are resolved against `list-apps`, and terminal/TUI apps are reported as undrivable.";

/** Structured result details, alongside the model-facing JSON payload. */
export interface RunDetails {
  ok: boolean;
  stop: string;
  turns: number;
  operations: number;
  jev_calls: number;
  window: { app?: string | null; id?: string | null; title?: string | null };
  surface: string | null;
  region_root: string | null;
  recent_actions: unknown[];
  notes: string[];
  confirm?: unknown;
  code?: string;
}

type RunOptions = { signal?: AbortSignal; timeoutMs?: number };

/* -------------------------------------------------------------------------- */
/* Observation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The shallow Window read. A drilled read re-roots at the Region instead of
 * skeletonising, so the Region's withheld children are actually read.
 */
function windowSnapshotArgs(params: RunInput, root: string | null, app?: string | null): string[] {
  return snapshotArgs({
    app: app ?? params.app,
    windowId: params.windowId,
    root,
    timeoutMs: params.timeoutMs,
  });
}

/** The Overlay Surface read passes `-i` alone: agent-desktop forbids `--skeleton` on a surface. */
function surfaceSnapshotArgs(params: RunInput, surface: string, app?: string | null): string[] {
  return snapshotArgs({
    app: app ?? params.app,
    windowId: params.windowId,
    surface,
    timeoutMs: params.timeoutMs,
  });
}

function runOptions(params: RunInput, signal: AbortSignal | undefined): RunOptions {
  return { signal, ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }) };
}

function stopCode(envelopeErrorCode: string | undefined): string {
  return `error: ${(envelopeErrorCode ?? "agent_desktop_error").toLowerCase()}`;
}

/**
 * Read the Window (or the drilled Region), switching to an open Overlay Surface
 * when one owns interaction priority, and never leaking another Window's nodes.
 */
async function observeWindow(
  deps: CuDeps,
  params: RunInput,
  root: string | null,
  signal: AbortSignal | undefined,
): Promise<ObserveOutcome> {
  const scope = await autoScopeApp(deps, params, signal);
  const notes: string[] = [];
  if (scope.autoScopedApp) notes.push(autoScopeNote(scope.autoScopedApp));

  let app: string | null = scope.app ?? params.app ?? null;
  let windowCall = await deps.runner.run(windowSnapshotArgs(params, root, app), runOptions(params, signal));

  // Resolve a loosely-named application ("cliamp", "Files") against list-apps.
  let suggestions: string[] = [];
  if (!windowCall.envelope.ok && windowCall.envelope.error?.code === "APP_NOT_FOUND" && app) {
    const resolution = await resolveAppName(deps, app, signal);
    suggestions = resolution.matches;
    if (resolution.name && resolution.changed) {
      notes.push(appAliasNote(app, resolution.name));
      app = resolution.name;
      suggestions = [];
      windowCall = await deps.runner.run(windowSnapshotArgs(params, root, app), runOptions(params, signal));
    }
  }

  if (!windowCall.envelope.ok) {
    const enriched = desktopErrorMessage(windowCall.envelope, {
      app,
      candidates: scope.foreground,
      suggestions,
      action: root ? "snapshot --root" : "snapshot",
    });
    return {
      ok: false,
      stop: stopCode(enriched.code),
      code: enriched.code,
      message: enriched.message,
    };
  }
  let data = (windowCall.envelope.data ?? {}) as AdSnapshotData;
  let surface: string | null = null;

  const overlay = root === null ? detectOverlay(data) : null;
  if (overlay) {
    const surfaceCall = await deps.runner.run(surfaceSnapshotArgs(params, overlay.kind, app), runOptions(params, signal));
    if (surfaceCall.envelope.ok) {
      data = (surfaceCall.envelope.data ?? {}) as AdSnapshotData;
      surface = overlay.kind;
      notes.push(overlaySwitchedNote(overlay.kind));
    } else {
      notes.push(overlayUnreadableNote(overlay.kind, surfaceCall.envelope.error?.code ?? "error"));
    }
  }

  if (params.windowId) {
    const actual = snapshotWindowId(data);
    if (actual && actual !== params.windowId) {
      const code = surface ? "SURFACE_OUTSIDE_WINDOW" : "ROOT_OUTSIDE_WINDOW";
      const message = surface
        ? `the ${surface} Overlay Surface is owned by window ${actual}, not by pinned window ${params.windowId}`
        : `the observation landed on window ${actual}, not on pinned window ${params.windowId}`;
      return { ok: false, stop: stopCode(code), code, message };
    }
  }

  return {
    ok: true,
    observation: { data, surface, fingerprint: screenFingerprint(data), notes },
  };
}

/* -------------------------------------------------------------------------- */
/* Execution and confirmation                                                  */
/* -------------------------------------------------------------------------- */

async function mutateOperation(
  deps: CuDeps,
  params: RunInput,
  operation: RunOperation,
  target: RunTarget,
  text: string | undefined,
  signal: AbortSignal | undefined,
): Promise<MutationOutcome> {
  const action = mapRunToAct(operation);
  if (!action) {
    return {
      ok: false,
      delivery: "not_delivered",
      code: "INVALID_OPERATION",
      message: `${String(operation)} is not an element Operation`,
    };
  }
  const args = buildRefArgs(action, target.ref, {
    action,
    app: params.app,
    windowId: params.windowId,
    text,
  });
  const run = await deps.runner.run(args, runOptions(params, signal));
  const delivery = refDelivery(run.envelope).delivery ?? "not_delivered";
  if (!run.envelope.ok) {
    return {
      ok: false,
      delivery,
      code: run.envelope.error?.code ?? "AGENT_DESKTOP_ERROR",
      message: run.envelope.error?.message ?? `agent-desktop ${action} failed`,
    };
  }
  return { ok: true, delivery };
}

function windowLabel(window: { app?: string | null; id?: string | null; title?: string | null }): string {
  return window.title ?? window.id ?? window.app ?? "active Window";
}

async function confirmStep(
  ctx: CuContext | undefined,
  params: RunInput,
  request: ConfirmRequest,
): Promise<{ prompted: boolean; approved: boolean }> {
  const ui = ctx?.ui;
  if (!ctx?.hasUI || !ui || params.confirmPolicy === "return") return { prompted: false, approved: false };
  const approved = await ui.confirm(
    confirmationTitle(String(request.operation)),
    confirmationMessage({
      goal: params.goal,
      window: windowLabel(request.window),
      operation: String(request.operation),
      target: targetLabel(request.target),
      confidence: request.confidence,
      destructive: request.destructive,
      why: request.why,
    }),
  );
  return { prompted: true, approved };
}

/* -------------------------------------------------------------------------- */
/* Result shaping                                                              */
/* -------------------------------------------------------------------------- */

function isErrorStop(stop: string): boolean {
  return stop.startsWith("error:");
}

function runPayload(result: GoalLoopResult, redactText: boolean, noValues: boolean): RunDetails {
  const secrets = result.secrets;
  const redactRecent = redactText || noValues;
  const payload: RunDetails = {
    ok: !isErrorStop(result.stop),
    stop: result.stop,
    turns: result.turns.length,
    operations: result.operations,
    jev_calls: result.jevCalls,
    window: result.window,
    surface: result.surface,
    region_root: result.root,
    recent_actions: redactRecent ? redactDeep(result.recentActions, secrets) : result.recentActions,
    notes: result.notes,
    ...(result.confirm ? { confirm: result.confirm } : {}),
    ...(result.code ? { code: result.code } : {}),
  };
  return redactText ? redactDeep(payload, secrets) : payload;
}

function turnUpdate(turn: RunTurn): CuOnUpdate {
  return {
    content: [{ type: "text", text: formatForModel(turn) }],
    details: turn,
  };
}

/* -------------------------------------------------------------------------- */
/* Tool                                                                        */
/* -------------------------------------------------------------------------- */

export function createRunTool(deps: CuDeps): CuTool {
  return {
    name: "cu_run",
    label: "Computer Use Run",
    description: RUN_DESCRIPTION,
    promptSnippet: "Drive a multi-step Goal through observe-decide-act-verify turns and stop on done or a budget",
    promptGuidelines: [
      "Use cu_run for a Goal spanning several steps; use cu_act for one step and cu_observe when you need explicit inspection.",
      "Phrase the Goal as the visible end state, including the labels you expect to see, e.g. \"open Preferences and enable Dark Mode\".",
      "Supply `text` for typed values and menu option labels; TYPE_TEXT and SELECT both consume from that queue.",
      "When cu_run stops for confirmation without UI, ask the user in conversation, then re-run with confirmDestructive or execute the step with cu_act.",
    ],
    parameters: RunParams,
    async execute(
      _toolCallId: string,
      params: RunInput,
      signal: AbortSignal | undefined,
      onUpdate: ((update: CuOnUpdate) => void) | undefined,
      ctx: CuContext,
    ): Promise<CuToolResult<RunDetails>> {
      const requestSignal = signal ?? ctx?.signal;
      if (!deps.decision.isConfigured()) {
        return errorResult(
          "JEV_NOT_CONFIGURED",
          "Jev System One is not configured, so cu_run cannot drive a Goal. Resolve the credentials reported by cu_status.",
        );
      }

      let result: GoalLoopResult;
      try {
        result = await runGoalLoop(
          {
            goal: params.goal,
            window: { app: params.app ?? null, id: params.windowId ?? null, title: null },
            text: params.text as TextSupply,
            limits: runLimits(params),
            confirmDestructive: params.confirmDestructive === true,
            noValues: params.noValues === true,
            signal: requestSignal,
          },
          {
            observe: (root, callSignal) => observeWindow(deps, params, root, callSignal ?? requestSignal),
            mutate: (operation, target, text, callSignal) =>
              mutateOperation(deps, params, operation, target, text, callSignal ?? requestSignal),
            confirm: (request) => confirmStep(ctx, params, request),
            evaluate: (decisionRequest: DecisionRequest, callSignal?: AbortSignal) =>
              deps.decision.evaluate(decisionRequest, callSignal),
            onTurn: (turn) => onUpdate?.(turnUpdate(turn)),
          },
        );
      } catch (error) {
        if (isAbortError(error, requestSignal)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        return errorResult("DECISION_FAILED", `Jev System One request failed: ${message}`);
      }

      const payload = runPayload(result, params.redactText === true, params.noValues === true);
      return textResult(formatForModel(payload), payload, {
        ...(isErrorStop(result.stop) ? { isError: true } : {}),
      });
    },
  };
}
