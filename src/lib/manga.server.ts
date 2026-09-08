import type { Segment } from "./script";
import { pixazoKeys, pickKey } from "./keys.server";
import { textChat } from "./text-engine.server";
import { verifyPromptForLine } from "./scene-check.server";

const PIXAZO_URL = "https://gateway.pixazo.ai/flux-1-schnell/v1/getData";

/**
 * Renderer-only art direction. The writing model describes only scene content;
 * this exact block is added at the final Pixazo request for every image.
 * Flux has no negative-prompt channel, so this stays entirely positive: naming
 * unwanted media such as photography or pencil sketches can make Flux draw them.
 */
export const STYLE =
  "FIXED VISUAL STYLE: polished 2D Japanese television anime frame, crisp uniform ink linework, " +
  "clean cel shading, restrained soft gradient highlights, expressive anime facial design, " +
  "consistent character proportions, richly painted anime background, vivid balanced colours, " +
  "sharp finished production artwork";

/**
 * The single authoritative light statement for every panel: natural, faithful
 * to the script, and always readable. Deliberately neutral — no darkness, no
 * mystery, no mood grade.
 */
export const TONE_LOCK =
  "LIGHTING: natural, clear and well-exposed, exactly as the scene describes (bright daylight stays bright, " +
  "a night scene is a well-lit night scene); faces, eyes and every environment detail are fully visible";

/**
 * Flux has NO negative prompt: every noun written here is a token the model can
 * draw. Long "no speech bubbles, no posters, no billboards..." lists were being
 * rendered literally (walls of speech bubbles and signage). So the guards are
 * now short and phrased POSITIVELY wherever possible.
 */
export const NO_TEXT_GUARD =
  "a pure wordless artwork, completely free of any text, lettering, signage, speech balloons or captions";

/** Single-image guard. Deliberately short; see NO_TEXT_GUARD note above. */
export const SINGLE_PANEL_GUARD =
  "one single full-bleed illustration of this one moment, one continuous scene edge to edge, fully drawn and detailed";

/** Added only when the scene has no people in it. */
export const NO_PEOPLE_GUARD =
  "an empty environment shot with no people, no figures and no characters anywhere in frame";

/** Added only when the scene does have named/described people. */
export const CAST_GUARD =
  "only the described cast is present, each person drawn once with their stated identity";

/**
 * Anatomy guard. Panels came back with two figures sharing one shirt and fused
 * torsos, so every body is now explicitly stated to be whole and separate.
 */
export const ANATOMY_GUARD =
  "anatomically correct bodies, one head, two arms and two legs per person, every figure a complete separate body with its own clothing, clearly spaced apart, never fused, merged, overlapping into one another or duplicated";

/**
 * Every text call in the app goes through Claude Opus 5 on tabitoken.com
 * (see claude.server.ts): one request at a time, with an automatic retry on
 * the next key when a daily free-model quota runs out. No other provider is
 * used anywhere in this app.
 */
export { textChat };

function stripFences(s: string): string {
  return s
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
}

/**
 * Forgiving reader for the prompt-writing answer.
 *
 * The free model kept refusing to emit a strict JSON array (unescaped quotes,
 * trailing prose, half-closed brackets), so the whole chunk was thrown away and
 * no panels ever appeared. The writing step now asks for plain "n) prompt"
 * lines and this parser accepts almost anything shaped like that:
 *
 *   - "1)" / "1." / "1:" / "1 -" / "[1]" / "Prompt 1:" numbering
 *   - leftover bullets, quotes, brackets, commas and code fences
 *   - a stray JSON array (parsed as such when it happens to be valid)
 *   - continuation lines, which are appended to the prompt above them
 *
 * Returns a sparse array indexed by (number - 1). Unnumbered output falls back
 * to reading the non-empty lines in order.
 */
export function parseNumberedList(raw: string, expected: number): string[] {
  const text = stripFences(raw);

  // If the model did return valid JSON after all, take it.
  const s = text.indexOf("[");
  const e = text.lastIndexOf("]");
  if (s !== -1 && e > s) {
    try {
      const parsed = JSON.parse(text.slice(s, e + 1)) as unknown;
      if (Array.isArray(parsed) && parsed.some((v) => typeof v === "string" && v.length > 30)) {
        return parsed.map((v) => (typeof v === "string" ? clean(v) : ""));
      }
    } catch {
      /* not JSON — fall through to the line reader */
    }
  }

  const out: string[] = [];
  const loose: string[] = [];
  let last = -1;
  const numbered = /^\s*(?:prompt\s*)?[[(]?(\d{1,3})[\])]?\s*[).:\-–—]\s*(.*)$/i;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = numbered.exec(line);
    if (m) {
      const n = Number(m[1]);
      const body = clean(m[2] ?? "");
      // Guard against a stray number inside prose restarting the list.
      if (n >= 1 && n <= expected + 5) {
        out[n - 1] = body;
        last = n - 1;
        continue;
      }
    }
    if (last >= 0) {
      // Continuation of the previous prompt (the model wrapped a long line).
      out[last] = `${out[last] ?? ""} ${clean(line)}`.trim();
    } else {
      loose.push(clean(line));
    }
  }

  const got = out.filter((v) => v && v.length > 30).length;
  if (got === 0 && loose.length > 0) {
    return loose.filter((v) => v.length > 30);
  }
  return out;
}

