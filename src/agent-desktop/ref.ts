/**
 * `agent-desktop` argument construction and envelope interpretation for `cu_ref`.
 *
 * Everything here is pure: the tool module owns validation, subprocess
 * invocation, and result shaping. ADR-0002 keeps this surface on AT-SPI Ref
 * operations plus `wl-clipboard`; no compositor input tools are reachable here.
 */

import { ACT_OPERATIONS, TEXT_OPERATIONS } from "../policy/operations.js";
import { narrowingArgs } from "../tools/snapshot-args.js";
import type { ActOperation, AdDisposition, AdEnvelope } from "../types.js";
import type { RefInput } from "../tools/schemas.js";

/** The Wayland-safe Ref operations this module can build a command for. */
export function isRefOperation(action: string): action is ActOperation {
  return (ACT_OPERATIONS as readonly string[]).includes(action);
}

/** `select` and `set-value` take the caller-supplied string as a positional argument. */
export function refNeedsText(action: ActOperation): boolean {
  return TEXT_OPERATIONS.has(action);
}

/** Accessibility variables every launched application receives so it joins the AT-SPI bus. */
const ACCESSIBILITY_ENV: ReadonlyArray<readonly [string, string]> = [
  ["ACCESSIBILITY_ENABLED", "1"],
  ["QT_LINUX_ACCESSIBILITY_ALWAYS_ON", "1"],
];

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
/** Extra subprocess headroom over the wait's own timeout so the CLI can report TIMEOUT itself. */
const WAIT_TIMEOUT_MARGIN_MS = 2_000;

/** Error codes `agent-desktop` returns when a node cannot accept semantic text. */
const HYPRLAND_SET_VALUE_ERROR_CODES: ReadonlySet<string> = new Set([
  "ACTION_NOT_SUPPORTED",
  "POLICY_DENIED",
]);

export const HYPRLAND_SET_VALUE_DIAGNOSTIC =
  "Hyprland Wayland diagnostic: this element does not advertise semantic SetValue, and physical keystroke input " +
  "(`type`/`press`) is unsupported on Hyprland Wayland. Do not retry this Operation; read the element's live state " +
  "and use a semantic Operation the element advertises.";

/** The Hyprland explanation for a failed text Operation, or `null` when it does not apply. */
export function setValueHyprlandDiagnostic(action: string, code: string): string | null {
  if (action !== "set-value" && action !== "clear") return null;
  if (!HYPRLAND_SET_VALUE_ERROR_CODES.has(code)) return null;
  return HYPRLAND_SET_VALUE_DIAGNOSTIC;
}

/**
 * `select <ref> <option>`, `set-value <ref> <value>`, every other Operation
 * `<command> <ref>`.
 *
 * A qualified Ref already names its snapshot and Window, so Ref commands accept
 * neither `--app` nor `--window-id`; passing them is an INVALID_ARGS failure
 * after a successful resolution.
 */
export function buildRefArgs(action: ActOperation, ref: string, input: RefInput): string[] {
  const args = [action, ref];
  if (refNeedsText(action) && input.text !== undefined) args.push(input.text);
  return args;
}

/** A `wait` blocks on a condition rather than pausing for an elapsed duration. */
function waitHasCondition(input: RefInput): boolean {
  return Boolean(
    input.element ||
      input.window ||
      input.text !== undefined ||
      input.menu ||
      input.menuClosed ||
      input.event,
  );
}

export function buildWaitArgs(input: RefInput): string[] {
  const args = ["wait"];
  if (input.ms !== undefined) args.push(String(input.ms));
  if (input.element) args.push("--element", input.element);
  if (input.predicate) args.push("--predicate", input.predicate);
  if (input.predicate === "value" && input.text !== undefined) args.push("--value", input.text);
  if (input.window) args.push("--window", input.window);
  if (input.text !== undefined && input.predicate !== "value") args.push("--text", input.text);
  if (input.menu) args.push("--menu");
  if (input.menuClosed) args.push("--menu-closed");
  if (input.event) args.push("--event", input.event);
  if (input.waitTimeoutMs !== undefined) args.push("--timeout", String(input.waitTimeoutMs));
  args.push(...narrowingArgs(input));
  return args;
}

/** Subprocess timeout: the requested wait duration plus headroom, never the 15s default. */
export function waitSubprocessTimeoutMs(input: RefInput): number {
  if (input.ms !== undefined && !waitHasCondition(input)) return input.ms + WAIT_TIMEOUT_MARGIN_MS;
  return (input.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS) + WAIT_TIMEOUT_MARGIN_MS;
}

export function buildClipboardArgs(
  action: "clipboard-get" | "clipboard-set" | "clipboard-clear",
  input: RefInput,
): string[] {
  switch (action) {
    case "clipboard-get":
      return input.format ? ["clipboard-get", "--format", input.format] : ["clipboard-get"];
    case "clipboard-set":
      return ["clipboard-set", input.text ?? ""];
    default:
      return ["clipboard-clear"];
  }
}

function launchEnvEntries(extra: RefInput["env"] = {}): Array<[string, string]> {
  const entries = ACCESSIBILITY_ENV.map(([key, value]): [string, string] => [key, value]);
  return [...entries, ...Object.entries(extra ?? {})];
}

export function buildLaunchArgs(app: string, input: RefInput): string[] {
  const args = ["launch", app];
  for (const [key, value] of launchEnvEntries(input.env)) args.push("--env", `${key}=${value}`);
  for (const arg of input.args ?? []) args.push(`--arg=${arg}`);
  if (input.cwd) args.push("--cwd", input.cwd);
  if (input.activate) args.push("--activate");
  return args;
}

/** `get <ref> --property value`; like every Ref command it takes no app/window narrowing. */
export function buildGetPropertyArgs(ref: string, property: string): string[] {
  return ["get", ref, "--property", property];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The Delivery Disposition `agent-desktop` reported for a successful command, if any. */
export function reportedDisposition(envelope: AdEnvelope): AdDisposition | undefined {
  const data = envelope.data;
  if (!isRecord(data) || !isRecord(data.disposition)) return undefined;
  const delivery = data.disposition.delivery;
  if (typeof delivery !== "string") return undefined;
  const retry = data.disposition.retry;
  return { delivery, ...(typeof retry === "string" ? { retry } : {}) };
}

/**
 * Delivery Disposition for a Ref Operation: a successful command without one is
 * `delivered_unverified`, an error is always `not_delivered`.
 */
export function refDelivery(envelope: AdEnvelope): AdDisposition {
  if (!envelope.ok) return errorDelivery(envelope);
  return reportedDisposition(envelope) ?? { delivery: "delivered_unverified" };
}

export function errorDelivery(envelope: AdEnvelope): AdDisposition {
  const retry = envelope.error?.disposition?.retry;
  return { delivery: "not_delivered", ...(typeof retry === "string" ? { retry } : {}) };
}
