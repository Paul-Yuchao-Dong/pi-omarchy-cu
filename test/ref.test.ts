import assert from "node:assert/strict";
import { test } from "node:test";
import { createCuTools } from "../src/extension.js";
import { ACT_OPERATIONS } from "../src/policy/operations.js";
import { REF_ACTIONS, type RefInput } from "../src/tools/schemas.js";
import type { AdEnvelope } from "../src/types.js";
import { FakeCliRunner, errEnvelope, makeContext, makeDeps, okEnvelope } from "./fakes.js";

const REF = "@snap-1:e7";

function cuRef(cli: FakeCliRunner) {
  const tool = createCuTools(makeDeps({ cli }))[2];
  assert.ok(tool);
  return tool;
}

async function callRef(
  params: RefInput,
  cli: FakeCliRunner,
  options: { signal?: AbortSignal } = {},
) {
  return cuRef(cli).execute("call-1", params, options.signal, undefined, makeContext());
}

function evidenceOf(result: { content: Array<{ text: string }> }): Record<string, any> {
  return JSON.parse(result.content[0]!.text);
}

function detailsOf(result: { details?: unknown }): Record<string, any> {
  return (result.details ?? {}) as Record<string, any>;
}

// Keep the last recorded command easy to assert without reaching into the tool.
function lastArgs(cli: FakeCliRunner): string[] {
  const call = cli.calls.at(-1);
  assert.ok(call, "expected an agent-desktop invocation");
  return call.args;
}

test("cu_ref builds the argument list for every Wayland-safe Ref operation", async () => {
  const cli = new FakeCliRunner((args) =>
    okEnvelope(args[0] ?? "unknown", {
      ref: REF,
      disposition: { delivery: "delivered_verified", retry: "unsafe" },
    }),
  );

  const cases: Array<{ action: RefInput["action"]; text?: string; expected: string[] }> = [
    { action: "click", expected: ["click", REF] },
    { action: "right-click", expected: ["right-click", REF] },
    { action: "set-value", text: "42", expected: ["set-value", REF, "42"] },
    { action: "clear", expected: ["clear", REF] },
    { action: "select", text: "Larger", expected: ["select", REF, "Larger"] },
    { action: "toggle", expected: ["toggle", REF] },
    { action: "check", expected: ["check", REF] },
    { action: "uncheck", expected: ["uncheck", REF] },
    { action: "expand", expected: ["expand", REF] },
    { action: "collapse", expected: ["collapse", REF] },
    { action: "scroll-to", expected: ["scroll-to", REF] },
  ];
  assert.deepEqual(
    cases.map((entry) => entry.action),
    [...ACT_OPERATIONS],
    "the test table covers exactly the 11 Wayland-safe Operations",
  );

  for (const entry of cases) {
    const result = await callRef({ action: entry.action, ref: REF, text: entry.text }, cli);
    assert.equal(result.isError, undefined, entry.action);
    assert.deepEqual(lastArgs(cli), entry.expected, entry.action);
    assert.equal(evidenceOf(result).disposition.delivery, "delivered_verified", entry.action);
  }
});

test("cu_ref never offers pruned X11 and Mutter-only operations", () => {
  const pruned = [
    "type",
    "press",
    "double-click",
    "hover",
    "scroll",
    "focus",
    "focus-window",
    "close-app",
    "screenshot",
  ];
  for (const operation of pruned) {
    assert.equal((REF_ACTIONS as readonly string[]).includes(operation), false, operation);
  }
});

test("cu_ref never forwards app or window-id to a Ref command, but forwards timeout and abort", async () => {
  const cli = new FakeCliRunner((args) => okEnvelope(args[0] ?? "unknown", { ref: REF }));
  const controller = new AbortController();

  // A qualified Ref owns its snapshot and Window; agent-desktop rejects
  // `click <ref> --app ...` with INVALID_ARGS, so the narrowing must be dropped.
  await callRef(
    { action: "click", ref: REF, app: "Firefox", windowId: "w-9", timeoutMs: 5000 },
    cli,
    { signal: controller.signal },
  );
  await callRef({ action: "set-value", ref: REF, text: "42", app: "Firefox", windowId: "w-9" }, cli);
  await callRef({ action: "select", ref: REF, text: "Dark Mode", windowId: "w-9" }, cli);

  assert.deepEqual(lastArgs(cli), ["select", REF, "Dark Mode"]);
  assert.equal(cli.invocations("click")[0]?.args.includes("--app"), false);
  assert.equal(cli.invocations("set-value")[0]?.args.includes("--window-id"), false);
  assert.equal(cli.calls[0]?.options?.timeoutMs, 5000);
  assert.equal(cli.calls[0]?.options?.signal, controller.signal);

  // `wait` does accept --app; it is not a Ref command.
  await callRef({ action: "wait", window: "Save As", app: "Firefox" }, cli);
  assert.deepEqual(lastArgs(cli), ["wait", "--window", "Save As", "--app", "Firefox"]);
});

