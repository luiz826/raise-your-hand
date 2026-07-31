# Chrome Web Store — submission kit

Everything to paste into the developer dashboard. The package to upload is
`raise-your-hand-extension.zip` (built with `npm run pack:ext`).

---

## Store listing

**Name:** Raise Your Hand

**Summary** (short description, ≤132 chars):
> A hands-free teaching assistant for YouTube university lectures. Pause, ask out loud, and hear a short, course-aware answer.

**Category:** Education

**Language:** English (primary). Also supports Portuguese in-app.

**Detailed description:**

```
Raise Your Hand turns any YouTube university course into an interactive class.

Pause a Stanford or MIT lecture, raise your hand to your webcam (or press a shortcut),
and ask your question out loud, the way you would in the room. You hear a short, spoken
answer that knows exactly where you are in the course.

What makes it different:

• It read the whole course. It knows the syllabus and the point where you paused, and
  points you to the right lecture and timestamp, in the course's own terms.

• It won't spoil what's next. Ask about something the course covers later and it tells
  you where it's coming instead of getting ahead of the professor.

• Hands-free and spoken. Voice-first and spoken back, so you stay in the flow of the
  lecture — the closest thing to a teaching assistant sitting next to you.

How it works:
1. Raise your hand to your webcam (or press a shortcut) to pause and start listening.
2. Ask your question out loud, in English or Portuguese.
3. Hear a brief answer. Say "no" and the lecture plays on.

Free, no account needed. Your webcam is processed entirely on your device — its video
is never uploaded. You can turn the camera, spoken answers, screenshots, or anonymous
feedback off in the settings at any time.

Works on YouTube course playlists.
Privacy policy: https://raise-your-hand.cloud/privacy
```

**Single purpose** (required field):
> Raise Your Hand lets a student pause a YouTube university lecture and ask a spoken,
> course-aware question, then hear a short spoken answer — a hands-free teaching
> assistant for online courses.

**Privacy policy URL:** `https://raise-your-hand.cloud/privacy`

**Homepage URL:** `https://raise-your-hand.cloud`

---

## Permission justifications

Paste these in the "Privacy practices" tab, one per permission.

- **storage** — Saves the user's own settings (language, voice, answer style, panel
  position, etc.) and a random anonymous device ID locally in the browser.
- **offscreen** — Runs the webcam hand-detection (MediaPipe, WebAssembly) in an
  offscreen document. A content script cannot hold a live camera stream + WASM model, so
  the detection must run off-screen; only the resulting "hand raised" event is used.
- **Host permission — `*://www.youtube.com/*`** — The extension runs only on YouTube
  watch pages, to read the current video/playlist and playback position and to draw the
  assistant overlay. It also captures a single screenshot of the paused frame (optional,
  user-toggleable) for visual context.
- **Host permission — `https://api.raise-your-hand.cloud/*`** — The extension's own
  backend, which transcribes the spoken question, generates the course-aware answer, and
  produces the spoken audio.
- **Camera** (requested at runtime) — Detects a raised hand to start a question
  hands-free. Frames are analyzed **locally in the browser and never uploaded**; only the
  "hand raised" event leaves the detector. Optional — can be turned off in settings.
- **Microphone** (requested at runtime) — Records the short spoken question, which is
  sent to the backend for transcription. Optional — the user can type instead.

## Data usage disclosures (Privacy practices form)

- Collects: **Website content** — the user's question (typed text or recorded audio) and
  an optional screenshot of the paused video frame, used only to generate the answer.
- Also stores a random **anonymous device ID** (not linked to any identity) so ratings
  and aggregate usage can be counted.
- Does **not** collect: name, email, address, financial/payment info, authentication,
  health, location, browsing history, or personal communications.
- Certify: data is **not sold**, **not used for anything unrelated** to the single
  purpose, and **not used for creditworthiness/lending**.
- Camera video is processed on-device and is **not** transmitted.

---

## Screenshots (you capture — 1280×800 or 640×400, 1–5 images)

Record the extension in action on a prepared CME295 (or any) lecture. Good shots:
1. The **answer card** on the right, with a spoken, spoiler-safe answer visible.
2. The **listening ring** centered while a question is being asked (the "hand raised" moment).
3. The **follow-up** in the card (Ask another / Resume) or the ⏹ Stop button while speaking.
4. The **options page** (`chrome://extensions` → Options) showing the settings.
5. Optional: the idle **"✋ Raise your hand"** cue over a lecture.

(A small promo tile 440×280 is also requested — a simple ✋ + the name on the dark/amber
background works.)

---

## Submission checklist

1. Create a Chrome Web Store **developer account** ($5 one-time) at
   chrome.google.com/webstore/devconsole.
2. **Upload** `raise-your-hand-extension.zip`.
3. Paste the **listing** copy, **category**, **single purpose**, **privacy policy URL**.
4. Fill the **Privacy practices** tab with the **permission justifications** + **data
   disclosures** above, and tick the certifications.
5. Upload **screenshots** + the promo tile.
6. Submit for review (typically a few days).

After it's approved, send me the store URL and I'll swap the landing page's "Coming soon"
button for a real **Add to Chrome** link.
