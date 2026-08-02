import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveParentSession,
  summarizeSessionMetrics,
  uniqueMarkerLine,
  waitForIdleSessions,
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

test("session metrics aggregate model usage without transcript content", () => {
  const metrics = summarizeSessionMetrics([
    {
      id: "parent",
      model: { providerID: "openai", id: "gpt-test", variant: "xhigh" },
      cost: 1.25,
      tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 2 } },
      time: { created: 1000, updated: 4000 },
    },
    {
      id: "child",
      parentID: "parent",
      cost: 0.5,
      tokens: { input: 40, output: 10, reasoning: 3, cache: { read: 4, write: 1 } },
      time: { created: 1500, updated: 5000 },
    },
  ]);
  assert.deepEqual(metrics, {
    sessionCount: 2,
    provider: "openai",
    model: "gpt-test",
    variant: "xhigh",
    cost: 1.75,
    tokens: { input: 140, output: 30, reasoning: 8, cacheRead: 34, cacheWrite: 3 },
    modelDurationMs: 4000,
  });
  assert.equal(JSON.stringify(metrics).includes("transcript"), false);
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

test("a verdict followed by a trailing sentence is still a completed turn", async () => {
  const clock = fakeClock();
  const text = [
    "PIPELINE_REVIEW_APPROVED:abc123",
    "No security, privacy, correctness, or contract regressions found.",
  ].join("\n");
  const run = (args) => (args[1] === "list"
    ? listing([{ id: "ses_parent", status: { type: "idle" } }])
    : assistant({ completedAt: 5, text }));

  const result = await waitForOpenChamberSession({
    directory,
    timeoutSeconds: 60,
    markerPrefix: "PIPELINE_REVIEW_",
    run,
    ...clock,
    pollIntervalMs: 10,
    idleGraceMs: 50,
  });

  assert.match(result.lastAssistantMessage.text, /PIPELINE_REVIEW_APPROVED/);
});

test("a marker in an earlier assistant message still completes the turn", async () => {
  const clock = fakeClock();
  const run = (args) => (args[1] === "list"
    ? listing([{ id: "ses_parent", status: { type: "idle" } }])
    : { messages: [
      { completedAt: 4, text: "Detailed findings...\nPIPELINE_REVIEW_APPROVED:abc123" },
      { completedAt: 5, text: "No blocking issues found." },
    ] });

  const result = await waitForOpenChamberSession({
    directory,
    timeoutSeconds: 60,
    markerPrefix: "PIPELINE_REVIEW_",
    run,
    ...clock,
    pollIntervalMs: 10,
    idleGraceMs: 50,
  });

  assert.match(result.lastAssistantMessage.text, /PIPELINE_REVIEW_APPROVED:abc123/);
});

test("conflicting markers across messages decide nothing", async () => {
  const clock = fakeClock();
  const run = (args) => (args[1] === "list"
    ? listing([{ id: "ses_parent", status: { type: "idle" } }])
    : { messages: [
      { completedAt: 4, text: "PIPELINE_REVIEW_APPROVED:abc123" },
      { completedAt: 5, text: "PIPELINE_REVIEW_REJECTED:abc123" },
    ] });

  await assert.rejects(waitForOpenChamberSession({
    directory,
    timeoutSeconds: 600,
    markerPrefix: "PIPELINE_REVIEW_",
    run,
    ...clock,
    pollIntervalMs: 10,
    idleGraceMs: 20,
  }), /without exactly one new PIPELINE_REVIEW_ marker/);
});

test("marker extraction requires exactly one unambiguous marker line", () => {
  assert.equal(
    uniqueMarkerLine({ text: "prose\nPIPELINE_TASK_READY:70\nmore prose" }, "PIPELINE_TASK_"),
    "PIPELINE_TASK_READY:70",
  );
  assert.equal(uniqueMarkerLine({ text: "no marker at all" }, "PIPELINE_TASK_"), null);
  assert.equal(
    uniqueMarkerLine({ text: "PIPELINE_TASK_READY:70\nPIPELINE_TASK_FAILED" }, "PIPELINE_TASK_"),
    null,
  );
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
  }), /became idle without exactly one new PIPELINE_TASK_ marker/);
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
    abort: async () => true,
  }), /did not complete within 1 seconds/);
});

