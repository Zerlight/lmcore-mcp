import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, mock, test } from "node:test";

const origin = "https://files.moodle.test";
process.env.LMCORE_URL = origin;
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "lmcore-files-test-"));
const testOs = { ...os, homedir: () => testHome };
const osMock = mock.module("node:os", { exports: { ...testOs, default: testOs } });
const responses = new Map();
const requests = [];
let closed = 0;
class SessionExpiredError extends Error {}
const page = {
  goto() { throw new Error("Attachment downloads must not use page.goto()."); },
  evaluate(callback, ...args) { return callback(...args); },
};
mock.module(new URL("../build/session.js", import.meta.url), {
  exports: {
    openSession: async () => ({ browser: { close: async () => { closed += 1; } }, page }),
    gotoAuthed: async (actualPage, url) => {
      assert.equal(actualPage, page);
      assert.equal(url, "/my/");
    },
    SessionExpiredError,
  },
});
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  requests.push({ url, options });
  const fixture = responses.get(url);
  assert.ok(fixture, `Unexpected file request: ${url}`);
  return {
    status: fixture.status ?? 200,
    url: fixture.url ?? url,
    headers: new Headers({ "content-type": fixture.mime ?? "text/plain", ...fixture.headers }),
    arrayBuffer: async () => Uint8Array.from(fixture.data ?? Buffer.from("hello")).buffer,
  };
};
after(() => {
  globalThis.fetch = originalFetch;
  osMock.restore();
  fs.rmSync(testHome, { recursive: true, force: true });
});
const { readFiles } = await import("../build/files.js");

function resource(id, fixture) {
  const url = `${origin}/mod/resource/view.php?id=${id}`;
  responses.set(url, fixture);
  return url;
}

test("attachment redirects are fetched once with browser credentials, without navigation", async () => {
  const url = resource(1, {
    url: `${origin}/pluginfile.php/4/course/handbook.txt?forcedownload=1`,
    headers: { "content-disposition": "attachment; filename*=UTF-8''course%20handbook.txt" },
    data: Buffer.from("Read this handbook."),
  });
  const count = requests.length;
  const beforeClosed = closed;
  const result = await readFiles(url);
  assert.equal(result.activity, "course handbook.txt");
  assert.deepEqual(result.files[0], {
    name: "course handbook.txt", mime: "text/plain", bytes: 19,
    pages: undefined, text: "Read this handbook.", note: undefined,
  });
  assert.equal(requests.length - count, 1);
  assert.deepEqual(requests.at(-1).options, {
    redirect: "follow", credentials: "same-origin", mode: "same-origin",
  });
  assert.equal(closed - beforeClosed, 1);
});

test("same-host login redirects and authorization failures report an expired session", async () => {
  for (const [id, fixture] of [
    [2, { url: `${origin}/login/index.php`, mime: "text/html" }],
    [3, { status: 401 }],
    [4, { status: 403 }],
  ]) {
    const beforeClosed = closed;
    await assert.rejects(readFiles(resource(id, fixture)), SessionExpiredError);
    assert.equal(closed - beforeClosed, 1);
  }
});

test("attachments can be saved with the requested filename and original bytes", async () => {
  const bytes = Buffer.from([0, 1, 2, 255, 10]);
  const url = resource(9, {
    url: `${origin}/pluginfile.php/4/material.bin`, data: bytes,
    mime: "application/octet-stream", headers: { "content-disposition": 'attachment; filename="course material.bin"' },
  });
  const result = await readFiles(url, true);
  assert.equal(result.files[0].name, "course material.bin");
  assert.equal(result.files[0].text, "");
  assert.equal(path.basename(result.files[0].savedTo), "course material.bin");
  assert.equal(result.files[0].savedTo.startsWith(testHome + path.sep), true);
  assert.deepEqual(fs.readFileSync(result.files[0].savedTo), bytes);
});

