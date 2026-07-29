import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveParentSession,
  waitForOpenChamberSession,
} from "../scripts/wait-for-openchamber-session.mjs";

const directory = "/model/task-1";

function fakeClock() {
  let value = 0;
  return {
    now: () => value,
    sleep: async (duration) => { value += duration; },
  };
}

const listing = (sessions) => ({ sessions });
const assistant = (message) => ({ messages: [message] });

test("the parent session is the one without a parent id", () => {
  const parent = resolveParentSession([
    { id: "ses_child", parentID: "ses_parent", status: { type: "busy" } },
    { id: "ses_parent", status: { type: "idle" } },
  ]);

  assert.equal(parent.id, "ses_parent");
  assert.equal(resolveParentSession([]), null);
  assert.throws(
    () => resolveParentSession([{ id: "ses_one" }, { id: "ses_two" }]),
    /2 parent sessions; refusing to guess/,
  );
});

test("polling adopts a session the dispatch call never confirmed", async () => {
  const clock = fakeClock();
  const responses = [
    listing([]),
    listing([{ id: "ses_parent", status: { type: "busy" } }]),
    listing([{ id: "ses_parent", status: { type: "idle" } }]),
    assistant({ completedAt: 2, text: "Done\nPIPELINE_TASK_READY:69" }),
  ];
  const resolved = [];

  const result = await waitForOpenChamberSession({
    directory,
    timeoutSeconds: 60,
    markerPrefix: "PIPELINE_TASK_",
    run: () => responses.shift(),
    ...clock,
    pollIntervalMs: 10,
    idleGraceMs: 50,
    onSessionResolved: (id) => resolved.push(id),
  });

  assert.equal(result.sessionId, "ses_parent");
  assert.equal(result.lastAssistantMessage.text, "Done\nPIPELINE_TASK_READY:69");
  assert.deepEqual(resolved, ["ses_parent"]);
});

test("polling waits through transient idle and busy child sessions", async () => {
  const clock = fakeClock();
  const responses = [
    listing([{ id: "ses_parent", status: { type: "idle" } }]),
    assistant({ completedAt: 1, text: "Planning" }),
    listing([
      { id: "ses_parent", status: { type: "idle" } },
      { id: "ses_child", parentID: "ses_parent", status: { type: "busy" } },
    ]),
    listing([
      { id: "ses_parent", status: { type: "idle" } },
      { id: "ses_child", parentID: "ses_parent", status: { type: "idle" } },
    ]),
    assistant({ completedAt: 3, text: "Grouped\nPIPELINE_TASK_GROUPED:70" }),
  ];

  const result = await waitForOpenChamberSession({
    directory,
    timeoutSeconds: 60,
    markerPrefix: "PIPELINE_TASK_",
    run: () => responses.shift(),
    ...clock,
    pollIntervalMs: 10,
    idleGraceMs: 50,
  });

  assert.match(result.lastAssistantMessage.text, /PIPELINE_TASK_GROUPED:70/);
});

test("polling fails closed when no session ever appears", async () => {
  const clock = fakeClock();

  await assert.rejects(waitForOpenChamberSession({
    directory,
    timeoutSeconds: 600,
    markerPrefix: "PIPELINE_TASK_",
    run: () => listing([]),
    ...clock,
    pollIntervalMs: 10,
    discoveryMs: 40,
  }), /never reported a dispatched session/);
});

test("polling rejects stable idle without a terminal marker", async () => {
  const clock = fakeClock();
  const run = (args) => (args[1] === "list"
    ? listing([{ id: "ses_parent", status: { type: "idle" } }])
    : assistant({ completedAt: 1, text: "No terminal marker" }));

  await assert.rejects(waitForOpenChamberSession({
    directory,
    timeoutSeconds: 600,
    markerPrefix: "PIPELINE_TASK_",
    run,
    ...clock,
    pollIntervalMs: 10,
    idleGraceMs: 20,
  }), /became idle without a completed PIPELINE_TASK_ marker/);
});

test("polling remains bounded while sessions stay busy", async () => {
  const clock = fakeClock();

  await assert.rejects(waitForOpenChamberSession({
    directory,
    timeoutSeconds: 1,
    markerPrefix: "PIPELINE_TASK_",
    run: () => listing([{ id: "ses_parent", status: { type: "busy" } }]),
    ...clock,
    pollIntervalMs: 250,
  }), /did not complete within 1 seconds/);
});

test("polling tolerates transient control-plane failures", async () => {
  const clock = fakeClock();
  let call = 0;
  const run = (args) => {
    call += 1;
    if (call <= 3) throw new Error("OpenChamber command failed: timed out after 4000ms.");
    return args[1] === "list"
      ? listing([{ id: "ses_parent", status: { type: "idle" } }])
      : assistant({ completedAt: 5, text: "PIPELINE_TASK_READY:69" });
  };

  const result = await waitForOpenChamberSession({
    directory,
    timeoutSeconds: 600,
    markerPrefix: "PIPELINE_TASK_",
    run,
    ...clock,
    pollIntervalMs: 10,
    idleGraceMs: 50,
  });

  assert.equal(result.sessionId, "ses_parent");
});
