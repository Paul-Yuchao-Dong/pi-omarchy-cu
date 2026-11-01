/**
 * Application identity and accessibility guidance.
 *
 * Natural-language requests name applications loosely ("play ... on cliamp"),
 * and the interesting failures are not CLI errors but capability facts:
 * the app is not running, it runs but never joined the AT-SPI bus, or it is a
 * terminal/TUI that can never be driven through the accessibility tree.
 */

import type { AdApp, AdEnvelope } from "../types.js";

/** Terminal emulators: they host TUI content that AT-SPI cannot expose as refs. */
const TERMINAL_APPS = new Set([
  "foot",
  "footclient",
  "alacritty",
  "kitty",
  "wezterm",
  "ghostty",
  "konsole",
  "gnome-terminal",
  "gnome-terminal-server",
  "kgx",
  "xfce4-terminal",
  "terminator",
  "tilix",
  "st",
  "urxvt",
  "rxvt",
  "xterm",
  "contour",
  "rio",
  "tabby",
  "warp",
]);

export function isTerminalApp(name: string | null | undefined): boolean {
  if (!name) return false;
  const base = name.toLowerCase().split(/[\s/]/)[0] ?? "";
  return TERMINAL_APPS.has(base);
}

export function appName(app: AdApp): string | null {
  return typeof app.name === "string" && app.name.length > 0 ? app.name : null;
}

export function foregroundApps(apps: readonly AdApp[]): string[] {
  const names = apps
    .filter((app) => app.presentation === "foreground")
    .map((app) => appName(app))
    .filter((name): name is string => name !== null);
  return [...new Set(names)];
}

export function allAppNames(apps: readonly AdApp[]): string[] {
  return [...new Set(apps.map((app) => appName(app)).filter((name): name is string => name !== null))];
}

export interface AppMatch {
  /** A resolved application name, or `null` when the request is ambiguous or unknown. */
  name: string | null;
  /** Names that matched, for guidance when `name` is `null`. */
  matches: string[];
}

/**
 * Resolve a loosely-named application against `list-apps`: case-insensitive
 * exact match, then a unique substring match in either direction.
 */
export function matchAppName(requested: string, apps: readonly AdApp[]): AppMatch {
  const wanted = requested.trim().toLowerCase();
  if (!wanted) return { name: null, matches: [] };
  const names = allAppNames(apps);
  const exact = names.find((name) => name.toLowerCase() === wanted);
  if (exact) return { name: exact, matches: [exact] };
  const partial = names.filter((name) => {
    const lower = name.toLowerCase();
    return lower.includes(wanted) || wanted.includes(lower);
  });
  if (partial.length === 1) return { name: partial[0], matches: partial };
  return { name: null, matches: partial };
}

/** The process `agent-desktop` named when an app is running outside the bus. */
export function runningOutsideBus(envelope: AdEnvelope): string | null {
  const error = envelope.error;
  if (!error || error.code !== "APP_NOT_FOUND") return null;
  const details = (error.details ?? {}) as Record<string, unknown>;
  if (details.kind === "no_accessibility_connection") {
    return typeof details.process === "string" ? details.process : "the process";
  }
  if (typeof error.message === "string" && /is running \(pid \d+\) but is not on the accessibility bus/.test(error.message)) {
    return "the process";
  }
  return null;
}

export const NO_ACTIONABLE_NODES =
  "the observed Window exposes no actionable AT-SPI nodes (a terminal/TUI, a canvas, or a view that is still loading), " +
  "so no Operation can be resolved without coordinates; keystroke input is unsupported on Hyprland Wayland";

export function tuiGuidance(app: string): string {
  return (
    `"${app}" is a terminal/TUI application: terminal content never registers on the AT-SPI bus, and Hyprland Wayland ` +
    "blocks synthetic keystrokes, so pi-omarchy-cu cannot drive it. Use the shell, the application's own CLI, or its keybindings instead."
  );
}

/** Guidance for `APP_NOT_FOUND`, or `null` when the code is something else. */
export function appNotFoundGuidance(app: string | null, envelope: AdEnvelope): string | null {
  if (envelope.error?.code !== "APP_NOT_FOUND") return null;
  const outsideBus = runningOutsideBus(envelope);
  if (app && isTerminalApp(app)) return tuiGuidance(app);
  if (outsideBus) {
    const name = app ?? outsideBus;
    return (
      `"${name}" is running but does not register with the accessibility bus. GUI apps can be relaunched with accessibility ` +
      "enabled (Qt: QT_ACCESSIBILITY=1 or QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1; Chromium: ACCESSIBILITY_ENABLED=1 and " +
      "--force-renderer-accessibility; GTK and Electron normally register by themselves). Terminal/TUI apps (cliamp, nvim, " +
      "btop) never register and cannot be driven, because Hyprland Wayland blocks synthetic keystrokes: use the shell or the " +
      "app's own CLI instead."
    );
  }
  const name = app ?? "the application";
  return (
    `"${name}" is not running. Start it with cu_ref { action: "launch", app: "${name}" }, which injects ` +
    "ACCESSIBILITY_ENABLED=1 and QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1, then retry."
  );
}

/** Guidance for `WINDOW_NOT_FOUND`, or `null` when the code is something else. */
export function windowNotFoundGuidance(
  app: string | null,
  candidates: readonly string[],
): string | null {
  if (candidates.length > 1) {
    return `No Window was selected and several foreground applications are registered (${candidates.join(", ")}); pass \`app\` or \`windowId\`.`;
  }
  if (app) {
    return (
      `"${app}" has no accessible Window yet: it may be windowless, background-only, or still starting. Retry after a \`cu_ref\` ` +
      "`wait`, or choose another application from cu_status."
    );
  }
  return "No focused Window was found. Pass `app` (from cu_status apps) or `windowId` (from cu_status windows).";
}
