// This function is serialized into Chrome. It only reads rendered DOM and has no
// access to cookies, storage, network APIs or user-supplied JavaScript.
export function inspectDocument(options: {
  maxChars: number;
  maxComments: number;
  startChar: number;
}) {
  const visible = (el: Element) => {
    const style = getComputedStyle(el);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      !!el.getClientRects().length
    );
  };
  const txt = (el: Element | null, limit = 1000) =>
    ((el as HTMLElement | null)?.innerText || el?.textContent || "")
      .trim()
      .slice(0, limit);
  const meta = (name: string) =>
    document
      .querySelector(`meta[name="${name}"],meta[property="${name}"]`)
      ?.getAttribute("content")
      ?.slice(0, 1000) || null;
  const main = (document.querySelector(
    "article,.note-content,#mw-content-text,main,[role=main]",
  ) || document.body) as HTMLElement;
  const allText = (main?.innerText || "").trim();
  const pageText = (document.body?.innerText || "").trim();
  const links = [
    ...(main || document).querySelectorAll<HTMLAnchorElement>("a[href]"),
  ]
    .filter(visible)
    .filter((a) => /^https?:/.test(a.href) && txt(a).length > 0);
  const uniqueLinks = [...new Map(links.map((a) => [a.href, a])).values()];
  const commentSelector =
    "shreddit-comment,[data-testid=comment],.comment-item,.parent-comment,[data-reviewid],[data-review-id],[data-testid=review-card]";
  const commentNodes = [...document.querySelectorAll(commentSelector)].filter(
    visible,
  );
  const comments = commentNodes
    .slice(0, options.maxComments)
    .map((el, index) => {
      const content =
        el.querySelector(
          "[slot=comment],.content,.comment-text,[data-testid=review-text]",
        ) || el;
      const body = txt(content, 12000);
      const time = el.querySelector("time");
      const author =
        el.getAttribute("author") ||
        txt(
          el.querySelector("[data-testid=author],.author,.name,.username"),
          200,
        ) ||
        null;
      const link = el.querySelector<HTMLAnchorElement>(
        'a[href*="/comments/"],a[href*="ShowUserReviews"],a[href*="comment"]',
      );
      const experience = [...el.querySelectorAll("span,div")].find(
        (e) =>
          e.childElementCount === 0 &&
          /^(Date of experience|Date of visit|旅行日期|体验日期)[:：]/i.test(
            txt(e, 200),
          ),
      );
      return {
        id:
          el.getAttribute("thingid") ||
          el.getAttribute("data-reviewid") ||
          el.id ||
          `comment-${index}`,
        text: body.slice(0, 2500),
        author,
        publishedAt:
          time?.getAttribute("datetime") ||
          txt(time, 150) ||
          txt(el.querySelector(".date,.time"), 150) ||
          null,
        experiencedAt: experience ? txt(experience, 200) : null,
        url: link?.href || null,
        truncated: body.length > 2500,
      };
    });
  const imageNodes = [
    ...(main || document).querySelectorAll<HTMLImageElement>("img"),
  ].filter(visible);
  const images = imageNodes
    .filter((el) => el.currentSrc || el.src)
    .slice(0, 40)
    .map((el) => ({
      kind: "image" as const,
      url: el.currentSrc || el.src,
      alt: el.alt.slice(0, 500),
      caption: txt(
        el.closest("figure")?.querySelector("figcaption") || null,
        500,
      ),
      status: "reference_only" as const,
    }));
  const videos = [
    ...(main || document).querySelectorAll<HTMLVideoElement>("video"),
  ]
    .filter(visible)
    .slice(0, 10)
    .map((el) => ({
      kind: "video" as const,
      url: el.currentSrc || el.src || el.poster,
      alt: el.getAttribute("aria-label") || "",
      caption: "",
      status: "reference_only" as const,
    }));
  const controls = [
    ...document.querySelectorAll<HTMLElement>("button,[role=button],summary,a"),
  ]
    .filter(visible)
    .filter(
      (el) =>
        el.tagName !== "A" ||
        !el.getAttribute("href") ||
        el.getAttribute("href")!.startsWith("#"),
    )
    .map((el) => ({
      el,
      label: (el.getAttribute("aria-label") || txt(el, 120)).trim(),
    }))
    .filter(({ label }) =>
      /^(展开.{0,30}|查看更多.{0,30}|加载更多.{0,30}|更多评论|更多回复|显示更多.{0,30}|(?:show|load|view|read|see) (?:\d+ |all |more |other |previous |the )*(?:comments?|replies|reviews?|responses?|more)|continue (?:this )?thread|more (?:comments|replies|reviews))$/i.test(
        label,
      ),
    );
  const countNode = document.querySelector(
    "[data-testid=comments-count],.comments-container .total,.comments-el .total",
  );
  const countMatch = countNode
    ? txt(countNode, 100).match(
        /(?:共\s*)?([\d,]+)\s*(?:条|comments?|reviews?)/i,
      )
    : null;
  const licenseLink = document.querySelector<HTMLAnchorElement>(
    'a[rel=license],a[href*="creativecommons.org/licenses"]',
  );
  const navigation = performance.getEntriesByType(
    "navigation",
  )[0] as PerformanceNavigationTiming & { responseStatus?: number };
  // A login link in the header alone is not a login wall.
  const loginWall =
    !!document.querySelector("input[type=password]") ||
    /^(log in|sign in|登录|注册)\b/i.test(document.title) ||
    ((allText.length < 1200 ||
      !!document.querySelector(
        "[role=dialog],.login-container,.login-modal",
      )) &&
      /登录后(?:查看|继续|搜索)|请先登录|登录即可|log in to (?:continue|view|see)|sign in to continue/i.test(
        pageText,
      ));
  const challenge =
    /verify you are human|prove your humanity|confirm (?:that )?you(?:'|’)re human|checking your browser|access denied|you(?:'|’)ve been blocked|blocked by network security|安全验证|安全限制|访问受限|请完成验证|验证码|IP存在风险|just a moment/i;
  const restricted =
    challenge.test(document.title) ||
    ((pageText.length < 2000 ||
      !!document.querySelector(
        'iframe[src*="captcha"],#challenge-running,[id*=challenge-form]',
      )) &&
      challenge.test(pageText.slice(0, 1500)));
  return {
    url: location.href,
    title: document.title.slice(0, 500),
    language: document.documentElement.lang || null,
    text: allText.slice(
      options.startChar,
      options.startChar + options.maxChars,
    ),
    totalTextChars: allText.length,
    truncated: options.startChar > 0 || allText.length > options.maxChars,
    textRange: {
      start: Math.min(options.startChar, allText.length),
      end: Math.min(options.startChar + options.maxChars, allText.length),
      nextOffset:
        options.startChar + options.maxChars < allText.length
          ? options.startChar + options.maxChars
          : null,
    },
    publishedAt: meta("article:published_time") || meta("datePublished"),
    modifiedAt: meta("article:modified_time"),
    author: meta("author"),
    canonicalUrl:
      document.querySelector<HTMLLinkElement>("link[rel=canonical]")?.href ||
      null,
    license: licenseLink?.href || null,
    links: uniqueLinks
      .slice(0, 150)
      .map((el, index) => ({
        id: `link-${index}`,
        text: txt(el, 300),
        url: el.href,
        kind: /\.pdf(?:[?#]|$)/i.test(el.href)
          ? ("pdf" as const)
          : ("page" as const),
      })),
    comments,
    media: [...images, ...videos],
    controls: controls
      .slice(0, 40)
      .map(({ label }, index) => ({ id: `expand-${index}`, label })),
    counts: {
      commentsDetected: commentNodes.length,
      commentsTotal: countMatch
        ? Number(countMatch[1].replaceAll(",", ""))
        : null,
      imagesDetected: imageNodes.length,
      linksDetected: uniqueLinks.length,
      controlsDetected: controls.length,
    },
    viewport: {
      scrollY: window.scrollY,
      height: window.innerHeight,
      documentHeight: document.documentElement.scrollHeight,
    },
    statusCode: navigation?.responseStatus || null,
    loginWall,
    restricted,
  };
}
export type ExtractedPage = ReturnType<typeof inspectDocument>;

export function extractionScript(
  maxChars: number,
  maxComments: number,
  startChar = 0,
) {
  // tsx/esbuild can emit a local function-name helper in development; tsc's
  // release output does not. Bind it in the isolated serialized function.
  return `() => { const __name = fn => fn; return (${inspectDocument.toString()})(${JSON.stringify({ maxChars, maxComments, startChar })}); }`;
}

// Re-identify the control immediately before a click; no selector or JavaScript
// supplied by an agent is evaluated. The current text and URL must still match.
export function expandScript(
  expectedUrl: string,
  label: string,
  index: number,
) {
  return `() => {
    const expected = ${JSON.stringify({ expectedUrl, label, index })};
    if (location.href !== expected.expectedUrl) return { changed: false, stale: true };
    const visible = el => getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length;
    const controls = [...document.querySelectorAll('button,[role=button],summary,a')].filter(visible)
      .filter(el => el.tagName !== 'A' || !el.getAttribute('href') || el.getAttribute('href').startsWith('#'))
      .map(el => ({ el, label: (el.getAttribute('aria-label') || el.innerText || el.textContent || '').trim().slice(0,120) }))
      .filter(({label}) => /^(展开.{0,30}|查看更多.{0,30}|加载更多.{0,30}|更多评论|更多回复|显示更多.{0,30}|(?:show|load|view|read|see) (?:\\d+ |all |more |other |previous |the )*(?:comments?|replies|reviews?|responses?|more)|continue (?:this )?thread|more (?:comments|replies|reviews))$/i.test(label));
    const control = controls[expected.index];
    if (!control || control.label !== expected.label) return { changed: false, stale: true };
    control.el.click(); return { changed: true, stale: false };
  }`;
}
