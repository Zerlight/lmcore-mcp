import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "puppeteer-core";
import { extract, ExtractInputKind } from "@xberg-io/xberg";
import { BASE_URL, isLoginUrl } from "./config.js";
import { orderSlides } from "./pptx.js";
import { gotoAuthed, openSession, SessionExpiredError } from "./session.js";

/** Path pattern for Moodle file resource activities. */
const RESOURCE_PATH = /^\/mod\/resource\/view\.php$/;
const SITE_ORIGIN = new URL(BASE_URL).origin;

export interface CourseFile {
  name: string;
  mime: string;
  bytes: number;
  /** Page or slide count for PDF and PowerPoint files, when available. */
  pages?: number;
  /** Extracted Markdown or plain text content (empty when `download: true`). */
  text: string;
  /** Warnings, extraction limitations, or truncation details. */
  note?: string;
  /** Absolute local path when `download: true` was requested. */
  savedTo?: string;
}

export interface FileReadResult {
  /** Activity title or resolved filename. */
  activity: string;
  files: CourseFile[];
}

/** User-local directory where downloaded source files are saved. */
const DOWNLOAD_DIR = path.join(os.homedir(), ".config", "lmcore-mcp", "downloads");

/**
 * Fetches and parses the files behind a Moodle `mod/resource` activity URL.
 *
 * Resource links either redirect directly to a file or render an intermediate
 * wrapper page containing embedded `/pluginfile.php/` URLs.
 */
export async function readFiles(url: string, download = false): Promise<FileReadResult> {
  const activity = parseActivityUrl(url);
  const { browser, page } = await openSession();
  try {
    await gotoAuthed(page, "/my/");
    const target = await resolveFiles(page, activity);
    const files: CourseFile[] = [];
    for (const file of target.files) files.push(await downloadFile(page, file, download));
    return { activity: target.activity, files };
  } finally {
    await browser.close();
  }
}

function parseActivityUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Not a valid URL. Pass a resource URL from lmcore_course_contents.");
  }
  if (parsed.origin !== SITE_ORIGIN || !RESOURCE_PATH.test(parsed.pathname)) {
    const folder = parsed.origin === SITE_ORIGIN && parsed.pathname === "/mod/folder/view.php";
    throw new Error(
      folder
        ? "Folder activities (/mod/folder/view.php) are not supported. Open the folder in a browser; this tool only accepts resource URLs (/mod/resource/view.php) from lmcore_course_contents."
        : "Only resource links on Learning Mall Core can be read. Pass a resource URL from lmcore_course_contents.",
    );
  }
  return parsed;
}

interface ResolvedFile {
  name: string;
  url: string;
  fetched?: FetchedFile;
}

/** Resolves a `mod/resource` URL to one or more underlying `/pluginfile.php/` files. */
async function resolveFiles(page: Page, activity: URL): Promise<{ activity: string; files: ResolvedFile[] }> {
  // Use in-page `fetch` instead of `page.goto`, which aborts on `Content-Disposition: attachment`.
  const fetched = await fetchFile(page, activity.toString());

  if (
    new URL(fetched.finalUrl).pathname.includes("/pluginfile.php/") ||
    fetched.disposition ||
    !fetched.mime.toLowerCase().startsWith("text/html")
  ) {
    const name = downloadName(fetched);
    return { activity: name, files: [{ name, url: fetched.finalUrl, fetched }] };
  }

  // Some resources render an HTML wrapper that embeds the file via <a>, <object>, <embed>, or <iframe>.
  const listing = await page.evaluate((html: string, baseUrl: string) => {
    const document = new DOMParser().parseFromString(html, "text/html");
    const seen = new Set<string>();
    const found: { name: string; url: string }[] = [];
    for (const link of document.querySelectorAll("a[href], object[data], embed[src], iframe[src]")) {
      const value = link.getAttribute("href") ?? link.getAttribute("data") ?? link.getAttribute("src");
      if (!value) continue;
      let target: URL;
      try {
        target = new URL(value, baseUrl);
      } catch {
        continue;
      }
      if (target.origin !== new URL(baseUrl).origin) continue;
      if (!target.pathname.includes("/pluginfile.php/")) continue;
      if (target.href === baseUrl || seen.has(target.href)) continue;
      seen.add(target.href);
      const name = link.textContent?.replace(/\s+/g, " ").trim() ?? "";
      found.push({ name, url: target.href });
    }
    return {
      activity: document.querySelector("h1, h2")?.textContent?.trim() ?? "",
      files: found,
      login: Boolean(document.querySelector('form#login, form[action*="/login/"], input[type="password"]')),
    };
  }, Buffer.from(fetched.base64, "base64").toString("utf8"), fetched.finalUrl);
  if (listing.login) throw new SessionExpiredError();
  if (!listing.files.length) throw new Error("The resource page contains no readable files.");
  return listing;
}

const TEXT_LIMIT = 60_000;

interface FetchedFile {
  status: number;
  mime: string;
  disposition: string;
  finalUrl: string;
  base64: string;
}

