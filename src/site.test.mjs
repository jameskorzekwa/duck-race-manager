import assert from "node:assert/strict";
import test from "node:test";

import {
  renderDuck,
  renderFinishLine,
  renderHome,
  renderInventoryIntake,
  renderInventoryIntakeUnsupported,
  renderMyDucks,
  renderRegistration,
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
  renderStaffLogin(),
  renderStaffHome("Administrator", true, []),
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

  assert.equal(openingForms, 35);
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

test("registration uses the responsive Turnstile widget contract", () => {
  const registration = renderRegistration("test-site-key");

  assert.match(registration, /class="cf-turnstile"[^>]*data-size="flexible"/);
  assert.match(style, /\.cf-turnstile,\.turnstile-mock \{ width:100%; min-width:0; max-width:100%; \}/);
});
