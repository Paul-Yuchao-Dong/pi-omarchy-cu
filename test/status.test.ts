import assert from "node:assert/strict";
import { test } from "node:test";
import { runCuCommand } from "../src/commands/cu.js";
import { createCuTools } from "../src/extension.js";
import { buildStatusReport, type StatusReport } from "../src/tools/status.js";
import type { AdEnvelope, StateRootInfo } from "../src/types.js";
import { FakeCliRunner, makeContext, makeDeps, okEnvelope } from "./fakes.js";

const STATUS_DATA = {
  version: "1.0.2",
  platform: "linux",
  permissions: {
    accessibility: { state: "granted" },
    automation: { state: "not_required" },
    screen_recording: { state: "unknown" },
  },
  supported_surfaces: ["window", "sheet", "alert", "menu"],
  state_root: "/tmp/cu-fake-agent-desktop",
  session_id: null,
  tracing: false,
};

const APPS_DATA = {
  apps: [{ name: "Firefox", pid: 100, bundle_id: "firefox", presentation: "foreground" }],
};

const WINDOWS_DATA = {
  windows: [
    { id: "w-1", title: "Mozilla Firefox", app_name: "Firefox", pid: 100, is_focused: true, accessible: true },
  ],
};

function readinessCli(): FakeCliRunner {
  const cli = new FakeCliRunner();
  cli.respondByCommand({
    status: () => okEnvelope("status", STATUS_DATA),
    "list-apps": () => okEnvelope("list-apps", APPS_DATA),
    "list-windows": () => okEnvelope("list-windows", WINDOWS_DATA),
  });
  return cli;
}

function noDisplay(command: string): AdEnvelope {
  return {
    version: "2.5",
    ok: false,
    command,
    error: {
      code: "PLATFORM_NOT_SUPPORTED",
      message: "No display server is configured in this session",
      suggestion: "Run inside a desktop session with DISPLAY or WAYLAND_DISPLAY set",
      disposition: { delivery: "not_delivered", retry: "safe" },
    },
  };
}

async function readReport(
  cli: FakeCliRunner,
  options: {
    env?: NodeJS.ProcessEnv;
    processes?: Array<{ pid: number; command: string }>;
  } = {},
): Promise<StatusReport> {
  const deps = makeDeps({ cli, env: options.env, processes: options.processes });
  const [statusTool] = createCuTools(deps);
  const result = await statusTool.execute("call-1", {}, undefined, undefined, makeContext());
  assert.equal(result.isError, undefined);
  return JSON.parse(result.content[0].text) as StatusReport;
}

function warningMatching(report: StatusReport, pattern: RegExp): string {
  const warning = report.warnings.find((entry) => pattern.test(entry));
  assert.ok(warning, `expected a warning matching ${pattern}; got ${JSON.stringify(report.warnings)}`);
  return warning;
}

test("cu_status reports binary, private state root, AT-SPI readiness, Jev config, apps, and windows", async () => {
  const cli = readinessCli();
  const report = await readReport(cli);

  assert.deepEqual(report.binary, {
    found: true,
    path: "/fake/agent-desktop",
    source: "env",
    version: "1.0.2",
  });
  assert.equal(cli.ensures, 1, "the state root is enforced once before any read");
  assert.deepEqual(report.stateRoot, {
    path: "/tmp/cu-fake-agent-desktop",
    mode: "0700",
    private: true,
    created: false,
    problem: null,
  });
  assert.equal(report.atspi.ready, true);
  assert.equal(report.atspi.platform, "linux");
  assert.deepEqual(report.atspi.supportedSurfaces, ["window", "sheet", "alert", "menu"]);
  assert.equal(report.atspi.permissions.accessibility.state, "granted");
  assert.equal(report.atspi.error, null);
  assert.equal(report.jev.configured, true);
  assert.equal(report.jev.baseURL, "https://api.typesafe.ai/v1/systemone");
  assert.equal(report.jev.model, "jev-latest");
  assert.equal(report.jev.keyOrigin, "$TYPESAFE_API_KEY");
  assert.equal(report.apps.ok, true);
  assert.deepEqual(
    report.apps.apps.map((app) => app.name),
    ["Firefox"],
  );
  assert.equal(report.windows.ok, true);
  assert.deepEqual(
    report.windows.windows.map((window) => window.id),
    ["w-1"],
  );
  assert.equal(report.blindSpots.checked, true);
  assert.deepEqual(report.blindSpots.detected, []);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.ready, true);
  assert.deepEqual(cli.argLists("status"), [["status"]]);
  assert.deepEqual(cli.argLists("list-apps"), [["list-apps"]]);
  assert.deepEqual(cli.argLists("list-windows"), [["list-windows"]]);
});

