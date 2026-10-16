import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("stdio registers seven tools and reports session failures as tool errors", { timeout: 15_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lmcore-mcp-test-"));
  const client = new Client({ name: "lmcore-regression", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../build/index.js", import.meta.url))],
    env: { LMCORE_SESSION: path.join(directory, "missing-session.json") },
    stderr: "pipe",
  });
  transport.stderr.resume();
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const calls = [
      ["lmcore_courses", {}],
      ["lmcore_deadlines", {}],
      ["lmcore_course_contents", { courseId: 1 }],
      ["lmcore_read_file", { url: "https://core.xjtlu.edu.cn/mod/resource/view.php?id=1" }],
      ["lmcore_assignments", { courseId: 1 }],
      ["lmcore_grades", { courseId: 1 }],
      ["lmcore_notifications", {}],
    ];
    assert.deepEqual(tools.map(({ name }) => name).sort(), calls.map(([name]) => name).sort());
    const readFile = tools.find(({ name }) => name === "lmcore_read_file");
    assert.match(readFile.description, /limited accuracy/);
    assert.match(readFile.description, /OCR is disabled/);
    assert.match(readFile.description, /multimodal input/);
    assert.match(readFile.description, /download to true/);
    assert.match(readFile.description, /does not attach the file.*automatically/);
    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, name);
      const { error } = JSON.parse(result.content[0].text);
      assert.match(error, /session is missing or has expired/, name);
      assert.match(error, /pnpm run login/, name);
    }
    for (const [name, args] of [
      ["lmcore_deadlines", { days: 0 }],
      ["lmcore_deadlines", { days: 181 }],
      ["lmcore_deadlines", { days: 1.5 }],
      ["lmcore_notifications", { limit: 0 }],
      ["lmcore_notifications", { limit: 51 }],
      ["lmcore_course_contents", { courseId: "1" }],
    ]) {
      try {
        const result = await client.callTool({ name, arguments: args });
        assert.equal(result.isError, true, `${name}: ${JSON.stringify(args)}`);
      } catch (error) {
        assert.match(String(error), /invalid|validat|parameter|schema/i);
      }
    }
  } finally {
    await client.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
