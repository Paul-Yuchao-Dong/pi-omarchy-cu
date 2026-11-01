/**
 * Parameter schemas for the five `cu_*` tools and the `/cu` command.
 *
 * These are the model-facing contract from the spec; behavior lives in the
 * per-tool modules.
 */

import { Type } from "@sinclair/typebox";

const literalUnion = <T extends readonly string[]>(values: T) =>
  Type.Union(values.map((value) => Type.Literal(value)) as any);

export const OBSERVE_ACTIONS = [
  "snapshot",
  "find",
  "get",
  "is",
  "list-surfaces",
] as const;

export const SURFACE_KINDS = [
  "window",
  "focused",
  "menu",
  "menubar",
  "sheet",
  "popover",
  "alert",
  "desktop",
  "taskbar",
  "system-tray",
  "quick-settings",
  "notification-center",
  "toolbar",
  "dock",
  "spotlight",
  "menu-bar-extras",
  "system-tray-overflow",
  "start-menu",
  "action-center",
] as const;

export const REF_ACTIONS = [
  "click",
  "right-click",
  "check",
  "uncheck",
  "toggle",
  "expand",
  "collapse",
  "select",
  "set-value",
  "clear",
  "scroll-to",
  "wait",
  "clipboard-get",
  "clipboard-set",
  "clipboard-clear",
  "launch",
] as const;

export const WAIT_PREDICATES = ["exists", "enabled", "visible", "actionable", "value"] as const;
export const WAIT_EVENTS = [
  "window-opened",
  "window-closed",
  "app-launched",
  "app-terminated",
  "focus-changed",
  "surface-appeared",
  "surface-dismissed",
] as const;
export const IS_PROPERTIES = ["visible", "enabled", "checked", "focused", "expanded", "selected"] as const;
export const GET_PROPERTIES = ["text", "value", "title", "bounds", "role", "states"] as const;

const TextSupply = Type.Union([Type.String(), Type.Array(Type.String())]);

export const StatusParams = Type.Object({});

export const ObserveParams = Type.Object({
  action: Type.Optional(
    literalUnion(OBSERVE_ACTIONS),
  ),
  app: Type.Optional(Type.String({ description: "Application name exactly as `list-apps` reports it." })),
  windowId: Type.Optional(Type.String({ description: "Opaque Window id from `list-windows`; pins every read to one Window." })),
  root: Type.Optional(Type.String({ description: "Ref of the Region to observe instead of the Window root (snapshot/find)." })),
  surface: Type.Optional(literalUnion(SURFACE_KINDS)),
  maxDepth: Type.Optional(Type.Number({ description: "Maximum tree depth (agent-desktop default 10)." })),
  interactiveOnly: Type.Optional(Type.Boolean({ description: "Keep interactive elements only (default true for snapshot)." })),
  compact: Type.Optional(Type.Boolean({ description: "Collapse empty wrappers (default true for snapshot)." })),
  includeBounds: Type.Optional(Type.Boolean({ description: "Include element bounds (default true for snapshot)." })),
  skeleton: Type.Optional(Type.Boolean({ description: "Shallow overview with children_count on truncated containers (default true for snapshot)." })),
  role: Type.Optional(Type.String({ description: "find: match by accessibility role." })),
  name: Type.Optional(Type.String({ description: "find: match by accessible name." })),
  text: Type.Optional(Type.String({ description: "find: match by text in name, value, title, or description." })),
  value: Type.Optional(Type.String({ description: "find: match by current value." })),
  state: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "find: state filter tokens, e.g. \"enabled\" or \"checked=false\"." })),
  exact: Type.Optional(Type.Boolean({ description: "find: require exact case-insensitive matches." })),
  limit: Type.Optional(Type.Number({ description: "find: maximum matches (agent-desktop default 50)." })),
  ref: Type.Optional(Type.String({ description: "get/is: the Ref to read." })),
  property: Type.Optional(Type.String({ description: "get: text|value|title|bounds|role|states. is: visible|enabled|checked|focused|expanded|selected." })),
  timeoutMs: Type.Optional(Type.Number({ description: "Observation deadline in milliseconds." })),
});