async function fetchFile(page: Page, url: string): Promise<FetchedFile> {
  if (new URL(url).origin !== SITE_ORIGIN) throw new Error("Files must be on the configured Moodle site.");
  const fetched = await page.evaluate(async (fileUrl: string) => {
    const response = await fetch(fileUrl, { redirect: "follow", credentials: "same-origin", mode: "same-origin" });
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return {
      status: response.status,
      mime: response.headers.get("content-type") ?? "",
      disposition: response.headers.get("content-disposition") ?? "",
      finalUrl: response.url,
      base64: btoa(binary),
    };
  }, url);

  if (fetched.status === 401 || fetched.status === 403 || isLoginUrl(fetched.finalUrl)) throw new SessionExpiredError();
  if (fetched.status >= 400) throw new Error(`Fetching ${url} returned HTTP ${fetched.status}.`);
  if (new URL(fetched.finalUrl).origin !== SITE_ORIGIN) throw new Error("The file redirected outside the configured Moodle site.");
  return fetched;
}

async function downloadFile(page: Page, file: ResolvedFile, download: boolean): Promise<CourseFile> {
  const fetched = file.fetched ?? await fetchFile(page, file.url);
  const data = Buffer.from(fetched.base64, "base64");
  const name = file.name || downloadName(fetched);
  const mime = fetched.mime.split(";")[0].trim();
  if (download) {
    return { name, mime, bytes: data.length, text: "", savedTo: saveFile(name, data) };
  }
  const extracted = await extractByType(data, name, mime);
  return {
    name,
    mime,
    bytes: data.length,
    pages: extracted.pages,
    text: extracted.text.slice(0, TEXT_LIMIT),
    note: [
      extracted.note,
      extracted.text.length > TEXT_LIMIT ? `Text truncated to ${TEXT_LIMIT.toLocaleString("en-US")} characters. Use download: true to read the complete source file.` : undefined,
    ].filter(Boolean).join(" ") || undefined,
  };
}

function downloadName(file: FetchedFile): string {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(file.disposition)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // Fall back to the plain filename parameter or URL path if percent-decoding fails.
    }
  }
  const plain = /filename=(?:"([^"]+)"|([^;]+))/i.exec(file.disposition);
  return (plain?.[1] ?? plain?.[2])?.trim() || fileName(file.finalUrl);
}

/** Writes `data` to `DOWNLOAD_DIR`, appending `(n)` if a file with the same name already exists. */
function saveFile(name: string, data: Buffer): string {
  const safe = path.basename(name).replace(/[^\w.\- ()\[\]]+/g, "_") || "download";
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true, mode: 0o700 });
  const ext = path.extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  let target = path.join(DOWNLOAD_DIR, safe);
  for (let n = 2; fs.existsSync(target); n += 1) {
    target = path.join(DOWNLOAD_DIR, `${stem} (${n})${ext}`);
  }
  fs.writeFileSync(target, data, { mode: 0o600 });
  return target;
}

function fileName(url: string): string {
  const last = new URL(url).pathname.split("/").pop() ?? "";
  return decodeURIComponent(last);
}

interface Extracted {
  text: string;
  pages?: number;
  note?: string;
}

async function extractByType(data: Buffer, name: string, mime: string): Promise<Extracted> {
  const lower = name.toLowerCase();
  let documentMime: string;
  if (mime === "application/pdf" || lower.endsWith(".pdf")) documentMime = "application/pdf";
  else if (lower.endsWith(".pptx") || mime.includes("presentationml")) {
    documentMime = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  } else if (lower.endsWith(".docx") || mime.includes("wordprocessingml")) {
    documentMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  } else if (mime.startsWith("text/") || /\.(txt|md|csv)$/.test(lower)) {
    return { text: data.toString("utf8") };
  } else {
    return {
      text: "",
      note: `No text extractor for ${mime || "this file type"}. Use download: true to save the original file locally.`,
    };
  }

  // Parse in-memory bytes directly with OCR, caching, and model-backed features disabled.
  const result = await extract({
    kind: ExtractInputKind.Bytes,
    bytes: data,
    mimeType: documentMime,
    filename: name,
  }, {
    disableOcr: true,
    useCache: false,
    outputFormat: "markdown",
    useLayoutForMarkdown: false,
    postprocessor: { enabled: false },
    maxArchiveDepth: 0,
  });
  if (result.errors?.length) throw new Error(`Cannot extract ${name}: ${result.errors[0].message}`);
  const document = result.results?.[0];
  if (!document) throw new Error(`No extraction result for ${name}.`);

  const presentation = documentMime.includes("presentationml");
  const slides = presentation ? await orderSlides(data, document.pages ?? []) : undefined;
  const text = slides?.text ?? document.content ?? "";
  const pages = document.counts?.pages ?? document.metadata?.pages?.totalCount;
  const warnings = document.processingWarnings?.map((warning) => warning.message) ?? [];
  if (!text.trim()) warnings.push("No native text was extracted. OCR is disabled; use download: true to read the original file with a capable model or application.");
  return {
    text,
    pages: slides?.pages ?? (documentMime === "application/pdf" ? pages || undefined : undefined),
    note: warnings.join(" ") || undefined,
  };
}
