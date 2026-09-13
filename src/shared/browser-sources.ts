import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { BrowserError } from "./browser-model.js";

export const sources = [
  {
    id: "wikipedia",
    label: "Wikipedia",
    type: "open_knowledge",
    host: "en.wikipedia.org",
    home: "https://en.wikipedia.org",
    search: (q: string) =>
      `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`,
    result: /\/wiki\/(?!Special:|Help:|Wikipedia:)/,
  },
  {
    id: "wikivoyage",
    label: "Wikivoyage",
    type: "travel_guide",
    host: "en.wikivoyage.org",
    home: "https://en.wikivoyage.org",
    search: (q: string) =>
      `https://en.wikivoyage.org/w/index.php?search=${encodeURIComponent(q)}`,
    result: /\/wiki\/(?!Special:|Help:|Wikivoyage:)/,
  },
  {
    id: "xiaohongshu",
    label: "小红书",
    type: "community",
    host: "www.xiaohongshu.com",
    home: "https://www.xiaohongshu.com",
    search: (q: string) =>
      `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(q)}&source=web_search_result_notes`,
    result: /\/(explore|search_result)\/[a-f\d]+/i,
  },
  {
    id: "reddit",
    label: "Reddit",
    type: "community",
    host: "www.reddit.com",
    home: "https://www.reddit.com",
    search: (q: string) =>
      `https://www.reddit.com/search/?q=${encodeURIComponent(q)}&type=posts`,
    result: /\/comments\//,
  },
  {
    id: "tripadvisor",
    label: "Tripadvisor",
    type: "reviews",
    host: "www.tripadvisor.com",
    home: "https://www.tripadvisor.com",
    search: (q: string) =>
      `https://www.tripadvisor.com/Search?q=${encodeURIComponent(q)}`,
    result:
      /\/(Attraction_Review|Hotel_Review|Restaurant_Review|ShowUserReviews|ShowTopic)-/,
  },
] as const;

// Host configuration is owned by the operator, never supplied by the model.
export const defaultHosts = [
  "wikipedia.org",
  "wikivoyage.org",
  "wikimedia.org",
  "mediawiki.org",
  "xiaohongshu.com",
  "xhscdn.com",
  "xhslink.com",
  "xiaohongshu.net",
  "reddit.com",
  "redditstatic.com",
  "redditmedia.com",
  "redd.it",
  "tripadvisor.com",
  "tripadvisor.cn",
  "tacdn.com",
  "jscache.com",
  "uffizi.it",
  "museogalileo.it",
  "visittuscany.com",
  "visitflorence.com",
  "trenitalia.com",
  "datocms-assets.com",
];
export function sourceFor(url: string) {
  const host = new URL(url).hostname;
  return sources.find(
    (s) =>
      host === s.host || host.endsWith(`.${s.host.replace(/^(www|en)\./, "")}`),
  );
}
export function hostMatches(host: string, allowed: readonly string[]) {
  return allowed.some((item) => host === item || host.endsWith(`.${item}`));
}
export function canonicalUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  url.username = "";
  url.password = "";
  for (const name of [...url.searchParams.keys()])
    if (
      /(token|session|cookie|password|signature|secret|csrf)/i.test(name) ||
      /^(utm_|xsec_|auth|sig$|key$|code$|fbclid|gclid|share_|uuid$|redirectpath$|rejecturl$|verifymsg$|error_msg$|solution$|jsc_|js_challenge$|__cf_)/i.test(
        name,
      )
    )
      url.searchParams.delete(name);
  return url.href;
}
export function privateAddress(address: string) {
  if (address.includes(":")) {
    const s = address.toLowerCase();
    // Conservatively admit global unicast only. Reject mapped IPv4 and transition ranges.
    const [first, second] = s
      .split(":")
      .map((part) => parseInt(part || "0", 16));
    return (
      !/^[23][0-9a-f]{3}:/.test(s) ||
      first === 0x2002 ||
      first === 0x3fff ||
      (first === 0x2001 &&
        (second === 0 ||
          second === 2 ||
          second === 0xdb8 ||
          (second >= 0x10 && second <= 0x2f)))
    );
  }
  const [a, b] = address.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && [0, 168].includes(b)) ||
    (a === 198 && [18, 19, 51].includes(b)) ||
    (a === 203 && b === 0) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}
export async function validateUrl(
  raw: string,
  hosts: readonly string[],
  allowLocalTest = false,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BrowserError("restricted", "网址无效");
  }
  if (
    !hostMatches(url.hostname, hosts) ||
    url.username ||
    url.password ||
    !["http:", "https:"].includes(url.protocol) ||
    (!allowLocalTest && url.port && !["80", "443"].includes(url.port))
  )
    throw new BrowserError(
      "restricted",
      "该网址不在浏览器工具的来源范围内，请由主机配置来源域名。",
    );
  if (!allowLocalTest) {
    let abort: (() => void) | undefined;
    const resolving = isIP(url.hostname)
      ? Promise.resolve([{ address: url.hostname }])
      : lookup(url.hostname, { all: true }).catch(() => {
          throw new BrowserError("unavailable", "来源域名解析失败");
        });
    const cancelled = signal
      ? new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
        })
      : undefined;
    const addresses = await (
      cancelled ? Promise.race([resolving, cancelled]) : resolving
    ).finally(() => {
      if (abort) signal!.removeEventListener("abort", abort);
    });
    if (
      !addresses.length ||
      addresses.some((entry) => privateAddress(entry.address))
    )
      throw new BrowserError(
        "restricted",
        "浏览器研究工具只读取已配置的公网来源。",
      );
  }
  return url.href;
}
