/**
 * Jev System One configuration resolution.
 *
 * Mirrors `pi-jev` so a user who already configured Jev for Pi needs no extra
 * setup:
 *
 * - endpoint: `PI_JEV_BASE_URL` -> `TYPESAFE_BASE_URL` -> OpenRouter default
 *   (when an OpenRouter key is in play) -> TypeSafe default.
 * - key: `$TYPESAFE_API_KEY` -> `~/.pi/agent/secrets/typesafe_api_key` ->
 *   `$OPENROUTER_API_KEY` -> `~/.pi/agent/secrets/openrouter_api_key` ->
 *   empty string for an explicit loopback endpoint.
 * - model: explicit -> `PI_JEV_MODEL` -> `TYPESAFE_MODEL` ->
 *   `TYPESAFE_DEFAULT_MODEL` -> `~typesafe/jev-latest` on OpenRouter
 *   (bare names are scoped) or `jev-latest` on TypeSafe.
 *
 * `@typesafe-ai/sdk` appends `/v1/systemone` to its `baseURL`, so an explicit
 * endpoint is reduced to its root before it reaches the SDK and the effective
 * request endpoint is reported separately.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const TYPESAFE_DEFAULT_ROOT = "https://api.typesafe.ai";
export const OPENROUTER_DEFAULT_ROOT = "https://openrouter.ai/api";
export const SYSTEM_ONE_PATH = "/v1/systemone";
/** The request endpoint the SDK builds for the TypeSafe default root. */
export const TYPESAFE_DEFAULT_ENDPOINT = `${TYPESAFE_DEFAULT_ROOT}${SYSTEM_ONE_PATH}`;
export const OPENROUTER_DEFAULT_MODEL = "~typesafe/jev-latest";
export const TYPESAFE_DEFAULT_MODEL = "jev-latest";

export type KeySource = "env" | "file";

export interface ResolvedKey {
  key: string;
  source: KeySource;
  origin: string;
}

export interface JevConfig {
  /** SDK API root; `null` leaves the TypeSafe default root to the SDK. */
  baseURL: string | null;
  /** The effective `/v1/systemone` request endpoint, safe to report to the model. */
  endpoint: string;
  apiKey: string | null;
  keyOrigin: string | null;
  model: string;
  openrouter: boolean;
  configured: boolean;
  /** Set when configuration exists but is unusable (bad URL, embedded credentials, missing key). */
  problem: string | null;
}

export interface ResolveJevConfigOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  readFile?: (file: string) => string | null;
  /** Explicit model passed by the caller. */
  model?: string;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function defaultReadFile(file: string): string | null {
  try {
    if (!fs.existsSync(file)) return null;
    const content = fs.readFileSync(file, "utf8").trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

export function resolveApiKey(options: ResolveJevConfigOptions = {}): ResolvedKey | null {
  const env = options.env ?? process.env;
  const homedir = options.homedir ?? os.homedir();
  const readFile = options.readFile ?? defaultReadFile;

  const typesafeEnv = envValue(env, "TYPESAFE_API_KEY");
  if (typesafeEnv) return { key: typesafeEnv, source: "env", origin: "$TYPESAFE_API_KEY" };

  const typesafeFile = readFile(path.join(homedir, ".pi", "agent", "secrets", "typesafe_api_key"));
  if (typesafeFile) {
    return {
      key: typesafeFile,
      source: "file",
      origin: "~/.pi/agent/secrets/typesafe_api_key",
    };
  }

  const openrouterEnv = envValue(env, "OPENROUTER_API_KEY");
  if (openrouterEnv) return { key: openrouterEnv, source: "env", origin: "$OPENROUTER_API_KEY" };

  const openrouterFile = readFile(
    path.join(homedir, ".pi", "agent", "secrets", "openrouter_api_key"),
  );
  if (openrouterFile) {
    return {
      key: openrouterFile,
      source: "file",
      origin: "~/.pi/agent/secrets/openrouter_api_key",
    };
  }

  return null;
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

export interface UrlValidation {
  ok: boolean;
  problem: string | null;
}

/** HTTPS for remote hosts; HTTP only for loopback. No embedded credentials. */
export function validateEndpoint(raw: string): UrlValidation {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, problem: `Jev endpoint is not a valid URL: ${raw}` };
  }

  if (url.username || url.password) {
    return { ok: false, problem: "Jev endpoint must not contain embedded credentials." };
  }

  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol === "https:") return { ok: true, problem: null };
  if (url.protocol === "http:") {
    if (loopback) return { ok: true, problem: null };
    return {
      ok: false,
      problem: `Jev endpoint ${url.hostname} uses plain HTTP; only https or a loopback http endpoint is allowed.`,
    };
  }
  return { ok: false, problem: `Jev endpoint must use http(s), got ${url.protocol}` };
}

