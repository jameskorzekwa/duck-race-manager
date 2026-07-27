import assert from "node:assert/strict";
import test from "node:test";

import { staffHomeScript } from "./client-scripts.ts";
import {
  renderInventoryIntake,
  renderMyDucks,
  renderStaffDuck,
  renderStaffHome,
} from "./site.ts";

const stylesheetFrom = (markup) => {
  const match = markup.match(/<style>([\s\S]+)<\/style>/);
  assert.ok(match, "rendered page must include the shared stylesheet");
  return match[1];
};

test("shared staff styles keep card and status rhythm without empty whitespace", () => {
  const css = stylesheetFrom(renderStaffHome("Spacing Test", true, []));

  assert.match(css, /--space-xs:\.45rem; --space-sm:\.75rem; --space-md:1rem; --space-lg:1\.4rem/);
  assert.match(css, /\.console-grid \{[^}]*align-items:start/);
  assert.match(css, /\.facts:empty \{ display:none; \}/);
  assert.match(css, /\.data-list:empty \{ display:none; \}/);
  assert.match(css, /form\.operation-card > \* \+ \* \{ margin-top:0; \}/);
  assert.match(css, /\.data-card h3 \{ margin-bottom:0; overflow-wrap:anywhere; \}/);
  // The freshness pill is gone; the live board stage chip replaces its rhythm.
  assert.doesNotMatch(css, /\.freshness\b/);
  assert.match(css, /\.live-board-stage \{[^}]*max-width:100%[^}]*overflow-wrap:anywhere/);
});

test("NFC station renders scoped control, state, history, and logout spacing", () => {
  const markup = renderInventoryIntake("Inventory Staff", "https://quickducks.com");
  const css = stylesheetFrom(markup);

  assert.match(markup, /class="operation-card station-state"/);
  assert.match(css, /\.station-panel > label \{ display:block; \}/);
  assert.match(css, /\[data-intake-controls\] > label,\.station-panel > label \{ display:block; \}/);
  assert.match(css, /\.station-panel > \.operation-card \+ \.operation-card[^}]*margin-top:var\(--space-lg\)/);
  assert.match(css, /\.station-panel > \.station-counters \+ h2[^}]*margin-top:var\(--space-lg\)/);
  assert.match(css, /\[data-intake-controls\] > \.operation-card \+ \.station-counters[^}]*margin-top:var\(--space-lg\)/);
  assert.match(css, /\[data-intake-controls\] > \.muted \+ \.station-history \{ margin-top:var\(--space-md\); \}/);
  assert.match(css, /\.station-state \.message-line \{ min-height:0; \}/);
  assert.match(css, /\.station-counter \{ min-width:0; \}/);
  assert.match(css, /\.station-history li \{[^}]*overflow-wrap:anywhere/);
  assert.match(css, /\.staff-bar-actions > a,\.staff-logout button \{[^}]*min-height:2\.75rem/);
});

test("pairing, readiness, inventory, and staff-role renderers expose spacing hooks", () => {
  const duckMarkup = renderStaffDuck("tag-token", "Registration Staff");
  const homeMarkup = renderStaffHome("Administrator", true, []);
  const css = stylesheetFrom(homeMarkup);

  assert.equal((duckMarkup.match(/class="work-area"/g) ?? []).length, 2);
  assert.match(homeMarkup, /class="operation-card inventory-detail-panel"[^>]*data-inventory-detail hidden/);
  assert.match(css, /\.result-button > \* \{ display:block; \}/);
  assert.match(css, /\.pairing-review > \* \+ \* \{ margin-top:var\(--space-xs\); \}/);
  assert.match(css, /\[data-event-readiness\] \.data-card \{[^}]*gap:var\(--space-sm\)/);
  assert.match(css, /\.inventory-detail-panel > \.facts \{ margin-block:var\(--space-sm\) var\(--space-md\); \}/);
  assert.match(css, /\.inventory-detail-panel > \.actions \{ align-items:center; \}/);
  assert.match(css, /\.inventory-detail-panel > h3 \+ \.data-list \{ margin-top:var\(--space-sm\); \}/);
  assert.match(css, /\.staff-role-controls \{[^}]*flex:1 0 100%/);
  assert.match(css, /\.role-set \{[^}]*grid-template-columns:repeat\(auto-fit,minmax\(10rem,1fr\)\)/);
  assert.match(homeMarkup, /<fieldset class="role-set" data-create-role-set>/);
  assert.match(staffHomeScript, /"actions staff-role-controls"/);
  assert.match(staffHomeScript, /fieldset\.className = "role-set"/);
});

test("My Ducks sections and app dialogs keep the shared spacing rhythm", () => {
  const markup = renderMyDucks();
  const css = stylesheetFrom(markup);

  assert.match(markup, /class="participant-section" data-participant-section="awaiting"/);
  assert.match(markup, /class="participant-section" data-participant-section="paired"/);
  assert.match(css, /\.participant-section \{ margin:2rem 0; padding-top:1\.5rem;/);
  assert.match(css, /\.participant-section-head \{[^}]*gap:\.8rem;/);
  assert.match(css, /\.participant-track \{[^}]*gap:1rem;[^}]*scroll-snap-type:x mandatory;/);
  assert.match(css, /\.app-confirmation h2 \{ margin-bottom:\.75rem;/);
  assert.match(css, /\.app-confirmation-message \{ margin-bottom:1\.5rem;/);
  assert.match(css, /\.app-confirmation-actions \{ display:flex; flex-wrap:wrap; justify-content:flex-end; gap:\.8rem; \}/);
});

test("mobile staff controls retain touch targets and wrapping containment", () => {
  const css = stylesheetFrom(renderStaffHome("Spacing Test", true, []));

  assert.match(css, /\.button \{[^}]*max-width:100%[^}]*overflow-wrap:anywhere/);
  assert.match(css, /\.role-tag \{[^}]*max-width:100%[^}]*overflow-wrap:anywhere/);
  assert.match(css, /@media \(max-width:43\.99rem\)[^{]*\{[^}]*\.shell \{ width:min\(100% - 1rem,40rem\); \}/);
  assert.match(css, /@media \(max-width:43\.99rem\)[\s\S]*\.button\.small \{ min-height:2\.75rem; \}/);
  assert.match(css, /\.button\.small:active:not\(:disabled\) \{ transform:translate\(2px,2px\); \}/);
  assert.match(css, /@media \(max-width:43\.99rem\)[\s\S]*\.role-set > \.check \{ min-height:2\.75rem; \}/);
  assert.match(css, /@media \(max-width:43\.99rem\)[\s\S]*\.site-head \{ flex-wrap:wrap; \}[\s\S]*\.nav \{ width:100%; \}[\s\S]*\.nav a \{ flex:1 1 0;/);
  assert.match(css, /\.staff-role-controls > select,\.staff-role-controls > fieldset \{ min-width:0;/);
});
