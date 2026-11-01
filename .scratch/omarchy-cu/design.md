# Module boundaries and shared seams

Implementation guide for the tickets in `.scratch/omarchy-cu/issues/`. Read the
[spec](./spec.md), the tickets, `GLOSSARY.md`, and the two ADRs first.

## The one test seam

Everything is tested through the Pi tool boundary:

```ts
const deps = makeDeps({ cli: new FakeCliRunner(handler), decision: new FakeDecisionClient(handler) });
const tools = createCuTools(deps);
const result = await tools[1].execute("call-1", params, signal, onUpdate, makeContext());
```

- `src/types.ts` defines `CliRunner` and `DecisionClient`; `test/fakes.ts`
  provides `FakeCliRunner`, `FakeDecisionClient`, `makeDeps`, `makeContext`,
  `okEnvelope`, `errEnvelope`, `answeringDecision`, `sdkClientWithTransport`.
- `src/extension.ts` wires production dependencies; `createCuTools(deps)`
  returns `[cu_status, cu_observe, cu_ref, cu_act, cu_run]` in that order.
- Tool modules own their `execute` body. Keep `name`, `description`,
  `promptSnippet`, `promptGuidelines`, and the parameter schema in
  `src/tools/schemas.ts` stable; extend the schema if a ticket truly needs a new
  field and say so in the commit message.
- Tests assert returned `content`/`details` and recorded boundary calls, never
  private helpers. No network, no real `agent-desktop` in tool-seam tests.

## Shared foundation (already built, treat as stable)

| Module | Responsibility |
| --- | --- |
| `src/agent-desktop/runner.ts` | `AgentDesktopCliRunner`: binary resolution, `0700` state root, async `execFile`, timeout, abort, envelope parsing. |
| `src/jev/config.ts` | Jev endpoint/key/model resolution and URL validation. |
| `src/jev/client.ts` | `SdkDecisionClient`: in-process SDK calls, retry on 429/503/529, abort. |
| `src/desktop/tree.ts` | Tree walking, offerable candidates, 254 cap, Overlay Surface detection, fingerprints. |
| `src/policy/route.ts` | `decideRoute`, `validateChoice`, confirmation text. |
| `src/policy/operations.ts` | 11 Wayland-safe Operations, required Advertised Actions, reconciliation, `SET_VALUE_ABSTAIN_REASON`. |
| `src/text/queue.ts` | `TextQueue`: ordered consumption, TYPE_TEXT-only secrets, scoped redaction. |
| `src/tools/shared.ts` | `CuTool`, result helpers, `formatForModel` cap. |
| `src/tools/schemas.ts` | Parameter schemas and input types for all five tools. |

If a foundation bug blocks a ticket, fix it in the ticket branch with a focused
test and call it out in the commit message. Do not restructure the foundation.

## Conventions

- TypeScript ESM, `.js` import specifiers for local modules, `type` imports for types.
- No new runtime dependencies without asking the supervisor.
- Tool output is compact JSON evidence, never the raw accessibility tree.
- Every abort path forwards the `AbortSignal` to the runner or decision client.
- `agent-desktop` is the only desktop boundary. Never shell out to `hyprctl`,
  `wtype`, `grim`, or `xdotool` (ADR-0002).
- Tests: `node --test --import tsx test/*.test.ts`. Typecheck: `npx tsc --noEmit`.
  Both must be green before you report done.

## Ticket ownership

| Ticket | Owns (primarily) |
| --- | --- |
| 01 | `src/tools/status.ts`, new `src/tools/blind-spots.ts`, `src/commands/cu.ts`, `test/status.test.ts`, `test/runner-live.test.ts` |
| 02 | `src/tools/observe.ts`, `src/desktop/*`, `test/observe.test.ts` |
| 03 | `src/tools/ref.ts`, `src/agent-desktop/*`, `test/ref.test.ts` |
| 04 | `src/tools/act.ts`, `src/decide/*`, `test/act.test.ts` |
| 05 | `src/tools/run.ts`, `src/decide/loop.ts`, `skills/omarchy-cu/SKILL.md`, `README.md`, `test/run.test.ts` |

Shared rows in this table (`src/desktop/*`, `src/agent-desktop/*`,
`src/decide/*`) mean "add new files here"; another ticket may be doing the same
on its own branch, so prefer a new file over editing one you do not own.

## Git protocol

- Each ticket works in its own worktree on `ticket/NN-<slug>`, based on the
  `integration` branch tip.
- Before reporting done: `git fetch` is unnecessary, but merge the current
  `integration` tip into your branch (from the main repo path) and resolve
  conflicts in favor of the ticket you own.
- Commit with a `feat(cu): ...` / `test(cu): ...` message. Leave the worktree
  clean.
