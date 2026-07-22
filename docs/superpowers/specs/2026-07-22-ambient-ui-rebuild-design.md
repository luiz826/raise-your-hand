# Ambient UI Rebuild — Design Spec

**Date:** 2026-07-22
**Status:** Design direction approved (interactive mockup). **Spec for review — not yet implemented.**
**Scope:** Rebuild the extension's *view layer* (`extension/content.js`) around the ambient/minimal concept. Keep all underlying logic (hand-raise, STT, TTS, ask streaming, follow-up loop, language, telemetry). This is also where the O5 cleanup (the 1,100-line file) lands.

## Principle

Voice-first: the interface is a **state machine composited over the paused lecture**, not a chat panel. Nothing to read top-to-bottom, no thread, no input row by default. The screen recedes; the answer arrives like a TA leaning over. Approved look: single dark theme, one amber accent, warm serif for the spoken answer, brief and forward-pointing.

## The state machine

One overlay, one active state at a time. Each state maps to an event the logic *already* emits today.

| State | Trigger (existing) | What shows |
|---|---|---|
| **idle** | hands-free armed, nothing happening | one faint corner cue (“✋ raise your hand · ⇧A”) |
| **listening** | `onHandRaised` / mic tap → `toggleDictation` | lecture softly dims; centered breathing ring + waveform; the live transcript echoes back as it's recognized |
| **thinking** | dictation sent, before first token | ring settles to a quiet pulse (brief) |
| **answer** | `/ask` streaming deltas + TTS | lower-third: “Teaching assistant” + the answer building word-by-word (warm serif), a speaking indicator, timestamp/anchor meta |
| **followup** | `askFollowUp` | quiet “Any other questions?” + listening affordance |
| **resume** | `resumeVideo` (no / silence) | overlay fades, dim lifts, lecture plays |
| **error** | gesture/backend/mic error | one quiet status line in the lower-third, then auto-clears |

**Dim nuance:** full soft dim during **listening** (attention on your voice); during **answer**, only a lower-third gradient scrim so the slide stays visible *above* the answer and the answer stays readable over any frame (bright slides included). This replaces the mockup's uniform dim.

## Components (replace the panel)

1. **Cue** — corner pill, idle only, low opacity.
2. **Listening indicator** — centered ring (breathing) + waveform + live transcript (`said`), driven by STT interim results.
3. **Answer (lower-third)** — warm serif, streams with the deltas, spoken by TTS. Keeps **clickable timestamps** (subtle underline → seeks the player) and shows the anchor meta (“Lecture 5 · 41:36 · GRPO → Lecture 6” style). Carries a **subtle feedback** affordance (small 👍/👎 that fades in with the answer — feedback is a real product signal; keep it, keep it quiet).
4. **Follow-up line** — “Any other questions?” + mini listening dots.
5. **Error line** — quiet, same region, self-clearing.
6. **Control dock** (bottom corner, auto-hiding) — replaces the old input row. Holds: the **Raise Your Hand** start/stop toggle, a **language** chip (EN/PT/…), **tap-to-talk** mic (voice without a hand-raise), and **type-instead** which summons a single slim input line (no panel). Mostly hidden; appears on mouse-move / focus.

## Kept / replaced / removed

- **Kept unchanged (logic):** offscreen hand-raise + suspend/resume, STT record→transcribe (+ Web-Speech fallback), TTS (chunked streaming + strip), `ask()` backend streaming, `askFollowUp`/`resumeVideo`, language `LANGS` table, telemetry (device/session/heartbeats), timestamp seeking, screenshot capture (now first-question-only).
- **Replaced (view):** `openPanel`/`closePanel`, `addBubble`/thread, `setStatus`, `setToast` → a single `overlay.setState(state, data)` renderer with the components above. Panel + thread + bubbles + toast CSS deleted.
- **Removed:** the chat panel, the message thread/history view (history is still kept **in memory** for follow-up context — just not shown), the topbar. Shift+A now toggles the type-instead input, not a panel.

## Code structure (and O5)

Content scripts have no bundler, so keep **one `content.js`** but split it into two clearly-bounded halves within the IIFE:
- **`logic`** — everything that talks to the SW/servers and drives state (gesture, STT, TTS, ask, follow-up, language, telemetry). Emits state transitions.
- **`view`** — the ambient overlay: builds the shadow DOM once, exposes `setState(state, data)` and small helpers (`showTranscript`, `appendAnswer`, `showError`), owns all overlay CSS.

The logic calls `view.setState(...)` instead of touching DOM directly. This is the decoupling O5 wanted, without a build step. (A real bundler/module split is a Phase-0+ nicety, noted but not required.)

## Decisions to confirm

1. **Control dock form** — my recommendation above (auto-hiding cluster: Raise-Your-Hand toggle + language chip + tap-to-talk + type-instead). Alternative: even more minimal (just the Raise-Your-Hand toggle; everything else behind one “···”). *Which?*
2. **Feedback affordance** — keep the subtle 👍/👎 on answers (recommended, for the signal), or drop visible feedback entirely and rely on other metrics? *Confirm.*
3. **Type-instead** — a slim bottom input line summoned on demand (recommended), vs. no text entry at all in the ambient UI. *Confirm.*

## Risks

- **Readability over bright slides** — mitigated by the lower-third scrim; verify on white slides.
- **Overlay over `<video>`** — compositing/perf: use transforms/opacity only, `will-change` sparingly; no layout thrash per delta.
- **Accessibility** — the answer is spoken *and* shown; keep focus states on the dock; honor `prefers-reduced-motion` (the breathing/waveform).
- **Regression surface** — big view change over working logic. Mitigate by building the `view` module behind the *same* events and testing each state against the live loop before deleting the old panel code.

## Status

Spec for review. **No implementation yet.** Once approved (and the three decisions settled), the next step is a phased implementation plan (via `superpowers:writing-plans`) → build.
