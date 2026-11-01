/**
 * Natural-language scoping: an Intent or Goal can name an app loosely, name no
 * app at all, or name an app that AT-SPI can never drive. These tests cover the
 * user-visible behaviour of each case.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createCuTools } from "../src/extension.js";
import type { AdNode, DecisionAnswer, DecisionRequest, DecisionResponse, RunOperation } from "../src/types.js";
import { ACT_OPERATIONS, SET_VALUE_ABSTAIN_REASON } from "../src/policy/operations.js";
import {
  choiceAnswer,
  decision,
  errEnvelope,
  FakeCliRunner,
  FakeDecisionClient,
  makeContext,
  makeDeps,
  noulAnswer,
  okEnvelope,
} from "./fakes.js";

const notesTree: AdNode = {
  role: "window",
  name: "Notes",
  children: [
    { role: "button", name: "List View", ref_id: "@s1:e1", available_actions: ["Click"] },
    { role: "switch", name: "Dark Mode", ref_id: "@s1:e2", available_actions: ["Toggle"] },
  ],
};

const staticOnlyTree: AdNode = {
  role: "window",
  name: "Canvas",
  children: [
    { role: "static", name: "rendered painting" },
    { role: "group", name: "toolbar", children: [{ role: "static", name: "label" }] },
  ],
};

function appsEnvelope(...apps: Array<{ name: string; presentation?: string }>) {
  return okEnvelope("list-apps", {
    apps: apps.map((app, index) => ({ pid: 1000 + index, presentation: "foreground", ...app })),
  });
}

function snapshotEnvelope(tree: AdNode, app = "Notes") {
  return okEnvelope("snapshot", {
    app,
    window: { id: "w1", title: `${app} — Window` },
    snapshot_id: "s1",
    ref_count: 2,
    complete: true,
    truncated: false,
    nodes_observed: 3,
    tree,
    surfaces: [],
  });
}

function mutationEnvelope(args: string[]) {
  return okEnvelope(args[0] ?? "unknown", {
    ref: args[1],
    disposition: { delivery: "delivered_verified", retry: "safe" },
  });
}

function distribution(chosen: string, confidence: number, options: readonly string[]) {
  const others = options.filter((option) => option !== chosen);
  const each = others.length > 0 ? (1 - confidence) / others.length : 0;
  const out: Record<string, number> = {};
  for (const option of options) out[option] = option === chosen ? confidence : each;
  return out;
}

function actDecision(target: string, command = "click", confidence = 0.93): DecisionResponse {
  const offered = [...notesTree.children!.map((node) => String(node.ref_id)), "none"];
  return decision({
    target: choiceAnswer(target, confidence, distribution(target, confidence, offered)),
    command: choiceAnswer(command, 0.9, distribution(command, 0.9, ACT_OPERATIONS)),
    present: noulAnswer(0.95),
    destructive: noulAnswer(0.02),
    needs_text: noulAnswer(0.01),
  });
}

function runStep(operation: RunOperation, target: string | null) {
  return (request: DecisionRequest): DecisionResponse => {
    const operationOptions = Object.keys(request.questions.operation.criteria as object);
    const answers: Record<string, DecisionAnswer> = {
      operation: choiceAnswer(operation, 0.9, distribution(operation, 0.9, operationOptions)),
      present: noulAnswer(0.95),
    };
    const question = `${operation.toLowerCase()}_target`;
    if (target && request.questions[question]) {
      const options = Object.keys(request.questions[question].criteria as object);
      answers[question] = choiceAnswer(target, 0.93, distribution(target, 0.93, options));
    }
    return decision(answers);
  };
}

function tool(deps: ReturnType<typeof makeDeps>, name: string) {
  const found = createCuTools(deps).find((candidate) => candidate.name === name);
  assert.ok(found, `${name} must be registered`);
  return found;
}

function textOf(result: { content: Array<{ text: string }> }) {
  return result.content.map((block) => block.text).join("\n");
}

/* -------------------------------------------------------------------------- */
/* cu_act scoping                                                              */
/* -------------------------------------------------------------------------- */

