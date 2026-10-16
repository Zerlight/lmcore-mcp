import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer, { type Browser, type Cookie, type Page } from "puppeteer-core";
import { BASE_URL, CHROME_PATH, isLoginUrl, SESSION_PATH, SITE_HOST } from "./config.js";

const FORMAT = "lmcore-mcp/session";
const FORMAT_VERSION = 1;

export interface StoredSession {
  format: typeof FORMAT;
  version: typeof FORMAT_VERSION;
  baseUrl: string;
  /** Moodle user ID, recorded when `lmcore_courses` runs. */
  userId: number;
  fullName: string;
  savedAt: string;
  cookies: Cookie[];
}

export class SessionExpiredError extends Error {
  constructor() {
    super(
      "Learning Mall session is missing or has expired. Run `pnpm run login` and sign in, then retry.",
    );
    this.name = "SessionExpiredError";
  }
}

function readSession(): StoredSession {
  let raw: string;
  try {
    raw = fs.readFileSync(SESSION_PATH, "utf8");
  } catch {
    throw new SessionExpiredError();
  }
  const parsed = JSON.parse(raw) as StoredSession;
  if (parsed.format !== FORMAT || !Array.isArray(parsed.cookies)) throw new SessionExpiredError();
  return parsed;
}

function saveSession(session: StoredSession): void {
  fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true, mode: 0o700 });
  const temporaryPath = `${SESSION_PATH}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(session, null, 2), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporaryPath, SESSION_PATH);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

/** Updates the stored session file with the authenticated user's ID and full name. */
export function rememberUser(userId: number, fullName: string): void {
  const session = readSession();
  session.userId = userId;
  session.fullName = fullName;
  session.savedAt = new Date().toISOString();
  saveSession(session);
}

/**
 * Launches headless Chrome preloaded with the saved session cookies.
 * The caller is responsible for closing the returned `browser` instance.
 */
export async function openSession(): Promise<{ browser: Browser; page: Page }> {
  const session = readSession();
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-first-run", "--disable-sync"],
  });
  try {
    const page = await browser.newPage();
    await page.setCookie(...session.cookies);
    return { browser, page };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

/**
 * Navigates to `urlPath` and verifies that Moodle did not redirect to a login screen.
 */
export async function gotoAuthed(page: Page, urlPath: string): Promise<void> {
  const target = new URL(urlPath, BASE_URL).toString();
  const response = await page.goto(target, { waitUntil: "networkidle2", timeout: 60_000 });
  if (response && response.status() >= 400) throw new Error(`${urlPath} returned HTTP ${response.status()}.`);
  if (isLoginUrl(page.url())) throw new SessionExpiredError();
}

export interface LoginOptions {
  /** Callback for status messages (written to stderr so stdout remains clean for MCP). */
  log: (message: string) => void;
}

/**
 * Launches a regular Chrome instance with a temporary user profile, waits for
 * the user to complete XJTLU SSO login, and writes the session cookies to disk.
 */
export async function interactiveLogin(options: LoginOptions): Promise<StoredSession> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lmcore-login-"));
  const debuggingPort = 9222 + Math.floor(Math.random() * 1000);
  let chrome: ReturnType<typeof spawn> | undefined;
  try {
    const child = spawn(
      CHROME_PATH,
      [
        `--user-data-dir=${profile}`,
        `--remote-debugging-port=${debuggingPort}`,
        "--no-first-run",
        "--no-default-browser-check",
        `${BASE_URL}/my/`,
      ],
      { stdio: "ignore" },
    );
    chrome = child;
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    options.log("Chrome window opened. Please sign in with your XJTLU account.");
    options.log("Waiting for authentication to complete...");
    const browser = await connectWhenReady(debuggingPort);
    try {
      await waitForLogin(browser, options);
      const cookies = await collectCookies(browser);
      if (!cookies.some((cookie) => cookie.name === "MoodleSession")) {
        throw new Error("Login finished but no MoodleSession cookie was set.");
      }
      const session: StoredSession = {
        format: FORMAT,
        version: FORMAT_VERSION,
        baseUrl: BASE_URL,
        userId: 0,
        fullName: "",
        savedAt: new Date().toISOString(),
        cookies,
      };
      saveSession(session);
      options.log(`Session saved to ${SESSION_PATH}`);
      return session;
    } finally {
      await browser.disconnect();
    }
  } finally {
    if (chrome) await stopChrome(chrome);
    await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** Terminates the temporary Chrome process and waits for it to exit before profile cleanup. */
async function stopChrome(chrome: ReturnType<typeof spawn>): Promise<void> {
  if (!chrome.pid || chrome.exitCode !== null || chrome.signalCode !== null) return;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const exited = await new Promise<boolean>((resolve) => {
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        chrome.off("exit", onExit);
        resolve(false);
      }, 5000);
      chrome.once("exit", onExit);
      chrome.kill(signal);
    });
    if (exited) return;
  }
  throw new Error("Chrome did not exit after SIGKILL; its temporary profile was left in place.");
}

/** Polls Chrome's DevTools port until the browser is ready to accept connections. */
async function connectWhenReady(port: number): Promise<Browser> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    } catch (error) {
      lastError = error;
      await delay(300);
    }
  }
  throw new Error(`Chrome did not open its debugging port. ${String(lastError)}`);
}

/** Polls open tabs until one reaches the configured Moodle host past all login screens. */
async function waitForLogin(browser: Browser, options: LoginOptions): Promise<void> {
  const deadline = Date.now() + 5 * 60_000;
  let prompted = false;
  while (Date.now() < deadline) {
    for (const page of await browser.pages()) {
      const url = page.url();
      if (!url.startsWith("http")) continue;
      let host = "";
      try {
        host = new URL(url).host;
      } catch {
        continue;
      }
      if (host === SITE_HOST && !isLoginUrl(url)) return;
    }
    if (!prompted && Date.now() + 4 * 60_000 < deadline) {
      prompted = true;
    }
    await delay(1000);
  }
  options.log("Login timed out after five minutes.");
  throw new Error("Timed out waiting for login.");
}

/** Reads cookies scoped to the configured Moodle host (and XJTLU SSO when applicable). */
async function collectCookies(browser: Browser): Promise<Cookie[]> {
  const page = (await browser.pages())[0];
  if (!page) throw new Error("Chrome closed before cookies could be read.");
  const client = await page.createCDPSession();
  const { cookies } = (await client.send("Network.getAllCookies")) as { cookies: Cookie[] };
  const hostname = new URL(BASE_URL).hostname;
  const hosts = [hostname];
  if (hostname === "xjtlu.edu.cn" || hostname.endsWith(".xjtlu.edu.cn")) {
    hosts.push("sso.xjtlu.edu.cn");
  }
  return cookies.filter((cookie) => {
    const domain = cookie.domain.replace(/^\./, "").toLowerCase();
    return hosts.some((host) => host === domain || (
      cookie.domain.startsWith(".") && host.endsWith(`.${domain}`)
    ));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Returns metadata for the stored session without exposing cookie values. */
export function describeSession(): { path: string; savedAt: string; fullName: string } | undefined {
  try {
    const session = readSession();
    return { path: SESSION_PATH, savedAt: session.savedAt, fullName: session.fullName };
  } catch {
    return undefined;
  }
}
