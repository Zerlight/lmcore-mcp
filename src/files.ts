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
/** Path pattern for Moodle folder activities. */
const FOLDER_PATH = /^\/mod\/folder\/view\.php$/;
const SITE_ORIGIN = new URL(BASE_URL).origin;

function isFolderContentPath(path: string): boolean {
  return /(?:^|\/)mod_folder\/content(?:\/|$)/.test(path);
}

/** True when `url` is a same-site pluginfile belonging to a folder activity. */
function isFolderFileUrl(url: URL): boolean {
  if (url.origin !== SITE_ORIGIN) return false;
  if (url.pathname.startsWith("/pluginfile.php/")) return isFolderContentPath(url.pathname);
  if (url.pathname === "/pluginfile.php") return isFolderContentPath(url.searchParams.get("file") ?? "");
  return false;
}

/** Relative path of a folder file inside the activity (decoded, no leading slash). */
export function folderFilePath(url: URL): string {
  const raw = url.pathname.startsWith("/pluginfile.php/")
    ? url.pathname
    : (url.searchParams.get("file") ?? "");
  const parts = raw.split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  const index = parts.findIndex((part, i) => part === "mod_folder" && parts[i + 1] === "content");
  if (index === -1) return parts.at(-1) ?? "";
  return parts.slice(index + 3).join("/");
}

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

export interface FolderEntry {
  name: string;
  /** Path of the file inside the folder, including any subdirectories. */
  path: string;
  url: string;
  /** Human-readable size when Moodle shows it on the folder page. */
  size?: string;
}

export interface FolderListing {
  /** Folder activity title. */
  activity: string;
  files: FolderEntry[];
  /** "Download folder" zip URL, when Moodle exposes one. */
  downloadUrl?: string;
}

/** User-local directory where downloaded source files are saved. */
const DOWNLOAD_DIR = path.join(os.homedir(), ".config", "lmcore-mcp", "downloads");

/**
 * Fetches and parses a Moodle `mod/resource` activity or a file from a
 * `mod/folder` listing (`/pluginfile.php/.../mod_folder/content/...`).
 *
 * Resource links either redirect directly to a file or render an intermediate
 * wrapper page containing embedded `/pluginfile.php/` URLs.
 */
export async function readFiles(url: string, download = false): Promise<FileReadResult> {
  const target = parseReadUrl(url);
  const { browser, page } = await openSession();
  try {
    await gotoAuthed(page, "/my/");
    if (target.kind === "folderFile") {
      const fetched = await fetchFile(page, target.url.toString());
      const name = downloadName(fetched) || folderFilePath(target.url).split("/").pop() || "download";
      return { activity: name, files: [await downloadFile(page, { name, url: target.url.toString(), fetched }, download)] };
    }
    const resolved = await resolveFiles(page, target.url);
    const files: CourseFile[] = [];
    for (const file of resolved.files) files.push(await downloadFile(page, file, download));
    return { activity: resolved.activity, files };
  } finally {
    await browser.close();
  }
}

/**
 * Lists the files in a Moodle `mod/folder` activity by URL or course-module id.
 * Does not download file contents; pass a returned file URL to `readFiles`.
 */