test("cu_status reports a state root that is not 0700 instead of passing silently", async () => {
  class LooseStateRootRunner extends FakeCliRunner {
    async ensureStateRoot(): Promise<StateRootInfo> {
      return { path: this.root, mode: 0o755, created: false };
    }
  }

  const cli = new LooseStateRootRunner();
  const report = await readReport(cli);

  assert.equal(report.stateRoot.private, false);
  assert.equal(report.stateRoot.mode, "0755");
  const warning = warningMatching(report, /0700/);
  assert.match(warning, /chmod 700/);
  assert.equal(report.ready, false);
});

test("cu_status surfaces an unavailable AT-SPI bus and display as readiness data", async () => {
  const cli = new FakeCliRunner();
  cli.respondByCommand({
    status: () => noDisplay("status"),
    "list-apps": () => noDisplay("list-apps"),
    "list-windows": () => noDisplay("list-windows"),
  });

  const report = await readReport(cli);

  assert.equal(report.ready, false);
  assert.equal(report.atspi.ready, false);
  assert.deepEqual(report.atspi.supportedSurfaces, []);
  assert.equal(report.atspi.error?.code, "PLATFORM_NOT_SUPPORTED");
  assert.equal(report.apps.ok, false);
  assert.equal(report.apps.error?.code, "PLATFORM_NOT_SUPPORTED");
  assert.deepEqual(report.apps.apps, []);
  assert.equal(report.windows.ok, false);
  assert.deepEqual(report.windows.windows, []);
  assert.equal(report.blindSpots.checked, false);
  assert.match(String(report.blindSpots.reason), /PLATFORM_NOT_SUPPORTED/);
  const warning = warningMatching(report, /list-apps failed/);
  assert.match(warning, /Run inside a desktop session/);
});

test("cu_status reports a missing agent-desktop binary without throwing or spawning", async () => {
  const cli = readinessCli();
  cli.binary = null;

  const report = await readReport(cli);

  assert.equal(report.binary.found, false);
  assert.equal(report.binary.path, null);
  assert.equal(report.ready, false);
  assert.equal(report.atspi.error?.code, "BINARY_NOT_FOUND");
  assert.equal(report.blindSpots.checked, false);
  assert.equal(cli.calls.length, 0, "no subprocess is spawned without a binary");
  warningMatching(report, /AGENT_DESKTOP_BIN/);
});

test("cu_status reports Chromium, Electron, and Qt processes missing from the AT-SPI bus with exact remediation", async () => {
  const cli = readinessCli();
  const report = await readReport(cli, {
    env: { XDG_CURRENT_DESKTOP: "GNOME" },
    processes: [
      { pid: 4242, command: "/usr/lib/chromium/chromium --ozone-platform=wayland" },
      { pid: 4243, command: "/usr/lib/chromium/chromium --type=renderer" },
      { pid: 5151, command: "/usr/share/code/code --no-sandbox" },
      { pid: 6161, command: "/usr/bin/dolphin" },
    ],
  });

  assert.equal(report.blindSpots.checked, true);
  assert.deepEqual(
    report.blindSpots.detected.map((spot) => spot.kind),
    ["chromium", "electron", "qt"],
  );

  const [chromium, electron, qt] = report.blindSpots.detected;
  assert.deepEqual(
    chromium.processes.map((process) => process.pid),
    [4242],
    "the --type=renderer helper is not a separate blind spot",
  );
  assert.ok(chromium.remediation.some((line) => line.includes("ACCESSIBILITY_ENABLED=1")));
  assert.ok(chromium.remediation.some((line) => line.includes("--force-renderer-accessibility")));
  assert.ok(electron.remediation.some((line) => line.includes("no accessibility flag")));
  assert.ok(electron.remediation.some((line) => line.includes("--no-sandbox")));
  assert.ok(electron.remediation.some((line) => line.includes("chrome-sandbox")));
  assert.ok(qt.remediation.some((line) => line.includes("QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1")));

  warningMatching(report, /Chromium is running \(pid 4242\).*ACCESSIBILITY_ENABLED=1/);
  warningMatching(report, /Qt is running \(pid 6161\)/);
});

