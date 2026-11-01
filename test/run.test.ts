import assert from "node:assert/strict";
import { test } from "node:test";
import { createCuTools } from "../src/extension.js";
import type {
  AdNode,
  DecisionAnswer,
  DecisionRequest,
  DecisionResponse,
  RunOperation,
} from "../src/types.js";
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

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const prefsTree: AdNode = {
  role: "window",
  name: "Preferences",
  children: [
    { role: "push button", name: "Appearance", ref_id: "@s1:e1", available_actions: ["Click"] },
    { role: "check box", name: "Dark Mode", ref_id: "@s1:e2", available_actions: ["Toggle"] },
  ],
};

const checkedTree: AdNode = {
  role: "window",
  name: "Preferences",
  children: [
    { role: "push button", name: "Appearance", ref_id: "@s1:e1", available_actions: ["Click"] },
    { role: "check box", name: "Dark Mode", ref_id: "@s1:e2", states: ["checked"], available_actions: ["Toggle"] },
  ],
};

function snapshotEnvelope(tree: AdNode, extra: Record<string, unknown> = {}) {
  return okEnvelope("snapshot", {
    app: "Preferences",
    window: { id: "w1", title: "Preferences — Appearance" },
    snapshot_id: "s1",
    ref_count: 2,
    complete: true,
    truncated: false,
    nodes_observed: 3,
    tree,
    surfaces: [],
    ...extra,
  });
}

function mutationEnvelope(args: string[]) {
  return okEnvelope(args[0] ?? "unknown", {
    ref: args[1],
    disposition: { delivery: "delivered_verified", retry: "safe" },
    steps: [{ action: args[0], ref: args[1] }],
  });
}

/** A probability distribution that sums to 1 for `chosen` over `options`. */
function distribution(chosen: string, confidence: number, options: readonly string[]): Record<string, number> {
  const others = options.filter((option) => option !== chosen);
  const each = others.length > 0 ? (1 - confidence) / others.length : 0;
  const out: Record<string, number> = {};
  for (const option of options) out[option] = option === chosen ? confidence : each;
  return out;
}

interface StepOptions {
  /** Target confidence for the `<operation>_target` answer (default 0.92). */
  confidence?: number;
  /** Confidence of the `operation` answer (default 0.9). */
  operationConfidence?: number;
  /** Probability that the target is present (default 0.95). */
  present?: number;
}

/**
 * A coherent System One answer for one Goal turn, built from the questions the
 * loop actually asked: the target question only exists when the Operation has
 * an offered target list.
 */
function runStep(operation: RunOperation, target: string | null, options: StepOptions = {}) {
  return (request: DecisionRequest): DecisionResponse => {
    const operationOptions = Object.keys(request.questions.operation.criteria as object);
    const operationConfidence = options.operationConfidence ?? 0.9;
    const answers: Record<string, DecisionAnswer> = {
      operation: choiceAnswer(operation, operationConfidence, distribution(operation, operationConfidence, operationOptions)),
      present: noulAnswer(options.present ?? 0.95),
    };
    const question = `${operation.toLowerCase()}_target`;
    if (request.questions[question] && target !== null) {
      const options2 = Object.keys(request.questions[question].criteria as object);
      const confidence = options.confidence ?? 0.92;
      answers[question] = choiceAnswer(target, confidence, distribution(target, confidence, options2));
    }
    return decision(answers);
  };
}

function riskAnswer(value: number) {
  return () => decision({ destructive: noulAnswer(value) });
}

function runTool(deps: ReturnType<typeof makeDeps>) {
  const tool = createCuTools(deps).find((candidate) => candidate.name === "cu_run");
  assert.ok(tool, "cu_run must be registered");
  return tool;
}

async function runGoal(
  deps: ReturnType<typeof makeDeps>,
  params: Record<string, unknown>,
  ctx = makeContext(),
) {
  return runTool(deps).execute("call-run", params, undefined, undefined, ctx);
}

/* -------------------------------------------------------------------------- */
/* Core loop                                                                   */
/* -------------------------------------------------------------------------- */

