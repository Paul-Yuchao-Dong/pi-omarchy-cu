/**
 * AT-SPI blind-spot diagnostics.
 *
 * An application that runs without its toolkit's accessibility switch never
 * registers on the accessibility bus. `list-apps` then reports a healthy but
 * empty desktop, and every observation looks like a missing window instead of
 * a missing flag. `cu_status` cross-checks running desktop processes against
 * the `list-apps` names and reports the exact relaunch flags each toolkit
 * needs.
 *
 * The process check is deliberately heuristic: `ps` gives a command line and
 * nothing else, so executables are classified by name and by well-known
 * command-line markers. A process that is already registered on the bus is
 * never reported, which keeps the false positives out of the report.
 */

import * as path from "node:path";
import type { AdApp, ProcessInfo } from "../types.js";

export type BlindSpotKind = "chromium" | "electron" | "qt";

export interface BlindSpot {
  kind: BlindSpotKind;
  label: string;
  /** Every unregistered process of this kind; the parent process owns the accessibility bridge. */
  processes: ProcessInfo[];
  remediation: string[];
  /** One-line warning: the app is running but invisible to automation. */
  message: string;
}

export interface BlindSpotReport {
  /** `false` when `list-apps` failed: an empty result would be a false all-clear. */
  checked: boolean;
  reason: string | null;
  detected: BlindSpot[];
  warnings: string[];
}

export const CHROMIUM_REMEDIATION = [
  "Relaunch Chromium with ACCESSIBILITY_ENABLED=1 and --force-renderer-accessibility.",
  "ACCESSIBILITY_ENABLED=1 alone puts the browser on the bus with no windows; --force-renderer-accessibility is what exposes the renderer content.",
  "Relaunching loses tabs and state, so ask the user first; cu_status never relaunches or kills applications.",
];

export const QT_REMEDIATION = [
  "Relaunch the Qt application with QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 in its environment.",
  "QT_ACCESSIBILITY=1 is the equivalent toolkit switch; either variable must be set when the process starts, so the app has to restart.",
];

export const ELECTRON_REMEDIATION = [
  "Electron needs no accessibility flag to join the AT-SPI bus.",
  "Add --no-sandbox only where chrome-sandbox is not setuid; otherwise the app refuses to start.",
  "If the process started before the accessibility bus, restart it so it registers.",
];

export const ELECTRON_BRIDGE_WARNING =
  "Electron single-client AT-SPI bridge hazard: when agent-desktop is the only AT-SPI client, its disconnect can crash the Electron accessibility bridge (VS Code exits with SIGSEGV on press). A GNOME desktop keeps the shell connected, so this hazard applies to non-GNOME desktops such as Hyprland: keep another AT-SPI client connected and do not press keys against an active Electron app.";

const LABELS: Record<BlindSpotKind, string> = {
  chromium: "Chromium",
  electron: "Electron",
  qt: "Qt",
};

const REMEDIATION: Record<BlindSpotKind, string[]> = {
  chromium: CHROMIUM_REMEDIATION,
  electron: ELECTRON_REMEDIATION,
  qt: QT_REMEDIATION,
};

const KIND_ORDER: BlindSpotKind[] = ["chromium", "electron", "qt"];

const CHROMIUM_EXECUTABLES = new Set([
  "chromium",
  "chromium-browser",
  "chrome",
  "chrome-browser",
  "google-chrome",
  "google-chrome-stable",
  "brave",
  "brave-browser",
  "microsoft-edge",
  "microsoft-edge-stable",
  "vivaldi",
  "vivaldi-stable",
]);

const ELECTRON_EXECUTABLES = new Set([
  "code",
  "code-oss",
  "codium",
  "vscodium",
  "slack",
  "discord",
  "obsidian",
  "notion",
  "spotify",
  "figma",
  "signal-desktop",
  "element-desktop",
]);

const QT_EXECUTABLES = new Set([
  "dolphin",
  "okular",
  "gwenview",
  "kate",
  "kcalc",
  "ark",
  "kdenlive",
  "qbittorrent",
  "keepassxc",
  "telegram-desktop",
  "strawberry",
  "smplayer",
  "obs",
  "vlc",
]);

