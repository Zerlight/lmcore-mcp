import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import puppeteer from "puppeteer-core";

const origin = "https://files.moodle.test";
process.env.LMCORE_URL = origin;
const { CHROME_PATH } = await import("../build/config.js");
let browser;
let closedPages = 0;
const requests = [];
const navigations = [];
const fixtureText = "Real Chrome attachment text.";
const fixtureFile = `${origin}/pluginfile.php/4/fixture.txt?forcedownload=1`;
const fixtures = new Map([
  [`${origin}/my/`, { contentType: "text/html", body: "<h1>Local test fixture</h1>" }],
  [`${origin}/mod/resource/view.php?id=1`, { status: 302, headers: { location: fixtureFile } }],
  [fixtureFile, {
    contentType: "text/plain", body: fixtureText,
    headers: { "content-disposition": 'attachment; filename="fixture.txt"' },
  }],
  [`${origin}/mod/resource/view.php?id=2`, {
    contentType: "text/html",
    body: `<h1>Embedded fixture</h1>
      <nav><a href="/mod/resource/view.php?id=100">Previous resource</a>
      <a href="/mod/resource/view.php?id=102">Next resource</a></nav>
      <a href="https://unrelated.test/pluginfile.php/4/private.txt">Foreign file</a>
      <object data="/pluginfile.php/4/fixture.txt?forcedownload=1"></object>
      <iframe src="/pluginfile.php/4/fixture.txt?forcedownload=1"></iframe>`,
  }],
  [`${origin}/mod/resource/view.php?id=3`, {
    contentType: "text/html", body: '<form id="login" action="/login/index.php"><input type="password"></form>',
  }],
]);

class SessionExpiredError extends Error {}
mock.module(new URL("../build/session.js", import.meta.url), {
  exports: {
    SessionExpiredError,
    openSession: async () => {
      const page = await browser.newPage();
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        requests.push(request.url());
        // Every browser request is fulfilled locally; no Moodle host or credentials are used.
        const response = fixtures.get(request.url()) ?? { status: 404, body: "Unknown fixture" };
        void request.respond(response);
      });
      const goto = page.goto.bind(page);
      page.goto = (url, options) => {
        navigations.push(url);
        return goto(url, options);
      };
      return {
        page,
        browser: { close: async () => { await page.close(); closedPages += 1; } },
      };
    },
    gotoAuthed: async (page, url) => { await page.goto(new URL(url, origin).href); },
  },
});
const { readFiles } = await import("../build/files.js");

before(async () => {
  browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-first-run", "--disable-sync"],
  });
});
after(async () => { await browser?.close(); });

test("real Chrome reads a redirect to an attachment without attachment navigation", async () => {
  const firstRequest = requests.length;
  const firstNavigation = navigations.length;
  const firstClosed = closedPages;
  const result = await readFiles(`${origin}/mod/resource/view.php?id=1`);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].name, "fixture.txt");
  assert.equal(result.files[0].text, fixtureText);
  assert.equal(result.files[0].bytes, Buffer.byteLength(fixtureText));
  assert.deepEqual(navigations.slice(firstNavigation), [`${origin}/my/`]);
  assert.equal(requests.slice(firstRequest).filter((url) => url === fixtureFile).length, 1);
  assert.equal(closedPages - firstClosed, 1);
});

test("real Chrome reads embedded files and ignores neighboring activities and foreign links", async () => {
  const firstRequest = requests.length;
  const result = await readFiles(`${origin}/mod/resource/view.php?id=2`);
  assert.equal(result.activity, "Embedded fixture");
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].name, "fixture.txt");
  assert.equal(result.files[0].text, fixtureText);
  const fetched = requests.slice(firstRequest);
  assert.equal(fetched.filter((url) => url === fixtureFile).length, 1);
  assert.ok(fetched.every((url) => !url.includes("unrelated.test") && !url.includes("id=100") && !url.includes("id=102")));
});

test("real Chrome reports a login form returned at the original resource URL as expired", async () => {
  const firstClosed = closedPages;
  await assert.rejects(readFiles(`${origin}/mod/resource/view.php?id=3`), SessionExpiredError);
  assert.equal(closedPages - firstClosed, 1);
});
