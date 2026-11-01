import type { TSchema } from "@sinclair/typebox";
import { desktopErrorGuidance, type DesktopErrorContext } from "../agent-desktop/scope.js";
import type {
  AdEnvelope,
  CuContentBlock,
  CuContext,
  CuToolResult,
} from "../types.js";

export interface CuOnUpdate {
  content: CuContentBlock[];
  details?: unknown;
}

export interface CuTool<TParams extends TSchema = TSchema, TDetails = unknown> {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: TParams;
  execute(
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: ((update: CuOnUpdate) => void) | undefined,
    ctx: CuContext,
  ): Promise<CuToolResult<TDetails>>;
}

/** Cap model-facing text so one observation can never flood the context window. */
export const MAX_RESULT_CHARS = 12_000;

export function formatForModel(value: unknown, maxChars = MAX_RESULT_CHARS): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated at ${maxChars} chars; narrow the request with app/windowId/root/limit]`;
}

export function textResult<TDetails>(
  text: string,
  details?: TDetails,
  options: { isError?: boolean } = {},
): CuToolResult<TDetails> {
  return {
    content: [{ type: "text", text }],
    ...(details === undefined ? {} : { details }),
    ...(options.isError ? { isError: true } : {}),
  };
}

export function jsonResult<TDetails>(payload: unknown, details?: TDetails): CuToolResult<TDetails> {
  return textResult(formatForModel(payload), details);
}

export function errorResult<TDetails>(
  code: string,
  message: string,
  details?: TDetails,
): CuToolResult<TDetails> {
  return textResult(formatForModel({ ok: false, code, message }), details, { isError: true });
}

export const NOT_IMPLEMENTED = "not implemented";

export function notImplemented(tool: string): CuToolResult {
  return errorResult("NOT_IMPLEMENTED", `${tool} is not implemented yet`);
}

/** Convert a failed `agent-desktop` envelope into a tool error, preserving its code. */
export function envelopeError(envelope: AdEnvelope, context?: string): CuToolResult {
  const error = envelope.error;
  const code = error?.code ?? "AGENT_DESKTOP_ERROR";
  const message = error?.message ?? `agent-desktop ${envelope.command ?? "command"} failed`;
  const suggestion = error?.suggestion ? ` Suggestion: ${error.suggestion}` : "";
  return errorResult(code, `${context ? `${context}: ` : ""}${message}${suggestion}`, {
    command: envelope.command,
    details: error?.details,
    disposition: error?.disposition,
  });
}

/**
 * A failed desktop read with a next-step sentence attached.
 *
 * `agent-desktop` reports codes and raw suggestions; this adds the facts only
 * the extension knows (ambiguous foreground scope, app not running, terminal
 * apps that can never join the bus).
 */
export function desktopErrorMessage(
  envelope: AdEnvelope,
  context: DesktopErrorContext & { action?: string } = {},
): { code: string; message: string; guidance: string | null } {
  const error = envelope.error;
  const code = error?.code ?? "AGENT_DESKTOP_ERROR";
  const base = error?.message ?? `agent-desktop ${envelope.command ?? "command"} failed`;
  const action = context.action ? `${context.action}: ` : "";
  const guidance = desktopErrorGuidance(envelope, context);
  return { code, message: guidance ? `${action}${base} — ${guidance}` : `${action}${base}`, guidance };
}

export function desktopErrorResult(
  envelope: AdEnvelope,
  context: DesktopErrorContext & { action?: string } = {},
): CuToolResult {
  const error = envelope.error;
  const { code, message, guidance } = desktopErrorMessage(envelope, context);
  return errorResult(code, message, {
    command: envelope.command,
    details: error?.details,
    disposition: error?.disposition,
    guidance,
  });
}

/** Compact JSON suitable for model-facing evidence. */
export function toJsonText(value: unknown): string {
  return JSON.stringify(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