export const RefParams = Type.Object({
  action: literalUnion(REF_ACTIONS),
  app: Type.Optional(Type.String()),
  windowId: Type.Optional(Type.String()),
  ref: Type.Optional(Type.String({ description: "Qualified Ref from a snapshot (@<snapshot_id>:eN). Required for Ref operations." })),
  text: Type.Optional(Type.String({ description: "Value for set-value/select, text for clipboard-set, or wait --text." })),
  format: Type.Optional(Type.String({ description: "clipboard-get format: text|auto|image|file-urls." })),
  args: Type.Optional(Type.Array(Type.String(), { description: "launch: extra command-line arguments passed with --arg." })),
  env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "launch: extra environment variables (ACCESSIBILITY_ENABLED and QT_LINUX_ACCESSIBILITY_ALWAYS_ON are always injected)." })),
  cwd: Type.Optional(Type.String({ description: "launch: working directory." })),
  activate: Type.Optional(Type.Boolean({ description: "launch: bring the app forward and wait for a window." })),
  ms: Type.Optional(Type.Number({ description: "wait: elapsed milliseconds to pause." })),
  element: Type.Optional(Type.String({ description: "wait: Ref to poll." })),
  predicate: Type.Optional(literalUnion(WAIT_PREDICATES)),
  window: Type.Optional(Type.String({ description: "wait: block until a window with this title appears." })),
  event: Type.Optional(literalUnion(WAIT_EVENTS)),
  menu: Type.Optional(Type.Boolean({ description: "wait: block until a menu surface is open." })),
  menuClosed: Type.Optional(Type.Boolean({ description: "wait: block until the menu surface is dismissed." })),
  waitTimeoutMs: Type.Optional(Type.Number({ description: "wait: condition timeout (agent-desktop default 30000)." })),
  verify: Type.Optional(Type.Boolean({ description: "After a mutating Ref operation, read the target's post-state with get." })),
  timeoutMs: Type.Optional(Type.Number({ description: "Subprocess timeout override." })),
});

export const ActParams = Type.Object({
  intent: Type.String({ description: "One plain-language instruction describing a single step, e.g. \"press the List View button\"." }),
  app: Type.Optional(Type.String()),
  windowId: Type.Optional(Type.String()),
  surface: Type.Optional(literalUnion(SURFACE_KINDS)),
  execute: Type.Optional(Type.Boolean({ description: "Execute the resolved step. Default false: resolve and return the decision only." })),
  text: Type.Optional(TextSupply),
  confirmDestructive: Type.Optional(Type.Boolean({ description: "Force a Route Decision of confirm before executing." })),
  confirmPolicy: Type.Optional(literalUnion(["prompt", "return"] as const)),
  noValues: Type.Optional(Type.Boolean({ description: "Withhold live field values from the decision request." })),
  redactText: Type.Optional(Type.Boolean({ description: "Redact caller-supplied TYPE_TEXT strings from tool output." })),
  maxDepth: Type.Optional(Type.Number()),
  timeoutMs: Type.Optional(Type.Number()),
});

export const RunParams = Type.Object({
  goal: Type.String({ description: "Plain-language outcome to achieve across observe-decide-act turns." }),
  app: Type.Optional(Type.String()),
  windowId: Type.Optional(Type.String()),
  text: Type.Optional(TextSupply),
  confirmDestructive: Type.Optional(Type.Boolean()),
  confirmPolicy: Type.Optional(literalUnion(["prompt", "return"] as const)),
  noValues: Type.Optional(Type.Boolean()),
  redactText: Type.Optional(Type.Boolean()),
  maxOperations: Type.Optional(Type.Number({ description: "Operation budget (default 40)." })),
  maxJevCalls: Type.Optional(Type.Number({ description: "Decision-model call budget (default 80)." })),
  maxUnchangedTurns: Type.Optional(Type.Number({ description: "Consecutive non-WAIT turns allowed without a screen change (default 3)." })),
  timeoutMs: Type.Optional(Type.Number()),
});

export type StatusInput = { [key: string]: never };
export type ObserveInput = {
  action?: (typeof OBSERVE_ACTIONS)[number];
  app?: string;
  windowId?: string;
  root?: string;
  surface?: (typeof SURFACE_KINDS)[number];
  maxDepth?: number;
  interactiveOnly?: boolean;
  compact?: boolean;
  includeBounds?: boolean;
  skeleton?: boolean;
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  state?: string | string[];
  exact?: boolean;
  limit?: number;
  ref?: string;
  property?: string;
  timeoutMs?: number;
};
export type RefInput = {
  action: (typeof REF_ACTIONS)[number];
  app?: string;
  windowId?: string;
  ref?: string;
  text?: string;
  format?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  activate?: boolean;
  ms?: number;
  element?: string;
  predicate?: (typeof WAIT_PREDICATES)[number];
  window?: string;
  event?: (typeof WAIT_EVENTS)[number];
  menu?: boolean;
  menuClosed?: boolean;
  waitTimeoutMs?: number;
  verify?: boolean;
  timeoutMs?: number;
};
export type ActInput = {
  intent: string;
  app?: string;
  windowId?: string;
  surface?: (typeof SURFACE_KINDS)[number];
  execute?: boolean;
  text?: string | string[];
  confirmDestructive?: boolean;
  confirmPolicy?: "prompt" | "return";
  noValues?: boolean;
  redactText?: boolean;
  maxDepth?: number;
  timeoutMs?: number;
};
export type RunInput = {
  goal: string;
  app?: string;
  windowId?: string;
  text?: string | string[];
  confirmDestructive?: boolean;
  confirmPolicy?: "prompt" | "return";
  noValues?: boolean;
  redactText?: boolean;
  maxOperations?: number;
  maxJevCalls?: number;
  maxUnchangedTurns?: number;
  timeoutMs?: number;
};