/** Strips leftover quoting/bullet punctuation from one recovered prompt. */
function clean(v: string): string {
  return v
    .replace(/^[\s*•\-–—]+/, "")
    .replace(/^["'`“”]+/, "")
    .replace(/["'`“”]?\s*,?\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Builds a compact, reusable character bible from the script.
 *
 * Only the OPENING portion of the script is sent: characters are introduced in
 * the first scenes, so the head alone is enough to fix their look, and it keeps
 * the request far inside the free model's context window (a multi-hour script
 * would otherwise come back as a hard 400). Budgets shrink on each retry.
 * It never throws: an empty bible only costs some consistency, while a throw
 * would kill the whole storyboard for a long script.
 */
export async function buildCharacterBible(script: string): Promise<string> {
  const system =
    "You are a character continuity editor. Read the WHOLE script (it may be " +
    "Hinglish/Hindi) and list the recurring characters. For each, give ONE compact English line of FIXED, highly " +
    "specific visual traits usable verbatim inside an image prompt: age, gender, exact hair colour + length + style, " +
    "eye colour, skin tone, face shape, one distinguishing feature (scar, mole, glasses, bandage), build/height, and " +
    "signature clothing WITH exact colours. Be concrete — these traits must let an artist redraw the same person " +
    "hundreds of times identically. 16-28 words per character. Max 10 characters. " +
    "After the characters, add up to 6 recurring LOCATIONS the same way, one line each, prefixed 'Place - ', with " +
    "fixed visual details (materials, colours, key furniture/landmarks, time of day if fixed) so the same place is " +
    "drawn identically every time it appears, e.g. 'Place - Henan's home: small brick village house, blue wooden " +
    "door, clay-tiled roof, neem tree in the yard, string cot outside'. " +
    "CRITICAL: determine each character's gender from the script (names, pronouns, relationships like brother/sister) " +
    "and make the gender the FIRST and most emphasized trait — write 'male' or 'female' explicitly plus a matching " +
    "noun (man/woman/boy/girl). Never guess wrong or leave gender ambiguous. " +
    "CRITICAL: determine each character's AGE from the script (school grade, job, parenthood, being called old/young, " +
    "family roles like grandfather/mother/child) and state it EXPLICITLY right after the gender: a number " +
    "('17 years old', '45 years old') or an exact band ('elderly, over 65', 'middle-aged, 40 to 55', 'teenager', " +
    "'young child'). Never leave age vague or write just 'young'/'old' — write the concrete age. " +
    "Output plain lines like: Henan: male, 17-year-old Indian boy, messy jet-black hair, dark brown eyes, tan skin, " +
    "thin wiry build, faded grey school shirt with frayed collar, small scar above left eyebrow. " +
    "No headings, no numbering, no extra commentary.";

  // Claude Opus 5 reads a million tokens, so the ENTIRE script goes in — no sampling,
  // no chunking. Characters introduced late are now covered like the rest.
  const body = script.length > MAX_SCRIPT_CHARS ? script.slice(0, MAX_SCRIPT_CHARS) : script;

  try {
    const out = await textChat(system, `FULL SCRIPT:\n${body}`, {
      temperature: 0.4,
      maxOutputTokens: 4_000,
    });
    const bible = stripFences(out).slice(0, 4000);
    if (bible.length > 20) return bible;
  } catch (e) {
    console.error("buildCharacterBible failed, continuing without a bible:", e);
  }
  return "";
}

const PROMPT_SYSTEM =
  "You are a storyboard writer. Describe scene CONTENT only; do not name or request any art style, medium, rendering " +
  "technique or visual genre because the image renderer applies one fixed style separately. You are given a " +
  "character bible and the COMPLETE script (Hindi/Hinglish/English), every line numbered with its timestamp. You are " +
  "then asked for a set of line numbers. For EACH requested number write ONE English image prompt that draws EXACTLY " +
  "WHAT THAT LINE LITERALLY DESCRIBES.\n" +
  "TIMESTAMP FIDELITY (absolute): the prompt for a numbered line must show ONLY that line's own moment, place and " +
  "action. Never draw a different timestamp's scene, never blend two timestamps into one image, and never repeat the " +
  "previous or next line's scene. Before writing each prompt, re-read THAT line and take its setting, people and " +
  "action from its own words.\n" +
  "EVERY prompt must contain, in this order: (1) the place/setting the line itself describes, (2) who or what is in " +
  "frame — with bible traits woven inline ONLY for characters the line itself is about; if the line involves no person, " +
  "the shot has no people at all, (3) the exact action, body pose and facial expression, (4) 4-6 concrete environmental " +
  "details, (5) the camera angle and shot size (extreme close-up / close-up / medium / wide / low angle / high angle / " +
  "over-the-shoulder), (6) the natural lighting and colour the line implies.\n" +
  "RULES:\n" +
  "- ONE LINE = ONE IMAGE (absolute): exactly one prompt per requested number, in the same order, never merged, never " +
  "split, never skipped, never a placeholder. Each prompt must be visibly DIFFERENT from its neighbours.\n" +
  "- LITERAL SUBJECT (the most important rule): draw the subject of THAT line and nothing else. If the line is " +
  "narration, exposition, history or backstory about demons, a massacre, a city, an army, a special force, a god, a " +
  "war, a crowd or a phenomenon, then the image IS that thing, shown in ITS OWN place and time — demons attacking " +
  "Busan becomes demons attacking Busan; soldiers mobilising becomes soldiers mobilising. Never fall back on the " +
  "main characters standing somewhere just because the previous line was there.\n" +
  "- FREE MOVEMENT IN PLACE AND TIME: consecutive lines may jump to a completely different location, era or set of " +
  "people, and that is expected. Take the setting from the line's own words (plus nearby lines only when the line " +
  "itself is ambiguous). There is no requirement to stay in the previous panel's location.\n" +
  "- CAST BY NAME ONLY: put a bible character in a panel only when that line is actually about them (named, or an " +
  "unmistakable pronoun continuing their own action from the line right before). Lines about soldiers, demons, " +
  "crowds, villagers, strangers or unnamed people show THOSE people — never insert a main character into them.\n" +
  "- A memory, flashback, dream or story-within-the-story is drawn as the remembered event itself, in the place and " +
  "time it happened, not as someone remembering it.\n" +
  "- LIGHTING & COLOUR: take the lighting ONLY from the line — daytime is bright natural daylight, an indoor scene is " +
  "a well-lit room, a night scene is a clearly lit night with visible detail. Never add darkness, gloom, shadowy " +
  "mystery, fog or noir the line does not state. Name the light source and the dominant colours.\n" +
  "- RICH DETAIL (critical): every prompt is dense with concrete visual detail — at least 4-6 specific drawable things " +
  "in the environment; for each person the posture, hand position, exact expression (eyes, eyebrows, mouth) and " +
  "clothing state. Foreground, midground and background must each have something drawn in them.\n" +
  "- Weave a character's fixed traits INLINE (e.g. 'Henan, a thin 17-year-old boy with messy jet-black hair, sits...'). " +
  "NEVER write a separate character description block, sheet, reference, lineup or 'plus portrait of'.\n" +
  "- CONSISTENCY: when a bible character DOES appear, repeat their bible traits (hair, eyes, clothing colours) using " +
  "the bible's own words. Never redesign, re-age or re-dress a character between shots.\n" +
  "- GENDER ACCURACY (critical): every bible character is written with their name AND their exact gender using an " +
  "explicit gendered noun. Never swap or reverse a character's gender. For side characters, pick one gender from the " +
  "script context and state it explicitly, and keep it identical everywhere in the story.\n" +
  "- AGE ACCURACY (critical): every bible character has a fixed age — copy it into every prompt they appear in " +
  "('a 45-year-old man', 'an elderly woman with deep wrinkles', 'a 7-year-old child'). A character must look the " +
  "SAME age in every panel: a child is never drawn adult, an old person is never drawn young, a teenager is never " +
  "drawn middle-aged. Add the visible age markers the bible implies (wrinkles and grey hair for the elderly, small " +
  "childlike stature and round face for a child). For unnamed side characters, state one explicit age and keep it " +
  "consistent for the whole story.\n" +
  "- TWO OR MORE PEOPLE IN FRAME (critical): name each person separately with their gender, their own EXACT age and " +
  "their own distinct traits, and say where each one stands. Never write 'two figures' or 'the two of them', and " +
  "never let one character's hair, clothing, age or body type bleed onto the other.\n" +
  "- MIXED PAIRS (critical): when two people in one frame differ in age or gender, write the CONTRAST explicitly " +
  "next to both of them — 'Ravi, a clearly MALE elderly man with deep wrinkles and white hair, beside Meena, a " +
  "clearly FEMALE 8-year-old girl, small and round-faced'. Never make a young character look the same age as the " +
  "older one beside them, never age a child up or an elder down to match the other person, and never draw a male " +
  "character feminine (or a female one masculine) just because they share the frame with the opposite gender.\n" +
  "- HEAD COUNT: state explicitly how many people are in frame and that nobody else is present.\n" +
  "- Exactly one scene, one moment, one instance of each character. Never ask for multiple panels, insets or collages.\n" +
  "- NO-CHARACTER LINES (critical): if the line describes only a place, an object, the sky, weather or a phenomenon and " +
  "involves no person, the prompt MUST be a pure environment shot with NOBODY in it. Start it with 'Empty environment " +
  "shot, no people:'. Never add a silhouette, an onlooker or a main character just to fill the frame.\n" +
  "- CROWD LINES: if the line says many people, everyone, a crowd, an army, soldiers or people running, show that " +
  "crowd or force, made of unnamed people who are not the main cast.\n" +
  "- NO TEXT: never describe text, letters, words, numbers, signs, posters, banners, newspapers, book pages, screens " +
  "with writing, labels or logos. Show the OBJECT and the reaction instead, never the writing.\n" +
  "- 55 to 80 words each — every word visual and load-bearing, no filler. English only. The image engine only reads a short prompt, so a longer one loses its ending.\n" +
  "OUTPUT FORMAT (strict about the shape, nothing else): one plain line per requested script line, each starting with " +
  "that script line's own number, then ') ', then the whole prompt on that same single line. Example:\n" +
  "37) In the sunlit courtyard, Henan, a male 17-year-old boy ...\n38) Close-up of ...\n" +
  "No JSON, no quotes, no brackets, no bullets, no headings, no blank lines, and never break one prompt across lines.";

/** Hard ceiling on how much script text is pasted into one request. */
const MAX_SCRIPT_CHARS = 2_000_000;

/**
 * How much of the script is pasted in for continuity on one prompt-writing
 * request. A full two-hour script is hundreds of thousands of characters; on a
 * long story that made every single request enormous and slow, which is why
 * long scripts finished with no prompts at all. Below this size the whole
 * script still goes in; above it, the request carries the story opening plus a
 * generous window around the lines being drawn.
 */
const CONTEXT_CHARS = 2_000_000;
/** Lines of story kept before/after the batch when the script is long. */
const CONTEXT_BEFORE = 400;
const CONTEXT_AFTER = 200;

/** Numbers the WHOLE script, 1-based, exactly as the model must answer it. */
function numberScript(all: Segment[]): string {
  const text = all.map((s, i) => `${i + 1}. [${s.start}s-${s.end}s] ${s.text}`).join("\n");
  return text.length <= MAX_SCRIPT_CHARS ? text : text.slice(0, MAX_SCRIPT_CHARS);
}

function numberRange(all: Segment[], from: number, to: number): string {
  return all
    .slice(from - 1, to)
    .map((s, i) => `${from + i}. [${s.start}s-${s.end}s] ${s.text}`)
    .join("\n");
}

/** Story context for one batch: the whole script when short, a window when long. */
function contextFor(all: Segment[], full: string, want: number[]): string {
  if (full.length <= CONTEXT_CHARS) return full;
  const first = Math.max(1, (want[0] as number) - CONTEXT_BEFORE);
  const last = Math.min(all.length, (want[want.length - 1] as number) + CONTEXT_AFTER);
  const opening = numberRange(all, 1, Math.min(30, all.length));
  const windowed = numberRange(all, first, last);
  return first > 31
    ? `STORY OPENING:\n${opening}\n\n...\n\nSTORY AROUND THESE LINES:\n${windowed}`
    : windowed;
}

/**
 * Writes image prompts for lines `from`..`to` (1-based, inclusive).
 *
 * Prompts are written in batches (the caller decides the batch size) because a
 * single answer covering an entire long script never completes: the answer, not
 * the input, is what has a ceiling. Each request carries the character bible
 * plus as much surrounding story as fits, so continuity is kept, and only
 * genuinely missing lines are asked for again.
 */
export async function writePrompts(
  bible: string,
  all: Segment[],
  from: number,
  to: number,
): Promise<string[]> {
  const count = to - from + 1;
  if (count <= 0) return [];

  const full = numberScript(all);

  const ask = async (want: number[], temp: number) => {
    const first = want[0] as number;
    const last = want[want.length - 1] as number;
    const contiguous = want.length === last - first + 1;
    const script = contextFor(all, full, want);
    const listing = want
      .map((n) => {
        const s = all[n - 1] as Segment;
        return `${n}. [${s.start}s-${s.end}s] ${s.text}`;
      })
      .join("\n");

    return textChat(
      PROMPT_SYSTEM,
      `CHARACTER BIBLE:\n${bible || "(none)"}\n\n` +
        `NUMBERED SCRIPT (read it for continuity):\n${script}\n\n` +
        `LINES TO DRAW — write ONE prompt for EACH of these ${want.length} lines and nothing else. ` +
        `Each prompt draws ONLY its own numbered line's moment, place and action, and must be ` +
        `recognisable as that line:\n${listing}\n\n` +
        `Output exactly ${want.length} lines, numbered with each line's OWN number` +
        `${contiguous ? ` (${first} to ${last})` : ` (${want.join(", ")})`}, then ') ', ` +
        `then the prompt on that same single line. Nothing else.`,
      {
        temperature: temp,
        maxOutputTokens: Math.min(240_000, 4_000 + want.length * 220),
      },
    );
  };


  const wanted = Array.from({ length: count }, (_, i) => from + i);
  const byNumber = new Map<number, string>();

  const absorb = (raw: string, want: number[]) => {
    // Answers are numbered with the GLOBAL line number, so the parser is fed
    // the highest expected number and the results re-keyed.
    const parsed = parseNumberedList(raw, all.length);
    const entries: { n: number; text: string }[] = [];
    parsed.forEach((v, idx) => {
      if (typeof v === "string" && v.trim().length > 30)
        entries.push({ n: idx + 1, text: v.trim() });
    });
    if (entries.length === 0) return;

    // Timestamp fidelity gate: accept a prompt only when it shares a content
    // word with its OWN script line (checked for English lines; Hindi lines
    // cannot be word-matched, so they are checked later, per line, by the
    // scene checker just before rendering).
    const accept = (n: number, text: string) => {
      const seg = all[n - 1];
      if (seg && isEnglishish(seg.text) && !mentionsLine(text, seg.text)) return;
      byNumber.set(n, text);
    };

    const wantSet = new Set(want);
    const matched = entries.filter((e) => wantSet.has(e.n));
    if (matched.length > 0) {
      // Numbers that belong to this request: trust them.
      for (const e of matched) accept(e.n, e.text);
      return;
    }

    // No requested number came back. The model renumbered its answer (1..N).
    // Positional mapping is only safe when the count matches EXACTLY — anything
    // else is guesswork and would put a prompt on the wrong timestamp.
    if (entries.length !== want.length) {
      console.error(
        `writePrompts: answer numbering does not match request (${entries.length} prompts for ${want.length} lines) — discarded`,
      );
      return;
    }
    entries.forEach((e, i) => accept(want[i] as number, e.text));
  };

  // ONE request for the whole range.
  try {
    absorb(await ask(wanted, 0.7), wanted);
  } catch (e) {
    console.error("writePrompts pass failed:", e instanceof Error ? e.message : e);
  }

  // Repair only what is genuinely missing (a truncated answer), in as few
  // extra requests as possible: one request for all the gaps together.
  const gap = wanted.filter((n) => !byNumber.has(n));
  if (gap.length > 0 && gap.length < wanted.length) {
    try {
      absorb(await ask(gap, 0.5), gap);
    } catch (e) {
      console.error("writePrompts repair failed:", e instanceof Error ? e.message : e);
    }
  }

  // Duplicate guard: two timestamps must never share one written prompt, or
  // one line's picture ends up standing in for another moment entirely.
  const seen = new Map<string, number>();
  for (const n of wanted) {
    const own = byNumber.get(n);
    if (!own) continue;
    const fingerprint = own.trim().toLowerCase().slice(0, 160);
    const first = seen.get(fingerprint);
    if (first !== undefined && first !== n) byNumber.delete(n);
    else seen.set(fingerprint, n);
  }

  // ONE ENTRY PER REQUESTED LINE, ALWAYS. The array is positional: the caller
  // maps built[i] onto line (from + i), so a missing prompt must stay in place
  // as an empty string. Throwing (the old behaviour) killed the prompts of the
  // whole range because of one unusable line, which is why some timestamps
  // ended up with no prompt of their own at all.
  const built: string[] = [];
  for (const n of wanted) {
    const seg = all[n - 1] as Segment;
    const own = byNumber.get(n);
    // Timestamp fidelity: a prompt that shares no content word with its OWN
    // line was written from some other part of the script. Reject it so the
    // per-line repair below replaces it instead of drawing the wrong moment.
    if (own && isEnglishish(seg.text) && !mentionsLine(own, seg.text)) {
      byNumber.delete(n);
    } else if (own) {
      built.push(sanitizePrompt(own));
      continue;
    }

    // No usable prompt for this line yet. NEVER borrow a neighbour's prompt —
    // that is exactly how a far-away timestamp's scene appeared on this panel.
    // Ask the model for a prompt built from THIS ONE line only (it also
    // handles Hindi/Hinglish, which the image engine cannot read).
    let solo = "";
    try {
      solo = (
        await textChat(
          "You turn ONE script line into ONE English image prompt for exactly that moment. " +
            "Translate the line if it is not English. Output only the prompt: one paragraph, " +
            "55-80 English words, its place, its people, its action, concrete environment details, " +
            "camera angle and natural lighting. No text, signs, speech bubbles, numbering or art-style talk.",
          `CHARACTER BIBLE:\n${bible || "(none)"}\n\nSCRIPT LINE ${n} [${seg.start}s-${seg.end}s]:\n${seg.text}`,
          { temperature: 0.4, maxOutputTokens: 700, attempts: 2 },
        )
      ).trim();
    } catch (e) {
      console.error(
        `writePrompts solo repair failed for line ${n}:`,
        e instanceof Error ? e.message : e,
      );
    }
    if (solo.length > 60) {
      built.push(sanitizePrompt(solo));
      continue;
    }
    if (isEnglishish(seg.text)) {
      built.push(sanitizePrompt(fallbackPrompt(seg)));
      continue;
    }
    // Unusable for now (a non-English line the model would not translate).
    // Empty keeps the alignment; the caller asks for this one line again.
    console.error(`writePrompts: no prompt for line ${n} — left empty for repair`);
    built.push("");
  }

  return chainContinuity(built);
}


/**
 * Panel-to-panel continuity.
 *
 * The old version appended "same place, same time of day, same characters as the
 * previous illustration" to EVERY panel. On a narrator-heavy script that forced
 * every line — demons in Busan, an army mobilising, backstory from another era —
 * to be redrawn as the previous panel's couple standing in the previous
 * panel's room. Each panel now stands on its own; the renderer applies the
 * shared art style only after these content prompts are written.
 */
export function chainContinuity(prompts: string[]): string[] {
  return prompts;
}

/** True when a string is mostly Latin-script text the image engine can read. */
export function isEnglishish(s: string): boolean {
  const letters = s.replace(/[^\p{L}]/gu, "");
  if (!letters) return false;
  const latin = letters.replace(/[^A-Za-z]/g, "").length;
  return latin / letters.length >= 0.85;
}

/**
 * True when a written image prompt shares at least one meaningful word with
 * the script line it belongs to. A prompt that shares nothing was almost
 * certainly written from a different timestamp, so the caller rejects it.
 */
export function mentionsLine(prompt: string, line: string): boolean {
  const stop = new Set([
    "this",
    "that",
    "with",
    "from",
    "then",
    "than",
    "they",
    "them",
    "their",
    "there",
    "here",
    "when",
    "what",
    "into",
    "over",
    "under",
    "about",
    "have",
    "has",
    "had",
    "were",
    "was",
    "are",
    "and",
    "the",
    "his",
    "her",
    "him",
    "she",
    "but",
    "not",
  ]);
  const words = line
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !stop.has(w));
  if (words.length === 0) return true;
  const p = prompt.toLowerCase();
  return words.some((w) => p.includes(w));
}

function fallbackPrompt(s: Segment, action?: string): string {
  const moment = action ? action : s.text;
  // The image engine cannot read Hindi/Devanagari: feeding it the raw line
  // produced pictures unrelated to the story. Only English lines are usable.
  if (!isEnglishish(moment)) {
    throw new Error(
      `No usable prompt could be written for line ${s.index + 1} — retry this panel.`,
    );
  }
  return (
    "A single detailed scene in clear natural lighting, with a fully drawn background, " +
    `depicting this exact story moment: ${moment}`
  );
}

/** Phrases that make Flux draw letterforms. Replaced with a neutral equivalent. */
const TEXT_TRIGGERS: [RegExp, string][] = [
  [
    /\b(sign(board|age)?s?|street sign|shop sign)\b\s*(that\s+)?(reads?|saying|says)?[^,.]*/gi,
    "weathered wall",
  ],
  [
    /\b(poster|posters|billboard|billboards|banner|banners|placard|flyer|leaflet|brochure)\b/gi,
    "bare wall",
  ],
  // Paper props only when they are the object itself. A trailing noun means the
  // word is an adjective for real furniture ("ticket machine", "note board"),
  // which must be left intact — rewriting it produced nonsense like
  // "a small worn paper object machine on the wall".
  [
    /\b(newspaper|newspapers|magazine|magazines|letter|letters|envelope|note|notes|notebook|diary|book page|pages of a book|document|documents|contract|receipt|ticket|label|labels|tag|tags)\b(?!\s+(machine|machines|counter|booth|stand|window|holder|dispenser|rack|box|board|shelf|kiosk|gate|barrier|office|hall|desk))/gi,
    "worn paper object",
  ],
  [
    /\b(text|texts|writing|written words?|words?\s+written|caption|captions|subtitle|subtitles|title card|handwriting|calligraphy|graffiti|inscription|slogan|logo|logos|brand name|watermark|number plate|license plate|numberplate)\b/gi,
    "",
  ],
  [/\b(that|which)\s+(reads?|says?)\b[^,.]*/gi, ""],
  [/\breading\s+(a|an|the)\s+\w+/gi, "holding an object"],
  [
    /\b(screen|display|monitor|phone screen|laptop screen)\s+(showing|displaying|with)\b[^,.]*/gi,
    "dark glowing screen",
  ],
  // Balloons/lettering furniture: naming them at all makes Flux draw them.
  [/\b(speech|thought|dialogue|word)\s*(bubble|balloon)s?\b/gi, ""],
  [
    /\b(comic|manga|manhwa|webtoon)\s+(page|panel|panels|strip|layout|gutters?)\b/gi,
    "illustration",
  ],
  [
    /\b(says?|saying|shouts?|shouting|whispers?|whispering|yells?|screams?|mutters?|exclaims?)\s*[,:]?\s*["“][^"”]{0,160}["”']/gi,
    "",
  ],
  [/"[^"]{0,120}"/g, ""],
  // Single quotes: ONLY a genuine quoted span. The old /'[^']{2,120}'/ treated
  // two possessive apostrophes as a pair and deleted everything between them —
  // "Henan's ... demon's" lost the whole middle of the description. An opening
  // quote may not follow a letter, and a closing quote may not sit between
  // letters (that is a possessive or a contraction, not a quote).
  [/(?<![A-Za-z0-9])'(?=\S)[^'\n]{2,120}(?<=\S)'(?![A-Za-z0-9])/g, ""],
  [/“[^”]{0,120}”/g, ""],
];

/**
 * Metaphor scrubber. "his lungs burned with fire" was rendered LITERALLY —
 * flames erupting from a character's chest. Figurative body/soul imagery is
 * rewritten into the visible human reaction instead.
 */
const METAPHOR_TRIGGERS: [RegExp, string][] = [
  [
    /\b(lungs?|chest|throat|veins?|blood|body|skin|heart|soul|mind|nerves?)\s+(burning|on fire|aflame|ablaze|engulfed in flames?|filled with fire|searing with fire)\b/gi,
    "face contorted in pain, hand clutching the chest",
  ],
  [
    /\b(fire|flames?|embers?|lightning|electricity|energy)\s+(erupting|bursting|pouring|radiating|spreading)\s+(from|out of|through)\s+(his|her|their|the)\s+(chest|body|lungs?|throat|skin|veins?|mouth|eyes)\b/gi,
    "body tensed, breath sharp, expression strained",
  ],
  [
    /\b(glowing|luminous|visible|exposed|raw|pulsing)\s+(organs?|flesh|muscle|lungs?|veins?|anatomy|innards?)\b/gi,
    "strained expression",
  ],
  [
    /\b(soul|spirit|consciousness|essence)\s+(torn|ripped|wrenched|extracted|pulled|dragged)\s+\w*\s*(from|out of)[^,.]*/gi,
    "whole body convulsing, eyes wide with shock",
  ],
  [
    /\b(x-?ray|anatomical cutaway|see-through body|transparent body|internal organs? view)\b/gi,
    "normal opaque body",
  ],
  [
    /\b(surreal|symbolic|abstract|metaphorical|dreamlike|otherworldly)\s+(imagery|vision|representation|overlay|effect)s?\b/gi,
    "grounded realistic depiction",
  ],
];

/**
 * Dark-tone scrubber. The storyboard has no mood filter any more, so any
 * leftover "dim / gloomy / mysterious" phrasing the text model still slips in
 * is rewritten into neutral, well-lit wording. Genuine script facts (night,
 * rain, a candle) are left alone — only the atmosphere adjectives go.
 */
const DARK_TRIGGERS: [RegExp, string][] = [
  [
    /\b(moody|gloomy|murky|ominous|foreboding|eerie|sinister|brooding|noir|mysterious|shadowy|dimly[- ]lit|dim|low[- ]key|chiaroscuro|oppressive|bleak|desaturated|muted)\s+(lighting|light|atmosphere|mood|tone|palette|colou?rs?|shadows?|room|scene|interior|street|corridor)\b/gi,
    "clear well-lit $2",
  ],
  [
    /\b(thick|deep|heavy|pitch|near|total|enveloping|swallowing)\s+(darkness|shadow|shadows|gloom|black)\b/gi,
    "soft natural light",
  ],
  [
    /\b(in|into|through|from|within|amid)\s+(the\s+)?(darkness|gloom|shadows|murk)\b/gi,
    "$1 the light",
  ],
  [/\b(hard|harsh|deep|long|heavy|dramatic)\s+shadows?\b/gi, "soft shadows"],
  [
    /\b(moody|gloomy|murky|ominous|foreboding|eerie|sinister|brooding|noir|mysterious|shadowy|dimly[- ]lit|low[- ]key|oppressive|bleak)\b,?\s*/gi,
    "",
  ],
  [/\b(dark|dim)\s+(and|,)\s+(mysterious|moody|gloomy|eerie)\b/gi, "clearly lit"],
];

/**
 * Art-style scrubber.
 *
 * The written prompt must describe CONTENT ONLY. Any medium/style/genre word
 * the writing model slips in (realistic, photo, 3D render, oil painting, and
 * even "anime"/"manga" themselves) is deleted here, so the ONLY style
 * statement that ever reaches the renderer is the fixed anime block added in
 * composeImagePrompt.
 */
const STYLE_TRIGGERS: [RegExp, string][] = [
  // "in the style of X", "X style", "rendered in X", "X art"
  [/\b(?:drawn|rendered|painted|illustrated|shot|captured)\s+(?:in|as|with)\s+[^,.]{0,60}/gi, ""],
  [/\bin\s+(?:the\s+)?style\s+of\s+[^,.]{0,60}/gi, ""],
  [/\b[\w-]+\s+(?:art\s+)?style\b/gi, ""],
  [
    /\b(photo[- ]?realistic|photorealism|photorealistic|hyper[- ]?realistic|realistic|realism|lifelike|true[- ]to[- ]life|photograph(y|ic)?|photo|dslr|bokeh|35mm|50mm|film grain|cinematic still|movie still|render(ed|ing)?|3d|cgi|unreal engine|octane|blender|pixar|disney|claymation|stop[- ]motion|low[- ]poly|voxel|pixel art|vector art|flat design|isometric)\b/gi,
    "",
  ],
  [
    /\b(anime|manga|manhwa|manhua|webtoon|comic book|cartoon|chibi|ghibli|shonen|shoujo|seinen|cel[- ]shaded|cel shading|line ?art|ink(ed)? drawing|pencil sketch|sketch(y)?|charcoal|watercolou?r|oil painting|acrylic|gouache|pastel drawing|digital painting|matte painting|concept art|illustration style|storybook illustration|woodcut|engraving|impressionist|surrealist|abstract|noir film|graphic novel)\b/gi,
    "",
  ],
  [/\b(4k|8k|hdr|ultra[- ]detailed|highly detailed render|trending on artstation|artstation)\b/gi, ""],
  // Photographic camera/lens/skin cues drag Flux back to its default photo look.
  [
    /\b(shallow depth of field|depth of field|telephoto|wide[- ]angle lens|macro lens|studio lighting|softbox|golden hour photo|candid|documentary|editorial|portrait photo|headshot|skin pores|subsurface scattering|ray[- ]?traced|volumetric lighting|lens flare|chromatic aberration|motion blur|long exposure|real[- ]life|true colour photo)\b,?\s*/gi,
    "",
  ],
];

/** Removes phrasing that makes the model draw a sheet/portrait, text, or a dark mood grade. */
export function sanitizePrompt(p: string): string {
  let out = p
    .replace(
      /\b(character (sheet|reference|design|lineup|turnaround|bible)|reference sheet|model sheet|inset portrait|split panel|multiple panels|panel grid|collage|side-by-side|two panels|comic page layout|storyboard grid)\b/gi,
      "",
    )
    .replace(
      /\b(black[- ]and[- ]white|black ?& ?white|monochrome|monochromatic|gr[ae]yscale|sepia|screentone|halftone|ink wash only)\b/gi,
      "full colour",
    );
  for (const [re, to] of TEXT_TRIGGERS) out = out.replace(re, to);
  for (const [re, to] of METAPHOR_TRIGGERS) out = out.replace(re, to);
  for (const [re, to] of DARK_TRIGGERS) out = out.replace(re, to);
  for (const [re, to] of STYLE_TRIGGERS) out = out.replace(re, to);


  return out
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .replace(/(,\s*){2,}/g, ", ")
    .replace(/^[\s,.-]+/, "")
    .trim();
}

/** Splits the text-only consistency sheet into `Name -> fixed traits` entries. */
export function parseBible(bible: string): { name: string; traits: string }[] {
  return bible
    .split("\n")
    .map((l) => l.replace(/^[\s\-*•\d.)]+/, "").trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(":");
      if (i < 1) return null;
      const name = l.slice(0, i).trim();
      const traits = l.slice(i + 1).trim();
      if (!name || name.length > 40 || !traits) return null;
      return { name, traits };
    })
    .filter((v): v is { name: string; traits: string } => v !== null)
    .slice(0, 6);
}

/** Reads an explicit gender out of a bible line's traits. */
export function genderOf(traits: string): "male" | "female" | null {
  const t = ` ${traits.toLowerCase()} `;
  const male = /\b(male|man|boy|father|dad|brother|son|uncle|husband|he|his)\b/.test(t);
  const female = /\b(female|woman|girl|mother|mom|sister|daughter|aunt|wife|she|her)\b/.test(t);
  if (male && !female) return "male";
  if (female && !male) return "female";
  // both matched: trust whichever token appears first
  const mi = t.search(/\b(male|man|boy)\b/);
  const fi = t.search(/\b(female|woman|girl)\b/);
  if (mi === -1 && fi === -1) return null;
  if (fi === -1) return "male";
  if (mi === -1) return "female";
  return mi < fi ? "male" : "female";
}

/**
 * Deterministic gender repair. The text model occasionally writes "she" for a
 * male character (or the reverse), and Flux then draws the wrong person. This
 * rewrites pronouns and gendered nouns in the prompt to match the bible, and
 * stamps an explicit gendered noun right after each character's name.
 */
export function enforceGender(prompt: string, bible?: string): string {
  if (!bible) return prompt;
  const entries = parseBible(bible).filter((e) => genderOf(e.traits));
  if (entries.length === 0) return prompt;

  const present = entries.filter((e) => new RegExp(`\\b${escapeRe(e.name)}\\b`, "i").test(prompt));
  if (present.length === 0) return prompt;

  let out = prompt;

  // Only rewrite pronouns when a single character is in frame — with two
  // characters we cannot tell which pronoun belongs to whom.
  if (present.length === 1) {
    const g = genderOf(present[0]!.traits)!;
    const map: Record<string, string> =
      g === "male"
        ? {
            she: "he",
            her: "his",
            hers: "his",
            herself: "himself",
            woman: "man",
            girl: "boy",
            lady: "man",
            "young woman": "young man",
          }
        : {
            he: "she",
            his: "her",
            him: "her",
            himself: "herself",
            man: "woman",
            boy: "girl",
            gentleman: "woman",
            "young man": "young woman",
          };
    for (const [from, to] of Object.entries(map)) {
      out = out.replace(new RegExp(`\\b${from}\\b`, "gi"), (m) =>
        m[0] === m[0]!.toUpperCase() ? to[0]!.toUpperCase() + to.slice(1) : to,
      );
    }
  }

  // Put one compact identity tag at the character's FIRST mention. Repeating
  // long identity instructions after every name made Flux focus on generic
  // portraits and ignore the timestamp's setting/action.
  for (const e of present) {
    const g = genderOf(e.traits)!;
    const noun = g === "male" ? "male" : "female";
    const age = ageOf(e.traits);
    const tag = age ? `${noun}, ${age}` : noun;
    out = out.replace(
      new RegExp(`\\b${escapeRe(e.name)}\\b(?!\\s*\\((male|female)\\b)`, "i"),
      `${e.name} (${tag})`,
    );
  }

  // A short cast ledger separates mixed pairs without drowning out the scene.
  // Concrete labels work better with Flux than paragraphs of negative rules.
  if (present.length >= 2) {
    const desc = present.map((e) => {
      const g = genderOf(e.traits)!;
      const age = ageOf(e.traits);
      return `${e.name}: ${g}${age ? `, ${age}` : ""}`;
    });
    out += `. Distinct cast: ${desc.join("; ")}.`;
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Deterministic character lock: whichever API key renders this scene, the same
 * fixed traits are appended verbatim, so characters never drift between shots.
 * The sheet is text only — it is injected as traits, never drawn as a sheet.
 */
export function characterLock(prompt: string, bible?: string): string {
  if (!bible) return "";
  const entries = parseBible(bible);
  if (entries.length === 0) return "";
  // NAMED CHARACTERS ONLY. The old pronoun fallback pulled a main character
  // into any panel containing "he"/"she" — including panels about soldiers,
  // crowds and strangers — which is exactly how narration lines turned into
  // generic "main couple standing somewhere" pictures. No name, no lock.
  const matched = entries.filter((e) => new RegExp(`\\b${escapeRe(e.name)}\\b`, "i").test(prompt));
  if (matched.length === 0) return "";

  return `Appearance lock: ${matched
    .map((e) => `${e.name}: ${e.traits.replace(/\.$/, "")}`)
    .join("; ")}.`;
}

/**
 * Reads a character's age out of their bible line. Age drift was a top
 * complaint — the same "old lady" came back young in the next panel — so
 * whatever age the bible fixed is restated as an explicit render instruction.
 */
export function ageOf(traits: string): string {
  const t = traits.toLowerCase();
  const num = /\b(\d{1,2})\s*(?:-|\s)?(?:to|–|-)?\s*(\d{1,2})?\s*(?:-|\s)?year[s]?[- ]old\b/.exec(
    t,
  );
  if (num) {
    return num[2] ? `${num[1]}-${num[2]} years old` : `exactly ${num[1]} years old`;
  }
  const bands: [RegExp, string][] = [
    [
      /\b(elderly|old|aged|ancient|grand(mother|father|ma|pa)|buzurg|budhi|budha)\b/,
      "elderly, clearly aged 65 or older, with deeply wrinkled skin, sagging features and grey or white hair",
    ],
    [
      /\b(middle[- ]aged|forties|fifties|40s|50s)\b/,
      "middle-aged, clearly 40 to 55, with faint lines on the face",
    ],
    [/\b(young adult|twenties|thirties|20s|30s)\b/, "a young adult in their twenties or thirties"],
    [/\b(teen(age[rd]?)?|adolescent|schoolboy|schoolgirl)\b/, "a teenager, clearly 13 to 18"],
    [/\b(child|kid|little (boy|girl)|toddler|infant|baby)\b/, "a young child"],
  ];
  for (const [re, label] of bands) if (re.test(t)) return label;
  return "";
}

/** True when the prompt describes at least one human in frame. */
export function hasPeople(prompt: string, bible?: string): boolean {
  const p = prompt.toLowerCase();
  if (/\bno (people|figures?|characters?|humans?)\b|\bempty environment\b|\bunpopulated\b/.test(p))
    return false;
  if (
    bible &&
    parseBible(bible).some((e) => new RegExp(`\\b${escapeRe(e.name)}\\b`, "i").test(prompt))
  )
    return true;
  return /\b(man|men|woman|women|boy|boys|girl|girls|child|children|person|people|crowd|figure|silhouette|soldier|guard|villager|student|teacher|shopkeeper|worker|stranger|face|faces|he|she|they)\b/.test(
    p,
  );
}

/**
 * Hard budget for what actually reaches the image model.
 *
 * Flux.1 Schnell reads roughly 256 tokens (~1000 characters). Everything past
 * that is silently thrown away by the encoder — the renderer never sees it.
 * The old composition opened with the long style block, then the scene, then
 * the appearance lock and five guard sentences, which ran past 2000
 * characters. On long scripts (longer prompts, a longer character bible) the
 * scene itself was pushed over the edge and got cut, so the picture was drawn
 * from a style block and some guards with barely any story in it — a panel
 * that looks nothing like its line. Short scripts stayed under the limit,
 * which is why the fault only showed up on long ones.
 *
 * So: the STORY MOMENT goes first and always fits, then a compact style and
 * the shortest possible guards, and the whole thing is kept inside the budget.
 */
const IMAGE_PROMPT_BUDGET = 1250;
const SCENE_BUDGET = 470;
const LOCK_BUDGET = 150;

/** Trims to a length without cutting mid-word. */
function clip(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(", "), cut.lastIndexOf(" "));
  return cut.slice(0, stop > max * 0.6 ? stop : max).replace(/[\s,.;-]+$/, "");
}

/**
 * Compact renderer-side art direction.
 *
 * Flux weights its opening tokens most heavily, and its untouched default look
 * is photographic — which is exactly why some panels came back looking like
 * photos even though the style clause was present later in the prompt. So the
 * anime declaration now OPENS the prompt (concrete, drawing-specific nouns the
 * model can only satisfy with 2D artwork) and is restated compactly at the end.
 */
const STYLE_LEAD =
  "2D hand-drawn Japanese anime animation frame, cel-shaded anime artwork, crisp uniform ink outlines, " +
  "flat anime colour fills, large expressive anime eyes and stylised anime faces, hand-painted anime background";

const STYLE_TAIL =
  "anime cel animation still, drawn ink lines and flat cel colour throughout, " +
  "fully finished production artwork drawn and coloured edge to edge, no unfinished patches";

export function composeImagePrompt(prompt: string, bible?: string): string {
  const fixed = enforceGender(sanitizePrompt(prompt), bible);
  const peopled = hasPeople(fixed, bible);
  // Character lock only matters when someone is actually in frame.
  const lock = peopled ? clip(characterLock(fixed, bible), LOCK_BUDGET) : "";

  // Style FIRST (Flux's default look is photographic), then the scene, which
  // is still protected by its own budget so it can never be lost.
  const parts = [
    STYLE_LEAD,
    `THIS EXACT STORY MOMENT: ${clip(fixed, SCENE_BUDGET)}`,
    lock,
    peopled
      ? "only the described people, each drawn once, whole separate bodies"
      : "empty environment, no people in frame",
    "natural clear lighting, wordless artwork with no text or signage",
    STYLE_TAIL,
    "one single 16:9 widescreen anime illustration of this one moment",
  ].filter(Boolean);

  return clip(
    parts
      .join(". ")
      .replace(/\.\s*\./g, ".")
      .replace(/\s{2,}/g, " "),
    IMAGE_PROMPT_BUDGET,
  );
}


/**
 * Blank-panel rejection.
 *
 * A blank/solid or nearly-empty Flux frame compresses to a few kilobytes and
 * its compressed bytes carry very little entropy, while a real detailed
 * 1024x576 panel never does. Anything suspiciously small, low-entropy, or not
 * an image at all is treated as blank and re-rendered on another key/seed, so
 * no empty panel can reach the encoder.
 */
const MIN_IMAGE_BYTES = 40_000;
/** Shannon entropy (bits/byte) of compressed image data; real art is > 7.5. */
const MIN_ENTROPY = 7.0;

function byteEntropy(buf: Uint8Array): number {
  const counts = new Uint32Array(256);
  const step = Math.max(1, Math.floor(buf.byteLength / 200_000));
  let n = 0;
  for (let i = 0; i < buf.byteLength; i += step) {
    counts[buf[i]!] = counts[buf[i]!]! + 1;
    n++;
  }
  let h = 0;
  for (let i = 0; i < 256; i++) {
    const c = counts[i]!;
    if (!c) continue;
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * True when the file at `url` is a COMPLETE, non-empty image.
 *
 * Half-drawn / cut-off panels were reaching the grid because only the first
 * bytes were checked: a truncated download still starts with a valid PNG or
 * JPEG header. The end-of-file marker is now checked too (PNG must end with
 * IEND, JPEG with FFD9, WebP's RIFF length must match the bytes received), so
 * an unfinished file is rejected and the panel is drawn again.
 */
async function isRealImage(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
    if (!res.ok) return false;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength < MIN_IMAGE_BYTES) return false;
    const isPng = buf[0] === 0x89 && buf[1] === 0x50;
    const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
    const isWebp = buf[8] === 0x57 && buf[9] === 0x45;
    if (!isPng && !isJpg && !isWebp) return false;
    if (!isComplete(buf, isPng, isJpg, isWebp)) return false;
    // skip the header before measuring entropy of the compressed payload
    return byteEntropy(buf.subarray(Math.min(2048, buf.byteLength >> 2))) >= MIN_ENTROPY;
  } catch {
    // Network hiccup while probing: don't throw away a probably-good panel.
    return true;
  }
}

/** Checks the image file actually reaches its end-of-file marker. */
function isComplete(buf: Uint8Array, isPng: boolean, isJpg: boolean, isWebp: boolean): boolean {
  const n = buf.byteLength;
  if (isPng) {
    // ...IEND®B`\x82
    return (
      buf[n - 8] === 0x49 && buf[n - 7] === 0x45 && buf[n - 6] === 0x4e && buf[n - 5] === 0x44
    );
  }
  if (isJpg) {
    // Trailing padding bytes are tolerated; look for FFD9 in the last few bytes.
    for (let i = n - 2; i >= Math.max(0, n - 16); i--) {
      if (buf[i] === 0xff && buf[i + 1] === 0xd9) return true;
    }
    return false;
  }
  if (isWebp) {
    const size = buf[4]! | (buf[5]! << 8) | (buf[6]! << 16) | buf[7]! * 0x1000000;
    return n >= size + 8;
  }
  return true;
}


/** Calls Flux.1 Schnell (free tier) at max quality with automatic retries. Always 16:9. */
export async function generateImage(
  prompt: string,
  seed: number,
  slot = 0,
  bible?: string,
  attempts = 6,
): Promise<string> {
  const keys = pixazoKeys();
  const body = composeImagePrompt(prompt, bible).slice(0, 2000);

  let lastErr = "";
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
    const key = pickKey(keys, slot, attempt);
    try {
      const res = await fetch(PIXAZO_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          "Ocp-Apim-Subscription-Key": key,
        },
        body: JSON.stringify({
          prompt: body,
          // Quality over speed: the maximum step count Schnell accepts, at the
          // largest 16:9 size the gateway honours (1280x720 is silently
          // rejected; 1344x768 is rendered at that exact size).
          num_steps: 8,
          // a fresh seed each attempt, so a blank frame is never re-rolled identically
          seed: seed + attempt * 977,
          width: 1344,
          height: 768,
        }),
      });
      if (res.ok) {
        const json = (await res.json()) as { output?: string };
        if (json.output) {
          if (await isRealImage(json.output)) return json.output;
          lastErr = "blank image rejected";
        } else {
          lastErr = "no output url";
        }
      } else {
        lastErr = `${res.status} ${await res.text().catch(() => "")}`.slice(0, 300);
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  throw new Error(`Image generation failed: ${lastErr}`);
}

/* ------------------------------------------------------------------ */
/* Never-give-up render ladder                                         */
/* ------------------------------------------------------------------ */

/**
 * Progressive prompt rewrites used when a panel keeps failing.
 *
 * Level 0 is the prompt as written. Higher levels strip whatever most often
 * makes a render fail (over-long text, exotic wording, quoted fragments,
 * violent/adult nouns the free tier refuses) while keeping the actual subject
 * of the line, and the last level is a short, plain description that the
 * renderer practically always accepts.
 */
export function promptVariant(prompt: string, level: number, line?: string): string {
  const base = sanitizePrompt(prompt);
  if (level <= 0) return base;

  // 1 — shorten: keep the first sentences (subject, action, setting) only.
  if (level === 1) {
    const parts = base.split(/(?<=[.!?])\s+/).filter(Boolean);
    return parts
      .slice(0, Math.max(2, Math.ceil(parts.length / 2)))
      .join(" ")
      .slice(0, 600);
  }

  // 2 — soften: replace wording the free renderer commonly refuses, and drop
  // decorative clauses in brackets.
  if (level === 2) {
    const soft: [RegExp, string][] = [
      [
        /\b(blood|bloody|bleeding|gore|gory|mutilated|dismembered|corpse|corpses|dead bodies?|severed)\b/gi,
        "aftermath",
      ],
      [
        /\b(kill(s|ing|ed)?|murder(s|ing|ed)?|slaughter(s|ing|ed)?|massacre(s|d)?|stab(s|bing|bed)?|torture(s|d)?)\b/gi,
        "attack",
      ],
      [/\b(naked|nude|nudity|topless|lingerie|seductive|sensual|erotic)\b/gi, "fully clothed"],
      [/\b(child|children|kid|kids|toddler|infant|baby)\b/gi, "young person"],
      [/\([^)]*\)/g, " "],
    ];
    let out = base;
    for (const [re, to] of soft) out = out.replace(re, to);
    return out
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 500);
  }

  // 3 — plain: one short English sentence built from the subject words.
  if (level === 3) {
    const head = base.split(/(?<=[.!?])\s+/)[0] ?? base;
    return `A detailed illustration of this exact moment: ${head}`.slice(0, 320);
  }

  // 4+ — last resort: a short neutral description. The script line itself is
  // only usable when it is English — the image engine cannot read Hindi, and
  // feeding it Devanagari drew scenes unrelated to the story.
  const src = line && isEnglishish(line) ? line : base;
  const raw = src
    .replace(/["“”'’]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 200);
  return `A detailed scene with a fully drawn background and clear natural lighting, showing: ${raw}`;
}

/**
 * Renders one panel and REFUSES to come back empty.
 *
 * Ladder: the prompt as written is tried twice (each try already walks the whole
 * image-key pool on a fresh seed). If both rounds fail, the prompt itself is
 * progressively rewritten — shortened, softened, then reduced to a plain
 * description of the script line — until an image comes back. Every timestamp
 * therefore ends up with a picture in any condition.
 */
export async function renderPanel(
  written: string,
  seed: number,
  slot = 0,
  bible?: string,
  line?: string,
  timestamp?: string,
): Promise<{
  url: string;
  prompt: string;
  level: number;
  tries: number;
  rewritten: boolean;
}> {
  const errors: string[] = [];
  let tries = 0;

  // TIMESTAMP FIDELITY GATE — rescue only.
  //
  // This used to send EVERY panel's prompt to the text model for approval, and
  // the model rewrote prompts it had judged "not this moment" while seeing only
  // one isolated line. On a long script that fired thousands of times, and each
  // rewrite replaced a correct, whole-script prompt with a scene the checker
  // invented — which is exactly how finished panels ended up showing something
  // completely different from the script. It also drained the daily text quota.
  //
  // The prompts now come from a model that has read the ENTIRE script, so a
  // prompt is trusted by default. The checker is called ONLY when a prompt
  // shares no content word at all with its own English line — a real sign it
  // was written from somewhere else.
  let prompt = written;
  let rewritten = false;
  if (line && isEnglishish(line) && !mentionsLine(written, line)) {
    const vetted = await verifyPromptForLine(written, line, bible, timestamp);
    prompt = vetted.prompt;
    rewritten = vetted.rewritten;
    if (rewritten) {
      console.warn(
        `timestamp fidelity: prompt for ${timestamp ? `[${timestamp}] ` : ""}line matched no word of its own line — regenerated for this line`,
      );
    }
  }

  // Rounds 0-1: exactly the prompt that was verified for this line.
  for (let round = 0; round < 2; round++) {
    tries++;
    try {
      const url = await generateImage(prompt, seed + round * 1861, slot + round, bible, 3);
      return { url, prompt, level: 0, tries, rewritten };
    } catch (e) {
      errors.push(`round ${round + 1}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await new Promise((r) => setTimeout(r, 600 * (round + 1)));
  }

  // Rounds 2+: modified prompts, each level simpler and safer than the last.
  // Every level is derived from the VERIFIED prompt, so a simplification can
  // never reintroduce another timestamp's scene.
  for (let level = 1; level <= 5; level++) {
    const variant = promptVariant(prompt, level, line);
    if (!variant || variant.length < 20) continue;

    tries++;
    try {
      const url = await generateImage(variant, seed + level * 5471, slot + level, bible, 3);
      return { url, prompt: variant, level, tries, rewritten };
    } catch (e) {
      errors.push(`level ${level}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await new Promise((r) => setTimeout(r, 700 * level));
  }

  throw new Error(`Image generation failed after ${tries} tries — ${errors.slice(-2).join(" | ")}`);
}

/* ------------------------------------------------------------------ */
/* Post-render review                                                  */
/* ------------------------------------------------------------------ */

const REVIEW_SYSTEM =
  "You are a storyboard continuity editor. You are given one script line and the image prompt that was rendered for it. " +
  "Judge whether the rendered panel matches the line: correct setting, correct people (right count and gender), " +
  "the action the line describes, no text/speech bubbles, no literal metaphors (no flames, glowing organs, x-ray bodies), " +
  "and no contradiction with the character sheet. " +
  'Reply with exactly "OK" when it matches. Otherwise reply with ONLY a corrected single-paragraph image prompt ' +
  "(no preamble, no quotes, no explanation) that fixes the problem while keeping the same characters, location and continuity.";

/**
 * Re-checks a rendered panel's prompt against its script line. Returns a
 * rewritten prompt when the panel does not match the line, otherwise null.
 */
export async function reviewPanel(
  line: string,
  prompt: string,
  bible?: string,
  slot = 0,
): Promise<string | null> {
  try {
    void slot;
    const out = await textChat(
      REVIEW_SYSTEM,
      (bible ? `CHARACTER SHEET:\n${bible}\n\n` : "") +
        `SCRIPT LINE:\n${line}\n\nRENDERED PROMPT:\n${prompt}`,
      { temperature: 0.3, maxOutputTokens: 800, attempts: 2 },
    );
    const text = stripFences(out).trim();
    if (!text || /^ok\b/i.test(text) || text.length < 40) return null;
    return sanitizePrompt(text.replace(/^["']|["']$/g, "").slice(0, 1200));
  } catch {
    // Review is best-effort: never fail a good panel because the check failed.
    return null;
  }
}

/**
 * Renders a panel, re-checks it against the script line and, when the check
 * finds a problem, rewrites the prompt and regenerates exactly once.
 */
export async function generateCheckedImage(
  prompt: string,
  seed: number,
  slot = 0,
  bible?: string,
  line?: string,
): Promise<{ url: string; prompt: string; revised: boolean }> {
  const url = await generateImage(prompt, seed, slot, bible);
  if (!line) return { url, prompt, revised: false };
  const fixed = await reviewPanel(line, prompt, bible, slot);
  if (!fixed) return { url, prompt, revised: false };
  try {
    const retry = await generateImage(fixed, seed + 4409, slot, bible);
    return { url: retry, prompt: fixed, revised: true };
  } catch {
    return { url, prompt, revised: false };
  }
}