test("cu_ref reports delivered_verified with post-state and step evidence", async () => {
  const postState = { checked: true, value: "on" };
  const steps = [{ action: "click", ok: true, disposition: "delivered_verified" }];
  const cli = new FakeCliRunner(() =>
    okEnvelope("click", {
      ref: REF,
      disposition: { delivery: "delivered_verified", retry: "unsafe" },
      post_state: postState,
      steps,
      window: { id: "w-9", title: "Settings" },
    }),
  );

  const evidence = evidenceOf(await callRef({ action: "click", ref: REF }, cli));
  assert.equal(evidence.disposition.delivery, "delivered_verified");
  assert.equal(evidence.disposition.retry, "unsafe");
  assert.deepEqual(evidence.post_state, postState);
  assert.deepEqual(evidence.steps, steps);
  assert.deepEqual(evidence.window, { id: "w-9", title: "Settings" });
});

test("cu_ref treats a successful operation without a disposition as delivered_unverified", async () => {
  const cli = new FakeCliRunner(() => okEnvelope("toggle", { ref: REF }));
  const evidence = evidenceOf(await callRef({ action: "toggle", ref: REF }, cli));
  assert.equal(evidence.disposition.delivery, "delivered_unverified");
});

test("cu_ref reports not_delivered and keeps the agent-desktop error code", async () => {
  const cli = new FakeCliRunner(() => errEnvelope("click", "ACTION_FAILED", "element vanished"));
  const result = await callRef({ action: "click", ref: REF }, cli);
  const details = detailsOf(result);

  assert.equal(result.isError, true);
  assert.equal(details.code, "ACTION_FAILED");
  assert.equal(details.disposition.delivery, "not_delivered");
  const text = result.content[0]?.text ?? "";
  assert.ok(text.includes("ACTION_FAILED"));
  assert.ok(text.includes("element vanished"));
});

test("cu_ref explains the Hyprland Wayland restriction when text cannot be set", async () => {
  for (const action of ["set-value", "clear"] as const) {
    for (const code of ["ACTION_NOT_SUPPORTED", "POLICY_DENIED"]) {
      const envelope: AdEnvelope = {
        version: "2.5",
        ok: false,
        command: action,
        error: {
          code,
          message: "node does not advertise SetValue",
          suggestion: "read the element's value instead",
          details: { ref: REF },
        },
      };
      const cli = new FakeCliRunner(() => envelope);
      const result = await callRef({ action, ref: REF, text: "typed" }, cli);
      const details = detailsOf(result);
      const text = result.content[0]?.text ?? "";
      const label = `${action} ${code}`;

      assert.equal(result.isError, true, label);
      assert.equal(details.code, code, label);
      assert.equal(details.message, "node does not advertise SetValue", label);
      assert.equal(details.suggestion, "read the element's value instead", label);
      assert.equal(details.disposition.delivery, "not_delivered", label);
      assert.match(details.hyprlandDiagnostic, /Hyprland Wayland/, label);
      assert.ok(text.includes("Hyprland Wayland"), label);
      assert.ok(text.includes("SetValue"), label);
      assert.ok(text.includes("`type`"), label);
      assert.ok(text.includes("`press`"), label);
      assert.ok(text.includes("node does not advertise SetValue"), label);
      assert.ok(text.includes("read the element's value instead"), label);
    }
  }
});

