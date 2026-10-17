import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createSecureServer } from "node:http2";
import os from "node:os";
import path from "node:path";
import { after, before, mock, test } from "node:test";
import puppeteer from "puppeteer-core";

const origin = "https://login.moodle.test";
process.env.LMCORE_URL = origin;
const config = await import("../build/config.js");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lmcore-login-browser-test-"));
let loginPredicate;
let loginArguments;
let chromeArguments;
let browser;
let page;
const authenticatedMenu = `<div class="usermenu">
  <a id="user-menu-toggle" href="#">Student</a>
  <div class="dropdown-menu"><a href="/login/logout.php?sesskey=fixture">Log out</a></div>
</div>`;

mock.module(new URL("../build/config.js", import.meta.url), {
  exports: { ...config, SESSION_PATH: path.join(directory, "session.json") },
});
mock.module("puppeteer-core", {
  exports: {
    default: {
      connect: async () => ({
        pages: async () => [{
          url: () => `${origin}/my/`,
          evaluate: async (predicate, ...args) => {
            loginPredicate = predicate;
            loginArguments = args;
            return true;
          },
          createCDPSession: async () => ({
            send: async () => ({ cookies: [{ name: "MoodleSession", domain: "login.moodle.test", value: "fixture", path: "/" }] }),
          }),
        }],
        disconnect: async () => {},
      }),
    },
  },
});
mock.module("node:child_process", {
  exports: {
    spawn: (_executable, args) => {
      chromeArguments = args;
      const child = new EventEmitter();
      child.pid = 12345;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = (signal) => {
        queueMicrotask(() => { child.signalCode = signal; child.emit("exit", null, signal); });
        return true;
      };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  },
});

before(async () => {
  const { interactiveLogin } = await import("../build/session.js?login-browser-test");
  await interactiveLogin({ log: () => {} });
  assert.equal(typeof loginPredicate, "function");
  assert.ok(chromeArguments.includes("--disable-http2"));
  browser = await puppeteer.launch({
    executablePath: config.CHROME_PATH,
    headless: true,
    args: ["--no-first-run", "--disable-sync", "--ignore-certificate-errors",
      ...chromeArguments.filter((arg) => arg === "--disable-http2")],
  });
  page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    // Every request is fulfilled locally; no Moodle host or credentials are used.
    void request.respond({ contentType: "text/html", body: "<body></body>" });
  });
  await page.goto(`${origin}/my/`, { waitUntil: "load" });
});

after(async () => {
  await browser?.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function authenticated(html) {
  await page.setContent(html, { waitUntil: "load" });
  return page.evaluate(loginPredicate, ...loginArguments);
}

test("login Chrome uses HTTP/1.1 while default Chrome negotiates HTTP/2", { timeout: 20_000 }, async () => {
  const keyPath = path.join(directory, "localhost.key");
  const certificatePath = path.join(directory, "localhost.crt");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certificatePath, "-subj", "/CN=localhost", "-days", "1",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore", timeout: 5_000 });
  const server = createSecureServer({
    key: fs.readFileSync(keyPath), cert: fs.readFileSync(certificatePath), allowHTTP1: true,
  }, (request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(request.httpVersion);
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  let controlBrowser;
  let loginPage;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const url = `https://127.0.0.1:${server.address().port}/`;
    controlBrowser = await puppeteer.launch({
      executablePath: config.CHROME_PATH, headless: true, timeout: 5_000,
      args: ["--ignore-certificate-errors"],
    });
    const controlPage = await controlBrowser.newPage();
    await controlPage.goto(url, { waitUntil: "load", timeout: 3_000 });
    assert.equal(await controlPage.evaluate(() => document.body.textContent), "2.0");
    loginPage = await browser.newPage();
    await loginPage.goto(url, { waitUntil: "load", timeout: 3_000 });
    assert.equal(await loginPage.evaluate(() => document.body.textContent), "1.1");
  } finally {
    await loginPage?.close();
    await controlBrowser?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("real Chrome rejects a guest menu even when Moodle exposes a positive guest user ID", async () => {
  assert.equal(await authenticated(`<body class="notloggedin">
    <script>window.M = { cfg: { userId: 1 } };</script>
    <div class="usermenu"><a id="user-menu-toggle" href="#">Guest</a>
      <a href="/login/index.php">Log in</a></div>
  </body>`), false);
  assert.equal(await authenticated(`<body class="notloggedin">${authenticatedMenu}</body>`), false);
});

test("real Chrome rejects a login form returned at the dashboard URL", async () => {
  assert.equal(await authenticated(`<body>${authenticatedMenu}
    <form id="login" action="/login/index.php"><input name="username"><input type="password"></form>
  </body>`), false);
});

test("real Chrome rejects a loading document despite an authenticated menu", async () => {
  await page.setContent(`<body>${authenticatedMenu}</body>`, { waitUntil: "load" });
  await page.evaluate(() => {
    Object.defineProperty(document, "readyState", { configurable: true, get: () => "loading" });
  });
  try {
    assert.equal(await page.evaluate(loginPredicate, ...loginArguments), false);
  } finally {
    await page.evaluate(() => { delete document.readyState; });
  }
});

test("real Chrome rejects foreign and unrelated logout links", async () => {
  assert.equal(await authenticated(`<body><div class="usermenu">
    <a id="user-menu-toggle" href="#">Student</a>
    <a href="https://foreign.test/login/logout.php">Log out</a>
  </div></body>`), false);
  assert.equal(await authenticated(`<body><div class="usermenu">
    <a id="user-menu-toggle" href="#">Guest</a></div>
    <a href="/login/logout.php">Log out</a>
  </body>`), false);
});

test("real Chrome accepts a complete authenticated user menu without relying on a user ID", async () => {
  assert.equal(await authenticated(`<body class="loggedin">${authenticatedMenu}</body>`), true);
});
