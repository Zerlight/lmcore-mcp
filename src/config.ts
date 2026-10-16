import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Base URL for Learning Mall Core (override via `LMCORE_URL`). */
export const BASE_URL = (
  process.env.LMCORE_URL ?? "https://core.xjtlu.edu.cn"
).replace(/\/+$/, "");

export const SITE_HOST = new URL(BASE_URL).host;

/** Path to the stored session file (override via `LMCORE_SESSION`). */
export const SESSION_PATH =
  process.env.LMCORE_SESSION ??
  path.join(os.homedir(), ".config", "lmcore-mcp", "session.json");

function findChrome(): string {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  if (os.platform() === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }

  const candidates = os.platform() === "win32"
    ? [
        process.env.PROGRAMFILES ?? "C:\\Program Files",
        process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
        process.env.LOCALAPPDATA,
      ].filter((directory): directory is string => Boolean(directory))
        .map((directory) => path.win32.join(directory, "Google", "Chrome", "Application", "chrome.exe"))
    : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].flatMap((name) =>
        (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(":")
          .filter(Boolean)
          .map((directory) => path.posix.join(directory, name)),
      );

  return candidates.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) ?? candidates[0] ?? "/usr/bin/google-chrome";
}

/** Browser executable, overridden by `PUPPETEER_EXECUTABLE_PATH`. */
export const CHROME_PATH = findChrome();

/** Returns true if `url` points to a Moodle or XJTLU SSO login endpoint. */
export function isLoginUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.pathname.startsWith("/login/") ||
      u.pathname.startsWith("/auth/") ||
      u.pathname.startsWith("/local/login/") ||
      u.host === "sso.xjtlu.edu.cn"
    );
  } catch {
    return false;
  }
}
