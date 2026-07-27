import assert from "node:assert/strict";
import test from "node:test";

import { participantScript } from "./client-scripts.ts";
import {
  homeScript,
  renderDuck,
  renderFinishLine,
  renderHome,
  renderInventoryIntake,
  renderInventoryIntakeUnsupported,
  renderMyDucks,
  renderPublicDuck,
  renderPublicDuckNotFound,
  renderRegistration,
  renderStaffAccess,
  renderStaffDuck,
  renderStaffHome,
  renderStaffLogin,
  renderStaffPairing,
  renderStartLine,
  renderStatus,
} from "./site.ts";

const renderedPages = [
  renderHome(),
  renderMyDucks(),
  renderRegistration(),
  renderRegistration("test-site-key"),
  renderStatus(),
  renderDuck(),
  renderPublicDuck(),
  renderPublicDuckNotFound("128"),
  renderStaffLogin(),
  renderStaffHome("Administrator", true, []),
  renderStaffAccess("Administrator"),
  renderStartLine("Start staff", false),
  renderFinishLine("Finish staff", false),
  renderInventoryIntake("Inventory staff", "https://quickducks.com"),
  renderInventoryIntakeUnsupported("Inventory staff"),
  renderStaffDuck("a".repeat(32), "Registration staff"),
  renderStaffPairing(),
];

const style = renderedPages[0].match(/<style>([\s\S]+)<\/style>/)?.[1];

test("shared CSS prevents intrinsic form and card widths from escaping containers", () => {
  assert.ok(style);
  assert.match(style, /\* \{ box-sizing:border-box; \}/);
  assert.match(style, /body \{[^}]*overflow-wrap:anywhere;/);
  assert.doesNotMatch(style, /body \{[^}]*min-width:/);
  assert.match(style, /\.site-head \{[^}]*flex-wrap:wrap;/);
  assert.match(style, /form \{[^}]*width:100%; min-width:0; max-width:100%;/);
  assert.match(style, /\.field-grid \{[^}]*min-width:0; max-width:100%;/);
  assert.match(style, /\.field-grid > \*,form > \*,label,fieldset \{ min-width:0; max-width:100%; \}/);
  assert.match(style, /input,select,textarea \{[^}]*width:100%; min-width:0; max-width:100%;/);
  assert.match(style, /button \{ min-width:0; max-width:100%; overflow-wrap:anywhere; white-space:normal; \}/);
  assert.match(style, /\.button \{[^}]*min-width:0; max-width:100%;[^}]*overflow-wrap:anywhere;[^}]*white-space:normal;/);
  assert.match(style, /\.actions > \* \{ min-width:0; max-width:100%; \}/);
  assert.match(style, /\.staff-access-card > \* \{ min-width:0; max-width:100%; \}/);
  assert.match(style, /\.section-tools > label \{[^}]*min-width:0; max-width:100%;/);
  assert.match(style, /\.check \{[^}]*grid-template-columns:1\.4rem minmax\(0,1fr\);/);
  assert.match(style, /\.field-grid \{ grid-template-columns:repeat\(2,minmax\(0,1fr\)\); \}/);
  assert.match(style, /\.console-grid \{ grid-template-columns:repeat\(2,minmax\(0,1fr\)\); \}/);
  assert.match(style, /\.cards \{ grid-template-columns:repeat\(3,minmax\(0,1fr\)\); \}/);
});

