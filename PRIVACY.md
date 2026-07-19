# Privacy Policy — Raise Your Hand

_Last updated: 2026-07-19_

Raise Your Hand is a browser extension that lets you ask questions about the
YouTube university lecture you're watching. This policy explains what the
extension handles and why.

## What the extension accesses

- **The current video and playlist** — the extension reads the video ID and
  playlist ID from the YouTube page URL, the current playback position, and
  (for courses you prepare) the lecture transcripts, which it fetches from
  YouTube in your browser.
- **Your questions** — the text you type into the ask box.
- **An anonymous device ID** — a random identifier generated on first use and
  stored locally in the browser. It is not linked to your name, email, Google
  account, or any personal identifier, and it is not used to track you across
  sites.

The extension does **not** access your browsing history, other tabs, cookies,
passwords, or any site other than the YouTube watch page it runs on.

## What is sent to the backend, and why

To answer a question, the extension sends to its backend server:

- the playlist and video IDs and your current timestamp,
- your question and recent questions/answers in the same pause session,
- the anonymous device ID.

To **prepare a course** you haven't used before, the extension additionally
uploads the lecture transcripts it fetched from YouTube, so the backend can
build a course summary. Prepared course data and questions/answers are stored
on the backend to provide the service and to compute anonymous, aggregate usage
metrics (such as how often answers are rated helpful). Thumbs up/down ratings
are stored against the anonymous answer/device IDs.

The backend sends lecture context and your question to an AI model provider
(e.g. Anthropic) to generate the answer, subject to that provider's terms.

## What is not done

- No personal information (name, email, account) is collected.
- Data is not sold, and is not used for advertising.
- No cross-site tracking.

## Your choices

- Uninstalling the extension stops all collection and clears the locally stored
  device ID.
- You can request deletion of data associated with your device ID by contacting
  the operator of the backend you connect to.

## Contact

Questions about this policy: _[add a contact email before publishing]_.