test("cu_ref leaves non-text failures without the Hyprland diagnostic", async () => {
  const cli = new FakeCliRunner(() => errEnvelope("click", "ACTION_NOT_SUPPORTED", "no click action"));
  const result = await callRef({ action: "click", ref: REF }, cli);
  assert.equal(result.isError, true);
  assert.equal(detailsOf(result).hyprlandDiagnostic, undefined);
  assert.equal((result.content[0]?.text ?? "").includes("Hyprland Wayland"), false);
});

test("cu_ref pauses for an elapsed wait and sizes the subprocess timeout to it", async () => {
  const cli = new FakeCliRunner(() => okEnvelope("wait", { elapsed_ms: 1500 }));
  const controller = new AbortController();

  const result = await callRef({ action: "wait", ms: 1500 }, cli, { signal: controller.signal });

  assert.deepEqual(lastArgs(cli), ["wait", "1500"]);
  assert.equal(cli.calls[0]?.options?.timeoutMs, 3500);
  assert.equal(cli.calls[0]?.options?.signal, controller.signal);
  assert.deepEqual(evidenceOf(result).data, { elapsed_ms: 1500 });
});

test("cu_ref waits on an element predicate and sizes the subprocess timeout to the condition", async () => {
  const cli = new FakeCliRunner(() => okEnvelope("wait", { element: REF }));
  const evidence = evidenceOf(
    await callRef({ action: "wait", element: REF, predicate: "value", text: "Ready", windowId: "w-1" }, cli),
  );

  assert.deepEqual(lastArgs(cli), [
    "wait",
    "--element",
    REF,
    "--predicate",
    "value",
    "--value",
    "Ready",
    "--window-id",
    "w-1",
  ]);
  assert.equal(cli.calls[0]?.options?.timeoutMs, 32_000);
  assert.equal(evidence.ok, true);
});

test("cu_ref maps every other wait condition onto its agent-desktop flag", async () => {
  const cli = new FakeCliRunner((args) => okEnvelope("wait", { args }));

  await callRef({ action: "wait", window: "Preferences", waitTimeoutMs: 5000 }, cli);
  assert.deepEqual(lastArgs(cli), ["wait", "--window", "Preferences", "--timeout", "5000"]);
  assert.equal(cli.calls[0]?.options?.timeoutMs, 7000);

  await callRef({ action: "wait", text: "Saved", app: "Firefox" }, cli);
  assert.deepEqual(lastArgs(cli), ["wait", "--text", "Saved", "--app", "Firefox"]);
  assert.equal(cli.calls[1]?.options?.timeoutMs, 32_000);

  await callRef({ action: "wait", menu: true }, cli);
  assert.deepEqual(lastArgs(cli), ["wait", "--menu"]);

  await callRef({ action: "wait", menuClosed: true }, cli);
  assert.deepEqual(lastArgs(cli), ["wait", "--menu-closed"]);

  await callRef({ action: "wait", event: "window-opened", waitTimeoutMs: 9000 }, cli);
  assert.deepEqual(lastArgs(cli), ["wait", "--event", "window-opened", "--timeout", "9000"]);
  assert.equal(cli.calls[4]?.options?.timeoutMs, 11_000);
});

test("cu_ref reads the Wayland clipboard", async () => {
  const cli = new FakeCliRunner((args) =>
    okEnvelope("clipboard-get", { type: "text", text: args.includes("--format") ? "copied" : "plain" }),
  );

  const withFormat = await callRef({ action: "clipboard-get", format: "text" }, cli);
  assert.deepEqual(lastArgs(cli), ["clipboard-get", "--format", "text"]);
  assert.deepEqual(evidenceOf(withFormat).data, { type: "text", text: "copied" });
  assert.ok((withFormat.content[0]?.text ?? "").includes("copied"));

  await callRef({ action: "clipboard-get" }, cli);
  assert.deepEqual(lastArgs(cli), ["clipboard-get"]);
});

test("cu_ref writes and clears the Wayland clipboard", async () => {
  const cli = new FakeCliRunner((args) => okEnvelope(args[0] ?? "unknown", { ok: true }));

  const set = await callRef({ action: "clipboard-set", text: "hello world" }, cli);
  assert.deepEqual(lastArgs(cli), ["clipboard-set", "hello world"]);
  assert.equal(evidenceOf(set).ok, true);

  await callRef({ action: "clipboard-clear" }, cli);
  assert.deepEqual(lastArgs(cli), ["clipboard-clear"]);
});

