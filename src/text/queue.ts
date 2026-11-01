/**
 * Shared caller-supplied text queue and scoped redaction.
 *
 * `TYPE_TEXT` and `SELECT` both consume one string per turn. Only strings
 * consumed by `TYPE_TEXT` are tracked as sensitive: redacting SELECT option
 * labels would corrupt real UI labels and Window titles in turn output.
 */

export type TextSupply = string | string[] | undefined;

export class TextQueue {
  private remaining: string[];
  private readonly sensitive: string[] = [];

  constructor(source?: TextSupply) {
    if (source === undefined) this.remaining = [];
    else if (Array.isArray(source)) this.remaining = source.filter((value) => typeof value === "string");
    else this.remaining = [source];
    this.remaining = this.remaining.filter((value) => value.length > 0);
  }

  get size(): number {
    return this.remaining.length;
  }

  get empty(): boolean {
    return this.remaining.length === 0;
  }

  peek(): string | undefined {
    return this.remaining[0];
  }

  /** Consume the next string, optionally marking it sensitive. */
  take(options: { sensitive?: boolean } = {}): string | undefined {
    const value = this.remaining.shift();
    if (value !== undefined && options.sensitive) this.sensitive.push(value);
    return value;
  }

  /** Strings that must never reach model history or tool output. */
  get secrets(): readonly string[] {
    return this.sensitive;
  }

  /** Redact tracked sensitive values from one string. */
  redact(value: string): string {
    return redactSecrets(value, this.sensitive);
  }
}

export const REDACTED = "[redacted]";

export function redactSecrets(value: string, secrets: readonly string[]): string {
  if (!value || secrets.length === 0) return value;
  let out = value;
  // Longest first so a secret containing another secret is fully removed.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (!secret) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

/**
 * Redact any string that appears in a structured value. Used for
 * `recent_actions` entries built by the Goal loop.
 */
export function redactDeep<T>(value: T, secrets: readonly string[]): T {
  if (secrets.length === 0) return value;
  if (typeof value === "string") return redactSecrets(value, secrets) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, secrets)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactDeep(item, secrets);
    }
    return out as unknown as T;
  }
  return value;
}
