/**
 * Cancellation shared by the tool modules and the decision client.
 *
 * The SDK throws `APIUserAbortError` when the caller aborts a request, while
 * `AbortSignal` and DOM `fetch` produce `AbortError`; both mean "the user
 * pressed Escape", never "the decision model failed".
 */

const ABORT_ERROR_NAMES: ReadonlySet<string> = new Set(["AbortError", "APIUserAbortError"]);

/** True when an error is, or exists only because of, a caller cancellation. */
export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" && ABORT_ERROR_NAMES.has(name);
}

/** The `AbortError` this extension raises for a signal that was already aborted. */
export function createAbortError(): Error {
  const error = new Error("Jev request aborted");
  error.name = "AbortError";
  return error;
}
