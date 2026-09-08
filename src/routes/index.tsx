import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { analyzeScript, promptsForRange, renderImage, renderBatch } from "@/lib/manga.functions";

import { buildTimeline, fmt, scriptEndTime, type Segment } from "@/lib/script";
import { buildVideo, webCodecsSupported } from "@/lib/video";
import { isBlankImageUrl } from "@/lib/blank";
import { loadRun, saveRun } from "@/lib/progress";
import { colabHealth, normalizeColabUrl, renderOnColab } from "@/lib/colab";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Script to Manga — AI Manga Video Generator" },
      {
        name: "description",
        content:
          "Turn a long timestamped script into thousands of consistent 16:9 manga panels and export a full-length video.",
      },
      { property: "og:title", content: "Script to Manga — AI Manga Video Generator" },
      {
        property: "og:description",
        content:
          "Paste a 100k-character script, get one manga panel per timestamp and a downloadable hours-long video.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type Shot = Segment & {
  prompt?: string | undefined;
  url?: string | undefined;
  status: "waiting" | "prompting" | "drawing" | "done" | "error";
  error?: string | undefined;
};

const SAMPLE = `(0:00)Henan की कहानी असुरा का उदय. Henan नाम का एक साधारण लड़का था. (0:05)

वह Mumbai के एक पुराने building की छोटी सी किराए की कोठरी में रहता था. (0:09)

कमरा इतना छोटा था कि एक बिस्तर, एक छोटी अलमारी और एक खिड़की के अलावा कुछ जगह ही नहीं बचती थी. (0:16)`;

/* ------------------------------------------------------------------ */
/* Pipeline tuning                                                     */
/* ------------------------------------------------------------------ */

/**
 * Script lines written per prompt pass.
 *
 * The model reads the ENTIRE script on every pass and writes this many prompts
 * at a time. Claude Opus 5 answers with roughly 5x the output length of the old
 * engine, so each pass covers 5x as many lines — far fewer requests per script,
 * which is what protects the daily free-model allowance.
 */
// The model reads the WHOLE script (1M+ input) on every pass and writes this
// many prompts per request. Claude Opus 5 answers up to ~264k tokens, so a large
// batch still lands in one streamed answer — bigger batches mean far fewer
// seams, so prompts stay faithful to the script's own lines and timestamps.
const PROMPT_RANGE = 120;

/**
 * Parallel image request lanes. Each lane sends IMAGE_BATCH prompts in one
 * round trip and the server renders them concurrently, so the real number of
 * images in flight is IMAGE_CONCURRENCY * IMAGE_BATCH (measured: one Pixazo key
 * sustains 24 concurrent Flux Schnell renders with no rate limiting, so four
 * keys comfortably carry ~96). Auto-throttles if the provider pushes back.
 */
const IMAGE_CONCURRENCY = 24;
const IMAGE_BATCH = 4;
/** Panels shown in the preview grid before "show all" (a 2h script has 1000+). */
const PREVIEW_LIMIT = 60;

/* ------------------------------------------------------------------ */
/* Crash-safe progress                                                 */
/* ------------------------------------------------------------------ */

function scriptKey(script: string): string {
  let h = 0;
  for (let i = 0; i < script.length; i++) h = (Math.imul(31, h) + script.charCodeAt(i)) | 0;
  return `manga:${script.length}:${h}`;
}

type Saved = { bible: string; shots: Shot[] };

// Progress lives in IndexedDB (src/lib/progress.ts): a long script's shots +
// prompts overflow localStorage's ~5MB quota, which is what triggered the
// "exceed its storage quota" failure.
const loadSaved = (key: string) => loadRun<Shot>(key);
const saveProgress = (key: string, data: Saved) => saveRun(key, data);

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx] as T);
    }
  });
  await Promise.all(workers);
}

/**
 * One timestamp = one prompt.
 *
 * The prompt writer keeps a slot for every line and leaves a line it could not
 * write EMPTY (instead of dropping it and shifting every later prompt onto the
 * wrong timestamp). So an empty / whitespace-only prompt means "still missing":
 * it stays in the repair loop and must never be sent to the image renderer.
 */
function hasPrompt(prompt?: string | null): boolean {
  return typeof prompt === "string" && prompt.trim().length > 0;
}

/** Line numbers (1-based) that still have no prompt of their own. */
function missingPromptLines(shots: Shot[]): number[] {
  return shots.filter((s) => !hasPrompt(s.prompt)).map((s) => s.index + 1);
}



