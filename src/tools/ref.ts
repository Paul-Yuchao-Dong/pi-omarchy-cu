import type { ActOperation, AdEnvelope, CuContext, CuDeps, CuToolResult } from "../types.js";
import {
  buildClipboardArgs,
  buildGetPropertyArgs,
  buildLaunchArgs,
  buildRefArgs,
  buildWaitArgs,
  errorDelivery,
  isRefOperation,
  refDelivery,
  refNeedsText,
  reportedDisposition,
  setValueHyprlandDiagnostic,
  waitSubprocessTimeoutMs,
} from "../agent-desktop/ref.js";
import { RefParams, type RefInput } from "./schemas.js";
import {
  errorResult,
  envelopeError,
  isRecord,
  jsonResult,
  type CuOnUpdate,
  type CuTool,
} from "./shared.js";

export const REF_DESCRIPTION =
  "Execute one deterministic AT-SPI operation on an already-known Ref, without any decision model. " +
  "Ref operations: click, right-click, check, uncheck, toggle, expand, collapse, select, set-value, clear, scroll-to. " +
  "Each returns the Delivery Disposition (delivered_verified, delivered_unverified, not_delivered) and post-state evidence. " +
  "`set-value` failures caused by a missing SetValue advertise are explained with the Hyprland Wayland restriction " +
  "(physical `type`/`press` keystrokes are unavailable on this session). " +
  "Also supports `wait` (milliseconds, element predicate, window title, text, menu state, or desktop event), " +
  "`clipboard-get` / `clipboard-set` / `clipboard-clear` via wl-clipboard, and `launch`, which injects " +
  "ACCESSIBILITY_ENABLED=1 and QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 so new apps register on the AT-SPI bus.";

type RunOptions = { signal?: AbortSignal; timeoutMs?: number };

/** A caller mistake: no subprocess runs, and the code stays in the structured details. */
function paramError(code: string, message: string): CuToolResult {
  return errorResult(code, message, { code });
}

function commandOptions(params: RefInput, signal: AbortSignal | undefined): RunOptions {
  return {
    signal,
    ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
  };
}

/** Evidence for a mutating Ref Operation: disposition plus the envelope's own state proof. */
function refEvidence(envelope: AdEnvelope, action: string, ref: string): Record<string, unknown> {
  const data = isRecord(envelope.data) ? envelope.data : {};
  const evidence: Record<string, unknown> = { ok: true, command: action, ref, disposition: refDelivery(envelope) };
  for (const key of ["app", "window", "post_state", "steps", "surfaces"] as const) {
    if (data[key] !== undefined) evidence[key] = data[key];
  }
  return evidence;
}

function verifyEvidence(envelope: AdEnvelope): Record<string, unknown> {
  if (!envelope.ok) {
    return {
      property: "value",
      ok: false,
      code: envelope.error?.code ?? "AGENT_DESKTOP_ERROR",
      message: envelope.error?.message,
    };
  }
  const data = isRecord(envelope.data) ? envelope.data : {};
  return { property: "value", ok: true, value: data.value };
}

/** Evidence for `wait`, clipboard, and `launch`: the envelope data, in full. */
function dataEvidence(envelope: AdEnvelope, action: string): Record<string, unknown> {
  const evidence: Record<string, unknown> = { ok: true, command: action };
  const disposition = reportedDisposition(envelope);
  if (disposition) evidence.disposition = disposition;
  evidence.data = isRecord(envelope.data) ? envelope.data : {};
  return evidence;
}

function envelopeOutcome(envelope: AdEnvelope, action: string): CuToolResult {
  if (!envelope.ok) return envelopeError(envelope, action);
  return jsonResult(dataEvidence(envelope, action));
}

/**
 * A failed Ref Operation keeps `agent-desktop`'s code, message, and suggestion,
 * and adds the Hyprland explanation when the target could not accept text.
 */
