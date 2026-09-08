/**
 * API key pools.
 *
 * Image keys (Pixazo) are used in parallel — several renders at once.
 * The text key (Agnes AI) is read directly from the
 * environment in agnes.server.ts.
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