test("cu_run drives a multi-turn Goal to done through click and check", async () => {
  let mutations = 0;
  const runner = new FakeCliRunner((args) => {
    if (args[0] === "snapshot") return mutations > 0 ? snapshotEnvelope(checkedTree) : snapshotEnvelope(prefsTree);
    mutations += 1;
    return mutationEnvelope(args);
  });
  const decisionClient = new FakeDecisionClient();
  decisionClient.queue(
    runStep("CLICK", "@s1:e1", { confidence: 0.92 }),
    runStep("CHECK", "@s1:e2", { confidence: 0.93 }),
    runStep("DONE", null, { operationConfidence: 0.95 }),
  );
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await runGoal(deps, { goal: "open Appearance and enable Dark Mode", app: "Preferences" });
  const details = result.details as any;

  assert.equal(result.isError, undefined);
  assert.equal(details.stop, "done");
  assert.equal(details.turns, 3);
  assert.equal(details.operations, 2);
  assert.equal(details.jev_calls, 3);
  assert.deepEqual(runner.argLists("click"), [["click", "@s1:e1", "--app", "Preferences"]]);
  assert.deepEqual(runner.argLists("check"), [["check", "@s1:e2", "--app", "Preferences"]]);
  assert.deepEqual(
    details.recent_actions.map((action: any) => [action.operation, action.target.ref, action.delivery]),
    [
      ["CLICK", "@s1:e1", "delivered_verified"],
      ["CHECK", "@s1:e2", "delivered_verified"],
    ],
  );
  assert.ok(!result.content[0].text.includes('"tree"'), "tool output must never contain the accessibility tree");
});

/* -------------------------------------------------------------------------- */
/* Target lists and view Operations                                            */
/* -------------------------------------------------------------------------- */

const richTree: AdNode = {
  role: "window",
  name: "Preferences",
  children: [
    { role: "push button", name: "Appearance", ref_id: "@s1:e1", available_actions: ["Click"] },
    { role: "check box", name: "Dark Mode", ref_id: "@s1:e2", available_actions: ["Toggle"] },
    { role: "entry", name: "Search", ref_id: "@s1:e3", available_actions: ["SetValue"] },
    { role: "combo box", name: "Theme", ref_id: "@s1:e4", available_actions: ["Select"] },
    { role: "tree item", name: "Advanced", ref_id: "@s1:e5", available_actions: ["Expand", "Collapse"] },
    { role: "panel", name: "Details", ref_id: "@s1:e6", children_count: 4 },
  ],
};

async function firstRequest(params: Record<string, unknown>): Promise<DecisionRequest> {
  const runner = new FakeCliRunner((args) => snapshotEnvelope(richTree));
  const decisionClient = new FakeDecisionClient(runStep("DONE", null));
  const deps = makeDeps({ cli: runner, decision: decisionClient });
  await runGoal(deps, { goal: "inspect the preferences", app: "Preferences", ...params });
  return decisionClient.requests[0];
}

function criteriaKeys(question: { criteria?: unknown }): string[] {
  return Object.keys((question.criteria ?? {}) as object);
}

test("cu_run asks the Operation and every matching target question in one request", async () => {
  const request = await firstRequest({ text: ["hunter2-secret", "Dark Mode"] });
  const questions = request.questions;

  assert.deepEqual(Object.keys(questions), [
    "operation",
    "click_target",
    "type_text_target",
    "clear_target",
    "select_target",
    "check_target",
    "uncheck_target",
    "expand_target",
    "collapse_target",
    "drill_target",
    "present",
  ]);
  assert.deepEqual(criteriaKeys(questions.operation), [
    "CLICK",
    "TYPE_TEXT",
    "CLEAR",
    "SELECT",
    "CHECK",
    "UNCHECK",
    "EXPAND",
    "COLLAPSE",
    "DRILL",
    "WAIT",
    "DONE",
    "BLOCKED",
  ]);
  assert.deepEqual(criteriaKeys(questions.click_target), ["@s1:e1", "none"]);
  assert.deepEqual(criteriaKeys(questions.type_text_target), ["@s1:e3", "none"]);
  assert.deepEqual(criteriaKeys(questions.clear_target), ["@s1:e3", "none"]);
  assert.deepEqual(criteriaKeys(questions.select_target), ["@s1:e4", "none"]);
  assert.deepEqual(criteriaKeys(questions.check_target), ["@s1:e2", "none"]);
  assert.deepEqual(criteriaKeys(questions.uncheck_target), ["@s1:e2", "none"]);
  assert.deepEqual(criteriaKeys(questions.expand_target), ["@s1:e5", "none"]);
  assert.deepEqual(criteriaKeys(questions.collapse_target), ["@s1:e5", "none"]);
  assert.deepEqual(criteriaKeys(questions.drill_target), ["@s1:e6", "none"]);
  assert.equal(questions.present.type, "noul");

  const state = request.state as any;
  assert.equal(state.goal, "inspect the preferences");
  assert.equal(state.turn, 1);
  assert.equal(state.text_supplied, true);
  assert.equal(state.window.title, "Preferences — Appearance");
  assert.deepEqual(state.candidates.map((candidate: any) => candidate.ref), [
    "@s1:e1",
    "@s1:e2",
    "@s1:e3",
    "@s1:e4",
    "@s1:e5",
  ]);
  assert.ok(!JSON.stringify(state).includes("hunter2-secret"), "caller text never reaches the decision state");
});

