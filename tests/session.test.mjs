import assert from "node:assert/strict";
import { spawn as realSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

let moduleId = 0;

function fakeChrome({ onKill } = {}) {
  const child = new EventEmitter();
  child.pid = 12345;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    if (onKill) return onKill(child, signal);
    queueMicrotask(() => {
      child.signalCode = signal;
      child.emit("exit", null, signal);
    });
    return true;
  };
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

async function loadSession(t, {
  baseUrl = "https://moodle.example.edu:8443", cookies = [], spawn, signIn,
  evaluate = async () => true, url = () => `${baseUrl}/my/`, goto, isLoginUrl = () => false,
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lmcore-session-test-"));
  const sessionPath = path.join(directory, "session.json");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = {
    killed: false, disconnected: false, profile: undefined, connectCalls: 0, cookieReads: 0,
    launches: [], preferences: undefined, aborted: [], continued: [], closedPages: 0,
  };
  let requestHandler;
  const page = {
    url,
    evaluate,
    setRequestInterception: async () => {},
    on: (event, handler) => { if (event === "request") requestHandler = handler; },
    goto: async (target) => {
      if (goto) return goto(target, (request) => requestHandler(request));
      return null;
    },
    close: async () => { state.closedPages++; },
    createCDPSession: async () => ({ send: async () => {
      state.cookieReads++;
      return { cookies };
    } }),
  };
  const restoredTab = { close: async () => { state.closedPages++; } };
  t.mock.module(new URL("../build/config.js", import.meta.url).href, {
    exports: {
      BASE_URL: baseUrl,
      SITE_HOST: new URL(baseUrl).host,
      SESSION_PATH: sessionPath,
      CHROME_PATH: path.join(directory, "nonexistent-chrome"),
      isLoginUrl,
    },
  });
  t.mock.module("puppeteer-core", {
    exports: {
      default: {
        connect: async () => {
          state.connectCalls++;
          return {
            newPage: async () => page,
            pages: async () => [restoredTab, page],
            disconnect: async () => { state.disconnected = true; },
          };
        },
      },
    },
  });
  t.mock.module("node:child_process", {
    exports: {
      spawn: (executable, args, options) => {
        assert.ok(args.includes("--disable-http2"));
        state.profile = args.find((arg) => arg.startsWith("--user-data-dir=")).split("=")[1];
        const phase = args.includes("--remote-debugging-port=0") ? "capture" : "signIn";
        state.launches.push({ phase, args });
        if (phase === "signIn") {
          state.preferences = JSON.parse(fs.readFileSync(path.join(state.profile, "Default", "Preferences"), "utf8"));
          if (signIn) return signIn(executable, args, options);
          // The user signs in and closes the window.
          const child = fakeChrome();
          child.once("spawn", () => queueMicrotask(() => { child.exitCode = 0; child.emit("exit", 0, null); }));
          return child;
        }
        fs.writeFileSync(path.join(state.profile, "DevToolsActivePort"), "9222\n/devtools/browser/test");
        if (spawn) return spawn(executable, args, options);
        return fakeChrome({ onKill: (child, signal) => {
          state.killed = signal === "SIGTERM";
          queueMicrotask(() => {
            child.signalCode = signal;
            child.emit("exit", null, signal);
          });
          return true;
        } });
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

/** Advances mocked timers until `promise` settles. */
async function drive(t, promise, step = 1000) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 10_000 && !settled; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    if (!settled) t.mock.timers.tick(step);
  }
  return promise;
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

test("login waits for the dashboard to confirm authentication before reading cookies", async (t) => {
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

test("an unconfirmed sign-in preserves the previously saved session", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { session, state, sessionPath } = await loadSession(t, {
    cookies: [cookie("MoodleSession", "moodle.example.edu")],
    evaluate: async () => false,
  });
  const previousSession = JSON.stringify({ format: "lmcore-mcp/session", cookies: [cookie("MoodleSession", "moodle.example.edu")] });
  fs.writeFileSync(sessionPath, previousSession, { mode: 0o600 });
  await assert.rejects(drive(t, session.interactiveLogin({ log: () => {} })), /Sign-in did not complete \(not signed in\); run login again/);
  assert.equal(fs.readFileSync(sessionPath, "utf8"), previousSession);
  assert.equal(state.cookieReads, 0);
  assert.equal(state.disconnected, true);
  assert.equal(state.killed, true);
  assert.equal(fs.existsSync(state.profile), false);
});

test("login failure disconnects the browser and removes its temporary profile", async (t) => {
  const { session, state, sessionPath } = await loadSession(t);
  await assert.rejects(session.interactiveLogin({ log: () => {} }), /Sign-in did not complete \(no MoodleSession cookie\); run login again/);
  assert.deepEqual(state.launches.map(({ phase }) => phase), ["signIn", "capture", "capture"]);
  assert.equal(state.disconnected, true);
  assert.equal(state.killed, true);
  assert.equal(fs.existsSync(state.profile), false);
  assert.equal(fs.existsSync(sessionPath), false);
});

test("invalid session JSON reports an expired session", async (t) => {
  const { session, sessionPath } = await loadSession(t);
  fs.writeFileSync(sessionPath, "{ broken", { mode: 0o600 });
  assert.throws(() => session.rememberUser(1, "Student"), session.SessionExpiredError);
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
  const { session, state } = await loadSession(t, { signIn: realSpawn });
  await assert.rejects(session.interactiveLogin({ log: () => {} }), { code: "ENOENT" });
  assert.equal(state.connectCalls, 0);
  assert.equal(fs.existsSync(state.profile), false);
});

test("a synchronous Chrome launch failure also removes its temporary profile", async (t) => {
  const { session, state } = await loadSession(t, {
    signIn: () => { throw new Error("simulated spawn failure"); },
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

test("sign-in Chrome runs without DevTools; only the capture launch enables debugging", async (t) => {
  const { session, state } = await loadSession(t, { cookies: [cookie("MoodleSession", "moodle.example.edu")] });
  await session.interactiveLogin({ log: () => {} });
  const [signIn, capture, ...rest] = state.launches;
  assert.equal(rest.length, 0);
  assert.equal(signIn.phase, "signIn");
  assert.ok(!signIn.args.some((arg) => arg.startsWith("--remote-debugging") || arg.startsWith("--headless")
    || arg.includes("automation")));
  assert.equal(signIn.args.at(-1), "https://moodle.example.edu:8443/my/");
  assert.deepEqual(state.preferences, { session: { restore_on_startup: 1 } });
  assert.ok(capture.args.includes("--headless=new"));
  assert.ok(capture.args.includes("--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE moodle.example.edu"));
  assert.equal(capture.args.at(-1), "about:blank");
  assert.equal(capture.args.find((arg) => arg.startsWith("--user-data-dir=")), signIn.args.find((arg) => arg.startsWith("--user-data-dir=")));
  assert.equal(state.closedPages, 1, "restored tabs are closed before the dashboard loads");
});

test("capture blocks redirects away from Moodle and reports an incomplete sign-in", async (t) => {
  const requests = [];
  const { session, state, sessionPath } = await loadSession(t, {
    cookies: [cookie("MoodleSession", "moodle.example.edu")],
    goto: async (target, emit) => {
      for (const href of [target, "https://sso.example.edu/esc-sso/login/page"]) {
        const request = {
          url: () => href, isNavigationRequest: () => true,
          abort: async () => { requests.push(["abort", href]); },
          continue: async () => { requests.push(["continue", href]); },
        };
        emit(request);
      }
      throw new Error("net::ERR_FAILED");
    },
  });
  await assert.rejects(session.interactiveLogin({ log: () => {} }), /Sign-in did not complete \(redirected to sign-in\); run login again/);
  assert.deepEqual(requests.slice(0, 2), [
    ["continue", "https://moodle.example.edu:8443/my/"],
    ["abort", "https://sso.example.edu/esc-sso/login/page"],
  ]);
  assert.deepEqual(state.launches.map(({ phase, args }) => [phase, args.includes("--headless=new")]),
    [["signIn", false], ["capture", true], ["capture", false]]);
  assert.equal(state.cookieReads, 0);
  assert.equal(fs.existsSync(sessionPath), false);
  assert.equal(fs.existsSync(state.profile), false);
});

test("capture rejects a Moodle login page instead of waiting", async (t) => {
  const { session, state } = await loadSession(t, {
    cookies: [cookie("MoodleSession", "moodle.example.edu")],
    url: () => "https://moodle.example.edu:8443/login/index.php",
    isLoginUrl: (url) => url.includes("/login/"),
  });
  await assert.rejects(session.interactiveLogin({ log: () => {} }), /Sign-in did not complete/);
  assert.equal(state.cookieReads, 0);
});

test("headed capture is used when the headless check cannot find the session", async (t) => {
  let captures = 0;
  const { session, state } = await loadSession(t, {
    cookies: [cookie("MoodleSession", "moodle.example.edu")],
    url: () => (captures === 1 ? "https://moodle.example.edu:8443/login/index.php" : "https://moodle.example.edu:8443/my/"),
    isLoginUrl: (url) => url.includes("/login/"),
    spawn: () => {
      captures++;
      return fakeChrome();
    },
  });
  const saved = await session.interactiveLogin({ log: () => {} });
  assert.equal(saved.cookies[0].name, "MoodleSession");
  assert.deepEqual(state.launches.map(({ args }) => args.includes("--headless=new")), [false, true, false]);
});

test("closing the sign-in window before Chrome finishes starting reports a launch failure", async (t) => {
  const { session, state } = await loadSession(t, {
    signIn: () => {
      const child = fakeChrome();
      child.once("spawn", () => queueMicrotask(() => { child.exitCode = 21; child.emit("exit", 21, null); }));
      return child;
    },
  });
  await assert.rejects(session.interactiveLogin({ log: () => {} }), /Chrome exited immediately \(code 21\)/);
  assert.equal(state.connectCalls, 0);
  assert.equal(fs.existsSync(state.profile), false);
});

test("sign-in window left open times out, stops Chrome, and removes the profile", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const signals = [];
  const { session, state } = await loadSession(t, {
    signIn: () => fakeChrome({ onKill: (child, signal) => {
      signals.push(signal);
      queueMicrotask(() => { child.signalCode = signal; child.emit("exit", null, signal); });
      return true;
    } }),
  });
  await assert.rejects(drive(t, session.interactiveLogin({ log: () => {} }), 60_000), /Timed out waiting for login/);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(state.connectCalls, 0);
  assert.equal(fs.existsSync(state.profile), false);
});

test("capture Chrome exiting mid-check aborts with a clear message", async (t) => {
  const { session, state } = await loadSession(t, {
    cookies: [cookie("MoodleSession", "moodle.example.edu")],
    spawn: () => {
      const child = fakeChrome();
      child.once("spawn", () => setImmediate(() => { child.exitCode = 1; child.emit("exit", 1, null); }));
      return child;
    },
    goto: () => new Promise(() => {}),
  });
  await assert.rejects(session.interactiveLogin({ log: () => {} }), /Chrome exited while the session was being checked/);
  assert.equal(fs.existsSync(state.profile), false);
});

test("session recovery advice uses the package script command", async (t) => {
  const { session } = await loadSession(t);
  assert.match(new session.SessionExpiredError().message, /pnpm run login/);
});