export async function listFolder(input: { url?: string; id?: number }): Promise<FolderListing> {
  const activity = parseFolderUrl(input);
  const { browser, page } = await openSession();
  try {
    await gotoAuthed(page, "/my/");
    const fetched = await fetchFile(page, activity.toString());
    const html = Buffer.from(fetched.base64, "base64").toString("utf8");
    const listing = await page.evaluate((pageHtml: string, baseUrl: string, siteOrigin: string) => {
      const document = new DOMParser().parseFromString(pageHtml, "text/html");
      const sizePattern = /(\d+(?:[.,]\d+)?\s*(?:B|KB|MB|GB|KiB|MiB|GiB|bytes))\b/i;
      const seen = new Set<string>();
      const files: { name: string; url: string; size?: string }[] = [];
      for (const link of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
        let target: URL;
        try {
          target = new URL(link.href, baseUrl);
        } catch {
          continue;
        }
        if (target.origin !== siteOrigin) continue;
        const path = target.pathname.startsWith("/pluginfile.php/")
          ? target.pathname
          : (target.pathname === "/pluginfile.php" ? (target.searchParams.get("file") ?? "") : "");
        if (!/(?:^|\/)mod_folder\/content(?:\/|$)/.test(path)) continue;
        if (target.searchParams.has("preview")) continue;
        const href = target.href;
        if (seen.has(href)) continue;
        seen.add(href);
        const name = link.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const context = (link.closest("li, tr, .fp-filename-icon") ?? link.parentElement)?.textContent ?? "";
        const size = sizePattern.exec(context)?.[1]?.replace(/\s+/g, " ").trim();
        files.push({ name, url: href, size });
      }
      const download = document.querySelector<HTMLAnchorElement>('a[href*="/mod/folder/download_folder.php"], a[href*="/mod/folder/download.php"]')
        ?? document.querySelector<HTMLFormElement>('form[action*="/mod/folder/download_folder.php"], form[action*="/mod/folder/download.php"]');
      let downloadUrl: string | undefined;
      if (download) {
        try {
          const href = "href" in download && download.href
            ? download.href
            : (download as HTMLFormElement).action;
          const parsed = new URL(href, baseUrl);
          for (const input of download.querySelectorAll<HTMLInputElement>("input[type='hidden']")) {
            if (input.name && !parsed.searchParams.has(input.name)) parsed.searchParams.set(input.name, input.value);
          }
          if (parsed.origin === siteOrigin) downloadUrl = parsed.href;
        } catch {
          // Ignore malformed download buttons.
        }
      }
      const headingText = (selector: string) => {
        for (const element of document.querySelectorAll(selector)) {
          if (element.classList.contains("visually-hidden") || element.closest(".visually-hidden")) continue;
          const text = element.textContent?.replace(/\s+/g, " ").trim();
          if (text) return text;
        }
        return "";
      };
      return {
        activity: headingText("h1") || headingText(".page-header-headings") || headingText("h2"),
        files,
        downloadUrl,
        login: Boolean(document.querySelector('form#login, form[action*="/login/"], input[type="password"]')),
      };
    }, html, fetched.finalUrl, SITE_ORIGIN);
    if (listing.login) throw new SessionExpiredError();
    return {
      activity: listing.activity,
      files: listing.files.map((file) => {
        const parsed = new URL(file.url);
        const path = folderFilePath(parsed);
        return {
          name: file.name || path.split("/").pop() || path,
          path,
          url: file.url,
          size: file.size,
        };
      }),
      downloadUrl: listing.downloadUrl,
    };
  } finally {
    await browser.close();
  }
}

function parseReadUrl(url: string): { kind: "resource" | "folderFile"; url: URL } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Not a valid URL. Pass a resource URL from lmcore_course_contents, or a file URL from lmcore_folder.");
  }
  if (parsed.origin === SITE_ORIGIN && RESOURCE_PATH.test(parsed.pathname)) {
    return { kind: "resource", url: parsed };
  }
  if (isFolderFileUrl(parsed) && !parsed.searchParams.has("preview")) {
    return { kind: "folderFile", url: parsed };
  }
  if (parsed.origin === SITE_ORIGIN && FOLDER_PATH.test(parsed.pathname)) {
    throw new Error(
      "Folder activities are listed with lmcore_folder. Pass a file URL from that listing to lmcore_read_file.",
    );
  }
  throw new Error(
    "Only resource or folder file links on Learning Mall Core can be read. Pass a resource URL from lmcore_course_contents, or a file URL from lmcore_folder.",
  );
}

function parseFolderUrl(input: { url?: string; id?: number }): URL {
  if (input.url) {
    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      throw new Error("Not a valid URL. Pass a folder URL from lmcore_course_contents, or a folder id.");
    }
    if (parsed.origin !== SITE_ORIGIN || !FOLDER_PATH.test(parsed.pathname)) {
      throw new Error(
        "Only folder links on Learning Mall Core can be listed. Pass a folder URL (/mod/folder/view.php?id=...) from lmcore_course_contents, or the folder's course-module id.",
      );
    }
    const id = Number(parsed.searchParams.get("id") ?? 0);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error("The folder URL is missing a valid id parameter.");
    }
    if (input.id != null && input.id !== id) {
      throw new Error("The folder url and id refer to different activities.");
    }
    return parsed;
  }
  if (input.id != null) {
    if (!Number.isSafeInteger(input.id) || input.id <= 0) {
      throw new Error("Provide a positive folder course-module id.");
    }
    return new URL(`/mod/folder/view.php?id=${input.id}`, BASE_URL);
  }
  throw new Error("Provide a folder URL or id.");
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
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
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
