import {setTimeout as delay} from 'node:timers/promises';
import type {BrowserBackend,ToolReply} from '../../src/agent/browser/chrome.js';
const json = (value: unknown): ToolReply => ({
  content: [
    {
      type: "text",
      text: `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``,
    },
  ],
});
export class FakeChrome implements BrowserBackend {
  calls: string[] = [];
  active = 0;
  maxActive = 0;
  closed = 0;
  slow = false;
  login = false;
  url = "https://en.wikipedia.org/wiki/Uffizi";
  async call(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolReply> {
    this.calls.push(name);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await delay(this.slow ? 1000 : 1, undefined, { signal });
      if (name === "new_page") {
        this.url = args.url as string;
        return {
          content: [],
          structuredContent: {
            pages: [{ id: 1, url: this.url, selected: true }],
          },
        };
      }
      if (name === "navigate_page") {
        this.url = args.url as string;
        return { content: [] };
      }
      if (name === "take_screenshot")
        return {
          content: [
            {
              type: "image",
              mimeType: "image/jpeg",
              data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"),
            },
          ],
        };
      if (name !== "evaluate_script") return { content: [] };
      const script = args.function as string;
      if (script.includes("({url: location.href})"))
        return json({ url: this.url });
      if (script.includes("window.scrollBy")) return json({ scrolled: true });
      if (script.includes("control.el.click()")) return json({ changed: true });
      return json({
        url: this.url,
        title: "Uffizi",
        language: "en",
        text: "Museum description",
        totalTextChars: 18,
        truncated: false,
        textRange: { start: 0, end: 18, nextOffset: null },
        publishedAt: null,
        modifiedAt: null,
        author: null,
        canonicalUrl: this.url,
        license: null,
        links: [
          {
            id: "link-0",
            text: "Florence",
            url: "https://en.wikipedia.org/wiki/Florence?xsec_token=secret&utm_source=foo",
            kind: "page",
          },
        ],
        comments: [
          {
            id: "c1",
            text: "Useful visit",
            author: "visitor",
            publishedAt: "09-01",
            experiencedAt: null,
            url: null,
            truncated: false,
          },
        ],
        media: [
          {
            kind: "image",
            url: "https://upload.wikimedia.org/image.jpg",
            alt: "museum",
            caption: "",
            status: "reference_only",
          },
        ],
        controls: [{ id: "expand-0", label: "Show more comments" }],
        counts: {
          commentsDetected: 1,
          commentsTotal: 10,
          imagesDetected: 1,
          linksDetected: 1,
          controlsDetected: 1,
        },
        viewport: { scrollY: 0, height: 800, documentHeight: 2000 },
        statusCode: 200,
        loginWall: this.login,
        restricted: false,
      });
    } finally {
      this.active--;
    }
  }
  async close() {
    this.closed++;
  }
}
