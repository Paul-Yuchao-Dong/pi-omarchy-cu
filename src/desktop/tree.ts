/**
 * Accessibility-tree helpers shared by observation, intent resolution, and the
 * Goal loop.
 *
 * Pure functions over the `agent-desktop` snapshot shape: no I/O, so every
 * caller can be tested with canned envelopes.
 */

import { createHash } from "node:crypto";
import type { AdNode, AdSnapshotData, AdSurface } from "../types.js";

/** Overlay Surface kinds, in interaction-priority order (alert wins). */
export const OVERLAY_KINDS = ["alert", "sheet", "menu", "popover"] as const;
export type OverlayKind = (typeof OVERLAY_KINDS)[number];

export interface WalkedNode {
  node: AdNode;
  depth: number;
  parent: AdNode | null;
  parentRole: string | null;
  /** Roles from the root down to and including this node. */
  path: string[];
}

export function isOverlayKind(value: unknown): value is OverlayKind {
  return typeof value === "string" && (OVERLAY_KINDS as readonly string[]).includes(value);
}

export function walkNodes(tree: AdNode | undefined | null): WalkedNode[] {
  const out: WalkedNode[] = [];
  if (!tree) return out;

  const visit = (node: AdNode, depth: number, parent: AdNode | null, path: string[]): void => {
    const role = typeof node.role === "string" ? node.role.toLowerCase() : "";
    const nextPath = [...path, role];
    out.push({ node, depth, parent, parentRole: parent ? String(parent.role ?? "").toLowerCase() : null, path: nextPath });
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) visit(child, depth + 1, node, nextPath);
  };

  visit(tree, 0, null, []);
  return out;
}

export function refNodes(tree: AdNode | undefined | null): WalkedNode[] {
  return walkNodes(tree).filter(({ node }) => typeof node.ref_id === "string" && node.ref_id.length > 0);
}

export function findNodeByRef(tree: AdNode | undefined | null, ref: string): WalkedNode | null {
  return refNodes(tree).find(({ node }) => node.ref_id === ref) ?? null;
}

export function nodeActions(node: AdNode): string[] {
  const raw = node.available_actions;
  if (!Array.isArray(raw)) return [];
  return raw.filter((action): action is string => typeof action === "string");
}

export function nodeStates(node: AdNode): string[] {
  const raw = node.states;
  if (!Array.isArray(raw)) return [];
  return raw.filter((state): state is string => typeof state === "string").map((state) => state.toLowerCase());
}

export function hasState(node: AdNode, state: string): boolean {
  return nodeStates(node).includes(state.toLowerCase());
}

export function advertises(node: AdNode, action: string): boolean {
  const wanted = action.toLowerCase();
  return nodeActions(node).some((candidate) => candidate.toLowerCase() === wanted);
}

export interface OfferableOptions {
  /** Include nodes that advertises no action (observation only). */
  requireActions?: boolean;
}

/**
 * A node is offerable to the decision model when it is addressable, enabled,
 * visible, advertises at least one action, and does not duplicate its row's
 * action (a `cell` directly inside a `treeitem`).
 */
export function isOfferable(node: AdNode, parentRole: string | null, options: OfferableOptions = {}): boolean {
  if (typeof node.ref_id !== "string" || node.ref_id.length === 0) return false;
  if (hasState(node, "disabled") || hasState(node, "hidden")) return false;
  if (options.requireActions !== false && nodeActions(node).length === 0) return false;
  const role = String(node.role ?? "").toLowerCase();
  if (role === "cell" && parentRole === "treeitem") return false;
  return true;
}

export interface CandidateCollection {
  candidates: WalkedNode[];
  /** Offerable nodes found before the cap. */
  total: number;
  truncated: number;
  note: string | null;
}

export const MAX_CANDIDATES = 254;

export function collectCandidates(
  tree: AdNode | undefined | null,
  options: { max?: number; requireActions?: boolean } = {},
): CandidateCollection {
  const max = options.max ?? MAX_CANDIDATES;
  const offerable = walkNodes(tree).filter(({ node, parentRole }) =>
    isOfferable(node, parentRole, { requireActions: options.requireActions }),
  );
  const candidates = offerable.slice(0, max);
  const truncated = Math.max(0, offerable.length - candidates.length);
  return {
    candidates,
    total: offerable.length,
    truncated,
    note: truncated > 0 ? `capped at ${max} candidates; ${truncated} more were withheld` : null,
  };
}