function refFailure(envelope: AdEnvelope, action: string): CuToolResult {
  const code = envelope.error?.code ?? "AGENT_DESKTOP_ERROR";
  const diagnostic = setValueHyprlandDiagnostic(action, code);
  const base = envelopeError(envelope, action);
  const baseDetails = isRecord(base.details) ? base.details : {};
  const details: Record<string, unknown> = {
    ...baseDetails,
    command: action,
    code,
    message: envelope.error?.message,
    suggestion: envelope.error?.suggestion,
    disposition: errorDelivery(envelope),
    ...(diagnostic === null ? {} : { hyprlandDiagnostic: diagnostic }),
  };
  const text = base.content[0]?.text ?? "";
  return {
    content: [{ type: "text", text: diagnostic === null ? text : `${text}\n${diagnostic}` }],
    details,
    isError: true,
  };
}

async function runRefOperation(
  deps: CuDeps,
  action: ActOperation,
  params: RefInput,
  signal: AbortSignal | undefined,
): Promise<CuToolResult> {
  if (!params.ref) {
    return paramError(
      "REF_REQUIRED",
      `${action} requires \`ref\`: the Ref returned by cu_observe or cu_act for the target element.`,
    );
  }
  if (refNeedsText(action) && params.text === undefined) {
    return paramError("REF_TEXT_REQUIRED", `${action} requires \`text\`; cu_ref never invents a value.`);
  }

  const run = await deps.runner.run(buildRefArgs(action, params.ref, params), commandOptions(params, signal));
  if (!run.envelope.ok) return refFailure(run.envelope, action);

  const evidence = refEvidence(run.envelope, action, params.ref);
  if (params.verify === true) {
    const read = await deps.runner.run(
      buildGetPropertyArgs(params.ref, "value"),
      commandOptions(params, signal),
    );
    evidence.verify = verifyEvidence(read.envelope);
  }
  return jsonResult(evidence, evidence);
}

export function createRefTool(deps: CuDeps): CuTool {
  return {
    name: "cu_ref",
    label: "Computer Use Ref",
    description: REF_DESCRIPTION,
    promptSnippet: "Run a deterministic AT-SPI Ref operation, wait, clipboard command, or accessibility-enabled launch",
    promptGuidelines: [
      "cu_ref never guesses: it only acts on a Ref returned by cu_observe or cu_act.",
      "Never retry a Ref operation whose disposition is not not_delivered; read the target's live state first.",
      "Use cu_ref `wait` instead of a fixed sleep when a UI transition is asynchronous.",
      "Launch desktop apps through cu_ref `launch` so accessibility environment variables are injected.",
    ],
    parameters: RefParams,
    async execute(
      _toolCallId: string,
      params: RefInput,
      signal: AbortSignal | undefined,
      _onUpdate: ((update: CuOnUpdate) => void) | undefined,
      ctx: CuContext,
    ) {
      const requestSignal = signal ?? ctx?.signal;
      const action = params.action;
      if (isRefOperation(action)) return runRefOperation(deps, action, params, requestSignal);

      switch (action) {
        case "wait": {
          const run = await deps.runner.run(buildWaitArgs(params), {
            signal: requestSignal,
            timeoutMs: waitSubprocessTimeoutMs(params),
          });
          return envelopeOutcome(run.envelope, "wait");
        }
        case "clipboard-get":
        case "clipboard-set":
        case "clipboard-clear": {
          if (action === "clipboard-set" && params.text === undefined) {
            return paramError(
              "CLIPBOARD_TEXT_REQUIRED",
              "clipboard-set requires `text`: the string to place on the Wayland clipboard.",
            );
          }
          const run = await deps.runner.run(buildClipboardArgs(action, params), commandOptions(params, requestSignal));
          return envelopeOutcome(run.envelope, action);
        }
        case "launch": {
          if (!params.app) {
            return paramError(
              "LAUNCH_APP_REQUIRED",
              "launch requires `app`: the executable or desktop application to start.",
            );
          }
          const run = await deps.runner.run(buildLaunchArgs(params.app, params), commandOptions(params, requestSignal));
          return envelopeOutcome(run.envelope, "launch");
        }
        default:
          return paramError("UNKNOWN_ACTION", `cu_ref does not support action ${String(action)}`);
      }
    },
  };
}
