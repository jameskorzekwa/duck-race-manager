import assert from "node:assert/strict";
import test from "node:test";

import { participantScript } from "./client-scripts.ts";
import {
  renderDuck,
  renderFinishLine,
  renderHome,
  renderStaffInventory,
  renderMyDucks,
  renderPublicDuck,
  renderPublicDuckNotFound,
  renderRace,
  renderRegistration,
  renderStaffAccess,
  renderStaffDuck,
  renderStaffHome,
  renderStaffLogin,
  renderStaffPairing,
  renderStaffRegistration,
  renderStartLine,
  renderStatus,
  searchScript,
} from "./site.ts";

const renderedPages = [
  renderHome("REGISTRATION"),
  renderHome(),
  renderMyDucks("REGISTRATION"),
  renderRegistration(undefined, "REGISTRATION"),
  renderRegistration("test-site-key", "REGISTRATION"),
  renderRegistration(),
  renderRegistration(undefined, "RACING"),
  renderRace("RACING"),
  renderRace(),
  renderStatus(),
  renderDuck(),
  renderPublicDuck(),
  renderPublicDuckNotFound("128"),
  renderStaffLogin(),
  renderStaffHome("Administrator", true, []),
  renderStaffAccess("Administrator"),
  renderStaffRegistration("Registration staff", false, ["REGISTRATION"]),
  renderStartLine("Start staff", false),
  renderFinishLine("Finish staff", false),
  renderStaffInventory("Inventory staff", "https://quickducks.com"),
  renderStaffDuck("a".repeat(32), "Registration staff"),
  renderStaffPairing(),
];

const style = renderedPages[0].match(/<style>([\s\S]+)<\/style>/)?.[1];

test("the private status page shows a scannable QR beside the readable lookup code", () => {
  const status = renderStatus({
    first_name: "Daisy",
    last_name: "Duck",
    lookup_code: "DAASY234",
    event_name: "Summer Duck Race",
    event_date: "2026-08-30",
    status: "SUBMITTED",
  });

  // The code stays readable so staff can always type it instead.
  assert.match(status, /<span class="code">DAASY234<\/span>/);
  assert.match(status, /<svg class="participant-qr"/);
  assert.match(status, /viewBox="0 0 29 29"/);
  // The QR encodes the code only; no participant detail may appear in it.
  const qr = status.match(/<svg class="participant-qr"[\s\S]*?<\/svg>/)[0];
  assert.doesNotMatch(qr, /Daisy|Duck|DAASY234|Summer/);
  // A participant page still exposes no staff-only or contact data.
  assert.doesNotMatch(status, /@example\.com|555-/);
});

test("the staff pairing page offers scanning, manual search, and a cancel path", () => {
  const page = renderStaffDuck("a".repeat(32), "Registration staff");

  assert.match(page, /data-scan-qr/);
  // Scanning is hidden until the client confirms the browser supports it, so an
  // unsupported device never shows a dead control.
  assert.match(page, /data-qr-launch hidden/);
  assert.match(page, /<section class="qr-scanner" data-qr-scanner hidden/);
  assert.match(page, /<video class="qr-video" data-qr-video muted playsinline><\/video>/);
  assert.match(page, /data-qr-cancel[^>]*>Cancel and search manually/);
  // Manual search always remains present as the fallback path.
  assert.match(page, /data-registration-search/);
  assert.match(page, /An exact lookup code pairs immediately/);
  // The field is a search box that narrows an already-visible list, so it is
  // neither required nor gated on a minimum length, and Enter reads as "search".
  assert.match(page, /<input name="query" type="search" enterkeyhint="search" autocomplete="off" maxlength="80"[^>]*data-registration-search-input>/);
  assert.doesNotMatch(page, /<input name="query"[^>]*minlength=/);
  assert.doesNotMatch(page, /<input name="query"[^>]*\srequired/);
  assert.match(page, /Everyone still waiting for a duck is listed below; typing narrows that list/);
  // The list has a live status line of its own, above the results.
  assert.match(page, /<p class="muted" data-registration-search-status aria-live="polite">Loading participants who still need a duck…<\/p>/);
  assert.ok(page.indexOf("data-registration-search-status") < page.indexOf("data-registration-results"));
  // The page itself never renders a participant or a QR payload.
  assert.doesNotMatch(page, /QD1:/);
});

