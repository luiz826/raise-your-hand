// YouTube data access without an API key: playlist pages, watch pages, and
// caption (timedtext) endpoints — the same surfaces the Chrome extension will
// use in-page later. Works from residential IPs; datacenter IPs get blocked.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

// YouTube inlines page state as `var ytInitialData = {...};` — regexes break on
// nested braces inside strings, so scan with a balanced-brace parser instead.
export function extractInlineJson(html: string, marker: string): unknown {
  const at = html.indexOf(marker);
  if (at < 0) throw new Error(`marker not found: ${marker}`);
  const start = html.indexOf("{", at);
  if (start < 0) throw new Error(`no object after marker: ${marker}`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return JSON.parse(html.slice(start, i + 1));
    }
  }
  throw new Error(`unbalanced JSON after marker: ${marker}`);
}

export interface PlaylistVideo {
  videoId: string;
  title: string;
  index: number;
}

export interface PlaylistInfo {
  playlistId: string;
  title: string;
  videos: PlaylistVideo[];
  truncated: boolean;
}

export function parsePlaylistId(input: string): string {
  const m = input.match(/[?&]list=([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{10,}$/.test(input)) return input;
  throw new Error(`could not parse a playlist id from: ${input}`);
}

export async function fetchPlaylist(playlistId: string): Promise<PlaylistInfo> {
  const html = await fetchPage(
    `https://www.youtube.com/playlist?list=${playlistId}&hl=en`,
  );
  const data = extractInlineJson(html, "ytInitialData = ") as any;
  const title: string =
    data?.metadata?.playlistMetadataRenderer?.title ?? playlistId;

  let items: any[] = [];
  const tabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs ?? [];
  for (const tab of tabs) {
    const sections =
      tab?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];
    for (const section of sections) {
      const sectionContents = section?.itemSectionRenderer?.contents;
      if (!Array.isArray(sectionContents)) continue;
      // Legacy layout wraps items in playlistVideoListRenderer; the 2025+
      // lockupViewModel layout puts them directly in the section contents.
      const legacy = sectionContents[0]?.playlistVideoListRenderer?.contents;
      const candidate = legacy ?? sectionContents;
      if (candidate.length > items.length) items = candidate;
    }
  }

  const videos: PlaylistVideo[] = [];
  let truncated = false;
  for (const item of items) {
    if (item?.continuationItemRenderer) {
      truncated = true; // >100 videos: spike only ingests the first page
      continue;
    }
    const r = item?.playlistVideoRenderer;
    if (r?.videoId) {
      const t =
        r.title?.runs?.map((x: any) => x.text).join("") ??
        r.title?.simpleText ??
        r.videoId;
      videos.push({ videoId: r.videoId, title: t, index: videos.length + 1 });
      continue;
    }
    const l = item?.lockupViewModel;
    if (l?.contentId && l?.contentType === "LOCKUP_CONTENT_TYPE_VIDEO") {
      videos.push({
        videoId: l.contentId,
        title:
          l.metadata?.lockupMetadataViewModel?.title?.content ?? l.contentId,
        index: videos.length + 1,
      });
    }
  }
  if (videos.length === 0) {
    throw new Error(
      "no videos found in playlist (private playlist, or page layout changed)",
    );
  }
  return { playlistId, title, videos, truncated };
}

export interface TranscriptSegment {
  start: number; // seconds
  text: string;
}

export interface VideoData {
  videoId: string;
  title: string;
  description: string;
  durationSeconds: number;
  captionKind: "manual" | "asr";
  captionLanguage: string;
  segments: TranscriptSegment[];
}

// Plain-HTTP caption fetching (verified 2026-07): watch-page caption URLs
// return empty 200s without a proof-of-origin token, but the InnerTube player
// endpoint with the ANDROID client still serves working caption URLs. The
// production extension will instead fetch in-page, where the browser session
// makes the normal web path work.
const UA_ANDROID =
  "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip";

async function innertubePlayer(videoId: string): Promise<any> {
  const res = await fetch(
    "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA_ANDROID },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "ANDROID",
            clientVersion: "20.10.38",
            androidSdkVersion: 30,
            hl: "en",
          },
        },
        videoId,
      }),
    },
  );
  if (!res.ok) throw new Error(`innertube player HTTP ${res.status} for ${videoId}`);
  return res.json();
}

