import type {
  AdApp,
  AdEnvelope,
  AdListAppsData,
  AdListWindowsData,
  AdStatusData,
  AdWindowRef,
  BinarySource,
  CuDeps,
  JevConfigSummary,
  ProcessInfo,
  StateRootInfo,
} from "../types.js";
import { detectBlindSpots, type BlindSpotReport } from "./blind-spots.js";
import { StatusParams } from "./schemas.js";
import { jsonResult, type CuTool } from "./shared.js";

export const STATUS_DESCRIPTION =
  "Report Omarchy computer-use readiness: agent-desktop binary and version, private state directory permissions, " +
  "AT-SPI bus status and supported surfaces, in-process Jev System One configuration (endpoint, model, key origin), " +
  "visible AT-SPI applications and Windows, and AT-SPI blind-spot warnings for running Chromium, Electron, or Qt " +
  "processes that are missing from the accessibility bus, with the exact launch flags or environment variables they need. " +
  "Call this first whenever a desktop read fails or a window is invisible to automation.";

export interface StatusError {
  code: string;
  message: string;
  suggestion: string | null;
}

export interface StatusReport {
  /** The desktop observation path is usable: binary, private state root, AT-SPI bus, and app listing all work. */
  ready: boolean;
  binary: {
    found: boolean;
    path: string | null;
    source: BinarySource | null;
    version: string | null;
  };
  stateRoot: {
    path: string;
    /** Octal string, e.g. `0700`. Reported after enforcement, never assumed. */
    mode: string;
    private: boolean;
    created: boolean;
    problem: string | null;
  };
  atspi: {
    ready: boolean;
    platform: string | null;
    supportedSurfaces: string[];
    permissions: Record<string, { state?: string } & Record<string, unknown>>;
    sessionId: string | null;
    tracing: boolean | null;
    error: StatusError | null;
  };
  jev: JevConfigSummary;
  apps: { ok: boolean; apps: AdApp[]; error: StatusError | null };
  windows: { ok: boolean; windows: AdWindowRef[]; error: StatusError | null };
  blindSpots: BlindSpotReport;
  warnings: string[];
}

const BINARY_NOT_FOUND: StatusError = {
  code: "BINARY_NOT_FOUND",
  message: "agent-desktop executable not found",
  suggestion:
    "Install agent-desktop (npm install -g agent-desktop) or set AGENT_DESKTOP_BIN to its path.",
};

function statusError(envelope: AdEnvelope): StatusError {
  return {
    code: envelope.error?.code ?? "AGENT_DESKTOP_ERROR",
    message: envelope.error?.message ?? `agent-desktop ${envelope.command ?? "command"} failed`,
    suggestion: envelope.error?.suggestion ?? null,
  };
}

function describeError(error: StatusError): string {
  return `${error.code}: ${error.message}${error.suggestion ? ` — ${error.suggestion}` : ""}`;
}

