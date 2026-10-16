<div align="center">

# lmcore-mcp

**Read-only [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for XJTLU Learning Mall Core (`core.xjtlu.edu.cn`, Moodle 5.0.2)**

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.12-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-stdio-000000)](https://modelcontextprotocol.io)
[![Platform](https://img.shields.io/badge/Platforms-macOS%20%7C%20Linux%20%7C%20Windows-555)](#platform-compatibility)
[![Mode](https://img.shields.io/badge/Access-Read--Only-blue)](#why-browser-session-auth)

English | [简体中文](./README.zh-CN.md)

</div>

`lmcore-mcp` connects MCP clients (Claude Desktop, Cursor, Claude Code, etc.) to XJTLU Learning Mall Core. It provides read-only access to your enrolled courses, upcoming deadlines, course materials, assignments, grades, and notifications.

## Why Browser Session Auth?

Standard Moodle MCP servers (such as [loyaniu/moodle-mcp](https://github.com/loyaniu/moodle-mcp)) authenticate with Moodle Web Service tokens. On XJTLU Learning Mall Core, student accounts cannot generate Web Service tokens (*Preferences → Security keys* only exposes an RSS key, and the Moodle mobile web service is disabled).

`lmcore-mcp` works around this by launching a standalone Chrome window once for you to sign in through XJTLU SSO, saving the resulting `MoodleSession` cookies locally (`0600`), and replaying that session in headless Chrome on subsequent tool calls.

> [!NOTE]
> All tools are strictly read-only. `lmcore-mcp` never submits assignments, posts messages, or modifies account state.

## Prerequisites

- **Node.js ≥ 22.12 and pnpm** — Node.js 24 is recommended.
- **Google Chrome or Chromium** — Install the browser separately. Set `PUPPETEER_EXECUTABLE_PATH` if it is not found automatically.
- **A supported native platform** — See the compatibility table below.

Nix and [devenv](https://devenv.sh/) are optional development tools. They are not required to install or run the MCP server.

## Platform Compatibility

Document parsing uses the native binaries shipped with [Xberg 1.3.10](https://www.npmjs.com/package/@xberg-io/xberg/v/1.3.10).

| Platform | Native parser package | Validation status |
| --- | --- | --- |
| macOS, Apple Silicon (`arm64`) | Available | Build, regression tests, and authenticated MCP calls verified. |
| Linux, `x64` or `arm64`, glibc | Available | Dependency support available; end-to-end operation not yet verified. |
| Linux, `x64` or `arm64`, musl | Available | Dependency support available; browser installation and end-to-end operation not yet verified. |
| Windows, `x64` | Available | Dependency support available; end-to-end operation not yet verified. |
| macOS, Intel (`x64`); Windows, `arm64` | No prebuilt package in the pinned Xberg release | Not supported by the standard installation. |

Chrome discovery uses `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` on macOS; `google-chrome`, `google-chrome-stable`, `chromium`, or `chromium-browser` on the Linux `PATH`; and standard Google Chrome installation locations on Windows. `PUPPETEER_EXECUTABLE_PATH` takes precedence on every platform. A Linux native parser package does not install a browser or its system dependencies; glibc-based distributions are the simplest deployment target.

## Quick Start

### 1. Install and Build

```bash
pnpm install
pnpm build
```

### 2. Sign In

```bash
pnpm run login
```

> [!WARNING]
> Always run `pnpm run login` (not `pnpm login`, which is pnpm's built-in command for authenticating with an npm registry).

1. A regular Chrome window will open to the Learning Mall login page using a temporary browser profile.
2. Sign in with your XJTLU account (waiting up to 5 minutes).
3. Once redirected back to Learning Mall, your session cookies are saved to `~/.config/lmcore-mcp/session.json` (permissions `0600`) and the window closes automatically.

When your Moodle session eventually expires, tools will prompt you to run `pnpm run login` again.

### 3. Configure Your MCP Client

Add `lmcore` to your MCP client's stdio server configuration (e.g., `claude_desktop_config.json` or `.mcp.json`):

```json
{
  "mcpServers": {
    "lmcore": {
      "command": "node",
      "args": ["/absolute/path/to/lmcore-mcp/build/index.js"]
    }
  }
}
```

The MCP host must be able to find Node.js. If needed, replace `node` with its absolute executable path. On Windows, use a Windows path for `build/index.js` and escape backslashes in JSON, for example `C:\\path\\to\\lmcore-mcp\\build\\index.js`. Clients may use different configuration formats; the server communicates over standard input and output.

### Linux Agent Hosts

An agent host can launch the compiled server as a local stdio MCP process on a supported Linux architecture. Install Node.js, pnpm, Chrome or Chromium, and the browser's system dependencies on that host, then build the project there. Set `PUPPETEER_EXECUTABLE_PATH` when necessary.

`pnpm run login` requires an interactive graphical desktop to display the SSO login window. On a server without a display, complete login on a trusted machine with a desktop, securely transfer only the session file to the server, and set `LMCORE_SESSION` to its absolute path in the MCP process environment. Keep the file outside the repository and restrict access to the account running the server (`chmod 600` on Unix; an equivalent owner-only ACL on Windows). A session may expire or be rejected in a different environment; verify a read-only tool call after transfer and sign in again when necessary.

Downloaded files and `savedTo` paths belong to the machine running the MCP server. A remote client needs its own secure file access or attachment mechanism to read them; the server does not automatically transfer files to the model.

## Available Tools

| Tool | Parameters | Description |
| --- | --- | --- |
| `lmcore_courses` | — | List enrolled courses grouped by status (`inprogress`, `future`, `past`), including each course's `courseId`. |
| `lmcore_deadlines` | `days?` *(1–180, default `21`)* | List upcoming action events (assignments, quizzes, choices) across all courses. Timestamps use `Asia/Shanghai`. |
| `lmcore_course_contents` | `courseId` | List all sections and activities in a course, including activity type, link, and completion status. |
| `lmcore_read_file` | `url`, `download?` *(default `false`)* | Extract Markdown/text from a course `mod/resource` file (PDF, PPTX, DOCX, TXT/MD/CSV), or save the original file locally when `download: true`. |
| `lmcore_assignments` | `courseId` | List all assignments in a course with due dates, submission status, and grades. |
| `lmcore_grades` | `courseId` | Fetch the user grade report (grades, ranges, percentages, and feedback) for a course. |
| `lmcore_notifications` | `limit?` *(1–50, default `10`)* | Fetch the unread notification count and most recent notifications. |

### How Data Is Fetched

- **Moodle AJAX API** (`lmcore_courses`, `lmcore_deadlines`, `lmcore_notifications`): Calls `/lib/ajax/service.php` using the active browser session's `sesskey`.
- **DOM Extraction** (`lmcore_course_contents`, `lmcore_assignments`, `lmcore_grades`): Parses the server-rendered Moodle pages directly, since the corresponding web service methods are restricted for student browser sessions.
- Each tool call opens a short-lived headless Chrome instance, which typically takes a few seconds.

## Document Reading & Extraction Limits

`lmcore_read_file` parses PDF, PPTX, and DOCX files locally in memory using [Xberg](https://github.com/xberg-io/xberg) (and restores presentation slide order from `<p:sldIdLst>` for PPTX files):

- **Privacy & Offline Parsing**: No document bytes are sent to external services, extraction caching is disabled, and no model weights are downloaded. Plain-text formats (`.txt`, `.md`, `.csv`) are returned verbatim.
- **Length Cap**: Extracted text is capped at **60,000 characters**. Truncation and parser warnings are reported in the returned `note` field.
- **Accuracy Trade-offs**: OCR and layout inference are disabled. Scanned PDFs, embedded images, complex tables, and mathematical formulas may be omitted or garbled.
- **Direct File Download (`download: true`)**: If your MCP host or model supports reading local files or multimodal PDF/Office input directly, pass `download: true` to save the raw file under `~/.config/lmcore-mcp/downloads/` (`0600`) and read the returned `savedTo` path with your client's file tools. The path is local to the MCP server; downloading does not automatically attach the file to the model.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `LMCORE_URL` | `https://core.xjtlu.edu.cn` | Base URL of the target Moodle instance. |
| `LMCORE_SESSION` | `~/.config/lmcore-mcp/session.json` | File path for storing session cookies. |
| `PUPPETEER_EXECUTABLE_PATH` | Platform-specific discovery | Override the local Chrome or Chromium executable path. |

## Development & Testing

With Node.js and pnpm installed:

```bash
pnpm typecheck
pnpm test
```

The test suite runs against synthetic sessions, HTML fixtures, and generated PDF/OOXML test files without reading your saved session or contacting Learning Mall Core. Browser integration tests require a local Chrome installation.

GitHub Actions runs the synthetic-session regression suite on Linux. It does not sign in through SSO or verify a real Learning Mall session.
