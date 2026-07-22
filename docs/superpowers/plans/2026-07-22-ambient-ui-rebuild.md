# Ambient UI Rebuild — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the extension's chat-panel UI with the approved ambient/minimal overlay — a state machine composited over the paused lecture — without changing any of the working voice/gesture/ask logic.

**Architecture:** Introduce a self-contained `View` object inside `extension/content.js` that owns the shadow-DOM overlay and exposes a small state API (`setState`, `setTranscript`, `appendAnswer`, `finishAnswer`, `showError`, control callbacks). The existing logic keeps its functions but calls `View.*` at each transition instead of touching the DOM. Visual markup/CSS is ported from the approved mockup. Old panel/thread/toast code is deleted only after the new view is verified live.

**Tech stack:** Chrome MV3 content script (no bundler), Shadow DOM, vanilla JS/CSS. Web Speech + MediaRecorder (STT), Kokoro (TTS), offscreen MediaPipe (gesture) — all unchanged.

**Verification model (no unit-test framework here):** each view task is verified against an **overlay harness** — a standalone `docs/ui-harness.html` that instantiates `View` and drives states via buttons — and wiring tasks are verified in the **live reloaded extension** on an ingested course (CME295 `Ub3GoFaUcds`). "Verify" steps below say exactly what to drive and observe.

## Global Constraints

- **Single dark theme, deliberate** — the overlay lives over a playing lecture; do not add a light theme.
- **One accent:** amber `#e6a94d` (lamplight / raised hand). Warm chalk text `#f1ece2`. Warm serif for the spoken answer, humanist sans for labels. (Values from the approved mockup.)
- **Answers carry no markdown/emojis** — already enforced server-side (persona) + client strip in `speak()`; keep the strip.
- **Keep ALL logic:** offscreen hand-raise + suspend/resume, STT record→transcribe (+ Web-Speech fallback), TTS (chunked streaming + strip), `ask()` streaming, `askFollowUp`/`resumeVideo`, `LANGS` language handling, telemetry (device/session/heartbeats/feedback), timestamp→seek, first-question-only screenshot.
- **No bundler:** one `content.js`, internally split into a `View` object and the logic. No manifest change.
- **Defaults locked:** control-dock cluster (Raise-Your-Hand toggle + language chip + tap-to-talk + type-instead); keep subtle 👍/👎 on answers; keep the slim summoned type-instead input.

---

### Task 1: Overlay harness (isolated test bed)

**Files:**
- Create: `docs/ui-harness.html`

**Interfaces:**
- Produces: a page that includes the same overlay markup/CSS the `View` will build and exposes buttons to call each state, so Tasks 2–4 are verifiable without YouTube. (Once `View` exists it can import the same CSS/markup; until then the harness carries a copy derived from the approved mockup.)

- [ ] **Step 1: Build the harness** from the approved mockup (`scratchpad/ambient-mockup.html`) — the `.stage` scene + overlay states — plus a control strip with buttons: `idle`, `listening`, `setTranscript("…")`, `appendAnswer` (streams a sample answer), `finishAnswer` (timestamps + feedback), `followup`, `showError`. Over a fake bright slide *and* a dark slide (toggle) to check readability.
- [ ] **Step 2: Verify** — open `docs/ui-harness.html`, click every button, confirm each state renders and the answer is readable over both the bright and dark slide.
- [ ] **Step 3: Commit** — `git add docs/ui-harness.html && git commit -m "test: add ambient overlay harness"`

---

### Task 2: `View` module — scaffold + core states

**Files:**
- Modify: `extension/content.js` (add a `View` object near the top of the IIFE; do not remove old UI yet)

**Interfaces:**
- Produces:
  - `View.mount(root)` — builds the shadow-DOM overlay once (cue, scrim, listening block, answer block, followup block, error line, control-dock placeholder). Idempotent.
  - `View.setState(state)` — `state ∈ {"idle","listening","thinking","answer","followup","error"}`; toggles `data-state` on the stage, applies the dim nuance (full soft-dim on `listening`; lower-third scrim on `answer`).
  - `View.setTranscript(text)` — sets the live "said" text in the listening block.
- Consumes: nothing (self-contained).