test("a timed-out session is aborted so its work can seed the next attempt", async () => {
  const clock = fakeClock();
  const aborted = [];
  let stopped = false;

  await assert.rejects(waitForOpenChamberSession({
    directory,
    timeoutSeconds: 1,
    markerPrefix: "PIPELINE_TASK_",
    run: (args) => (args[1] === "list"
      ? listing([
        { id: "ses_parent", status: { type: stopped ? "idle" : "busy" } },
        { id: "ses_child", parentID: "ses_parent", status: { type: stopped ? "idle" : "busy" } },
      ])
      : assistant(null)),
    ...clock,
    pollIntervalMs: 250,
    abort: async ({ sessionIds }) => {
      aborted.push(...sessionIds);
      stopped = true;
      return true;
    },
  }), /did not complete within 1 seconds/);

  assert.deepEqual(aborted, ["ses_parent", "ses_child"]);
});

test("an abort failure still reports the timeout instead of hanging", async () => {
  const clock = fakeClock();

  await assert.rejects(waitForOpenChamberSession({
    directory,
    timeoutSeconds: 1,
    markerPrefix: "PIPELINE_TASK_",
    run: () => listing([{ id: "ses_parent", status: { type: "busy" } }]),
    ...clock,
    pollIntervalMs: 250,
    abort: async () => { throw new Error("proxy unreachable"); },
  }), /did not complete within 1 seconds/);
});

test("cleanup waits for a straggler subagent instead of discarding the attempt", async () => {
  const clock = fakeClock();
  const responses = [
    listing([
      { id: "ses_parent", status: { type: "idle" } },
      { id: "ses_child", parentID: "ses_parent", status: { type: "busy" } },
    ]),
    listing([
      { id: "ses_parent", status: { type: "idle" } },
      { id: "ses_child", parentID: "ses_parent", status: { type: "idle" } },
    ]),
  ];

  const sessions = await waitForIdleSessions({
    directory,
    timeoutSeconds: 600,
    requireSession: true,
    run: () => responses.shift(),
    ...clock,
    pollIntervalMs: 10,
  });

  assert.equal(sessions.length, 2);
});

test("cleanup still fails closed on a session that never goes idle", async () => {
  const clock = fakeClock();

  await assert.rejects(waitForIdleSessions({
    directory,
    timeoutSeconds: 1,
    run: () => listing([{ id: "ses_parent", status: { type: "busy" } }]),
    ...clock,
    pollIntervalMs: 250,
  }), /Model sessions remain active after 1 seconds: ses_parent/);
});

test("cleanup fails closed when a dispatched session vanished", async () => {
  const clock = fakeClock();

  await assert.rejects(waitForIdleSessions({
    directory,
    timeoutSeconds: 60,
    requireSession: true,
    run: () => listing([]),
    ...clock,
    pollIntervalMs: 10,
  }), /dispatched model session is missing/);

  assert.deepEqual(await waitForIdleSessions({
    directory,
    timeoutSeconds: 60,
    run: () => listing([]),
    ...clock,
    pollIntervalMs: 10,
  }), []);
});

test("a busy session with no activity is stalled, aborted, and reported", async () => {
  const clock = fakeClock();
  const aborted = [];
  const frozen = [{ id: "ses_parent", status: { type: "busy" }, time: { updated: 100 }, tokens: { input: 0, output: 0 } }];

  await assert.rejects(waitForOpenChamberSession({
    directory,
    timeoutSeconds: 9600,
    markerPrefix: "PIPELINE_TASK_",
    run: () => ({ sessions: frozen }),
    ...clock,
    pollIntervalMs: 1000,
    stallMs: 5000,
    abort: async ({ sessionIds }) => { aborted.push(...sessionIds); return true; },
  }), /stalled: busy for 0 minutes with no activity/);

  assert.deepEqual(aborted, ["ses_parent"]);
});

test("token movement resets the stall clock", async () => {
  const clock = fakeClock();
  let output = 0;
  const run = (args) => {
    if (args[1] === "list") {
      output += 1;
      return { sessions: [{ id: "ses_parent", status: { type: output > 3 ? "idle" : "busy" }, tokens: { input: 1, output } }] };
    }
    return { messages: [{ completedAt: 9, text: "PIPELINE_TASK_READY:70" }] };
  };

  const result = await waitForOpenChamberSession({
    directory,
    timeoutSeconds: 9600,
    markerPrefix: "PIPELINE_TASK_",
    run,
    ...clock,
    pollIntervalMs: 1000,
    stallMs: 2500,
    idleGraceMs: 5000,
  });

  assert.equal(result.sessionId, "ses_parent");
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
