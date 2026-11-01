import type { AdListSurfacesData, AdSnapshotData, CliRunOptions, CuDeps, CuToolResult } from "../types.js";
import { detectOverlay, findNodeByRef, snapshotWindowId, truncatedRegions, type OverlayKind } from "../desktop/tree.js";
import { ObserveParams, type ObserveInput } from "./schemas.js";
import { narrowingArgs, snapshotArgs } from "./snapshot-args.js";
import { envelopeError, errorResult, jsonResult, type CuTool } from "./shared.js";

export const OBSERVE_DESCRIPTION =
  "Read a live desktop Window, Region, or Overlay Surface over AT-SPI through agent-desktop. " +
  "`action: \"snapshot\"` (default) is an interactive-only, compact, bounds-included, shallow skeleton read " +
  "(`-i --compact --include-bounds --skeleton`) and automatically switches to an open Overlay Surface (sheet, alert, " +
  "menu, or popover) when neither `surface` nor a Region `root` Ref is given. Pass `root` or `maxDepth` for a deeper " +
  "Region read. `find`, `get`, `is`, and `list-surfaces` answer targeted questions without dumping the tree. " +
  "When `windowId` is pinned, a `root` or Overlay Surface from another Window is rejected rather than leaked. " +
  "Prefer cu_act for intent-driven steps; use cu_observe only when you need explicit tree inspection.";

/** Structured metadata returned alongside the model-facing JSON payload. */
export interface ObserveDetails {
  action: string;
  app?: string;
  windowId?: string;
  root?: string;
  surface?: string | null;
  autoSurface?: boolean;
  ref?: string;
  property?: string;
  snapshotId?: string | null;
  refCount?: number | null;
  complete?: boolean | null;
  truncated?: boolean | null;
  notes: string[];
}

type ObserveAction = NonNullable<ObserveInput["action"]>;

function timeoutArgs(params: ObserveInput): string[] {
  return params.timeoutMs === undefined ? [] : ["--timeout-ms", String(params.timeoutMs)];
}

function runOptions(params: ObserveInput, signal: AbortSignal | undefined): CliRunOptions {
  return { signal, timeoutMs: params.timeoutMs };
}

function hasDefaultDepth(params: ObserveInput): boolean {
  return params.root === undefined && params.maxDepth === undefined;
}

/**
 * `snapshot` arguments.
 *
 * A caller-requested read defaults to the shallow skeleton overview; an
 * explicit `root` or `maxDepth` replaces that default so the Region can be read
 * in detail. The automatic Overlay Surface re-read (`mode: "surface"`) passes
 * `-i` alone: agent-desktop forbids `--skeleton` on a surface and popup trees
 * are already small. `snapshot-args.ts` owns the flag order and the surface rule.
 */
function callerSnapshotArgs(
  params: ObserveInput,
  surfaceKind: OverlayKind | string | null,
  mode: "caller" | "surface",
): string[] {
  const surfaceRead = mode === "surface";
  return snapshotArgs({
    app: params.app,
    windowId: params.windowId,
    surface: surfaceKind,
    root: params.root ?? null,
    maxDepth: params.maxDepth,
    interactiveOnly: params.interactiveOnly !== false,
    compact: !surfaceRead && (params.compact === true || params.compact === undefined),
    includeBounds:
      !surfaceRead && (params.includeBounds === true || (params.includeBounds === undefined && hasDefaultDepth(params))),
    skeleton: !surfaceRead && (params.skeleton === true || (params.skeleton === undefined && hasDefaultDepth(params))),
    timeoutMs: params.timeoutMs,
  });
}

/**
 * Window-only read used to prove that a pinned `root` Ref belongs to the
 * pinned Window. Region Refs are harvested from interactive-only reads, so the
 * probe mirrors that filter.
 */
function containmentProbeArgs(params: ObserveInput): string[] {
  return snapshotArgs({
    app: params.app,
    windowId: params.windowId,
    interactiveOnly: params.interactiveOnly !== false,
    compact: true,
    includeBounds: false,
    skeleton: false,
    timeoutMs: params.timeoutMs,
  });
}

