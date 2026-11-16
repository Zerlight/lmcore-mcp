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
  let parsed: StoredSession;
  try {
    raw = fs.readFileSync(SESSION_PATH, "utf8");
    parsed = JSON.parse(raw) as StoredSession;
  } catch {
    throw new SessionExpiredError();
  }
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

/** How long the user has to sign in and close the sign-in window. */
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
/** How long the verification browser may take to start, load the dashboard, and confirm sign-in. */
const VERIFY_TIMEOUT_MS = 60_000;
const SIGN_IN_INCOMPLETE = "Sign-in did not complete; run login again.";

type ChromeProcess = ReturnType<typeof spawn>;

/** Chrome processes and profiles owned by a login in progress, for signal-time cleanup. */
const liveChromes = new Set<ChromeProcess>();
const liveProfiles = new Set<string>();

/**
 * Synchronously kills login Chrome processes and removes temporary profiles.
 * Intended for SIGINT/SIGTERM handlers in the login entrypoint.
 */
export function abortLoginSync(): void {
  for (const chrome of liveChromes) {
    try {
      chrome.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const profile of liveProfiles) {
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Best effort; the OS temp directory is cleaned eventually.
    }
  }
}

class ChromeStuckError extends Error {
  constructor() {
    super("Chrome did not exit after SIGKILL; its temporary profile was left in place.");
    this.name = "ChromeStuckError";
  }
}

class SignInIncompleteError extends Error {
  constructor(detail?: string) {
    super(detail ? `Sign-in did not complete (${detail}); run login again.` : SIGN_IN_INCOMPLETE);
    this.name = "SignInIncompleteError";
  }
}

/** Flags shared by both login phases. None of them is visible to web pages. */
function commonChromeArgs(profile: string): string[] {
  return [
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    // Avoid cross-origin HTTP/2 connection reuse during SSO redirects.
    "--disable-http2",
    // Encrypt cookies the same way in the headed and headless launches on Linux.
    ...(os.platform() === "linux" ? ["--password-store=basic"] : []),
  ];
}

/**
 * Two-phase interactive login.
 *
 * Phase 1 opens a plain Chrome window (no remote debugging, no automation) with a
 * temporary profile so XJTLU SSO cannot detect DevTools. The user signs in and
 * closes the window; Chrome then writes its cookies to the profile.
 *
 * Phase 2 reopens the same profile with remote debugging, loads only the
 * Learning Mall dashboard (navigation to any other host is blocked), verifies the
 * signed-in state, and saves the session cookies to disk.
 */
export async function interactiveLogin(options: LoginOptions): Promise<StoredSession> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lmcore-login-"));
  liveProfiles.add(profile);
  let keepProfile = false;
  try {
    prepareProfile(profile);
    await signInWithoutDevTools(profile, options);
    let cookies: Cookie[];
    try {
      cookies = await captureSession(profile, true, options);
    } catch (error) {
      if (!(error instanceof SignInIncompleteError)) throw error;
      // Some platforms cannot read the headed profile's cookies in headless mode.
      options.log("Headless check did not find the session; retrying in a regular window...");
      cookies = await captureSession(profile, false, options);
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
  } catch (error) {
    // Never delete a profile that a still-running Chrome may be writing.
    if (error instanceof ChromeStuckError) keepProfile = true;
    throw error;
  } finally {
    liveProfiles.delete(profile);
    if (!keepProfile) await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/**
 * Sets "Continue where you left off" so Chrome keeps session-only cookies such as
 * MoodleSession when the profile is reopened in phase 2.
 */
function prepareProfile(profile: string): void {
  const directory = path.join(profile, "Default");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "Preferences"), JSON.stringify({ session: { restore_on_startup: 1 } }));
}

/** Phase 1: plain Chrome window; resolves once the user closes it. */
async function signInWithoutDevTools(profile: string, options: LoginOptions): Promise<void> {
  const chrome = await launchChrome([...commonChromeArgs(profile), `${BASE_URL}/my/`]);
  const startedAt = Date.now();
  options.log("A Chrome window has opened. Sign in with your XJTLU account through SSO.");
  options.log(
    "When the Learning Mall dashboard appears, close that Chrome window"
      + (os.platform() === "darwin" ? " and quit Chrome (Cmd+Q)." : ".")
      + " Do not force-quit it, or the session may be lost.",
  );
  options.log(`Waiting up to ${SIGN_IN_TIMEOUT_MS / 60_000} minutes for the window to close...`);
  try {
    const result = await waitForExit(chrome, SIGN_IN_TIMEOUT_MS);
    if (!result) {
      options.log("Login timed out.");
      throw new Error(`Timed out waiting for login: the sign-in window was not closed within ${SIGN_IN_TIMEOUT_MS / 60_000} minutes.`);
    }
    if (Date.now() - startedAt < 3000 && result.code !== 0) {
      throw new Error(`Chrome exited immediately (${result.signal ?? `code ${result.code}`}); the sign-in window could not be opened.`);
    }
    options.log("Sign-in window closed. Checking the session...");
  } finally {
    await stopChrome(chrome);
  }
}

