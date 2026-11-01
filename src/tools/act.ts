/**
 * `cu_act`: resolve one plain-language Intent against the live Window or
 * Overlay Surface and optionally execute it.
 *
 * The accessibility tree never leaves this module: only compact evidence about
 * the chosen target, Operation, Route Decision, and Delivery Disposition is
 * returned to the model.
 */

import type {
  AdSnapshotData,
  CuContext,
  CuDeps,
  CuToolResult,
  DeliveryDisposition,
  RouteDecision,
} from "../types.js";
import { buildRefArgs, refDelivery, refNeedsText } from "../agent-desktop/ref.js";
import {
  collectActCandidates,
  resolveActStep,
  type ActCandidateCollection,
  type ActStepResolution,
} from "../decide/act.js";
import { detectOverlay, snapshotWindowId } from "../desktop/tree.js";
import { targetLabel, targetPayload } from "../decide/shared.js";
import { isAbortError } from "../jev/abort.js";
import { confirmationMessage, confirmationTitle } from "../policy/route.js";
import { redactDeep, TextQueue } from "../text/queue.js";
import { ActParams, type ActInput } from "./schemas.js";
import { overlaySwitchedNote, overlayUnreadableNote, snapshotArgs } from "./snapshot-args.js";
import {
  envelopeError,
  errorResult,
  formatForModel,
  isRecord,
  textResult,
  type CuOnUpdate,
  type CuTool,
} from "./shared.js";

export const ACT_DESCRIPTION =
  "Resolve one plain-language Intent against the live Window or active Overlay Surface without reading the accessibility " +
  "tree into the agent's context, then optionally execute it. Inside the call the extension snapshots the active surface, " +
  "filters offerable Refs by their Advertised Actions, asks Jev System One for the target Ref, the Operation, presence, " +
  "destructive risk, and text need, reranks the top 5 candidates with richer descriptions when target confidence is below " +
  "0.70, reconciles the chosen Operation against the node's Advertised Actions over the 11 Wayland-safe Operations, applies " +
  "the deterministic Route Decision (act, confirm, abstain, needs_text), asks the user to confirm risky or ambiguous steps, " +
  "and executes. Defaults to a dry run (`execute: false`). Returns compact evidence, never the tree.";

/** Structured result details, alongside the model-facing JSON payload. */
export interface ActDetails {
  decision: RouteDecision;
  why: string;
  target: { ref: string; role: string; name: string } | null;
  operation: string | null;
  reconciled: boolean;
  reranked: boolean;
  confidence: number;
  present: number;
  destructive: number | null;
  execute: boolean;
  executed: boolean;
  delivery?: DeliveryDisposition;
  code?: string;
  confirmedByUser?: boolean;
  notes: string[];
  [key: string]: unknown;
}

type RunOptions = { signal?: AbortSignal; timeoutMs?: number };

/* -------------------------------------------------------------------------- */
/* Observation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `snapshot` arguments for the Intent observation: the Window read keeps the
 * shallow skeleton overview and a surface read passes `-i` alone.
 */
function actSnapshotArgs(params: ActInput, surface: string | null): string[] {
  const windowRead = surface === null;
  return snapshotArgs({
    app: params.app,
    windowId: params.windowId,
    surface,
    maxDepth: params.maxDepth,
    includeBounds: windowRead,
    skeleton: windowRead,
    timeoutMs: params.timeoutMs,
  });
}

function runOptions(params: ActInput, signal: AbortSignal | undefined): RunOptions {
  return {
    signal,
    ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
  };
}

interface Observation {
  data: AdSnapshotData;
  surface: string | null;
  autoSurface: boolean;
  notes: string[];
}

/**
 * Snapshot the active surface. When no explicit `surface` is pinned, an open
 * Overlay Surface takes priority over the Window behind it; if that surface
 * read fails (the popup vanished or the platform refused it) the Window read is
 * kept and the reason is reported.
 */
