# Roadmap

- [x] Clone storyweaver-sync-aid into this project, store API keys as secrets
- [x] Remove dark/mysterious tone from prompts, style, sanitizer and video grades
- [x] Webtoon/manhwa page style, high-detail prompts, max render quality (8 steps, 1344x768)
- [x] Verify end-to-end (bible → brief → prompts → image) — 3/3 panels generated in browser test
- [x] Per-panel Retry button: rebuilds the panel's 15-line chunk, regenerates the
      brief/prompt with the preceding chunk as context, re-renders on a fresh seed,
      timestamps untouched, progress persisted
- [x] Reduce final video encoding from 1080p 30fps to 720p 24fps (browser + Colab encoder)
- [x] Gemini removed entirely; writing now runs on MiniMax M3 (free) via OpenRouter,
      5 keys rotating one at a time with automatic switch on daily quota
- [x] Prompts per pass raised 60 -> 300 (MiniMax output ceiling) to cut daily requests
- [x] Keep timestamp scene/action dominant while applying compact age and gender identity locks
- [x] Apply one fixed anime style only in the final image-generation request, never during prompt writing

- [x] Cloned minimax-m3-magic here; all 4 image keys + 5 writing keys stored as secrets
- [x] Backup writing engine removed — writing runs ONLY on MiniMax M3 (free) via OpenRouter
- [x] Timestamp fidelity: weak word-overlap gate replaced by a strict per-line scene
      check run immediately before every image request; a prompt whose setting,
      subject or action is not that line's own moment is rewritten for that exact
      line and the rewrite is what gets drawn
- [x] Writing key 1 verified working again on MiniMax M3 (free)

## Done
- [x] Confirmed the text service allows 5 requests/min PER KEY (not 60) — 7 keys = 35/min total
- [x] Prompt writing switched from strict JSON to lenient numbered lines + forgiving parser
- [x] Page fan-out capped at 6 writing lanes (one analysis + one writing call per 15 lines)
- [x] Temporary chat timing log removed
- [x] Full re-run verified: 3/3 panels rendered, same room/props kept across panels
- [x] Final video encoding reduced to 1280x720 @ 24fps (was 1920x1080 @ 30fps)

## Cloned into this project (2026-09-07)
- [x] Project cloned from moment-render-magic and running here
- [x] 4 image keys + 5 writing keys stored as secrets; all 5 writing keys verified 200 on MiniMax M3 (free)
- [ ] End-to-end pass with the sample chapter: first panels must visually match 0:05-0:35
- [ ] Verify continuation spans (no text between two marks) draw their own moment, not a distant scene

## Cloned into this project (2026-09-07, tale-tuner-studio)
- [x] Repo cloned and running here; 4 image keys stored as secrets (never in code)
- [x] Writing key 1 stored as a secret and verified 200 on MiniMax M3 (free)
- [x] Player page: an empty prompt now counts as "still missing" — kept in the
      repair loop, never sent to the picture generator, slots never shift
- [x] Final check before the video is built: export stops and names the lines if
      any timestamp has no prompt of its own
- [x] All 5 writing keys stored as secrets and each verified 200 on MiniMax M3 (free)
- [x] Long-script pass: 40 timestamps -> 40 prompts, no empty slots, no shifting, panel rendered

- [x] Free writing model fixed: MiniMax M3 free was withdrawn by OpenRouter (404 "unavailable for free"),
      which is why no prompts were written. Writing now runs on a list of currently free models
      (Nemotron 3 Super 120B first, then Nemotron Ultra and Gemma 4) with automatic switch on
      model-unavailable/overloaded, plus thinking-budget headroom so answers are never cut off.

## Cloned into this project (2026-09-08, narrative-art-weaver)
- [x] Repo cloned and running here; 4 Pixazo image keys stored as secrets (never in code)
- [x] OpenRouter removed completely (openrouter.server.ts deleted, all its models gone)
- [x] Writing now runs only on Claude Opus 5 via tabitoken.com, thinking disabled,
      key read from the OPENAI_API_KEY secret on the server only
- [ ] Blocked: tabitoken shows "0 models enabled" for this account, so the model
      id cannot be confirmed. Default is `claude-opus-5`; override with the
      TABITOKEN_MODEL secret once the account lists the model.
