import assert from "node:assert/strict";
import { spawn as realSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

let moduleId = 0;

async function loadSession(t, {
  baseUrl = "https://moodle.example.edu:8443", cookies = [], spawn,
  evaluate = async () => true, url = () => `${baseUrl}/my/`, pages,
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lmcore-session-test-"));
  const sessionPath = path.join(directory, "session.json");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = { killed: false, disconnected: false, profile: undefined, connectCalls: 0, cookieReads: 0 };
  const page = {
    url,
    evaluate,
    createCDPSession: async () => ({ send: async () => {
      state.cookieReads++;
      return { cookies };
    } }),
  };
  t.mock.module(new URL("../build/config.js", import.meta.url).href, {
    exports: {
      BASE_URL: baseUrl,
      SITE_HOST: new URL(baseUrl).host,
      SESSION_PATH: sessionPath,
      CHROME_PATH: path.join(directory, "nonexistent-chrome"),
      isLoginUrl: () => false,
    },
  });
  t.mock.module("puppeteer-core", {
    exports: {
      default: {
        connect: async () => {
          state.connectCalls++;
          return {
            pages: pages ?? (async () => [page]),
            disconnect: async () => { state.disconnected = true; },
          };
        },
      },
    },
  });
  t.mock.module("node:child_process", {
    exports: {
      spawn: (executable, args, options) => {
        state.profile = args.find((arg) => arg.startsWith("--user-data-dir=")).split("=")[1];
        if (spawn) return spawn(executable, args, options);
        const child = new EventEmitter();
        child.pid = 12345;
        child.exitCode = null;
        child.signalCode = null;
        child.kill = (signal) => {
          state.killed = signal === "SIGTERM";
          queueMicrotask(() => {
            child.signalCode = signal;
            child.emit("exit", null, signal);
          });
          return true;
        };
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
    },
  });
  return {
    session: await import(`../build/session.js?test=${++moduleId}`),
    state,
    directory,
    sessionPath,
  };
}

function cookie(name, domain) {
  return { name, domain, value: "test-value", path: "/", expires: -1, httpOnly: true, secure: true };
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

test("login retains only cookies applicable to the configured Moodle host", async (t) => {
  const { session, state, sessionPath } = await loadSession(t, {
    cookies: [
      cookie("MoodleSession", "moodle.example.edu"),
      cookie("parent", ".example.edu"),
      cookie("hostOnlyParent", "example.edu"),
      cookie("unrelatedSibling", "other.example.edu"),
      cookie("unrelatedXjtlu", "sso.xjtlu.edu.cn"),
      cookie("similarHost", "moodle.example.edu.attacker.test"),
    ],
  });
  fs.writeFileSync(sessionPath, "old data", { mode: 0o644 });
  const saved = await session.interactiveLogin({ log: () => {} });
  assert.deepEqual(saved.cookies.map(({ name }) => name), ["MoodleSession", "parent"]);
  assert.equal(fs.statSync(sessionPath).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(sessionPath, "utf8")), saved);
  assert.equal(state.disconnected, true);
  assert.equal(state.killed, true);
  assert.equal(fs.existsSync(state.profile), false);
});

test("XJTLU login also keeps SSO cookies without accepting similarly named domains", async (t) => {
  const { session } = await loadSession(t, {
    baseUrl: "https://core.xjtlu.edu.cn",
    cookies: [
      cookie("MoodleSession", "core.xjtlu.edu.cn"),
      cookie("sso", "sso.xjtlu.edu.cn"),
      cookie("shared", ".xjtlu.edu.cn"),
      cookie("unrelatedSibling", "mail.xjtlu.edu.cn"),
      cookie("prefixAttack", "notxjtlu.edu.cn"),
      cookie("suffixAttack", "xjtlu.edu.cn.attacker.test"),
    ],
  });
  const saved = await session.interactiveLogin({ log: () => {} });
  assert.deepEqual(saved.cookies.map(({ name }) => name), ["MoodleSession", "sso", "shared"]);
});

test("login keeps Chrome open for a guest session until authentication is confirmed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const checked = deferred();
  let authenticated = false;
  const { session, state, sessionPath } = await loadSession(t, {
    cookies: [cookie("MoodleSession", "moodle.example.edu")],
    evaluate: async () => {
      checked.resolve();
      return authenticated;
    },
  });
  const login = session.interactiveLogin({ log: () => {} });
  await checked.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.cookieReads, 0);
  assert.equal(state.disconnected, false);
  assert.equal(state.killed, false);
  assert.equal(fs.existsSync(sessionPath), false);
  assert.equal(fs.existsSync(state.profile), true);

  authenticated = true;
  t.mock.timers.tick(1000);
  const saved = await login;
  assert.equal(saved.cookies[0].name, "MoodleSession");
  assert.equal(state.cookieReads, 1);
  assert.equal(state.killed, true);
  assert.equal(fs.existsSync(sessionPath), true);
});

test("login retries when navigation destroys the page execution context", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const checked = deferred();
  let attempts = 0;
  const { session, state } = await loadSession(t, {
    cookies: [cookie("MoodleSession", "moodle.example.edu")],
    evaluate: async () => {
      if (++attempts === 1) {
        checked.resolve();
        throw new Error("Execution context was destroyed, most likely because of a navigation.");
      }
      return true;
    },
  });
  const login = session.interactiveLogin({ log: () => {} });
  await checked.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.killed, false);
  assert.equal(state.cookieReads, 0);
  t.mock.timers.tick(1000);
  await login;
  assert.equal(attempts, 2);
  assert.equal(state.cookieReads, 1);
});