async function observeSurface(
  deps: CuDeps,
  params: ActInput,
  signal: AbortSignal | undefined,
): Promise<Observation | { error: CuToolResult }> {
  const pinned = params.surface ?? null;
  const first = await deps.runner.run(actSnapshotArgs(params, pinned), runOptions(params, signal));
  if (!first.envelope.ok) {
    return {
      error: envelopeError(first.envelope, pinned ? `snapshot --surface ${pinned}` : "snapshot"),
    };
  }
  const data = (first.envelope.data ?? {}) as AdSnapshotData;
  if (pinned) return { data, surface: pinned, autoSurface: false, notes: [] };

  const overlay = detectOverlay(data);
  if (!overlay) return { data, surface: null, autoSurface: false, notes: [] };

  const second = await deps.runner.run(actSnapshotArgs(params, overlay.kind), runOptions(params, signal));
  if (!second.envelope.ok) {
    return {
      data,
      surface: null,
      autoSurface: false,
      notes: [overlayUnreadableNote(overlay.kind, second.envelope.error?.code ?? "error")],
    };
  }
  return {
    data: (second.envelope.data ?? {}) as AdSnapshotData,
    surface: overlay.kind,
    autoSurface: true,
    notes: [overlaySwitchedNote(overlay.kind)],
  };
}

function windowLabel(data: AdSnapshotData, params: ActInput): string {
  const title = typeof data.window?.title === "string" ? data.window.title : null;
  const id = snapshotWindowId(data);
  return title ?? id ?? params.windowId ?? params.app ?? "active Window";
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                   */
/* -------------------------------------------------------------------------- */

interface ExecutionSuccess {
  ok: true;
  args: string[];
  delivery: DeliveryDisposition;
  postState?: unknown;
  steps?: unknown;
}

interface ExecutionFailure {
  ok: false;
  args: string[];
  delivery: DeliveryDisposition;
  code: string;
  message: string;
}

/**
 * Run the reconciled Operation through `agent-desktop`.
 *
 * Only `set-value` consumes a sensitive string: SELECT labels stay readable in
 * turn output because redacting them would corrupt real UI labels.
 */
async function executeStep(
  deps: CuDeps,
  step: ActStepResolution,
  params: ActInput,
  queue: TextQueue,
  signal: AbortSignal | undefined,
): Promise<ExecutionSuccess | ExecutionFailure> {
  const operation = step.operation!;
  const text = refNeedsText(operation)
    ? queue.take({ sensitive: operation === "set-value" })
    : undefined;
  const args = buildRefArgs(operation, step.target!.ref, {
    action: operation,
    app: params.app,
    windowId: params.windowId,
    text,
  });
  const run = await deps.runner.run(args, runOptions(params, signal));
  const delivery = refDelivery(run.envelope).delivery ?? "not_delivered";
  if (!run.envelope.ok) {
    return {
      ok: false,
      args,
      delivery,
      code: run.envelope.error?.code ?? "AGENT_DESKTOP_ERROR",
      message: run.envelope.error?.message ?? `agent-desktop ${operation} failed`,
    };
  }
  const data = isRecord(run.envelope.data) ? run.envelope.data : {};
  return {
    ok: true,
    args,
    delivery,
    ...(data.post_state === undefined ? {} : { postState: data.post_state }),
    ...(data.steps === undefined ? {} : { steps: data.steps }),
  };
}

/* -------------------------------------------------------------------------- */
/* Result shaping                                                              */
/* -------------------------------------------------------------------------- */

function actResult(
  payload: Record<string, unknown>,
  details: ActDetails,
  queue: TextQueue,
  redactText: boolean,
  options: { isError?: boolean } = {},
): CuToolResult {
  const model = redactText ? redactDeep(payload, queue.secrets) : payload;
  const rendered = formatForModel(model);
  return textResult(rendered, redactText ? redactDeep(details, queue.secrets) : details, options);
}

/** Assemble the model-facing payload from the resolution and any execution evidence. */
function resolutionPayload(
  step: ActStepResolution,
  observation: Observation,
  collection: ActCandidateCollection,
  params: ActInput,
  notes: string[],
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ok: true,
    decision: step.decision,
    why: step.why,
    bar: step.bar,
    target: targetPayload(step.target),
    operation: step.operation,
    reconciled: step.reconciled,
    reconciled_note: step.reconciledNote,
    reranked: step.reranked,
    confidence: step.confidence,
    present: step.present,
    destructive: step.destructive,
    surface: observation.surface,
    execute: params.execute === true,
    executed: false,
    notes,
  };
  if (collection.truncated > 0) payload.truncated = collection.truncated;
  return payload;
}

function detailsFrom(payload: Record<string, unknown>): ActDetails {
  return payload as unknown as ActDetails;
}

/* -------------------------------------------------------------------------- */
/* Tool                                                                        */
/* -------------------------------------------------------------------------- */

