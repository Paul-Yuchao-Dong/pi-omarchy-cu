/**
 * Display-environment recovery for stripped process environments.
 *
 * A Pi session launched from a Herdr server, a systemd unit, an SSH shell, or a
 * container often has `DBUS_SESSION_BUS_ADDRESS` (so AT-SPI works) but no
 * `WAYLAND_DISPLAY` / `DISPLAY` (so `agent-desktop list-apps` answers
 * PLATFORM_NOT_SUPPORTED). The compositor sockets are still discoverable, so
 * derive the two variables for the `agent-desktop` child. An explicit value
 * from the caller always wins.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const X11_SOCKET_DIR = "/tmp/.X11-unix";

export interface DisplayEnvOptions {
  uid?: number;
  exists?: (file: string) => boolean;
  readdir?: (dir: string) => string[];
  mtimeMs?: (file: string) => number;
}

export interface DerivedDisplay {
  waylandDisplay?: string;
  display?: string;
}

export interface DisplayFallbackResult {
  env: NodeJS.ProcessEnv;
  /** Values this call derived; empty when the caller already supplied them. */
  derived: DerivedDisplay;
}

function defaultExists(file: string): boolean {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

function defaultReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function defaultMtimeMs(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function runtimeDir(env: NodeJS.ProcessEnv, uid: number): string {
  const configured = env.XDG_RUNTIME_DIR?.trim();
  return configured && configured.length > 0 ? configured : `/run/user/${uid}`;
}

/**
 * The Wayland socket to use, or `null` when none exists.
 *
 * Sockets are named `wayland-<n>`. When several exist (nested compositors,
 * a stale socket after a restart), the most recently created one wins.
 */
export function findWaylandDisplay(
  env: NodeJS.ProcessEnv,
  options: DisplayEnvOptions = {},
): string | null {
  const readdir = options.readdir ?? defaultReaddir;
  const mtimeMs = options.mtimeMs ?? defaultMtimeMs;
  const dir = runtimeDir(env, options.uid ?? os.userInfo().uid);

  const sockets = readdir(dir)
    .filter((entry) => /^wayland-\d+$/.test(entry))
    .map((entry) => ({ entry, mtime: mtimeMs(path.join(dir, entry)) }))
    .sort((a, b) => b.mtime - a.mtime || Number(b.entry.slice(8)) - Number(a.entry.slice(8)));

  return sockets[0]?.entry ?? null;
}

/** The X11 (XWayland) display to use, e.g. `:0`, or `null` when none exists. */
export function findX11Display(options: DisplayEnvOptions = {}): string | null {
  const readdir = options.readdir ?? defaultReaddir;
  const exists = options.exists ?? defaultExists;

  const displays = readdir(X11_SOCKET_DIR)
    .map((entry) => entry.match(/^X(\d+)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b);

  for (const display of displays) {
    if (exists(path.join(X11_SOCKET_DIR, `X${display}`))) return `:${display}`;
  }
  return null;
}

/**
 * Fill in `WAYLAND_DISPLAY` and `DISPLAY` when they are missing. Existing
 * values are preserved, so an explicit environment always wins.
 */
export function withDisplayFallback(
  env: NodeJS.ProcessEnv,
  options: DisplayEnvOptions = {},
): DisplayFallbackResult {
  const next: NodeJS.ProcessEnv = { ...env };
  const derived: DerivedDisplay = {};

  if (!next.WAYLAND_DISPLAY?.trim()) {
    const wayland = findWaylandDisplay(next, options);
    if (wayland) {
      next.WAYLAND_DISPLAY = wayland;
      derived.waylandDisplay = wayland;
    }
  }

  if (!next.DISPLAY?.trim()) {
    const x11 = findX11Display(options);
    if (x11) {
      next.DISPLAY = x11;
      derived.display = x11;
    }
  }

  return { env: next, derived };
}