test("cu_run withholds TYPE_TEXT and SELECT until the caller supplies text", async () => {
  const request = await firstRequest({});
  assert.ok(!("type_text_target" in request.questions));
  assert.ok(!("select_target" in request.questions));
  assert.ok(!criteriaKeys(request.questions.operation).includes("TYPE_TEXT"));
  assert.ok(!criteriaKeys(request.questions.operation).includes("SELECT"));
  assert.ok(criteriaKeys(request.questions.operation).includes("CLICK"));
});

test("cu_run shares Jev's 254-option limit across all target questions and records the cut", async () => {
  const wide: AdNode = {
    role: "window",
    name: "Wide",
    children: Array.from({ length: 300 }, (_, index) => ({
      role: "button",
      name: `Button ${index}`,
      ref_id: `@s1:e${index}`,
      available_actions: ["Click"],
    })),
  };
  const runner = new FakeCliRunner((args) => snapshotEnvelope(wide));
  const decisionClient = new FakeDecisionClient(runStep("DONE", null));
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await runGoal(deps, { goal: "press Button 0", app: "Wide" });
  const details = result.details as any;
  const request = decisionClient.requests[0];

  assert.equal(criteriaKeys(request.questions.click_target).length, 255);
  assert.equal(details.notes.some((note: string) => /capped at 254/.test(note)), true);
});

test("cu_run drills into a truncated Region and widens back to the Window", async () => {
  const regionTree: AdNode = {
    role: "panel",
    name: "Details",
    children: [{ role: "push button", name: "Reset", ref_id: "@s2:e1", available_actions: ["Click"] }],
  };
  const runner = new FakeCliRunner((args) => {
    if (args[0] !== "snapshot") return mutationEnvelope(args);
    if (args.includes("--root")) return snapshotEnvelope(regionTree);
    return snapshotEnvelope(richTree);
  });
  const decisionClient = new FakeDecisionClient();
  decisionClient.queue(
    runStep("DRILL", "@s1:e6", { confidence: 0.9 }),
    runStep("WIDEN", "window", { confidence: 0.9 }),
    runStep("DONE", null),
  );
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await runGoal(deps, { goal: "inspect the details panel", app: "Preferences" });
  const details = result.details as any;

  assert.equal(details.stop, "done");
  assert.equal(details.operations, 0);
  assert.deepEqual(
    runner.argLists("snapshot").map((args) => args.filter((arg) => arg === "--root" || arg === "window")),
    [[], ["--root"], []],
  );
  const drilledRead = runner.argLists("snapshot").find((args) => args.includes("--root"));
  assert.deepEqual(drilledRead, [
    "snapshot",
    "--app",
    "Preferences",
    "-i",
    "--compact",
    "--root",
    "@s1:e6",
  ]);
  assert.deepEqual(
    details.recent_actions.map((action: any) => [action.operation, action.delivery, action.changed, action.decision]),
    [
      ["DRILL", "looked", true, null],
      ["WIDEN", "looked", true, null],
    ],
  );
  assert.equal(details.region_root, null);
  assert.equal(runner.invocations("click").length, 0);
  // The drilled request is rooted at the Region and offers its inner button.
  assert.equal((decisionClient.requests[1].state as any).region_root, "@s1:e6");
  assert.deepEqual(criteriaKeys(decisionClient.requests[1].questions.click_target), ["@s2:e1", "none"]);
  assert.ok("widen_target" in decisionClient.requests[1].questions);
  assert.ok(!("widen_target" in decisionClient.requests[0].questions));
});

/* -------------------------------------------------------------------------- */
/* Risk rating and interactive confirmation                                    */
/* -------------------------------------------------------------------------- */