test("pressing a button fully depresses it, distinct from the hover half-press", () => {
  assert.ok(style);
  assert.match(style, /\.button \{[^}]*box-shadow:4px 4px 0 var\(--ink\);/);
  assert.match(style, /\.button:hover,\.button:focus-visible \{ outline:none; box-shadow:2px 2px 0 var\(--ink\); transform:translate\(2px,2px\); \}/);
  assert.match(style, /\.button:active:not\(:disabled\) \{ box-shadow:none; filter:brightness\(\.92\); transform:translate\(4px,4px\); \}/);
  assert.match(style, /\.button\.small:active:not\(:disabled\) \{ transform:translate\(2px,2px\); \}/);
  assert.match(style, /\.result-button:active:not\(:disabled\) \{ background:#e4f4f8; filter:brightness\(\.97\); transform:translate\(1px,1px\); \}/);
});

test("disabled controls never react to presses and motion stays gated and tiny", () => {
  assert.ok(style);
  assert.doesNotMatch(style, /:active(?!:not\(:disabled\))/);
  assert.match(style, /\.button:active:not\(:disabled\)[\s\S]*\.button:disabled \{ opacity:\.55; box-shadow:none; cursor:not-allowed; transform:none; \}/);
  assert.match(style, /\.result-button:active:not\(:disabled\)[\s\S]*\.result-button:disabled \{ opacity:\.55; cursor:not-allowed; \}/);
  assert.match(style, /@media \(prefers-reduced-motion:no-preference\) \{ \.button,\.result-button \{ transition:transform 80ms ease-out,box-shadow 80ms ease-out,filter 80ms ease-out,background-color 80ms ease-out; \}/);
  assert.doesNotMatch(style, /transition:[^;}]*(?:\d{3,}(?:\.\d+)?ms|\d(?:\.\d+)?s)/);
});

test("newer My Ducks, inventory panel, and app dialog surfaces stay contained", () => {
  const myDucks = renderMyDucks();
  const staffHome = renderStaffHome("Administrator", true, []);

  assert.match(myDucks, /class="participant-track" id="awaiting-participants" data-participant-track/);
  assert.match(style, /\.participant-track \{[^}]*overflow-x:auto;[^}]*scroll-snap-type:x mandatory;/);
  assert.match(style, /\.participant-card \{ flex:0 0 min\(30rem,calc\(100% - 3rem\)\); min-width:0;/);
  assert.match(style, /\.page-panel\.my-ducks-panel \{ max-width:70rem; \}/);
  assert.match(staffHome, /class="operation-card inventory-detail-panel"[^>]*data-inventory-detail hidden/);
  assert.match(style, /\.inventory-detail-panel \{ min-width:0;/);
  assert.match(style, /\.inventory-card-grid \{ grid-template-columns:repeat\(auto-fit,minmax\(min\(100%,14rem\),1fr\)\);/);
  assert.match(style, /\.app-confirmation \{ width:min\(34rem,calc\(100% - 2rem\)\);/);
  assert.match(style, /\.app-confirmation-message \{[^}]*overflow-wrap:anywhere;/);
});

test("every rendered form class remains covered by the shared form constraints", () => {
  const formClasses = new Set();
  let openingForms = 0;
  let closingForms = 0;

  for (const page of renderedPages) {
    openingForms += [...page.matchAll(/<form\b([^>]*)>/g)].length;
    closingForms += [...page.matchAll(/<\/form>/g)].length;
    for (const match of page.matchAll(/<form\b([^>]*)>/g)) {
      const classValue = match[1].match(/\bclass="([^"]+)"/)?.[1];
      for (const className of classValue?.split(/\s+/) ?? []) formClasses.add(className);
    }
  }

  // 34 on the console after staff access moved out, plus the access page's
  // grant form and the sign-out form every staff page renders.
  assert.equal(openingForms, 36);
  assert.equal(closingForms, openingForms);
  assert.deepEqual([...formClasses].sort(), [
    "danger-zone",
    "operation-card",
    "search-form",
    "section-tools",
    "staff-logout",
  ]);
  assert.match(style, /form \{[^}]*min-width:0; max-width:100%;/);
});

test("no rendered page ships a freshness indicator or its stylesheet rule", () => {
  assert.ok(style);
  assert.doesNotMatch(style, /\.freshness\b/);
  for (const page of renderedPages) {
    assert.doesNotMatch(page, /class="freshness"/);
    assert.doesNotMatch(page, /data-live-freshness|data-station-freshness|data-my-ducks-freshness/);
    assert.doesNotMatch(page, /Updated just now|Updates are arriving live|Checking for fresh updates/);
    assert.doesNotMatch(page, /Reconnecting; this (?:page|station) is still checking/);
    assert.doesNotMatch(page, /Updates are delayed|Saved registrations are temporarily unavailable/);
  }
});

test("stations keep their actionable message lines after freshness removal", () => {
  const startLine = renderStartLine("Start staff", false);
  const finishLine = renderFinishLine("Finish staff", false);
  const intake = renderInventoryIntake("Inventory staff", "https://quickducks.com");

  for (const markup of [startLine, finishLine]) {
    assert.match(markup, /class="message-line muted" data-station-message aria-live="polite"/);
    assert.match(markup, /data-station-event/);
  }
  assert.match(intake, /data-intake-message/);
});

test("the live board exposes a stage chip on every page that renders it", () => {
  const boardPages = [renderHome(), renderStatus(), renderDuck()];

  for (const markup of boardPages) {
    assert.match(markup, /<p class="status-chip live-board-stage" data-live-board-stage aria-live="polite">Loading race stage…<\/p>/);
    assert.match(markup, /<h2 class="live-board-title" id="live-board-title" data-live-board-title>/);
    assert.match(markup, /data-live-board-summary/);
    assert.match(markup, /<p class="message-line muted" data-live-board-error role="alert" hidden><\/p>/);
    assert.match(markup, /data-live-board-content/);
  }
  assert.match(style, /\.live-board-stage \{[^}]*background:var\(--yellow\)/);
  assert.equal(renderMyDucks().includes("data-live-board-stage"), false);
});

test("the how-it-works cards describe the race without linking anywhere", () => {
  const home = renderHome();
  const explainers = home.match(/<section id="how-it-works"[\s\S]*?<\/section>/)?.[0];

  assert.ok(explainers);
  for (const heading of ["Before the race", "At check-in", "On race day"]) {
    assert.ok(explainers.includes(`<strong>${heading}</strong>`), heading);
  }
  assert.match(explainers, /<h3>Register in under a minute<\/h3>/);
  assert.match(explainers, /<h3>Staff pair your selected duck<\/h3>/);
  assert.match(explainers, /<h3>One clear source of truth<\/h3>/);
  assert.equal((explainers.match(/<a\b/g) ?? []).length, 0);
  assert.doesNotMatch(explainers, /card-link/);
  assert.doesNotMatch(home, /Open registration →|Open staff tools →|Preview status →/);
  assert.doesNotMatch(home, /href="\/r\/mock"/);
  // The class survives only because the My Ducks private-status link still uses it.
  assert.match(style, /\.card-link \{/);
  assert.match(participantScript, /participantText\("a", "Open private status", "card-link"\)/);
});

test("My Ducks ships no per-section empty state and stays gated until data loads", () => {
  const myDucks = renderMyDucks();

  for (const kind of ["awaiting", "paired"]) {
    assert.match(
      myDucks,
      new RegExp(`<section class="participant-section" data-participant-section="${kind}" aria-labelledby="[a-z-]+" hidden>`),
    );
  }
  assert.doesNotMatch(myDucks, /data-carousel-empty/);
  assert.doesNotMatch(myDucks, /No participants are waiting for a duck|No paired ducks are saved on this device yet/);
  assert.match(myDucks, /<p class="empty-state" data-my-ducks-empty hidden>No registrations are saved on this device yet\./);
  assert.match(myDucks, /<h2 id="awaiting-participants-title">Awaiting Participants<\/h2>/);
  assert.match(myDucks, /<h2 id="paired-participants-title">My Ducks<\/h2>/);
  assert.match(myDucks, /data-carousel-controls hidden/);
  assert.match(myDucks, /data-participant-track tabindex="0" aria-label="Awaiting participant registrations" hidden/);
});

test("search results style an add-to-My-Ducks action with the shared button conventions", () => {
  assert.match(homeScript, /"\/api\/v1\/registrations\/mine\/follow"/);
  assert.match(homeScript, /createText\("button", "Add to My Ducks", "button small"\)/);
  assert.match(homeScript, /button\.type = "button"/);
  assert.match(homeScript, /createText\("span", "In My Ducks", "success-tag"\)/);
  assert.match(style, /\.button\.small \{/);
  assert.match(style, /\.success-tag \{/);
  assert.match(style, /\.duck-card > \.actions \{ margin-top:\.75rem; \}/);
  // The public search carries no staff code and no private token, so no result
  // card can read or render either one.
  assert.doesNotMatch(homeScript, /lookupCode|Staff lookup code|privateStatusPath|privateToken/i);
  assert.doesNotMatch(homeScript, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
});

test("registration uses the responsive Turnstile widget contract", () => {
  const registration = renderRegistration("test-site-key");

  assert.match(registration, /class="cf-turnstile"[^>]*data-size="flexible"/);
  assert.match(style, /\.cf-turnstile,\.turnstile-mock \{ width:100%; min-width:0; max-width:100%; \}/);
});

const duckStatus = (overrides = {}) => ({
  event: {
    id: "event_mock",
    slug: "summer-duck-race",
    name: "Summer Duck Race",
    eventDate: "2026-08-30",
    status: "FINAL",
  },
  participantDisplayName: "Jamie R.",
  duck: { visibleNumber: 128 },
  assignedHeat: { roundOne: { number: 7, status: "FINALIZED" }, final: { number: 1, status: "RUNNING" } },
  currentHeat: { round: "FINAL", number: 1, status: "RUNNING" },
  outcome: "FINALIST",
  ...overrides,
});

test("the public duck detail view renders every promised public fact", () => {
  const markup = renderPublicDuck(duckStatus());
  const facts = [...markup.matchAll(/<dt>([^<]+)<\/dt><dd>([^<]*)<\/dd>/g)].map((match) => [match[1], match[2]]);

  assert.deepEqual(facts, [
    ["Participant", "Jamie R."],
    ["Duck", "Duck #128"],
    ["Round one heat", "Heat 7 · Result official"],
    ["Final heat", "Heat 1 · Racing now"],
    ["Currently running", "Final · Heat 1 · Racing now"],
    ["Race status", "Finalist"],
  ]);
  assert.match(markup, /<h1 class="page-title">Duck #128<\/h1>/);
  assert.match(markup, /<meta name="robots" content="noindex,nofollow">/);
  // It follows the same live contract as the other public duck/status pages.
  assert.match(markup, /<div data-live-personal="number">/);
  assert.match(markup, /data-live-board/);
  assert.match(markup, /src="\/assets\/live\.js"/);
});

test("the public duck detail view reports an official finishing place only when decided", () => {
  const official = {
    FIRST_PLACE: "1st place · Official podium",
    SECOND_PLACE: "2nd place · Official podium",
    THIRD_PLACE: "3rd place · Official podium",
    FINAL_COMPLETE: "Finished the final · Off the podium",
    ROUND_ONE_WINNER: "Won its round-one heat",
    ELIMINATED: "Did not advance past round one",
  };

  for (const [outcome, label] of Object.entries(official)) {
    const markup = renderPublicDuck(duckStatus({ outcome }));
    assert.match(markup, new RegExp(`<dt>Official result</dt><dd>${label.replace(/[.*+?^$()|[\]\\]/g, "\\$&")}</dd>`), outcome);
  }
  for (const outcome of ["NOT_RACED", "RUNNING", "AWAITING_RESULT", "FINALIST", "HEAT_ASSIGNMENT_PENDING", "WITHDRAWN"]) {
    assert.doesNotMatch(renderPublicDuck(duckStatus({ outcome })), /Official result/, outcome);
  }
});

test("the public duck detail view degrades cleanly before heats and results exist", () => {
  const markup = renderPublicDuck(duckStatus({
    assignedHeat: { roundOne: null, final: null },
    currentHeat: null,
    outcome: "AWAITING_DUCK_PAIRING",
    duck: null,
  }));

  assert.match(markup, /<dt>Duck<\/dt><dd>Waiting for duck assignment<\/dd>/);
  assert.match(markup, /<dt>Round one heat<\/dt><dd>Not assigned yet<\/dd>/);
  assert.match(markup, /<dt>Final heat<\/dt><dd>Not in the final<\/dd>/);
  assert.match(markup, /<dt>Currently running<\/dt><dd>No heat is running right now<\/dd>/);
});

test("the public duck detail view escapes server values and shows no private material", () => {
  const markup = renderPublicDuck(duckStatus({
    participantDisplayName: `Jamie "R" <script>alert(1)</script>`,
    event: { ...duckStatus().event, name: "Summer & <b>Duck</b> Race" },
  }));

  assert.doesNotMatch(markup, /<script>alert\(1\)<\/script>/);
  assert.match(markup, /Jamie &quot;R&quot; &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(markup, /Summer &amp; &lt;b&gt;Duck&lt;\/b&gt; Race/);
  assert.doesNotMatch(markup, /lookup code|private status link|href="\/t\//i);
  assert.match(markup, /never contact information, staff codes, private links, or the duck’s tag/);
});

test("the duck not-found view is friendly, terminal, and reveals nothing extra", () => {
  const markup = renderPublicDuckNotFound("4096");
  const panel = markup.match(/<section class="page-panel">[\s\S]*?<\/section>/)?.[0];

  assert.ok(panel);
  assert.match(markup, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(panel, /Duck #4096 isn’t racing\./);
  assert.match(panel, /No duck with this number is paired with a participant in the current race\./);
  assert.match(panel, /<a class="button" href="\/">Back to the race board<\/a>/);
  // No live surface, no board, and no wording that separates the possible causes.
  assert.doesNotMatch(markup, /data-live-personal|data-live-board|assets\/live\.js/);
  assert.doesNotMatch(panel, /inventory|available|reserved|unpaired|unknown|does not exist/i);
  // The requested number is echoed back escaped, never as raw markup.
  assert.match(renderPublicDuckNotFound("<b>1</b>"), /Duck #&lt;b&gt;1&lt;\/b&gt; isn’t racing\./);
});

test("the duck number link style is shared by the board and My Ducks", () => {
  assert.ok(style);
  assert.match(style, /\.duck-number-link \{[^}]*text-decoration:underline;/);
  assert.match(style, /\.duck-number-link:focus-visible \{ outline:4px solid #83d8ec; outline-offset:2px; \}/);
  assert.match(participantScript, /duckDetailLink\(document, status\.duck \? status\.duck\.visibleNumber : null\)/);
});