function executableName(token: string): string {
  const unquoted = token.replace(/^["']|["']$/g, "");
  return path.basename(unquoted).toLowerCase();
}

function appKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Classify one `ps` command line as a Chromium-family browser, an Electron
 * app, or a Qt app; `null` for everything else.
 */
export function classifyDesktopProcess(command: string): BlindSpotKind | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  // Chromium and Electron spawn `--type=` helper children that never own the
  // accessibility bridge; reporting them would duplicate the parent process.
  if (tokens.some((token) => token.startsWith("--type="))) return null;

  const executable = executableName(tokens[0]);
  if (CHROMIUM_EXECUTABLES.has(executable)) return "chromium";
  if (
    ELECTRON_EXECUTABLES.has(executable) ||
    tokens.some((token) => executableName(token) === "electron")
  ) {
    return "electron";
  }
  if (
    QT_EXECUTABLES.has(executable) ||
    tokens.some((token) => token === "-platform" || token.startsWith("-platformpluginpath")) ||
    /\/libqt[56]/i.test(command)
  ) {
    return "qt";
  }
  return null;
}

function isRegistered(process: ProcessInfo, apps: AdApp[]): boolean {
  if (apps.some((app) => typeof app.pid === "number" && app.pid === process.pid)) return true;
  const tokens = process.command.trim().split(/\s+/).filter(Boolean);
  const executable = tokens.length > 0 ? executableName(tokens[0]) : "";
  if (!executable) return false;
  const key = appKey(executable);
  return apps.some((app) => {
    if (typeof app.name !== "string" || app.name.trim() === "") return false;
    return (
      appKey(app.name) === key ||
      app.name.toLowerCase().split(/[^a-z0-9]+/).includes(executable)
    );
  });
}

function isGnomeDesktop(desktop: string | null | undefined): boolean {
  return typeof desktop === "string" && /gnome/i.test(desktop);
}

export interface DetectBlindSpotsOptions {
  processes: ProcessInfo[];
  /** `list-apps` rows, or `null` when the accessibility listing is unavailable. */
  apps: AdApp[] | null;
  /** Why the listing is unavailable; reported verbatim when `apps` is `null`. */
  unavailableReason?: string;
  /** `XDG_CURRENT_DESKTOP` / `XDG_SESSION_DESKTOP`; the Electron bridge hazard is GNOME-exempt. */
  desktop?: string | null;
}

export function detectBlindSpots(options: DetectBlindSpotsOptions): BlindSpotReport {
  const { processes, apps } = options;
  if (apps === null) {
    return {
      checked: false,
      reason: options.unavailableReason ?? "list-apps is unavailable, so blind spots cannot be detected",
      detected: [],
      warnings: [],
    };
  }

  const runningKinds = new Set<BlindSpotKind>();
  const unregistered = new Map<BlindSpotKind, ProcessInfo[]>();
  for (const process of processes) {
    const kind = classifyDesktopProcess(process.command);
    if (!kind) continue;
    runningKinds.add(kind);
    if (isRegistered(process, apps)) continue;
    const group = unregistered.get(kind) ?? [];
    group.push(process);
    unregistered.set(kind, group);
  }

  const detected: BlindSpot[] = [];
  for (const kind of KIND_ORDER) {
    const group = unregistered.get(kind);
    if (!group || group.length === 0) continue;
    const remediation = REMEDIATION[kind];
    const pids = group.map((process) => process.pid).join(", ");
    detected.push({
      kind,
      label: LABELS[kind],
      processes: group,
      remediation,
      message: `${LABELS[kind]} is running (pid ${pids}) but is not on the AT-SPI bus. ${remediation[0]}`,
    });
  }

  const warnings: string[] = [];
  if (runningKinds.has("electron") && !isGnomeDesktop(options.desktop)) {
    warnings.push(ELECTRON_BRIDGE_WARNING);
  }

  return { checked: true, reason: null, detected, warnings };
}