test("cu_run rates destructive risk before prompting and shows both probabilities", async () => {
  const runner = new FakeCliRunner((args) => (args[0] === "snapshot" ? snapshotEnvelope(prefsTree) : mutationEnvelope(args)));
  const decisionClient = new FakeDecisionClient();
  decisionClient.queue(
    runStep("CLICK", "@s1:e1", { confidence: 0.62 }),
    riskAnswer(0.15),
    runStep("DONE", null),
  );
  const deps = makeDeps({ cli: runner, decision: decisionClient });
  let requestsWhenPrompted = -1;
  const ctx = makeContext({
    confirm: () => {
      requestsWhenPrompted = decisionClient.requests.length;
      return true;
    },
  });

  const result = await runGoal(deps, { goal: "open the appearance settings", app: "Preferences" }, ctx);
  const details = result.details as any;

  assert.deepEqual(
    decisionClient.requests.map((request) => Object.keys(request.questions)),
    [["operation", "click_target", "check_target", "uncheck_target", "present"], ["destructive"], ["operation", "click_target", "check_target", "uncheck_target", "present"]],
  );
  assert.equal(requestsWhenPrompted, 2, "the destructive rating must land before the prompt");
  assert.equal(ctx.ui.confirms.length, 1);
  const prompt = ctx.ui.confirms[0];
  assert.equal(prompt.title, "Approve CLICK?");
  assert.match(prompt.message, /Goal: open the appearance settings/);
  assert.match(prompt.message, /Window: Preferences — Appearance/);
  assert.match(prompt.message, /Operation: CLICK/);
  assert.match(prompt.message, /Target: push button "Appearance" \(@s1:e1\)/);
  assert.match(prompt.message, /Target confidence: 0\.62/);
  assert.match(prompt.message, /Destructive risk: 0\.15/);
  assert.equal(details.stop, "done");
  assert.equal(details.operations, 1);
  assert.equal(details.recent_actions[0].confirmedByUser, true);
  assert.deepEqual(runner.argLists("click"), [["click", "@s1:e1", "--app", "Preferences"]]);
});

test("cu_run stops with the confirm candidate when the prompt is declined", async () => {
  const runner = new FakeCliRunner((args) => (args[0] === "snapshot" ? snapshotEnvelope(prefsTree) : mutationEnvelope(args)));
  const decisionClient = new FakeDecisionClient();
  decisionClient.queue(runStep("CLICK", "@s1:e1", { confidence: 0.62 }), riskAnswer(0.15));
  const deps = makeDeps({ cli: runner, decision: decisionClient });
  const ctx = makeContext({ confirm: false });

  const result = await runGoal(deps, { goal: "open the appearance settings", app: "Preferences" }, ctx);
  const details = result.details as any;

  assert.equal(ctx.ui.confirms.length, 1);
  assert.equal(runner.invocations("click").length, 0);
  assert.match(details.stop, /^confirm: CLICK /);
  assert.deepEqual(details.confirm, {
    operation: "CLICK",
    target: { ref: "@s1:e1", role: "push button", name: "Appearance" },
    confidence: 0.62,
    destructive: 0.15,
    why: details.confirm.why,
  });
  assert.equal(details.operations, 0);
  assert.equal(result.isError, undefined);
  assert.ok(details.notes.some((note: string) => /declined/.test(note)));
});

test("cu_run returns the confirm candidate headless instead of mutating", async () => {
  const runner = new FakeCliRunner((args) => (args[0] === "snapshot" ? snapshotEnvelope(prefsTree) : mutationEnvelope(args)));
  const decisionClient = new FakeDecisionClient();
  decisionClient.queue(runStep("CLICK", "@s1:e1", { confidence: 0.62 }), riskAnswer(0.15));
  const deps = makeDeps({ cli: runner, decision: decisionClient });
  const ctx = makeContext({ hasUI: false });

  const result = await runGoal(deps, { goal: "open the appearance settings", app: "Preferences" }, ctx);
  const details = result.details as any;

  assert.equal(ctx.ui.confirms.length, 0);
  assert.equal(runner.invocations("click").length, 0);
  assert.match(details.stop, /^confirm: CLICK /);
  assert.equal(details.confirm.destructive, 0.15);
  assert.equal(details.operations, 0);
  assert.ok(details.notes.some((note: string) => /no interactive prompt/.test(note)));
});

test("cu_run returns a confirm step instead of prompting when confirmPolicy is return", async () => {
  const runner = new FakeCliRunner((args) => (args[0] === "snapshot" ? snapshotEnvelope(prefsTree) : mutationEnvelope(args)));
  const decisionClient = new FakeDecisionClient();
  decisionClient.queue(runStep("CLICK", "@s1:e1", { confidence: 0.62 }), riskAnswer(0.15));
  const deps = makeDeps({ cli: runner, decision: decisionClient });
  const ctx = makeContext({ confirm: true });

  const result = await runGoal(
    deps,
    { goal: "open the appearance settings", app: "Preferences", confirmPolicy: "return" },
    ctx,
  );
  const details = result.details as any;

  assert.equal(ctx.ui.confirms.length, 0);
  assert.equal(runner.invocations("click").length, 0);
  assert.match(details.stop, /^confirm: CLICK /);
});

