import type { CuDeps } from "../types.js";
import { RunParams } from "./schemas.js";
import { notImplemented, type CuTool } from "./shared.js";

export const RUN_DESCRIPTION =
  "Drive a multi-turn plain-language Goal against a Window: observe shallowly, decide the next Operation with Jev System One, " +
  "confirm risky steps, act, verify, and repeat until the Goal is visibly satisfied (`stop: \"done\"`) or a stop condition is " +
  "reached. Operations are the Wayland-safe element Operations (CLICK, RIGHT_CLICK, TYPE_TEXT, CLEAR, SELECT, CHECK, UNCHECK, " +
  "EXPAND, COLLAPSE, SCROLL_TO), the non-mutating view Operations (DRILL into a truncated Region, WIDEN back to the Window), and " +
  "the terminal Operations (WAIT, DONE, BLOCKED). Destructive risk is rated before any confirmation, each turn is streamed via " +
  "progress updates, and loops stop on done, blocked, action_failed, window_closed, root_outside_window, surface_outside_window, " +
  "40 operations, 80 decision calls, or 3 consecutive non-WAIT turns with an unchanged screen fingerprint.";

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
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      void deps;
      return notImplemented("cu_run");
    },
  };
}
