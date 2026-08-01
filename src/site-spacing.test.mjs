import assert from "node:assert/strict";
import test from "node:test";

import { staffAccessScript } from "./client-scripts.ts";
import {
  renderAnnouncer,
  renderFinishLine,
  renderStaffInventory,
  renderMyDucks,
  renderStaffAccess,
  renderStaffDuck,
  renderStaffHome,
  renderStartLine,
} from "./site.ts";

const stylesheetFrom = (markup) => {
  const match = markup.match(/<style>([\s\S]+)<\/style>/);
  assert.ok(match, "rendered page must include the shared stylesheet");
  return match[1];
};

test("the shared rounded type uses open tracking instead of compressed letters", () => {
  const css = stylesheetFrom(renderMyDucks());

  assert.match(css, /:root \{[^}]*letter-spacing:\.005em;/);
  assert.match(css, /h1 \{[^}]*letter-spacing:\.005em;/);
  assert.doesNotMatch(css, /letter-spacing:-/);
  assert.match(css, /\.hero \{[^}]*padding-bottom:13\.5rem;/);
  assert.match(css, /@media \(max-width:43\.99rem\)[\s\S]*\.hero \{[^}]*padding:[^;]*17rem;/);
  assert.doesNotMatch(css, /\.home-(?:status|preparing)-card \{[^}]*min-height/);
});

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
  const markup = renderStaffInventory("Inventory Staff", "https://quickducks.com");
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
  assert.match(css, /\.staff-logout button \{[^}]*min-height:2\.75rem/);
});

test("the staff bar is a footer that cannot overflow a narrow screen", () => {
  const css = stylesheetFrom(renderStaffHome("Spacing Test", true, []));

  // Full-width bar, name left and sign out right, and every child bounded so a
  // long display name wraps instead of pushing the page sideways at 320px.
  assert.match(css, /\.staff-bar \{[^}]*display:flex/);
  assert.match(css, /\.staff-bar \{[^}]*flex-wrap:wrap/);
  assert.match(css, /\.staff-bar \{[^}]*width:100%/);
  assert.match(css, /\.staff-bar \{[^}]*max-width:100%/);
  assert.match(css, /\.staff-bar \{[^}]*justify-content:space-between/);
  // It sits below the page, so its margin is above it rather than beneath it.
  assert.match(css, /\.staff-bar \{[^}]*margin:var\(--space-lg\) 0 0/);
  assert.doesNotMatch(css, /\.staff-bar \{[^}]*margin-bottom/);
  assert.match(css, /\.staff-bar > \* \{ min-width:0; max-width:100%; \}/);
  assert.match(css, /\.staff-bar p \{[^}]*overflow-wrap:anywhere/);
  // The action row that used to hold the "Staff home" link is gone entirely.
  assert.doesNotMatch(css, /staff-bar-actions/);
});

test("pairing, readiness, inventory, and staff-role renderers expose spacing hooks", () => {
  const duckMarkup = renderStaffDuck("tag-token", "Registration Staff");
  const homeMarkup = renderStaffHome("Administrator", true, []);
  const css = stylesheetFrom(homeMarkup);

  // Two work areas: pairing, and the emergency replacement of a lost or
  // damaged duck once a round is running. The disposition work area went with
  // returns.
  assert.equal((duckMarkup.match(/class="work-area"/g) ?? []).length, 2);
  assert.match(
    renderStaffInventory("Duck Manager", "https://quickducks.com"),
    /class="operation-card inventory-detail-panel"[^>]*data-inventory-detail hidden/,
  );
  assert.match(css, /\.result-button > \* \{ display:block; \}/);
  assert.match(css, /\.pairing-review > \* \+ \* \{ margin-top:var\(--space-xs\); \}/);
  assert.match(css, /\[data-event-readiness\] \.data-card \{[^}]*gap:var\(--space-sm\)/);
  assert.match(css, /\.inventory-detail-panel > \.facts \{ margin-block:var\(--space-sm\) var\(--space-md\); \}/);
  assert.match(css, /\.inventory-detail-panel > \.actions \{ align-items:center; \}/);
  assert.match(css, /\.inventory-detail-panel > h3 \+ \.data-list \{ margin-top:var\(--space-sm\); \}/);
  assert.match(css, /\.staff-role-controls \{[^}]*flex:1 0 100%/);
  assert.match(css, /\.role-set \{[^}]*grid-template-columns:repeat\(auto-fit,minmax\(10rem,1fr\)\)/);
  // The staff-role controls moved to /staff/access and keep the same hooks.
  assert.match(renderStaffAccess("Administrator"), /<fieldset class="role-set" data-create-role-set>/);
  assert.doesNotMatch(homeMarkup, /data-create-role-set/);
  assert.match(staffAccessScript, /"actions staff-role-controls"/);
  assert.match(staffAccessScript, /fieldset\.className = "role-set"/);
});