test("cu_run executes high-confidence steps without rating risk or prompting", async () => {
  const runner = new FakeCliRunner((args) => (args[0] === "snapshot" ? snapshotEnvelope(prefsTree) : mutationEnvelope(args)));
  const decisionClient = new FakeDecisionClient();
  decisionClient.queue(runStep("CLICK", "@s1:e1", { confidence: 0.93 }), runStep("DONE", null));
  const deps = makeDeps({ cli: runner, decision: decisionClient });
  const ctx = makeContext({ confirm: true });

  const result = await runGoal(deps, { goal: "open the appearance settings", app: "Preferences" }, ctx);
  const details = result.details as any;

  assert.equal(decisionClient.requests.length, 2);
  assert.equal(ctx.ui.confirms.length, 0);
  assert.equal(details.operations, 1);
  assert.equal(details.recent_actions[0].confirmedByUser, undefined);
});

/* -------------------------------------------------------------------------- */
/* Text supply and redaction                                                   */
/* -------------------------------------------------------------------------- */

const textTree: AdNode = {
  role: "window",
  name: "Preferences",
  children: [
    { role: "entry", name: "Search", value: "live-secret", ref_id: "@s1:e1", available_actions: ["SetValue"] },
    { role: "combo box", name: "Theme", ref_id: "@s1:e2", available_actions: ["Select"] },
  ],
};

function textRunner(): FakeCliRunner {
  return new FakeCliRunner((args) => (args[0] === "snapshot" ? snapshotEnvelope(textTree) : mutationEnvelope(args)));
}

test("cu_run types a sensitive string and selects a plain label from the same queue", async () => {
  const runner = textRunner();
  const decisionClient = new FakeDecisionClient();
  decisionClient.queue(
    runStep("TYPE_TEXT", "@s1:e1", { confidence: 0.93 }),
    runStep("SELECT", "@s1:e2", { confidence: 0.93 }),
    runStep("DONE", null),
  );
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await runGoal(deps, {
    goal: "search for the token and pick the dark theme",
    app: "Preferences",
    text: ["hunter2-secret", "Dark Mode"],
    redactText: true,
  });
  const details = result.details as any;

  assert.deepEqual(runner.argLists("set-value"), [
    ["set-value", "@s1:e1", "hunter2-secret", "--app", "Preferences"],
  ]);
  assert.deepEqual(runner.argLists("select"), [["select", "@s1:e2", "Dark Mode", "--app", "Preferences"]]);
  assert.equal(details.operations, 2);
  assert.ok(result.content[0].text.includes("[redacted]"));
  assert.ok(!result.content[0].text.includes("hunter2-secret"));
  assert.ok(!JSON.stringify(details).includes("hunter2-secret"));
  assert.ok(result.content[0].text.includes("Dark Mode"), "SELECT labels are never redacted");
  assert.equal(details.recent_actions[0].text, "[redacted]");
  assert.equal(details.recent_actions[1].text, "Dark Mode");
});

test("cu_run withholds live values from decision requests when noValues is true", async () => {
  async function requestsWith(noValues: boolean): Promise<FakeDecisionClient> {
    const decisionClient = new FakeDecisionClient();
    decisionClient.queue(
      runStep("TYPE_TEXT", "@s1:e1", { confidence: 0.93 }),
      runStep("DONE", null),
    );
    const deps = makeDeps({ cli: textRunner(), decision: decisionClient });
    await runGoal(deps, {
      goal: "fill in the search field",
      app: "Preferences",
      text: ["typed-secret"],
      ...(noValues ? { noValues: true } : {}),
    });
    return decisionClient;
  }

  const visible = await requestsWith(false);
  assert.match(JSON.stringify(visible.requests), /live-secret/);

  const withheld = await requestsWith(true);
  assert.ok(!JSON.stringify(withheld.requests).includes("live-secret"));
});

test("cu_run redacts typed text from model history under noValues while keeping SELECT labels", async () => {
  const runner = textRunner();
  const decisionClient = new FakeDecisionClient();
  decisionClient.queue(
    runStep("TYPE_TEXT", "@s1:e1", { confidence: 0.93 }),
    runStep("SELECT", "@s1:e2", { confidence: 0.93 }),
    runStep("DONE", null),
  );
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await runGoal(deps, {
    goal: "search for the token and pick the dark theme",
    app: "Preferences",
    text: ["typed-secret", "Dark Mode"],
    noValues: true,
  });
  const details = result.details as any;

  assert.equal(details.recent_actions[0].text, "[redacted]");
  assert.equal(details.recent_actions[1].text, "Dark Mode");
  assert.ok(!result.content[0].text.includes("typed-secret"));
  assert.ok(result.content[0].text.includes("Dark Mode"));
});

