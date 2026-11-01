/**
 * Observation scoping: pick the application a natural-language request means
 * when the caller did not name one, and turn desktop failures into next steps.
 */

import type { AdApp, AdEnvelope, CuDeps } from "../types.js";
import { appNotFoundGuidance, foregroundApps, matchAppName, windowNotFoundGuidance } from "./apps.js";

export interface AutoScope {
  /** Application to observe: the caller's, or the sole foreground application. */
  app: string | null;
  /** Set only when this scope was derived rather than requested. */
  autoScopedApp: string | null;
  /** Foreground application names seen, for ambiguous-scope guidance. */
  foreground: string[];
}

/**
 * Scope an unscoped observation to the only foreground application.
 *
 * With several foreground apps the request is ambiguous, so nothing is guessed;
 * the caller gets the names to choose from. `list-apps` is only consulted when
 * neither `app` nor `windowId` was supplied.
 */
export async function autoScopeApp(
  deps: CuDeps,
  input: { app?: string | null; windowId?: string | null },
  signal?: AbortSignal,
): Promise<AutoScope> {
  const requested = input.app ?? null;
  if (requested || input.windowId) {
    return { app: requested, autoScopedApp: null, foreground: [] };
  }

  const listed = await deps.runner.run(["list-apps"], signal ? { signal } : {});
  if (!listed.envelope.ok) return { app: null, autoScopedApp: null, foreground: [] };
  const apps = ((listed.envelope.data ?? {}) as { apps?: AdApp[] }).apps ?? [];
  const foreground = foregroundApps(apps);
  if (foreground.length === 1) {
    return { app: foreground[0], autoScopedApp: foreground[0], foreground };
  }
  return { app: null, autoScopedApp: null, foreground };
}

export interface AppResolution {
  /** Resolved name, or `null` when nothing matched. */
  name: string | null;
  /** Whether the name differs from the request (an alias/casing match). */
  changed: boolean;
  matches: string[];
}

/** Re-resolve a loosely-named application against `list-apps`. */
export async function resolveAppName(
  deps: CuDeps,
  requested: string,
  signal?: AbortSignal,
): Promise<AppResolution> {
  const listed = await deps.runner.run(["list-apps"], signal ? { signal } : {});
  if (!listed.envelope.ok) return { name: null, changed: false, matches: [] };
  const apps = ((listed.envelope.data ?? {}) as { apps?: AdApp[] }).apps ?? [];
  const match = matchAppName(requested, apps);
  return {
    name: match.name,
    changed: match.name !== null && match.name !== requested,
    matches: match.matches,
  };
}

export function autoScopeNote(app: string): string {
  return `auto-scoped to the only foreground application "${app}" because no app or windowId was given`;
}

export function appAliasNote(requested: string, resolved: string): string {
  return `resolved app "${requested}" to "${resolved}" from list-apps`;
}

export interface DesktopErrorContext {
  app?: string | null;
  /** Foreground app names when the scope was ambiguous. */
  candidates?: readonly string[];
  /** Names discovered from `list-apps`, for "did you mean" guidance. */
  suggestions?: readonly string[];
}

/**
 * A next-step sentence for a failed desktop read, or `null` when the failure
 * is not one this extension can explain better than `agent-desktop` already did.
 */
export function desktopErrorGuidance(
  envelope: AdEnvelope,
  context: DesktopErrorContext = {},
): string | null {
  const app = context.app ?? null;
  if (envelope.error?.code === "APP_NOT_FOUND") {
    const base = appNotFoundGuidance(app, envelope);
    if (!base) return null;
    const suggestions = context.suggestions ?? [];
    if (suggestions.length === 1) return `${base} Did you mean "${suggestions[0]}"?`;
    if (suggestions.length > 1) return `${base} Matching applications: ${suggestions.join(", ")}.`;
    return base;
  }
  if (envelope.error?.code === "WINDOW_NOT_FOUND") {
    return windowNotFoundGuidance(app, context.candidates ?? []);
  }
  return null;
}
