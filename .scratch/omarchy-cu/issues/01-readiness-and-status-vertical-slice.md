# 01: Readiness, AT-SPI Blind-Spot Diagnostics, and `/cu` Command (`cu_status` & `/cu`)

**What to build:** Scaffold the standalone Pi extension package and deliver the `cu_status` tool and `/cu` interactive slash command (`status`, `apps`, `windows`) end-to-end. Invoking `cu_status` or `/cu` resolves the `agent-desktop` binary, enforces `0700` permissions on the state directory, queries AT-SPI bus readiness and supported surfaces, lists visible applications and Windows, inspects in-process Jev System One configuration (`isConfigured`, key origin, endpoint, model), and detects running Chromium, Electron, or Qt desktop processes that are missing from the AT-SPI bus along with exact launch flag guidance and the Electron single-client bridge warning.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] Standalone Pi package configuration (`package.json`, TypeScript config, test script, and extension entrypoint) loads cleanly and exposes injectable `CliRunner` and `DecisionClient` interfaces at the extension boundary.
- [x] `CliRunner` resolves the `agent-desktop` binary (`AGENT_DESKTOP_BIN` → local `node_modules/.bin/agent-desktop` → `/tmp/ad-probe` fallback → `PATH`), enforces mode `0700` on `AGENT_DESKTOP_HOME` / `~/.agent-desktop` before execution, runs asynchronously without blocking the event loop, and aborts immediately when its `AbortSignal` fires.
- [x] In-process Jev configuration resolution matches `pi-jev` (`PI_JEV_BASE_URL` / `TYPESAFE_BASE_URL`, `PI_JEV_MODEL` / `TYPESAFE_MODEL`, `$TYPESAFE_API_KEY`, `~/.pi/agent/secrets/typesafe_api_key`, `$OPENROUTER_API_KEY`, `~/.pi/agent/secrets/openrouter_api_key`, OpenRouter `~typesafe/` model scoping, and HTTPS / loopback HTTP validation).
- [x] `cu_status` returns structured readiness data covering binary version, state directory permissions, AT-SPI bus status and supported surfaces, Jev configuration status, visible AT-SPI applications and Windows, and AT-SPI blind-spot warnings for running Chromium/Electron/Qt processes not registered on the bus.
- [x] `/cu` slash command supports `/cu status`, `/cu apps`, and `/cu windows` for zero-token interactive inspection.
- [x] Tool-seam tests and a live subprocess smoke test verify `cu_status`, `/cu`, `0700` directory enforcement, and `AbortSignal` cancellation.
