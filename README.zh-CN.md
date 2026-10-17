<div align="center">

# lmcore-mcp

**面向西交利物浦大学 Learning Mall Core (`core.xjtlu.edu.cn`, Moodle 5.0.2) 的只读 [MCP](https://modelcontextprotocol.io) 服务器**

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.12-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-stdio-000000)](https://modelcontextprotocol.io)
[![Platform](https://img.shields.io/badge/Platforms-macOS%20%7C%20Linux%20%7C%20Windows-555)](#平台兼容性)
[![Mode](https://img.shields.io/badge/Access-Read--Only-blue)](#为什么使用浏览器会话认证)

[English](./README.md) | 简体中文

</div>

`lmcore-mcp` 将西交利物浦大学 Learning Mall Core 接入支持 MCP 协议的客户端（如 Claude Desktop、Cursor、Claude Code 等），支持以只读方式查询已选课程、近期截止事项、课程资料、作业状态、成绩明细与系统通知。

## 为什么使用浏览器会话认证？

常见的 Moodle MCP 服务器（如 [loyaniu/moodle-mcp](https://github.com/loyaniu/moodle-mcp)）依赖 Moodle Web Service Token 进行认证。但 Learning Mall Core 未向学生账号开放该权限（*Preferences → Security keys* 仅提供 RSS 密钥，且移动端 Web Service 已禁用），因此基于 Token 的方案无法连接。

`lmcore-mcp` 采用浏览器会话复用方案：首次登录时拉起独立的本地 Chrome 窗口，由你在窗口中完成西浦统一身份认证（SSO），随后将生成的 `MoodleSession` 等 Cookie 保存至本地配置文件（权限 `0600`）。后续工具调用均通过无头（Headless）Chrome 复用该会话。

> [!NOTE]
> 本项目提供的所有工具均为**严格只读**，不包含任何提交作业、发送消息或修改状态的接口。

## 环境要求

- **Node.js ≥ 22.12 与 pnpm** — 推荐 Node.js 24。
- **Google Chrome 或 Chromium** — 需要单独安装浏览器；若无法自动发现，请设置 `PUPPETEER_EXECUTABLE_PATH`。
- **受支持的原生平台** — 参见下方兼容性表。

Nix 与 [devenv](https://devenv.sh/) 是可选开发工具，安装或运行 MCP 服务器均不依赖它们。

## 平台兼容性

文档解析使用 [Xberg 1.3.10](https://www.npmjs.com/package/@xberg-io/xberg/v/1.3.10) 提供的原生二进制包。

| 平台 | 原生解析包 | 验证状态 |
| --- | --- | --- |
| macOS，Apple Silicon（`arm64`） | 已提供 | 已验证构建、回归测试及真实登录后的 MCP 调用。 |
| Linux，`x64` 或 `arm64`，glibc | 已提供 | 依赖具备平台支持，尚未进行端到端验证。 |
| Linux，`x64` 或 `arm64`，musl | 已提供 | 依赖具备平台支持，浏览器安装及端到端运行尚未验证。 |
| Windows，`x64` | 已提供 | 依赖具备平台支持，尚未进行端到端验证。 |
| macOS，Intel（`x64`）；Windows，`arm64` | 当前固定版本未提供预编译包 | 不支持标准安装流程。 |

macOS 默认查找 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`；Linux 从 `PATH` 查找 `google-chrome`、`google-chrome-stable`、`chromium` 或 `chromium-browser`；Windows 查找 Google Chrome 的标准安装位置。各平台均优先使用 `PUPPETEER_EXECUTABLE_PATH`。Linux 原生解析包不包含浏览器或浏览器所需的系统依赖，建议优先使用基于 glibc 的发行版。

## 快速开始

### 1. 安装依赖与构建

```bash
pnpm install
pnpm build
```

### 2. 登录获取会话

```bash
pnpm run login
```

> [!WARNING]
> 请务必执行 `pnpm run login`，不要省略 `run`（`pnpm login` 是 pnpm 内置的 npm 仓库登录命令）。

1. 命令会使用独立临时配置目录弹出一个普通 Chrome 窗口并打开 Learning Mall 登录页（不会影响你日常使用的 Chrome 窗口或资料）。
2. 请在 5 分钟内使用西浦账号完成 SSO 登录。
3. 页面跳转回 Learning Mall 后，程序会自动将 Cookie 写入 `~/.config/lmcore-mcp/session.json`（权限 `0600`）并关闭窗口。

当 Moodle 会话过期时，工具调用会返回明确提示，届时重新运行 `pnpm run login` 即可。

交互式登录浏览器会禁用 HTTP/2，避免 SSO 跳转时跨域复用连接。后续 MCP 工具调用仍使用 Chrome 默认的协议协商方式。

### 3. 配置 MCP 客户端

将 `lmcore` 添加到 MCP 客户端的 stdio 服务器配置中（如 `claude_desktop_config.json` 或 `.mcp.json`）：

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

MCP 宿主需要能够找到 Node.js，必要时请将 `node` 替换为可执行文件的绝对路径。Windows 请使用对应的 `build/index.js` 路径，并在 JSON 中转义反斜杠，例如 `C:\\path\\to\\lmcore-mcp\\build\\index.js`。不同客户端的配置格式可能不同，服务器通过标准输入和标准输出通信。

### Linux Agent 宿主

Agent 宿主可以在受支持的 Linux 架构上，将构建后的服务器作为本地 stdio MCP 进程启动。请在宿主中安装 Node.js、pnpm、Chrome 或 Chromium 及浏览器所需的系统依赖，再在该环境中构建项目；必要时设置 `PUPPETEER_EXECUTABLE_PATH`。

`pnpm run login` 需要交互式图形桌面来显示 SSO 登录窗口。对于无显示环境的服务器，可以先在可信且具备桌面的机器上完成登录，再安全传输会话文件，并在 MCP 进程环境中将 `LMCORE_SESSION` 设为该文件的绝对路径。会话文件应位于仓库之外，且仅允许运行服务器的账号访问（Unix 使用 `chmod 600`，Windows 使用等效的仅所有者可访问 ACL）。会话可能过期，或在其他环境中被拒绝；传输后应调用只读工具验证，并在需要时重新登录。

下载文件及 `savedTo` 路径属于运行 MCP 服务器的机器。远程客户端需要自行提供安全的文件访问或附件传输机制；服务器不会自动把文件传给模型。

## 工具列表

| 工具名称 | 参数 | 功能说明 |
| --- | --- | --- |
| `lmcore_courses` | — | 获取当前账号已注册的课程列表，按时间线状态（`inprogress`、`future`、`past`）分组，并返回其他工具所需的 `courseId`。 |
| `lmcore_deadlines` | `days?` *(1–180，默认 `21`)* | 查询未来 `days` 天内所有课程的待办截止事件（作业、测验、投票等），时间统一采用 `Asia/Shanghai` 时区。 |
| `lmcore_course_contents` | `courseId` | 获取指定课程的章节目录与教学活动列表，包含名称、类型、链接及完成状态。 |
| `lmcore_read_file` | `url`, `download?` *(默认 `false`)* | 读取 `lmcore_course_contents` 返回的 `mod/resource` 课件资源。默认在本地将 PDF、PPTX、DOCX 解析为 Markdown；若设置 `download: true` 则将原文件保存至本地并返回路径。 |
| `lmcore_assignments` | `courseId` | 获取指定课程的所有作业列表，包含截止时间、提交状态及评分。 |
| `lmcore_grades` | `courseId` | 获取指定课程的个人成绩单明细（得分、满分范围、百分比及教师评语）。 |
| `lmcore_notifications` | `limit?` *(1–50，默认 `10`)* | 获取未读通知数量及最近的系统通知列表。 |

### 数据获取机制

- **Moodle AJAX 接口**（`lmcore_courses`、`lmcore_deadlines`、`lmcore_notifications`）：复用页面中的 `sesskey` 直接调用 `/lib/ajax/service.php` 并解析返回的 JSON。
- **页面 DOM 解析**（`lmcore_course_contents`、`lmcore_assignments`、`lmcore_grades`）：由于站点禁止学生浏览器会话直接调用相关 Web Service 方法，这部分数据直接从服务端渲染的页面 DOM 中提取。
- 每次工具调用都会启动一个短暂的无头 Chrome 实例，单次耗时通常在数秒左右。

## 文档解析与限制说明

`lmcore_read_file` 使用 [Xberg](https://github.com/xberg-io/xberg) 在本地内存中解析 PDF、PPTX 与 DOCX 文档（并针对 PPTX 额外根据 `<p:sldIdLst>` 还原幻灯片真实播放顺序）：

- **纯本地处理**：已关闭缓存、OCR、版面推理与模型特征提取，不会向任何外部解析服务上传课件内容，也不会下载模型权重。纯文本文件（`.txt`、`.md`、`.csv`）直接返回原始文本。
- **长度截断**：单文件提取文本上限为 **60,000 字符**，超出部分会被截断并在返回结果的 `note` 字段中注明。
- **解析精度限制**：由于未启用 OCR 与复杂版面还原，扫描版 PDF、图片内文字、复杂跨格表格及数学公式可能无法完整提取。
- **下载原文件（`download: true`）**：如果宿主客户端或大模型原生支持多模态文档输入或本地文件读取，建议传入 `download: true`。工具会将原始文件保存至 `~/.config/lmcore-mcp/downloads/`（权限 `0600`）并返回 `savedTo` 绝对路径，供客户端自带的文件工具直接读取（注意：`download: true` 仅保存文件并返回路径，不会自动将文件附加到模型上下文中）。

## 环境变量

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `LMCORE_URL` | `https://core.xjtlu.edu.cn` | 目标 Moodle 站点根地址。 |
| `LMCORE_SESSION` | `~/.config/lmcore-mcp/session.json` | 登录会话 Cookie 的存储路径。 |
| `PUPPETEER_EXECUTABLE_PATH` | 根据平台自动发现 | 覆盖本地 Chrome 或 Chromium 可执行文件路径。 |

## 开发与测试

在已安装 Node.js 与 pnpm 的环境中运行：

```bash
pnpm typecheck
pnpm test
```

回归测试全部基于合成的会话、页面 HTML 与测试文档运行，不会读取本地真实登录态，也不会向 Learning Mall 发起网络请求。浏览器相关测试需要本地安装 Chrome，并在 `PATH` 中提供 `openssl`，用于生成临时的本机 TLS 测试证书。

GitHub Actions 在 Linux 上运行合成会话回归测试，不会通过 SSO 登录，也不验证真实 Learning Mall 会话。
