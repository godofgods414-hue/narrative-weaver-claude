/**
 * The only text engine in this app: Claude Opus 5, served through the
 * tabitoken.com OpenAI-compatible endpoint.
 *
 * Rules baked in here:
 *  - ONE model only (`TABITOKEN_MODEL`, default `claude-opus-5`).
 *  - Thinking / extended reasoning is explicitly DISABLED on every request.
 *  - Requests are queued: one call in flight at a time, with a small gap so
 *    the account's rate limit is never raced.
 *  - The key lives only in the server environment; it is never sent to the
 *    browser and never written into the codebase.
 */

const API = "https://tabitoken.com/v1/chat/completions";

/** Fixed model. Override with the TABITOKEN_MODEL secret if the id differs. */
export function model(): string {
  return process.env["TABITOKEN_MODEL"]?.trim() || "claude-opus-5";
}

function apiKey(): string {
  const key = process.env["OPENAI_API_KEY"]?.trim();
  if (!key) throw new Error("Missing OPENAI_API_KEY (tabitoken.com key)");
  return key;
}

/** Largest answer to ask for. */
const MAX_OUT = 32_000;
/** Minimum gap between two requests. */
const MIN_GAP_MS = 1_200;

let lastUsed = 0;
/** Global serialization: one request in flight at a time. */
let chain: Promise<unknown> = Promise.resolve();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when the provider is momentarily busy — retry the same model. */
function busy(status: number, body: string): boolean {
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    /overloaded|temporarily|Upstream error|Provider returned error|no available channel/i.test(body)
  );
}

export type ChatOptions = {
  system?: string;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Total attempts before giving up. */
  attempts?: number;
};

/** One text completion, queued behind every other text call. */
export function claudeChat(user: string, opts: ChatOptions = {}): Promise<string> {
  const run = chain.then(
    () => callClaude(user, opts),
    () => callClaude(user, opts),
  );
  chain = run.catch(() => undefined);
  return run;
}

async function callClaude(user: string, opts: ChatOptions): Promise<string> {
  const attempts = opts.attempts ?? 6;
  let lastErr = "";

  for (let attempt = 0; attempt < attempts; attempt++) {
    const gap = MIN_GAP_MS - (Date.now() - lastUsed);
    if (gap > 0) await sleep(gap);
    lastUsed = Date.now();

    try {
      const res = await fetch(API, {
        method: "POST",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 600_000),
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${apiKey()}`,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          "HTTP-Referer": "https://lovable.dev",
          "X-Title": "Script to Manga",
        },
        body: JSON.stringify({
          model: model(),
          messages: [
            ...(opts.system ? [{ role: "system", content: opts.system }] : []),
            { role: "user", content: user },
          ],
          temperature: opts.temperature ?? 0.7,
          max_tokens: Math.min(MAX_OUT, opts.maxOutputTokens ?? 16_000),
          // Thinking stays OFF — both spellings, so whichever the relay
          // forwards to Anthropic keeps extended reasoning disabled.
          thinking: { type: "disabled" },
          reasoning_effort: "none",
          // STREAMING IS REQUIRED for long answers: a buffered request that
          // sends no bytes for ~2 minutes is severed by the hosting platform.
          stream: true,
        }),
      });

      if (res.ok) {
        const { text, err } = await readStream(res);
        if (text) return text;
        lastErr = err
          ? `${err.code ?? "error"} ${err.message ?? ""}`.trim()
          : "empty completion";
        await sleep(1_500 * (attempt + 1));
        continue;
      }

      const body = (await res.text().catch(() => "")).slice(0, 600);
      lastErr = `${res.status} ${body}`;

      if (busy(res.status, body)) {
        const retryAfter = Number(res.headers.get("retry-after") ?? 0);
        await sleep(retryAfter > 0 ? retryAfter * 1000 + 500 : 2_000 * (attempt + 1));
        continue;
      }
      if (res.status === 400 || res.status === 401 || res.status === 403) break;
      await sleep(1_200 * (attempt + 1));
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      await sleep(1_000 * (attempt + 1));
    }
  }

  throw new Error(`Claude request failed: ${lastErr}`);
}

export function engineStatus(): { model: string; keyIndex: number; keys: number } {
  return { model: model(), keyIndex: 1, keys: 1 };
}

/** Reads a streamed completion. */
async function readStream(
  res: Response,
): Promise<{ text: string; err?: { message?: string; code?: number | string } | undefined }> {
  const body = res.body;
  if (!body) return { text: "" };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let out = "";
  let err: { message?: string; code?: number | string } | undefined;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith(":")) continue;
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const json = JSON.parse(data) as {
          choices?: { delta?: { content?: string }; message?: { content?: string } }[];
          error?: { message?: string; code?: number | string };
        };
        if (json.error) err = json.error;
        const piece = json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content;
        if (piece) out += piece;
      } catch {
        /* keep reading: a partial frame arrives complete on the next chunk */
      }
    }
  }

  return { text: out.trim(), err };
}
