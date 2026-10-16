import assert from "node:assert/strict";
import { after, before, describe, mock, test } from "node:test";
import puppeteer from "puppeteer-core";
import { CHROME_PATH } from "../build/config.js";

let activePage;
let closes = 0;
mock.module(new URL("../build/session.js", import.meta.url).href, {
  exports: {
    openSession: async () => ({
      page: activePage,
      browser: { close: async () => { closes++; } },
    }),
    gotoAuthed: async () => {},
    rememberUser: () => {},
    SessionExpiredError: class SessionExpiredError extends Error {},
  },
});
const { courseContents, grades, listCourses, upcomingDeadlines } = await import("../build/moodle.js");

function ajaxPage(handler) {
  return {
    async evaluate(_callback, method, args) {
      if (!method) return { userid: 1, fullname: "Student", username: "", sitename: "Test Moodle" };
      return { error: false, data: handler(method, args) };
    },
  };
}

function courses(first, count) {
  return Array.from({ length: count }, (_, index) => ({
    id: first + index,
    fullname: `Course ${first + index}`,
    shortname: `C${first + index}`,
  }));
}

test("course pagination follows nextoffset through filtered chunks and beyond 500", async () => {
  const offsets = [];
  const chunks = new Map([
    [0, { courses: courses(1, 25), nextoffset: 75 }],
    [75, { courses: [], nextoffset: 130 }],
    [130, { courses: courses(26, 50), nextoffset: 300 }],
    [300, { courses: courses(76, 50), nextoffset: 610 }],
    [610, { courses: courses(126, 1), nextoffset: 700 }],
    [700, { courses: [], nextoffset: 700 }],
  ]);
  activePage = ajaxPage((method, args) => {
    assert.equal(method, "core_course_get_enrolled_courses_by_timeline_classification");
    if (args.classification !== "inprogress") return { courses: [], nextoffset: 0 };
    offsets.push(args.offset);
    assert.equal(args.limit, 50);
    assert.ok(chunks.has(args.offset), `Unexpected offset ${args.offset}`);
    return chunks.get(args.offset);
  });

  const result = await listCourses();
  assert.deepEqual(offsets, [0, 75, 130, 300, 610, 700]);
  assert.deepEqual(result.courses.map((course) => course.id), Array.from({ length: 126 }, (_, i) => i + 1));
  assert.equal(new Set(result.courses.map((course) => course.id)).size, result.courses.length);
  assert.ok(result.courses.every((course) => course.classification === "inprogress"));
});

test("course pagination rejects a nonadvancing cursor and closes its session", async () => {
  activePage = ajaxPage((_method, args) => args.classification === "inprogress"
    ? { courses: courses(1, 1), nextoffset: 0 }
    : { courses: [], nextoffset: 0 });
  const beforeCloses = closes;
  await assert.rejects(listCourses(), /Course pagination did not advance/);
  assert.equal(closes, beforeCloses + 1);
});

test("deadlines use aftereventid without dropping events that share a timestamp", async () => {
  const events = Array.from({ length: 101 }, (_, index) => ({
    id: index + 1,
    name: `Deadline ${index + 1}`,
    timesort: 2_000_000_000,
    url: `https://moodle.example/event/${index + 1}`,
    course: { fullname: "Course" },
    modulename: "assign",
  }));
  const requests = [];
  activePage = ajaxPage((method, args) => {
    assert.equal(method, "core_calendar_get_action_events_by_timesort");
    requests.push(args);
    return { events: events.slice(args.aftereventid, args.aftereventid + args.limitnum) };
  });

  const result = await upcomingDeadlines(7);
  assert.deepEqual(requests.map((args) => args.aftereventid), [0, 50, 100]);
  assert.ok(requests.every((args) => args.timesortfrom === requests[0].timesortfrom));
  assert.ok(requests.every((args) => args.timesortto - args.timesortfrom === 7 * 24 * 60 * 60));
  assert.deepEqual(result.map((event) => event.id), events.map((event) => event.id));
  assert.equal(result.at(-1).component, "assign");
});