function rootOutsideWindow(params: ObserveInput, actualWindowId: string | null): CuToolResult {
  const reason = actualWindowId
    ? `window ${actualWindowId}`
    : `a Window other than ${params.windowId}`;
  const message =
    `root ${params.root} is not part of window ${params.windowId}; it belongs to ${reason}. ` +
    "Refs are Window-scoped: snapshot the pinned Window and use a Ref from that Window's tree.";
  return errorResult("root_outside_window", message, {
    action: "snapshot",
    windowId: params.windowId,
    root: params.root,
    notes: [message],
  });
}

function surfaceOutsideWindow(params: ObserveInput, surface: string, actualWindowId: string | null): CuToolResult {
  const actual = actualWindowId ?? "another Window";
  const message =
    `the ${surface} Overlay Surface is owned by ${actual}, not by pinned window ${params.windowId}; ` +
    "refusing to observe another Window's nodes.";
  return errorResult("surface_outside_window", message, {
    action: "snapshot",
    windowId: params.windowId,
    surface,
    notes: [message],
  });
}

function snapshotPayload(
  params: ObserveInput,
  data: AdSnapshotData,
  surface: { kind: string | null; auto: boolean },
): { payload: Record<string, unknown>; details: ObserveDetails } {
  const snapshotId = typeof data.snapshot_id === "string" ? data.snapshot_id : null;
  const refCount = typeof data.ref_count === "number" ? data.ref_count : null;
  const complete = data.complete !== false;
  const truncated = data.truncated === true;
  const notes: string[] = [];

  if (surface.auto) {
    notes.push(
      `an open ${surface.kind} Overlay Surface took observation priority over the Window; ` +
        "pass `surface` or a Region `root` to read the Window instead.",
    );
  }
  if (!complete || truncated) {
    notes.push("the snapshot is incomplete; narrow it with `root` or raise `maxDepth` before trusting the tree.");
  }
  const regions = truncatedRegions(data.tree);
  if (regions.length > 0) {
    const refs = regions
      .slice(0, 5)
      .map(({ node }) => node.ref_id)
      .filter((ref): ref is string => typeof ref === "string" && ref.length > 0);
    notes.push(
      `${regions.length} Region(s) were truncated by the shallow read` +
        (refs.length > 0 ? `; drill with root=${refs.join(" or root=")}` : ""),
    );
  }

  const app = data.app ?? params.app ?? null;
  const payload = {
    ok: true,
    action: "snapshot",
    app,
    window: data.window ?? null,
    surface: surface.kind,
    snapshot_id: snapshotId,
    ref_count: refCount,
    complete,
    truncated,
    nodes_observed: typeof data.nodes_observed === "number" ? data.nodes_observed : null,
    tree: data.tree ?? null,
    notes,
  };
  const details: ObserveDetails = {
    action: "snapshot",
    app: typeof app === "string" ? app : undefined,
    windowId: params.windowId,
    root: params.root,
    surface: surface.kind,
    autoSurface: surface.auto,
    snapshotId,
    refCount,
    complete,
    truncated,
    notes,
  };
  return { payload, details };
}

async function readSnapshot(
  deps: CuDeps,
  params: ObserveInput,
  surfaceKind: string | null,
  mode: "caller" | "surface",
  signal: AbortSignal | undefined,
): Promise<{ data: AdSnapshotData } | { error: CuToolResult }> {
  const args = callerSnapshotArgs(params, surfaceKind, mode);
  const call = await deps.runner.run(args, runOptions(params, signal));
  if (!call.envelope.ok) {
    return { error: envelopeError(call.envelope, surfaceKind ? `snapshot --surface ${surfaceKind}` : "snapshot") };
  }
  return { data: (call.envelope.data ?? {}) as AdSnapshotData };
}