/* -------------------------------------------------------------------------- */
/* WAIT, budgets, and stop conditions                                          */
/* -------------------------------------------------------------------------- */

test("cu_run treats WAIT as a look turn and re-observes", async () => {
  const runner = new FakeCliRunner((args) => snapshotEnvelope(prefsTree));
  const decisionClient = new FakeDecisionClient();
  decisionClient.queue(runStep("WAIT", null), runStep("DONE", null));
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await runGoal(deps, { goal: "wait for the window to settle", app: "Preferences" });
  const details = result.details as any;

  assert.equal(details.stop, "done");
  assert.equal(details.turns, 2);
  assert.equal(details.operations, 0);
  assert.deepEqual(details.recent_actions, [
    { turn: 1, operation: "WAIT", target: null, decision: null, delivery: "looked", changed: null },
  ]);
  assert.equal(runner.argLists("snapshot").length, 2, "WAIT looks again");
});

test("cu_run stops with blocked when the decision model reports the Goal blocked", async () => {
  const runner = new FakeCliRunner((args) => snapshotEnvelope(prefsTree));
  const decisionClient = new FakeDecisionClient(runStep("BLOCKED", null));
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const updates: any[] = [];
  const result = await runTool(deps).execute(
    "call-run",
    { goal: "change the system theme", app: "Preferences" },
    undefined,
    (update: any) => updates.push(update),
    makeContext(),
  );
  const details = result.details as any;

  assert.equal(updates[0].details.operation, "BLOCKED");
  assert.equal(updates[0].details.decision, null);
  assert.equal(details.stop, "blocked");
  assert.equal(details.turns, 1);
  assert.equal(details.operations, 0);
  assert.equal(result.isError, undefined);
});

test("cu_run stops with action_failed when a mutating Operation fails", async () => {
  const runner = new FakeCliRunner((args) =>
    args[0] === "snapshot" ? snapshotEnvelope(prefsTree) : errEnvelope(args[0], "ACTION_NOT_SUPPORTED", "no Click"),
  );
  const decisionClient = new FakeDecisionClient(runStep("CLICK", "@s1:e1", { confidence: 0.93 }));
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await runGoal(deps, { goal: "open the appearance settings", app: "Preferences" });
  const details = result.details as any;

  assert.equal(details.stop, "error: action_failed");
  assert.equal(details.code, "ACTION_NOT_SUPPORTED");
  assert.equal(details.operations, 0);
  assert.equal(result.isError, true);
  assert.equal(details.recent_actions.length, 0);
  assert.ok(details.notes.some((note: string) => /ACTION_NOT_SUPPORTED/.test(note)));
});

test("cu_run stops with window_closed when the Window read fails", async () => {
  const runner = new FakeCliRunner(() => errEnvelope("snapshot", "WINDOW_CLOSED", "the window is gone"));
  const decisionClient = new FakeDecisionClient();
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await runGoal(deps, { goal: "open the appearance settings", app: "Preferences" });
  const details = result.details as any;

  assert.equal(details.stop, "error: window_closed");
  assert.equal(details.code, "WINDOW_CLOSED");
  assert.equal(details.turns, 0);
  assert.equal(result.isError, true);
  assert.equal(decisionClient.requests.length, 0);
});

test("cu_run stops with root_outside_window when the pinned Window is not the one read", async () => {
  const runner = new FakeCliRunner(() =>
    snapshotEnvelope(prefsTree, { window: { id: "w2", title: "Elsewhere" } }),
  );
  const decisionClient = new FakeDecisionClient();
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await runGoal(deps, { goal: "open the appearance settings", windowId: "w1" });
  const details = result.details as any;

  assert.equal(details.stop, "error: root_outside_window");
  assert.equal(details.code, "ROOT_OUTSIDE_WINDOW");
  assert.equal(result.isError, true);
  assert.equal(decisionClient.requests.length, 0);
});

