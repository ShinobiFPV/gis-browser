/**
 * Safe coercion of untrusted JSON scalars.
 *
 * Service responses are `unknown` and stringifying an object into an id would produce
 * "[object Object]" -- a value that looks fine in the database and silently breaks the
 * lazy geometry fetch later. These helpers make the failure happen at ingest instead.
 */

export function asText(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

export function asNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** Feature identifiers must be a string or a number. Anything else is a hard error. */
export function asFeatureId(value: unknown, context: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new Error(`${context}: expected a string or number identifier, got ${JSON.stringify(value)}`);
}
