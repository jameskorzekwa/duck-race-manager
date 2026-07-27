import assert from "node:assert/strict";
import test from "node:test";

import { appSelectHelpersScript, staffHomeScript, timezonePickerHelpersScript } from "./client-scripts.ts";
import { renderStaffHome } from "./site.ts";

// app-select.js observes the native select for the option rebuild this feature
// performs. Node has no MutationObserver, so this fake delivers it the way a
// browser would.
class FakeMutationObserver {
  static instances = [];
  constructor(callback) {
    this.callback = callback;
    FakeMutationObserver.instances.push(this);
  }
  observe() {}
  disconnect() {}
  deliver() { this.callback([], this); }
}
globalThis.MutationObserver = FakeMutationObserver;

// The helpers run in a browser, so the tests load them with an injectable Intl
// and document. That proves both the detection path and the behaviour on a
// runtime that predates Intl.supportedValuesOf.
const loadHelpers = (intl = Intl, documentObject = undefined) => new Function(
  "Intl",
  "document",
  `${timezonePickerHelpersScript}
   return {
     timezoneFallbackZones,
     timezoneDetect,
     timezoneSupportedZones,
     timezoneZoneList,
     timezoneOptionLabel,
     timezoneApplyValue,
     timezonePopulate,
   };`,
)(intl, documentObject);

const fakeIntl = ({ detected = "America/Denver", zones = null, detectThrows = false }) => ({
  DateTimeFormat: function DateTimeFormat() {
    return {
      resolvedOptions() {
        if (detectThrows) throw new RangeError("no zone");
        return { timeZone: detected };
      },
    };
  },
  ...(zones === null ? {} : { supportedValuesOf: () => zones.slice() }),
});

const createBrowserElement = (doc, tagName) => {
  const element = {
    tagName: String(tagName).toUpperCase(),
    ownerDocument: doc,
    children: [],
    parentNode: null,
    attributes: new Map(),
    listeners: new Map(),
    classNames: new Set(),
    className: "",
    textContent: "",
    value: "",
    hidden: false,
    disabled: false,
    selected: false,
    defaultSelected: false,
    id: "",
    type: "",
    focusCount: 0,
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; },
    removeAttribute(name) { this.attributes.delete(name); },
    append(...nodes) {
      for (const node of nodes) {
        node.parentNode = this;
        this.children.push(node);
      }
    },
    replaceChildren(...nodes) {
      this.children = [];
      this.append(...nodes);
    },
    insertBefore(node, reference) {
      node.parentNode = this;
      const at = this.children.indexOf(reference);
      if (at === -1) this.children.push(node);
      else this.children.splice(at, 0, node);
      return node;
    },
    contains(node) {
      let current = node;
      while (current) {
        if (current === this) return true;
        current = current.parentNode;
      }
      return false;
    },
    focus() { this.focusCount += 1; },
    addEventListener(type, handler) {
      const handlers = this.listeners.get(type) ?? [];
      handlers.push(handler);
      this.listeners.set(type, handlers);
    },
    dispatch(type, event = {}) {
      for (const handler of this.listeners.get(type) ?? []) handler(event);
    },
  };
  element.classList = {
    add: (...names) => { for (const name of names) element.classNames.add(name); },
    remove: (...names) => { for (const name of names) element.classNames.delete(name); },
    contains: (name) => element.classNames.has(name),
  };
  return element;
};

const createBrowserDocument = () => {
  const doc = { listeners: new Map() };
  doc.createElement = (tagName) => createBrowserElement(doc, tagName);
  doc.addEventListener = (type, handler) => {
    const handlers = doc.listeners.get(type) ?? [];
    handlers.push(handler);
    doc.listeners.set(type, handlers);
  };
  return doc;
};

// value and selectedIndex live on a prototype exactly like HTMLSelectElement,
// and appending an option marked selected moves the selection, so the helpers
// are exercised against real select semantics.
const browserSelectPrototype = {
  get value() {
    const option = this.optionNodes[this.selectedPosition];
    return option ? option.value : "";
  },
  set value(next) {
    const at = this.optionNodes.findIndex((option) => option.value === String(next));
    if (at === -1) return;
    this.selectedPosition = at;
    this.syncSelected();
  },
  get selectedIndex() {
    return this.selectedPosition;
  },
  set selectedIndex(next) {
    this.selectedPosition = next;
    this.syncSelected();
  },
};