/** A compact, model-facing description of one candidate node. */
export function describeNode(walked: WalkedNode, options: { rich?: boolean } = {}): string {
  const { node } = walked;
  const role = String(node.role ?? "element");
  const name = String(node.name ?? node.title ?? node.value ?? "").trim();
  const actions = nodeActions(node);
  const parts = [`${role}`, name ? `"${name}"` : "(unnamed)"];
  if (options.rich) {
    parts.push(`actions: ${actions.length ? actions.join(",") : "none"}`);
    const hidden = hiddenChildCount(node);
    if (hidden > 0) parts.push(`hidden_children: ${hidden}`);
    if (walked.parentRole) parts.push(`parent: ${walked.parentRole}`);
    const states = nodeStates(node);
    if (states.length) parts.push(`states: ${states.slice(0, 6).join(",")}`);
    if (typeof node.value === "string" && node.value && node.value !== name) {
      parts.push(`value: "${node.value.slice(0, 60)}"`);
    }
  }
  return `${node.ref_id} | ${parts.join(" | ")}`;
}

export function hiddenChildCount(node: AdNode): number {
  if (typeof node.children_count === "number") {
    const actual = Array.isArray(node.children) ? node.children.length : 0;
    return Math.max(0, node.children_count - actual);
  }
  return 0;
}

/** Truncated Regions: containers holding children withheld from a skeleton read. */
export function truncatedRegions(tree: AdNode | undefined | null): WalkedNode[] {
  return walkNodes(tree).filter(({ node }) => node.subtree_truncated === true || hiddenChildCount(node) > 0);
}

function surfaceKind(entry: AdSurface | string): string | null {
  if (typeof entry === "string") return entry.toLowerCase();
  const candidate = entry.kind ?? entry.surface ?? entry.role;
  return typeof candidate === "string" ? candidate.toLowerCase() : null;
}

/**
 * Detect an open Overlay Surface in a snapshot.
 *
 * `data.surfaces` is authoritative; a tree whose root is an overlay role also
 * counts, which covers menu frames reported as top-level frames.
 */
export function detectOverlay(
  data: AdSnapshotData | undefined | null,
): { kind: OverlayKind; surface: AdSurface | string | null } | null {
  if (!data) return null;
  const entries: Array<AdSurface | string> = [];
  if (Array.isArray(data.surfaces)) entries.push(...data.surfaces);
  if (data.surface) entries.push(data.surface);
  const byKind = new Map<OverlayKind, AdSurface | string | null>();
  for (const entry of entries) {
    const kind = surfaceKind(entry);
    if (isOverlayKind(kind) && !byKind.has(kind)) byKind.set(kind, entry);
  }

  const rootRole = String(data.tree?.role ?? "").toLowerCase();
  if (isOverlayKind(rootRole) && !byKind.has(rootRole)) byKind.set(rootRole, null);

  for (const { node } of walkNodes(data.tree)) {
    const role = String(node.role ?? "").toLowerCase();
    if (isOverlayKind(role) && !byKind.has(role)) byKind.set(role, null);
  }

  for (const kind of OVERLAY_KINDS) {
    if (byKind.has(kind)) return { kind, surface: byKind.get(kind) ?? null };
  }
  return null;
}

export function snapshotWindowId(data: AdSnapshotData | undefined | null): string | null {
  const id = data?.window?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** Stable SHA-1 screen fingerprint over roles, names, refs, and values. */
export function screenFingerprint(data: AdSnapshotData | undefined | null): string {
  const hash = createHash("sha1");
  for (const { node, depth } of walkNodes(data?.tree)) {
    hash.update(`${depth}\u0000${node.ref_id ?? ""}\u0000${node.role ?? ""}\u0000${node.name ?? ""}\u0000${node.value ?? ""}\u0000`);
    hash.update(`${nodeActions(node).join(",")}\u0000${nodeStates(node).sort().join(",")}\n`);
  }
  return hash.digest("hex");
}

export function nodeByNameOrRef(tree: AdNode | undefined | null, ref: string): WalkedNode | null {
  return findNodeByRef(tree, ref);
}