test("cu_ref launch injects the accessibility environment and passes args as --arg=", async () => {
  const cli = new FakeCliRunner(() =>
    okEnvelope("launch", { app: "chromium", pid: 4242, window: { id: "w-1", title: "New Tab" } }),
  );

  const result = await callRef(
    {
      action: "launch",
      app: "chromium",
      env: { FOO: "bar" },
      args: ["--force-renderer-accessibility", "--no-sandbox"],
      cwd: "/home/fake/project",
      activate: true,
    },
    cli,
  );

  assert.deepEqual(lastArgs(cli), [
    "launch",
    "chromium",
    "--env",
    "ACCESSIBILITY_ENABLED=1",
    "--env",
    "QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1",
    "--env",
    "FOO=bar",
    "--arg=--force-renderer-accessibility",
    "--arg=--no-sandbox",
    "--cwd",
    "/home/fake/project",
    "--activate",
  ]);
  assert.equal(evidenceOf(result).data.pid, 4242);
});

test("cu_ref launch requires an app and never starts a subprocess without one", async () => {
  const cli = new FakeCliRunner();
  const result = await callRef({ action: "launch" }, cli);

  assert.equal(result.isError, true);
  assert.equal(detailsOf(result).code, "LAUNCH_APP_REQUIRED");
  assert.equal(cli.calls.length, 0);
});

test("cu_ref verify reads the target's value after a Ref operation", async () => {
  const cli = new FakeCliRunner();
  cli.respondByCommand({
    "set-value": () =>
      okEnvelope("set-value", {
        ref: REF,
        disposition: { delivery: "delivered_verified", retry: "unsafe" },
      }),
    get: () => okEnvelope("get", { ref: REF, property: "value", value: "42" }),
  });

  const evidence = evidenceOf(
    await callRef({ action: "set-value", ref: REF, text: "42", windowId: "w-1", verify: true }, cli),
  );

  assert.deepEqual(cli.calls[1]?.args, ["get", REF, "--property", "value"]);
  assert.deepEqual(evidence.verify, { property: "value", ok: true, value: "42" });
  assert.equal(evidence.disposition.delivery, "delivered_verified");
});

test("cu_ref verify reports a failed post-read without failing the operation", async () => {
  const cli = new FakeCliRunner();
  cli.respondByCommand({
    click: () => okEnvelope("click", { ref: REF, disposition: { delivery: "delivered_unverified" } }),
    get: () => errEnvelope("get", "STALE_REF", "ref is stale"),
  });

  const result = await callRef({ action: "click", ref: REF, verify: true }, cli);
  const evidence = evidenceOf(result);

  assert.equal(result.isError, undefined);
  assert.equal(evidence.disposition.delivery, "delivered_unverified");
  assert.equal(evidence.verify.ok, false);
  assert.equal(evidence.verify.code, "STALE_REF");
});

test("cu_ref skips the post-read unless verify is true", async () => {
  const cli = new FakeCliRunner(() => okEnvelope("click", { ref: REF }));
  await callRef({ action: "click", ref: REF }, cli);
  assert.deepEqual(
    cli.calls.map((call) => call.args[0]),
    ["click"],
  );
});

test("cu_ref rejects a Ref operation without a ref or caller-supplied text", async () => {
  const cli = new FakeCliRunner();

  const missingRef = await callRef({ action: "click" }, cli);
  assert.equal(missingRef.isError, true);
  assert.equal(detailsOf(missingRef).code, "REF_REQUIRED");

  const missingText = await callRef({ action: "set-value", ref: REF }, cli);
  assert.equal(missingText.isError, true);
  assert.equal(detailsOf(missingText).code, "REF_TEXT_REQUIRED");

  assert.equal(cli.calls.length, 0);
});

test("cu_ref falls back to the Pi context AbortSignal when the tool signal is absent", async () => {
  const cli = new FakeCliRunner((args) => okEnvelope(args[0] ?? "unknown", { ref: REF }));
  const controller = new AbortController();

  await cuRef(cli).execute(
    "call-1",
    { action: "click", ref: REF },
    undefined,
    undefined,
    makeContext({ signal: controller.signal }),
  );

  assert.equal(cli.calls[0]?.options?.signal, controller.signal);
});
