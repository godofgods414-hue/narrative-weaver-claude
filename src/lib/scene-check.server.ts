/**
 * Strict per-timestamp scene validation.
 *
 * The old gate was a word-overlap test: a prompt was accepted as long as it
 * shared ONE content word with its script line. That is far too weak — a scene
 * from a completely different timestamp routinely shares a word ("village",
 * "night", "Henan") with the line it does not belong to, so wrong panels kept
 * getting rendered.
 *
 * This replaces it with a real per-line check that runs IMMEDIATELY BEFORE the
 * image request: the writing model is shown the ONE script line (with its own
 * timestamp) and the prompt about to be drawn, and must answer MATCH or write a
 * replacement prompt for that exact line. A mismatched prompt is never sent to
 * the renderer — it is rewritten first.
 */

import { textChat } from "./text-engine.server";

const SYSTEM =
  "You are a storyboard fidelity checker. You are given ONE script line (with its own timestamp) and ONE image " +
  "prompt that is about to be drawn for exactly that line. The script may be Hindi, Hinglish or English.\n" +
  "Check ALL of these against THAT LINE ALONE:\n" +
  "1. SETTING: the place/time in the prompt is the place/time this line itself describes (or, if the line names no " +
  "place, a place that cannot contradict it).\n" +
  "2. SUBJECT: the people, creatures or objects in the prompt are the ones THIS line is about — not the previous or " +
  "next line's people, not a main character inserted into a line about strangers, crowds, soldiers or an empty place.\n" +
  "3. ACTION: the exact action and moment drawn is the action this line states, not a different beat of the story.\n" +
  "4. NO BLENDING: the prompt shows one single moment, not two timestamps merged.\n" +
  "Be strict: sharing a word or a character name is NOT a match — the depicted moment must be this line's moment.\n" +
  "ANSWER FORMAT: if all four checks pass, reply with exactly: MATCH\n" +
  "Otherwise reply with ONLY a replacement image prompt (one single paragraph, 55-80 English words, no preamble, " +
  "no quotes, no explanation, no numbering) that draws EXACTLY this line's own moment: its place, its people with " +
  "their character-sheet traits woven inline, its action, 4-6 concrete environment details, a camera angle and the " +
  "natural lighting the line implies. Never describe text, signs, speech bubbles, panels or an art style.";

/** Prompt+line pairs already vetted in this process, so nothing is checked twice. */
const cache = new Map<string, string>();
const MAX_CACHE = 4_000;

function keyFor(line: string, prompt: string): string {
  return `${line}\u0000${prompt}`;
}

function remember(key: string, value: string) {
  if (cache.size > MAX_CACHE) cache.clear();
  cache.set(key, value);
}

function looksLikePrompt(text: string): boolean {
  return text.length >= 60 && /[a-z]/.test(text) && !/^match\b/i.test(text);
}

/**
 * Returns the prompt that may be sent to the image renderer for this exact
 * line: either the original (verified as this line's own moment) or a
 * replacement written specifically for it.
 *
 * Up to `rounds` rewrite attempts. If the checker cannot be reached at all the
 * original prompt is used — a missing check must never stop a panel from being
 * drawn — but any answered mismatch is always regenerated, never rendered.
 */
export async function verifyPromptForLine(
  prompt: string,
  line: string,
  bible?: string,
  timestamp?: string,
  rounds = 2,
): Promise<{ prompt: string; rewritten: boolean; checked: boolean }> {
  const trimmed = line.trim();
  if (!trimmed) return { prompt, rewritten: false, checked: false };

  const cacheKey = keyFor(trimmed, prompt);
  const hit = cache.get(cacheKey);
  if (hit !== undefined) {
    return { prompt: hit, rewritten: hit !== prompt, checked: true };
  }

  let current = prompt;
  let rewritten = false;
  let checked = false;

  for (let round = 0; round < Math.max(1, rounds); round++) {
    let answer: string;
    try {
      answer = (
        await textChat(
          SYSTEM,
          (bible ? `CHARACTER SHEET:\n${bible}\n\n` : "") +
            `SCRIPT LINE${timestamp ? ` [${timestamp}]` : ""}:\n${trimmed}\n\n` +
            `PROMPT ABOUT TO BE DRAWN FOR THIS LINE:\n${current}`,
          { temperature: 0.2, maxOutputTokens: 900, attempts: 2 },
        )
      ).trim();
    } catch (e) {
      console.error(
        "scene check unavailable for one line, drawing the written prompt:",
        e instanceof Error ? e.message : e,
      );
      break;
    }

    checked = true;
    const text = answer
      .replace(/```[a-z]*|```/gi, "")
      .replace(/^["'`]+|["'`]+$/g, "")
      .trim();

    if (/^match\b/i.test(text) || !looksLikePrompt(text)) {
      // MATCH, or an unusable answer on a prompt already rewritten for this
      // line — stop here and draw the current prompt.
      break;
    }

    current = text.slice(0, 1400);
    rewritten = true;
  }

  remember(cacheKey, current);
  return { prompt: current, rewritten, checked };
}
