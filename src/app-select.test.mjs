import assert from "node:assert/strict";
import test from "node:test";

import { appSelectHelpersScript, appSelectScript, staffHomeScript } from "./client-scripts.ts";
import { createWorker } from "./index.ts";
import {
  renderInventoryIntake,
  renderStaffAccess,
  renderStaffDuck,
  renderStaffHome,
} from "./site.ts";

// The enhancement observes the native select for option and attribute changes.
// Node has no MutationObserver, so this fake proves the wiring and lets tests
// deliver mutation callbacks exactly the way a browser would.
class FakeMutationObserver {
  static instances = [];
  constructor(callback) {
    this.callback = callback;
    this.observed = [];
    this.disconnected = false;
    FakeMutationObserver.instances.push(this);
  }
  observe(target, options) {
    this.observed.push({ target, options });
  }
  disconnect() {
    this.disconnected = true;
  }
  deliver() {
    this.callback([], this);
  }
}
globalThis.MutationObserver = FakeMutationObserver;

const createFakeElement = (doc, tagName) => {
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
    hidden: false,
    disabled: false,
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

const createFakeDocument = () => {
  const doc = { listeners: new Map() };
  doc.createElement = (tag) => createFakeElement(doc, tag);
  doc.addEventListener = (type, handler) => {
    const handlers = doc.listeners.get(type) ?? [];
    handlers.push(handler);
    doc.listeners.set(type, handlers);
  };
  return doc;
};

// Value and selectedIndex live as accessors on a prototype, exactly like
// HTMLSelectElement.prototype, so the tests prove the per-instance
// Object.defineProperty interception delegates to prototype accessors.
const fakeSelectPrototype = {
  get value() {
    const option = this.optionNodes[this.selectedPosition];
    return option ? option.value : "";
  },
  set value(next) {
    this.selectedPosition = this.optionNodes.findIndex((option) => option.value === String(next));
  },
  get selectedIndex() {
    return this.selectedPosition;
  },
  set selectedIndex(next) {
    this.selectedPosition = next;
  },
};

const option = (value, textContent, extra = {}) => ({ value, textContent, disabled: false, ...extra });

const createFakeSelect = (doc, options) => {
  const select = Object.create(fakeSelectPrototype);
  Object.assign(select, createFakeElement(doc, "select"));
  delete select.children;
  select.optionNodes = [];
  select.selectedPosition = -1;
  Object.defineProperty(select, "options", { get() { return this.optionNodes; } });
  select.append = (...nodes) => {
    for (const node of nodes) {
      node.parentNode = select;
      select.optionNodes.push(node);
    }
    if (select.selectedPosition === -1 && select.optionNodes.length > 0) select.selectedPosition = 0;
  };
  select.replaceChildren = (...nodes) => {
    select.optionNodes = [];
    select.selectedPosition = -1;
    select.append(...nodes);
  };
  select.dispatchEvent = (event) => {
    select.dispatch(event.type, event);
    return true;
  };
  select.changeCount = 0;
  select.addEventListener("change", () => { select.changeCount += 1; });
  select.append(...options);
  return select;
};

const createAppSelect = new Function(`${appSelectHelpersScript}; return createAppSelect;`)();

const enhance = (options, configure) => {
  const doc = createFakeDocument();
  const select = createFakeSelect(doc, options);
  if (configure) configure(select);
  const controller = createAppSelect(select, { documentObject: doc });
  return { doc, select, controller };
};

// A searchable select opts in with data-app-select-search, exactly like the
// timezone field the staff console renders.
const enhanceSearchable = (options, configure) => enhance(options, (select) => {
  select.setAttribute("data-app-select-search", "true");
  if (configure) configure(select);
});

const zoneOptions = (values) => values.map((value) => option(value, value));

// Typing into the filter input: the browser updates .value before "input" fires.
const typeIntoFilter = (controller, value) => {
  controller.searchInput.value = value;
  controller.searchInput.dispatch("input", {});
};

test("enhancement builds an ARIA combobox trigger and listbox panel around the hidden native select", () => {
  const { select, controller } = enhance(
    [option("", "All statuses"), option("ACTIVE", "Active")],
    (select) => select.setAttribute("aria-label", "Status"),
  );
  const { trigger, panel, wrapper } = controller;

  assert.equal(trigger.getAttribute("role"), "combobox");
  assert.equal(trigger.getAttribute("aria-haspopup"), "listbox");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(trigger.getAttribute("aria-controls"), panel.id);
  assert.equal(trigger.getAttribute("aria-label"), "Status");
  assert.equal(trigger.type, "button");
  assert.equal(panel.getAttribute("role"), "listbox");
  assert.equal(panel.hidden, true);
  assert.equal(wrapper.className, "app-select");
  assert.ok(wrapper.contains(select));
  assert.ok(wrapper.contains(trigger));
  assert.ok(wrapper.contains(panel));
  // The native select stays form-associated but leaves the accessibility tree.
  assert.ok(select.classList.contains("app-select-native"));
  assert.equal(select.getAttribute("tabindex"), "-1");
  assert.equal(select.getAttribute("aria-hidden"), "true");
  // The trigger shows the current native selection.
  assert.equal(trigger.children[0].textContent, "All statuses");
  // Focus sent to the native select is redirected to the trigger.
  select.dispatch("focus");
  assert.equal(trigger.focusCount, 1);
});

test("opening rebuilds the panel from the live native options with selection state", () => {
  const { select, controller } = enhance([
    option("", "Choose outcome", { disabled: true }),
    option("RETURNED", "Returned, good condition"),
    option("DAMAGED", "Damaged"),
  ]);
  select.selectedPosition = 1;

  controller.open();
  assert.equal(controller.isOpen(), true);
  assert.equal(controller.panel.hidden, false);
  assert.equal(controller.trigger.getAttribute("aria-expanded"), "true");
  const options = controller.optionElements();
  assert.equal(options.length, 3);
  assert.equal(options[0].getAttribute("role"), "option");
  assert.equal(options[0].getAttribute("aria-disabled"), "true");
  assert.equal(options[1].getAttribute("aria-selected"), "true");
  assert.equal(options[2].getAttribute("aria-selected"), "false");
  assert.equal(options[1].textContent, "Returned, good condition");
  assert.equal(controller.trigger.getAttribute("aria-activedescendant"), options[1].id);

  // replaceChildren + append (the console rebuild pattern) is picked up on the
  // next open because the panel is always rebuilt from the live options.
  controller.close(false);
  select.replaceChildren(option("evt_1", "Spring Race · Draft"), option("evt_2", "Fall Race · Registration open"));
  select.value = "evt_2";
  controller.open();
  const rebuilt = controller.optionElements();
  assert.equal(rebuilt.length, 2);
  assert.equal(rebuilt[1].textContent, "Fall Race · Registration open");
  assert.equal(rebuilt[1].getAttribute("aria-selected"), "true");
});

test("picking an option updates the native select and fires exactly one change event", () => {
  const { select, controller } = enhance([
    option("", "All statuses"),
    option("SUBMITTED", "Submitted"),
    option("ACTIVE", "Active"),
  ]);

  controller.open();
  controller.optionElements()[2].dispatch("click");

  assert.equal(select.value, "ACTIVE");
  assert.equal(select.selectedIndex, 2);
  assert.equal(select.changeCount, 1);
  assert.equal(controller.isOpen(), false);
  assert.equal(controller.trigger.getAttribute("aria-expanded"), "false");
  assert.equal(controller.trigger.children[0].textContent, "Active");
  assert.equal(controller.trigger.focusCount, 1);

  // Re-picking the already-selected option must not fire another change.
  controller.open();
  controller.optionElements()[2].dispatch("click");
  assert.equal(select.changeCount, 1);

  // Disabled options are inert.
  select.optionNodes[1].disabled = true;
  controller.open();
  controller.optionElements()[1].dispatch("click");
  assert.equal(select.value, "ACTIVE");
  assert.equal(select.changeCount, 1);
});

test("programmatic value and selectedIndex writes keep the trigger label in sync without change events", () => {
  const { select, controller } = enhance([
    option("evt_1", "Spring Race"),
    option("evt_2", "Fall Race"),
  ]);
  const label = () => controller.trigger.children[0].textContent;

  select.value = "evt_2";
  assert.equal(label(), "Fall Race");
  select.selectedIndex = 0;
  assert.equal(label(), "Spring Race");
  assert.equal(select.changeCount, 0);

  // The interception delegates to the prototype accessors, so reads stay native.
  assert.equal(select.value, "evt_1");
  assert.equal(select.selectedIndex, 0);
});

test("mutation observation refreshes labels after option rebuilds and reflects disabled state", () => {
  const before = FakeMutationObserver.instances.length;
  const { select, controller } = enhance([option("", "Loading events…")]);
  const observer = FakeMutationObserver.instances[before];

  assert.equal(observer.observed.length, 1);
  assert.equal(observer.observed[0].target, select);
  assert.deepEqual(observer.observed[0].options, { attributes: true, childList: true, subtree: true });

  // Simulate the console pattern: rebuild options without touching .value,
  // where only the childList mutation reveals the new selected label.
  select.optionNodes = [option("evt_9", "Winter Race · Draft")];
  select.selectedPosition = 0;
  observer.deliver();
  assert.equal(controller.trigger.children[0].textContent, "Winter Race · Draft");

  // Disabled toggles reach the trigger through the attribute observation.
  select.disabled = true;
  observer.deliver();
  assert.equal(controller.trigger.disabled, true);
  controller.open();
  assert.equal(controller.isOpen(), false);

  select.disabled = false;
  observer.deliver();
  assert.equal(controller.trigger.disabled, false);

  // A disable that arrives while the panel is open closes it.
  controller.open();
  assert.equal(controller.isOpen(), true);
  select.disabled = true;
  observer.deliver();
  assert.equal(controller.isOpen(), false);
});

const keyEvent = (key) => {
  const event = { key, defaultPrevented: false };
  event.preventDefault = () => { event.defaultPrevented = true; };
  return event;
};

test("keyboard follows the combobox pattern: open, move, select, and close", () => {
  const { select, controller } = enhance([
    option("", "All statuses", { disabled: true }),
    option("SUBMITTED", "Submitted"),
    option("ACTIVE", "Active"),
    option("WITHDRAWN", "Withdrawn"),
  ]);
  select.selectedPosition = 1;
  const { trigger } = controller;

  // ArrowDown opens and highlights the current selection.
  const openKey = keyEvent("ArrowDown");
  trigger.dispatch("keydown", openKey);
  assert.equal(openKey.defaultPrevented, true);
  assert.equal(controller.isOpen(), true);
  assert.equal(controller.highlightedIndex(), 1);

  // Arrows move between enabled options without wrapping.
  trigger.dispatch("keydown", keyEvent("ArrowDown"));
  assert.equal(controller.highlightedIndex(), 2);
  trigger.dispatch("keydown", keyEvent("End"));
  assert.equal(controller.highlightedIndex(), 3);
  trigger.dispatch("keydown", keyEvent("ArrowDown"));
  assert.equal(controller.highlightedIndex(), 3);
  trigger.dispatch("keydown", keyEvent("Home"));
  assert.equal(controller.highlightedIndex(), 1);
  trigger.dispatch("keydown", keyEvent("ArrowUp"));
  assert.equal(controller.highlightedIndex(), 1);

  // Enter commits the highlighted option, closes, and returns focus.
  trigger.dispatch("keydown", keyEvent("ArrowDown"));
  trigger.dispatch("keydown", keyEvent("Enter"));
  assert.equal(select.value, "ACTIVE");
  assert.equal(select.changeCount, 1);
  assert.equal(controller.isOpen(), false);
  assert.equal(trigger.focusCount, 1);
  assert.equal(trigger.attributes.has("aria-activedescendant"), false);

  // Escape closes without changing the value.
  trigger.dispatch("keydown", keyEvent(" "));
  assert.equal(controller.isOpen(), true);
  trigger.dispatch("keydown", keyEvent("ArrowUp"));
  trigger.dispatch("keydown", keyEvent("Escape"));
  assert.equal(controller.isOpen(), false);
  assert.equal(select.value, "ACTIVE");
  assert.equal(select.changeCount, 1);
  assert.equal(trigger.focusCount, 2);

  // Tab closes without stealing focus back.
  trigger.dispatch("keydown", keyEvent("Enter"));
  assert.equal(controller.isOpen(), true);
  const tab = keyEvent("Tab");
  trigger.dispatch("keydown", tab);
  assert.equal(controller.isOpen(), false);
  assert.equal(tab.defaultPrevented, false);
  assert.equal(trigger.focusCount, 2);
});

test("type-ahead highlights matches and cycles repeated characters", () => {
  const { controller } = enhance([
    option("ALPHA", "Alpha"),
    option("BETA", "Beta"),
    option("BRAVO", "Bravo"),
  ]);

  controller.open();
  controller.typeAhead("b", 1000);
  assert.equal(controller.highlightedIndex(), 1);
  controller.typeAhead("r", 1100);
  assert.equal(controller.highlightedIndex(), 2);
  // After the buffer resets, a repeated first letter cycles through matches.
  controller.typeAhead("b", 5000);
  assert.equal(controller.highlightedIndex(), 1);
  controller.typeAhead("b", 5100);
  assert.equal(controller.highlightedIndex(), 2);
  controller.typeAhead("b", 5200);
  assert.equal(controller.highlightedIndex(), 1);

  // A printable key on the closed trigger opens the panel and applies type-ahead.
  controller.close(false);
  controller.trigger.dispatch("keydown", keyEvent("A"));
  assert.equal(controller.isOpen(), true);
});

test("a searchable select puts a filter input in the panel and keeps combobox/listbox semantics", () => {
  const { select, controller } = enhanceSearchable(
    zoneOptions(["America/Denver", "America/New_York", "Europe/London"]),
    (select) => select.setAttribute("aria-label", "Timezone"),
  );
  const { trigger, panel, listbox, searchInput } = controller;

  assert.equal(controller.isSearchable(), true);
  // The panel stops being the listbox so a searchbox never sits inside listbox
  // semantics; the listbox moves to its own element and keeps the wiring.
  assert.equal(panel.getAttribute("role"), null);
  assert.equal(listbox.getAttribute("role"), "listbox");
  assert.notEqual(listbox, panel);
  assert.ok(panel.contains(listbox));
  assert.ok(panel.contains(searchInput));
  assert.equal(trigger.getAttribute("role"), "combobox");
  assert.equal(trigger.getAttribute("aria-haspopup"), "listbox");
  assert.equal(trigger.getAttribute("aria-controls"), listbox.id);
  assert.equal(trigger.getAttribute("aria-label"), "Timezone");
  // The filter input is the combobox that owns the list while it holds focus.
  assert.equal(searchInput.type, "text");
  assert.equal(searchInput.getAttribute("role"), "combobox");
  assert.equal(searchInput.getAttribute("aria-autocomplete"), "list");
  assert.equal(searchInput.getAttribute("aria-controls"), listbox.id);
  assert.equal(searchInput.getAttribute("aria-expanded"), "false");
  assert.equal(searchInput.getAttribute("aria-label"), "Filter Timezone");
  assert.equal(searchInput.getAttribute("autocomplete"), "off");
  assert.equal(panel.hidden, true);

  // The control is still the native select underneath, never a text field.
  assert.equal(select.tagName, "SELECT");
  assert.equal(trigger.type, "button");

  controller.open();
  assert.equal(searchInput.getAttribute("aria-expanded"), "true");
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  // Focus moves into the filter so typing narrows instead of type-ahead jumping.
  assert.equal(searchInput.focusCount, 1);
  assert.equal(controller.optionElements().length, 3);
});

test("the filter narrows the list, folds separators, and reports an empty result", () => {
  const { controller } = enhanceSearchable(
    zoneOptions(["America/Denver", "America/New_York", "Europe/London", "Pacific/Auckland"]),
  );
  const visible = () => controller.optionElements().map((element) => element.textContent);

  controller.open();
  assert.deepEqual(visible(), ["America/Denver", "America/New_York", "Europe/London", "Pacific/Auckland"]);

  typeIntoFilter(controller, "den");
  assert.deepEqual(visible(), ["America/Denver"]);
  assert.equal(controller.filterText(), "den");
  assert.equal(controller.emptyMessage.hidden, true);

  // Matching is case-insensitive and substring based, not prefix-only.
  typeIntoFilter(controller, "LONDON");
  assert.deepEqual(visible(), ["Europe/London"]);

  // Underscores and slashes fold to spaces so "new york" finds America/New_York.
  typeIntoFilter(controller, "new york");
  assert.deepEqual(visible(), ["America/New_York"]);
  typeIntoFilter(controller, "america new");
  assert.deepEqual(visible(), ["America/New_York"]);

  typeIntoFilter(controller, "atlantis");
  assert.deepEqual(visible(), []);
  assert.equal(controller.emptyMessage.hidden, false);
  assert.match(controller.emptyMessage.textContent, /No match for/);
  assert.match(controller.emptyMessage.textContent, /atlantis/);
  assert.equal(controller.highlightedIndex(), -1);

  // Clearing restores the full list.
  typeIntoFilter(controller, "");
  assert.deepEqual(visible(), ["America/Denver", "America/New_York", "Europe/London", "Pacific/Auckland"]);
  assert.equal(controller.emptyMessage.hidden, true);
});

test("keyboard selection still works through the filter and fires exactly one change event", () => {
  const { select, controller } = enhanceSearchable(
    zoneOptions(["America/Denver", "America/New_York", "Europe/London", "Pacific/Auckland"]),
  );
  const { searchInput, trigger } = controller;
  select.selectedPosition = 0;

  trigger.dispatch("keydown", keyEvent("ArrowDown"));
  assert.equal(controller.isOpen(), true);
  // The selected option is highlighted and announced from the focused input.
  assert.equal(controller.highlightedIndex(), 0);
  assert.equal(searchInput.getAttribute("aria-activedescendant"), controller.optionElements()[0].id);
  assert.equal(trigger.attributes.has("aria-activedescendant"), false);

  typeIntoFilter(controller, "america");
  assert.equal(controller.highlightedIndex(), 0);
  searchInput.dispatch("keydown", keyEvent("ArrowDown"));
  assert.equal(controller.highlightedIndex(), 1);
  assert.equal(searchInput.getAttribute("aria-activedescendant"), controller.optionElements()[1].id);
  // Arrows stay inside the filtered set instead of walking hidden options.
  searchInput.dispatch("keydown", keyEvent("ArrowDown"));
  assert.equal(controller.highlightedIndex(), 1);

  searchInput.dispatch("keydown", keyEvent("Enter"));
  assert.equal(select.value, "America/New_York");
  assert.equal(select.selectedIndex, 1);
  assert.equal(select.changeCount, 1);
  assert.equal(controller.isOpen(), false);
  assert.equal(trigger.children[0].textContent, "America/New_York");
  assert.equal(trigger.focusCount, 1);
  // Closing clears the filter and the activedescendant wiring on both hosts.
  assert.equal(controller.filterText(), "");
  assert.equal(searchInput.value, "");
  assert.equal(searchInput.getAttribute("aria-expanded"), "false");
  assert.equal(searchInput.attributes.has("aria-activedescendant"), false);
  assert.equal(trigger.attributes.has("aria-activedescendant"), false);

  // Reopening shows the whole list again, highlighting the new selection.
  controller.open();
  assert.equal(controller.optionElements().length, 4);
  assert.equal(controller.highlightedIndex(), 1);

  // Re-picking the same option must not fire a second change.
  searchInput.dispatch("keydown", keyEvent("Enter"));
  assert.equal(select.changeCount, 1);
});

test("pointer selection through a filtered panel updates the native select once", () => {
  const { select, controller } = enhanceSearchable(
    zoneOptions(["America/Denver", "Europe/London", "Pacific/Auckland"]),
  );

  controller.open();
  typeIntoFilter(controller, "auck");
  assert.equal(controller.optionElements().length, 1);
  controller.optionElements()[0].dispatch("click");

  assert.equal(select.value, "Pacific/Auckland");
  assert.equal(select.selectedIndex, 2);
  assert.equal(select.changeCount, 1);
  assert.equal(controller.isOpen(), false);
  assert.equal(controller.trigger.children[0].textContent, "Pacific/Auckland");
});

test("the filter input keeps text keys, while Escape and Tab keep combobox behaviour", () => {
  const { select, controller } = enhanceSearchable(
    zoneOptions(["America/Denver", "Europe/London", "Los Angeles/Test"]),
  );
  const { searchInput, trigger } = controller;
  select.selectedPosition = 0;

  controller.open();
  // Space types a space instead of committing the highlighted option.
  const space = keyEvent(" ");
  searchInput.dispatch("keydown", space);
  assert.equal(space.defaultPrevented, false);
  assert.equal(controller.isOpen(), true);
  assert.equal(select.changeCount, 0);
  // Home/End belong to the caret inside a text field.
  const home = keyEvent("Home");
  searchInput.dispatch("keydown", home);
  assert.equal(home.defaultPrevented, false);
  assert.equal(controller.highlightedIndex(), 0);

  // Escape closes without changing the value and returns focus to the trigger.
  typeIntoFilter(controller, "london");
  searchInput.dispatch("keydown", keyEvent("Escape"));
  assert.equal(controller.isOpen(), false);
  assert.equal(select.value, "America/Denver");
  assert.equal(select.changeCount, 0);
  assert.equal(trigger.focusCount, 1);
  assert.equal(controller.filterText(), "");

  // Tab closes without stealing focus back.
  controller.open();
  const tab = keyEvent("Tab");
  searchInput.dispatch("keydown", tab);
  assert.equal(controller.isOpen(), false);
  assert.equal(tab.defaultPrevented, false);
  assert.equal(trigger.focusCount, 1);
});

test("a printable key on a searchable trigger opens the panel and seeds the filter once", () => {
  const { controller } = enhanceSearchable(
    zoneOptions(["America/Denver", "Europe/London", "Europe/Lisbon"]),
  );

  const key = keyEvent("l");
  controller.trigger.dispatch("keydown", key);

  assert.equal(controller.isOpen(), true);
  // The default action is suppressed so the character is not typed twice.
  assert.equal(key.defaultPrevented, true);
  assert.equal(controller.filterText(), "l");
  assert.equal(controller.searchInput.value, "l");
  assert.deepEqual(
    controller.optionElements().map((element) => element.textContent),
    ["Europe/London", "Europe/Lisbon"],
  );
});

test("a select without the search flag keeps the original single-element listbox panel", () => {
  const { controller } = enhance([option("ONE", "One"), option("TWO", "Two")]);

  assert.equal(controller.isSearchable(), false);
  assert.equal(controller.searchInput, null);
  assert.equal(controller.emptyMessage, null);
  assert.equal(controller.listbox, controller.panel);
  assert.equal(controller.panel.getAttribute("role"), "listbox");
  assert.equal(controller.trigger.getAttribute("aria-controls"), controller.panel.id);

  // Single-keystroke type-ahead still owns typing on unsearchable selects.
  controller.open();
  controller.trigger.dispatch("keydown", keyEvent("t"));
  assert.equal(controller.highlightedIndex(), 1);
});

test("options added after enhancement become filterable without re-enhancing", () => {
  const before = FakeMutationObserver.instances.length;
  const { select, controller } = enhanceSearchable([option("UTC", "UTC")]);
  const observer = FakeMutationObserver.instances[before];

  // The console replaces the bootstrap option with the full runtime zone list.
  select.replaceChildren(...zoneOptions(["America/Denver", "Europe/London", "UTC"]));
  select.value = "Europe/London";
  observer.deliver();
  assert.equal(controller.trigger.children[0].textContent, "Europe/London");

  controller.open();
  assert.equal(controller.optionElements().length, 3);
  typeIntoFilter(controller, "utc");
  assert.deepEqual(controller.optionElements().map((element) => element.textContent), ["UTC"]);
});

test("outside pointerdown closes the panel while inside interaction keeps it open", () => {
  const { doc, controller } = enhance([option("ONE", "One"), option("TWO", "Two")]);

  controller.open();
  const inside = { parentNode: controller.panel };
  for (const handler of doc.listeners.get("pointerdown")) handler({ target: inside });
  assert.equal(controller.isOpen(), true);

  const outside = createFakeElement(doc, "div");
  for (const handler of doc.listeners.get("pointerdown")) handler({ target: outside });
  assert.equal(controller.isOpen(), false);
});

test("enhancement scripts are valid JavaScript and avoid unsafe DOM sinks", () => {
  assert.doesNotThrow(() => new Function(appSelectScript));
  assert.doesNotMatch(appSelectScript, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(appSelectScript, /textContent/);
  assert.match(appSelectScript, /replaceChildren/);
  // Enhancement covers selects added later (heat result forms, staff access rows).
  assert.match(appSelectScript, /new MutationObserver/);
  assert.match(appSelectScript, /appSelectAdditions\.observe\(document\.body, \{ childList: true, subtree: true \}\)/);
  // Multi-selects and list-sized selects keep their native widget.
  assert.match(appSelectScript, /!element\.multiple/);
  // Real change events are dispatched so existing listeners keep working.
  assert.match(appSelectScript, /new Event\("change", \{ bubbles: true \}\)/);
  // Form resets re-sync the trigger label.
  assert.match(appSelectScript, /addEventListener\("reset"/);
  // The filter is opt-in, so short lists keep the plain listbox panel.
  assert.match(appSelectScript, /getAttribute\("data-app-select-search"\) === "true"/);
  // Filter text reaches the DOM as text, never as markup.
  assert.match(appSelectScript, /emptyMessage\.textContent =/);
  assert.doesNotMatch(appSelectScript, /innerText/);
});

// The staff console loads app-select.js and staff-home.js as classic scripts,
// so their top-level bindings share one global scope.
test("the enhancement and the console client declare no colliding globals", () => {
  const topLevel = (source) => new Set(
    [...source.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]),
  );
  const enhancement = topLevel(appSelectScript);
  const console = topLevel(staffHomeScript);

  assert.ok(enhancement.size > 5 && console.size > 5, "both scripts declare globals");
  assert.deepEqual([...enhancement].filter((name) => console.has(name)), []);
});

test("every page with a select loads the shared enhancement script", () => {
  const pages = [
    renderStaffHome("Administrator", true, []),
    renderStaffHome("Registration Staff", false, ["REGISTRATION"]),
    renderStaffAccess("Administrator"),
    renderInventoryIntake("Duck Manager", "https://quickducks.com"),
  ];
  for (const markup of pages) {
    assert.match(markup, /<script src="\/assets\/app-select\.js" defer><\/script>/);
    assert.match(markup, /<select[\s>]/);
  }

  // The staff duck page lost its only select with the disposition form. It
  // still loads the shared script, which is a no-op when no select exists.
  const duckMarkup = renderStaffDuck("tag-token", "Registration Staff");
  assert.match(duckMarkup, /<script src="\/assets\/app-select\.js" defer><\/script>/);
  assert.doesNotMatch(duckMarkup, /<select[\s>]/);
});

test("app-select styling matches the chunky ink/cream/yellow design system and layering rules", () => {
  const markup = renderStaffHome("Administrator", true, []);

  // Trigger looks like the app's form controls: ink border, rounded, tall touch target.
  assert.match(markup, /\.app-select-trigger \{[^}]*min-height:3\.2rem;[^}]*border:2px solid var\(--ink\); border-radius:\.65rem; background:#fff;/);
  assert.match(markup, /\.app-select-trigger:focus-visible \{ outline:4px solid #83d8ec; outline-offset:1px; \}/);
  assert.match(markup, /\.app-select-trigger:disabled \{ opacity:\.55; cursor:not-allowed; \}/);
  // Panel matches the card language: ink border, paper, shadow, rounded, scrolling.
  assert.match(markup, /\.app-select-panel \{ position:absolute; z-index:60;[^}]*max-height:16rem;[^}]*overflow:auto;[^}]*border:3px solid var\(--ink\); border-radius:\.8rem; background:var\(--paper\); box-shadow:4px 4px 0 var\(--ink\); \}/);
  // Options keep 44px touch targets with selected and highlight states.
  assert.match(markup, /\.app-select-option \{[^}]*min-height:2\.75rem;/);
  assert.match(markup, /\.app-select-option\[aria-selected="true"\] \{ background:var\(--yellow\); font-weight:900; \}/);
  assert.match(markup, /\.app-select-option\.is-highlighted \{ outline:3px solid var\(--water-dark\); outline-offset:-3px; \}/);
  // The panel is anchored to its wrapper so a 320px viewport never overflows,
  // and it layers above cards (z-index 5) but below the dialog backdrop (99).
  assert.match(markup, /\.app-select \{ position:relative;/);
  assert.match(markup, /\.app-select-panel \{ position:absolute; z-index:60; top:calc\(100% \+ \.35rem\); right:0; left:0;/);
  assert.match(markup, /\.app-confirmation-backdrop \{ position:fixed; z-index:99;/);
  // The native select stays form-associated but visually hidden.
  assert.match(markup, /select\.app-select-native \{ position:absolute; width:1px; height:1px;[^}]*clip-path:inset\(50%\); opacity:0;[^}]*pointer-events:none; \}/);
  assert.doesNotMatch(markup, /select\.app-select-native \{[^}]*display:none/);

  // The filter row stays visible while the list scrolls, and matches the app's
  // form controls: ink border, rounded, 44px touch target.
  assert.match(markup, /\.app-select-search \{ position:sticky; z-index:1; top:0;[^}]*background:var\(--paper\); \}/);
  assert.match(markup, /\.app-select-search-input \{[^}]*min-height:2\.75rem;[^}]*border:2px solid var\(--ink\); border-radius:\.5rem; background:#fff;/);
  assert.match(markup, /\.app-select-search-input:focus-visible \{ outline:4px solid #83d8ec; outline-offset:1px; \}/);
  assert.match(markup, /\.app-select-empty \{[^}]*color:var\(--muted\);[^}]*\}/);
});

test("the worker serves the enhancement asset uncached", async () => {
  const worker = createWorker();
  const env = { APP_ORIGIN: "https://quickducks.com" };
  const response = await worker.fetch(new Request("https://quickducks.com/assets/app-select.js"), env);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/javascript/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(body, /createAppSelect/);
  assert.match(body, /role", "combobox"/);
});
