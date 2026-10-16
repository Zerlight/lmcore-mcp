import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

function chromePath(platform, environment = {}, executables = []) {
  const script = `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import os from "node:os";
    import { mock } from "node:test";
    const platform = ${JSON.stringify(platform)};
    const environment = ${JSON.stringify(environment)};
    const executables = ${JSON.stringify(executables)};
    for (const name of ["PUPPETEER_EXECUTABLE_PATH", "PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA", "PATH"]) {
      delete process.env[name];
    }
    Object.assign(process.env, environment);
    const testOs = { ...os, platform: () => platform, homedir: () => "/temporary-test-home" };
    const testFs = { ...fs, accessSync: (candidate, mode) => {
      assert.equal(mode, fs.constants.X_OK);
      if (!executables.includes(candidate)) throw new Error("Executable unavailable");
    }};
    mock.module("node:os", { exports: { ...testOs, default: testOs } });
    mock.module("node:fs", { exports: { ...testFs, default: testFs } });
    const { CHROME_PATH } = await import(${JSON.stringify(new URL("../build/config.js", import.meta.url).href)});
    process.stdout.write(CHROME_PATH);
  `;
  return execFileSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "-e", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("an explicit browser executable overrides platform discovery", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    assert.equal(chromePath(platform, { PUPPETEER_EXECUTABLE_PATH: "/custom/browser" }), "/custom/browser");
  }
});

test("macOS retains the standard Chrome application path", () => {
  assert.equal(chromePath("darwin"), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
});

test("Linux discovers executable Chrome and Chromium installations on PATH", () => {
  const environment = { PATH: "/opt/browser/bin:/usr/bin:/snap/bin" };
  assert.equal(chromePath("linux", environment, ["/snap/bin/chromium"]), "/snap/bin/chromium");
  assert.equal(chromePath("linux", environment, ["/usr/bin/google-chrome-stable", "/snap/bin/chromium"]), "/usr/bin/google-chrome-stable");
});

test("Windows discovers Chrome in system and per-user installation directories", () => {
  const environment = {
    PROGRAMFILES: "D:\\Applications",
    "PROGRAMFILES(X86)": "D:\\Applications (x86)",
    LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
  };
  for (const directory of Object.values(environment)) {
    const executable = `${directory}\\Google\\Chrome\\Application\\chrome.exe`;
    assert.equal(chromePath("win32", environment, [executable]), executable);
  }
});

test("missing Chrome does not prevent importing configuration", () => {
  assert.equal(chromePath("linux", { PATH: "/usr/bin" }), "/usr/bin/google-chrome");
  assert.equal(chromePath("win32"), "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
});
