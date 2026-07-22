# Raise Your Hand — Positioning & Launch Strategy

**Date:** 2026-07-22
**Status:** Framing approved via brainstorm. **Not yet planned or implemented.**
**Scope:** Product positioning + ruthless prioritization + hosted-launch direction. This is a strategy spec, not a code design; the Phase 0 implementation plan is a separate, later step.

## Mission

Elite university courses (Stanford, MIT, …) are already free on YouTube. What's missing is the *classroom* — a teaching assistant who knows the course and answers when you raise your hand. Raise Your Hand is a **free community project** whose goal is to give any self-learner in the world a close-to-in-person experience while watching those lectures.

## Positioning

> **Gemini answers the video. Raise Your Hand teaches the course.**

Raise Your Hand is the hands-free TA for people teaching themselves a whole course on YouTube. You raise your hand and ask out loud; it answers like a TA who knows the entire syllabus and *where you are in it* — brief, spoiler-free, and pointing you forward. Not a chatbot that explains the current video; a course companion that paces *with* you.

Landing-page line: *Elite courses are already free on YouTube. What's missing is the classroom. Raise Your Hand gives every self-learner that classroom, for free.*

### Why we don't lose to Gemini
YouTube's built-in Gemini wins on distribution and single-video Q&A; we do **not** fight there. We win on what Gemini structurally can't/won't do for a serious course-learner (confirmed against a real Gemini transcript on a CME295 lecture):
- It has no idea a course exists or where the learner is — it cites only the current video's timestamps, never "you'll see this in lecture X."
- It teaches *ahead* — full mini-lectures with bullet lists, spoiling material not yet reached.
- It's a text box, not a raised hand.

## Target user (beachhead → expand)

- **Beachhead:** self-learners working through an entire course playlist end-to-end. This is where course-awareness makes us unambiguously better than Gemini.
- **Expansion (later):** widen toward single educational videos once the experience and course library are proven.

## Launch wedge

**Voice-first, fully hosted.** The raise-your-hand → speak → hear-the-answer loop *is* the product, and nothing runs on the user's machine: one-click install, hosted backend, hosted voice.

## Double down (the three pillars)

1. **Course-awareness + spoiler-safe pacing** — knows the whole syllabus and where the learner is; answers briefly and points forward ("you'll see GRPO in the reasoning lecture") without spoiling. The intellectual moat.
2. **Raise-your-hand + voice** — the hands-free classroom hook; the demo that makes people say "whoa." The emotional differentiator.
3. **Restraint** — brief, TA-style answers; the opposite of Gemini's mini-lectures, and what a mid-course learner actually needs.

## Cut / defer (ruthless — none of this serves the beachhead)

- **Local 3-server setup → replaced by hosted.** Users never run a server. This is priority #1.
- **Text chat → demoted** to a quiet fallback, not a selling point (we are voice-first).
- **Diagram / whiteboard generation → deferred.** A different mode (visual + detailed) that fights the brief-spoken core; a strong post-beachhead "deep mode," not a launch feature.
- **Broad any-video support → deferred.** The beachhead is full courses; don't dilute.
- **Model-quality / multi-provider eval / cheap-model cost tuning → frozen.** Kimi K3 at 36/38 is good enough to launch; optimize with real usage later. Further eval spend now is procrastination.
- **📷 visual questions → kept silent.** Auto-on and cheap already; fine to keep, but not a headline.

## Hosted architecture (replaces the local servers)

| Today (friction) | Launch (hosted) |
|---|---|
| `npm run server` (Q&A) | One small hosted backend (stateless + cached) |
| `run-voice.sh` (Kokoro TTS + Whisper STT) | **Self-hosted** Kokoro/Whisper on one modest box — *not* pay-per-call cloud APIs (ElevenLabs/Deepgram don't scale for free) |
| Load unpacked extension | One-click **Chrome Web Store** install |
| Maintainer ingests each course | Shared, reusable course-map library (implementation detail) |

**Cost weapon:** the open voice models already validated (Whisper `medium`, Kokoro) are good enough; self-hosting them keeps voice ~free-at-scale in a way a per-API-call startup cannot match. The "amateur" local stack is secretly the right architecture for a free community project.

## Sustainability (free community project, no paywall)

Free + worldwide + voice-first has one real bill: **LLM tokens** (the ~32k course-context prefix per question) and voice compute. Levers instead of revenue:
1. **Cheap model on the free tier** — Kimi K3 validated (36/38, and Moonshot auto-caches).
2. **Bring-your-own-key** — power users paste their own LLM key; their usage costs the project nothing.
3. **Donations / sponsors / grants** — standard for education-access projects; funds the one voice box + backend.
4. **Aggressive prefix caching** — the course context is identical across a course's learners.

A shared course-map library (ingest a course once, reuse for everyone) removes per-user ingest cost. Treated as an implementation detail, not a headline pillar.

## Roadmap

- **Phase 0 — Make it real (hosted):** deploy backend + one voice box; publish the extension; pre-ingest ~5–10 flagship courses (CME295, 3b1b, a couple of MIT). **Success = a stranger installs it and it just works, voice included.**
- **Phase 1 — Open + community library:** open-source the project; let anyone contribute a course ingestion; add bring-your-own-key.
- **Phase 2 — Delight + widen:** the "deep mode" (diagrams/whiteboard), then cautiously expand toward single videos.

## Open questions / risks

- **Where does the hosted voice box live, and who funds it?** (sponsor/grant/donation — needs a concrete answer before scaling past a demo.)
- **Free-tier model + rate limits** to bound LLM cost.
- **Chrome Web Store review** — justify camera/mic permissions clearly.
- **Course-map quality at scale** as community ingestions grow (validation/moderation).
- **Legal / ToS** — YouTube ToS and course-content usage; review before a wide launch.

## Status

Strategy framing approved. **No implementation and no implementation plan yet**, by explicit request. When the maintainer is ready, the next step is a Phase 0 implementation plan (via the writing-plans skill).