const createBrowserSelect = (doc, attributes = {}) => {
  const select = Object.create(browserSelectPrototype);
  const base = createBrowserElement(doc, "select");
  // A select resolves value and children through its options, not own properties.
  delete base.children;
  delete base.value;
  select.optionNodes = [];
  select.selectedPosition = -1;
  Object.assign(select, base);
  select.changeCount = 0;
  for (const [name, value] of Object.entries(attributes)) select.attributes.set(name, String(value));
  Object.defineProperty(select, "options", { get() { return select.optionNodes; } });
  select.syncSelected = () => {
    select.optionNodes.forEach((option, index) => { option.selected = index === select.selectedPosition; });
  };
  select.append = (...nodes) => {
    for (const node of nodes) {
      node.parentNode = select;
      select.optionNodes.push(node);
    }
    const explicit = select.optionNodes.findIndex((option) => option.selected);
    if (explicit !== -1) select.selectedPosition = explicit;
    else if (select.selectedPosition === -1 && select.optionNodes.length > 0) select.selectedPosition = 0;
    select.syncSelected();
  };
  select.replaceChildren = (...nodes) => {
    select.optionNodes = [];
    select.selectedPosition = -1;
    select.append(...nodes);
  };
  select.insertBefore = (node, reference) => {
    node.parentNode = select;
    const at = select.optionNodes.indexOf(reference);
    if (at === -1) select.optionNodes.push(node);
    else select.optionNodes.splice(at, 0, node);
    const selectedNode = select.optionNodes[select.selectedPosition];
    if (selectedNode) select.selectedPosition = select.optionNodes.indexOf(selectedNode);
    return node;
  };
  select.dispatchEvent = (event) => {
    select.dispatch(event.type, event);
    return true;
  };
  select.addEventListener("change", () => { select.changeCount += 1; });
  return select;
};

const createFakeDocument = createBrowserDocument;

const createFakeSelect = (doc, { value = "", attributes = {} } = {}) => {
  const select = createBrowserSelect(doc, attributes);
  // The server renders one valid option so the field is never empty.
  if (value !== "") {
    const bootstrap = doc.createElement("option");
    bootstrap.value = value;
    bootstrap.textContent = value;
    select.append(bootstrap);
  }
  return select;
};

const createAppSelect = new Function(
  "MutationObserver",
  `${appSelectHelpersScript}; return createAppSelect;`,
)(FakeMutationObserver);

const optionValues = (select) => select.options.map((option) => option.value);
const optionLabels = (select) => select.options.map((option) => option.textContent);

