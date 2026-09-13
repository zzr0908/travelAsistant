import { z } from "zod";

export const sourceId = z.enum([
  "wikipedia",
  "wikivoyage",
  "xiaohongshu",
  "reddit",
  "tripadvisor",
]);
const context = z
  .object({
    destination: z.string().max(200).optional(),
    dates: z.string().max(200).optional(),
    purpose: z.string().max(500).optional(),
    conditions: z.record(z.string().max(80), z.string().max(500)).default({}),
  })
  .strict()
  .default({ conditions: {} });
const common = {
  requestId: z.string().uuid(),
  context,
  maxChars: z.number().int().min(500).max(40000).default(16000),
  startChar: z.number().int().min(0).max(2000000).default(0),
  maxComments: z.number().int().min(0).max(50).default(20),
};
export const browserRequest = z.discriminatedUnion("action", [
  z
    .object({
      ...common,
      action: z.literal("search"),
      source: sourceId,
      query: z.string().trim().min(1).max(300),
      limit: z.number().int().min(1).max(20).default(5),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal("read"),
      url: z.string().url().max(4096),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal("capture"),
      pageId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal("scroll"),
      pageId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal("expand"),
      pageId: z.string().uuid(),
      snapshotId: z.string().uuid(),
      controlId: z.string().max(100),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal("follow"),
      pageId: z.string().uuid(),
      snapshotId: z.string().uuid(),
      linkId: z.string().max(100),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal("screenshot"),
      pageId: z.string().uuid(),
    })
    .strict(),
  z
    .object({ ...common, action: z.literal("login"), source: sourceId })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal("close"),
      pageId: z.string().uuid(),
    })
    .strict(),
]);
export type BrowserRequest = z.infer<typeof browserRequest>;
export const queryStatus = z.enum([
  "ok",
  "partial",
  "no_match",
  "needs_input",
  "unsupported",
  "unavailable",
  "restricted",
  "rate_limited",
  "timeout",
  "cancelled",
  "failed",
  "interrupted",
]);
export type QueryStatus = z.infer<typeof queryStatus>;
export const pageData = z.object({
  pageId: z.string().uuid(),
  snapshotId: z.string().uuid(),
  sourceId: z.string(),
  sourceType: z.string(),
  url: z.string(),
  title: z.string(),
  language: z.string().nullable(),
  contentKind: z.enum(["search_results", "page", "login", "access_notice"]),
  text: z.string(),
  textHash: z.string(),
  totalTextChars: z.number(),
  truncated: z.boolean(),
  textRange: z.object({
    start: z.number(),
    end: z.number(),
    nextOffset: z.number().nullable(),
  }),
  publishedAt: z.string().nullable(),
  modifiedAt: z.string().nullable(),
  experiencedAt: z.string().nullable(),
  author: z.string().nullable(),
  canonicalUrl: z.string().nullable(),
  license: z.string().nullable(),
  links: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      url: z.string(),
      kind: z.enum(["page", "pdf"]),
    }),
  ),
  comments: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      author: z.string().nullable(),
      publishedAt: z.string().nullable(),
      experiencedAt: z.string().nullable(),
      url: z.string().nullable(),
      truncated: z.boolean(),
    }),
  ),
  media: z.array(
    z.object({
      kind: z.enum(["image", "video"]),
      url: z.string(),
      alt: z.string(),
      caption: z.string(),
      status: z.literal("reference_only"),
    }),
  ),
  controls: z.array(z.object({ id: z.string(), label: z.string() })),
  counts: z.object({
    commentsDetected: z.number(),
    commentsSaved: z.number(),
    commentsTotal: z.number().nullable(),
    imagesDetected: z.number(),
    mediaSaved: z.number(),
    linksDetected: z.number(),
    linksSaved: z.number(),
    controlsDetected: z.number(),
  }),
  viewport: z.object({
    scrollY: z.number(),
    height: z.number(),
    documentHeight: z.number(),
  }),
  evidenceId: z.string().nullable(),
  verification: z.literal("unverified"),
});
export type PageData = z.infer<typeof pageData>;
export const browserResult = z.object({
  schemaVersion: z.literal(1),
  queryId: z.string().uuid(),
  capability: z.string(),
  providerId: z.literal("chrome-devtools-mcp"),
  status: queryStatus,
  data: pageData.nullable(),
  evidenceIds: z.array(z.string()),
  artifact: z
    .object({
      id: z.string().uuid(),
      mimeType: z.string(),
      sha256: z.string(),
      byteLength: z.number(),
      interpretation: z.literal("not_performed"),
    })
    .nullable(),
  context,
  missing: z.array(z.string()),
  limitations: z.array(z.string()),
  retrievedAt: z.string(),
  durationMs: z.number(),
  usage: z.object({
    toolCalls: z.number(),
    browserRequests: z.null(),
    cost: z.null(),
  }),
  message: z.string(),
});
export type BrowserResult = z.infer<typeof browserResult>;
export class BrowserError extends Error {
  constructor(
    public status: QueryStatus,
    message: string,
  ) {
    super(message);
  }
}
