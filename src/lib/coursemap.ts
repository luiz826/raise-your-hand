// Course-map building: one structured-output call per lecture (concepts with
// timestamps), then one overview call across all lectures. The concept index
// is what lets the Q&A agent say "you'll see that in lecture 7". Runs through the
// provider abstraction so ingestion can use any model.

import {
  compactTranscript,
  extractUrls,
  fetchSiteText,
  type PlaylistInfo,
  type VideoData,
} from "./youtube";
import type { PromptSegment } from "./provider-types";
import type { ResolvedModel } from "./provider";

export { addUsage, emptyUsage } from "./provider-types";
export type { Usage as UsageTotals } from "./provider-types";
import { addUsage, type Usage } from "./provider-types";

export interface LectureConcept {
  name: string;
  first_introduced_at_seconds: number;
  description: string;
}

export interface LectureMap {
  index: number;
  videoId: string;
  title: string;
  durationSeconds: number;
  summary: string;
  concepts: LectureConcept[];
}

export interface CourseMap {
  playlistId: string;
  courseTitle: string;
  model: string;
  createdAt: string;
  overview: string;
  courseSiteUrl: string | null;
  courseSiteExcerpt: string | null;
  lectures: LectureMap[];
}

const LECTURE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "concepts"],
  properties: {
    summary: {
      type: "string",
      description: "3-5 sentences on what this lecture teaches, in order.",
    },
    concepts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "first_introduced_at_seconds", "description"],
        properties: {
          name: {
            type: "string",
            description:
              "Concise canonical name, using the professor's terminology.",
          },
          first_introduced_at_seconds: {
            type: "integer",
            description:
              "Seconds into the video where the professor starts teaching it.",
          },
          description: {
            type: "string",
            description: "One line on what is said about it.",
          },
        },
      },
    },
  },
} as Record<string, unknown>;

const MAP_INSTRUCTIONS = `You build a machine-readable syllabus ("course map") for a university course from lecture transcripts. For the lecture transcript you receive, extract:
- summary: 3-5 sentences on what the lecture teaches, in order.
- concepts: the substantive ideas, techniques, definitions, and results the professor actually teaches (typically 5-25). For each, give the timestamp (in seconds, from the [m:ss] markers) where it is FIRST INTRODUCED — where teaching begins, not a passing mention of something coming later.

Auto-generated captions can garble technical terms (e.g. "ell two norm" for "L2 norm"); write the corrected canonical term. The course context below lists every lecture title — keep concept naming consistent with it.`;

function courseHeader(playlist: PlaylistInfo): string {
  const list = playlist.videos
    .map((v) => `${v.index}. ${v.title}`)
    .join("\n");
  return `COURSE: ${playlist.title}\nLECTURES:\n${list}`;
}

export async function buildLectureMap(
  model: ResolvedModel,
  playlist: PlaylistInfo,
  video: VideoData,
  index: number,
  totals: Usage,
): Promise<LectureMap> {
  const segments: PromptSegment[] = [
    // Shared prefix across all per-lecture calls for this course → cacheable.
    { role: "system", text: `${MAP_INSTRUCTIONS}\n\n${courseHeader(playlist)}`, cacheable: true },
    {
      role: "user",
      text: `Lecture ${index}: ${video.title}\n\nTRANSCRIPT:\n${compactTranscript(video.segments)}`,
    },
  ];
  const { text, usage } = await model.provider.completeStructured({
    model: model.model,
    segments,
    maxTokens: 8192,
    reasoning: "thorough",
    schemaName: "lecture_map",
    schema: LECTURE_SCHEMA,
  });
  addUsage(totals, usage);

  const parsed = JSON.parse(text) as {
    summary: string;
    concepts: LectureConcept[];
  };
  return {
    index,
    videoId: video.videoId,
    title: video.title,
    durationSeconds: video.durationSeconds,
    summary: parsed.summary,
    concepts: parsed.concepts,
  };
}

const OVERVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["overview", "course_site_url"],
  properties: {
    overview: {
      type: "string",
      description:
        "4-8 sentences: what the course covers, how it progresses lecture to lecture, and inferable prerequisites.",
    },
    course_site_url: {
      type: ["string", "null"],
      description:
        "The official course website from the candidate list (verbatim), or null if no candidate is one.",
    },
  },
} as Record<string, unknown>;

export async function buildOverview(
  model: ResolvedModel,
  playlist: PlaylistInfo,
  lectures: LectureMap[],
  candidateUrls: string[],
  totals: Usage,
): Promise<{ overview: string; courseSiteUrl: string | null }> {
  const lectureDigest = lectures
    .map(
      (l) =>
        `Lecture ${l.index}: ${l.title}\n${l.summary}\nConcepts: ${l.concepts.map((c) => c.name).join(", ")}`,
    )
    .join("\n\n");
  const { text, usage } = await model.provider.completeStructured({
    model: model.model,
    segments: [
      {
        role: "user",
        text: `Course: ${playlist.title}\n\n${lectureDigest}\n\nCandidate URLs found in the video descriptions (pick the official course website, or null):\n${candidateUrls.length > 0 ? candidateUrls.join("\n") : "(none)"}\n\nWrite the course overview and pick the course site URL.`,
      },
    ],
    maxTokens: 4096,
    reasoning: "thorough",
    schemaName: "course_overview",
    schema: OVERVIEW_SCHEMA,
  });
  addUsage(totals, usage);

  const parsed = JSON.parse(text) as {
    overview: string;
    course_site_url: string | null;
  };
  // The model must choose from the provided list; drop anything else.
  const courseSiteUrl =
    parsed.course_site_url && candidateUrls.includes(parsed.course_site_url)
      ? parsed.course_site_url
      : null;
  return { overview: parsed.overview, courseSiteUrl };
}

export async function buildCourseMap(
  model: ResolvedModel,
  playlist: PlaylistInfo,
  videos: VideoData[],
  totals: Usage,
  log: (msg: string) => void,
): Promise<CourseMap> {
  // First call alone so it writes the shared cache; the rest read it.
  const lectures: LectureMap[] = [];
  log(`building lecture map 1/${videos.length}…`);
  lectures.push(await buildLectureMap(model, playlist, videos[0], 1, totals));

  const CONCURRENCY = 3;
  for (let i = 1; i < videos.length; i += CONCURRENCY) {
    const batch = videos.slice(i, i + CONCURRENCY);
    log(
      `building lecture maps ${i + 1}-${i + batch.length}/${videos.length}…`,
    );
    const results = await Promise.all(
      batch.map((v, j) =>
        buildLectureMap(model, playlist, v, i + j + 1, totals),
      ),
    );
    lectures.push(...results);
  }

  const candidateUrls = [
    ...new Set(videos.flatMap((v) => extractUrls(v.description))),
  ].slice(0, 20);
  log("building course overview…");
  const { overview, courseSiteUrl } = await buildOverview(
    model,
    playlist,
    lectures,
    candidateUrls,
    totals,
  );

  let courseSiteExcerpt: string | null = null;
  if (courseSiteUrl) {
    log(`fetching course site: ${courseSiteUrl}`);
    try {
      courseSiteExcerpt = await fetchSiteText(courseSiteUrl);
    } catch (err) {
      log(`  (course site fetch failed: ${(err as Error).message})`);
    }
  }

  return {
    playlistId: playlist.playlistId,
    courseTitle: playlist.title,
    model: model.spec,
    createdAt: new Date().toISOString(),
    overview,
    courseSiteUrl,
    courseSiteExcerpt,
    lectures,
  };
}