test("cu_act auto-scopes to the only foreground application", async () => {
  const runner = new FakeCliRunner((args) => {
    if (args[0] === "list-apps") return appsEnvelope({ name: "Notes" });
    if (args[0] === "snapshot") return snapshotEnvelope(notesTree);
    return mutationEnvelope(args);
  });
  const decisionClient = new FakeDecisionClient(() => actDecision("@s1:e1"));
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await tool(deps, "cu_act").execute(
    "call-1",
    { intent: "switch to list view", execute: true },
    undefined,
    undefined,
    makeContext(),
  );

  assert.deepEqual(runner.argLists("snapshot"), [
    ["snapshot", "--app", "Notes", "-i", "--compact", "--include-bounds", "--skeleton"],
  ]);
  assert.deepEqual(runner.argLists("click"), [["click", "@s1:e1"]]);
  const details = result.details as { notes: string[]; delivery: string };
  assert.match(details.notes.join(" "), /auto-scoped to the only foreground application "Notes"/);
  assert.equal(details.delivery, "delivered_verified");
});

test("cu_act asks for an explicitly chosen application when several are foreground", async () => {
  const runner = new FakeCliRunner((args) => {
    if (args[0] === "list-apps") return appsEnvelope({ name: "Notes" }, { name: "Files" });
    return errEnvelope("snapshot", "WINDOW_NOT_FOUND", "No focused window found");
  });
  const decisionClient = new FakeDecisionClient(() => actDecision("@s1:e1"));
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await tool(deps, "cu_act").execute(
    "call-1",
    { intent: "switch to list view" },
    undefined,
    undefined,
    makeContext(),
  );

  assert.equal(result.isError, true);
  const text = textOf(result);
  assert.match(text, /Notes, Files/);
  assert.match(text, /windowId/);
  assert.equal(decisionClient.requests.length, 0);
});

test("cu_act resolves a loosely-named application and retries the read", async () => {
  let snapshots = 0;
  const runner = new FakeCliRunner((args) => {
    if (args[0] === "list-apps") return appsEnvelope({ name: "Notes" });
    if (args[0] === "snapshot") {
      snapshots += 1;
      if (snapshots === 1) return errEnvelope("snapshot", "APP_NOT_FOUND", "'notes' was not found");
      return snapshotEnvelope(notesTree);
    }
    return mutationEnvelope(args);
  });
  const deps = makeDeps({
    cli: runner,
    decision: new FakeDecisionClient(() => actDecision("@s1:e1")),
  });

  const result = await tool(deps, "cu_act").execute(
    "call-1",
    { intent: "switch to list view", app: "notes", execute: true },
    undefined,
    undefined,
    makeContext(),
  );

  assert.deepEqual(runner.argLists("snapshot"), [
    ["snapshot", "--app", "notes", "-i", "--compact", "--include-bounds", "--skeleton"],
    ["snapshot", "--app", "Notes", "-i", "--compact", "--include-bounds", "--skeleton"],
  ]);
  const details = result.details as { notes: string[] };
  assert.match(details.notes.join(" "), /resolved app "notes" to "Notes"/);
});

