import type { CuDeps } from "../types.js";
import { StatusParams } from "./schemas.js";
import { jsonResult, type CuTool } from "./shared.js";

export const STATUS_DESCRIPTION =
  "Report Omarchy computer-use readiness: agent-desktop binary and version, private state directory permissions, " +
  "AT-SPI bus status and supported surfaces, in-process Jev System One configuration (endpoint, model, key origin), " +
  "visible AT-SPI applications and Windows, and AT-SPI blind-spot warnings for running Chromium, Electron, or Qt " +
  "processes that are missing from the accessibility bus, with the exact launch flags or environment variables they need. " +
  "Call this first whenever a desktop read fails or a window is invisible to automation.";

/**
 * Build the readiness report. Shared by the `cu_status` tool and `/cu status`
 * so both surfaces can never disagree.
 */
export async function buildStatusReport(deps: CuDeps): Promise<unknown> {
  void deps;
  throw new Error("buildStatusReport is not implemented yet");
}

export function createStatusTool(deps: CuDeps): CuTool {
  return {
    name: "cu_status",
    label: "Computer Use Status",
    description: STATUS_DESCRIPTION,
    promptSnippet: "Check Omarchy computer-use readiness, AT-SPI bus health, and blind-spot warnings",
    promptGuidelines: [
      "Call cu_status before the first desktop interaction of a session, and again whenever cu_observe or cu_ref reports an AT-SPI blind spot.",
      "Report the exact remediation flags from cu_status to the user; never relaunch or kill their applications yourself.",
    ],
    parameters: StatusParams,
    async execute() {
      return jsonResult(await buildStatusReport(deps));
    },
  };
}
