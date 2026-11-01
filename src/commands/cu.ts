/**
 * `/cu` interactive diagnostics: zero-token terminal inspection.
 *
 * Supported: `/cu status`, `/cu apps`, `/cu windows`.
 */

import type { CliRunner, CuToolResult } from "../types.js";
import { formatForModel } from "../tools/shared.js";

export const CU_USAGE = "Usage: /cu status | /cu apps | /cu windows";

export interface CuCommandDeps {
  runner: CliRunner;
  statusSummary: () => Promise<unknown>;
}

export interface CuCommandResult {
  text: string;
  isError?: boolean;
}

export async function runCuCommand(args: string, deps: CuCommandDeps): Promise<CuCommandResult> {
  const sub = args.trim().split(/\s+/)[0] ?? "";
  switch (sub) {
    case "":
    case "status": {
      const summary = await deps.statusSummary();
      return { text: formatForModel(summary, 6000) };
    }
    case "apps": {
      const result = await deps.runner.run(["list-apps"]);
      if (!result.envelope.ok) {
        return {
          text: `agent-desktop list-apps failed: ${result.envelope.error?.code ?? "ERROR"} ${result.envelope.error?.message ?? ""}`.trim(),
          isError: true,
        };
      }
      return { text: formatForModel(result.envelope.data ?? {}, 6000) };
    }
    case "windows": {
      const result = await deps.runner.run(["list-windows"]);
      if (!result.envelope.ok) {
        return {
          text: `agent-desktop list-windows failed: ${result.envelope.error?.code ?? "ERROR"} ${result.envelope.error?.message ?? ""}`.trim(),
          isError: true,
        };
      }
      return { text: formatForModel(result.envelope.data ?? {}, 6000) };
    }
    default:
      return { text: `Unknown /cu subcommand: ${sub}\n${CU_USAGE}`, isError: true };
  }
}

export function cuToolResult(result: CuCommandResult): CuToolResult {
  return {
    content: [{ type: "text", text: result.text }],
    ...(result.isError ? { isError: true } : {}),
  };
}
