/**
 * Helpers shared by the two decision models: `cu_act` resolves one Intent and
 * the `cu_run` loop plans one turn, but both describe the same Window, the same
 * nodes, and the same target vocabulary, so those pieces live here once.
 */

import type { AdNode } from "../types.js";

/** The Window an operation targets, as reported to the decision model. */
export interface ActWindow {
  app?: string | null;
  id?: string | null;
  title?: string | null;
}

/** The identity every offered target carries. */
export interface NodeIdentity {
  ref: string;
  role: string;
  name: string;
}

/** The Ref, role, and accessible name of one walked node. */
export function nodeIdentity(node: AdNode): NodeIdentity {
  return {
    ref: String(node.ref_id ?? ""),
    role: String(node.role ?? "element"),
    name: String(node.name ?? node.title ?? ""),
  };
}

/** The `window` object sent to System One; empty fields are omitted. */
export function windowState(window: ActWindow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (window.app) out.app = window.app;
  if (window.id) out.id = window.id;
  if (window.title) out.title = window.title;
  return out;
}

/** `role "name" (ref)`, the shape both confirmation prompts and stop reasons use. */
export function targetLabel(target: NodeIdentity): string {
  const name = target.name ? ` "${target.name}"` : "";
  return `${target.role}${name} (${target.ref})`;
}

/** The target as reported in tool output and turn records. */
export function targetPayload(target: NodeIdentity | null): NodeIdentity | null {
  return target ? { ref: target.ref, role: target.role, name: target.name } : null;
}