function scopeOpenRouterModel(model: string): string {
  if (model.includes("/")) return model;
  return `~typesafe/${model}`;
}

/**
 * Reduce an explicit endpoint to the API root the SDK expects.
 *
 * Both `https://api.typesafe.ai` and `https://api.typesafe.ai/v1/systemone` are
 * accepted, so a value copied from TypeSafe's docs cannot produce a doubled
 * `.../v1/systemone/v1/systemone` request path.
 */
export function systemOneRoot(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  const withoutPath = trimmed.endsWith(SYSTEM_ONE_PATH)
    ? trimmed.slice(0, -SYSTEM_ONE_PATH.length)
    : trimmed;
  return withoutPath.replace(/\/+$/, "");
}

export function resolveJevConfig(options: ResolveJevConfigOptions = {}): JevConfig {
  const env = options.env ?? process.env;
  const explicitBase = envValue(env, "PI_JEV_BASE_URL") ?? envValue(env, "TYPESAFE_BASE_URL");
  const key = resolveApiKey(options);

  const openrouterKey =
    key?.origin === "$OPENROUTER_API_KEY" ||
    key?.origin === "~/.pi/agent/secrets/openrouter_api_key" ||
    Boolean(key?.key.startsWith("sk-or-"));

  const openrouterEndpoint = explicitBase
    ? explicitBase.includes("openrouter.ai")
    : !explicitBase && openrouterKey;
  const openrouter = openrouterEndpoint;

  let problem: string | null = null;
  let baseURL: string | null = null; // SDK root; null means "the SDK's TypeSafe default"

  if (explicitBase) {
    const validation = validateEndpoint(explicitBase);
    if (validation.ok) baseURL = systemOneRoot(explicitBase);
    else problem = validation.problem;
  } else if (openrouter) {
    baseURL = OPENROUTER_DEFAULT_ROOT;
  }

  const endpoint = baseURL === null ? TYPESAFE_DEFAULT_ENDPOINT : `${baseURL}${SYSTEM_ONE_PATH}`;

  const explicitModel = options.model?.trim();
  const modelEnv =
    envValue(env, "PI_JEV_MODEL") ??
    envValue(env, "TYPESAFE_MODEL") ??
    envValue(env, "TYPESAFE_DEFAULT_MODEL");

  let model = explicitModel ?? modelEnv ?? (openrouter ? OPENROUTER_DEFAULT_MODEL : TYPESAFE_DEFAULT_MODEL);
  if (openrouter) model = scopeOpenRouterModel(model);

  const loopbackEndpoint = baseURL ? isLoopbackHost(new URL(baseURL).hostname) : false;
  const apiKey = key?.key ?? (explicitBase && loopbackEndpoint && !openrouter ? "" : null);

  if (apiKey === null) {
    problem = problem ?? "No Jev API key found (TYPESAFE_API_KEY, OPENROUTER_API_KEY, or a pi secret file).";
  }

  return {
    baseURL,
    endpoint,
    apiKey,
    keyOrigin: key?.origin ?? null,
    model,
    openrouter,
    // A keyless loopback endpoint is configured: the empty key is deliberate.
    configured: apiKey !== null && problem === null,
    problem,
  };
}