test("the browser zone is detected from Intl and falls back to UTC when unavailable", () => {
  assert.equal(loadHelpers(fakeIntl({ detected: "Australia/Sydney" })).timezoneDetect(), "Australia/Sydney");
  assert.equal(loadHelpers(fakeIntl({ detectThrows: true })).timezoneDetect(), "UTC");
  assert.equal(loadHelpers(fakeIntl({ detected: "" })).timezoneDetect(), "UTC");
  // A runtime that resolves no zone at all also falls back.
  const withoutZone = { DateTimeFormat: function DateTimeFormat() { return { resolvedOptions: () => ({}) }; } };
  assert.equal(loadHelpers(withoutZone).timezoneDetect(), "UTC");

  // Against the real runtime it returns the actual resolved zone.
  const real = loadHelpers().timezoneDetect();
  assert.equal(real, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.doesNotThrow(() => new Intl.DateTimeFormat("en-US", { timeZone: real }));
});

test("the option source is Intl.supportedValuesOf with a real-zone fallback list", () => {
  const supported = loadHelpers().timezoneSupportedZones();
  assert.deepEqual(supported, Intl.supportedValuesOf("timeZone"));
  assert.ok(supported.length > 100, "the runtime list carries hundreds of zones");

  // Runtimes without supportedValuesOf, and a throwing implementation, fall back.
  const withoutSupport = loadHelpers(fakeIntl({ detected: "UTC" }));
  const fallback = withoutSupport.timezoneSupportedZones();
  assert.deepEqual(fallback, withoutSupport.timezoneFallbackZones);
  assert.ok(fallback.includes("UTC"));
  assert.ok(fallback.length >= 40, "the fallback still covers the globe");

  const throwing = loadHelpers({
    DateTimeFormat: fakeIntl({}).DateTimeFormat,
    supportedValuesOf: () => { throw new RangeError("unsupported"); },
  });
  assert.deepEqual(throwing.timezoneSupportedZones(), throwing.timezoneFallbackZones);
  assert.deepEqual(loadHelpers(fakeIntl({ zones: [] })).timezoneSupportedZones(), fallback);

  // Every bundled fallback zone must be a zone the server will also accept.
  for (const zone of fallback) {
    assert.doesNotThrow(
      () => new Intl.DateTimeFormat("en-US", { timeZone: zone }),
      `fallback zone ${zone} must be a real IANA zone`,
    );
  }
  assert.equal(new Set(fallback).size, fallback.length, "the fallback list has no duplicates");
});

test("a create-form select defaults to the detected zone and marks it in the list", () => {
  const helpers = loadHelpers(fakeIntl({ detected: "Europe/Lisbon", zones: ["America/Denver", "Europe/Lisbon", "UTC"] }));
  const doc = createFakeDocument();
  // Exactly what the server renders for the create form.
  const select = createFakeSelect(doc, { value: "UTC", attributes: { "data-timezone-detect": "true" } });

  const result = helpers.timezonePopulate(select, { documentObject: doc });

  assert.equal(result.detected, "Europe/Lisbon");
  assert.equal(result.desired, "Europe/Lisbon");
  // Detection wins over the server-rendered bootstrap value when nothing is set.
  assert.equal(select.value, "Europe/Lisbon");
  assert.deepEqual(optionValues(select), ["America/Denver", "Europe/Lisbon", "UTC"]);
  // The detected zone is obvious in the list, but the submitted value stays bare.
  assert.deepEqual(optionLabels(select), ["America/Denver", "Europe/Lisbon (detected)", "UTC"]);
  const detectedOption = select.options.find((option) => option.value === "Europe/Lisbon");
  assert.equal(detectedOption.getAttribute("data-detected"), "true");
  assert.equal(detectedOption.selected, true);
  // defaultSelected keeps the detected zone after the create form is reset.
  assert.equal(detectedOption.defaultSelected, true);
  assert.equal(select.options.filter((option) => option.defaultSelected).length, 1);
  assert.equal(select.getAttribute("data-timezone-detected"), "Europe/Lisbon");
});

test("a detected zone missing from the runtime list is still selectable", () => {
  const helpers = loadHelpers(fakeIntl({ detected: "US/Mountain", zones: ["America/Denver", "UTC"] }));
  const doc = createFakeDocument();
  const select = createFakeSelect(doc, { value: "UTC", attributes: { "data-timezone-detect": "true" } });

  helpers.timezonePopulate(select, { documentObject: doc });

  assert.equal(select.value, "US/Mountain");
  assert.deepEqual(optionValues(select), ["America/Denver", "US/Mountain", "UTC"]);
  assert.ok(optionLabels(select).includes("US/Mountain (detected)"));
});

test("a config-form select keeps its rendered value and is filled with the full zone list", () => {
  const helpers = loadHelpers(fakeIntl({ detected: "America/Denver", zones: ["America/Denver", "Europe/London", "UTC"] }));
  const doc = createFakeDocument();
  // The config form carries no detect flag: its value comes from the event.
  const select = createFakeSelect(doc, { value: "UTC" });

  const result = helpers.timezonePopulate(select, { documentObject: doc });

  assert.equal(result.desired, "UTC");
  assert.equal(select.value, "UTC");
  assert.deepEqual(optionValues(select), ["America/Denver", "Europe/London", "UTC"]);
  // The detected zone stays labelled even when it is not the selection.
  assert.ok(optionLabels(select).includes("America/Denver (detected)"));

  // A zone stored before this feature loads and displays without being changed.
  helpers.timezoneApplyValue(select, "Europe/London", { documentObject: doc });
  assert.equal(select.value, "Europe/London");
  assert.equal(select.options.length, 3);
});

test("an existing stored zone the runtime does not list is added in order and selected", () => {
  const helpers = loadHelpers(fakeIntl({ detected: "America/Denver", zones: ["America/Denver", "Europe/London", "UTC"] }));
  const doc = createFakeDocument();
  const select = createFakeSelect(doc, { value: "UTC" });
  helpers.timezonePopulate(select, { documentObject: doc });

  const applied = helpers.timezoneApplyValue(select, "Asia/Calcutta", { documentObject: doc });

  assert.equal(applied, "Asia/Calcutta");
  assert.equal(select.value, "Asia/Calcutta");
  // Inserted in sorted position rather than appended after UTC.
  assert.deepEqual(optionValues(select), ["America/Denver", "Asia/Calcutta", "Europe/London", "UTC"]);
  // A legacy alias is never relabelled as detected.
  assert.equal(select.options[1].textContent, "Asia/Calcutta");
  assert.equal(select.options[1].defaultSelected, false);

  // Re-applying an existing zone selects it without duplicating the option.
  helpers.timezoneApplyValue(select, "Europe/London", { documentObject: doc });
  assert.equal(select.value, "Europe/London");
  assert.equal(select.options.length, 4);

  // Blank or non-string values leave the current selection alone.
  assert.equal(helpers.timezoneApplyValue(select, "", { documentObject: doc }), "Europe/London");
  assert.equal(helpers.timezoneApplyValue(select, null, { documentObject: doc }), "Europe/London");
  assert.equal(select.options.length, 4);
});

test("zone lists are sorted and free of duplicates", () => {
  const helpers = loadHelpers(fakeIntl({ detected: "UTC", zones: ["Pacific/Auckland", "America/Denver", "UTC"] }));

  const zones = helpers.timezoneZoneList("UTC", "UTC");
  assert.deepEqual(zones, ["America/Denver", "Pacific/Auckland", "UTC"]);
  assert.equal(new Set(zones).size, zones.length);

  const withExtras = helpers.timezoneZoneList("US/Mountain", "Asia/Calcutta");
  assert.deepEqual(withExtras, ["America/Denver", "Asia/Calcutta", "Pacific/Auckland", "US/Mountain", "UTC"]);
});

test("both staff timezone fields are searchable selects, never text inputs", () => {
  const markup = renderStaffHome("Administrator", true, []);
  const createForm = markup.match(/<form data-event-create-form>[^]*?<\/form>/)?.[0];
  const configForm = markup.match(/<form data-event-config-form>[^]*?<\/form>/)?.[0];
  assert.ok(createForm && configForm);

  // The free-text field is gone from every form on the page.
  assert.doesNotMatch(markup, /<input[^>]*name="timezone"/);
  assert.doesNotMatch(markup, /name="timezone" maxlength/);

  for (const form of [createForm, configForm]) {
    const field = form.match(/<select name="timezone"[^>]*>/)?.[0];
    assert.ok(field, "the timezone control is a select");
    // Form-associated, required, and enhanced into the searchable app control.
    assert.match(field, /\brequired\b/);
    assert.match(field, /\bdata-timezone-select\b/);
    assert.match(field, /data-app-select-search="true"/);
    // The server renders the current value only, not hundreds of zones.
    const options = form.match(/<select name="timezone"[^]*?<\/select>/)?.[0];
    assert.equal([...options.matchAll(/<option/g)].length, 1);
    assert.match(options, /<option value="UTC">UTC<\/option>/);
  }

  // Only the create form has no stored zone yet, so only it asks for detection.
  assert.match(createForm, /<select name="timezone"[^>]*data-timezone-detect="true"/);
  assert.doesNotMatch(configForm, /data-timezone-detect/);
  assert.match(createForm, /Detected from this device/);

  // No page ships the IANA list in its HTML.
  assert.doesNotMatch(markup, /America\/Denver|Europe\/London|Pacific\/Auckland/);
  assert.ok(markup.length < 200_000, "the staff page stays small");

  // The enhancement and the console client are both loaded.
  assert.match(markup, /<script src="\/assets\/app-select\.js" defer><\/script>/);
  assert.match(markup, /<script src="\/assets\/staff-home\.js" defer><\/script>/);
});

// End-to-end across both browser scripts: app-select.js enhances the
// server-rendered select first, then staff-home.js fills it from the runtime
// zone list, exactly as the two deferred scripts run on the staff page.
const createEnhancedTimezoneField = ({ detect }) => {
  const doc = createBrowserDocument();
  const select = createBrowserSelect(doc, {
    "data-timezone-select": "",
    "data-app-select-search": "true",
    ...(detect ? { "data-timezone-detect": "true" } : {}),
  });
  // The single option the server renders keeps the field valid before scripts run.
  const bootstrap = doc.createElement("option");
  bootstrap.value = "UTC";
  bootstrap.textContent = "UTC";
  select.append(bootstrap);
  const parent = doc.createElement("div");
  parent.append(select);

  const observerCount = FakeMutationObserver.instances.length;
  const controller = createAppSelect(select, { documentObject: doc });
  const observer = FakeMutationObserver.instances[observerCount];
  const helpers = loadHelpers(Intl, doc);
  return { doc, select, controller, helpers, applyRebuild: () => observer.deliver() };
};

test("the enhanced create field defaults to the detected zone and searches the full IANA list", () => {
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { select, controller, helpers, applyRebuild } = createEnhancedTimezoneField({ detect: true });

  // Before enhancement data arrives the field already holds a valid value.
  assert.equal(select.value, "UTC");
  assert.equal(select.tagName, "SELECT");

  helpers.timezonePopulate(select, { documentObject: select.ownerDocument });
  applyRebuild();

  // Detection supplies the default selection when nothing is set yet.
  assert.equal(select.value, detected);
  // The runtime list omits UTC because it is a link, so the picker adds it back:
  // it is the value the server renders and a zone operators genuinely pick.
  assert.equal(Intl.supportedValuesOf("timeZone").includes("UTC"), false);
  assert.equal(
    select.options.length,
    new Set([...Intl.supportedValuesOf("timeZone"), "UTC", detected]).size,
  );
  assert.ok(select.options.some((option) => option.value === "UTC"));
  // The trigger shows the detected zone and says so.
  assert.equal(controller.trigger.children[0].textContent, detected + " (detected)");
  assert.equal(select.changeCount, 0, "populating is not a user change");

  controller.open();
  assert.equal(controller.optionElements().length, select.options.length);
  assert.ok(controller.optionElements().length > 100, "hundreds of zones are listed");
  assert.equal(controller.searchInput.focusCount, 1);

  // Typing narrows hundreds of zones down to the intended one. The target is
  // chosen away from this machine's own zone so the run is location independent.
  const target = detected === "America/Denver" ? "Europe/London" : "America/Denver";
  controller.searchInput.value = target.split("/")[1].toLowerCase();
  controller.searchInput.dispatch("input", {});
  assert.deepEqual(controller.optionElements().map((element) => element.textContent), [target]);

  // Keyboard selection commits it and fires exactly one change event.
  controller.searchInput.dispatch("keydown", { key: "Enter", preventDefault() {} });
  assert.equal(select.value, target);
  assert.equal(select.changeCount, 1);
  assert.equal(controller.isOpen(), false);
  assert.equal(controller.trigger.children[0].textContent, target);
  // The submitted value is the bare identifier the server validates.
  assert.doesNotThrow(() => new Intl.DateTimeFormat("en-US", { timeZone: select.value }));
});

test("the enhanced config field loads an existing stored zone, including a legacy link", () => {
  const { select, controller, helpers, applyRebuild } = createEnhancedTimezoneField({ detect: false });
  helpers.timezonePopulate(select, { documentObject: select.ownerDocument });
  applyRebuild();

  // renderEvent applies the zone the API returned for the draft.
  helpers.timezoneApplyValue(select, "Europe/London", { documentObject: select.ownerDocument });
  applyRebuild();
  assert.equal(select.value, "Europe/London");
  assert.equal(controller.trigger.children[0].textContent, "Europe/London");

  // A zone stored before this feature that the runtime list omits still loads.
  assert.equal(Intl.supportedValuesOf("timeZone").includes("US/Mountain"), false);
  helpers.timezoneApplyValue(select, "US/Mountain", { documentObject: select.ownerDocument });
  applyRebuild();
  assert.equal(select.value, "US/Mountain");
  assert.equal(controller.trigger.children[0].textContent, "US/Mountain");
  assert.equal(select.changeCount, 0, "loading an event is not a user change");

  // It is selectable and findable in the open panel like any other zone.
  controller.open();
  controller.searchInput.value = "mountain";
  controller.searchInput.dispatch("input", {});
  assert.ok(controller.optionElements().some((element) => element.textContent === "US/Mountain"));
});

test("the timezone picker script parses, uses the runtime zone source, and avoids unsafe sinks", () => {
  assert.doesNotThrow(() => new Function(timezonePickerHelpersScript));
  assert.doesNotThrow(() => new Function(staffHomeScript));

  for (const script of [timezonePickerHelpersScript, staffHomeScript]) {
    assert.doesNotMatch(script, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
  }
  // Options are built as nodes with text, never markup.
  assert.match(timezonePickerHelpersScript, /createElement\("option"\)/);
  assert.match(timezonePickerHelpersScript, /option\.textContent = timezoneOptionLabel/);
  assert.match(timezonePickerHelpersScript, /replaceChildren\(/);

  // Detection and the client-side option source are exactly the required APIs.
  assert.match(timezonePickerHelpersScript, /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/);
  assert.match(timezonePickerHelpersScript, /typeof Intl\.supportedValuesOf === "function"/);
  assert.match(timezonePickerHelpersScript, /Intl\.supportedValuesOf\("timeZone"\)/);

  // The console fills every timezone select and sends the value on create.
  assert.match(staffHomeScript, /document\.querySelectorAll\("\[data-timezone-select\]"\)/);
  assert.match(staffHomeScript, /timezonePopulate\(select, timezoneContext\)/);
  assert.match(
    staffHomeScript,
    /timezoneApplyValue\(eventConfigForm\.elements\.timezone, currentEvent\.timezone, timezoneContext\)/,
  );
  assert.match(staffHomeScript, /timezone: String\(values\.get\("timezone"\)\)/);
  // The old free-text assignment is gone.
  assert.doesNotMatch(staffHomeScript, /eventConfigForm\.elements\.timezone\.value =/);
});