function modeString(mode: number): string {
  return mode.toString(8).padStart(4, "0");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rows<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function desktopName(env: NodeJS.ProcessEnv | undefined): string | null {
  const raw = env?.XDG_CURRENT_DESKTOP ?? env?.XDG_SESSION_DESKTOP;
  return raw && raw.trim() ? raw.trim() : null;
}

/**
 * Enforce `0700` on the state root and report the mode that actually resulted.
 * A root that is still accessible to group or other users is reported as a
 * problem instead of silently passing.
 */
async function inspectStateRoot(deps: CuDeps): Promise<StatusReport["stateRoot"]> {
  const configuredPath = deps.runner.stateRoot();
  let info: StateRootInfo | null = null;
  let problem: string | null = null;
  try {
    info = await deps.runner.ensureStateRoot();
  } catch (error) {
    problem = `Could not create or chmod 0700 the state directory ${configuredPath}: ${errorMessage(error)}`;
  }

  const rootPath = info?.path ?? configuredPath;
  const mode = info?.mode ?? 0;
  const isPrivate = mode === 0o700;
  if (!isPrivate && problem === null) {
    problem = `State directory ${rootPath} has mode ${modeString(mode)}; agent-desktop requires a private 0700 root (chmod 700 ${rootPath}).`;
  }

  return {
    path: rootPath,
    mode: modeString(mode),
    private: isPrivate,
    created: info?.created ?? false,
    problem,
  };
}

/**
 * Build the readiness report. Shared by the `cu_status` tool and `/cu status`
 * so both surfaces can never disagree.
 *
 * A failing `status` or `list-apps` (no display server, no AT-SPI bus) is
 * readiness data, not an exception: the report says what is broken and why.
 */
export async function buildStatusReport(
  deps: CuDeps,
  options: { signal?: AbortSignal } = {},
): Promise<StatusReport> {
  const warnings: string[] = [];

  const resolution = deps.runner.resolve();
  if (!resolution) warnings.push(`Cannot check desktop readiness: ${describeError(BINARY_NOT_FOUND)}`);

  const stateRoot = await inspectStateRoot(deps);
  if (!stateRoot.private && stateRoot.problem) warnings.push(stateRoot.problem);

  const commands = resolution
    ? await Promise.all([
        deps.runner.run(["status"], { signal: options.signal }),
        deps.runner.run(["list-apps"], { signal: options.signal }),
        deps.runner.run(["list-windows"], { signal: options.signal }),
      ])
    : null;
  const statusEnvelope = commands?.[0].envelope ?? null;
  const appsEnvelope = commands?.[1].envelope ?? null;
  const windowsEnvelope = commands?.[2].envelope ?? null;

  const statusData = statusEnvelope?.ok
    ? ((statusEnvelope.data ?? {}) as AdStatusData)
    : ({} as AdStatusData);
  const supportedSurfaces = rows<unknown>(statusData.supported_surfaces).map(String);
  const atspiError =
    statusEnvelope === null ? BINARY_NOT_FOUND : statusEnvelope.ok ? null : statusError(statusEnvelope);
  const atspiReady = statusEnvelope !== null && statusEnvelope.ok && supportedSurfaces.length > 0;
  if (atspiError) {
    if (resolution) warnings.push(`AT-SPI status failed: ${describeError(atspiError)}`);
  } else if (!atspiReady) {
    warnings.push(
      "AT-SPI accessibility bus did not answer: status returned empty supported_surfaces. Run inside the graphical session; do not restart a bus you did not start.",
    );
  }

  const appsError =
    appsEnvelope === null ? BINARY_NOT_FOUND : appsEnvelope.ok ? null : statusError(appsEnvelope);
  const apps = appsEnvelope?.ok ? rows<AdApp>((appsEnvelope.data as AdListAppsData | undefined)?.apps) : [];
  if (appsError && resolution) warnings.push(`agent-desktop list-apps failed: ${describeError(appsError)}`);

  const windowsError =
    windowsEnvelope === null ? BINARY_NOT_FOUND : windowsEnvelope.ok ? null : statusError(windowsEnvelope);
  const windows = windowsEnvelope?.ok
    ? rows<AdWindowRef>((windowsEnvelope.data as AdListWindowsData | undefined)?.windows)
    : [];
  if (windowsError && resolution) {
    warnings.push(`agent-desktop list-windows failed: ${describeError(windowsError)}`);
  }

  const jev = deps.decision.describe();
  if (!jev.configured) {
    warnings.push(
      `Jev System One is not configured: ${jev.problem ?? "no usable endpoint or API key"}. cu_act and cu_run cannot resolve intents until it is.`,
    );
  }

  let processes: ProcessInfo[] | null = null;
  if (deps.listProcesses) {
    try {
      processes = await deps.listProcesses();
    } catch (error) {
      warnings.push(`Could not list desktop processes; the AT-SPI blind-spot check was skipped: ${errorMessage(error)}`);
    }
  } else {
    warnings.push("No process listing is configured; the AT-SPI blind-spot check was skipped.");
  }

  const blindSpots = detectBlindSpots({
    processes: processes ?? [],
    apps: processes !== null && appsEnvelope?.ok ? apps : null,
    unavailableReason:
      processes === null
        ? "The desktop process listing is unavailable, so an accessibility listing cannot prove there are no blind spots."
        : appsError
          ? `list-apps is unavailable (${describeError(appsError)})`
          : undefined,
    desktop: desktopName(deps.env),
  });
  for (const spot of blindSpots.detected) warnings.push(spot.message);
  warnings.push(...blindSpots.warnings);

  return {
    ready: Boolean(resolution) && stateRoot.private && atspiReady && appsError === null,
    binary: {
      found: resolution !== null,
      path: resolution?.binary ?? null,
      source: resolution?.source ?? null,
      version: typeof statusData.version === "string" ? statusData.version : null,
    },
    stateRoot,
    atspi: {
      ready: atspiReady,
      platform: typeof statusData.platform === "string" ? statusData.platform : null,
      supportedSurfaces,
      permissions: statusData.permissions ?? {},
      sessionId: statusData.session_id ?? null,
      tracing: typeof statusData.tracing === "boolean" ? statusData.tracing : null,
      error: atspiError,
    },
    jev,
    apps: { ok: appsEnvelope?.ok === true, apps, error: appsError },
    windows: { ok: windowsEnvelope?.ok === true, windows, error: windowsError },
    blindSpots,
    warnings,
  };
}

export function createStatusTool(deps: CuDeps): CuTool {
  return {
    name: "cu_status",
    label: "Computer Use Status",
    description: STATUS_DESCRIPTION,
    promptSnippet: "Check Omarchy computer-use readiness, AT-SPI bus health, and blind-spot warnings",
    promptGuidelines: [
      "Call cu_status before the first desktop interaction of a session, and again whenever cu_observe or cu_ref reports an AT-SPI blind spot.",
      "Report the exact remediation flags from cu_status to the user; never relaunch or kill their applications yourself.",
    ],
    parameters: StatusParams,
    async execute(_toolCallId, _params, signal) {
      return jsonResult(await buildStatusReport(deps, { signal }));
    },
  };
}
