/**
 * Async `agent-desktop` subprocess runner and state-root guard.
 *
 * The state directory must be private (`0700`): `agent-desktop` refuses to
 * write snapshots into a group- or world-accessible root.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdEnvelope,
  BinaryResolution,
  CliRunOptions,
  CliRunResult,
  CliRunner,
  StateRootInfo,
} from "../types.js";

export const DEFAULT_TIMEOUT_MS = 15_000;
export const PROBE_BINARY_PATH = "/tmp/ad-probe/node_modules/.bin/agent-desktop";

export interface AgentDesktopCliRunnerOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  /** Package root used to look up `node_modules/.bin/agent-desktop`. */
  packageRoot?: string;
  probePath?: string;
  /** Override executable lookup, for tests. */
  pathLookup?: (env: NodeJS.ProcessEnv) => string | null;
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultPackageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..");
}

export function searchPath(env: NodeJS.ProcessEnv): string | null {
  const raw = env.PATH ?? "";
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "agent-desktop");
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

export class AgentDesktopCliRunner implements CliRunner {
  private readonly env: NodeJS.ProcessEnv;
  private readonly homedir: string;
  private readonly packageRoot: string;
  private readonly probePath: string;
  private readonly pathLookup: (env: NodeJS.ProcessEnv) => string | null;
  private cached: BinaryResolution | null | undefined;

  constructor(options: AgentDesktopCliRunnerOptions = {}) {
    this.env = options.env ?? process.env;
    this.homedir = options.homedir ?? os.homedir();
    this.packageRoot = options.packageRoot ?? defaultPackageRoot();
    this.probePath = options.probePath ?? PROBE_BINARY_PATH;
    this.pathLookup = options.pathLookup ?? searchPath;
  }

  resolve(): BinaryResolution | null {
    if (this.cached !== undefined) return this.cached;

    const explicit = this.env.AGENT_DESKTOP_BIN?.trim();
    if (explicit && isExecutableFile(explicit)) {
      this.cached = { binary: explicit, source: "env" };
      return this.cached;
    }

    const local = path.join(this.packageRoot, "node_modules", ".bin", "agent-desktop");
    if (isExecutableFile(local)) {
      this.cached = { binary: local, source: "package" };
      return this.cached;
    }

    if (isExecutableFile(this.probePath)) {
      this.cached = { binary: this.probePath, source: "probe" };
      return this.cached;
    }

    const onPath = this.pathLookup(this.env);
    this.cached = onPath ? { binary: onPath, source: "path" } : null;
    return this.cached;
  }

  stateRoot(): string {
    const configured = this.env.AGENT_DESKTOP_HOME?.trim();
    if (configured) return path.resolve(configured);
    return path.join(this.homedir, ".agent-desktop");
  }

  async ensureStateRoot(): Promise<StateRootInfo> {
    const root = this.stateRoot();
    let created = false;
    if (!fs.existsSync(root)) {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      created = true;
    }
    const stat = fs.statSync(root);
    let mode = stat.mode & 0o777;
    if (mode !== 0o700) {
      fs.chmodSync(root, 0o700);
      mode = fs.statSync(root).mode & 0o777;
    }
    return { path: root, mode, created };
  }

  run(args: string[], options: CliRunOptions = {}): Promise<CliRunResult> {
    const started = Date.now();
    const resolution = this.resolve();
    if (!resolution) {
      return Promise.resolve({
        envelope: {
          ok: false,
          command: args[0],
          error: {
            code: "BINARY_NOT_FOUND",
            message: "agent-desktop executable not found",
            suggestion:
              "Run npm install in the pi-omarchy-cu package (agent-desktop is a dependency), or set AGENT_DESKTOP_BIN to an existing agent-desktop executable.",
            disposition: { delivery: "not_delivered", retry: "safe" },
          },
        },
        stdout: "",
        stderr: "",
        exitCode: null,
        durationMs: Date.now() - started,
        binary: "",
        args,
        timedOut: false,
        aborted: false,
      });
    }

    // The state root must be private before every invocation. Do this
    // synchronously: the child process must never start against a stale mode.
    try {
      const root = this.stateRoot();
      if (!fs.existsSync(root)) {
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      }
      const stat = fs.statSync(root);
      if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(root, 0o700);
    } catch {
      // Let agent-desktop report the problem in its own envelope.
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const env: NodeJS.ProcessEnv = { ...this.env, ...(options.env ?? {}) };

    return new Promise<CliRunResult>((resolvePromise) => {
      execFile(
        resolution.binary,
        args,
        {
          timeout: timeoutMs,
          signal: options.signal,
          env,
          cwd: options.cwd,
          maxBuffer: 32 * 1024 * 1024,
          encoding: "utf8",
        },
        (error, stdoutRaw, stderrRaw) => {
          const stdout = typeof stdoutRaw === "string" ? stdoutRaw : "";
          const stderr = typeof stderrRaw === "string" ? stderrRaw : "";
          const err = error as (NodeJS.ErrnoException & { code?: string | number; killed?: boolean }) | null;
          const aborted = Boolean(
            options.signal?.aborted || err?.name === "AbortError" || err?.code === "ABORT_ERR",
          );
          const timedOut = err?.killed === true && !aborted;

          if (aborted) {
            resolvePromise({
              envelope: {
                ok: false,
                command: args[0],
                error: {
                  code: "ABORTED",
                  message: "agent-desktop command was cancelled.",
                  disposition: { delivery: "not_delivered", retry: "safe" },
                },
              },
              stdout,
              stderr,
              exitCode: null,
              durationMs: Date.now() - started,
              binary: resolution.binary,
              args,
              timedOut: false,
              aborted: true,
            });
            return;
          }

          const envelope = parseEnvelope(stdout, stderr);
          const exitCode = typeof err?.code === "number" ? err.code : err ? 1 : 0;

          resolvePromise({
            envelope:
              envelope ??
              ({
                ok: false,
                command: args[0],
                error: {
                  code: timedOut ? "TIMEOUT" : "INVALID_OUTPUT",
                  message: timedOut
                    ? `agent-desktop ${args[0] ?? ""} timed out after ${timeoutMs}ms`
                    : `agent-desktop did not print a JSON envelope (exit ${exitCode}).`,
                  details: { stderr: stderr.slice(0, 2000), stdout: stdout.slice(0, 2000) },
                  disposition: { delivery: "not_delivered", retry: "safe" },
                },
              } satisfies AdEnvelope),
            stdout,
            stderr,
            exitCode,
            durationMs: Date.now() - started,
            binary: resolution.binary,
            args,
            timedOut,
            aborted: false,
          });
        },
      );
    });
  }
}

/** Extract the first JSON object that looks like an `agent-desktop` envelope. */
export function parseEnvelope(stdout: string, stderr = ""): AdEnvelope | null {
  for (const source of [stdout, stderr]) {
    const trimmed = source.trim();
    if (!trimmed) continue;
    const candidates = [trimmed];
    for (const line of trimmed.split("\n")) {
      const candidate = line.trim();
      if (candidate.startsWith("{") && candidate.endsWith("}")) candidates.push(candidate);
    }
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === "object" && typeof parsed.ok === "boolean") {
          return parsed as AdEnvelope;
        }
      } catch {
        // keep trying
      }
    }
  }
  return null;
}