- [ ] **Step 1: Add the `View` object** with `mount(root)` creating the overlay DOM + injecting the overlay CSS (ported from the mockup; amber accent, serif answer, breathing ring, waveform). Include the dim-nuance rules (`[data-state="listening"]` full dim; `[data-state="answer"]` lower-third scrim only).
- [ ] **Step 2: Implement `setState` + `setTranscript`.**
- [ ] **Step 3: Point the harness at the real `View`** (load the `View` code, replace the harness's copied markup with `View.mount` + button calls to `View.setState`/`setTranscript`).
- [ ] **Step 4: Verify** in the harness: `idle → listening → thinking → answer → followup` transitions render; `setTranscript` updates the echoed text; dim nuance correct (slide visible above the answer).
- [ ] **Step 5: Commit** — `git commit -am "feat(ui): ambient View scaffold + core states"`

---

### Task 3: `View` — streaming answer, timestamps, feedback

**Files:**
- Modify: `extension/content.js` (`View`)

**Interfaces:**
- Produces:
  - `View.appendAnswer(delta)` — appends streamed text into the answer block (first call also `setState("answer")`).
  - `View.finishAnswer({ answerId, meta })` — linkifies `M:SS`/`H:MM:SS` in the answer to clickable seek controls, renders the `meta` line, and reveals the subtle 👍/👎.
  - `View.onSeek(fn)` / `View.onFeedback(fn)` — register callbacks `fn(seconds)` and `fn(rating, answerId)`.
- Consumes: `setState` (Task 2).

- [ ] **Step 1: Implement `appendAnswer`** (efficient text append — no full re-render per delta).
- [ ] **Step 2: Implement `finishAnswer`** — port the existing `renderWithTimestamps` regex to produce subtle underlined seek links calling the registered `onSeek`; render `meta`; fade in 👍/👎 wired to `onFeedback` (one vote, then disabled).
- [ ] **Step 3: Verify** in the harness: stream a multi-sentence sample with a `41:36` timestamp; confirm words build up, the timestamp is clickable (logs the seek), feedback registers once.
- [ ] **Step 4: Commit** — `git commit -am "feat(ui): streaming answer + timestamp seek + feedback"`

---

### Task 4: `View` — control dock + type-instead

**Files:**
- Modify: `extension/content.js` (`View`)

**Interfaces:**
- Produces:
  - `View.dock({ onToggleHandRaise, onTapToTalk, onLang, onType })` — builds the auto-hiding bottom-corner dock: Raise-Your-Hand toggle, language chip (populated from `LANGS`), tap-to-talk mic, and "type" which reveals a slim single-line input that calls `onType(text)` on Enter.
  - `View.setHandRaise(on)` — reflect toggle state; `View.setLang(code)` — reflect selected language; `View.setListeningUI(on)` — mic live/⏹ affordance.
  - `View.showError(message)` — quiet lower-third line, auto-clears after ~5s.
- Consumes: `setState`.

- [ ] **Step 1: Implement `dock` + the slim type-instead input** (hidden until summoned; Shift+A also summons it).
- [ ] **Step 2: Implement `setHandRaise`, `setLang`, `setListeningUI`, `showError`.**
- [ ] **Step 3: Verify** in the harness: dock auto-hides/appears on mouse-move; language chip lists the 5 languages; "type" reveals the input and Enter fires `onType`; `showError` shows + clears.
- [ ] **Step 4: Commit** — `git commit -am "feat(ui): control dock + type-instead + error line"`

---

### Task 5: Wire the logic to `View` (the swap)

**Files:**
- Modify: `extension/content.js` (logic half — replace DOM calls with `View.*`; keep behavior identical)

**Interfaces:**
- Consumes: all of `View` (Tasks 2–4).
- Produces: nothing new — this rewires existing functions.

Mapping (replace, do not change behavior):
- `init` → `View.mount` + `View.dock({...})` + register `View.onSeek(seekTo)` / `View.onFeedback(sendFeedback)`.
- `onHandRaised` → `View.setState("listening")` (keep pause + suspendDetection + toggleDictation).
- STT interim (`onresult` / live transcript) → `View.setTranscript(text)`.
- dictation send / before first token → `View.setState("thinking")`.
- `ask()` `delta` → `View.appendAnswer(text)`; `done` → `View.finishAnswer({answerId, meta})`; `error` → `View.showError(...)`.
- `askFollowUp` → `View.setState("followup")` (keep the spoken prompt + re-listen).
- `resumeVideo` → `View.setState("idle")` + play (drop `closePanel`).
- gesture ready/error, backend errors, mic errors → `View.showError(...)`.
- `toggleHandRaise`/`stopHandRaise` → `View.setHandRaise(on)`; language change → `View.setLang(code)`; `setListeningUI` → `View.setListeningUI(on)`.

- [ ] **Step 1: Rewire** each call site above; leave the old panel/thread/toast functions defined but unused for now (so a mistake is recoverable).
- [ ] **Step 2: Verify LIVE** — reload extension + YouTube page (CME295 `Ub3GoFaUcds`), start the backend + `./run-voice.sh`. Run the full loop: Raise Your Hand → speak a question → watch listening → streamed spoken answer in the lower-third → "Any other questions?" → say "no" → video resumes. Then: click a timestamp (seeks), thumbs (records), switch language to PT and ask in Portuguese, use tap-to-talk and type-instead.
- [ ] **Step 3: Commit** — `git commit -am "feat(ui): drive ambient View from the voice loop"`

---

### Task 6: Delete the old UI + polish

**Files:**
- Modify: `extension/content.js` (remove dead panel/thread/toast/status code + their CSS)

- [ ] **Step 1: Remove** `openPanel`/`closePanel`, `addBubble`/`scrollThread`, `setStatus`, `setToast`, the old `buildUI` panel/topbar/inputrow markup, and all `.ryh-panel`/`.ryh-thread`/`.ryh-msg`/`.ryh-toast`/etc. CSS now unused. Keep `renderWithTimestamps`/`parseTime` if reused by `View`.
- [ ] **Step 2: Polish pass** — `prefers-reduced-motion` disables breathing/waveform; visible focus on all dock controls; confirm readability over a bright slide (lower-third scrim); confirm the "🖐 Ask" pill and panel are truly gone.
- [ ] **Step 3: Verify LIVE** — repeat the Task 5 full-loop test; confirm no console errors and no dead UI. `node --check extension/content.js`.
- [ ] **Step 4: Commit** — `git commit -am "refactor(ui): remove old panel; ambient UI is the only view"`

---

## Self-Review

- **Spec coverage:** state machine (T2), dim nuance (T2), streaming answer + timestamps + feedback (T3), control dock + type-instead + errors (T4), keep-all-logic wiring (T5), remove panel + a11y/readability (T6), logic/view split (T2 introduces `View`; T6 removes old view) — all spec sections covered.
- **Placeholder scan:** none — each task names exact files, the exact `View` interface, and concrete verify actions. (Visual CSS intentionally references the approved mockup rather than re-pasting ~200 lines.)
- **Type consistency:** the `View.*` names in T5's mapping match those defined in T2–T4 (`setState`, `setTranscript`, `appendAnswer`, `finishAnswer`, `showError`, `dock`, `onSeek`, `onFeedback`, `setHandRaise`, `setLang`, `setListeningUI`).
