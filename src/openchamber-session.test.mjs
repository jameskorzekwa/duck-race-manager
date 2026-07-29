import assert from "node:assert/strict";
import { test } from "node:test";

import { waitForOpenChamberSession } from "../scripts/wait-for-openchamber-session.mjs";

const dispatch = {
  sessionId: "ses_parent",
  directory: "/model/task-1",
  promptDispatched: true,
};

function fakeClock() {
  let value = 0;
  return {
    now: () => value,
    sleep: async (duration) => { value += duration; },
  };
}

test("OpenChamber polling waits through transient idle and busy child sessions", async () => {
  const clock = fakeClock();
  const statuses = [
    [{ id: "ses_parent", status: { type: "idle" } }],
    [
      { id: "ses_parent", status: { type: "busy" } },
      { id: "ses_child", status: { type: "busy" } },
    ],
    [
      { id: "ses_parent", status: { type: "idle" } },
      { id: "ses_child", status: { type: "idle" } },
    ],
  ];
  const messages = [
    { completedAt: 1, text: "Still working" },
    { completedAt: 2, text: "Ready\nPIPELINE_TASK_READY:69" },
  ];
  const run = (args) => args[1] === "list"
    ? { sessions: statuses.shift() }
    : { messages: [messages.shift()] };

  const result = await waitForOpenChamberSession({
    dispatch,
    timeoutSeconds: 10,
    markerPrefix: "PIPELINE_TASK_",
    run,
    ...clock,
    pollIntervalMs: 10,
    idleGraceMs: 50,
  });

  assert.equal(result.lastAssistantMessage.text, "Ready\nPIPELINE_TASK_READY:69");
  assert.deepEqual(result.sessionStatus, { type: "idle" });
});

test("OpenChamber polling rejects stable idle without a terminal marker", async () => {
  const clock = fakeClock();
  const run = (args) => args[1] === "list"
    ? { sessions: [{ id: "ses_parent", status: { type: "idle" } }] }
    : { messages: [{ completedAt: 1, text: "No terminal marker" }] };

  await assert.rejects(waitForOpenChamberSession({
    dispatch,
    timeoutSeconds: 10,
    markerPrefix: "PIPELINE_TASK_",
    run,
    ...clock,
    pollIntervalMs: 10,
    idleGraceMs: 20,
  }), /became idle without a completed PIPELINE_TASK_ marker/);
});

test("OpenChamber polling remains bounded while sessions are busy", async () => {
  const clock = fakeClock();
  const run = () => ({ sessions: [{ id: "ses_parent", status: { type: "busy" } }] });

  await assert.rejects(waitForOpenChamberSession({
    dispatch,
    timeoutSeconds: 1,
    markerPrefix: "PIPELINE_TASK_",
    run,
    ...clock,
    pollIntervalMs: 250,
    idleGraceMs: 20,
  }), /did not complete within 1 seconds/);
});
