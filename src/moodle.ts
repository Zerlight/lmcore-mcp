import type { Page } from "puppeteer-core";
import { BASE_URL } from "./config.js";
import { gotoAuthed, openSession, rememberUser, SessionExpiredError } from "./session.js";

/** Response envelope returned by Moodle's `/lib/ajax/service.php` endpoint. */
interface AjaxResult<T> {
  error: boolean;
  data?: T;
  exception?: { message?: string; errorcode?: string };
}

async function ajax<T>(page: Page, methodname: string, args: Record<string, unknown>): Promise<T> {
  const result = await page.evaluate(
    async (method: string, methodArgs: Record<string, unknown>, base: string) => {
      const sesskey =
        (window as unknown as { M?: { cfg?: { sesskey?: string } } }).M?.cfg?.sesskey ?? "";
      const response = await fetch(`${base}/lib/ajax/service.php?sesskey=${sesskey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([{ index: 0, methodname: method, args: methodArgs }]),
      });
      const json = (await response.json()) as Array<{
        error: boolean;
        data?: unknown;
        exception?: { message?: string; errorcode?: string };
      }>;
      return json[0];
    },
    methodname,
    args,
    BASE_URL,
  );
  const typed = result as AjaxResult<T> | undefined;
  if (!typed) throw new Error(`${methodname} returned nothing.`);
  if (typed.error) {
    if (typed.exception?.errorcode === "servicerequireslogin") throw new SessionExpiredError();
    throw new Error(typed.exception?.message ?? `${methodname} failed.`);
  }
  return typed.data as T;
}

export interface SiteInfo {
  userid: number;
  fullname: string;
  username: string;
  sitename: string;
}

/** Extracts the signed-in user's ID, full name, and site title from the current Moodle page. */
async function readUser(page: Page): Promise<SiteInfo> {
  const info = await page.evaluate(() => {
    const cfg = (window as unknown as { M?: { cfg?: { userId?: number } } }).M?.cfg;
    const marked = document.querySelector<HTMLElement>("[data-userid]");
    const sitename = document.querySelector(".navbar-brand")?.getAttribute("aria-label") ?? "";
    return {
      userid: Number(cfg?.userId ?? marked?.dataset.userid ?? 0),
      fullname: document.querySelector("#user-menu-toggle")?.getAttribute("title")?.trim() ?? "",
      username: "",
      sitename,
    };
  });
  if (!info.userid) throw new SessionExpiredError();
  return { userid: info.userid, fullname: info.fullname, username: info.username, sitename: info.sitename };
}

export interface Course {
  id: number;
  fullname: string;
  shortname: string;
  /** Timeline classification: `"inprogress"`, `"past"`, or `"future"`. */
  classification: string;
  progress: number | null;
  viewurl: string;
}

interface TimelineCourse {
  id: number;
  fullname: string;
  shortname: string;
  progress?: number | null;
  viewurl?: string;
}

async function loadClassification(page: Page, classification: string): Promise<Course[]> {
  const courses: Course[] = [];
  const seen = new Set<number>();
  const limit = 50;
  for (let offset = 0; ; ) {
    const data = await ajax<{ courses: TimelineCourse[]; nextoffset: number }>(
      page,
      "core_course_get_enrolled_courses_by_timeline_classification",
      { classification, limit, offset, sort: "fullname" },
    );
    for (const course of data.courses) {
      if (seen.has(course.id)) continue;
      seen.add(course.id);
      courses.push({
        id: course.id,
        fullname: course.fullname,
        shortname: course.shortname,
        classification,
        progress: course.progress ?? null,
        viewurl: course.viewurl ?? `${BASE_URL}/course/view.php?id=${course.id}`,
      });
    }
    // Moodle increments `nextoffset` across all enrolments before filtering by classification.
    if (data.nextoffset === offset && !data.courses.length) break;
    if (!Number.isSafeInteger(data.nextoffset) || data.nextoffset <= offset) {
      throw new Error("Course pagination did not advance.");
    }
    offset = data.nextoffset;
  }
  return courses;
}

export async function listCourses(): Promise<{ user: SiteInfo; courses: Course[] }> {
  const { browser, page } = await openSession();
  try {
    await gotoAuthed(page, "/my/courses.php");
    const user = await readUser(page);
    rememberUser(user.userid, user.fullname);
    const groups = await Promise.all(
      ["inprogress", "future", "past"].map((classification) =>
        loadClassification(page, classification),
      ),
    );
    return { user, courses: groups.flat() };
  } finally {
    await browser.close();
  }
}

export interface Deadline {
  id: number;
  name: string;
  courseName: string;
  /** Due timestamp in Unix seconds. */
  time: number;
  url: string;
  /** Moodle module name (e.g. `"assign"`, `"quiz"`, `"choice"`). */
  component: string;
}

interface ActionEvent {
  id: number;
  name: string;
  course?: { fullname?: string };
  timesort: number;
  url: string;
  modulename?: string;
  component?: string;
}

export async function upcomingDeadlines(days: number): Promise<Deadline[]> {
  const { browser, page } = await openSession();
  try {
    await gotoAuthed(page, "/my/");
    const now = Math.floor(Date.now() / 1000);
    const events: ActionEvent[] = [];
    const cursors = new Set<number>([0]);
    const limitnum = 50;
    let aftereventid = 0;
    for (;;) {
      const data = await ajax<{ events: ActionEvent[] }>(
        page,
        "core_calendar_get_action_events_by_timesort",
        { timesortfrom: now, timesortto: now + days * 24 * 60 * 60, limitnum, aftereventid },
      );
      events.push(...data.events);
      if (data.events.length < limitnum) break;
      aftereventid = data.events.at(-1)!.id;
      if (cursors.has(aftereventid)) throw new Error("Deadline pagination did not advance.");
      cursors.add(aftereventid);
    }
    return events.map((event) => ({
      id: event.id,
      name: event.name,
      courseName: event.course?.fullname ?? "",
      time: event.timesort,
      url: event.url,
      component: event.modulename ?? event.component ?? "",
    }));
  } finally {
    await browser.close();
  }
}

export interface Notification {
  id: number;
  subject: string;
  text: string;
  time: number;
  read: boolean;
}

interface PopupNotification {
  id: number;
  subject?: string;
  smallmessage?: string;
  text?: string;
  timecreated: number;
  read: boolean;
}

export async function notifications(limit: number): Promise<{ unread: number; items: Notification[] }> {
  const { browser, page } = await openSession();
  try {
    await gotoAuthed(page, "/my/");
    const user = await readUser(page);
    const [count, list] = await Promise.all([
      ajax<number>(page, "message_popup_get_unread_popup_notification_count", { useridto: user.userid }),
      ajax<{ notifications: PopupNotification[] }>(page, "message_popup_get_popup_notifications", {
        useridto: user.userid,
        limit,
        offset: 0,
      }),
    ]);
    return {
      unread: count,
      items: list.notifications.map((item) => ({
        id: item.id,
        subject: item.subject ?? "",
        text: item.smallmessage ?? item.text ?? "",
        time: item.timecreated,
        read: item.read,
      })),
    };
  } finally {
    await browser.close();
  }
}

export interface CourseSection {
  title: string;
  visible: boolean;
  modules: CourseModule[];
}

export interface CourseModule {
  name: string;
  type: string;
  url: string;
  /** Completion status reported by Moodle (e.g. `"1"`, `"0"`, or requirement badges). */
  completion: string;
}

/**
 * Scrapes sections and activities from `/course/view.php` (the web service
 * endpoint for course contents is disabled for browser sessions on this site).
 */
export async function courseContents(courseId: number): Promise<{ name: string; sections: CourseSection[] }> {
  const { browser, page } = await openSession();
  try {
    await gotoAuthed(page, `/course/view.php?id=${courseId}`);
    return await page.evaluate(() => {
      const name = document.querySelector("h1")?.textContent?.trim() ?? "";
      const sections: CourseSection[] = [];
      const sectionSelector = '[data-region="section"], li.section';
      for (const region of document.querySelectorAll<HTMLElement>(sectionSelector)) {
        const inSection = (selector: string) => [...region.querySelectorAll<HTMLElement>(selector)]
          .find((element) => element.closest(sectionSelector) === region);
        const title =
          region.dataset.sectionname?.trim() ||
          inSection('[data-for="sectiontoggler"]')?.getAttribute("aria-label")?.trim() ||
          inSection(".sectionname")?.textContent?.trim() ||
          "";
        const modules: CourseModule[] = [];
        for (const activity of region.querySelectorAll<HTMLElement>(".activity")) {
          // Skip activities inside nested delegated subsections so each section owns only its direct children.
          if (activity.closest(sectionSelector) !== region) continue;
          const inActivity = <T extends Element>(selector: string) => [...activity.querySelectorAll<T>(selector)]
            .find((element) => element.closest(".activity") === activity && element.closest(sectionSelector) === region);
          const link = inActivity<HTMLAnchorElement>("a.aalink, .activityname a");
          const completion = inActivity<HTMLElement>(
            '[data-region="completion-info"], .completion-info, [data-region="completionrequirements"], [data-action="toggle-manual-completion"]',
          );
          const manual = completion?.getAttribute("data-value") ??
            completion?.querySelector("[data-value]")?.getAttribute("data-value");
          const requirementSelector = '.badge, [role="listitem"]';
          const automatic = [...(completion?.querySelectorAll(requirementSelector) ?? [])]
            .filter((item) => {
              const ancestor = item.parentElement?.closest(requirementSelector);
              return !ancestor || !completion?.contains(ancestor);
            })
            .map((item) =>
              (item.getAttribute("aria-label") || item.getAttribute("title") || item.textContent || "")
                .replace(/\s+/g, " ").trim(),
            ).filter(Boolean).join(" · ");
          modules.push({
            name: link?.textContent?.trim() ?? activity.dataset.activityname ?? "",
            type: activity.className.match(/modtype_(\w+)/)?.[1] ?? "",
            url: link?.href ?? "",
            completion: manual ?? automatic,
          });
        }
        sections.push({ title, visible: !region.classList.contains("hidden"), modules });
      }
      return { name, sections };
    });
  } finally {
    await browser.close();
  }
}

export interface AssignmentSummary {
  id: number;
  name: string;
  status: string;
  due: string;
  grade: string;
  url: string;
}

/**
 * Scrapes the course assignment index table (`/mod/assign/index.php`), which
 * lists due dates, submission status, and grades in a single view.
 */
export async function assignments(courseId: number): Promise<AssignmentSummary[]> {
  const { browser, page } = await openSession();
  try {
    await gotoAuthed(page, `/mod/assign/index.php?id=${courseId}`);
    return await page.evaluate(() => {
      const rows: AssignmentSummary[] = [];
      for (const row of document.querySelectorAll<HTMLTableRowElement>("table tbody tr")) {
        const link = row.querySelector<HTMLAnchorElement>("a[href*='mod/assign/view.php']");
        if (!link) continue;
        const cells = [...row.querySelectorAll("td")].map((cell) => cell.innerText.replace(/\s+/g, " ").trim());
        rows.push({
          id: Number(new URL(link.href).searchParams.get("id") ?? 0),
          name: link.innerText.replace(/\s+/g, " ").trim(),
          due: cells[1] ?? "",
          status: [cells[2], cells[3]].filter(Boolean).join(" · "),
          grade: cells[4] ?? "",
          url: link.href,
        });
      }
      return rows;
    });
  } finally {
    await browser.close();
  }
}

export interface GradeItem {
  name: string;
  grade: string;
  range: string;
  percentage: string;
  feedback: string;
}

/** Scrapes the user grade report table (`/grade/report/user/index.php`) for a course. */
export async function grades(courseId: number): Promise<{ course: string; items: GradeItem[] }> {
  const { browser, page } = await openSession();
  try {
    await gotoAuthed(page, `/grade/report/user/index.php?id=${courseId}`);
    return await page.evaluate(() => {
      const course = document.querySelector("h1, .page-header-headings")?.textContent?.trim() ?? "";
      const items: GradeItem[] = [];
      for (const row of document.querySelectorAll<HTMLTableRowElement>("table.user-grade tbody tr")) {
        const text = (cell: Element | null) => cell?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const nameCell = row.querySelector(".column-itemname");
        if (!nameCell || nameCell.classList.contains("category")) continue;
        const name = text(nameCell.querySelector(".rowtitle") ?? nameCell);
        if (!name) continue;
        items.push({
          name,
          grade: text(row.querySelector(".column-grade")),
          range: text(row.querySelector(".column-range")),
          percentage: text(row.querySelector(".column-percentage")),
          feedback: text(row.querySelector(".column-feedback")),
        });
      }
      return { course, items };
    });
  } finally {
    await browser.close();
  }
}
