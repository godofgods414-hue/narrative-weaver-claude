/**
 * API key pools.
 *
 * Image keys (Pixazo) are used in parallel — several renders at once.
 * Text keys (OpenRouter) are NEVER used in parallel: one key is active at a time
 * and the pool only advances when that key's daily quota is exhausted
 * (see openrouter.server.ts).
 */

function readPool(prefix: string): string[] {
  const keys: string[] = [];
  const base = process.env[prefix];
  if (base) keys.push(base.trim());
  for (let i = 1; i <= 12; i++) {
    const v = process.env[`${prefix}_${i}`];
    if (v && v.trim()) keys.push(v.trim());
  }
  return [...new Set(keys)];
}

export function pixazoKeys(): string[] {
  const keys = readPool("PIXAZO_API_KEY");
  if (keys.length === 0) throw new Error("Missing PIXAZO_API_KEY");
  return keys;
}

export function openrouterKeys(): string[] {
  const keys = readPool("OPENROUTER_API_KEY");
  if (keys.length === 0) throw new Error("Missing OPENROUTER_API_KEY");
  return keys;
}

/**
 * Deterministic spread for the IMAGE pool: a caller passes the scene index as
 * `slot`, so consecutive scenes running at the same time land on different
 * keys. `attempt` shifts to the next key on a retry.
 */
export function pickKey(keys: string[], slot: number, attempt = 0): string {
  const n = keys.length;
  const i = ((((slot % n) + n) % n) + attempt) % n;
  return keys[i] as string;
}