test("cu_run stops with surface_outside_window when the Overlay Surface belongs to another Window", async () => {
  const runner = new FakeCliRunner((args) => {
    if (args.includes("--surface")) {
      return snapshotEnvelope(prefsTree, { window: { id: "w2", title: "Elsewhere" } });
    }
    return snapshotEnvelope(prefsTree, { surfaces: [{ kind: "sheet" }] });
  });
  const decisionClient = new FakeDecisionClient();
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await runGoal(deps, { goal: "confirm the dialog", windowId: "w1" });
  const details = result.details as any;

  assert.equal(details.stop, "error: surface_outside_window");
  assert.equal(details.code, "SURFACE_OUTSIDE_WINDOW");
  assert.equal(result.isError, true);
  assert.deepEqual(runner.argLists("snapshot"), [
    ["snapshot", "--window-id", "w1", "-i", "--compact", "--include-bounds", "--skeleton"],
    ["snapshot", "--window-id", "w1", "-i", "--surface", "sheet"],
  ]);
});

test("cu_run stops at the 40-operation budget", async () => {
  let mutations = 0;
  const runner = new FakeCliRunner((args) => {
    if (args[0] !== "snapshot") {
      mutations += 1;
      return mutationEnvelope(args);
    }
    const tree: AdNode = {
      role: "window",
      name: `Preferences ${mutations}`,
      children: [{ role: "push button", name: `Open ${mutations}`, ref_id: "@s1:e1", available_actions: ["Click"] }],
    };
    return snapshotEnvelope(tree);
  });
  const decisionClient = new FakeDecisionClient(runStep("CLICK", "@s1:e1", { confidence: 0.93 }));
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await runGoal(deps, { goal: "keep pressing open", app: "Preferences" });
  const details = result.details as any;

  assert.equal(details.stop, "budget: operations");
  assert.equal(details.operations, 40);
  assert.equal(details.turns, 40);
  assert.equal(details.jev_calls, 40);
  assert.equal(runner.invocations("click").length, 40);
  assert.equal(result.isError, undefined);
});

test("cu_run stops after 3 consecutive non-WAIT turns without a screen change", async () => {
  const runner = new FakeCliRunner((args) => (args[0] === "snapshot" ? snapshotEnvelope(prefsTree) : mutationEnvelope(args)));
  const decisionClient = new FakeDecisionClient(runStep("CLICK", "@s1:e1", { confidence: 0.93 }));
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await runGoal(deps, { goal: "open the appearance settings", app: "Preferences" });
  const details = result.details as any;

  assert.equal(details.stop, "unchanged: 3 turns");
  assert.equal(details.turns, 3);
  assert.equal(details.operations, 3);
  assert.deepEqual(
    details.recent_actions.map((action: any) => action.changed),
    [false, false, false],
  );
});

test("cu_run never issues a decision call past the budget for the risk rating", async () => {
  const runner = new FakeCliRunner((args) => (args[0] === "snapshot" ? snapshotEnvelope(prefsTree) : mutationEnvelope(args)));
  const decisionClient = new FakeDecisionClient();
  decisionClient.queue(
    runStep("CLICK", "@s1:e1", { confidence: 0.62 }),
    riskAnswer(0.1),
    runStep("CLICK", "@s1:e1", { confidence: 0.62 }),
    riskAnswer(0.1),
  );
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await runGoal(deps, {
    goal: "open the appearance settings",
    app: "Preferences",
    maxJevCalls: 3,
  });
  const details = result.details as any;

  // Turn 1 spends call 1 (plan) + call 2 (risk). Turn 2 spends call 3 (plan) and
  // must not spend a fourth call rating risk past the budget.
  assert.equal(details.stop, "budget: jev calls");
  assert.equal(details.jev_calls, 3);
  assert.equal(decisionClient.requests.length, 3);
  assert.equal(details.turns, 1);
  assert.ok(details.notes.some((note: string) => /decision-call budget/.test(note)));
});

test("cu_run stops at the 80-Jev-call budget", async () => {
  const runner = new FakeCliRunner((args) => snapshotEnvelope(prefsTree));
  const decisionClient = new FakeDecisionClient(runStep("WAIT", null));
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await runGoal(deps, { goal: "wait for something to appear", app: "Preferences" });
  const details = result.details as any;

  assert.equal(details.stop, "budget: jev calls");
  assert.equal(details.jev_calls, 80);
  assert.equal(details.turns, 80);
  assert.equal(details.operations, 0);
});

/* -------------------------------------------------------------------------- */
/* Observation, abstention, streaming, abort                                   */
/* -------------------------------------------------------------------------- */