test("My Ducks sections and app dialogs keep the shared spacing rhythm", () => {
  const markup = renderMyDucks();
  const css = stylesheetFrom(markup);

  assert.match(markup, /class="participant-section" data-participant-section="awaiting"/);
  assert.match(markup, /class="participant-section" data-participant-section="paired"/);
  assert.match(css, /\.participant-section \{ margin:2rem 0; padding-top:1\.5rem;/);
  assert.match(css, /\.participant-section-head \{[^}]*gap:\.8rem;/);
  assert.match(css, /\.participant-track \{[^}]*gap:1rem;[^}]*scroll-snap-type:x mandatory;/);
  assert.match(css, /\.my-ducks-search > \.privacy \{ margin-top:1\.5rem; \}/);
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

test("every primary staff view uses one shared panel size, color, padding, and title scale", () => {
  const pages = [
    renderStaffHome("Administrator", true, []),
    renderAnnouncer("Administrator", false, true, []),
    renderStartLine("Administrator", false, true, []),
    renderFinishLine("Administrator", false, true, []),
    renderStaffInventory("Administrator", "https://quickducks.com", true, []),
    renderStaffAccess("Administrator", true, []),
    renderStaffDuck("tag-token", "Administrator", true, []),
  ];
  for (const markup of pages) assert.match(markup, /class="page-panel [^"]*staff-panel[^"]*"/);

  const css = stylesheetFrom(pages[0]);
  assert.match(
    css,
    /\.operations-panel,\.station-panel \{ max-width:70rem; padding:clamp\(1rem,3vw,2\.2rem\); background:var\(--paper\); \}/,
  );
  assert.match(
    css,
    /\.operations-title,\.staff-panel > \.page-title \{ max-width:none; margin-bottom:\.6rem; font-size:clamp\(2\.5rem,8vw,5rem\); line-height:\.92; \}/,
  );
  assert.doesNotMatch(css, /\.station-panel \{[^}]*max-width:62rem|\.station-panel \{[^}]*background:#fff/);
});

test("shared controls replace system affordances and keep adjacent actions aligned", () => {
  const css = stylesheetFrom(renderStaffHome("Administrator", true, []));

  assert.match(css, /input\[type="number"\] \{ appearance:textfield; \}/);
  assert.match(css, /\.check input\[type="checkbox"\] \{[^}]*appearance:none;[^}]*background:#fff;/);
  assert.match(css, /\.check input\[type="checkbox"\]:checked \{ background:var\(--yellow\); \}/);
  assert.match(css, /details\.operation-card > summary \{[^}]*min-height:2\.75rem;[^}]*list-style:none;/);
  assert.match(css, /details\.operation-card > summary::before \{[^}]*border-right:3px solid var\(--ink\);/);
  assert.match(css, /\.section-tools > \.button \{ flex:0 0 auto; min-height:3\.2rem; \}/);
});

test("public primary surfaces share the paper color and naming controls always start a new row", () => {
  const css = stylesheetFrom(renderMyDucks());

  assert.match(css, /\.page-panel \{[^}]*background:var\(--paper\);/);
  assert.match(css, /\.live-board \{ border-width:4px; background:var\(--paper\);/);
  assert.match(css, /\.duck-name-toggle \{ display:flex; width:max-content; margin-top:\.7rem;/);
});
