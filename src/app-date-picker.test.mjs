import assert from "node:assert/strict";
import test from "node:test";

import { appDatePickerHelpersScript, appDatePickerScript } from "./client-scripts.ts";
import { createWorker } from "./index.ts";
import { renderStaffHome } from "./site.ts";

const helpers = new Function(
  `${appDatePickerHelpersScript}; return { appDateParse, appDateValue, appDateDisplay, appDateMonthDisplay, appDateTimeDisplay };`,
)();

test("date picker helpers strictly parse and serialize local date values", () => {
  assert.deepEqual(helpers.appDateParse("2028-02-29", "date"), {
    year: 2028, month: 2, day: 29, hour: 0, minute: 0,
  });
  assert.deepEqual(helpers.appDateParse("2028-02-29T23:55", "datetime"), {
    year: 2028, month: 2, day: 29, hour: 23, minute: 55,
  });
  for (const value of ["", "2027-02-29", "2028-13-01", "2028-01-32", "08/11/2026"]) {
    assert.equal(helpers.appDateParse(value, "date"), null, value);
  }
  for (const value of ["2028-02-29T24:00", "2028-02-29T12:60", "2028-02-29 12:00"]) {
    assert.equal(helpers.appDateParse(value, "datetime"), null, value);
  }
  assert.equal(
    helpers.appDateValue({ year: 2028, month: 2, day: 9, hour: 7, minute: 5 }, "datetime"),
    "2028-02-09T07:05",
  );
});

test("date picker labels use readable app text instead of raw ISO values", () => {
  assert.equal(helpers.appDateDisplay("2026-08-11", "date", "en-US"), "Aug 11, 2026");
  assert.match(helpers.appDateDisplay("2026-08-11T09:05", "datetime", "en-US"), /Aug 11, 2026.*9:05 AM/);
  assert.equal(helpers.appDateMonthDisplay(2026, 8, "en-US"), "August 2026");
  assert.equal(helpers.appDateTimeDisplay(13, 5, "en-US"), "1:05 PM");
});

test("staff event dates opt into app controls and expose no system date picker", () => {
  const markup = renderStaffHome("Administrator", true, []);
  const fields = [...markup.matchAll(/<input name="(eventDate|registrationOpensAt|registrationClosesAt)"[^>]*>/g)];

  assert.equal(fields.length, 4);
  assert.equal(fields.filter((match) => match[1] === "eventDate").length, 2);
  for (const [field] of fields) {
    assert.match(field, /type="text"/);
    assert.match(field, /inputmode="none"/);
    assert.match(field, /data-app-date-picker="(?:date|datetime)"/);
    assert.doesNotMatch(field, /type="date"|type="datetime-local"/);
  }
  assert.doesNotMatch(markup, /<input[^>]*type="(?:date|datetime-local)"/);
  const selectAt = markup.indexOf('<script src="/assets/app-select.js" defer></script>');
  const dateAt = markup.indexOf('<script src="/assets/app-date-picker.js" defer></script>');
  const consoleAt = markup.indexOf('<script src="/assets/staff-home.js" defer></script>');
  assert.ok(selectAt >= 0 && selectAt < dateAt && dateAt < consoleAt);
});

test("date picker script is DOM-safe and keeps a form-associated source input", () => {
  assert.doesNotThrow(() => new Function(appDatePickerHelpersScript));
  assert.doesNotThrow(() => new Function(appDatePickerScript));
  assert.doesNotMatch(appDatePickerScript, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(appDatePickerScript, /input\.classList\.add\("app-date-native"\)/);
  assert.match(appDatePickerScript, /input\.dispatchEvent\(new Event\("change", \{ bubbles: true \}\)\)/);
  assert.match(appDatePickerScript, /input\.form\.addEventListener\("reset"/);
  assert.match(appDatePickerScript, /document\.querySelectorAll\("input\[data-app-date-picker\]"\)/);
  assert.match(appDatePickerScript, /Array\.from\(\{ length: 60 \}/, "every minute remains selectable");
  assert.match(appDatePickerScript, /trigger\.setAttribute\("aria-label", fieldLabel \+ ": " \+ visibleValue/);
  assert.match(appDatePickerScript, /doc\.addEventListener\("focusin"/);
  assert.match(appDatePickerScript, /if \(changed && openState\) close\(true\);/);
  assert.match(appDatePickerScript, /delete select\.dataset\.liveDirty/);
  assert.match(appDatePickerScript, /button\.tabIndex = selected \? 0 : -1/);
  assert.match(appDatePickerScript, /if \(openState\) close\(true\);/);
});

test("date picker styling uses the shared control, card, focus, and touch-target language", () => {
  const markup = renderStaffHome("Administrator", true, []);

  assert.match(markup, /\.app-date-trigger \{[^}]*min-height:3\.2rem;[^}]*border:2px solid var\(--ink\); border-radius:\.65rem; background:#fff;/);
  assert.match(markup, /\.app-date-panel \{ position:absolute; z-index:70;[^}]*padding:var\(--space-md\);[^}]*border:3px solid var\(--ink\); border-radius:\.9rem; background:var\(--paper\); box-shadow:5px 5px 0 var\(--ink\); \}/);
  assert.match(markup, /\.app-date-day,\.app-date-blank \{[^}]*min-height:2\.75rem;/);
  assert.match(markup, /\.app-date-day\[aria-pressed="true"\] \{[^}]*background:var\(--yellow\);/);
  assert.match(markup, /\.app-date-time-fields \{ display:grid; grid-template-columns:repeat|\.app-date-time-fields \{ display:grid; grid-template-columns:minmax/);
  assert.match(markup, /input\.app-date-native \{ position:absolute; width:1px; height:1px;[^}]*clip-path:inset\(50%\); opacity:0;/);
  assert.doesNotMatch(markup, /input\.app-date-native \{[^}]*display:none/);
  assert.match(markup, /@media \(max-width:43\.99rem\)[^]*\.app-date-panel \{ position:fixed; top:1rem; right:1rem; left:1rem; width:auto; max-height:calc\(100vh - 2rem\); \}/);
  assert.match(markup, /@media \(max-width:43\.99rem\)[^]*\.app-date-panel \{ max-height:calc\(100dvh - 2rem\); \}/);
});

test("the worker serves the date picker asset uncached", async () => {
  const worker = createWorker();
  const env = { APP_ORIGIN: "https://quickducks.com" };
  const response = await worker.fetch(new Request("https://quickducks.com/assets/app-date-picker.js"), env);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/javascript/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(body, /createAppDatePicker/);
  assert.match(body, /aria-haspopup", "dialog"/);
});