/** Fail when a pinned `root` does not exist in the pinned Window's tree. */
async function verifyRootInWindow(
  deps: CuDeps,
  params: ObserveInput,
  signal: AbortSignal | undefined,
): Promise<CuToolResult | null> {
  if (!params.root || !params.windowId) return null;
  const call = await deps.runner.run(containmentProbeArgs(params), runOptions(params, signal));
  if (!call.envelope.ok) return envelopeError(call.envelope, "snapshot");
  const probe = (call.envelope.data ?? {}) as AdSnapshotData;
  if (findNodeByRef(probe.tree, params.root)) return null;
  return rootOutsideWindow(params, snapshotWindowId(probe));
}

async function observeSnapshot(
  deps: CuDeps,
  params: ObserveInput,
  signal: AbortSignal | undefined,
): Promise<CuToolResult> {
  if (params.root !== undefined && params.surface !== undefined) {
    return errorResult(
      "INVALID_ARGUMENT",
      "agent-desktop cannot combine a Region `root` with `surface`; pass one of them.",
      { action: "snapshot", windowId: params.windowId, root: params.root, surface: params.surface, notes: [] },
    );
  }

  const containment = await verifyRootInWindow(deps, params, signal);
  if (containment) return containment;

  let surface: string | null = params.surface ?? null;
  let autoSurface = false;
  let data: AdSnapshotData;

  if (surface) {
    const read = await readSnapshot(deps, params, surface, "caller", signal);
    if ("error" in read) return read.error;
    data = read.data;
  } else {
    const windowRead = await readSnapshot(deps, params, null, "caller", signal);
    if ("error" in windowRead) return windowRead.error;
    data = windowRead.data;

    const overlay = params.root === undefined ? detectOverlay(data) : null;
    if (overlay) {
      const surfaceRead = await readSnapshot(deps, params, overlay.kind, "surface", signal);
      if ("error" in surfaceRead) return surfaceRead.error;
      surface = overlay.kind;
      autoSurface = true;
      data = surfaceRead.data;
    }
  }

  if (params.windowId) {
    const actualWindowId = snapshotWindowId(data);
    if (actualWindowId && actualWindowId !== params.windowId) {
      return surface
        ? surfaceOutsideWindow(params, surface, actualWindowId)
        : rootOutsideWindow(params, actualWindowId);
    }
  }

  const { payload, details } = snapshotPayload(params, data, { kind: surface, auto: autoSurface });
  return jsonResult(payload, details);
}

function stateTokens(state: string | string[] | undefined): string[] {
  if (Array.isArray(state)) return state.filter((token) => token.length > 0);
  return typeof state === "string" && state.length > 0 ? [state] : [];
}

function findArgs(params: ObserveInput): string[] {
  const args = ["find", ...narrowingArgs(params)];
  if (params.root) args.push("--root", params.root);
  if (params.surface) args.push("--surface", params.surface);
  if (params.role !== undefined) args.push("--role", params.role);
  if (params.name !== undefined) args.push("--name", params.name);
  if (params.text !== undefined) args.push("--text", params.text);
  if (params.value !== undefined) args.push("--value", params.value);
  for (const token of stateTokens(params.state)) args.push("--state", token);
  if (params.exact === true) args.push("--exact");
  if (params.limit !== undefined) args.push("--limit", String(params.limit));
  args.push(...timeoutArgs(params));
  return args;
}