test("cu_run observes an open Overlay Surface instead of the Window behind it", async () => {
  const sheetTree: AdNode = {
    role: "sheet",
    name: "Allow access?",
    children: [{ role: "push button", name: "Allow", ref_id: "@s2:e1", available_actions: ["Click"] }],
  };
  const runner = new FakeCliRunner((args) => {
    if (args[0] !== "snapshot") return mutationEnvelope(args);
    if (args.includes("--surface")) return snapshotEnvelope(sheetTree, { surfaces: [{ kind: "sheet" }] });
    return snapshotEnvelope(prefsTree, { surfaces: [{ kind: "sheet" }] });
  });
  const decisionClient = new FakeDecisionClient();
  decisionClient.queue(
    runStep("CLICK", "@s2:e1", { confidence: 0.93 }),
    runStep("DONE", null),
  );
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await runGoal(deps, { goal: "allow access", app: "Preferences" });
  const details = result.details as any;

  assert.deepEqual(runner.argLists("snapshot").slice(0, 2), [
    ["snapshot", "--app", "Preferences", "-i", "--compact", "--include-bounds", "--skeleton"],
    ["snapshot", "--app", "Preferences", "-i", "--surface", "sheet"],
  ]);
  assert.equal(details.surface, "sheet");
  assert.deepEqual(runner.argLists("click"), [["click", "@s2:e1", "--app", "Preferences"]]);
  assert.ok(details.notes.some((note: string) => /Overlay Surface/.test(note)));
});

test("cu_run abstains when no offered element matches the Goal", async () => {
  const runner = new FakeCliRunner((args) => snapshotEnvelope(prefsTree));
  const decisionClient = new FakeDecisionClient(runStep("CLICK", "none", { confidence: 0.93 }));
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await runGoal(deps, { goal: "open a settings dialog that is not there", app: "Preferences" });
  const details = result.details as any;

  assert.match(details.stop, /^abstain: /);
  assert.equal(details.operations, 0);
  assert.equal(runner.invocations("click").length, 0);
  assert.equal(result.isError, undefined);
});

test("cu_run streams every completed turn through onUpdate", async () => {
  let mutations = 0;
  const runner = new FakeCliRunner((args) => {
    if (args[0] === "snapshot") return mutations > 0 ? snapshotEnvelope(checkedTree) : snapshotEnvelope(prefsTree);
    mutations += 1;
    return mutationEnvelope(args);
  });
  const decisionClient = new FakeDecisionClient();
  decisionClient.queue(
    runStep("CLICK", "@s1:e1", { confidence: 0.92 }),
    runStep("CHECK", "@s1:e2", { confidence: 0.93 }),
    runStep("DONE", null),
  );
  const deps = makeDeps({ cli: runner, decision: decisionClient });
  const updates: any[] = [];

  await runTool(deps).execute(
    "call-run",
    { goal: "open Appearance and enable Dark Mode", app: "Preferences" },
    undefined,
    (update: any) => updates.push(update),
    makeContext(),
  );

  assert.equal(updates.length, 3);
  assert.deepEqual(updates[0].details, {
    turn: 1,
    operation: "CLICK",
    target: { ref: "@s1:e1", role: "push button", name: "Appearance" },
    decision: "act",
    delivery: "delivered_verified",
    changed: true,
  });
  assert.deepEqual(updates[1].details.changed, false);
  assert.equal(updates[2].details.operation, "DONE");
  assert.equal(updates[2].details.decision, null);
  assert.equal(updates[2].details.stop, "done");
  assert.match(updates[0].content[0].text, /"operation":"CLICK"/);
});

test("cu_run forwards the AbortSignal to the runner and the decision client", async () => {
  const runner = new FakeCliRunner((args) => snapshotEnvelope(prefsTree));
  const signals: Array<AbortSignal | undefined> = [];
  const decisionClient = new FakeDecisionClient((request, signal) => {
    signals.push(signal);
    return runStep("DONE", null)(request);
  });
  const deps = makeDeps({ cli: runner, decision: decisionClient });
  const controller = new AbortController();

  await runTool(deps).execute(
    "call-run",
    { goal: "inspect the preferences", app: "Preferences" },
    controller.signal,
    undefined,
    makeContext(),
  );

  assert.equal(runner.calls[0].options?.signal, controller.signal);
  assert.equal(signals.length, 1);
  assert.equal(signals[0], controller.signal);
});

test("cu_run lets a cancelled decision request abort instead of reporting DECISION_FAILED", async () => {
  const runner = new FakeCliRunner((args) => snapshotEnvelope(prefsTree));
  const decisionClient = new FakeDecisionClient(() => {
    throw Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" });
  });
  const deps = makeDeps({ cli: runner, decision: decisionClient });
  const controller = new AbortController();

  await assert.rejects(
    runTool(deps).execute(
      "call-run",
      { goal: "inspect the preferences", app: "Preferences" },
      controller.signal,
      undefined,
      makeContext(),
    ),
    /aborted/i,
  );
});
