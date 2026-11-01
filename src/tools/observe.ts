import type { CuDeps } from "../types.js";
import { ObserveParams } from "./schemas.js";
import { notImplemented, type CuTool } from "./shared.js";

export const OBSERVE_DESCRIPTION =
  "Read a live desktop Window, Region, or Overlay Surface over AT-SPI through agent-desktop. " +
  "`action: \"snapshot\"` (default) is an interactive-only, compact, bounds-included, shallow skeleton read " +
  "(`-i --compact --include-bounds --skeleton`) and automatically switches to an open Overlay Surface (sheet, alert, " +
  "menu, or popover) when neither `surface` nor a Region `root` Ref is given. Pass `root` or `maxDepth` for a deeper " +
  "Region read. `find`, `get`, `is`, and `list-surfaces` answer targeted questions without dumping the tree. " +
  "When `windowId` is pinned, a `root` or Overlay Surface from another Window is rejected rather than leaked. " +
  "Prefer cu_act for intent-driven steps; use cu_observe only when you need explicit tree inspection.";

export function createObserveTool(deps: CuDeps): CuTool {
  return {
    name: "cu_observe",
    label: "Computer Use Observe",
    description: OBSERVE_DESCRIPTION,
    promptSnippet: "Inspect a Window, Region, or Overlay Surface over AT-SPI without loading the tree into context by default",
    promptGuidelines: [
      "Use cu_observe for explicit inspection, and cu_act when you already know what you want to do.",
      "A skeleton read that truncates a Region is drilled with `root` (the returned ref), not by raising maxDepth blindly.",
      "When a dialog or menu is open, observe it; do not act on the occluded Window behind it.",
    ],
    parameters: ObserveParams,
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      void deps;
      return notImplemented("cu_observe");
    },
  };
}
