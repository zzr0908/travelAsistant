import { resolve } from "node:path";
import { defaultHosts } from "./sources.js";
import type { BrowserOptions } from "./service.js";

export function browserOptions(directory: string): BrowserOptions {
  return {
    directory: resolve(directory),
    enabled: process.env.BROWSER_ENABLED !== "0",
    headless: process.env.BROWSER_HEADLESS === "1",
    hosts: process.env.BROWSER_ALLOWED_HOSTS
      ? process.env.BROWSER_ALLOWED_HOSTS.split(",")
          .map((host) => host.trim().toLowerCase())
          .filter(Boolean)
      : defaultHosts,
    executablePath: process.env.BROWSER_CHROME_PATH || undefined,
    proxyServer: process.env.BROWSER_PROXY_SERVER || undefined,
  };
}
