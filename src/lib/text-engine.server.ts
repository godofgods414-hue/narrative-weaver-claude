/**
 * The ONLY text engine in this app: Claude Opus 5 via tabitoken.com.
 *
 * There is deliberately no other provider, and thinking is disabled.
 */

import { claudeChat } from "./claude.server";

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
  return claudeChat(user, { system, ...opts });
}