test("cu_act explains that a terminal or TUI application cannot be driven", async () => {
  const runner = new FakeCliRunner((args) => {
    if (args[0] === "list-apps") return appsEnvelope();
    return {
      ...errEnvelope("snapshot", "APP_NOT_FOUND", "'cliamp' is running (pid 4321) but is not on the accessibility bus"),
      error: {
        code: "APP_NOT_FOUND",
        message: "'cliamp' is running (pid 4321) but is not on the accessibility bus",
        details: { kind: "no_accessibility_connection", process: "cliamp" },
        disposition: { delivery: "not_delivered", retry: "safe" },
      },
    };
  });
  const decisionClient = new FakeDecisionClient(() => actDecision("@s1:e1"));
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await tool(deps, "cu_act").execute(
    "call-1",
    { intent: "play NCS Chill radio station on cliamp", app: "cliamp" },
    undefined,
    undefined,
    makeContext(),
  );

  assert.equal(result.isError, true);
  const text = textOf(result);
  assert.match(text, /terminal\/TUI/i);
  assert.match(text, /keystroke/i);
  assert.match(text, /use the shell or the app's own CLI/i);
  assert.equal(decisionClient.requests.length, 0);
});

test("cu_act abstains without a decision call when nothing is actionable", async () => {
  const runner = new FakeCliRunner(() => snapshotEnvelope(staticOnlyTree, "Canvas"));
  const decisionClient = new FakeDecisionClient(() => actDecision("@s1:e1"));
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await tool(deps, "cu_act").execute(
    "call-1",
    { intent: "press the play button", app: "Canvas", execute: true },
    undefined,
    undefined,
    makeContext(),
  );

  const details = result.details as { decision: string; why: string };
  assert.equal(details.decision, "abstain");
  assert.match(details.why, /no actionable AT-SPI nodes/);
  assert.equal(decisionClient.requests.length, 0);
  assert.equal(runner.invocations("click").length, 0);
});

/* -------------------------------------------------------------------------- */
/* cu_run scoping                                                              */
/* -------------------------------------------------------------------------- */

test("cu_run auto-scopes to the only foreground application", async () => {
  const runner = new FakeCliRunner((args) => {
    if (args[0] === "list-apps") return appsEnvelope({ name: "Notes" });
    if (args[0] === "snapshot") return snapshotEnvelope(notesTree);
    return mutationEnvelope(args);
  });
  const deps = makeDeps({ cli: runner, decision: new FakeDecisionClient(runStep("DONE", null)) });

  const result = await tool(deps, "cu_run").execute(
    "call-1",
    { goal: "leave the window as it is" },
    undefined,
    undefined,
    makeContext(),
  );

  assert.deepEqual(runner.argLists("snapshot"), [
    ["snapshot", "--app", "Notes", "-i", "--compact", "--include-bounds", "--skeleton"],
  ]);
  const details = result.details as { stop: string; notes: string[] };
  assert.equal(details.stop, "done");
  assert.match(details.notes.join(" "), /auto-scoped to the only foreground application "Notes"/);
});

test("cu_run tells the user to launch an application that is not running", async () => {
  const runner = new FakeCliRunner((args) => {
    if (args[0] === "snapshot") return errEnvelope("snapshot", "APP_NOT_FOUND", "'cliamp' was not found");
    return appsEnvelope();
  });
  const decisionClient = new FakeDecisionClient(runStep("DONE", null));
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await tool(deps, "cu_run").execute(
    "call-1",
    { goal: "play NCS Chill radio station on cliamp", app: "cliamp" },
    undefined,
    undefined,
    makeContext(),
  );

  const details = result.details as { stop: string; notes: string[] };
  assert.match(details.stop, /app_not_found/);
  assert.match(details.notes.join(" "), /cu_ref \{ action: "launch", app: "cliamp" \}/);
  assert.equal(decisionClient.requests.length, 0);
});

/* -------------------------------------------------------------------------- */
/* cu_status                                                                   */
/* -------------------------------------------------------------------------- */

test("cu_status explains applications that report no accessible Windows", async () => {
  const runner = new FakeCliRunner((args) => {
    if (args[0] === "status") {
      return okEnvelope("status", {
        platform: "linux",
        supported_surfaces: ["window", "sheet", "alert", "menu"],
        permissions: {},
      });
    }
    if (args[0] === "list-apps") return appsEnvelope({ name: "Notes" });
    if (args[0] === "list-windows") return okEnvelope("list-windows", { windows: [] });
    return okEnvelope(args[0] ?? "unknown", {});
  });
  const deps = makeDeps({ cli: runner });

  const result = await tool(deps, "cu_status").execute(
    "call-1",
    {},
    undefined,
    undefined,
    makeContext({ hasUI: false }),
  );

  assert.match(textOf(result), /report no accessible Windows/);
});

// Keep the unused import honest: the SetValue abstention text is exercised in test/act.test.ts.
void SET_VALUE_ABSTAIN_REASON;