/** Phase 2: reopen the profile with DevTools, load only the dashboard, and read cookies. */
async function captureSession(profile: string, headless: boolean, options: LoginOptions): Promise<Cookie[]> {
  fs.rmSync(path.join(profile, "DevToolsActivePort"), { force: true });
  const chrome = await launchChrome([
    ...commonChromeArgs(profile),
    "--remote-debugging-port=0",
    // Only the Learning Mall host resolves, so tabs Chrome restores from the
    // sign-in window can never reach SSO from this DevTools-enabled browser.
    `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${new URL(BASE_URL).hostname}`,
    ...(headless ? ["--headless=new"] : []),
    "about:blank",
  ]);
  const exited = waitForExit(chrome, Number.POSITIVE_INFINITY).then(() => {
    throw new Error("Chrome exited while the session was being checked; run login again.");
  });
  exited.catch(() => {});
  let browser: Browser | undefined;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Timed out waiting for login: the session check did not finish.")), VERIFY_TIMEOUT_MS);
  });
  timeout.catch(() => {});
  try {
    const work = (async () => {
      browser = await connectWhenReady(path.join(profile, "DevToolsActivePort"));
      return verifyAndCollect(browser, options);
    })();
    return await Promise.race([work, exited, timeout]);
  } finally {
    clearTimeout(timer);
    if (browser) await browser.disconnect().catch(() => {});
    await stopChrome(chrome);
  }
}

async function verifyAndCollect(browser: Browser, options: LoginOptions): Promise<Cookie[]> {
  const page = await browser.newPage();
  // Close tabs restored from the sign-in window so only the dashboard is loaded.
  for (const other of await browser.pages()) {
    if (other !== page) await other.close().catch(() => {});
  }
  let blocked: string | undefined;
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    let host = "";
    try {
      host = new URL(request.url()).host;
    } catch {
      // Non-URL requests (data:, about:) are left alone below.
    }
    if (request.isNavigationRequest() && request.url().startsWith("http") && host !== SITE_HOST) {
      // Never load the SSO page from a DevTools-controlled browser.
      blocked = request.url();
      void request.abort().catch(() => {});
      return;
    }
    void request.continue().catch(() => {});
  });
  try {
    await page.goto(`${BASE_URL}/my/`, { waitUntil: "load", timeout: VERIFY_TIMEOUT_MS });
  } catch (error) {
    if (blocked) throw new SignInIncompleteError("redirected to sign-in");
    throw error;
  }
  if (blocked) throw new SignInIncompleteError("redirected to sign-in");
  await waitForLogin(page, options);
  const cookies = await collectCookies(page);
  if (!cookies.some((cookie) => cookie.name === "MoodleSession")) {
    throw new SignInIncompleteError("no MoodleSession cookie");
  }
  return cookies;
}

async function launchChrome(args: string[]): Promise<ChromeProcess> {
  const child = spawn(CHROME_PATH, args, { stdio: "ignore" });
  liveChromes.add(child);
  child.once("exit", () => liveChromes.delete(child));
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } catch (error) {
    liveChromes.delete(child);
    throw error;
  }
  return child;
}

/** Resolves with the exit status, or `undefined` if `ms` elapses first. */
function waitForExit(
  chrome: ChromeProcess,
  ms: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null } | undefined> {
  if (chrome.exitCode !== null || chrome.signalCode !== null) {
    return Promise.resolve({ code: chrome.exitCode, signal: chrome.signalCode });
  }
  return new Promise((resolve) => {
    const timer = Number.isFinite(ms)
      ? setTimeout(() => {
          chrome.off("exit", onExit);
          resolve(undefined);
        }, ms)
      : undefined;
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    chrome.once("exit", onExit);
  });
}

/** Terminates a Chrome process and waits for it to exit before profile cleanup. */
async function stopChrome(chrome: ChromeProcess): Promise<void> {
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
  throw new ChromeStuckError();
}

/** Polls Chrome's DevTools port until the browser is ready to accept connections. */
async function connectWhenReady(portFile: string): Promise<Browser> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const port = Number(fs.readFileSync(portFile, "utf8").split("\n", 1)[0]);
      if (Number.isInteger(port) && port > 0 && port <= 65_535) {
        return await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
      }
      throw new Error("Chrome did not report a valid debugging port.");
    } catch (error) {
      lastError = error;
      await delay(300);
    }
  }
  throw new Error(`Chrome did not open its debugging port. ${String(lastError)}`);
}

/** Confirms the dashboard is a fully loaded Moodle page with an authenticated user menu. */
async function waitForLogin(page: Page, options: LoginOptions): Promise<void> {
  const deadline = Date.now() + 15_000;
  const origin = new URL(BASE_URL).origin;
  while (Date.now() < deadline) {
    const url = page.url();
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      // Treated as not signed in below.
    }
    if (host !== SITE_HOST || isLoginUrl(url)) throw new SignInIncompleteError("redirected to sign-in");
    try {
      const authenticated = await page.evaluate((expectedUrl: string, expectedOrigin: string) => {
        if (location.href !== expectedUrl || location.origin !== expectedOrigin || document.readyState !== "complete") return false;
        if (document.body?.classList.contains("notloggedin") || document.querySelector('form#login, form[action*="/login/"], input[type="password"]')) return false;
        const menu = document.querySelector(".usermenu");
        if (!menu?.querySelector("#user-menu-toggle, .userbutton")) return false;
        return [...menu.querySelectorAll<HTMLAnchorElement>("a[href]")].some((link) => {
          const target = new URL(link.href, location.href);
          return target.origin === expectedOrigin && target.pathname.endsWith("/login/logout.php");
        });
      }, url, origin);
      if (authenticated && page.url() === url) return;
    } catch {
      // A late navigation can replace the execution context between checks.
    }
    await delay(1000);
  }
  options.log("Learning Mall did not show a signed-in dashboard.");
  throw new SignInIncompleteError("not signed in");
}

/** Reads cookies scoped to the configured Moodle host (and XJTLU SSO when applicable). */
async function collectCookies(page: Page): Promise<Cookie[]> {
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
