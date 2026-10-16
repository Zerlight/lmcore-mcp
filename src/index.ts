#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { readFiles } from "./files.js";
import { assignments, courseContents, grades, listCourses, notifications, upcomingDeadlines } from "./moodle.js";
import { failure, formatTime, relativeTime } from "./format.js";

const server = new McpServer({
  name: "lmcore",
  version: "0.1.0",
});

const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

server.registerTool(
  "lmcore_courses",
  {
    description:
      "List enrolled courses for the signed-in Learning Mall Core user, grouped by timeline status (`inprogress`, `future`, `past`), including the `courseId` required by course-level tools.",
    inputSchema: {},
    annotations: readOnly,
  },
  async () => {
    try {
      const { user, courses } = await listCourses();
      return { content: [{ type: "text" as const, text: JSON.stringify({
        user,
        counts: countBy(courses, (course) => course.classification),
        courses,
      }, null, 2) }] };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "lmcore_deadlines",
  {
    description:
      "List upcoming deadlines and action events (assignments, quizzes, choices) across all enrolled courses within the next N days (default 21). Timestamps are formatted in Asia/Shanghai.",
    inputSchema: {
      days: z.number().int().min(1).max(180).default(21).describe("Number of days ahead to query (1–180)."),
    },
    annotations: readOnly,
  },
  async ({ days }) => {
    try {
      const events = await upcomingDeadlines(days);
      return { content: [{ type: "text" as const, text: JSON.stringify({
        days,
        count: events.length,
        deadlines: events.map((event) => ({
          ...event,
          when: formatTime(event.time),
          fromNow: relativeTime(event.time),
        })),
      }, null, 2) }] };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "lmcore_course_contents",
  {
    description:
      "List sections and activities for a course, including title, module type (`assign`, `quiz`, `forum`, `resource`, `url`, `page`, `folder`), URL, and completion status.",
    inputSchema: {
      courseId: z.number().int().describe("Course ID from lmcore_courses."),
    },
    annotations: readOnly,
  },
  async ({ courseId }) => {
    try {
      const course = await courseContents(courseId);
      const activities = course.sections.reduce((sum, section) => sum + section.modules.length, 0);
      return { content: [{ type: "text" as const, text: JSON.stringify({ courseId, sectionCount: course.sections.length, activities, ...course }, null, 2) }] };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "lmcore_read_file",
  {
    description:
      "Read a file from a `mod/resource` URL returned by lmcore_course_contents. PDF, PowerPoint, and Word files are converted locally to Markdown (capped at 60,000 characters). Built-in extraction has limited accuracy: OCR is disabled, and images, complex tables, formulas, or layout order may be incomplete. If your client supports direct document or multimodal input, set download to true to save the original file locally and read `savedTo` with your own tools (downloading does not attach the file to the model automatically).",
    inputSchema: {
      url: z.string().describe("Resource activity URL (`/mod/resource/view.php?id=...`) from lmcore_course_contents."),
      download: z
        .boolean()
        .default(false)
        .describe("Save the raw source file to disk and return its local path (`savedTo`) instead of extracting text."),
    },
    annotations: readOnly,
  },
  async ({ url, download }) => {
    try {
      const result = await readFiles(url, download);
      const files = result.files.map(({ text, ...file }) => ({ ...file, characters: text.length, text }));
      return { content: [{ type: "text" as const, text: JSON.stringify({ activity: result.activity, count: files.length, files }, null, 2) }] };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "lmcore_assignments",
  {
    description:
      "List all assignments in a course with due dates, submission status, and grades.",
    inputSchema: {
      courseId: z.number().int().describe("Course ID from lmcore_courses."),
    },
    annotations: readOnly,
  },
  async ({ courseId }) => {
    try {
      const rows = await assignments(courseId);
      return { content: [{ type: "text" as const, text: JSON.stringify({ courseId, count: rows.length, assignments: rows }, null, 2) }] };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "lmcore_grades",
  {
    description: "Fetch the signed-in user's grade report items, ranges, percentages, and feedback for a course.",
    inputSchema: {
      courseId: z.number().int().describe("Course ID from lmcore_courses."),
    },
    annotations: readOnly,
  },
  async ({ courseId }) => {
    try {
      return { content: [{ type: "text" as const, text: JSON.stringify({ courseId, ...(await grades(courseId)) }, null, 2) }] };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "lmcore_notifications",
  {
    description: "Fetch the unread notification count and most recent notifications.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).default(10).describe("Maximum number of notifications to return (1–50)."),
    },
    annotations: readOnly,
  },
  async ({ limit }) => {
    try {
      const result = await notifications(limit);
      return { content: [{ type: "text" as const, text: JSON.stringify({
        unread: result.unread,
        notifications: result.items.map((item) => ({ ...item, when: formatTime(item.time) })),
      }, null, 2) }] };
    } catch (error) {
      return failure(error);
    }
  },
);

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  console.error("lmcore-mcp listening on stdio");
}

main().catch((error: unknown) => {
  console.error("lmcore-mcp failed to start:", error);
  process.exit(1);
});
