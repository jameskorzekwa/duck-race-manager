import assert from "node:assert/strict";
import test from "node:test";

import {
  heatRosterHelpersScript,
  inventoryDetailHelpersScript,
  inventoryGroupHelpersScript,
  staffHomeScript,
  staffInventoryScript,
} from "./client-scripts.ts";
import { renderStaffHome, renderStaffInventory } from "./site.ts";

// ---------------------------------------------------------------------------
// A small DOM double. Only the APIs the console actually uses are implemented,
// so a new unsafe sink or an unsupported API would fail loudly here.
// ---------------------------------------------------------------------------

const attributeSelector = /^\[([a-z-]+)\]$/;

const datasetKey = (attribute) => attribute
  .replace(/^data-/, "")
  .replace(/-([a-z])/g, (_, character) => character.toUpperCase());

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.className = "";
    this.textContent = "";
    this.hidden = false;
    this.id = "";
    this.type = "";
    this.isConnected = true;
    this.parentNode = null;
    this.focusCount = 0;
    this.scrollCalls = [];
  }

  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      this.children.push(child);
    }
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.textContent = "";
    this.append(...children);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(handler);
  }

  // Real controls are dispatched, never invoked directly, so a control that was
  // not wired as a listener cannot pass these tests.
  dispatch(name) {
    const event = { type: name, target: this, currentTarget: this, preventDefault() {} };
    return Promise.all((this.listeners.get(name) ?? []).map((handler) => handler(event)));
  }

  focus() {
    this.focusCount += 1;
    this.ownerDocument.activeElement = this;
  }

  scrollIntoView(options) {
    this.scrollCalls.push(options);
  }

  get descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants]);
  }

  matches(selector) {
    const attribute = selector.match(attributeSelector);
    if (attribute !== null) return this.dataset[datasetKey(attribute[1])] !== undefined;
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    return this.tagName === selector.toUpperCase();
  }

  querySelectorAll(selector) {
    return this.descendants.filter((node) => node.matches(selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  get textTree() {
    return [this.textContent, ...this.children.map((child) => child.textTree)].join(" ").trim();
  }
}

class FakeDocument {
  constructor() {
    this.hooks = new Map();
    this.activeElement = null;
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  hook(selector, tagName = "div") {
    const element = this.createElement(tagName);
    if (selector.startsWith("#")) element.id = selector.slice(1);
    this.hooks.set(selector, element);
    return element;
  }

  querySelector(selector) {
    return this.hooks.get(selector) ?? null;
  }

  getElementById(id) {
    return this.hooks.get(`#${id}`) ?? null;
  }
}

// ---------------------------------------------------------------------------
// The console source under test is lifted out of the generated script so these
// tests exercise the shipped browser code, never a copy of it.
// ---------------------------------------------------------------------------

// Inventory moved to its own page, so each lifted function names the shipped
// bundle it belongs to. Lifting from the wrong one fails here rather than
// silently testing the other page's copy.
const lift = (label, { pattern, from }) => {
  const match = from.match(pattern);
  assert.ok(match, `the shipped client defines ${label}`);
  return match[0];
};

// The two standalone staff pages each carry their own copy of the tiny shared
// helpers, because a classic script cannot import. They must stay identical, or
// the same control would behave differently depending on which page it is on.
test("the two staff bundles share byte-identical copies of the common helpers", () => {
  for (const [label, pattern] of [
    ["text", /const text = \(tag, value, className\) => \{[\s\S]*?\n\};/],
    ["humanize", /const humanize = \(value\) => [^;]+;/],
    ["empty", /const empty = \(message\) => .*;/],
    ["commandOptions", /const commandOptions = \(method, payload\) => \(\{[\s\S]*?\n\}\);/],
    ["historyCard", /const historyCard = \(title, detail\) => \{[\s\S]*?\n\};/],
  ]) {
    const consoleCopy = staffHomeScript.match(pattern);
    const inventoryCopy = staffInventoryScript.match(pattern);
    assert.ok(consoleCopy, `the console defines ${label}`);
    assert.ok(inventoryCopy, `the inventory page defines ${label}`);
    assert.equal(inventoryCopy[0], consoleCopy[0], `${label} has drifted between the two bundles`);
  }
});

const fromConsole = (pattern) => ({ pattern, from: staffHomeScript });
const fromInventory = (pattern) => ({ pattern, from: staffInventoryScript });

const consoleParts = {
  text: fromConsole(/const text = \(tag, value, className\) => \{[\s\S]*?\n\};/),
  humanize: fromConsole(/const humanize = \(value\) => [^;]+;/),
  empty: fromConsole(/const empty = \(message\) => .*;/),
  inventoryCard: fromInventory(/const inventoryCard = \(duck\) => \{[\s\S]*?\n\};/),
  inventoryGroupSection: fromInventory(/const inventoryGroupSection = \(group\) => \{[\s\S]*?\n\};/),
  loadInventory: fromInventory(/const loadInventory = async \(\) => \{[\s\S]*?\n\};/),
  loadDuckDetail: fromInventory(/const loadDuckDetail = async \(duckId, trigger = null, focusDetail = false\) => \{[\s\S]*?\n\};/),
  loadParticipantDetail: fromConsole(/const loadParticipantDetail = async \(registrationId\) => \{[\s\S]*?\n\};/),
  revealConsoleSection: fromConsole(/const revealConsoleSection = \(view\) => \{[\s\S]*?\n\};/),
  participantIsPaired: fromConsole(/const participantIsPaired = \(registration\) =>\n[\s\S]*?;\n/),
  openRosterParticipant: fromConsole(/const openRosterParticipant = async \(registrationId\) => \{[\s\S]*?\n\};/),
  openRosterDuck: fromConsole(/const openRosterDuck = \(duckId\) => \{[\s\S]*?\n\};/),
  loadHeatDetail: fromConsole(/const loadHeatDetail = async \(heatId\) => \{[\s\S]*?\n\};/),
  commandOptions: fromConsole(/const commandOptions = \(method, payload\) => \(\{[\s\S]*?\n\}\);/),
  addParticipantAction: fromConsole(/const addParticipantAction = \(label, className, action\) => \{[\s\S]*?\n\};/),
  participantDuckNameFact: fromConsole(/const participantDuckNameFact = \(registration\) => \{[\s\S]*?\n\};/),
  clearParticipantDuckName: fromConsole(/const clearParticipantDuckName = async \(button\) => \{[\s\S]*?\n\};/),
  renderParticipantDetail: fromConsole(/const renderParticipantDetail = \(registration\) => \{[\s\S]*?\n\};/),
  markParticipantSelection: fromConsole(/const markParticipantSelection = \(\) => \{[\s\S]*?\n\};/),
  toggleParticipantDetail: fromConsole(/const toggleParticipantDetail = \(registrationId\) => \{[\s\S]*?\n\};/),
  clearParticipantDetail: fromConsole(/const clearParticipantDetail = \(\) => \{[\s\S]*?\n\};/),
  loadParticipants: fromConsole(/const loadParticipants = async \(pruneSelection = false\) => \{[\s\S]*?\n\};/),
};

const build = (parts, injected, returned) => {
  const source = parts.map((part) => (
    Object.prototype.hasOwnProperty.call(consoleParts, part) ? lift(part, consoleParts[part]) : part
  )).join("\n");
  const names = Object.keys(injected);
  return new Function(...names, `${source}\nreturn { ${returned.join(", ")} };`)(
    ...names.map((name) => injected[name]),
  );
};

const groupHelpers = () => new Function(
  `${inventoryGroupHelpersScript}; return { inventoryDuckGroupKey, groupInventoryDucks, inventoryGroupDefinitions };`,
)();

// A duck summary in the exact shape `GET /api/v1/staff/inventory/ducks` returns.
const duck = (visibleNumber, inventoryStatus, { reservation = null, assignment = null, participant = null } = {}) => ({
  id: "duck-" + visibleNumber,
  visibleNumber,
  inventoryStatus,
  revision: 0,
  condition: "GOOD",
  location: null,
  notes: null,
  tag: null,
  reservation,
  assignment,
  participant,
});

const activeReservation = { id: "event-duck-1", reservedAt: "2026-07-26T10:00:00Z", releasedAt: null, event: { id: "event", name: "Annual Duck Race", status: "REGISTRATION_OPEN" } };
const releasedReservation = { ...activeReservation, releasedAt: "2026-07-26T12:00:00Z" };
const openAssignment = { id: "assignment-1", validFrom: "2026-07-26T11:00:00Z", raceEntryId: "entry-1" };
const pairedParticipant = { registrationId: "registration-1", raceEntryId: "entry-1", firstName: "Ada", lastName: "Lovelace", status: "ACTIVE" };

// ---------------------------------------------------------------------------
// Grouping rule
// ---------------------------------------------------------------------------

test("inventory grouping is derived from every real inventory and reservation state", () => {
  const { inventoryDuckGroupKey } = groupHelpers();

  // Committed to a race: an unreleased reservation, an open assignment, or the
  // IN_USE status itself. Reservation and pairing win over the status, so a
  // duck that is reserved while damaged is still reported as in use.
  assert.equal(inventoryDuckGroupKey(duck(1, "RESERVED_FOR_EVENT", { reservation: activeReservation })), "IN_USE");
  assert.equal(inventoryDuckGroupKey(duck(2, "IN_USE", { reservation: activeReservation, assignment: openAssignment, participant: pairedParticipant })), "IN_USE");
  assert.equal(inventoryDuckGroupKey(duck(3, "IN_USE")), "IN_USE");
  assert.equal(inventoryDuckGroupKey(duck(4, "DAMAGED", { reservation: activeReservation })), "IN_USE");
  assert.equal(inventoryDuckGroupKey(duck(5, "QUARANTINED", { reservation: activeReservation })), "IN_USE");
  assert.equal(inventoryDuckGroupKey(duck(6, "AVAILABLE", { assignment: openAssignment })), "IN_USE");
  assert.equal(inventoryDuckGroupKey(duck(7, "AVAILABLE", { participant: pairedParticipant })), "IN_USE");

  // Ready to be reserved: AVAILABLE with nothing holding it, which is exactly
  // the state the assignment and pairing paths accept.
  assert.equal(inventoryDuckGroupKey(duck(8, "AVAILABLE")), "READY");
  assert.equal(inventoryDuckGroupKey(duck(9, "AVAILABLE", { reservation: releasedReservation })), "READY");

  // Every remaining real status cannot be reserved and is held out of the race.
  for (const status of ["NEW", "QUARANTINED", "DAMAGED", "MISSING", "UNACCOUNTED_FOR", "KEPT", "RETIRED"]) {
    assert.equal(inventoryDuckGroupKey(duck(10, status)), "UNAVAILABLE", status);
    assert.equal(inventoryDuckGroupKey(duck(11, status, { reservation: releasedReservation })), "UNAVAILABLE", status);
  }

  // The grouping never depends on a state the API does not report.
  assert.equal(inventoryDuckGroupKey(duck(12, "AVAILABLE", { reservation: null, assignment: null, participant: null })), "READY");
});

test("inventory groups keep server ordering and cover every duck exactly once", () => {
  const { groupInventoryDucks, inventoryGroupDefinitions } = groupHelpers();
  const ducks = [
    duck(1, "AVAILABLE"),
    duck(2, "RESERVED_FOR_EVENT", { reservation: activeReservation }),
    duck(3, "RETIRED"),
    duck(4, "AVAILABLE"),
    duck(5, "IN_USE", { reservation: activeReservation, assignment: openAssignment, participant: pairedParticipant }),
  ];
  const groups = groupInventoryDucks(ducks);

  assert.deepEqual(groups.map((group) => group.key), ["IN_USE", "READY", "UNAVAILABLE"]);
  assert.deepEqual(groups.map((group) => group.ducks.map((entry) => entry.visibleNumber)), [[2, 5], [1, 4], [3]]);
  assert.equal(groups.flatMap((group) => group.ducks).length, ducks.length);
  assert.deepEqual(inventoryGroupDefinitions.map((group) => group.title), [
    "In use",
    "Ready to be reserved",
    "Not ready to reserve",
  ]);
  // Every group carries the wording the console renders for an empty group.
  for (const group of inventoryGroupDefinitions) assert.match(group.emptyMessage, /\S/);
});

test("an empty inventory group renders a message instead of a blank area", () => {
  const { groupInventoryDucks } = groupHelpers();

  // Both primary groups are always rendered, even when empty.
  const onlyReady = groupInventoryDucks([duck(1, "AVAILABLE")]);
  assert.deepEqual(onlyReady.map((group) => group.key), ["IN_USE", "READY"]);
  assert.deepEqual(onlyReady[0].ducks, []);
  assert.equal(onlyReady[0].emptyMessage, "No ducks are reserved or paired yet.");

  const onlyInUse = groupInventoryDucks([duck(1, "IN_USE")]);
  assert.deepEqual(onlyInUse.map((group) => group.key), ["IN_USE", "READY"]);
  assert.equal(onlyInUse[1].emptyMessage, "No ducks are ready to be reserved.");

  // The exception bucket is an exception: it appears only when it holds ducks.
  assert.deepEqual(groupInventoryDucks([]).map((group) => group.key), ["IN_USE", "READY"]);
  assert.deepEqual(
    groupInventoryDucks([duck(1, "DAMAGED")]).map((group) => group.key),
    ["IN_USE", "READY", "UNAVAILABLE"],
  );
});

// ---------------------------------------------------------------------------
// Inventory rendering
// ---------------------------------------------------------------------------

const inventoryHarness = ({ ducks }) => {
  const document = new FakeDocument();
  const inventoryList = document.hook("[data-inventory-list]");
  const requests = [];
  const selections = [];
  const runtime = build(
    [inventoryGroupHelpersScript, "text", "humanize", "empty", "inventoryCard", "inventoryGroupSection", "loadInventory"],
    {
      document,
      api: async (url) => {
        requests.push(url);
        return { ducks };
      },
      inventoryList,
      loadDuckDetail: async (...args) => {
        selections.push(args);
      },
      setMessage: () => {},
      inventoryDetailController: { syncButtons: () => selections.push(["sync"]) },
    },
    ["loadInventory"],
  );
  return { document, inventoryList, requests, selections, loadInventory: runtime.loadInventory };
};

const groupSections = (list) => list.children.filter((child) => child.dataset.inventoryGroup !== undefined);

test("the inventory list renders labelled in-use and ready-to-reserve sections", async () => {
  const harness = inventoryHarness({
    ducks: [
      duck(1, "RESERVED_FOR_EVENT", { reservation: activeReservation }),
      duck(2, "IN_USE", { reservation: activeReservation, assignment: openAssignment, participant: pairedParticipant }),
      duck(3, "AVAILABLE"),
      duck(4, "DAMAGED"),
    ],
  });
  await harness.loadInventory();

  assert.deepEqual(harness.requests, ["/api/v1/staff/inventory/ducks"]);
  const sections = groupSections(harness.inventoryList);
  assert.deepEqual(sections.map((section) => section.dataset.inventoryGroup), ["IN_USE", "READY", "UNAVAILABLE"]);

  // Each group is a labelled region with a real heading.
  const [inUse, ready, unavailable] = sections;
  assert.equal(inUse.tagName, "SECTION");
  assert.equal(inUse.children[0].tagName, "H3");
  assert.equal(inUse.children[0].textContent, "In use");
  assert.equal(inUse.children[0].id, "inventory-group-in-use");
  assert.equal(inUse.getAttribute("aria-labelledby"), "inventory-group-in-use");
  assert.equal(ready.children[0].textContent, "Ready to be reserved");
  assert.equal(ready.getAttribute("aria-labelledby"), "inventory-group-ready");
  assert.equal(unavailable.children[0].textContent, "Not ready to reserve");

  // The count and purpose of each group are stated in plain language.
  assert.equal(inUse.children[1].textContent, "2 ducks · Reserved to a race, paired with a participant, or racing now.");
  assert.equal(ready.children[1].textContent, "1 duck · Available ducks with no live reservation. Assigning one reserves it automatically.");

  // Cards keep the existing card grid, wording, and detail-panel wiring.
  const cards = harness.inventoryList.querySelectorAll("[data-duck-id]");
  assert.deepEqual(cards.map((card) => card.dataset.duckId), ["duck-1", "duck-2", "duck-3", "duck-4"]);
  for (const card of cards) {
    assert.equal(card.tagName, "BUTTON");
    assert.equal(card.type, "button");
    assert.equal(card.className, "result-button");
    assert.equal(card.getAttribute("aria-controls"), "inventory-detail-panel");
    assert.equal(card.getAttribute("aria-expanded"), "false");
    assert.equal(card.parentNode.className, "data-list inventory-card-grid");
  }
  assert.equal(cards[0].textContent, "Duck #1 · Reserved for event · Annual Duck Race");
  assert.equal(cards[2].textContent, "Duck #3 · Available");

  // A card click still runs the shared duck-detail selection path.
  await cards[2].dispatch("click");
  assert.deepEqual(harness.selections.at(-1), ["duck-3", cards[2], true]);
  // The card selection state is resynchronised after every list render.
  assert.deepEqual(harness.selections[0], ["sync"]);
});

test("an empty inventory group renders its own empty state and never a blank band", async () => {
  const harness = inventoryHarness({ ducks: [duck(1, "AVAILABLE"), duck(2, "AVAILABLE")] });
  await harness.loadInventory();

  const [inUse, ready] = groupSections(harness.inventoryList);
  assert.equal(groupSections(harness.inventoryList).length, 2, "the exception bucket is not rendered when empty");
  assert.equal(inUse.children.length, 2);
  assert.equal(inUse.children[1].className, "empty-state");
  assert.equal(inUse.children[1].textContent, "No ducks are reserved or paired yet.");
  assert.equal(inUse.querySelectorAll("[data-duck-id]").length, 0);
  assert.equal(ready.querySelectorAll("[data-duck-id]").length, 2);

  const reversed = inventoryHarness({ ducks: [duck(1, "IN_USE")] });
  await reversed.loadInventory();
  const readyGroup = groupSections(reversed.inventoryList)[1];
  assert.equal(readyGroup.children[1].className, "empty-state");
  assert.equal(readyGroup.children[1].textContent, "No ducks are ready to be reserved.");
});

test("an empty inventory keeps the single no-ducks message and no group scaffolding", async () => {
  const harness = inventoryHarness({ ducks: [] });
  await harness.loadInventory();

  assert.equal(harness.inventoryList.children.length, 1);
  assert.equal(harness.inventoryList.children[0].className, "empty-state");
  assert.equal(
    harness.inventoryList.children[0].textContent,
    "No ducks are in inventory. Scan a blank sticker to add the first one.",
  );
  assert.equal(groupSections(harness.inventoryList).length, 0);
  assert.deepEqual(harness.selections, [["sync"]], "the detail controller is still resynchronised");
});

// ---------------------------------------------------------------------------
// Detail panel behaviour with grouped cards
// ---------------------------------------------------------------------------

const detailHarness = ({ ducks, detailDelay = null }) => {
  const document = new FakeDocument();
  const inventoryList = document.hook("[data-inventory-list]");
  const detail = document.hook("[data-inventory-detail]");
  const closeButton = document.createElement("button");
  detail.hidden = true;
  const rendered = [];
  let cleared = 0;
  const runtime = build(
    [
      inventoryGroupHelpersScript,
      inventoryDetailHelpersScript,
      "text",
      "humanize",
      "empty",
      "inventoryCard",
      "inventoryGroupSection",
      "loadInventory",
      "loadDuckDetail",
      `const inventoryDetailController = createInventoryDetailController({
        detail, list: inventoryList, closeButton, clear: () => clearDetail(),
      });`,
    ],
    {
      document,
      detail,
      closeButton,
      inventoryList,
      clearDetail: () => { cleared += 1; },
      setMessage: () => {},
      renderDuckDetail: (body) => rendered.push(body.duck.id),
      api: async (url) => {
        if (url.endsWith("/inventory/ducks")) return { ducks };
        const duckId = decodeURIComponent(url.split("/").pop());
        if (detailDelay) await detailDelay(duckId);
        return { duck: { id: duckId }, history: {} };
      },
    },
    ["loadInventory", "loadDuckDetail", "inventoryDetailController"],
  );
  return {
    ...runtime,
    closeButton,
    detail,
    document,
    inventoryList,
    rendered,
    clearedCount: () => cleared,
    cards: () => inventoryList.querySelectorAll("[data-duck-id]"),
  };
};

test("selecting a grouped card opens the sticky detail panel and returns focus on close", async () => {
  const harness = detailHarness({
    ducks: [duck(1, "IN_USE", { reservation: activeReservation }), duck(2, "AVAILABLE")],
  });
  await harness.loadInventory();

  const [inUseCard, readyCard] = harness.cards();
  await inUseCard.dispatch("click");

  assert.equal(harness.detail.hidden, false);
  assert.deepEqual(harness.rendered, ["duck-1"]);
  assert.equal(inUseCard.getAttribute("aria-expanded"), "true");
  assert.equal(readyCard.getAttribute("aria-expanded"), "false", "cards in another group stay collapsed");
  assert.equal(harness.closeButton.focusCount, 1);

  // Selecting across groups moves the expanded state with the selection.
  await readyCard.dispatch("click");
  assert.equal(inUseCard.getAttribute("aria-expanded"), "false");
  assert.equal(readyCard.getAttribute("aria-expanded"), "true");

  harness.inventoryDetailController.close();
  assert.equal(harness.detail.hidden, true);
  assert.equal(harness.clearedCount(), 1);
  assert.equal(readyCard.focusCount, 1, "focus returns to the card that opened the panel");
});

test("a live refresh regroups the cards without stranding the open detail panel", async () => {
  const harness = detailHarness({
    ducks: [duck(1, "AVAILABLE"), duck(2, "AVAILABLE")],
  });
  await harness.loadInventory();
  await harness.cards()[0].dispatch("click");
  assert.equal(harness.cards()[0].getAttribute("aria-expanded"), "true");

  // A refresh rebuilds every group and card from the authoritative list.
  await harness.loadInventory();
  const cards = harness.cards();
  assert.equal(cards.length, 2);
  assert.equal(cards[0].getAttribute("aria-expanded"), "true", "the selected duck stays expanded after a refresh");
  assert.equal(harness.detail.hidden, false);
});

// ---------------------------------------------------------------------------
// Heat roster entries and their deep links
// ---------------------------------------------------------------------------

const rosterEntry = (overrides = {}) => ({
  heatEntryId: "heat-entry-1",
  raceEntryId: "0b7a1c62-6c1f-4f2e-9d0a-2f7a1c626c1f",
  slotNumber: 1,
  assignmentSource: "BALANCED_DRAW",
  participant: {
    registrationId: "registration-1",
    firstName: "Ada",
    lastName: "Lovelace",
    registrationStatus: "ACTIVE",
  },
  duck: { id: "duck-12", visibleNumber: 12 },
  ...overrides,
});

const heatHarness = ({ roster, canRegistration = true, canInventory = true }) => {
  const document = new FakeDocument();
  const heatDetail = document.hook("[data-heat-detail]");
  const heatRoster = document.hook("[data-heat-roster]", "ul");
  const heatFacts = document.hook("[data-heat-facts]", "dl");
  const heatResults = document.hook("[data-heat-results]");
  const heatName = document.hook("[data-heat-name]", "h3");
  const participants = document.hook("#participants", "section");
  const participantDetail = document.hook("[data-participant-detail]", "article");
  const opened = [];
  const navigations = [];
  const appliedViews = [];
  const location = { hash: "", assign: (url) => navigations.push(url) };
  const runtime = build(
    [
      heatRosterHelpersScript,
      "text",
      "humanize",
      "empty",
      "revealConsoleSection",
      "openRosterParticipant",
      "openRosterDuck",
      "loadParticipantDetail",
      "loadHeatDetail",
    ],
    {
      document,
      canRegistration,
      canInventory,
      // The Admin view switcher: the roster deep link goes through the same
      // hash path the menu bar uses, so it is injected rather than stubbed out.
      consoleViewSections: [Object.assign(participants, { dataset: { consoleView: "participants" } })],
      applyConsoleView: (view) => appliedViews.push(view),
      location,
      heatDetail,
      heatRoster,
      heatFacts,
      heatResults,
      participantDetail,
      selectedHeat: null,
      currentEventId: () => "event",
      showFacts: () => {},
      historyCard: () => document.createElement("div"),
      renderHeatControls: () => {},
      renderParticipantDetail: (registration) => {
        participantDetail.hidden = false;
        opened.push(["participant-rendered", registration.registrationId]);
      },
      setMessage: (message, isError) => opened.push(["message", message, Boolean(isError)]),
      api: async (url) => {
        opened.push(["api", url]);
        if (url.includes("/registrations/")) {
          return { registration: { registrationId: decodeURIComponent(url.split("/").pop()) } };
        }
        return { heat: { id: "heat-1", round: "ROUND_ONE", number: 1, status: "PLANNED", rosterSize: roster.length, publishedResultCount: 0, revision: 0 }, roster, results: [] };
      },
    },
    ["loadHeatDetail"],
  );
  return {
    document,
    heatRoster,
    appliedViews,
    location,
    navigations,
    opened,
    participantDetail,
    participants,
    loadHeatDetail: runtime.loadHeatDetail,
    entries: () => heatRoster.children,
    links: (name) => heatRoster.querySelectorAll(`[data-roster-${name}-link]`),
  };
};

test("a heat roster entry shows its uuid and both deep links as real buttons", async () => {
  const harness = heatHarness({ roster: [rosterEntry()] });
  await harness.loadHeatDetail("heat-1");

  const [item] = harness.entries();
  assert.equal(item.tagName, "LI");
  assert.equal(item.className, "roster-entry");
  assert.equal(item.children[0].textContent, "Slot 1 · Ada Lovelace · Duck #12");
  // The race-entry UUID is shown, but never as the only affordance.
  assert.equal(item.children[1].textContent, "Race entry 0b7a1c62-6c1f-4f2e-9d0a-2f7a1c626c1f");
  assert.equal(item.children[1].className, "roster-entry-id");

  const [participantLink] = harness.links("participant");
  const [duckLink] = harness.links("duck");
  for (const link of [participantLink, duckLink]) {
    // Keyboard operable by construction: a real button, not a click-only div or
    // an anchor with no href.
    assert.equal(link.tagName, "BUTTON");
    assert.equal(link.type, "button");
    assert.equal(link.className, "button secondary small");
    assert.ok(link.listeners.get("click")?.length === 1, "the control is activated by a click listener");
  }
  assert.equal(participantLink.textContent, "Participant details · Ada Lovelace");
  assert.equal(participantLink.dataset.rosterParticipantLink, "0b7a1c62-6c1f-4f2e-9d0a-2f7a1c626c1f");
  assert.equal(duckLink.textContent, "Duck #12 in inventory");
  assert.equal(duckLink.dataset.rosterDuckLink, "duck-12");
  assert.equal(duckLink.parentNode.className, "actions");
});

test("a roster entry with no duck assigned offers no duck link", async () => {
  const harness = heatHarness({ roster: [rosterEntry({ duck: null })] });
  await harness.loadHeatDetail("heat-1");

  const [item] = harness.entries();
  assert.equal(item.children[0].textContent, "Slot 1 · Ada Lovelace · No duck");
  assert.equal(harness.links("duck").length, 0);
  assert.equal(harness.links("participant").length, 1);
  assert.equal(item.textTree.includes("in inventory"), false);
});

test("the roster entry builder itself refuses a duck link for an unassigned entry", () => {
  const document = new FakeDocument();
  const { createHeatRosterEntry, text } = build(
    [heatRosterHelpersScript, "text"],
    { document },
    ["createHeatRosterEntry", "text"],
  );

  // Even when a duck action is handed in, an entry with no duck gets no link.
  const item = createHeatRosterEntry({
    entry: rosterEntry({ duck: null }),
    text,
    openParticipant: null,
    openDuck: () => assert.fail("an unassigned entry must not offer a duck link"),
  });
  assert.equal(item.querySelectorAll("[data-roster-duck-link]").length, 0);
  assert.equal(item.children.length, 2, "no empty action row is rendered either");

  const linked = createHeatRosterEntry({
    entry: rosterEntry(),
    text,
    openParticipant: null,
    openDuck: () => {},
  });
  assert.equal(linked.querySelectorAll("[data-roster-duck-link]").length, 1);
});

test("roster deep links follow the actor's console roles", async () => {
  const registrationOnly = heatHarness({ roster: [rosterEntry()], canInventory: false });
  await registrationOnly.loadHeatDetail("heat-1");
  assert.equal(registrationOnly.links("participant").length, 1);
  assert.equal(registrationOnly.links("duck").length, 0);

  const inventoryOnly = heatHarness({ roster: [rosterEntry()], canRegistration: false });
  await inventoryOnly.loadHeatDetail("heat-1");
  assert.equal(inventoryOnly.links("participant").length, 0);
  assert.equal(inventoryOnly.links("duck").length, 1);

  // An announcer may read the heat but open neither section, so the entry keeps
  // its identifier and offers no navigation at all.
  const readOnly = heatHarness({ roster: [rosterEntry()], canRegistration: false, canInventory: false });
  await readOnly.loadHeatDetail("heat-1");
  const [item] = readOnly.entries();
  assert.equal(readOnly.links("participant").length, 0);
  assert.equal(readOnly.links("duck").length, 0);
  assert.equal(item.children.length, 2);
  assert.match(item.textTree, /Race entry 0b7a1c62/);
});

test("the participant link reveals the participants section and loads that participant", async () => {
  const harness = heatHarness({ roster: [rosterEntry()] });
  await harness.loadHeatDetail("heat-1");
  const [participantLink] = harness.links("participant");

  await participantLink.dispatch("click");

  // The deep link switches the Admin view through the hash, then scrolls.
  assert.equal(harness.location.hash, "participants");
  assert.deepEqual(harness.participants.scrollCalls, [{ behavior: "smooth", block: "start" }]);
  assert.ok(harness.opened.some(([kind, value]) => kind === "api" && value === "/api/v1/staff/registrations/registration-1"));
  assert.ok(harness.opened.some(([kind, value]) => kind === "participant-rendered" && value === "registration-1"));
  assert.equal(harness.participantDetail.hidden, false);
  // Focus lands in the loaded panel, so a keyboard user is not left behind.
  assert.equal(harness.participantDetail.focusCount, 1);
  assert.equal(harness.document.activeElement, harness.participantDetail);
});

test("the duck link navigates to the inventory page with that duck selected", async () => {
  const harness = heatHarness({ roster: [rosterEntry()] });
  await harness.loadHeatDetail("heat-1");
  const [duckLink] = harness.links("duck");

  await duckLink.dispatch("click");

  // Inventory is its own page now, so the roster hands the duck to it rather
  // than scrolling to a console section that no longer exists.
  assert.deepEqual(harness.navigations, ["/staff/inventory?duck=duck-12"]);
});

test("a failed roster navigation reports the error instead of throwing", async () => {
  const harness = heatHarness({ roster: [rosterEntry({ participant: { ...rosterEntry().participant, registrationId: "missing" } })] });
  harness.document.hooks.get("[data-participant-detail]").focus = () => { throw new Error("Participant not found."); };
  await harness.loadHeatDetail("heat-1");

  await harness.links("participant")[0].dispatch("click");
  assert.deepEqual(harness.opened.at(-1), ["message", "Participant not found.", true]);
});

// ---------------------------------------------------------------------------
// Deep links and the inventory detail request version
// ---------------------------------------------------------------------------

test("an inventory selection overtaken by the panel closing never renders into it", async () => {
  const pending = new Map();
  const harness = detailHarness({
    ducks: [duck(1, "IN_USE", { reservation: activeReservation }), duck(2, "AVAILABLE")],
    detailDelay: (duckId) => new Promise((resolve) => pending.set(duckId, resolve)),
  });
  await harness.loadInventory();

  const firstSelection = harness.loadDuckDetail("duck-1");
  harness.inventoryDetailController.close();
  pending.get("duck-1")();
  await firstSelection;

  assert.deepEqual(harness.rendered, [], "a superseded request never renders into the panel");
  assert.equal(harness.detail.hidden, true);

  // The next selection still opens normally.
  const secondSelection = harness.loadDuckDetail("duck-2");
  pending.get("duck-2")();
  await secondSelection;
  assert.deepEqual(harness.rendered, ["duck-2"]);
  assert.equal(harness.detail.hidden, false);
});

// ---------------------------------------------------------------------------
// Moderating a participant-chosen duck name
// ---------------------------------------------------------------------------

const registrationDetail = (overrides = {}) => ({
  registrationId: "registration-1",
  raceEntryId: "entry-1",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  phone: "555-0100",
  status: "ACTIVE",
  lookupCode: "ADAA2345",
  createdVia: "PUBLIC",
  notes: null,
  revision: 3,
  assignment: { id: "assignment-1", duck: { id: "duck-12", visibleNumber: 12 } },
  duckName: null,
  duckNamePubliclyHidden: false,
  ...overrides,
});

const participantDetailHarness = ({ canRegistration = true, canDirectRace = false, clearResponse = null } = {}) => {
  const document = new FakeDocument();
  const participantDetail = document.hook("[data-participant-detail]", "article");
  const participantFacts = document.hook("[data-participant-facts]", "dl");
  const participantActions = document.hook("[data-participant-actions]", "div");
  document.hook("[data-participant-name]", "h3");
  const participantDuckNameForm = document.hook("[data-participant-duck-name-form]", "form");
  participantDuckNameForm.hidden = true;
  participantDuckNameForm.elements = { duckName: { value: "" } };
  const facts = [];
  const requests = [];
  const confirmations = [];
  let confirmAnswer = true;
  const participantEditForm = {
    elements: {
      firstName: { value: "" },
      lastName: { value: "" },
      email: { value: "" },
      phone: { value: "" },
      notes: { value: "" },
    },
    reset() {},
  };
  const runtime = build(
    [
      "text",
      "humanize",
      "commandOptions",
      "addParticipantAction",
      "participantDuckNameFact",
      "clearParticipantDuckName",
      "participantIsPaired",
      "renderParticipantDetail",
    ],
    {
      document,
      canRegistration,
      canInventory: false,
      canDirectRace,
      participantDetail,
      participantFacts,
      participantActions,
      participantEditForm,
      participantDuckNameForm,
      selectedRegistration: null,
      showFacts: (container, entries) => facts.push(...entries),
      appConfirm: async (message, options) => {
        confirmations.push([message, options]);
        return confirmAnswer;
      },
      perform: async (button, message, operation) => operation(),
      api: async (url, options) => {
        requests.push([url, options]);
        return clearResponse ?? { registration: registrationDetail({ duckName: null }) };
      },
      loadParticipants: async () => {},
      changeParticipantStatus: async () => {},
      deleteParticipant: async () => {},
      crypto: { randomUUID: () => "11111111-1111-4111-8111-111111111111" },
    },
    ["renderParticipantDetail", "participantDuckNameFact"],
  );
  return {
    ...runtime,
    facts,
    requests,
    confirmations,
    participantActions,
    participantDuckNameForm,
    setConfirmAnswer: (value) => { confirmAnswer = value; },
    action: (label) => participantActions.children.find((child) => child.textContent === label) ?? null,
    actionLabels: () => participantActions.children
      .filter((child) => child.tagName === "BUTTON")
      .map((child) => child.textContent),
    note: () => participantActions.children
      .find((child) => child.dataset.participantActionNote !== undefined) ?? null,
  };
};

// Pairing, not status, decides which destructive action a staffer is offered.
// An unpaired registration has nothing physical in the race, so removing it is
// all that makes sense. A paired one has a duck sealed in a heat bag, so it
// stays in the water and can only be made ineligible to win.
test("an unpaired participant offers Delete and neither Withdraw nor Disqualify", () => {
  for (const status of ["SUBMITTED", "ACTIVE", "WITHDRAWN"]) {
    const harness = participantDetailHarness({ canDirectRace: true });
    harness.renderParticipantDetail(registrationDetail({ assignment: null, status }));
    const labels = harness.actionLabels();
    assert.ok(labels.includes("Delete registration"), `${status}: delete is the destructive action`);
    assert.equal(labels.includes("Withdraw"), false, status);
    assert.equal(labels.includes("Disqualify"), false, status);
    // Nothing is in the water, so there is nothing to explain.
    assert.equal(harness.note(), null, status);
  }

  // Reactivation is not destructive and is unaffected by pairing.
  const withdrawn = participantDetailHarness({ canDirectRace: true });
  withdrawn.renderParticipantDetail(registrationDetail({ assignment: null, status: "WITHDRAWN" }));
  assert.ok(withdrawn.actionLabels().includes("Reactivate"));
});

test("a paired participant offers Withdraw and Disqualify, never Delete, and says why", () => {
  const harness = participantDetailHarness({ canDirectRace: true });
  harness.renderParticipantDetail(registrationDetail({ status: "ACTIVE" }));
  const labels = harness.actionLabels();
  assert.deepEqual(labels.filter((label) => label !== "Reactivate"), ["Withdraw", "Disqualify"]);
  assert.equal(labels.includes("Delete registration"), false);

  // One short sentence beside the actions, naming the duck and the reason.
  const note = harness.note();
  assert.ok(note, "a paired participant is told why delete is unavailable");
  assert.equal(note.tagName, "P");
  assert.equal(note.className, "muted participant-action-note");
  assert.match(note.textContent, /Duck #12 is already sealed in a heat bag/);
  assert.match(note.textContent, /ineligible to be counted as a winner/);
  assert.match(note.textContent, /cannot be deleted/);

  // Disqualification stays a race-director action; withdrawal does not.
  const desk = participantDetailHarness();
  desk.renderParticipantDetail(registrationDetail({ status: "ACTIVE" }));
  assert.deepEqual(desk.actionLabels(), ["Withdraw"]);

  // SUBMITTED versus ACTIVE is not the question: a reactivated participant can
  // be SUBMITTED while still holding the duck, and is still undeletable.
  const reactivated = participantDetailHarness({ canDirectRace: true });
  reactivated.renderParticipantDetail(registrationDetail({ status: "SUBMITTED" }));
  assert.equal(reactivated.actionLabels().includes("Delete registration"), false);
  assert.deepEqual(reactivated.actionLabels(), ["Withdraw", "Disqualify"]);

  // Already out of the race: no status change is offered, and still no delete.
  const disqualified = participantDetailHarness({ canDirectRace: true });
  disqualified.renderParticipantDetail(registrationDetail({ status: "DISQUALIFIED" }));
  assert.deepEqual(disqualified.actionLabels(), ["Reactivate"]);
  assert.ok(disqualified.note(), "the explanation stays while the duck is still paired");
});

test("the participant panel shows the stored duck name and whether it is already hidden", () => {
  const named = participantDetailHarness();
  named.renderParticipantDetail(registrationDetail({ duckName: "Sir Quacks-a-Lot" }));
  assert.deepEqual(
    named.facts.find(([label]) => label === "Duck name"),
    ["Duck name", "Sir Quacks-a-Lot"],
  );
  // The canonical duck number stays its own fact.
  assert.deepEqual(named.facts.find(([label]) => label === "Duck"), ["Duck", "#12"]);

  // Staff need to know when the read-time filter is already suppressing it, or
  // they cannot tell a moderated duck from an unmoderated one.
  const hidden = participantDetailHarness();
  hidden.renderParticipantDetail(registrationDetail({
    duckName: "Regrettable Pun",
    duckNamePubliclyHidden: true,
  }));
  assert.deepEqual(
    hidden.facts.find(([label]) => label === "Duck name"),
    ["Duck name", "Regrettable Pun (already hidden from public surfaces)"],
  );

  const unnamed = participantDetailHarness();
  unnamed.renderParticipantDetail(registrationDetail());
  assert.deepEqual(unnamed.facts.find(([label]) => label === "Duck name"), ["Duck name", "Not named"]);
});

test("clearing a duck name is offered only with a name and the registration role", () => {
  const named = participantDetailHarness();
  named.renderParticipantDetail(registrationDetail({ duckName: "Sir Quacks-a-Lot" }));
  const button = named.action("Clear duck name");
  assert.ok(button, "a named duck offers the moderation action");
  assert.equal(button.tagName, "BUTTON");
  assert.equal(button.type, "button");
  assert.equal(button.className, "button danger small");

  // Nothing to clear means no button at all.
  const unnamed = participantDetailHarness();
  unnamed.renderParticipantDetail(registrationDetail());
  assert.equal(unnamed.action("Clear duck name"), null);

  // UI role filtering is convenience only — the API enforces it — but an
  // announcer or duck manager is not shown a control that would only 403.
  const readOnly = participantDetailHarness({ canRegistration: false });
  readOnly.renderParticipantDetail(registrationDetail({ duckName: "Sir Quacks-a-Lot" }));
  assert.equal(readOnly.action("Clear duck name"), null);
});

test("clearing a duck name confirms first, then posts one idempotent command", async () => {
  const harness = participantDetailHarness();
  harness.renderParticipantDetail(registrationDetail({ duckName: "Sir Quacks-a-Lot" }));

  // Cancelling changes nothing.
  harness.setConfirmAnswer(false);
  await harness.action("Clear duck name").dispatch("click");
  assert.deepEqual(harness.requests, []);
  assert.match(harness.confirmations[0][0], /Clear the duck name chosen by Ada Lovelace/);
  assert.match(harness.confirmations[0][0], /recorded in the audit trail/);
  assert.deepEqual(harness.confirmations[0][1], { danger: true, confirmLabel: "Clear duck name" });

  harness.setConfirmAnswer(true);
  await harness.action("Clear duck name").dispatch("click");
  assert.equal(harness.requests.length, 1);
  const [url, options] = harness.requests[0];
  assert.equal(url, "/api/v1/staff/registrations/registration-1/clear-duck-name");
  assert.equal(options.method, "POST");
  // The shared command envelope, so the browser sends the application Origin
  // the server requires of a cookie-authenticated staff mutation.
  assert.equal(options.headers["content-type"], "application/json");
  // One command identifier and nothing else: the body carries no revision to
  // race against and no participant text.
  assert.deepEqual(Object.keys(JSON.parse(options.body)), ["commandId"]);
  assert.match(JSON.parse(options.body).commandId, /^[0-9a-f-]{36}$/);
  // The offending text is never part of the request.
  assert.equal(options.body.includes("Sir Quacks-a-Lot"), false);

  // The panel repaints from the authoritative response, which has no name left.
  assert.deepEqual(harness.facts.filter(([label]) => label === "Duck name").at(-1), ["Duck name", "Not named"]);
});

// A duck name is what labels a duck someone is racing, so the desk can only set
// one for a participant who already holds a duck. The endpoint refuses it
// otherwise, and the field follows that rule rather than offering a control that
// could only fail.
test("the desk duck-name field appears only for a paired participant with the registration role", () => {
  const paired = participantDetailHarness();
  paired.renderParticipantDetail(registrationDetail({ duckName: "Sir Quacks-a-Lot" }));
  assert.equal(paired.participantDuckNameForm.hidden, false);
  assert.equal(paired.participantDuckNameForm.elements.duckName.value, "Sir Quacks-a-Lot");

  const unnamed = participantDetailHarness();
  unnamed.renderParticipantDetail(registrationDetail());
  assert.equal(unnamed.participantDuckNameForm.hidden, false);
  assert.equal(unnamed.participantDuckNameForm.elements.duckName.value, "");

  const unpaired = participantDetailHarness();
  unpaired.renderParticipantDetail(registrationDetail({ assignment: null }));
  assert.equal(unpaired.participantDuckNameForm.hidden, true, "nothing to name without a duck");

  const readOnly = participantDetailHarness({ canRegistration: false });
  readOnly.renderParticipantDetail(registrationDetail({ duckName: "Sir Quacks-a-Lot" }));
  assert.equal(readOnly.participantDuckNameForm.hidden, true);
});

// ---------------------------------------------------------------------------
// Shipped script and markup guarantees
// ---------------------------------------------------------------------------

test("the new console helpers parse and use no unsafe DOM sinks", () => {
  for (const script of [inventoryGroupHelpersScript, heatRosterHelpersScript]) {
    assert.doesNotThrow(() => new Function(script));
    assert.doesNotMatch(script, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
    assert.doesNotMatch(script, /\b(?:eval|Function)\s*\(/);
  }
  assert.doesNotMatch(staffHomeScript, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.doesNotThrow(() => new Function(staffHomeScript));
  // The grouped list and the roster entries are built with safe DOM APIs only.
  assert.match(inventoryGroupHelpersScript, /inventoryDuckGroupKey/);
  assert.match(heatRosterHelpersScript, /createElement|text\(/);
});

test("the console gates roster deep links on the same roles that gate the sections", () => {
  assert.match(staffHomeScript, /openParticipant: canRegistration && entry\.participant\.registrationId/);
  assert.match(staffHomeScript, /openDuck: canInventory && entry\.duck && entry\.duck\.id/);
  assert.match(staffHomeScript, /const canRegistration = hasRole\("REGISTRATION"\) \|\| hasRole\("RACE_DIRECTOR"\);/);
  assert.match(staffHomeScript, /const canInventory = hasRole\("DUCK_MANAGER"\) \|\| hasRole\("RACE_DIRECTOR"\);/);

  // Role gating in the rendered console is unchanged: the sections a roster link
  // targets are still the role-gated ones.
  const announcer = renderStaffHome("Announcer", false, ["ANNOUNCER"]);
  assert.match(announcer, /<section class="console-section" id="participants"[^>]*data-role-allowed="false"/);
  assert.match(announcer, /<section class="console-section" id="heats"[^>]*data-role-allowed="true"/);
  const director = renderStaffHome("Race Director", false, ["RACE_DIRECTOR"]);
  for (const id of ["participants", "heats"]) {
    assert.match(director, new RegExp(`<section class="console-section" id="${id}"[^>]*data-role-allowed="true"`));
  }
  // The duck link targets the inventory page, which is role-gated at the route.
  assert.doesNotMatch(announcer, /href="\/staff\/inventory"/);
  assert.match(director, /href="\/staff\/inventory"/);
});

test("the inventory page keeps the inventory layout and the console keeps its focusable participant panel", () => {
  const markup = renderStaffHome("Race Director", false, ["RACE_DIRECTOR"]);
  const inventory = renderStaffInventory("Race Director", "https://quickducks.com", false, ["RACE_DIRECTOR"]);

  // The inventory card grid and sticky detail panel are untouched by the move;
  // groups are still rendered inside the existing list container.
  assert.match(inventory, /<div class="inventory-layout"><div class="data-list inventory-card-grid" data-inventory-list><\/div>/);
  assert.match(markup, /\.inventory-group \{ grid-column:1\/-1; display:grid; gap:\.5rem; \}/);
  assert.match(markup, /\.inventory-group-title \{ margin:0; font-size:1\.05rem; overflow-wrap:anywhere; \}/);
  // Roster entries wrap long identifiers instead of overflowing a phone screen.
  assert.match(markup, /\.roster-entry p \{ margin:0; overflow-wrap:anywhere; \}/);
  assert.match(markup, /\.roster-entry-id \{ font-size:\.78rem; color:var\(--muted\); \}/);
  // The participant detail panel is programmatically focusable for deep links.
  assert.match(markup, /<article class="operation-card" tabindex="-1" data-participant-detail hidden>/);
});

// ---------------------------------------------------------------------------
// Participant selection
// ---------------------------------------------------------------------------

const participantSummary = (registrationId, overrides = {}) => ({
  registrationId,
  firstName: "Ada",
  lastName: registrationId.toUpperCase(),
  lookupCode: "AAAA2345",
  status: "SUBMITTED",
  assignment: null,
  ...overrides,
});

const participantListHarness = () => {
  const document = new FakeDocument();
  const participantList = document.hook("[data-participant-list]");
  const participantDetail = document.hook("[data-participant-detail]", "article");
  const participantFacts = document.hook("[data-participant-facts]", "dl");
  const participantActions = document.hook("[data-participant-actions]");
  const participantName = document.hook("[data-participant-name]", "h3");
  participantDetail.hidden = true;
  const messages = [];
  const rendered = [];
  const resets = [];
  let listed = [];
  const runtime = build(
    [
      "let selectedRegistration = null;",
      "text",
      "humanize",
      "empty",
      // A double for the detail renderer: this harness is about which
      // participant is open, not about how the card is drawn.
      "const renderParticipantDetail = (registration) => {\n"
      + "  selectedRegistration = registration;\n"
      + "  participantDetail.hidden = false;\n"
      + "  rendered.push(registration.registrationId);\n"
      + "};",
      "loadParticipantDetail",
      "clearParticipantDetail",
      "markParticipantSelection",
      "toggleParticipantDetail",
      "loadParticipants",
      "const openParticipantId = () => (selectedRegistration === null ? null : selectedRegistration.registrationId);",
    ],
    {
      document,
      participantList,
      participantDetail,
      participantFacts,
      participantActions,
      // This client also runs on `/staff/registration`, so the participants
      // code paths first check that their own markup is on the page.
      participantsPresent: true,
      rendered,
      currentEvent: { id: "event" },
      participantQuery: () => new URLSearchParams({ limit: "200" }),
      participantEditForm: { reset: () => resets.push("edit") },
      setMessage: (message, isError) => messages.push([message, Boolean(isError)]),
      api: async (url) => {
        const detail = url.match(/\/registrations\/([^/?]+)$/);
        if (detail !== null) return { registration: participantSummary(decodeURIComponent(detail[1])) };
        return { registrations: listed };
      },
    },
    ["loadParticipants", "openParticipantId"],
  );
  return {
    ...runtime,
    messages,
    participantDetail,
    participantName,
    rendered,
    setList: (registrations) => { listed = registrations; },
    rows: () => participantList.children,
    row: (registrationId) => participantList.children
      .find((child) => child.dataset.registrationId === registrationId) ?? null,
  };
};

test("pressing the open participant again closes the detail card and clears the highlight", async () => {
  const harness = participantListHarness();
  harness.setList([participantSummary("registration-1"), participantSummary("registration-2")]);
  await harness.loadParticipants();

  await harness.row("registration-1").dispatch("click");
  assert.equal(harness.openParticipantId(), "registration-1");
  assert.equal(harness.participantDetail.hidden, false);
  assert.equal(harness.row("registration-1").className, "result-button is-selected");
  assert.equal(harness.row("registration-1").getAttribute("aria-pressed"), "true");
  assert.equal(harness.row("registration-2").getAttribute("aria-pressed"), "false");

  // The same row again is how staff put a participant down.
  await harness.row("registration-1").dispatch("click");
  assert.equal(harness.openParticipantId(), null);
  assert.equal(harness.participantDetail.hidden, true);
  assert.equal(harness.row("registration-1").className, "result-button");
  assert.equal(harness.row("registration-1").getAttribute("aria-pressed"), "false");
  assert.equal(harness.participantName.textContent, "Participant detail");

  // A different row still opens normally rather than toggling.
  await harness.row("registration-2").dispatch("click");
  assert.equal(harness.openParticipantId(), "registration-2");
  assert.equal(harness.participantDetail.hidden, false);
  assert.deepEqual(harness.rendered, ["registration-1", "registration-2"]);
});

test("a filtered reload drops a detail card the new list no longer contains", async () => {
  const harness = participantListHarness();
  harness.setList([participantSummary("registration-1"), participantSummary("registration-2")]);
  await harness.loadParticipants();
  await harness.row("registration-1").dispatch("click");
  assert.equal(harness.openParticipantId(), "registration-1");

  // "List participants" and the filter form ask for a pruning reload.
  harness.setList([participantSummary("registration-2")]);
  await harness.loadParticipants(true);
  assert.equal(harness.openParticipantId(), null);
  assert.equal(harness.participantDetail.hidden, true);
  assert.equal(harness.row("registration-1"), null);
  assert.equal(harness.row("registration-2").getAttribute("aria-pressed"), "false");
});

test("a reload that still contains the open participant keeps the card and the highlight", async () => {
  const harness = participantListHarness();
  harness.setList([participantSummary("registration-1"), participantSummary("registration-2")]);
  await harness.loadParticipants();
  await harness.row("registration-1").dispatch("click");

  await harness.loadParticipants(true);
  assert.equal(harness.openParticipantId(), "registration-1");
  assert.equal(harness.participantDetail.hidden, false);
  assert.equal(harness.row("registration-1").getAttribute("aria-pressed"), "true");

  // A mutation's direct reload does not prune: the card it just rendered must
  // survive a list the filter no longer matches.
  harness.setList([participantSummary("registration-2")]);
  await harness.loadParticipants();
  assert.equal(harness.openParticipantId(), "registration-1");
  assert.equal(harness.participantDetail.hidden, false);
});

test("event and live refreshes prune participant detail that left the filtered list", () => {
  assert.match(staffHomeScript, /if \(canRegistration\) loads\.push\(loadParticipants\(true\)\)/);
});
