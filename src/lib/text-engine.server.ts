/**
 * The ONLY text engine in this app: MiniMax M3 (free) on OpenRouter.
 *
 * There is deliberately no other provider. The key pool rotates automatically
 * when a key's daily free allowance runs out (see openrouter.server.ts).
 */

import { openrouterChat } from "./openrouter.server";

export async function textChat(
  system: string,
  user: string,
  opts: {
    temperature?: number;
    maxOutputTokens?: number;
    timeoutMs?: number;
    attempts?: number;
  } = {},
): Promise<string> {
  return openrouterChat(user, { system, ...opts });
}