test("login ignores an authentication result from a page that navigated during evaluation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const checked = deferred();
  let currentUrl = "https://moodle.example.edu:8443/my/";
  let attempts = 0;
  const { session, state, sessionPath } = await loadSession(t, {
    cookies: [cookie("MoodleSession", "moodle.example.edu")],
    url: () => currentUrl,
    evaluate: async () => {
      if (++attempts === 1) {
        currentUrl = "https://sso.example.edu/sign-in";
        checked.resolve();
      }
      return true;
    },
  });
  const login = session.interactiveLogin({ log: () => {} });
  await checked.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.cookieReads, 0);
  assert.equal(state.killed, false);
  assert.equal(fs.existsSync(sessionPath), false);
  currentUrl = "https://moodle.example.edu:8443/my/";
  t.mock.timers.tick(1000);
  await login;
  assert.equal(attempts, 2);
  assert.equal(state.cookieReads, 1);
});

test("login timeout preserves the previously saved session", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const checked = deferred();
  const { session, state, sessionPath } = await loadSession(t, {
    cookies: [cookie("MoodleSession", "moodle.example.edu")],
    evaluate: async () => { checked.resolve(); return false; },
  });
  const previousSession = JSON.stringify({ format: "lmcore-mcp/session", cookies: [cookie("MoodleSession", "moodle.example.edu")] });
  fs.writeFileSync(sessionPath, previousSession, { mode: 0o600 });
  const login = assert.rejects(session.interactiveLogin({ log: () => {} }), /Timed out waiting for login/);
  await checked.promise;
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(5 * 60_000);
  await login;
  assert.equal(fs.readFileSync(sessionPath, "utf8"), previousSession);
  assert.equal(state.cookieReads, 0);
  assert.equal(state.disconnected, true);
  assert.equal(state.killed, true);
  assert.equal(fs.existsSync(state.profile), false);
});

test("login failure disconnects the browser and removes its temporary profile", async (t) => {
  const { session, state, sessionPath } = await loadSession(t);
  await assert.rejects(session.interactiveLogin({ log: () => {} }), /no MoodleSession cookie/);
  assert.equal(state.disconnected, true);
  assert.equal(state.killed, true);
  assert.equal(fs.existsSync(state.profile), false);
  assert.equal(fs.existsSync(sessionPath), false);
});