export function createActTool(deps: CuDeps): CuTool {
  return {
    name: "cu_act",
    label: "Computer Use Act",
    description: ACT_DESCRIPTION,
    promptSnippet: "Resolve and optionally execute one plain-language Intent against the live Window without reading the tree",
    promptGuidelines: [
      "State the Intent as the single step you want, quoting visible labels, e.g. \"turn on the Dark Mode switch\".",
      "cu_act defaults to a dry run; set execute: true only when you accept the step landing immediately.",
      "On decision abstain or needs_text, follow the returned reason instead of retrying the same Intent.",
      "Supply `text` when the Intent needs a typed value or a menu option label; the extension never invents strings.",
    ],
    parameters: ActParams,
    async execute(
      _toolCallId: string,
      params: ActInput,
      signal: AbortSignal | undefined,
      _onUpdate: ((update: CuOnUpdate) => void) | undefined,
      ctx: CuContext,
    ): Promise<CuToolResult> {
      const requestSignal = signal ?? ctx?.signal;
      if (!deps.decision.isConfigured()) {
        return errorResult(
          "JEV_NOT_CONFIGURED",
          "Jev System One is not configured, so cu_act cannot resolve an Intent. Resolve the credentials reported by cu_status.",
        );
      }

      const observation = await observeSurface(deps, params, requestSignal);
      if ("error" in observation) return observation.error;

      const queue = new TextQueue(params.text);
      const collection = collectActCandidates(observation.data.tree, { values: params.noValues !== true });

      let step: ActStepResolution;
      try {
        step = await resolveActStep({
          intent: params.intent,
          window: {
            app: typeof observation.data.app === "string" ? observation.data.app : params.app ?? null,
            id: snapshotWindowId(observation.data),
            title: typeof observation.data.window?.title === "string" ? observation.data.window.title : null,
          },
          surface: observation.surface,
          candidates: collection.candidates,
          textSupplied: !queue.empty,
          noValues: params.noValues === true,
          confirmDestructive: params.confirmDestructive === true,
          signal: requestSignal,
          evaluate: (request, callSignal) => deps.decision.evaluate(request, callSignal),
        });
      } catch (error) {
        if (isAbortError(error, requestSignal)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        return errorResult("DECISION_FAILED", `Jev System One request failed: ${message}`);
      }

      const notes = [
        ...observation.notes,
        ...(collection.note ? [collection.note] : []),
        ...step.notes,
      ];
      const payload = resolutionPayload(step, observation, collection, params, notes);

      const confirmRequired = step.decision === "confirm";
      let approved = false;
      if (params.execute === true && confirmRequired) {
        const ui = ctx?.ui;
        if (ctx?.hasUI && ui && params.confirmPolicy !== "return") {
          approved = await ui.confirm(
            confirmationTitle(String(step.operation)),
            confirmationMessage({
              intent: params.intent,
              window: windowLabel(observation.data, params),
              operation: String(step.operation),
              target: targetLabel(step.target!),
              confidence: step.confidence,
              destructive: step.destructive,
              why: step.why,
            }),
          );
        }
        if (!approved) {
          payload.delivery = "not_delivered";
          payload.code = "NOT_EXECUTED";
          notes.push(
            params.execute === true && ctx?.hasUI && ctx.ui && params.confirmPolicy !== "return"
              ? "the confirmation prompt was declined; no Operation was executed"
              : "confirmation is required but no interactive prompt is available; no Operation was executed",
          );
          const details = detailsFrom(payload);
          return actResult(payload, details, queue, params.redactText === true);
        }
      }

      if (params.execute !== true || (step.decision !== "act" && !approved)) {
        if (step.decision === "abstain" || step.decision === "needs_text") {
          notes.push("no Operation was executed");
        }
        const details = detailsFrom(payload);
        return actResult(payload, details, queue, params.redactText === true);
      }

      const execution = await executeStep(deps, step, params, queue, requestSignal);
      payload.executed = true;
      payload.args = execution.args;
      payload.delivery = execution.delivery;
      if (approved) payload.confirmedByUser = true;
      if (!execution.ok) {
        payload.ok = false;
        payload.code = execution.code;
        payload.message = execution.message;
        notes.push(`agent-desktop ${String(step.operation)} failed with ${execution.code}`);
        const details = detailsFrom(payload);
        return actResult(payload, details, queue, params.redactText === true, { isError: true });
      }
      if (execution.postState !== undefined) payload.post_state = execution.postState;
      if (execution.steps !== undefined) payload.steps = execution.steps;
      const details = detailsFrom(payload);
      return actResult(payload, details, queue, params.redactText === true);
    },
  };
}