test("cu_status does not report desktop processes that are already on the AT-SPI bus", async () => {
  const cli = readinessCli();
  cli.respondByCommand({
    status: () => okEnvelope("status", STATUS_DATA),
    "list-apps": () =>
      okEnvelope("list-apps", {
        apps: [
          { name: "chromium", pid: 4242 },
          { name: "Visual Studio Code", pid: 5151 },
        ],
      }),
    "list-windows": () => okEnvelope("list-windows", WINDOWS_DATA),
  });

  const report = await readReport(cli, {
    env: { XDG_CURRENT_DESKTOP: "Hyprland" },
    processes: [
      { pid: 4242, command: "/usr/lib/chromium/chromium" },
      { pid: 5151, command: "/usr/share/code/code" },
      { pid: 9999, command: "/usr/lib/chromium/chromium --type=gpu-process" },
    ],
  });

  assert.deepEqual(report.blindSpots.detected, []);
});

test("cu_status warns about the Electron single-client bridge crash on non-GNOME desktops only", async () => {
  const cli = readinessCli();
  const hyprland = await readReport(cli, {
    env: { XDG_CURRENT_DESKTOP: "Hyprland" },
    processes: [{ pid: 5151, command: "/usr/share/code/code" }],
  });
  const warning = warningMatching(hyprland, /Electron single-client AT-SPI bridge hazard/);
  assert.match(warning, /SEGV/);
  assert.match(warning, /GNOME/);

  const gnome = await readReport(cli, {
    env: { XDG_CURRENT_DESKTOP: "GNOME" },
    processes: [{ pid: 5151, command: "/usr/share/code/code" }],
  });
  assert.equal(
    gnome.warnings.some((entry) => entry.includes("Electron single-client")),
    false,
  );
});

test("/cu status, apps, and windows print structured diagnostics and surface failures", async () => {
  const cli = readinessCli();
  const deps = makeDeps({ cli });
  const commandDeps = {
    runner: cli,
    statusSummary: () => buildStatusReport(deps),
  };

  const status = await runCuCommand("status", commandDeps);
  assert.equal(status.isError, undefined);
  assert.deepEqual(
    (JSON.parse(status.text) as StatusReport).atspi.supportedSurfaces,
    ["window", "sheet", "alert", "menu"],
  );

  const defaulted = await runCuCommand("", commandDeps);
  assert.deepEqual(JSON.parse(defaulted.text), JSON.parse(status.text));

  const apps = await runCuCommand("apps", commandDeps);
  assert.deepEqual(JSON.parse(apps.text), APPS_DATA);

  const windows = await runCuCommand("windows", commandDeps);
  assert.deepEqual(JSON.parse(windows.text), WINDOWS_DATA);

  const unknown = await runCuCommand("nonsense", commandDeps);
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /Unknown \/cu subcommand: nonsense/);
  assert.match(unknown.text, /\/cu status \| \/cu apps \| \/cu windows/);
});

test("/cu apps and /cu windows report the agent-desktop error code and message", async () => {
  const cli = new FakeCliRunner();
  cli.respondByCommand({
    "list-apps": () => noDisplay("list-apps"),
    "list-windows": () => noDisplay("list-windows"),
  });
  const commandDeps = { runner: cli, statusSummary: async () => ({}) };

  const apps = await runCuCommand("apps", commandDeps);
  assert.equal(apps.isError, true);
  assert.match(apps.text, /PLATFORM_NOT_SUPPORTED/);
  assert.match(apps.text, /No display server is configured/);

  const windows = await runCuCommand("windows", commandDeps);
  assert.equal(windows.isError, true);
  assert.match(windows.text, /PLATFORM_NOT_SUPPORTED/);
});