test("remembering a user replaces a readable session with a private file", async (t) => {
  const { session, directory, sessionPath } = await loadSession(t);
  fs.writeFileSync(sessionPath, JSON.stringify({
    format: "lmcore-mcp/session", version: 1, baseUrl: "https://moodle.example.edu:8443",
    userId: 0, fullName: "", savedAt: "old", cookies: [cookie("MoodleSession", "moodle.example.edu")],
  }), { mode: 0o644 });
  session.rememberUser(42, "Student");
  const saved = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  assert.equal(saved.userId, 42);
  assert.equal(saved.fullName, "Student");
  assert.equal(saved.cookies[0].name, "MoodleSession");
  assert.equal(fs.statSync(sessionPath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(directory), ["session.json"]);
});

test("failed atomic replacement preserves the old session and removes its temporary file", async (t) => {
  const { session, directory, sessionPath } = await loadSession(t);
  const original = JSON.stringify({ format: "lmcore-mcp/session", cookies: [] });
  fs.writeFileSync(sessionPath, original, { mode: 0o600 });
  t.mock.method(fs, "renameSync", () => { throw new Error("simulated rename failure"); });
  assert.throws(() => session.rememberUser(42, "Student"), /simulated rename failure/);
  assert.equal(fs.readFileSync(sessionPath, "utf8"), original);
  assert.deepEqual(fs.readdirSync(directory), ["session.json"]);
});

test("a missing Chrome executable rejects promptly and removes its temporary profile", async (t) => {
  const { session, state } = await loadSession(t, { spawn: realSpawn });
  await assert.rejects(session.interactiveLogin({ log: () => {} }), { code: "ENOENT" });
  assert.equal(state.connectCalls, 0);
  assert.equal(fs.existsSync(state.profile), false);
});

test("a synchronous Chrome launch failure also removes its temporary profile", async (t) => {
  const { session, state } = await loadSession(t, {
    spawn: () => { throw new Error("simulated spawn failure"); },
  });
  await assert.rejects(session.interactiveLogin({ log: () => {} }), /simulated spawn failure/);
  assert.equal(fs.existsSync(state.profile), false);
});

test("login waits for Chrome to exit before deleting the profile it is still writing", async (t) => {
  let finishShutdown;
  let signalTermination;
  const termination = new Promise((resolve) => { signalTermination = resolve; });
  const { session, state } = await loadSession(t, {
    cookies: [cookie("MoodleSession", "moodle.example.edu")],
    spawn: (_executable, args) => {
      const child = new EventEmitter();
      const profile = args.find((arg) => arg.startsWith("--user-data-dir=")).split("=")[1];
      child.pid = 12345;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = (signal) => {
        assert.equal(signal, "SIGTERM");
        signalTermination();
        return true;
      };
      finishShutdown = () => {
        fs.writeFileSync(path.join(profile, "final-profile-write"), "closed");
        child.signalCode = "SIGTERM";
        child.emit("exit", null, "SIGTERM");
      };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  let completed = false;
  const login = session.interactiveLogin({ log: () => {} }).then(() => { completed = true; });
  t.after(() => { if (fs.existsSync(state.profile)) finishShutdown(); });
  await termination;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  assert.equal(fs.existsSync(state.profile), true);
  finishShutdown();
  await login;
  assert.equal(fs.existsSync(state.profile), false);
});

test("login escalates to SIGKILL when Chrome ignores SIGTERM", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const signals = [];
  let signalTermination;
  const termination = new Promise((resolve) => { signalTermination = resolve; });
  const { session, state } = await loadSession(t, {
    cookies: [cookie("MoodleSession", "moodle.example.edu")],
    spawn: () => {
      const child = new EventEmitter();
      child.pid = 12345;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = (signal) => {
        signals.push(signal);
        if (signal === "SIGTERM") signalTermination();
        if (signal === "SIGKILL") queueMicrotask(() => {
          child.signalCode = signal;
          child.emit("exit", null, signal);
        });
        return true;
      };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  const login = session.interactiveLogin({ log: () => {} });
  await termination;
  assert.equal(fs.existsSync(state.profile), true);
  t.mock.timers.tick(5000);
  await login;
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(fs.existsSync(state.profile), false);
});

test("login stops waiting after SIGKILL and preserves a profile still in use", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const signals = [];
  let signalTermination;
  let signalForceKill;
  const termination = new Promise((resolve) => { signalTermination = resolve; });
  const forceKill = new Promise((resolve) => { signalForceKill = resolve; });
  const { session, state } = await loadSession(t, {
    cookies: [cookie("MoodleSession", "moodle.example.edu")],
    spawn: () => {
      const child = new EventEmitter();
      child.pid = 12345;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = (signal) => {
        signals.push(signal);
        if (signal === "SIGTERM") signalTermination();
        if (signal === "SIGKILL") signalForceKill();
        return true;
      };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  t.after(() => fs.rmSync(state.profile, { recursive: true, force: true }));
  const login = assert.rejects(session.interactiveLogin({ log: () => {} }), /did not exit after SIGKILL/);
  await termination;
  t.mock.timers.tick(5000);
  await forceKill;
  t.mock.timers.tick(5000);
  await login;
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(fs.existsSync(state.profile), true);
});

test("session recovery advice uses the package script command", async (t) => {
  const { session } = await loadSession(t);
  assert.match(new session.SessionExpiredError().message, /pnpm run login/);
});