test("deadlines reject repeated cursors and close their session", async () => {
  const events = Array.from({ length: 50 }, (_, index) => ({
    id: index + 1, name: "Deadline", timesort: 2_000_000_000, url: "https://moodle.example/event",
  }));
  activePage = ajaxPage(() => ({ events }));
  const beforeCloses = closes;
  await assert.rejects(upcomingDeadlines(7), /Deadline pagination did not advance/);
  assert.equal(closes, beforeCloses + 1);
});

describe("Moodle DOM parsing", () => {
  let browser;
  let page;
  before(async () => {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ["--no-first-run", "--disable-sync"],
    });
    page = await browser.newPage();
  });
  after(async () => { await browser?.close(); });

  test("grades use named columns despite weights, optional columns, and category rowspans", async () => {
    activePage = page;
    await page.setContent(`
      <h1>Test course</h1>
      <table class="user-grade"><tbody>
        <tr><th class="column-itemname category" colspan="8">Category</th></tr>
        <tr><td class="leader" rowspan="3"></td></tr>
        <tr>
          <th class="column-itemname" colspan="2"><span>Assignment</span><div class="rowtitle">Essay</div></th>
          <td class="column-weight">40.00 %</td><td class="column-grade">72.00</td>
          <td class="column-range">0–100</td><td class="column-percentage">72.00 %</td>
          <td class="column-feedback"><p>Good work</p></td><td class="column-rank">3</td>
        </tr>
        <tr>
          <th class="column-itemname">Lab</th><td class="column-range">0–10</td>
          <td class="column-feedback">Awaiting grade</td><td class="column-rank">5</td>
        </tr>
        <tr>
          <th class="column-itemname">Quiz</th><td class="column-percentage">0 %</td>
          <td class="column-grade">0</td><td class="column-weight">60 %</td>
        </tr>
      </tbody></table>
    `);
    assert.deepEqual(await grades(1), {
      course: "Test course",
      items: [
        { name: "Essay", grade: "72.00", range: "0–100", percentage: "72.00 %", feedback: "Good work" },
        { name: "Lab", grade: "", range: "0–10", percentage: "", feedback: "Awaiting grade" },
        { name: "Quiz", grade: "0", range: "", percentage: "0 %", feedback: "" },
      ],
    });
  });

  test("course sections retain empty sections and read automatic and manual completion", async () => {
    activePage = page;
    await page.setContent(`
      <base href="https://moodle.example/"><h1>Test course</h1>
      <ul>
        <li class="section" data-region="section" data-sectionname="Attribute title">
          <div class="activity modtype_assign">
            <a class="aalink" href="mod/assign/view.php?id=1">Essay</a>
            <span data-value="unrelated">Unrelated metadata</span>
            <div data-region="completion-info"><div data-region="completionrequirements" role="list">
              <div class="badge" role="listitem" aria-label="Done: View (Set by Teacher)">Done: View</div>
              <div class="badge" role="listitem" title="To do: Receive a grade">To do: Grade</div>
              <div class="badge" role="listitem"><strong>Done:</strong> Submit</div>
            </div></div>
            <div data-region="activity-dates">Due: tomorrow</div>
          </div>
        </li>
        <li class="section"><h3 class="sectionname"><a>Multipage section</a></h3></li>
        <li class="section">
          <a data-for="sectiontoggler" aria-label="Collapsible section"></a>
          <div class="activity modtype_resource">
            <a class="aalink" href="mod/resource/view.php?id=2">Notes</a>
            <span data-value="unrelated"></span>
            <div class="completion-info"><button data-action="toggle-manual-completion" data-value="1">Done</button></div>
          </div>
          <div class="activity modtype_page">
            <a class="aalink" href="mod/page/view.php?id=3">Read me</a>
            <button data-action="toggle-manual-completion" data-value="0">Mark as done</button>
          </div>
          <div class="activity modtype_label" data-activityname="No completion"><span data-value="not completion"></span></div>
        </li>
        <li class="section hidden"></li>
      </ul>
    `);
    const result = await courseContents(1);
    assert.equal(result.name, "Test course");
    assert.deepEqual(result.sections.map((section) => section.title), [
      "Attribute title", "Multipage section", "Collapsible section", "",
    ]);
    assert.deepEqual(result.sections[1].modules, []);
    assert.equal(result.sections[3].visible, false);
    assert.deepEqual(result.sections[3].modules, []);
    assert.equal(result.sections[0].modules[0].completion,
      "Done: View (Set by Teacher) · To do: Receive a grade · Done: Submit");
    assert.equal(result.sections[0].modules[0].url, "https://moodle.example/mod/assign/view.php?id=1");
    assert.deepEqual(result.sections[2].modules.map((activity) => activity.completion), ["1", "0", ""]);
  });

  test("delegated subsections own their activities, titles, links, and completion state", async () => {
    activePage = page;
    await page.setContent(`
      <base href="https://moodle.example/"><h1>Test course</h1>
      <ul><li class="section" data-sectionname="Parent">
        <div class="activity modtype_subsection" data-activityname="Subsection">
          <li class="section delegated-section"><h3 class="sectionname">Child</h3>
            <div class="activity modtype_resource">
              <a class="aalink" href="mod/resource/view.php?id=1">Child resource</a>
              <div class="completion-info"><span class="badge">Done: View</span></div>
            </div>
          </li>
        </div>
      </li></ul>
      <div data-region="section">
        <div class="activity modtype_subsection">
          <a class="aalink" href="course/view.php?id=1&amp;section=3">Linked subsection</a>
          <div data-region="section"><h3 class="sectionname">Another child</h3>
            <div class="activity modtype_page">
              <a class="aalink" href="mod/page/view.php?id=2">Child page</a>
              <button data-action="toggle-manual-completion" data-value="1">Done</button>
            </div>
          </div>
        </div>
      </div>
    `);
    const result = await courseContents(1);
    assert.deepEqual(result.sections.map((section) => section.title), ["Parent", "Child", "", "Another child"]);
    assert.deepEqual(result.sections.map((section) => section.modules.map((activity) => ({
      name: activity.name, type: activity.type, completion: activity.completion,
    }))), [
      [{ name: "Subsection", type: "subsection", completion: "" }],
      [{ name: "Child resource", type: "resource", completion: "Done: View" }],
      [{ name: "Linked subsection", type: "subsection", completion: "" }],
      [{ name: "Child page", type: "page", completion: "1" }],
    ]);
    assert.equal(result.sections[0].modules[0].url, "");
    assert.equal(result.sections[1].modules[0].url, "https://moodle.example/mod/resource/view.php?id=1");
    assert.equal(result.sections[2].modules[0].url, "https://moodle.example/course/view.php?id=1&section=3");
  });

  test("completion dropdowns read requirement items when status buttons contain only icons", async () => {
    activePage = page;
    await page.setContent(`
      <h1>Test course</h1><li class="section">
        <div class="activity modtype_resource" data-activityname="Notes" role="listitem">
          <div data-region="completion-info"><div data-region="completionrequirements" aria-label="Completion requirements for Notes">
            <div class="completion-dropdown">
              <button data-for="dropdowndialog_button"><i class="fa fa-check"></i></button>
              <div class="dropdown-menu"><div data-for="dropdowndialog_content"><div class="completion-dialog">
                <strong>You must</strong><div role="list">
                  <div class="d-flex mt-2 text-success" role="listitem"><i></i><span class="visually-hidden">Done:</span> <span>View</span></div>
                  <div class="d-flex mt-2" role="listitem"><span class="badge"><span class="visually-hidden">To do:</span> Submit</span></div>
                </div>
              </div></div></div>
            </div>
          </div></div>
        </div>
      </li>
    `);
    const result = await courseContents(1);
    assert.equal(result.sections[0].modules[0].completion, "Done: View · To do: Submit");
  });
});