test("result taker duck inspection exposes only the winner surface, not pairing controls", () => {
  const page = renderStaffDuck("a".repeat(32), "Result staff", false, ["RESULT_TAKER"]);

  assert.match(page, /data-winner-action/);
  assert.doesNotMatch(page, /data-registration-search|data-confirm-pairing|data-scan-qr/);
  assert.doesNotMatch(page, /lookup code pairs|phone, or email/i);
});

test("the finalists card has current-winner wording and no verification control", () => {
  const page = renderStaffHome("Result staff", false, ["RESULT_TAKER"]);

  assert.match(page, /data-finalist-card/);
  assert.match(page, /current round-one winners promoted into the final/i);
  assert.doesNotMatch(page, /Verify finalists|not yet verified|roster verified/i);
});

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
  assert.match(style, /\.winner-ribbon \{[^}]*background:#f4c542;[^}]*font-weight:950;[^}]*text-transform:uppercase;/);
  assert.match(style, /\.winner-action \.button \{ width:100%; min-height:4rem; \}/);
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
  const myDucks = renderMyDucks("REGISTRATION");
  const staffHome = renderStaffHome("Administrator", true, []);

  assert.match(myDucks, /class="participant-track" id="awaiting-participants" data-participant-track/);
  assert.match(style, /\.participant-track \{[^}]*overflow-x:auto;[^}]*scroll-snap-type:x mandatory;/);
  assert.match(style, /\.participant-card \{ flex:0 0 min\(30rem,calc\(100% - 3rem\)\); min-width:0;/);
  assert.match(style, /\.page-panel\.my-ducks-panel \{ max-width:70rem; \}/);
  // The phase message pages set a whole sentence as the page title, so it gets
  // a readable size instead of the 12ch display treatment.
  assert.match(style, /\.page-title\.message-title \{ max-width:26ch; font-size:clamp\(1\.9rem,5vw,3\.2rem\);/);
  assert.match(style, /\.my-ducks-flow \{ display:flex; flex-direction:column; \}/);
  // Inventory is its own page now, so the detail panel lives there.
  assert.match(
    renderStaffInventory("Duck Manager", "https://quickducks.com"),
    /class="operation-card inventory-detail-panel"[^>]*data-inventory-detail hidden/,
  );
  assert.doesNotMatch(staffHome, /data-inventory-detail/);
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

  // Down from 36: the Returns section's four forms (numbered disposition,
  // purge-ready, cancel purge-ready, return-batch item), the two purge forms
  // in Support, and the staff duck page's disposition form are all gone.
  // The name-search form moved from the home page to My Ducks, and the
  // registration form now renders only in the Registration phase.
  //
  // Inventory then moved off the console onto its own page: the console lost
  // seven forms (intake, edit, replace tag, retire tag, assign, unassign,
  // release) and gained the staff duck-name field, and the inventory page
  // renders six of its own (intake, duck name, assign, unpair, release,
  // delete). The unsupported-device page, which had none, is gone. Retiring
  // the duplicate empty-draft deletion path removed one more console form.
  //
  // The registration desk then added five: the shared participants surface's
  // filter, walk-up, duck-name, and edit forms, plus its own sign-out form.
  assert.equal(openingForms, 32);
  assert.equal(closingForms, openingForms);
  // "danger-zone" left the form vocabulary with the two purge forms; it now
  // styles only the <details>/<article> wrappers around destructive actions.
  assert.deepEqual([...formClasses].sort(), [
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
  const intake = renderStaffInventory("Inventory staff", "https://quickducks.com");

  for (const markup of [startLine, finishLine]) {
    assert.match(markup, /class="message-line muted" data-station-message aria-live="polite"/);
    assert.match(markup, /data-station-event/);
  }
  assert.match(intake, /data-intake-message/);
});

test("the live board exposes a stage chip on every page that renders it", () => {
  const boardPages = [renderRace("RACING"), renderStatus(), renderDuck()];

  for (const markup of boardPages) {
    assert.match(markup, /<p class="status-chip live-board-stage" data-live-board-stage aria-live="polite">Loading race stage…<\/p>/);
    assert.match(markup, /<h2 class="live-board-title" id="live-board-title" data-live-board-title>/);
    assert.match(markup, /data-live-board-summary/);
    assert.match(markup, /<p class="message-line muted" data-live-board-error role="alert" hidden><\/p>/);
    assert.match(markup, /data-live-board-content/);
  }
  assert.match(style, /\.live-board-stage \{[^}]*background:var\(--yellow\)/);
  assert.equal(renderMyDucks("RACING").includes("data-live-board-stage"), false);
  // The full board left the home page; only the compact summary remains there.
  assert.equal(renderHome("RACING").includes("data-live-board-stage"), false);
  assert.equal(renderHome("RACING").includes("data-live-board-content"), false);
});

test("the how-it-works cards describe the race without linking anywhere", () => {
  const home = renderHome("REGISTRATION");
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

test("the home hero is copy and artwork only, with the CTA in the race-named section", () => {
  const home = renderHome("REGISTRATION");
  const hero = home.match(/<section class="hero">[\s\S]*?<\/section>/)?.[0];
  const summary = home.match(/<section class="status-section" data-live-summary[\s\S]*?<\/section>/)?.[0];

  assert.ok(hero);
  assert.ok(summary);
  assert.match(hero, /<h1>Find your duck\. Cheer it home\.<\/h1>/);
  assert.doesNotMatch(hero, /class="actions"|<a\b|data-home-cta/);
  assert.match(summary, /<a class="button" href="\/register" data-home-cta>Register<\/a>/);
  // Preparing has no CTA, so it has no happening-now section, and the hero keeps
  // its own empty-state sentence.
  const preparing = renderHome("PREPARING");
  assert.match(preparing, /data-home-preparing>The next race is being prepared\./);
  assert.doesNotMatch(preparing, /data-live-summary|data-home-cta|class="actions"/);
});

test("no public card is singled out with the retired just-registered highlight", () => {
  // The just-registered card is rendered exactly like every other card, so the
  // highlight rule has no remaining consumer anywhere in the shared stylesheet.
  assert.doesNotMatch(style, /\.participant-card\.is-current/);
  assert.doesNotMatch(style, /#fff8c5/);
  assert.doesNotMatch(participantScript, /is-current|Just registered/);
  // The Following pill and its shared tag styling stay.
  assert.match(participantScript, /participantText\("span", "Following", "success-tag"\)/);
  assert.match(style, /\.success-tag \{/);
});

test("My Ducks keeps the registration action while sections stay gated until data loads", () => {
  const myDucks = renderMyDucks("REGISTRATION");

  assert.match(
    myDucks,
    /<section class="participant-section" data-participant-section="awaiting" data-keep-empty="true" aria-labelledby="awaiting-participants-title" hidden>/,
  );
  for (const kind of ["paired", "followed"]) {
    assert.match(
      myDucks,
      new RegExp(`<section class="participant-section" data-participant-section="${kind}" aria-labelledby="[a-z-]+" hidden>`),
    );
  }
  assert.doesNotMatch(renderMyDucks("RACING"), /data-participant-section="awaiting" data-keep-empty/);
  assert.doesNotMatch(myDucks, /data-carousel-empty/);
  assert.doesNotMatch(myDucks, /No participants are waiting for a duck|No paired ducks are saved on this device yet/);
  assert.match(myDucks, /<p class="empty-state" data-my-ducks-empty hidden>No registrations are saved on this device yet\./);
  assert.match(myDucks, /<h2 id="awaiting-participants-title">Awaiting Participants<\/h2>/);
  assert.match(myDucks, /<h2 id="paired-participants-title">My Ducks<\/h2>/);
  assert.match(myDucks, /data-carousel-controls hidden/);
  assert.match(myDucks, /data-participant-track tabindex="0" aria-label="Awaiting participant registrations" hidden/);
});

test("My Ducks separates participants registered here from ducks that are only followed", () => {
  const myDucks = renderMyDucks("REGISTRATION");

  // The followed set is its own section with its own carousel, and it says
  // plainly that those entries carry no staff code and no duck name.
  assert.match(myDucks, /<h2 id="followed-participants-title">Ducks I’m Following<\/h2>/);
  assert.match(myDucks, /data-participant-track tabindex="0" aria-label="Followed participants" hidden/);
  assert.match(myDucks, /someone else’s registration, so they show public race status only — no staff lookup code and no duck name/);
  // The owned sections say the opposite, so the distinction is on the page and
  // not only in the card contents.
  assert.match(myDucks, /Participants you registered on this device, waiting for staff to pair a physical duck\. Their staff lookup code stays on this device\./);
  assert.match(myDucks, /Participants you registered on this device, already paired with their race duck\. Use Rename on a duck to give it a name/);
  assert.match(myDucks, /Participants you registered on this device keep their full details and staff lookup code\./);
  // The followed section still follows the shared hidden-until-data rule.
  const followed = myDucks.slice(myDucks.indexOf('data-participant-section="followed"'));
  assert.match(followed.slice(0, followed.indexOf("</section>")), /data-carousel-controls hidden/);
});

test("search results style an add-to-My-Ducks action with the shared button conventions", () => {
  assert.match(searchScript, /"\/api\/v1\/registrations\/mine\/follow"/);
  assert.match(searchScript, /createText\("button", "Add to My Ducks", "button small"\)/);
  assert.match(searchScript, /button\.type = "button"/);
  assert.match(searchScript, /createText\("span", "In My Ducks", "success-tag"\)/);
  assert.match(style, /\.button\.small \{/);
  assert.match(style, /\.success-tag \{/);
  assert.match(style, /\.duck-card > \.actions \{ margin-top:\.75rem; \}/);
  // The public search carries no staff code and no private token, so no result
  // card can read or render either one.
  assert.doesNotMatch(searchScript, /lookupCode|Staff lookup code|privateStatusPath|privateToken/i);
  assert.doesNotMatch(searchScript, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
});

test("registration uses the responsive Turnstile widget contract", () => {
  const registration = renderRegistration("test-site-key", "REGISTRATION");

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
  duckName: null,
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

test("both public duck views show a chosen duck name beside the canonical number", () => {
  for (const [label, render] of [["tag scan", renderDuck], ["duck number", renderPublicDuck]]) {
    const named = render(duckStatus({ duckName: "Sir Quacks-a-Lot" }));
    assert.match(named, /<dt>Duck<\/dt><dd>Duck #128 · Sir Quacks-a-Lot<\/dd>/, label);
    // The heading stays the canonical number, so the page still matches the
    // duck in the water even when the name is long or confusing.
    assert.match(named, /<h1 class="page-title">Duck #128<\/h1>/, label);

    // No name, or a name the read-time filter suppressed, leaves "Duck #N".
    assert.match(render(duckStatus({ duckName: null })), /<dt>Duck<\/dt><dd>Duck #128<\/dd>/, label);
  }
});

test("a chosen duck name is escaped like every other server value", () => {
  const hostile = renderPublicDuck(duckStatus({ duckName: `<script>alert(1)</script> & "quotes"` }));
  assert.doesNotMatch(hostile, /<script>alert\(1\)<\/script>/);
  assert.match(hostile, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;quotes&quot;/);

  const tagPage = renderDuck(duckStatus({ duckName: `<img src=x onerror=alert(1)>` }));
  assert.doesNotMatch(tagPage, /<img src=x/);
  assert.match(tagPage, /&lt;img src=x onerror=alert\(1\)&gt;/);
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

test("both public duck views paint the follow control from the resolved follow state", () => {
  const followId = "11111111-1111-4111-8111-111111111111";
  for (const [label, render] of [["tag scan", renderDuck], ["duck number", renderPublicDuck]]) {
    // No follow state means the participant cannot be followed at all, so no
    // control is painted and no dead button can appear.
    const none = render(duckStatus(), "RACING", null);
    assert.doesNotMatch(none, /data-duck-follow data-follow-id/, label);
    assert.doesNotMatch(none, /data-follow-button|data-follow-added/, label);

    const offered = render(duckStatus(), "RACING", { followId, inMyDucks: false });
    assert.match(
      offered,
      new RegExp(`<div class="actions" data-duck-follow data-follow-id="${followId}"><button class="button" type="button" data-follow-button>Follow this duck</button></div>`),
      label,
    );
    assert.match(offered, /<p class="message-line muted" data-follow-message role="status" hidden><\/p>/, label);

    const already = render(duckStatus(), "RACING", { followId, inMyDucks: true });
    assert.match(already, /<span class="success-tag" data-follow-added>In My Ducks<\/span>/, label);
    assert.match(already, /<a class="button secondary small" href="\/my-ducks">Open My Ducks<\/a>/, label);
    assert.doesNotMatch(already, /data-follow-button/, label);

    // The identifier is a server value like any other and is escaped.
    assert.match(
      render(duckStatus(), "RACING", { followId: '"><script>alert(1)</script>', inMyDucks: false }),
      /data-follow-id="&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/,
      label,
    );
    // The control adds no participant data of its own.
    assert.doesNotMatch(offered, /lookup code|duckName|privateStatusPath/i, label);
  }
});

test("the duck not-found view is friendly, terminal, and reveals nothing extra", () => {
  const markup = renderPublicDuckNotFound("4096");
  const panel = markup.match(/<section class="page-panel">[\s\S]*?<\/section>/)?.[0];

  assert.ok(panel);
  assert.match(markup, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(panel, /Duck #4096 isn’t racing\./);
  assert.match(panel, /No duck with this number is paired with a participant in the current race\./);
  // The board moved to /race, so the recovery action follows it. Before a race
  // exists there is no board, so the same action falls back to the home page.
  assert.match(panel, /<a class="button" href="\/">Back to QuickDucks<\/a>/);
  assert.match(
    renderPublicDuckNotFound("4096", "RACING"),
    /<a class="button" href="\/race">Back to the race board<\/a>/,
  );
  assert.match(
    renderPublicDuck(duckStatus(), "RACING"),
    /<a class="button secondary" href="\/race">Back to the race board<\/a>/,
  );
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
  // My Ducks passes the owner's chosen duck name as the link label. The
  // destination stays the shared public duck path either way.
  assert.match(participantScript, /duckDetailLink\(document, status\.duck \? status\.duck\.visibleNumber : null, duckName\)/);
  assert.match(style, /\.duck-number-note \{[^}]*color:var\(--muted\);/);
});

test("every pattern attribute compiles the way a browser compiles it", () => {
  // HTML compiles `pattern` with the RegExp `v` flag, which is stricter than
  // the default: `-` is a reserved character class syntax character there and
  // must be escaped even in a trailing position. A pattern that fails to
  // compile is not a strict validator that rejects everything — the browser
  // discards the attribute, so the field silently stops validating at all and
  // only logs to the console. `[A-Za-z0-9_-]+` shipped that way on the duck
  // intake tag-token field, where the constraint had never once run.
  const patterns = renderedPages.flatMap((html) =>
    [...html.matchAll(/ pattern="([^"]*)"/g)].map((match) => match[1])
  );
  assert.ok(patterns.length > 0, "no pattern attributes found — has this moved out of site.ts?");

  for (const pattern of patterns) {
    assert.doesNotThrow(
      () => new RegExp(pattern, "v"),
      `pattern ${pattern} is not a valid v-mode regular expression, so browsers ignore it`,
    );
  }
});

test("no rendered page offers a Preview button", () => {
  // The mock routes stay reachable by hand; nothing in the product links to
  // them, so no visitor and no staff member is ever offered a mock as an action.
  for (const markup of renderedPages) {
    for (const [, label] of markup.matchAll(/<(?:a|button)\b[^>]*>([^<]*)</g)) {
      assert.doesNotMatch(label, /^\s*Preview\b/i, `a control still offers "${label}"`);
    }
    assert.doesNotMatch(markup, /<a[^>]+href="\/mock\//);
  }

  // The read-only slug preview is a labelled input, not a button, and stays.
  assert.match(
    renderStaffHome("Administrator", true, []),
    /<label>URL slug preview<input data-event-create-slug-preview/,
  );
});

test("staff renderers take the resolved public phase and never claim a live-nav slot", () => {
  const staffPages = [
    ["staff login", renderStaffLogin("/staff", "REGISTRATION")],
    ["staff home", renderStaffHome("Administrator", true, [], "REGISTRATION")],
    ["staff access", renderStaffAccess("Administrator", true, [], "REGISTRATION")],
    ["start line", renderStartLine("Start staff", false, false, ["HEAT_RUNNER"], "REGISTRATION")],
    ["finish line", renderFinishLine("Finish staff", false, false, ["RESULT_TAKER"], "REGISTRATION")],
    ["inventory", renderStaffInventory("Inventory staff", "https://quickducks.com", false, ["DUCK_MANAGER"], "REGISTRATION")],
    ["staff duck", renderStaffDuck("a".repeat(32), "Registration staff", false, ["REGISTRATION"], "REGISTRATION")],
    ["pairing mock", renderStaffPairing("REGISTRATION")],
  ];

  for (const [label, markup] of staffPages) {
    const nav = markup.match(/<nav class="nav"[\s\S]*?<\/nav>/)?.[0];
    assert.ok(nav, label);
    assert.match(nav, /data-phase="REGISTRATION"/, label);
    assert.match(nav, /<a href="\/register" data-nav-register>Register<\/a>/, label);
    assert.match(nav, /data-my-ducks-nav data-phase-visible="true">My Ducks<\/a>/, label);
    // `data-live-nav` is the live hub's admission marker; staff pages hold no
    // navigation subscription, so the server paint is final for them.
    assert.doesNotMatch(nav, /data-live-nav/, label);
  }

  // Defaulting is unchanged: a renderer called without a phase still paints the
  // conservative Preparing navigation.
  assert.match(renderStaffHome("Administrator", true, []), /data-phase="PREPARING"/);
});

test("every staff page ends with a signed-in footer holding only the name and log out", () => {
  const staffPages = [
    ["staff home", renderStaffHome("Ada Duck", true, [])],
    ["staff access", renderStaffAccess("Ada Duck")],
    ["start line", renderStartLine("Ada Duck", false)],
    ["finish line", renderFinishLine("Ada Duck", false)],
    ["inventory", renderStaffInventory("Ada Duck", "https://quickducks.com")],
    ["staff duck", renderStaffDuck("a".repeat(32), "Ada Duck")],
  ];

  for (const [label, markup] of staffPages) {
    const main = markup.match(/<main class="shell">[\s\S]*<\/main>/)?.[0];
    assert.ok(main, label);
    assert.equal((markup.match(/class="staff-bar"/g) ?? []).length, 1, label);
    assert.match(
      markup,
      /<footer class="staff-bar"><p><strong>Ada Duck<\/strong><\/p><form class="staff-logout" method="post" action="\/staff\/logout"><button type="submit">Log out<\/button><\/form><\/footer>/,
      label,
    );
    // It is a footer at the bottom, below the staff nav and the page heading.
    assert.ok(main.indexOf('class="staff-bar"') > main.indexOf('class="staff-nav"'), label);
    assert.ok(main.indexOf('class="staff-bar"') > main.indexOf("<h1"), label);
    // Nothing else survives in it: no Staff home link, no page-name suffix.
    assert.doesNotMatch(main, /staff-bar-actions/, label);
    assert.doesNotMatch(main, />Staff home</, label);
    assert.doesNotMatch(main, /Ada Duck<\/strong> ·/, label);
  }

  // A display name is a server value and stays escaped inside the footer.
  assert.match(
    renderStaffHome('Ada "<script>" Duck', true, []),
    /<strong>Ada &quot;&lt;script&gt;&quot; Duck<\/strong>/,
  );
});

test("the staff console no longer repeats the stations the staff nav already lists", () => {
  const director = renderStaffHome("Race Director", false, ["RACE_DIRECTOR"]);

  for (const markup of [director, renderStaffHome("Administrator", true, []), renderStaffHome("Heat Runner", false, ["HEAT_RUNNER"]), renderStaffHome("Result Taker", false, ["RESULT_TAKER"])]) {
    assert.doesNotMatch(markup, /Open start line|Open finish line/);
    assert.doesNotMatch(markup, /station-links/);
  }
  // The stations are still one tap away, from the staff nav.
  assert.match(director, /<a href="\/staff\/start-line">Start line<\/a>/);
  assert.match(director, /<a href="\/staff\/finish-line">Finish line<\/a>/);
  // `.station-control` is still used by the finish-line and intake stations.
  assert.ok(style);
  assert.match(style, /\.station-control \{ min-height:4rem;/);
  assert.match(renderFinishLine("Finish staff", false), /class="button station-control"/);
});

test("the tag token pattern still accepts exactly what the server accepts", () => {
  // Escaping must not narrow the accepted set: this pattern mirrors
  // `validTagToken` in duck-operations.ts, and the lengths come from
  // minlength/maxlength beside it.
  const pattern = renderStaffInventory("Duck Manager", "https://quickducks.com")
    .match(/name="tagToken"[^>]* pattern="([^"]*)"/)[1];
  const field = new RegExp(`^(?:${pattern})$`, "v");

  // A real token from the seeded local site, which carries both - and _.
  assert.ok(field.test("gegczEBa_iiuCKl2j9r4bkC-QC4gFEhvDQm4zF20JWw"));
  assert.ok(field.test("abcDEF012_-"));
  assert.equal(field.test("has space"), false);
  assert.equal(field.test("has.dot"), false);
  assert.equal(field.test("has/slash"), false);
  assert.equal(field.test(""), false);
});

// Pairing puts a physical duck into a physical heat bag it never comes out of,
// so the pairing screen has to shout which bag before the staffer walks away.
test("the pairing page carries an unmissable heat-bag callout above everything else", () => {
  const page = renderStaffDuck("a".repeat(32), "Registration staff");

  assert.match(
    page,
    /<section class="heat-bag" data-heat-bag hidden aria-live="assertive" aria-label="Which heat bag this duck goes into">/,
  );
  for (const hook of [
    "data-heat-bag-instruction",
    "data-heat-bag-number",
    "data-heat-bag-duck",
    "data-heat-bag-note",
    "data-heat-bag-dismiss",
  ]) assert.ok(page.includes(hook), hook);
  // It stays until the staffer says the duck is in the bag; nothing else clears it.
  assert.match(page, /data-heat-bag-dismiss>Done — this duck is in the bag</);
  // It is the first thing in the panel, above the duck record and the pairing work area.
  assert.ok(page.indexOf("data-heat-bag") < page.indexOf("data-duck-summary"));
  assert.ok(page.indexOf("data-heat-bag") < page.indexOf("data-pairing-work"));
  // The server never paints a heat number into the markup; the client renders
  // the authoritative one from the pairing response.
  const callout = page.match(/<section class="heat-bag"[\s\S]*?<\/section>/)[0];
  assert.doesNotMatch(callout, /Heat \d|heat \d/);

  // A role that cannot pair is offered no bag panel at all.
  assert.doesNotMatch(renderStaffDuck("a".repeat(32), "Result staff", false, ["RESULT_TAKER"]), /data-heat-bag/);
});

test("the heat-bag callout is styled loud, high contrast, and safe at 320px", () => {
  assert.match(style, /\.heat-bag \{[^}]*border:6px solid var\(--ink\)/);
  assert.match(style, /\.heat-bag \{[^}]*background:var\(--yellow\)/);
  assert.match(style, /\.heat-bag \{[^}]*box-shadow:8px 8px 0 var\(--ink\)/);
  // The bag number is display sized; the instruction is large but secondary.
  assert.match(style, /\.heat-bag-number \{ font-size:clamp\(3rem,17vw,7rem\)/);
  assert.match(style, /\.heat-bag-instruction \{ font-size:clamp\(1\.35rem,6vw,2\.4rem\)/);
  // Every line wraps rather than pushing a narrow phone sideways, and the
  // pending state shrinks its wordy headline so it still fits.
  for (const rule of ["instruction", "number", "duck", "note"]) {
    assert.match(style, new RegExp(`\\.heat-bag-${rule} \\{[^}]*overflow-wrap:anywhere`));
  }
  assert.match(style, /\.heat-bag\.pending \{[^}]*background:#ffd8d2/);
  assert.match(style, /\.heat-bag\.pending \.heat-bag-number \{ font-size:clamp\(1\.5rem,7vw,2\.6rem\)/);
  assert.match(style, /\.heat-bag \.button \{ width:100%; \}/);
});

// Scanning a withdrawn or disqualified duck at the finish line is a normal
// outcome, so it gets its own calm region rather than the error message line.
test("the finish line has a dedicated region for a duck that cannot be recorded", () => {
  const page = renderFinishLine("Finish staff", false);

  assert.match(
    page,
    /<section class="station-ineligible" data-finish-ineligible hidden aria-live="assertive" aria-label="Duck that cannot be recorded"><\/section>/,
  );
  // It sits above the scan form so it is read before the next scan is typed.
  assert.ok(page.indexOf("data-finish-ineligible") < page.indexOf("data-finish-scan-form"));
  // The station keeps its ordinary message line and its scan controls.
  assert.match(page, /class="message-line muted" data-station-message aria-live="polite"/);
  assert.match(page, /data-start-nfc/);

  assert.match(style, /\.station-ineligible \{[^}]*border:5px solid #9f261c/);
  assert.match(style, /\.station-ineligible \{[^}]*background:#ffd8d2/);
  assert.match(style, /\.station-ineligible strong \{[^}]*overflow-wrap:anywhere/);
  assert.match(style, /\.station-ineligible p \{[^}]*overflow-wrap:anywhere/);
  // The scanned-duck page reuses the winner panel in the same refused colours.
  assert.match(style, /\.winner-action\.ineligible \{ border-color:#9f261c; background:#ffd8d2; \}/);
});
