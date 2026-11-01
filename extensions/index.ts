import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCuTools, createDeps } from "../src/extension.js";
import { CU_USAGE, runCuCommand } from "../src/commands/cu.js";
import { buildStatusReport } from "../src/tools/status.js";

export { createCuTools, createDeps } from "../src/extension.js";

export default function (pi: ExtensionAPI) {
  const deps = createDeps();

  for (const tool of createCuTools(deps)) {
    pi.registerTool(tool as any);
  }

  pi.registerCommand("cu", {
    description: "Omarchy computer-use diagnostics: /cu status, /cu apps, /cu windows",
    handler: async (args, ctx) => {
      const result = await runCuCommand(args, {
        runner: deps.runner,
        statusSummary: () => buildStatusReport(deps),
      });
      if (result.isError) {
        ctx.ui.notify(result.text, "error");
      } else {
        ctx.ui.notify(result.text, "info");
      }
      void CU_USAGE;
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const configured = deps.decision.isConfigured();
    ctx.ui.setStatus("cu", configured ? "cu: ready" : "cu: jev unconfigured");
  });
}
