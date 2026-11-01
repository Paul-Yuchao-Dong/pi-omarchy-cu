# Omarchy Computer Use

Semantic desktop observation and goal-driven interaction for Linux applications over the accessibility tree, where a calibrated decision model chooses targets and operations while deterministic policy enforces capability and risk boundaries.

## Surfaces & Identity

**Window**:
A top-level application frame on the accessibility bus, addressed by an application identifier and an optional opaque window identifier.
_Avoid_: Screen, frame, view

**Overlay Surface**:
A transient modal or popup layer (sheet, alert, menu, or popover) that owns interaction priority over its parent Window while open.
_Avoid_: Surface, popup, dialog, modal

**Region**:
A subtree of a Window rooted at a specific container node that holds child elements omitted from a shallow overview read.
_Avoid_: Subtree, scope, container

**Ref**:
A snapshot-scoped address bound to a single live accessibility node and its identity within a Window.
_Avoid_: Element ID, handle, selector, locator

**Advertised Action**:
A semantic interaction capability that a live accessibility node explicitly reports it can receive.
_Avoid_: Capability, method, supported verb

## Decisions & Execution

**Intent**:
A single plain-language instruction describing one step to resolve against the current Window or Overlay Surface.
_Avoid_: Prompt, query, command string

**Goal**:
A plain-language outcome driven across multiple observe-decide-act turns until visibly satisfied or stopped by policy.
_Avoid_: Task, script, workflow

**Operation**:
A canonical interaction or navigation step chosen by the decision model before translation into an executable call.
_Avoid_: Command, verb, action

**Route Decision**:
The deterministic policy outcome (`act`, `confirm`, `abstain`, or `needs_text`) computed from target confidence and destructive-risk probability against fixed thresholds.
_Avoid_: Verdict, judgment, gate result

**Delivery Disposition**:
The post-execution verification state indicating whether an Operation was delivered and verified, delivered without verification, not delivered, or was a non-mutating look/wait turn.
_Avoid_: Execution status, result code, outcome
