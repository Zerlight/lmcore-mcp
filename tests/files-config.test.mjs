import assert from "node:assert/strict";
import { after, mock, test } from "node:test";

const origin = "https://parser.moodle.test";
process.env.LMCORE_URL = origin;
const bytes = Buffer.from("PDF parser contract fixture");
const extractions = [];
let parserResult;
let closed = 0;

const parserMock = mock.module("@xberg-io/xberg", {
  exports: {
    ExtractInputKind: { Bytes: "bytes" },
    extract: async (input, config) => {
      extractions.push({ input, config });
      if (parserResult instanceof Error) throw parserResult;
      return parserResult;
    },
  },
});
const page = { evaluate: (callback, ...args) => callback(...args) };
const sessionMock = mock.module(new URL("../build/session.js", import.meta.url), {
  exports: {
    openSession: async () => ({ browser: { close: async () => { closed += 1; } }, page }),
    gotoAuthed: async () => {},
    SessionExpiredError: class extends Error {},
  },
});
const fetchMock = mock.method(globalThis, "fetch", async () => ({
  status: 200,
  url: `${origin}/pluginfile.php/1/course/guide.pdf`,
  headers: new Headers({ "content-type": "application/pdf" }),
  arrayBuffer: async () => Uint8Array.from(bytes).buffer,
}));
after(() => {
  fetchMock.mock.restore();
  sessionMock.restore();
  parserMock.restore();
});
const { readFiles } = await import("../build/files.js");
const url = `${origin}/mod/resource/view.php?id=1`;

test("document parsing passes bytes locally and disables model and cache features", async () => {
  parserResult = { results: [{ content: "# Native text", counts: { pages: 3 }, metadata: { pages: { totalCount: 2 } } }] };
  const beforeClosed = closed;
  const result = await readFiles(url);
  const { input, config } = extractions.at(-1);

  assert.equal(input.kind, "bytes");
  assert.deepEqual(input.bytes, bytes);
  assert.equal(input.uri, undefined);
  assert.equal(config.disableOcr, true);
  assert.equal(config.useCache, false);
  for (const feature of ["ocr", "layout", "chunking", "transcription", "structuredExtraction", "captioning"]) {
    assert.equal(config[feature], undefined, `${feature} must remain disabled`);
  }
  assert.equal(config.postprocessor.enabled, false);
  assert.equal(config.maxArchiveDepth, 0);
  assert.equal(result.files[0].pages, 3);
  assert.equal(result.files[0].text, "# Native text");
  assert.equal(closed - beforeClosed, 1);
});

test("parser warnings remain visible in the file note", async () => {
  parserResult = {
    results: [{ content: "Native text", processingWarnings: [{ source: "pdf", message: "A malformed font was skipped." }] }],
  };
  const result = await readFiles(url);
  assert.match(result.files[0].note, /A malformed font was skipped\./);
});

test("parser errors and missing results reject and close the browser session", async () => {
  for (const [result, message] of [
    [{ errors: [{ message: "Invalid PDF structure" }] }, /Cannot extract guide\.pdf: Invalid PDF structure/],
    [{ results: [] }, /No extraction result for guide\.pdf/],
    [new Error("Native parser rejected"), /Native parser rejected/],
  ]) {
    parserResult = result;
    const beforeClosed = closed;
    await assert.rejects(readFiles(url), message);
    assert.equal(closed - beforeClosed, 1);
  }
});