async function observeFind(deps: CuDeps, params: ObserveInput, signal: AbortSignal | undefined): Promise<CuToolResult> {
  const containment = await verifyRootInWindow(deps, params, signal);
  if (containment) return containment;

  const call = await deps.runner.run(findArgs(params), runOptions(params, signal));
  if (!call.envelope.ok) return envelopeError(call.envelope, "find");
  const data = (call.envelope.data ?? {}) as { snapshot_id?: string; matches?: unknown[]; match?: unknown };

  const matches = Array.isArray(data.matches) ? data.matches : data.match === undefined ? [] : [data.match];
  const notes: string[] = [];
  if (params.limit !== undefined && matches.length >= params.limit) {
    notes.push(`find returned the full limit (${params.limit}); narrow the filters or raise \`limit\` for more matches.`);
  }

  const payload = {
    ok: true,
    action: "find",
    app: params.app ?? null,
    snapshot_id: typeof data.snapshot_id === "string" ? data.snapshot_id : null,
    count: matches.length,
    matches,
    notes,
  };
  const details: ObserveDetails = {
    action: "find",
    app: params.app,
    windowId: params.windowId,
    root: params.root,
    surface: params.surface ?? null,
    snapshotId: payload.snapshot_id,
    notes,
  };
  return jsonResult(payload, details);
}

async function observeGetOrIs(
  deps: CuDeps,
  params: ObserveInput,
  action: "get" | "is",
  signal: AbortSignal | undefined,
): Promise<CuToolResult> {
  if (!params.ref) {
    return errorResult("INVALID_ARGUMENT", `cu_observe \`${action}\` requires a \`ref\` from a snapshot.`, {
      action,
      windowId: params.windowId,
      notes: [],
    });
  }

  const args = [action, params.ref, ...narrowingArgs(params)];
  if (params.property) args.push("--property", params.property);
  args.push(...timeoutArgs(params));

  const call = await deps.runner.run(args, runOptions(params, signal));
  if (!call.envelope.ok) return envelopeError(call.envelope, action);

  const data = (call.envelope.data ?? {}) as {
    ref?: string;
    property?: string;
    value?: unknown;
    result?: unknown;
    applicable?: unknown;
  };
  const property = data.property ?? params.property ?? null;
  const payload =
    action === "get"
      ? { ok: true, action, ref: params.ref, property, value: data.value ?? null, notes: [] }
      : { ok: true, action, ref: params.ref, property, result: data.result ?? null, applicable: data.applicable ?? null, notes: [] };
  const details: ObserveDetails = {
    action,
    app: params.app,
    windowId: params.windowId,
    ref: params.ref,
    property: property ?? undefined,
    notes: [],
  };
  return jsonResult(payload, details);
}

async function observeListSurfaces(
  deps: CuDeps,
  params: ObserveInput,
  signal: AbortSignal | undefined,
): Promise<CuToolResult> {
  const args = ["list-surfaces", ...narrowingArgs(params), ...timeoutArgs(params)];
  const call = await deps.runner.run(args, runOptions(params, signal));
  if (!call.envelope.ok) return envelopeError(call.envelope, "list-surfaces");

  const data = (call.envelope.data ?? {}) as AdListSurfacesData;
  const surfaces = Array.isArray(data.surfaces) ? data.surfaces : [];
  const windows = Array.isArray(data.windows) ? data.windows : [];
  const notes = surfaces.length === 0 ? ["no open surfaces were reported for this application."] : [];

  const payload = {
    ok: true,
    action: "list-surfaces",
    app: params.app ?? null,
    window_id: params.windowId ?? null,
    surfaces,
    windows,
    notes,
  };
  const details: ObserveDetails = {
    action: "list-surfaces",
    app: params.app,
    windowId: params.windowId,
    surface: null,
    notes,
  };
  return jsonResult(payload, details);
}

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
    async execute(_toolCallId, params: ObserveInput, signal, _onUpdate, ctx) {
      const requestSignal = signal ?? ctx?.signal;
      const action: ObserveAction = params.action ?? "snapshot";
      switch (action) {
        case "snapshot":
          return observeSnapshot(deps, params, requestSignal);
        case "find":
          return observeFind(deps, params, requestSignal);
        case "get":
        case "is":
          return observeGetOrIs(deps, params, action, requestSignal);
        case "list-surfaces":
          return observeListSurfaces(deps, params, requestSignal);
        default:
          return errorResult("INVALID_ARGUMENT", `cu_observe does not support action ${String(action)}.`, {
            action: String(action),
            notes: [],
          });
      }
    },
  };
}