export async function fetchVideo(videoId: string): Promise<VideoData> {
  const player = await innertubePlayer(videoId);
  const status = player?.playabilityStatus?.status;
  if (status !== "OK") {
    throw new Error(
      `video ${videoId} not playable via API (${status}: ${player?.playabilityStatus?.reason ?? "no reason"})`,
    );
  }
  const details = player?.videoDetails ?? {};
  const tracks: any[] =
    player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (tracks.length === 0) {
    throw new Error(
      `no caption tracks for ${videoId} ("${details.title ?? "?"}") — ASR fallback not implemented in the spike`,
    );
  }

  // Prefer human-made captions over auto-generated (kind === "asr"), and
  // English over other languages; lectures usually have at least ASR English.
  const score = (t: any) =>
    (t.kind === "asr" ? 0 : 2) +
    (String(t.languageCode ?? "").startsWith("en") ? 1 : 0);
  const track = [...tracks].sort((a, b) => score(b) - score(a))[0];

  // baseUrl often already carries a fmt param — replace, don't append.
  const url = new URL(track.baseUrl);
  url.searchParams.set("fmt", "json3");
  const res = await fetch(url, { headers: { "User-Agent": UA_ANDROID } });
  if (!res.ok) throw new Error(`timedtext HTTP ${res.status} for ${videoId}`);
  const body = await res.text();
  if (!body.trim()) throw new Error(`empty timedtext response for ${videoId}`);

  const segments = parseTimedText(body);
  if (segments.length === 0) throw new Error(`empty transcript for ${videoId}`);

  return {
    videoId,
    title: details.title ?? videoId,
    description: details.shortDescription ?? "",
    durationSeconds: Number(details.lengthSeconds ?? 0),
    captionKind: track.kind === "asr" ? "asr" : "manual",
    captionLanguage: String(track.languageCode ?? "unknown"),
    segments,
  };
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

// Handles both timedtext formats: json3 and srv3 XML (the server sometimes
// ignores the fmt override and answers with whatever the baseUrl encoded).
function parseTimedText(body: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  if (body.trimStart().startsWith("{")) {
    const json = JSON.parse(body);
    for (const ev of json.events ?? []) {
      const text = (ev.segs ?? [])
        .map((s: any) => s.utf8 ?? "")
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (text) {
        segments.push({ start: Math.round((ev.tStartMs ?? 0) / 1000), text });
      }
    }
  } else {
    for (const m of body.matchAll(/<p t="(\d+)"[^>]*>([\s\S]*?)<\/p>/g)) {
      const text = decodeEntities(m[2].replace(/<[^>]+>/g, " "))
        .replace(/\s+/g, " ")
        .trim();
      if (text) {
        segments.push({ start: Math.round(Number(m[1]) / 1000), text });
      }
    }
  }
  return segments;
}

export function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

export function parseTime(input: string): number {
  const parts = input.split(":").map((p) => Number(p));
  if (parts.some((n) => Number.isNaN(n) || n < 0)) {
    throw new Error(`bad time: ${input} (use ss, mm:ss or h:mm:ss)`);
  }
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

// Merge fine-grained caption cues into ~40s windows: same content, far fewer
// "[m:ss]" markers, so prompts stay token-efficient.
export function compactTranscript(
  segments: TranscriptSegment[],
  uptoSeconds?: number,
): string {
  const lines: string[] = [];
  let windowStart = -1;
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length > 0) {
      lines.push(`[${formatTime(windowStart)}] ${buffer.join(" ")}`);
    }
    buffer = [];
  };
  for (const seg of segments) {
    if (uptoSeconds !== undefined && seg.start > uptoSeconds) break;
    if (windowStart < 0 || seg.start - windowStart >= 40) {
      flush();
      windowStart = seg.start;
    }
    buffer.push(seg.text);
  }
  flush();
  return lines.join("\n");
}

export function extractUrls(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s"'<>()\][]+/g) ?? [];
  const noise =
    /(youtube\.com|youtu\.be|twitter\.com|x\.com|instagram\.com|facebook\.com|tiktok\.com|patreon\.com|discord\.(gg|com)|bit\.ly|amzn|linkedin\.com|reddit\.com)/i;
  const clean = found
    .map((u) => u.replace(/[.,;:!?]+$/, ""))
    .filter((u) => !noise.test(u));
  return [...new Set(clean)];
}

export async function fetchSiteText(
  url: string,
  maxChars = 8000,
): Promise<string> {
  const html = await fetchPage(url);
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}
