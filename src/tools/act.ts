import type { CuDeps } from "../types.js";
import { ActParams } from "./schemas.js";
import { notImplemented, type CuTool } from "./shared.js";

export const ACT_DESCRIPTION =
  "Resolve one plain-language Intent against the live Window or active Overlay Surface without reading the accessibility " +
  "tree into the agent's context, then optionally execute it. Inside the call the extension snapshots the active surface, " +
  "filters offerable Refs by their Advertised Actions, asks Jev System One for the target Ref, the Operation, presence, " +
  "destructive risk, and text need, reranks the top 5 candidates with richer descriptions when target confidence is below " +
  "0.70, reconciles the chosen Operation against the node's Advertised Actions over the 11 Wayland-safe Operations, applies " +
  "the deterministic Route Decision (act, confirm, abstain, needs_text), asks the user to confirm risky or ambiguous steps, " +
  "and executes. Defaults to a dry run (`execute: false`). Returns compact evidence, never the tree.";

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
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      void deps;
      return notImplemented("cu_act");
    },
  };
}
