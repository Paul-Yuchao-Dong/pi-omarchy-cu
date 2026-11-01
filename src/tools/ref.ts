import type { CuDeps } from "../types.js";
import { RefParams } from "./schemas.js";
import { notImplemented, type CuTool } from "./shared.js";

export const REF_DESCRIPTION =
  "Execute one deterministic AT-SPI operation on an already-known Ref, without any decision model. " +
  "Ref operations: click, right-click, check, uncheck, toggle, expand, collapse, select, set-value, clear, scroll-to. " +
  "Each returns the Delivery Disposition (delivered_verified, delivered_unverified, not_delivered) and post-state evidence. " +
  "`set-value` failures caused by a missing SetValue advertise are explained with the Hyprland Wayland restriction " +
  "(physical `type`/`press` keystrokes are unavailable on this session). " +
  "Also supports `wait` (milliseconds, element predicate, window title, text, menu state, or desktop event), " +
  "`clipboard-get` / `clipboard-set` / `clipboard-clear` via wl-clipboard, and `launch`, which injects " +
  "ACCESSIBILITY_ENABLED=1 and QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 so new apps register on the AT-SPI bus.";

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
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      void deps;
      return notImplemented("cu_ref");
    },
  };
}