test("only configured-origin resource URLs are accepted and HTTP errors remain errors", async () => {
  for (const url of [
    "https://unrelated.test/mod/resource/view.php?id=1",
    "http://files.moodle.test/mod/resource/view.php?id=1",
    `${origin}/pluginfile.php/4/file.txt`,
  ]) {
    await assert.rejects(readFiles(url), /Only resource links/);
  }
  await assert.rejects(readFiles(resource(5, { status: 404 })), /HTTP 404/);
  await assert.rejects(readFiles(resource(6, { url: "https://unrelated.test/file.txt" })), /outside the configured Moodle site/);
});

test("PPTX uses the presentation relationship order rather than lexical or numeric filenames", async () => {
  const order = [4, 1, 12, 2, 10, 3, 11, 5, 9, 7, 6, 8];
  const result = await readFiles(resource(7, {
    url: `${origin}/pluginfile.php/4/slides.pptx`,
    data: fs.readFileSync(new URL("./fixtures/relationship-order.pptx", import.meta.url)),
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  }));
  assert.equal(result.files[0].pages, 12);
  assert.deepEqual([...result.files[0].text.matchAll(/SlideToken(\d+)/g)].map((match) => Number(match[1])), order);
  assert.equal(result.files[0].note, undefined);
});

test("DOCX preserves spaces between runs, leading zeros, and whitespace-only runs", async () => {
  const result = await readFiles(resource(8, {
    url: `${origin}/pluginfile.php/4/notes.docx`,
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    data: fs.readFileSync(new URL("./fixtures/structured.docx", import.meta.url)),
  }));
  assert.match(result.files[0].text, /Hello world/);
  assert.match(result.files[0].text, /\b00123\b/);
  assert.match(result.files[0].text, /A B/);
  assert.equal(result.files[0].note, undefined);
});

test("DOCX keeps headings and table cells in Markdown", async () => {
  const result = await readFiles(resource(10, {
    url: `${origin}/pluginfile.php/4/guide.docx`,
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    data: fs.readFileSync(new URL("./fixtures/structured.docx", import.meta.url)),
  }));
  assert.match(result.files[0].text, /^# Course guide$/m);
  assert.match(result.files[0].text, /\|\s*Topic\s*\|\s*Week\s*\|/);
  assert.match(result.files[0].text, /\|\s*Circuits\s*\|\s*01\s*\|/);
});

test("PDF extracts native text and retains its page count", async () => {
  const result = await readFiles(resource(11, {
    url: `${origin}/pluginfile.php/4/guide.pdf`,
    mime: "application/pdf",
    data: fs.readFileSync(new URL("./fixtures/native-text.pdf", import.meta.url)),
  }));
  assert.equal(result.files[0].pages, 2);
  assert.match(result.files[0].text, /First native PDF page/);
  assert.match(result.files[0].text, /Second native PDF page 00123/);
  assert.equal(result.files[0].note, undefined);
});

test("image-only PDF returns no text with OCR disabled", { timeout: 10_000 }, async () => {
  const result = await readFiles(resource(12, {
    url: `${origin}/pluginfile.php/4/scan.pdf`,
    mime: "application/pdf",
    data: fs.readFileSync(new URL("./fixtures/image-only.pdf", import.meta.url)),
  }));
  assert.equal(result.files[0].pages, 1);
  assert.equal(result.files[0].text.trim(), "");
  assert.match(result.files[0].note, /no.*text|text.*layer|OCR.*disabled/i);
});

test("corrupt documents report extraction failures and close the browser session", async () => {
  for (const [id, name, mime] of [
    [13, "broken.pdf", "application/pdf"],
    [14, "broken.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    [15, "broken.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ]) {
    const beforeClosed = closed;
    await assert.rejects(readFiles(resource(id, {
      url: `${origin}/pluginfile.php/4/${name}`, mime, data: Buffer.from("not a document"),
    })), /extract|parse|invalid|corrupt|PDF|archive/i);
    assert.equal(closed - beforeClosed, 1);
  }
});

test("long text is capped with an explicit truncation note", async () => {
  const result = await readFiles(resource(16, {
    url: `${origin}/pluginfile.php/4/long.txt`,
    mime: "text/plain", data: Buffer.from("x".repeat(60_001)),
  }));
  assert.equal(result.files[0].text.length, 60_000);
  assert.match(result.files[0].note, /truncat|60,?000|limit/i);
});