function Index() {
  const analyze = useServerFn(analyzeScript);
  const getPrompts = useServerFn(promptsForRange);

  const draw = useServerFn(renderImage);
  const drawBatch = useServerFn(renderBatch);

  const [script, setScript] = useState("");
  const [bible, setBible] = useState("");
  const [shots, setShots] = useState<Shot[]>([]);
  const [phase, setPhase] = useState<"idle" | "running" | "video" | "done" | "error">("idle");
  const [note, setNote] = useState("");
  const [videoPct, setVideoPct] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [canResume, setCanResume] = useState(false);
  const [colabUrl, setColabUrlState] = useState("");
  const setColabUrl = useCallback((url: string) => {
    setColabUrlState(url);
    try {
      localStorage.setItem("sceneweaver.colabUrl", url);
    } catch {
      /* ignore */
    }
  }, []);
  const [colabInfo, setColabInfo] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const shotsRef = useRef<Shot[]>([]);
  const cancelRef = useRef(false);
  const [retrying, setRetrying] = useState<number[]>([]);

  shotsRef.current = shots;

  // restore the Colab encoder link across refreshes
  useEffect(() => {
    try {
      const saved = localStorage.getItem("sceneweaver.colabUrl");
      if (saved) setColabUrlState(saved);
    } catch {
      /* ignore */
    }
  }, []);

  const doneCount = shots.filter((s) => s.status === "done").length;
  // Anything without a picture can be retried — not just panels that ended in
  // an explicit error state.
  const failed = useMemo(() => shots.filter((s) => !s.url), [shots]);

  const pct = shots.length ? Math.round((doneCount / shots.length) * 100) : 0;

  const stats = useMemo(() => {
    const words = script.trim() ? script.trim().split(/\s+/).length : 0;
    return { chars: script.length, words };
  }, [script]);

  // Runtime is the script's own span (first to last timestamp) — the exact
  // length the exported video is forced to match.
  const runtime = useMemo(() => scriptEndTime(script), [script]);

  // offer to resume whatever this exact script produced last time
  useEffect(() => {
    if (script.trim().length < 10) {
      setCanResume(false);
      return;
    }
    let alive = true;
    void loadSaved(scriptKey(script)).then((saved) => {
      if (alive) setCanResume(!!saved && saved.shots.length > 0 && shots.length === 0);
    });
    return () => {
      alive = false;
    };
  }, [script, shots.length]);

  const patch = useCallback((index: number, next: Partial<Shot>) => {
    setShots((prev) => prev.map((s) => (s.index === index ? { ...s, ...next } : s)));
  }, []);

  async function resume() {
    const saved = await loadSaved(scriptKey(script));
    if (!saved) return;
    setBible(saved.bible);
    setShots(saved.shots);
    setPhase("done");
    setNote(
      `Restored ${saved.shots.filter((s) => s.status === "done").length}/${saved.shots.length} panels from your last run.`,
    );
  }

  /* ---------------------------------------------------------------- */
  /* Generation                                                        */
  /* ---------------------------------------------------------------- */

  async function run(existing?: Shot[], existingBible?: string) {
    setError(null);
    setVideoUrl(null);
    setSavedTo(null);
    cancelRef.current = false;
    setPhase("running");
    const key = scriptKey(script);

    try {
      let b = existingBible ?? "";
      let list: Shot[];

      if (existing && existing.length > 0) {
        list = existing;
      } else {
        setNote("Reading script and locking character designs…");
        const res = await analyze({ data: { script } });
        b = res.bible;
        list = res.segments.map((s) => ({ ...s, status: "waiting" as const }));
      }
      setBible(b);
      setShots(list);

      const pending = list.filter((s) => s.status !== "done" || !s.url);
      const total = list.length;

      // Stage 1: prompts. The model reads the WHOLE script on every pass and
      // only writes the prompts for one range of line numbers (the answer, not
      // the input, is what has a size ceiling). Passes run one after another
      // because the text engine uses a single key at a time.
      // Stage 2 drains a shared queue as soon as prompts land, so image
      // rendering starts within seconds instead of after the last pass.
      const needPrompts = pending.filter((s) => !hasPrompt(s.prompt));
      const ranges: { from: number; to: number }[] = [];
      for (let i = 0; i < needPrompts.length; i += PROMPT_RANGE) {
        const slice = needPrompts.slice(i, i + PROMPT_RANGE);
        ranges.push({
          from: (slice[0] as Shot).index + 1,
          to: (slice[slice.length - 1] as Shot).index + 1,
        });
      }

      let promptDone = total - needPrompts.length;
      let drawn = list.filter((s) => s.status === "done").length;
      let lastTick = 0;
      const tick = (force = false) => {
        const now = Date.now();
        if (!force && now - lastTick < 300) return;
        lastTick = now;
        setNote(`Prompts ${promptDone}/${total} · panels ${drawn}/${total}`);
      };
      tick(true);

      let keyTick = 0;
      type Job = { seg: Shot; prompt: string; attempts: number };
      // Only lines that actually HAVE a prompt may enter the render queue.
      const queue: Job[] = pending
        .filter((s) => hasPrompt(s.prompt) && !s.url)
        .map((s) => ({ seg: s, prompt: (s.prompt as string).trim(), attempts: 0 }));

      /**
       * One timestamp = one image, in any condition: a failed panel is pushed
       * back onto the queue and re-drawn with a fresh seed and key instead of
       * being dropped. The cap only protects against a genuinely broken
       * provider looping forever; 10 attempts is far past any real outage.
       */
      const MAX_IMAGE_ATTEMPTS = 10;

      let promptingDone = ranges.length === 0;

      const record = (index: number, next: Partial<Shot>) => {
        list = list.map((x) => (x.index === index ? { ...x, ...next } : x));
        patch(index, next);
      };

      let saveTimer = 0;
      const persist = () => {
        const now = Date.now();
        if (now - saveTimer < 4000) return;
        saveTimer = now;
        void saveProgress(key, { bible: b, shots: list });
      };

      const allSegments = list.map((s) => ({
        index: s.index,
        start: s.start,
        end: s.end,
        text: s.text,
      }));

      const promptStage = (async () => {
        for (const range of ranges) {
          if (cancelRef.current) break;
          const targets = list.filter(
            (s) => s.index + 1 >= range.from && s.index + 1 <= range.to && !hasPrompt(s.prompt),
          );
          if (targets.length === 0) continue;
          targets.forEach((s) => record(s.index, { status: "prompting" }));
          try {
            const res = await getPrompts({
              data: {
                bible: b,
                from: range.from,
                to: range.to,
                segments: allSegments,
              },
            });
            const prompts = res.prompts as string[];
            targets.forEach((s) => {
              // Slot-aligned: prompts[i] belongs to this exact line number. An
              // empty slot stays empty (never inherits a neighbour's prompt) and
              // is picked up again by the repair sweep below.
              const slot = prompts[s.index + 1 - range.from];
              if (!hasPrompt(slot)) {
                record(s.index, { prompt: undefined, status: "error", error: "prompt missing" });
                return;
              }
              const prompt = (slot as string).trim();
              record(s.index, { prompt, status: "waiting" });
              queue.push({ seg: s as Shot, prompt, attempts: 0 });
            });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            targets.forEach((s) => record(s.index, { status: "error", error: msg }));
          }
          promptDone += targets.length;
          tick();
        }

        // Repair sweep: one timestamp = one image, in any condition. Any line
        // that still has no prompt (model skipped it, or the pass failed) is
        // asked for again in small groups until every line has one.
        for (let round = 0; round < 5; round++) {
          if (cancelRef.current) break;
          const missing = list.filter((s) => !hasPrompt(s.prompt));
          if (missing.length === 0) break;
          // One line per request: a mixed, non-contiguous group is exactly how a
          // prompt written for another timestamp landed on this panel.
          for (const s of missing) {
            if (cancelRef.current) break;
            const num = s.index + 1;
            record(s.index, { status: "prompting", error: undefined });
            try {
              const res = await getPrompts({
                data: { bible: b, from: num, to: num, segments: allSegments },
              });
              const slot = (res.prompts as string[])[0];
              if (hasPrompt(slot)) {
                const prompt = (slot as string).trim();
                record(s.index, { prompt, status: "waiting", error: undefined });
                queue.push({ seg: s as Shot, prompt, attempts: 0 });
              } else {
                record(s.index, { prompt: undefined, status: "error", error: "prompt missing" });
              }
            } catch {
              record(s.index, { prompt: undefined, status: "error", error: "prompt missing" });
            }
            tick();
          }
        }
      })().then(() => {
        promptingDone = true;
      });

      // Adaptive throttle: back off globally when the provider rate-limits.
      let cooldownUntil = 0;
      // Jobs currently in flight. A worker must NOT exit while another worker
      // is still rendering, because that worker can push a failed panel back
      // onto the queue — with everyone already gone, the automatic retry
      // silently never happened. This is what made retries look broken.
      let inFlight = 0;

      const worker = async () => {
        for (;;) {
          if (cancelRef.current) return;
          const group = queue.splice(0, IMAGE_BATCH);
          if (group.length === 0) {
            if (promptingDone && inFlight === 0) return;
            await new Promise((r) => setTimeout(r, 150));
            continue;
          }
          const wait = cooldownUntil - Date.now();
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));

          inFlight++;
          group.forEach((g) => record(g.seg.index, { status: "drawing" }));

          /**
           * A failure is never final: the job goes back on the queue with a
           * fresh seed/key so every timestamp eventually gets its image. Only
           * after MAX_IMAGE_ATTEMPTS tries is the panel marked failed.
           */
          const requeue = (g: Job, msg: string) => {
            if (/429|rate|quota/i.test(msg)) cooldownUntil = Date.now() + 5000;
            if (g.attempts + 1 < MAX_IMAGE_ATTEMPTS && !cancelRef.current) {
              queue.push({ ...g, attempts: g.attempts + 1 });
              record(g.seg.index, { status: "waiting", error: undefined });
            } else {
              record(g.seg.index, { status: "error", prompt: g.prompt, error: msg });
            }
          };
          try {
            const { results } = await drawBatch({
              data: {
                bible: b,
                jobs: group.map((g) => ({
                  index: g.seg.index,
                  prompt: g.prompt,
                  seed: 1000 + g.seg.index + g.attempts * 7919,
                  slot: keyTick++,
                  line: g.seg.text,
                  timestamp: `${g.seg.start}s-${g.seg.end}s`,
                })),
              },
            });
            await Promise.all(
              results.map(async (r) => {
                const job = group.find((g) => g.seg.index === r.index);
                if (r.url) {
                  // Pixel-level blank check in the browser: a flat/empty frame
                  // is re-rolled on a fresh seed and key so every timestamp
                  // ends up with a real image.
                  let url: string | null = r.url;
                  // the review pass may have rewritten the prompt server-side
                  const prompt = r.prompt ?? job?.prompt ?? "";
                  for (let attempt = 1; attempt <= 2; attempt++) {
                    if (!url || !(await isBlankImageUrl(url))) break;
                    url = null;
                    if (!prompt) break;
                    try {
                      const res = await draw({
                        data: {
                          prompt,
                          seed: 1000 + r.index + attempt * 7919,
                          bible: b,
                          slot: keyTick++,
                          line: job?.seg.text,
                          ...(job ? { timestamp: `${job.seg.start}s-${job.seg.end}s` } : {}),
                        },
                      });
                      url = res.url;
                    } catch {
                      url = null;
                    }
                  }
                  if (url && !(await isBlankImageUrl(url))) {
                    record(r.index, { url, prompt, status: "done", error: undefined });
                  } else if (job) {
                    requeue(job, "blank image");
                  } else {
                    record(r.index, { status: "error", error: "blank image" });
                  }
                  return;
                }
                if (job) {
                  requeue(job, r.error ?? "render failed");
                } else {
                  record(r.index, { status: "error", error: r.error ?? "render failed" });
                }
              }),
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            group.forEach((g) => requeue(g, msg));
          } finally {
            inFlight--;
          }
          // Count finished panels only — re-queued jobs must not inflate it.
          drawn = list.filter((s) => s.status === "done").length;
          tick();
          persist();

        }
      };

      await Promise.all([
        promptStage,
        ...Array.from({ length: IMAGE_CONCURRENCY }, () => worker()),
      ]);

      await saveProgress(key, { bible: b, shots: list });
      setPhase("done");
      const bad = list.filter((s) => !s.url).length;
      const noPrompt = missingPromptLines(list).length;
      setNote(
        bad || noPrompt
          ? `${list.length - bad}/${list.length} panels ready · ${bad} failed${
              noPrompt ? ` · ${noPrompt} without a prompt` : ""
            }`
          : "All panels generated · every timestamp has its own prompt.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  /**
   * Draws one panel again.
   *
   * The prompt this panel already has is REUSED — a retry used to ask the text
   * model for a brand new prompt first, and on a long script that request is
   * slow and often blocked by the daily free-model quota, so the retry died
   * before it ever reached the image renderer. Only a panel with no prompt at
   * all asks for one, and even then a failure there is reported instead of
   * killing the retry. Each attempt uses a fresh random seed and key slot, and
   * a blank frame counts as a failure.
   */
  const redrawShot = useCallback(
    async (
      shot: Shot,
      record: (i: number, next: Partial<Shot>) => void,
      slotBase: number,
    ): Promise<boolean> => {
      let prompt = hasPrompt(shot.prompt) ? (shot.prompt as string).trim() : undefined;
      if (!prompt) {
        record(shot.index, { status: "prompting", error: undefined });
        try {
          const { prompts } = await getPrompts({
            data: {
              bible,
              from: shot.index + 1,
              to: shot.index + 1,
              segments: shotsRef.current.map((s) => ({
                index: s.index,
                start: s.start,
                end: s.end,
                text: s.text,
              })),
            },
          });
          const slot = prompts[0] as string | undefined;
          prompt = hasPrompt(slot) ? (slot as string).trim() : undefined;
        } catch {
          prompt = undefined;
        }
        if (!prompt) {
          record(shot.index, { status: "error", error: "no prompt could be written" });
          return false;
        }
      }

      record(shot.index, { prompt, status: "drawing", error: undefined });
      let last = "render failed";
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await draw({
            data: {
              prompt,
              seed: 10_000 + shot.index * 31 + Math.floor(Math.random() * 900_000),
              slot: slotBase + attempt,
              bible,
              line: shot.text,
              timestamp: `${shot.start}s-${shot.end}s`,
            },
          });
          const url = res.url;
          if (url && !(await isBlankImageUrl(url))) {
            record(shot.index, {
              url,
              prompt: res.prompt ?? prompt,
              status: "done",
              error: undefined,
            });
            return true;
          }
          last = "blank image";
        } catch (e) {
          last = e instanceof Error ? e.message : String(e);
        }
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
      record(shot.index, { status: "error", prompt, error: last });
      return false;
    },
    [bible, draw, getPrompts],
  );

  async function retryFailed() {
    const key = scriptKey(script);
    setPhase("running");
    let keyTick = 0;
    let list = shotsRef.current;
    const record = (index: number, next: Partial<Shot>) => {
      list = list.map((x) => (x.index === index ? { ...x, ...next } : x));
      patch(index, next);
    };
    const targets = shotsRef.current.filter((s) => !s.url);
    let n = 0;
    let ok = 0;
    try {
      await pool(targets, IMAGE_CONCURRENCY, async (shot) => {
        const fresh = list.find((s) => s.index === shot.index) ?? shot;
        if (await redrawShot(fresh, record, (keyTick += 3))) ok++;
        n++;
        setNote(`Retrying failed panels ${n}/${targets.length} · ${ok} fixed`);
      });
      await saveProgress(key, { bible, shots: list });
      setNote(`Retry finished · ${ok}/${targets.length} panels fixed.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPhase("done");
    }
  }

  /** Re-rolls a single panel on a fresh seed, keeping its timestamp and prompt. */
  async function retryOne(index: number) {
    if (retrying.includes(index)) return;
    setRetrying((prev) => [...prev, index]);
    const key = scriptKey(script);
    let list = shotsRef.current;
    const record = (i: number, next: Partial<Shot>) => {
      list = list.map((x) => (x.index === i ? { ...x, ...next } : x));
      patch(i, next);
    };

    try {
      const target = list.find((s) => s.index === index);
      if (!target) return;
      await redrawShot(target, record, index + 1);
      await saveProgress(key, { bible, shots: list });
    } catch (e) {
      record(index, { status: "error", error: e instanceof Error ? e.message : String(e) });
      await saveProgress(key, { bible, shots: list });
    } finally {
      setRetrying((prev) => prev.filter((i) => i !== index));
    }
  }


  /* ---------------------------------------------------------------- */
  /* Video                                                             */
  /* ---------------------------------------------------------------- */

  async function checkColab() {
    setError(null);
    setColabInfo(null);
    try {
      const h = await colabHealth(colabUrl);
      setColabInfo(
        h.gpu
          ? `Connected · GPU (NVENC) encoder ready · ${h.lanes} lanes`
          : `Connected · CPU encoder (libx264) ready · ${h.lanes} parallel lanes`,
      );
    } catch (e) {
      setError(
        `Could not reach that encoder. Make sure encoder_server.py is still running and the tunnel is up. (${
          e instanceof Error ? e.message : String(e)
        })`,
      );
    }
  }

  /** Encodes on the user's connected remote encoder — nothing runs on this device. */
  async function makeVideoOnColab() {
    setError(null);
    setSavedTo(null);
    setVideoUrl(null);
    setDownloadUrl(null);

    // Every script timestamp becomes a panel. Panels whose image failed reuse a
    // neighbour's image instead of vanishing, so the runtime always matches.
    // Final coverage check: no timestamp may reach the video without its own
    // prompt. A missing prompt means that panel was never really drawn for its
    // moment, so the export stops and points at the exact lines to repair.
    const gaps = missingPromptLines(shotsRef.current);
    if (gaps.length > 0) {
      setError(
        `${gaps.length} timestamp(s) still have no prompt of their own (line${
          gaps.length > 1 ? "s" : ""
        } ${gaps.slice(0, 12).join(", ")}${gaps.length > 12 ? "…" : ""}). Press "Retry failed panels" so every moment gets its own picture before exporting.`,
      );
      return;
    }

    const timeline = buildTimeline(shotsRef.current, scriptEndTime(script));

    if (timeline.panels.length === 0) {
      setError("No finished panels to build a video from.");
      return;
    }
    if (!colabUrl.trim()) {
      setError("Paste the https link of your remote encoder first.");
      return;
    }

    setPhase("video");
    setVideoPct(0);
    try {
      if (timeline.substituted > 0)
        setNote(
          `${timeline.substituted} panel(s) had no image — covering their time with the nearest panel so the length still matches the script.`,
        );
      const res = await renderOnColab(colabUrl, timeline.panels, timeline.total, (p, n) => {
        setVideoPct(p);
        setNote(n);
      });
      setDownloadUrl(res.downloadUrl);
      setNote(`Video ready (${fmt(timeline.total)}) — download it from the encoder`);
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  async function makeVideo() {
    // The save-location dialog MUST be the very first thing that happens on the
    // click — browsers only allow it while the user gesture is still "fresh".
    // Nothing (no state updates, no timeline work) may run before it.
    const picker = (
      window as unknown as {
        showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle>;
      }
    ).showSaveFilePicker;

    let handle: FileSystemFileHandle | undefined;
    let pickerError: string | null = null;
    let cancelled = false;

    if (picker) {
      try {
        handle = await picker({
          suggestedName: "manga-video.mp4",
          types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }],
        });
      } catch (e) {
        const err = e as { name?: string; message?: string };
        if (err?.name === "AbortError") {
          cancelled = true;
        } else {
          pickerError = err?.message || String(e);
        }
      }
    }

    setError(null);
    setSavedTo(null);
    setVideoUrl(null);
    setDownloadUrl(null);

    // Final coverage check: no timestamp may reach the video without its own
    // prompt. A missing prompt means that panel was never really drawn for its
    // moment, so the export stops and points at the exact lines to repair.
    const gaps = missingPromptLines(shotsRef.current);
    if (gaps.length > 0) {
      setError(
        `${gaps.length} timestamp(s) still have no prompt of their own (line${
          gaps.length > 1 ? "s" : ""
        } ${gaps.slice(0, 12).join(", ")}${gaps.length > 12 ? "…" : ""}). Press "Retry failed panels" so every moment gets its own picture before exporting.`,
      );
      return;
    }

    const timeline = buildTimeline(shotsRef.current, scriptEndTime(script));
    const ready = timeline.panels;

    if (ready.length === 0) {
      setError("No finished panels to build a video from.");
      return;
    }
    if (!webCodecsSupported()) {
      setError(
        "This browser has no video encoder. Either open the page in the latest desktop Chrome/Edge, or encode on your remote CPU/GPU server instead.",
      );
      return;
    }

    const seconds = timeline.total;
    const long = seconds > 600; // 10 min+ must stream to disk, not to RAM

    if (!handle) {
      if (pickerError) {
        // Typically: the page is embedded in a preview frame that blocks the
        // file dialog. Tell the user the real reason instead of a vague hint.
        const inFrame = window.self !== window.top;
        setError(
          inFrame
            ? "The save dialog is blocked inside this embedded preview. Open the app in its own browser tab (or publish it) and press Export again."
            : `The browser refused to open the save dialog: ${pickerError}`,
        );
        return;
      }
      if (cancelled) {
        if (long) {
          setError(
            "A video this long must be saved to a file. Pick a save location and try again.",
          );
          return;
        }
        // Short video, user dismissed the dialog: fall through and keep it in memory.
      } else if (!picker && long) {
        setError(
          "This browser cannot stream a multi-hour video to disk. Use desktop Chrome or Edge so the file can be written directly.",
        );
        return;
      }
    }

    setPhase("video");
    setVideoPct(0);
    try {
      const res = await buildVideo(
        ready,
        (p: number, n: string) => {
          setVideoPct(p);
          setNote(n);
        },
        { fileHandle: handle, targetSeconds: timeline.total },
      );

      if (res.kind === "file") {
        setSavedTo(res.fileName);
        setNote(`Saved ${res.fileName}`);
      } else {
        setVideoUrl(URL.createObjectURL(res.blob));
      }
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    f.text().then(setScript);
  }

  const busy = phase === "running" || phase === "video";
  const visible = showAll ? shots : shots.slice(0, PREVIEW_LIMIT);

  return (
    <main className="min-h-screen bg-background px-4 py-10 text-foreground">
      <div className="mx-auto max-w-5xl">
        <header className="border-b-4 border-foreground pb-6">
          <p className="text-xs font-bold uppercase tracking-[0.4em] text-accent-foreground">
            AI Manga Studio
          </p>
          <h1 className="mt-2 font-display text-5xl font-black uppercase leading-none tracking-tight">
            Script → Manga Video
          </h1>
          <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
            Paste a timestamped script — including full-length ones of 100,000+ characters. Every{" "}
            <span className="font-semibold">(m:ss)</span> window becomes one fixed-style 16:9 manga
            panel with locked character identities, then everything is encoded into a single
            downloadable video.
          </p>
        </header>

        <section className="mt-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="font-display text-lg font-bold uppercase">Your script</label>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>
                {stats.chars.toLocaleString()} chars · {stats.words.toLocaleString()} words
              </span>
              <button
                onClick={() => setScript(SAMPLE)}
                className="rounded-none border-2 border-foreground px-3 py-1 font-semibold uppercase hover:bg-foreground hover:text-background"
              >
                Sample
              </button>
              <button
                onClick={() => fileRef.current?.click()}
                className="rounded-none border-2 border-foreground px-3 py-1 font-semibold uppercase hover:bg-foreground hover:text-background"
              >
                Upload .txt
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".txt,text/plain"
                onChange={onFile}
                className="hidden"
              />
            </div>
          </div>
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            rows={12}
            spellCheck={false}
            placeholder="(0:00)पहली लाइन... (0:05)&#10;&#10;दूसरी लाइन... (0:09)"
            className="mt-3 w-full resize-y border-2 border-foreground bg-card p-4 font-mono text-sm outline-none focus:ring-4 focus:ring-ring"
          />
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              disabled={busy || script.trim().length < 10}
              onClick={() => run()}
              className="border-4 border-foreground bg-primary px-6 py-3 font-display text-lg font-black uppercase text-primary-foreground shadow-[6px_6px_0_0_var(--color-foreground)] transition-transform hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-[3px_3px_0_0_var(--color-foreground)] disabled:opacity-40"
            >
              {busy ? "Working…" : "Generate manga"}
            </button>
            {canResume && !busy && (
              <button
                onClick={resume}
                className="border-4 border-foreground bg-secondary px-6 py-3 font-display text-lg font-black uppercase text-secondary-foreground"
              >
                Resume last run
              </button>
            )}
            {failed.length > 0 && !busy && (
              <button
                onClick={retryFailed}
                className="border-4 border-foreground bg-destructive px-6 py-3 font-display text-lg font-black uppercase text-destructive-foreground"
              >
                Retry {failed.length} failed
              </button>
            )}
            {doneCount > 0 && !busy && (
              <>
                <button
                  onClick={makeVideoOnColab}
                  className="border-4 border-foreground bg-accent px-6 py-3 font-display text-lg font-black uppercase text-accent-foreground"
                >
                  Encode on server
                </button>
                <button
                  onClick={makeVideo}
                  className="border-4 border-foreground bg-secondary px-6 py-3 font-display text-lg font-black uppercase text-secondary-foreground"
                >
                  Build in browser
                </button>
              </>
            )}

            {busy && (
              <button
                onClick={() => {
                  cancelRef.current = true;
                }}
                className="border-4 border-foreground px-6 py-3 font-display text-lg font-black uppercase"
              >
                Stop
              </button>
            )}
          </div>
        </section>

        {(shots.length > 0 || busy) && (
          <section className="mt-8 border-4 border-foreground bg-card p-5">
            <div className="flex items-center justify-between gap-4 font-mono text-xs uppercase">
              <span className="truncate">{note || "Ready"}</span>
              <span className="shrink-0">
                {doneCount}/{shots.length} panels ·{" "}
                {runtime ? `${Math.floor(runtime / 60)}m runtime` : "—"}
              </span>
            </div>
            <div className="mt-3 h-4 w-full border-2 border-foreground">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${phase === "video" ? videoPct : pct}%` }}
              />
            </div>
            {bible && (
              <details className="mt-4 text-sm">
                <summary className="cursor-pointer font-display font-bold uppercase">
                  Character consistency sheet (text only — never drawn)
                </summary>
                <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-muted-foreground">
                  {bible}
                </pre>
              </details>
            )}
          </section>
        )}

        <section className="mt-8 border-4 border-foreground bg-card p-5">
          <h2 className="font-display text-2xl font-black uppercase">
            Remote encoder (CPU or GPU)
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Encode the final video on any remote machine — a plain <strong>CPU</strong> cloud box or
            a GPU runtime. Nothing is rendered locally, so multi-hour exports never hit your
            browser's encoder or storage quota. The server auto-detects NVENC and falls back to
            libx264, saturating every core it finds.
          </p>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm">
            <li>
              On your CPU box (needs <span className="font-mono">python3</span> +{" "}
              <span className="font-mono">ffmpeg</span>){" "}
              <button
                type="button"
                onClick={async () => {
                  try {
                    const res = await fetch("/colab/encoder_server.py");
                    const blob = await res.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "encoder_server.py";
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 2000);
                  } catch {
                    window.open("/colab/encoder_server.py", "_blank");
                  }
                }}
                className="font-semibold underline"
              >
                download encoder_server.py
              </button>{" "}
              and run <span className="font-mono">python3 encoder_server.py</span> (listens on port
              8000).
            </li>
            <li>
              Expose it over https, e.g.{" "}
              <span className="font-mono">cloudflared tunnel --url http://localhost:8000</span>.
            </li>
            <li>Paste that https link below and hit Connect.</li>
            <li className="text-muted-foreground">
              On a GPU notebook instead? Use the{" "}
              <button
                type="button"
                onClick={() => window.open("/colab/scene-weaver-gpu-encoder.ipynb", "_blank")}
                className="font-semibold underline"
              >
                notebook version
              </button>
              .
            </li>
          </ol>
          <div className="mt-4 flex flex-wrap gap-2">
            <input
              value={colabUrl}
              onChange={(e) => setColabUrl(normalizeColabUrl(e.target.value))}
              placeholder="https://something.trycloudflare.com"
              className="min-w-[280px] flex-1 border-2 border-foreground bg-background p-3 font-mono text-sm outline-none focus:ring-4 focus:ring-ring"
            />
            <button
              onClick={checkColab}
              className="border-4 border-foreground bg-primary px-5 py-2 font-display font-black uppercase text-primary-foreground"
            >
              Connect
            </button>
          </div>
          {colabInfo && <p className="mt-3 font-mono text-xs uppercase">{colabInfo}</p>}
        </section>

        {error && (
          <p className="mt-4 border-2 border-destructive bg-destructive/10 p-3 text-sm">{error}</p>
        )}

        {savedTo && (
          <p className="mt-4 border-2 border-foreground bg-card p-3 text-sm">
            Video written to <span className="font-mono font-bold">{savedTo}</span>.
          </p>
        )}

        {videoUrl && (
          <section className="mt-8 border-4 border-foreground bg-card p-5">
            <h2 className="font-display text-2xl font-black uppercase">Your video</h2>
            <video src={videoUrl} controls className="mt-3 w-full border-2 border-foreground" />
            <a
              href={videoUrl}
              download="manga-video.mp4"
              className="mt-3 inline-block border-4 border-foreground bg-primary px-5 py-2 font-display font-black uppercase text-primary-foreground"
            >
              Download mp4
            </a>
          </section>
        )}

        {downloadUrl && (
          <section className="mt-8 border-4 border-foreground bg-card p-5">
            <h2 className="font-display text-2xl font-black uppercase">
              Your video (remote encoder)
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Encoded on your remote server. Download it while the server and tunnel are still
              running — the link dies with the session.
            </p>
            <video src={downloadUrl} controls className="mt-3 w-full border-2 border-foreground" />
            <a
              href={downloadUrl}
              download="manga-video.mp4"
              className="mt-3 inline-block border-4 border-foreground bg-primary px-5 py-2 font-display font-black uppercase text-primary-foreground"
            >
              Download mp4
            </a>
          </section>
        )}

        {shots.length > 0 && (
          <>
            <section className="mt-8 grid gap-5 sm:grid-cols-2">
              {visible.map((s) => (
                <article key={s.index} className="border-4 border-foreground bg-card">
                  <div className="flex items-center justify-between border-b-2 border-foreground px-3 py-2 font-mono text-xs uppercase">
                    <span>
                      #{s.index + 1} · {fmt(s.start)} → {fmt(s.end)}
                    </span>
                    <span className="flex items-center gap-2">
                      <span
                        className={
                          s.status === "error" ? "text-destructive" : "text-muted-foreground"
                        }
                      >
                        {retrying.includes(s.index) ? "retrying" : s.status}
                      </span>
                      <button
                        type="button"
                        onClick={() => void retryOne(s.index)}
                        disabled={retrying.includes(s.index)}
                        className="border-2 border-foreground px-2 py-0.5 font-semibold uppercase hover:bg-foreground hover:text-background disabled:opacity-40"
                      >
                        Retry
                      </button>
                    </span>
                  </div>
                  <div className="aspect-video w-full bg-muted">
                    {s.url ? (
                      <img
                        src={s.url}
                        alt={`Manga panel ${s.index + 1}`}

                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center font-mono text-xs text-muted-foreground">
                        {s.status === "error" ? "failed" : "…"}
                      </div>
                    )}
                  </div>
                  <p className="border-t-2 border-foreground p-3 text-xs text-muted-foreground">
                    {s.text}
                  </p>
                </article>
              ))}
            </section>
            {shots.length > PREVIEW_LIMIT && (
              <button
                onClick={() => setShowAll((v) => !v)}
                className="mt-6 border-2 border-foreground px-4 py-2 font-display text-sm font-bold uppercase"
              >
                {showAll
                  ? "Show first 60 panels"
                  : `Show all ${shots.length.toLocaleString()} panels`}
              </button>
            )}
          </>
        )}
      </div>
    </main>
  );
}
