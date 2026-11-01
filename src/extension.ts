import { AgentDesktopCliRunner } from "./agent-desktop/runner.js";
import { SdkDecisionClient } from "./jev/client.js";
import { listProcessesWithPs } from "./system/processes.js";
import { createStatusTool } from "./tools/status.js";
import { createObserveTool } from "./tools/observe.js";
import { createRefTool } from "./tools/ref.js";
import { createActTool } from "./tools/act.js";
import { createRunTool } from "./tools/run.js";
import type { CuDeps } from "./types.js";

export interface CreateDepsOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  packageRoot?: string;
  agentDesktopBin?: string;
  jevModel?: string;
}

/**
 * Production wiring. Every dependency is replaceable, which is what makes the
 * tool seam the single test boundary.
 */
export function createDeps(options: CreateDepsOptions = {}): CuDeps {
  const env = options.env ?? process.env;
  const runner = new AgentDesktopCliRunner({
    env: options.agentDesktopBin
      ? { ...env, AGENT_DESKTOP_BIN: options.agentDesktopBin }
      : env,
    homedir: options.homedir,
    packageRoot: options.packageRoot,
  });
  const decision = new SdkDecisionClient({
    env,
    homedir: options.homedir,
    model: options.jevModel,
  });
  return {
    runner,
    decision,
    env,
    homedir: options.homedir,
    listProcesses: listProcessesWithPs,
  };
}

export function createCuTools(deps: CuDeps) {
  return [
    createStatusTool(deps),
    createObserveTool(deps),
    createRefTool(deps),
    createActTool(deps),
    createRunTool(deps),
  ];
}
