/**
 * Shared `agent-desktop snapshot` argument construction.
 *
 * `cu_observe`, `cu_act`, `cu_run`, and the `cu_observe` containment probe read
 * the same desktop through the same CLI, so the flag set lives here once:
 *
 * - a Window overview is interactive-only, compact, bounds-included, and
 *   shallow (`-i --compact --include-bounds --skeleton`);
 * - a Region read re-roots at `--root` instead of skeletonising, so the withheld
 *   children are actually read;
 * - an automatic Overlay Surface re-read passes `-i` alone, because agent-desktop
 *   forbids `--skeleton` on a surface and popup trees are already small.
 *
 * Bounds and skeleton are defaulted on only for the shallow Window overview and
 * are never defaulted on for a surface or a Region; a caller that asks for them
 * explicitly gets them.
 */

export interface SnapshotNarrowing {
  app?: string | null;
  windowId?: string | null;
  timeoutMs?: number;
}

/** `--app` / `--window-id`, the narrowing shared by every Ref and snapshot command. */
export function narrowingArgs(input: Pick<SnapshotNarrowing, "app" | "windowId">): string[] {
  const args: string[] = [];
  if (input.app) args.push("--app", input.app);
  if (input.windowId) args.push("--window-id", input.windowId);
  return args;
}

export interface SnapshotArgsInput extends SnapshotNarrowing {
  /** Overlay Surface kind to read; mutually exclusive with `root`. */
  surface?: string | null;
  /** Region Ref to re-root the read at. */
  root?: string | null;
  maxDepth?: number;
  /** `-i`; defaults to true: every read path here is interactive-only. */
  interactiveOnly?: boolean;
  /** `--compact`; defaults to true for a Window or Region read and false for a surface. */
  compact?: boolean;
  /** `--include-bounds`; defaults to the shallow Window overview. */
  includeBounds?: boolean;
  /** `--skeleton`; defaults to the shallow Window overview. */
  skeleton?: boolean;
}

/** Build one `snapshot` invocation: `snapshot <narrowing> <read flags> <target>`. */
export function snapshotArgs(input: SnapshotArgsInput = {}): string[] {
  const surface = input.surface ?? null;
  const overview = surface === null && !input.root && input.maxDepth === undefined;
  const args = ["snapshot", ...narrowingArgs(input)];
  if (input.interactiveOnly !== false) args.push("-i");
  if (input.compact ?? (surface === null)) args.push("--compact");
  if (input.includeBounds ?? overview) args.push("--include-bounds");
  if (input.skeleton ?? overview) args.push("--skeleton");
  if (surface) args.push("--surface", surface);
  if (input.root) args.push("--root", input.root);
  if (input.maxDepth !== undefined) args.push("--max-depth", String(input.maxDepth));
  if (input.timeoutMs !== undefined) args.push("--timeout-ms", String(input.timeoutMs));
  return args;
}

/** The note a read path reports after switching from the Window to an open Overlay Surface. */
export function overlaySwitchedNote(kind: string): string {
  return `observed the open ${kind} Overlay Surface instead of the Window behind it`;
}

/** The note a read path reports when the open Overlay Surface could not be read. */
export function overlayUnreadableNote(kind: string, code: string): string {
  return `the open ${kind} Overlay Surface could not be read (${code}); observed the Window instead`;
}
