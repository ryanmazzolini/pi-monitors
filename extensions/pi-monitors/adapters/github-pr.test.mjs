import assert from "node:assert/strict";
import test from "node:test";
import { createPiMonitorsExtension } from "../index.ts";
import { MONITOR_BATCH_MESSAGE_TYPE } from "../types.ts";
import {
  collectFeedback,
  createGithubPrMonitorAdapter,
  formatFeedback,
  parsePullRequestUrl,
} from "./github-pr.ts";

const PR_URL = "https://github.com/acme/widgets/pull/42";
const NOW = Date.parse("2026-08-01T12:00:00Z");

function pr(overrides = {}) {
  return { owner: "acme", repo: "widgets", number: 42, url: PR_URL, title: "Keep widgets correct", state: "OPEN", ...overrides };
}

function issueComment(overrides = {}) {
  return {
    id: 101,
    node_id: "IC_101",
    user: { login: "reviewer" },
    body: "Please cover the error path.",
    created_at: "2026-08-01T11:00:00Z",
    updated_at: "2026-08-01T11:00:00Z",
    html_url: `${PR_URL}#issuecomment-101`,
    ...overrides,
  };
}

function review(overrides = {}) {
  return {
    id: 201,
    node_id: "PRR_201",
    user: { login: "reviewer" },
    body: "One overall concern.",
    state: "CHANGES_REQUESTED",
    submitted_at: "2026-08-01T11:01:00Z",
    html_url: `${PR_URL}#pullrequestreview-201`,
    commit_id: "a".repeat(40),
    ...overrides,
  };
}

function reviewComment(overrides = {}) {
  return {
    id: 301,
    node_id: "PRRC_301",
    user: { login: "reviewer" },
    body: "This can return undefined.",
    created_at: "2026-08-01T11:02:00Z",
    updated_at: "2026-08-01T11:02:00Z",
    html_url: `${PR_URL}#discussion_r301`,
    path: "src/widget.ts",
    line: 18,
    ...overrides,
  };
}

function ok(value) {
  return { code: 0, stdout: JSON.stringify(value), stderr: "" };
}

function fakeTimer() {
  const timers = [];
  return {
    timers,
    schedule(callback, delayMs) {
      const timer = { callback, delayMs, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancelSchedule(timer) { timer.cancelled = true; },
    latest(delayMs) {
      const timer = [...timers].reverse().find((candidate) => !candidate.cancelled && candidate.delayMs === delayMs);
      assert.ok(timer, `missing ${delayMs}ms timer`);
      return timer;
    },
  };
}

function fixture({
  entries = [],
  pullRequests = new Map([[PR_URL, { number: 42, url: PR_URL, title: "Keep widgets correct", state: "OPEN" }]]),
  snapshots = new Map([[PR_URL, { pull: { state: "open", title: "Keep widgets correct" }, comments: [], reviews: [], reviewComments: [] }]]),
  beforeExec,
} = {}) {
  const handlers = new Map();
  const tools = [];
  const commands = new Map();
  const renderers = new Map();
  const sent = [];
  const statuses = [];
  const notifications = [];
  const execCalls = [];
  const eventListeners = new Map();
  const timer = fakeTimer();
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerTool(tool) { tools.push(tool); },
    registerCommand(name, command) { commands.set(name, command); },
    registerMessageRenderer(type, renderer) { renderers.set(type, renderer); },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data, timestamp: new Date(NOW).toISOString() }); },
    sendMessage(...args) { sent.push(args); },
    events: {
      on(channel, listener) {
        const listeners = eventListeners.get(channel) ?? new Set();
        listeners.add(listener);
        eventListeners.set(channel, listeners);
        return () => listeners.delete(listener);
      },
      emit(channel, value) { for (const listener of eventListeners.get(channel) ?? []) listener(value); },
    },
    async exec(command, args, options) {
      execCalls.push({ command, args: [...args], options });
      await beforeExec?.(command, args, options);
      if (command !== "gh") throw new Error(`unexpected command: ${command}`);
      if (args[0] === "pr" && args[1] === "view") {
        const result = pullRequests.get(args[2]);
        return result ? ok(result) : { code: 1, stdout: "", stderr: "not found" };
      }
      assert.equal(args[0], "api");
      const rawEndpoint = args.at(-1);
      const [endpoint, query = ""] = rawEndpoint.split("?", 2);
      const match = /^repos\/([^/]+)\/([^/]+)\/(?:pulls|issues)\/(\d+)/.exec(endpoint);
      assert.ok(match, endpoint);
      const url = `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`;
      const snapshot = snapshots.get(url);
      if (!snapshot) return { code: 1, stdout: "", stderr: "not found" };
      if (/\/pulls\/\d+$/.test(endpoint)) return ok({ number: Number(match[3]), html_url: url, ...snapshot.pull });
      const page = Number(new URLSearchParams(query).get("page") ?? "1");
      if (/\/issues\/\d+\/comments$/.test(endpoint)) return ok((snapshot.commentPages ?? [snapshot.comments])[page - 1] ?? []);
      if (/\/pulls\/\d+\/reviews$/.test(endpoint)) return ok((snapshot.reviewPages ?? [snapshot.reviews])[page - 1] ?? []);
      if (/\/pulls\/\d+\/comments$/.test(endpoint)) return ok((snapshot.reviewCommentPages ?? [snapshot.reviewComments])[page - 1] ?? []);
      throw new Error(`unexpected endpoint: ${endpoint}`);
    },
  };
  const ctx = {
    cwd: "/unrelated/directory",
    mode: "tui",
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => "session-1",
      getSessionFile: () => "/sessions/session-1.jsonl",
    },
    ui: {
      theme: { fg: (_color, text) => text },
      setStatus(key, value) { statuses.push({ key, value }); },
      notify(message, level) { notifications.push({ message, level }); },
    },
  };
  const adapter = createGithubPrMonitorAdapter({
    pollIntervalMs: 60_000,
    maxBackoffMs: 15 * 60_000,
    now: () => NOW,
    schedule: timer.schedule,
    cancelSchedule: timer.cancelSchedule,
  });
  let runtime;
  const hostRuntime = createPiMonitorsExtension(pi, [{ id: adapter.id, bind(api, services) { runtime = adapter.bind(api, services); return runtime; } }]);
  return { handlers, tools, commands, renderers, sent, statuses, notifications, execCalls, entries, timer, pi, ctx, runtime, hostRuntime };
}

async function start(f, reason = "startup") {
  await f.handlers.get("session_start")({ reason }, f.ctx);
}

async function settleDelivery() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function acknowledgeLast(f, settle = true) {
  const message = f.sent.at(-1)?.[0];
  assert.ok(message);
  f.entries.push({ type: "custom_message", customType: message.customType, content: message.content, details: message.details });
  await f.handlers.get("message_end")({ message: { role: "custom", ...message } }, f.ctx);
  if (settle) {
    await f.handlers.get("agent_settled")({}, f.ctx);
    await settleDelivery();
  }
}

function activeRecord(f, id = "github-pr:acme/widgets#42") {
  const state = f.entries.findLast((entry) => entry.customType === "pi-monitors-records")?.data;
  return state?.active.find((record) => record.id === id);
}

test("accepts only canonical GitHub pull request URLs", () => {
  assert.deepEqual(parsePullRequestUrl(`${PR_URL}/`), { owner: "acme", repo: "widgets", number: 42, url: PR_URL });
  for (const invalid of [
    "http://github.com/acme/widgets/pull/42",
    "https://example.com/acme/widgets/pull/42",
    "https://user@github.com/acme/widgets/pull/42",
    `${PR_URL}?diff=split`,
    `${PR_URL}#discussion_r1`,
    "https://github.com/acme/widgets/issues/42",
    "https://github.com/acme/widgets/pull/0",
    "https://github.com/acme/widgets/pull/42/files",
  ]) assert.throws(() => parsePullRequestUrl(invalid));
});

test("exposes monitor registration guidance to PR workflows", () => {
  const f = fixture();
  assert.match(
    f.tools[0].promptGuidelines[0],
    /updates or reviews an open pull request, call monitor_github_pr with notifyExistingFeedback false/,
  );
});

test("stays dormant until monitor_github_pr is called explicitly", async () => {
  const f = fixture();
  await start(f);
  assert.equal(f.execCalls.length, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.timer.timers.length, 0);
});

test("registers one exact PR and delivers all three feedback surfaces", async () => {
  const f = fixture({ snapshots: new Map([[PR_URL, {
    pull: { state: "open", title: "Keep widgets correct" },
    comments: [issueComment()], reviews: [review()], reviewComments: [reviewComment()],
  }]]) });
  await start(f);
  const result = await f.tools[0].execute("call", { url: PR_URL }, undefined, undefined, f.ctx);
  await settleDelivery();

  assert.match(result.content[0].text, /3 existing feedback item/);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0][0].content, /error path/);
  assert.match(f.sent[0][0].content, /overall concern/);
  assert.match(f.sent[0][0].content, /src\/widget\.ts:18/);
  assert.deepEqual(f.sent[0][1], { deliverAs: "followUp", triggerTurn: true });
  assert.equal(Buffer.byteLength(JSON.stringify(f.sent[0][0]), "utf8") <= 48 * 1024, true);
  assert.equal(f.execCalls.some((call) => call.command === "git"), false);
  assert.equal(f.runtime.snapshot().active[0].attentionCount, 3);

  await acknowledgeLast(f);
  assert.equal(f.runtime.snapshot().active[0].attentionCount, 0);
  assert.equal(activeRecord(f).pendingNotification, undefined);
});

test("baselines existing feedback without notifying and delivers later edits", async () => {
  const snapshot = {
    pull: { state: "open", title: "Keep widgets correct" },
    comments: [issueComment()], reviews: [review()], reviewComments: [reviewComment()],
  };
  const f = fixture({ snapshots: new Map([[PR_URL, snapshot]]) });
  await start(f);

  const result = await f.tools[0].execute(
    "call",
    { url: PR_URL, notifyExistingFeedback: false },
    undefined,
    undefined,
    f.ctx,
  );
  await settleDelivery();

  assert.match(result.content[0].text, /Existing feedback will be baselined without notification/);
  assert.equal(result.details.baselinesExistingFeedback, true);
  assert.equal(f.sent.length, 0);
  assert.equal(f.runtime.snapshot().active[0].attentionCount, 0);

  snapshot.comments = [issueComment({
    body: "Please cover both error paths.",
    updated_at: "2026-08-01T11:05:00Z",
  })];
  await f.runtime.refresh();
  await settleDelivery();

  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0][0].content, /both error paths/);
  assert.doesNotMatch(f.sent[0][0].content, /One overall concern/);
  assert.doesNotMatch(f.sent[0][0].content, /return undefined/);
});

test("a later baseline request promotes a degraded initial registration", async () => {
  const snapshot = {
    pull: { state: "open", title: "Keep widgets correct" },
    comments: [issueComment()], reviews: [], reviewComments: [],
  };
  let failInitialPoll = true;
  const f = fixture({
    snapshots: new Map([[PR_URL, snapshot]]),
    beforeExec(_command, args) {
      if (failInitialPoll && args[0] === "api") {
        failInitialPoll = false;
        throw new Error("temporary GitHub failure");
      }
    },
  });
  await start(f);

  const initial = await f.runtime.register(PR_URL, f.ctx);
  assert.match(initial.warning, /GitHub polling failed/);
  assert.equal(activeRecord(f).state.initialPollPending, true);
  assert.equal(activeRecord(f).state.baselineExistingFeedback, undefined);

  const promoted = await f.runtime.register(PR_URL, f.ctx, undefined, false);
  assert.equal(promoted.baselineExistingFeedback, true);
  assert.equal(activeRecord(f).state.baselineExistingFeedback, true);

  await f.runtime.refresh();
  await settleDelivery();

  assert.equal(f.sent.length, 0);
  assert.equal(activeRecord(f).state.initialPollPending, undefined);
  assert.equal(activeRecord(f).state.baselineExistingFeedback, undefined);
});

test("a concurrent baseline request promotes an in-flight initial registration", async () => {
  const snapshot = {
    pull: { state: "open", title: "Keep widgets correct" },
    comments: [issueComment()], reviews: [], reviewComments: [],
  };
  let releasePoll;
  let reachedPoll;
  let blockInitialPoll = true;
  const pollReached = new Promise((resolve) => { reachedPoll = resolve; });
  const pollGate = new Promise((resolve) => { releasePoll = resolve; });
  const f = fixture({
    snapshots: new Map([[PR_URL, snapshot]]),
    async beforeExec(_command, args) {
      if (blockInitialPoll && args[0] === "api") {
        blockInitialPoll = false;
        reachedPoll();
        await pollGate;
      }
    },
  });
  await start(f);

  const initial = f.runtime.register(PR_URL, f.ctx);
  await pollReached;
  const promoted = f.runtime.register(PR_URL, f.ctx, undefined, false);
  releasePoll();
  const [initialResult, promotedResult] = await Promise.all([initial, promoted]);
  await settleDelivery();

  assert.equal(initialResult.baselineExistingFeedback, true);
  assert.equal(promotedResult.baselineExistingFeedback, true);
  assert.equal(f.sent.length, 0);
  assert.equal(activeRecord(f).state.initialPollPending, undefined);
});

test("restores an unfinished existing-feedback baseline without delivering history", async () => {
  const entries = [];
  const snapshot = {
    pull: { state: "open", title: "Keep widgets correct" },
    comments: [issueComment()], reviews: [], reviewComments: [],
  };
  let failInitialPoll = true;
  const first = fixture({
    entries,
    snapshots: new Map([[PR_URL, snapshot]]),
    beforeExec(_command, args) {
      if (failInitialPoll && args[0] === "api") {
        failInitialPoll = false;
        throw new Error("temporary GitHub failure");
      }
    },
  });
  await start(first);
  const result = await first.tools[0].execute(
    "call",
    { url: PR_URL, notifyExistingFeedback: false },
    undefined,
    undefined,
    first.ctx,
  );

  assert.match(result.content[0].text, /Existing feedback will be baselined without notification/);
  assert.match(result.content[0].text, /Initial polling is degraded/);
  assert.equal(activeRecord(first).state.initialPollPending, true);
  assert.equal(activeRecord(first).state.baselineExistingFeedback, true);
  assert.equal(first.sent.length, 0);
  await first.handlers.get("session_shutdown")({}, first.ctx);

  const second = fixture({ entries, snapshots: new Map([[PR_URL, snapshot]]) });
  await start(second);
  await second.runtime.refresh();
  await settleDelivery();

  assert.equal(second.sent.length, 0);
  assert.equal(activeRecord(second).state.initialPollPending, undefined);
  assert.equal(activeRecord(second).state.baselineExistingFeedback, undefined);

  snapshot.comments.push(issueComment({
    id: 102,
    node_id: "IC_102",
    body: "This reply arrived after restart.",
    created_at: "2026-08-01T11:06:00Z",
    updated_at: "2026-08-01T11:06:00Z",
    html_url: `${PR_URL}#issuecomment-102`,
  }));
  await second.runtime.refresh();
  await settleDelivery();

  assert.equal(second.sent.length, 1);
  assert.match(second.sent[0][0].content, /arrived after restart/);
  assert.doesNotMatch(second.sent[0][0].content, /cover the error path/);
});

test("notifies on bodyless approvals and changes requested while keeping bodyless comments passive", () => {
  for (const state of ["APPROVED", "CHANGES_REQUESTED"]) {
    const collected = collectFeedback(pr(), [], [review({ body: "", state })], [], {});
    assert.equal(collected.events.length, 1, state);
    assert.equal(collected.passive.length, 0, state);
    assert.equal(collected.events[0].state, state);
  }
  const commented = collectFeedback(pr(), [], [review({ body: "", state: "COMMENTED" })], [], {});
  assert.equal(commented.events.length, 0);
  assert.equal(commented.passive.length, 1);
});

test("fetches explicit 100-item REST pages within the feedback bound", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => issueComment({ id: index + 1, node_id: `IC_${index + 1}` }));
  const f = fixture({ snapshots: new Map([[PR_URL, {
    pull: { state: "open", title: "Keep widgets correct" },
    commentPages: [firstPage, [issueComment({ id: 102, node_id: "IC_102" })]],
    reviewPages: [[review()]], reviewCommentPages: [[reviewComment()]], comments: [], reviews: [], reviewComments: [],
  }]]) });
  await start(f);
  await f.tools[0].execute("call", { url: PR_URL }, undefined, undefined, f.ctx);
  await settleDelivery();
  assert.equal(f.sent[0][0].details.count, 103);
  const collectionCalls = f.execCalls.filter((call) => call.args[0] === "api" && call.args.at(-1).includes("per_page=100"));
  assert.equal(collectionCalls.length, 4);
  assert.equal(collectionCalls.some((call) => call.args.at(-1).includes("page=2")), true);
});

test("supports idempotent registration and many PRs with one polling timer", async () => {
  const otherUrl = "https://github.com/elsewhere/gadgets/pull/7";
  const f = fixture({
    pullRequests: new Map([
      [PR_URL, { number: 42, url: PR_URL, title: "Widgets", state: "OPEN" }],
      [otherUrl, { number: 7, url: otherUrl, title: "Gadgets", state: "OPEN" }],
    ]),
    snapshots: new Map([
      [PR_URL, { pull: { state: "open", title: "Widgets" }, comments: [], reviews: [], reviewComments: [] }],
      [otherUrl, { pull: { state: "open", title: "Gadgets" }, comments: [], reviews: [], reviewComments: [] }],
    ]),
  });
  await start(f);
  await f.tools[0].execute("one", { url: PR_URL }, undefined, undefined, f.ctx);
  await f.tools[0].execute("again", { url: PR_URL }, undefined, undefined, f.ctx);
  await f.tools[0].execute("two", { url: otherUrl }, undefined, undefined, f.ctx);
  assert.equal(f.execCalls.filter((call) => call.args[0] === "pr").length, 2);
  assert.equal(f.timer.timers.filter((timer) => timer.delayMs === 60_000 && !timer.cancelled).length, 1);
  assert.equal(f.runtime.snapshot().active.length, 2);
});

test("concurrent registration waits for the initial poll outcome", async () => {
  const snapshot = {
    pull: { state: "closed", title: "Closed during registration" },
    comments: [issueComment()],
    reviews: [],
    reviewComments: [],
  };
  let markPollStarted;
  const pollStarted = new Promise((resolve) => { markPollStarted = resolve; });
  let releasePoll;
  const pollGate = new Promise((resolve) => { releasePoll = resolve; });
  let blockPoll = true;
  const f = fixture({
    snapshots: new Map([[PR_URL, snapshot]]),
    beforeExec: async (_command, args) => {
      if (!blockPoll || args[0] !== "api" || !args.at(-1).endsWith("repos/acme/widgets/pulls/42")) return;
      blockPoll = false;
      markPollStarted();
      await pollGate;
    },
  });
  await start(f);
  const first = f.runtime.register(PR_URL, f.ctx);
  await pollStarted;
  let secondSettled = false;
  const second = f.runtime.register(PR_URL, f.ctx).finally(() => { secondSettled = true; });
  await settleDelivery();
  assert.equal(secondSettled, false);
  releasePoll();

  const results = await Promise.allSettled([first, second]);
  assert.equal(results.every((result) => result.status === "rejected" && /closed/.test(String(result.reason))), true);
  await settleDelivery();
  assert.equal(f.sent.length, 1);
  assert.match(f.runtime.snapshot().active[0].status, /Finishing:.*closed/);
});

test("registration cancellation keeps existing monitors scheduled", async () => {
  const otherUrl = "https://github.com/acme/gadgets/pull/7";
  let blockPoll = false;
  let markPollStarted;
  const pollStarted = new Promise((resolve) => { markPollStarted = resolve; });
  const f = fixture({
    pullRequests: new Map([
      [PR_URL, { number: 42, url: PR_URL, title: "Widgets", state: "OPEN" }],
      [otherUrl, { number: 7, url: otherUrl, title: "Gadgets", state: "OPEN" }],
    ]),
    snapshots: new Map([
      [PR_URL, { pull: { state: "open", title: "Widgets" }, comments: [], reviews: [], reviewComments: [] }],
      [otherUrl, { pull: { state: "open", title: "Gadgets" }, comments: [], reviews: [], reviewComments: [] }],
    ]),
    beforeExec: async (_command, args, options) => {
      if (!blockPoll || args[0] !== "api" || !args.at(-1).endsWith("repos/acme/widgets/pulls/42")) return;
      blockPoll = false;
      markPollStarted();
      await new Promise((resolve) => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener("abort", resolve, { once: true });
      });
      throw new Error("poll aborted");
    },
  });
  await start(f);
  await f.runtime.register(PR_URL, f.ctx);
  blockPoll = true;
  const controller = new AbortController();
  const registration = f.runtime.register(otherUrl, f.ctx, controller.signal);
  await pollStarted;
  controller.abort();
  await assert.rejects(registration, /cancelled/);
  for (let attempt = 0; attempt < 10 && f.runtime.snapshot().active.length !== 1; attempt++) await settleDelivery();
  await settleDelivery();

  assert.deepEqual(f.runtime.snapshot().active.map((monitor) => monitor.id), ["github-pr:acme/widgets#42"]);
  assert.equal(f.timer.timers.filter((timer) => timer.delayMs === 60_000 && !timer.cancelled).length, 1);
});

test("restores monitors and delivered feedback from shared branch state", async () => {
  const snapshots = new Map([[PR_URL, {
    pull: { state: "open", title: "Keep widgets correct" }, comments: [issueComment()], reviews: [], reviewComments: [],
  }]]);
  const first = fixture({ snapshots });
  await start(first);
  await first.tools[0].execute("call", { url: PR_URL }, undefined, undefined, first.ctx);
  await settleDelivery();
  await acknowledgeLast(first);

  const restored = fixture({ entries: structuredClone(first.entries), snapshots });
  await start(restored, "reload");
  await settleDelivery();
  assert.equal(restored.runtime.snapshot().active.length, 1);
  assert.equal(restored.sent.length, 0);
});

test("restored polling does not block session startup", async () => {
  const first = fixture();
  await start(first);
  await first.tools[0].execute("call", { url: PR_URL }, undefined, undefined, first.ctx);

  let markPollStarted;
  const pollStarted = new Promise((resolve) => { markPollStarted = resolve; });
  let releasePoll;
  const pollGate = new Promise((resolve) => { releasePoll = resolve; });
  let blocked = false;
  const restored = fixture({
    entries: structuredClone(first.entries),
    beforeExec: async (_command, args) => {
      if (blocked || args[0] !== "api") return;
      blocked = true;
      markPollStarted();
      await pollGate;
    },
  });

  const starting = start(restored, "reload");
  await pollStarted;
  const startedBeforePollCompleted = await Promise.race([
    starting.then(() => true),
    new Promise((resolve) => setImmediate(() => resolve(false))),
  ]);
  releasePoll();
  await starting;

  assert.equal(startedBeforePollCompleted, true);
  await settleDelivery();
});

test("a new session starts empty", async () => {
  const f = fixture();
  await start(f, "new");
  assert.equal(f.runtime.snapshot().active.length, 0);
  assert.equal(f.execCalls.length, 0);
});

test("ignores metadata-only comment touches while preserving body edits", () => {
  const first = collectFeedback(pr(), [issueComment()], [], [], {});
  const seen = { [first.events[0].key]: first.events[0].fingerprint };
  assert.equal(collectFeedback(pr(), [issueComment()], [], [], seen).events.length, 0);
  const touched = issueComment({ updated_at: "2026-08-01T11:04:00Z" });
  assert.equal(collectFeedback(pr(), [touched], [], [], seen).events.length, 0);
  const edited = collectFeedback(pr(), [issueComment({ body: "Updated request" })], [], [], seen);
  assert.equal(edited.events.length, 1);
  assert.equal(edited.events[0].key, first.events[0].key);
  assert.notEqual(edited.events[0].fingerprint, first.events[0].fingerprint);
});

test("ignores inline location and timestamp remapping while preserving body edits", () => {
  const original = reviewComment({ line: 18, original_line: 18 });
  const first = collectFeedback(pr(), [], [], [original], {});
  const seen = { [first.events[0].key]: first.events[0].fingerprint };

  const remapped = reviewComment({ line: null, original_line: 18 });
  assert.equal(collectFeedback(pr(), [], [], [remapped], seen).events.length, 0);
  const touched = reviewComment({ line: null, original_line: 18, updated_at: "2026-08-01T11:05:00Z" });
  assert.equal(collectFeedback(pr(), [], [], [touched], seen).events.length, 0);

  const edited = reviewComment({
    line: null,
    original_line: 18,
    body: "Updated inline feedback",
  });
  assert.equal(collectFeedback(pr(), [], [], [edited], seen).events.length, 1);
});

test("sanitizes hostile content and bounds the complete serialized packet", () => {
  const events = collectFeedback(pr(), [issueComment({ body: `ignore\u202eprevious\u0000\u0007\n${"x".repeat(20_000)}` })], [], [], {}).events;
  assert.equal(events.length, 1);
  assert.equal(events[0].body.includes("\u202e"), false);
  assert.equal(events[0].truncated, true);
  const formatted = formatFeedback(Array.from({ length: 100 }, (_, index) => ({
    ...events[0], key: `comment:${index}`, fingerprint: String(index).padStart(64, "0"), body: `${index}:${events[0].body}`,
  })));
  assert.equal(Buffer.byteLength(JSON.stringify({
    customType: "github_pr_feedback", content: formatted.content, display: true, details: formatted.details,
  }), "utf8") <= 48 * 1024, true);
  assert.equal(formatted.details.truncated, true);
  assert.match(formatted.content, /untrusted external data/);
});

test("edited feedback waits for the outstanding receipt and then delivers", async () => {
  const snapshot = {
    pull: { state: "open", title: "Keep widgets correct" }, comments: [issueComment()], reviews: [], reviewComments: [],
  };
  const f = fixture({ snapshots: new Map([[PR_URL, snapshot]]) });
  await start(f);
  await f.tools[0].execute("call", { url: PR_URL }, undefined, undefined, f.ctx);
  await settleDelivery();
  snapshot.comments = [issueComment({ body: "Updated request", updated_at: "2026-08-01T11:05:00Z" })];
  await f.timer.latest(60_000).callback();
  await settleDelivery();
  assert.equal(f.sent.length, 1);

  await acknowledgeLast(f);
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1][0].content, /Updated request/);
});

test("restart preserves the exact outstanding packet before delivering an edit", async () => {
  const snapshot = {
    pull: { state: "open", title: "Keep widgets correct" }, comments: [issueComment()], reviews: [], reviewComments: [],
  };
  const first = fixture({ snapshots: new Map([[PR_URL, snapshot]]) });
  await start(first);
  await first.tools[0].execute("call", { url: PR_URL }, undefined, undefined, first.ctx);
  await settleDelivery();
  const oldFingerprint = activeRecord(first).pendingNotification.fingerprint;

  snapshot.comments = [issueComment({ body: "Edited after crash", updated_at: "2026-08-01T11:10:00Z" })];
  const restored = fixture({ entries: structuredClone(first.entries), snapshots: new Map([[PR_URL, snapshot]]) });
  await start(restored, "reload");
  await settleDelivery();

  assert.equal(restored.sent.length, 1);
  assert.match(restored.sent[0][0].content, /Please cover the error path/);
  assert.equal(activeRecord(restored).pendingNotification.fingerprint, oldFingerprint);
  await acknowledgeLast(restored);
  assert.equal(restored.sent.length, 2);
  assert.match(restored.sent[1][0].content, /Edited after crash/);
});

test("restart preserves outstanding feedback deleted from GitHub before acknowledgement", async () => {
  const snapshot = {
    pull: { state: "open", title: "Keep widgets correct" }, comments: [issueComment()], reviews: [], reviewComments: [],
  };
  const first = fixture({ snapshots: new Map([[PR_URL, snapshot]]) });
  await start(first);
  await first.tools[0].execute("call", { url: PR_URL }, undefined, undefined, first.ctx);
  await settleDelivery();

  snapshot.comments = [];
  const restored = fixture({ entries: structuredClone(first.entries), snapshots: new Map([[PR_URL, snapshot]]) });
  await start(restored, "reload");
  await settleDelivery();

  assert.equal(restored.sent.length, 1);
  assert.match(restored.sent[0][0].content, /Please cover the error path/);
  await acknowledgeLast(restored);
  assert.equal(activeRecord(restored).pendingNotification, undefined);
});

test("shared delivery batches feedback from multiple PRs found by one poll", async () => {
  const otherUrl = "https://github.com/acme/gadgets/pull/7";
  const widgetSnapshot = { pull: { state: "open", title: "Widgets" }, comments: [], reviews: [], reviewComments: [] };
  const gadgetSnapshot = { pull: { state: "open", title: "Gadgets" }, comments: [], reviews: [], reviewComments: [] };
  const f = fixture({
    pullRequests: new Map([
      [PR_URL, { number: 42, url: PR_URL, title: "Widgets", state: "OPEN" }],
      [otherUrl, { number: 7, url: otherUrl, title: "Gadgets", state: "OPEN" }],
    ]),
    snapshots: new Map([[PR_URL, widgetSnapshot], [otherUrl, gadgetSnapshot]]),
  });
  await start(f);
  await f.runtime.register(PR_URL, f.ctx);
  await f.runtime.register(otherUrl, f.ctx);
  widgetSnapshot.comments = [issueComment()];
  gadgetSnapshot.comments = [issueComment({ id: 701, node_id: "IC_701" })];

  await f.timer.latest(60_000).callback();
  await settleDelivery();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0][0].customType, "pi-monitors-notification-batch");
  assert.match(f.sent[0][0].content, /widgets#42/);
  assert.match(f.sent[0][0].content, /gadgets#7/);
});

test("shared delivery batches terminal outcomes from one poll", async () => {
  const otherUrl = "https://github.com/acme/gadgets/pull/7";
  const widgetSnapshot = { pull: { state: "open", title: "Widgets", merged_at: null }, comments: [], reviews: [], reviewComments: [] };
  const gadgetSnapshot = { pull: { state: "open", title: "Gadgets", merged_at: null }, comments: [], reviews: [], reviewComments: [] };
  const f = fixture({
    pullRequests: new Map([
      [PR_URL, { number: 42, url: PR_URL, title: "Widgets", state: "OPEN" }],
      [otherUrl, { number: 7, url: otherUrl, title: "Gadgets", state: "OPEN" }],
    ]),
    snapshots: new Map([[PR_URL, widgetSnapshot], [otherUrl, gadgetSnapshot]]),
  });
  await start(f);
  await f.runtime.register(PR_URL, f.ctx);
  await f.runtime.register(otherUrl, f.ctx);
  widgetSnapshot.pull.state = "closed";
  gadgetSnapshot.pull.state = "closed";
  gadgetSnapshot.pull.merged_at = "2026-08-01T12:00:00Z";

  await f.timer.latest(60_000).callback();
  await settleDelivery();

  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0][0].customType, "pi-monitors-notification-batch");
  assert.deepEqual(f.sent[0][0].details.items.map((item) => item.customType), ["github_pr_outcome", "github_pr_outcome"]);
  assert.match(f.sent[0][0].content, /"outcome":"closed"/);
  assert.match(f.sent[0][0].content, /"outcome":"merged"/);
  assert.equal(f.notifications.slice(-2).every((notification) => notification.level === "info"), true);

  await acknowledgeLast(f);
  assert.equal(f.runtime.snapshot().active.length, 0);
  assert.deepEqual(f.runtime.snapshot().recent.map((item) => item.status).sort(), [
    "GitHub reports that it is closed",
    "GitHub reports that it was merged",
  ]);
});

test("one outcome acknowledgement keeps another terminal retry scheduled", async () => {
  const otherUrl = "https://github.com/acme/gadgets/pull/7";
  const widgetSnapshot = { pull: { state: "open", title: "Widgets" }, comments: [], reviews: [], reviewComments: [] };
  const gadgetSnapshot = { pull: { state: "open", title: "Gadgets" }, comments: [], reviews: [], reviewComments: [] };
  let failGadgetFinalDrain = false;
  const f = fixture({
    pullRequests: new Map([
      [PR_URL, { number: 42, url: PR_URL, title: "Widgets", state: "OPEN" }],
      [otherUrl, { number: 7, url: otherUrl, title: "Gadgets", state: "OPEN" }],
    ]),
    snapshots: new Map([[PR_URL, widgetSnapshot], [otherUrl, gadgetSnapshot]]),
    beforeExec(_command, args) {
      if (failGadgetFinalDrain && args[0] === "api" && args.at(-1) === "repos/acme/gadgets/pulls/7") {
        failGadgetFinalDrain = false;
        throw new Error("temporary GitHub failure");
      }
    },
  });
  await start(f);
  await f.runtime.register(PR_URL, f.ctx);
  await f.runtime.register(otherUrl, f.ctx);

  widgetSnapshot.pull.state = "closed";
  gadgetSnapshot.pull.state = "closed";
  gadgetSnapshot.comments = [issueComment({ id: 701, node_id: "IC_701", html_url: `${otherUrl}#issuecomment-701` })];
  await f.timer.latest(60_000).callback();
  await settleDelivery();

  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0][0].customType, "github_pr_feedback");

  failGadgetFinalDrain = true;
  await acknowledgeLast(f);
  const retry = f.timer.latest(120_000);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1][0].customType, "github_pr_outcome");

  await acknowledgeLast(f);
  assert.deepEqual(f.runtime.snapshot().active.map((monitor) => monitor.id), ["github-pr:acme/gadgets#7"]);
  assert.match(f.runtime.snapshot().active[0].status, /Finishing:.*closed/);
  assert.equal(retry.cancelled, false);
  await retry.callback();
  await settleDelivery();

  assert.equal(f.sent.length, 3);
  assert.equal(f.sent[2][0].customType, "github_pr_outcome");
  assert.equal(f.sent[2][0].details.prKey, "acme/gadgets#7");
});

test("the full PR monitor set shares one automatic turn", async () => {
  const pullRequests = new Map();
  const snapshots = new Map();
  const urls = [];
  for (let index = 1; index <= 10; index++) {
    const url = `https://github.com/acme/repo-${index}/pull/${index}`;
    urls.push(url);
    pullRequests.set(url, { number: index, url, title: `PR ${index}`, state: "OPEN" });
    snapshots.set(url, { pull: { state: "open", title: `PR ${index}` }, comments: [], reviews: [], reviewComments: [] });
  }
  const overflowUrl = "https://github.com/acme/overflow/pull/99";
  pullRequests.set(overflowUrl, { number: 99, url: overflowUrl, title: "Overflow", state: "OPEN" });
  snapshots.set(overflowUrl, { pull: { state: "open", title: "Overflow" }, comments: [], reviews: [], reviewComments: [] });
  const f = fixture({ pullRequests, snapshots });
  await start(f);
  for (const url of urls) await f.runtime.register(url, f.ctx);
  await assert.rejects(f.runtime.register(overflowUrl, f.ctx), /at most 10/);
  for (const [index, url] of urls.entries()) {
    snapshots.get(url).comments = [issueComment({ id: index + 1, node_id: `IC_${index + 1}`, body: `feedback ${index + 1}` })];
  }

  await f.timer.latest(60_000).callback();
  await settleDelivery();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0][0].customType, "pi-monitors-notification-batch");
  assert.equal(f.sent[0][0].details.items.length, 10);
  assert.equal(f.runtime.snapshot().active.reduce((sum, monitor) => sum + monitor.attentionCount, 0), 10);

  await acknowledgeLast(f);
  for (const [monitorIndex, url] of urls.entries()) {
    snapshots.get(url).comments = Array.from({ length: 100 }, (_value, commentIndex) => issueComment({
      id: commentIndex + 1,
      node_id: `IC_${monitorIndex}_${commentIndex}`,
      body: `feedback ${monitorIndex + 1}.${commentIndex + 1}`,
    }));
  }
  const callsBeforeBoundaryPoll = f.execCalls.length;
  await f.timer.latest(60_000).callback();
  await settleDelivery();
  assert.equal(f.execCalls.slice(callsBeforeBoundaryPoll).filter((call) => call.args[0] === "api").length, 50);
});

test("concurrent registration cannot exceed the session monitor limit", async () => {
  const pullRequests = new Map();
  const snapshots = new Map();
  const urls = Array.from({ length: 11 }, (_value, index) => {
    const number = index + 1;
    const url = `https://github.com/acme/concurrent-${number}/pull/${number}`;
    pullRequests.set(url, { number, url, title: `PR ${number}`, state: "OPEN" });
    snapshots.set(url, { pull: { state: "open", title: `PR ${number}` }, comments: [], reviews: [], reviewComments: [] });
    return url;
  });
  const f = fixture({ pullRequests, snapshots });
  await start(f);
  const results = await Promise.allSettled(urls.map((url) => f.runtime.register(url, f.ctx)));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 10);
  assert.equal(results.filter((result) => result.status === "rejected" && /at most 10/.test(String(result.reason))).length, 1);
  assert.equal(f.runtime.snapshot().active.length, 10);
});

test("high-volume monitors use shared backoff to protect the GitHub request budget", async () => {
  const comments = Array.from({ length: 301 }, (_, index) => issueComment({ id: index + 1, node_id: `IC_${index + 1}` }));
  const f = fixture({ snapshots: new Map([[PR_URL, {
    pull: { state: "open", title: "Keep widgets correct" }, comments, reviews: [], reviewComments: [],
  }]]) });
  await start(f);
  const result = await f.tools[0].execute("call", { url: PR_URL }, undefined, undefined, f.ctx);
  assert.match(result.content[0].text, /degraded/);
  assert.ok(f.timer.latest(120_000));
});

test("rejects closed PRs without creating shared state", async () => {
  const f = fixture({ pullRequests: new Map([[PR_URL, { number: 42, url: PR_URL, title: "Done", state: "MERGED" }]]) });
  await start(f);
  await assert.rejects(f.tools[0].execute("call", { url: PR_URL }, undefined, undefined, f.ctx), /only monitor an open PR/);
  assert.equal(activeRecord(f), undefined);
  assert.equal(f.timer.timers.length, 0);
});

test("rejects registration when the pull request closes during its first poll", async () => {
  const snapshot = {
    pull: { state: "closed", title: "Closed during registration" },
    comments: [issueComment()],
    reviews: [],
    reviewComments: [],
  };
  const f = fixture({ snapshots: new Map([[PR_URL, snapshot]]) });
  await start(f);

  await assert.rejects(f.tools[0].execute("call", { url: PR_URL }, undefined, undefined, f.ctx), /closed/);
  await settleDelivery();
  assert.equal(f.sent.length, 1);
  assert.match(f.runtime.snapshot().active[0].status, /Finishing:.*closed/);
  await acknowledgeLast(f);
  await settleDelivery();
  assert.equal(f.runtime.snapshot().active.length, 1);
  assert.equal(f.sent[1][0].customType, "github_pr_outcome");
  assert.equal(f.sent[1][0].details.outcome, "closed");
  await acknowledgeLast(f);
  assert.equal(f.runtime.snapshot().active.length, 0);
  assert.match(f.runtime.snapshot().recent[0].status, /closed/);
});

test("retains 2,000 delivered fingerprints inside shared state bounds", async () => {
  const commentPages = Array.from({ length: 20 }, (_, page) => Array.from({ length: 100 }, (_value, index) => {
    const id = page * 100 + index + 1;
    return issueComment({ id, node_id: `IC_${id}`, body: `comment ${id}` });
  }));
  const snapshots = new Map([[PR_URL, {
    pull: { state: "open", title: "Keep widgets correct" }, commentPages, comments: [], reviews: [], reviewComments: [],
  }]]);
  const f = fixture({ snapshots });
  await start(f);
  await f.tools[0].execute("call", { url: PR_URL }, undefined, undefined, f.ctx);
  await settleDelivery();
  let deliveries = 0;
  while (f.runtime.snapshot().active[0].attentionCount > 0) {
    deliveries++;
    assert.equal(deliveries <= 16, true);
    await acknowledgeLast(f);
  }
  assert.equal(Buffer.byteLength(JSON.stringify(activeRecord(f).state), "utf8") < 64 * 1024, true);

  const restored = fixture({ entries: structuredClone(f.entries), snapshots });
  await start(restored, "reload");
  await settleDelivery();
  assert.equal(restored.sent.length, 0);
  assert.equal(restored.runtime.snapshot().active[0].attentionCount, 0);
});

test("stops without a model turn when feedback exceeds the safety limit", async () => {
  const comments = Array.from({ length: 2_001 }, (_, index) => issueComment({ id: index + 1, node_id: `IC_${index + 1}` }));
  const f = fixture({ snapshots: new Map([[PR_URL, {
    pull: { state: "open", title: "Keep widgets correct" }, commentPages: [comments], comments: [], reviews: [], reviewComments: [],
  }]]) });
  await start(f);
  await assert.rejects(f.tools[0].execute("call", { url: PR_URL }, undefined, undefined, f.ctx), /safety limit/);
  await settleDelivery();
  assert.equal(f.sent.length, 0);
  assert.equal(activeRecord(f), undefined);
  assert.match(f.notifications.at(-1).message, /safety limit/);
  assert.equal(f.runtime.snapshot().recent[0].health, "degraded");
  assert.match(f.runtime.snapshot().recent[0].status, /safety limit/);
});

test("stops instead of repeatedly polling an oversized GitHub response", async () => {
  const f = fixture();
  await start(f);
  const originalExec = f.pi.exec;
  f.pi.exec = async (command, args, options) => {
    if (args[0] === "api" && args.at(-1).includes("/issues/42/comments")) {
      return { code: 0, stdout: JSON.stringify([{ id: 1, body: "x".repeat(5 * 1024 * 1024) }]), stderr: "" };
    }
    return originalExec(command, args, options);
  };
  await assert.rejects(f.tools[0].execute("call", { url: PR_URL }, undefined, undefined, f.ctx), /response limit/);
  assert.equal(activeRecord(f), undefined);
});

test("collects final feedback and observes a merge before terminal delivery", async () => {
  const snapshot = { pull: { state: "open", title: "Keep widgets correct", merged_at: null }, comments: [], reviews: [], reviewComments: [] };
  const f = fixture({ snapshots: new Map([[PR_URL, snapshot]]) });
  await start(f);
  await f.tools[0].execute("call", { url: PR_URL }, undefined, undefined, f.ctx);

  snapshot.comments = [issueComment()];
  snapshot.pull.state = "closed";
  await f.timer.latest(60_000).callback();
  await settleDelivery();

  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0][0].content, /Please cover the error path/);
  assert.match(f.runtime.snapshot().active[0].status, /Finishing:.*closed/);
  snapshot.pull.merged_at = "2026-08-01T12:00:00Z";
  await acknowledgeLast(f);
  assert.equal(f.runtime.snapshot().active.length, 1);
  assert.equal(f.sent[1][0].customType, "github_pr_outcome");
  assert.equal(f.sent[1][0].details.outcome, "merged");
  await acknowledgeLast(f);
  assert.equal(f.runtime.snapshot().active.length, 0);
  assert.match(f.runtime.snapshot().recent[0].status, /merged/);
});

test("resumes monitoring when a pull request reopens before terminal delivery", async () => {
  const snapshot = { pull: { state: "open", title: "Keep widgets correct" }, comments: [], reviews: [], reviewComments: [] };
  const f = fixture({ snapshots: new Map([[PR_URL, snapshot]]) });
  await start(f);
  await f.tools[0].execute("call", { url: PR_URL }, undefined, undefined, f.ctx);

  snapshot.comments = [issueComment()];
  snapshot.pull.state = "closed";
  await f.timer.latest(60_000).callback();
  await settleDelivery();
  assert.match(f.runtime.snapshot().active[0].status, /Finishing:.*closed/);

  snapshot.pull.state = "open";
  await acknowledgeLast(f);
  assert.equal(f.sent.length, 1);
  assert.equal(f.runtime.snapshot().active.length, 1);
  assert.equal(f.runtime.snapshot().active[0].status, "Monitoring for feedback");
  assert.equal(activeRecord(f).state.stoppedReason, undefined);

  snapshot.pull.state = "closed";
  await f.timer.latest(60_000).callback();
  await settleDelivery();
  assert.equal(f.sent[1][0].customType, "github_pr_outcome");
  assert.equal(f.sent[1][0].details.outcome, "closed");
});

test("preserves queued feedback through closure and restart before stopping", async () => {
  const snapshot = { pull: { state: "open", title: "Keep widgets correct" }, comments: [], reviews: [], reviewComments: [] };
  const first = fixture({ snapshots: new Map([[PR_URL, snapshot]]) });
  await start(first);
  await first.tools[0].execute("call", { url: PR_URL }, undefined, undefined, first.ctx);
  await first.handlers.get("agent_start")({}, first.ctx);

  snapshot.comments = [issueComment()];
  await first.timer.latest(60_000).callback();
  await settleDelivery();
  assert.equal(first.sent.length, 0);
  snapshot.pull.state = "closed";
  await first.timer.latest(60_000).callback();
  await settleDelivery();

  assert.equal(first.runtime.snapshot().active.length, 1);
  assert.match(first.runtime.snapshot().active[0].status, /Finishing:.*delivery pending/);
  assert.match(activeRecord(first).state.stoppedReason, /closed/);

  const restored = fixture({ entries: structuredClone(first.entries), snapshots: new Map([[PR_URL, snapshot]]) });
  await start(restored, "reload");
  await settleDelivery();
  assert.equal(restored.execCalls.length, 0);
  assert.equal(restored.sent.length, 1);
  assert.match(restored.sent[0][0].content, /Please cover the error path/);

  await acknowledgeLast(restored);
  await settleDelivery();
  assert.equal(restored.runtime.snapshot().active.length, 1);
  assert.equal(restored.sent[1][0].customType, "github_pr_outcome");
  await acknowledgeLast(restored);
  assert.equal(restored.runtime.snapshot().active.length, 0);
  assert.equal(activeRecord(restored), undefined);
});

test("restores every remaining feedback packet before finalizing a closed monitor", async () => {
  const comments = Array.from({ length: 12 }, (_, index) => issueComment({
    id: index + 1,
    node_id: `IC_${index + 1}`,
    body: `Feedback ${index + 1}: ${"x".repeat(7_000)}`,
  }));
  const snapshot = { pull: { state: "open", title: "Keep widgets correct" }, comments: [], reviews: [], reviewComments: [] };
  const first = fixture({ snapshots: new Map([[PR_URL, snapshot]]) });
  await start(first);
  await first.tools[0].execute("call", { url: PR_URL }, undefined, undefined, first.ctx);
  snapshot.comments = comments;
  snapshot.pull.state = "closed";
  await first.timer.latest(60_000).callback();
  await settleDelivery();

  assert.equal(first.sent.length, 1);
  assert.equal(first.sent[0][0].details.truncated, true);
  assert.equal(first.sent[0][0].details.items.length < comments.length, true);

  const restored = fixture({ entries: structuredClone(first.entries), snapshots: new Map([[PR_URL, snapshot]]) });
  await start(restored, "reload");
  await settleDelivery();
  const deliveredKeys = new Set();
  let packetIndex = 0;
  while (restored.sent.at(-1)[0].customType === "github_pr_feedback") {
    assert.equal(packetIndex < comments.length, true);
    assert.equal(restored.sent.length, packetIndex + 1);
    for (const item of restored.sent[packetIndex][0].details.items) deliveredKeys.add(item.key);
    await acknowledgeLast(restored);
    packetIndex++;
    await settleDelivery();
  }

  assert.equal(packetIndex > 1, true);
  assert.equal(deliveredKeys.size, comments.length);
  assert.equal(restored.sent.length, packetIndex + 1);
  assert.equal(restored.sent[packetIndex][0].customType, "github_pr_outcome");
  await acknowledgeLast(restored);
  assert.equal(activeRecord(restored), undefined);
  assert.match(restored.runtime.snapshot().recent[0].status, /closed/);
});

test("reconciles delivered feedback items before draining a restored closed monitor", async () => {
  for (const batched of [false, true]) {
    const original = issueComment();
    const added = issueComment({
      id: 102,
      node_id: "IC_102",
      body: "New feedback after the durable packet.",
      updated_at: "2026-08-01T11:05:00Z",
      html_url: `${PR_URL}#issuecomment-102`,
    });
    const snapshot = { pull: { state: "open", title: "Keep widgets correct" }, comments: [], reviews: [], reviewComments: [] };
    const first = fixture({ snapshots: new Map([[PR_URL, snapshot]]) });
    await start(first);
    await first.runtime.register(PR_URL, first.ctx);
    snapshot.comments = [original];
    snapshot.pull.state = "closed";
    await first.timer.latest(60_000).callback();
    await settleDelivery();
    const delivered = first.sent[0][0];
    const directEntry = {
      type: "custom_message",
      customType: delivered.customType,
      content: delivered.content,
      details: delivered.details,
    };
    const deliveredEntry = batched ? {
      type: "custom_message",
      customType: MONITOR_BATCH_MESSAGE_TYPE,
      content: "Delivered monitor batch",
      details: {
        version: 1,
        items: [{
          adapterId: "github-pr",
          eventId: "github-pr:acme/widgets#42",
          fingerprint: delivered.details.deliveryId,
          customType: delivered.customType,
          content: delivered.content,
          display: true,
          details: delivered.details,
        }],
      },
    } : directEntry;
    const deliveredBranch = [...first.entries, deliveredEntry];

    snapshot.comments = [original, added];
    const restored = fixture({ entries: deliveredBranch, snapshots: new Map([[PR_URL, snapshot]]) });
    await start(restored, "reload");
    await settleDelivery();

    assert.equal(restored.sent.length, 1, batched ? "batch" : "direct");
    assert.doesNotMatch(restored.sent[0][0].content, /Please cover the error path/);
    assert.match(restored.sent[0][0].content, /New feedback after the durable packet/);
    assert.deepEqual(restored.sent[0][0].details.items.map((item) => item.key), ["comment:102"]);
    await acknowledgeLast(restored);
    await settleDelivery();
    assert.equal(restored.runtime.snapshot().active.length, 1);
    assert.equal(restored.sent[1][0].customType, "github_pr_outcome");
    await acknowledgeLast(restored);
    assert.equal(restored.runtime.snapshot().active.length, 0);
  }
});

test("an in-flight poll cannot recreate a monitor stopped by the user", async () => {
  const otherUrl = "https://github.com/acme/gadgets/pull/7";
  const widgetSnapshot = { pull: { state: "open", title: "Widgets" }, comments: [], reviews: [], reviewComments: [] };
  const gadgetSnapshot = { pull: { state: "open", title: "Gadgets" }, comments: [], reviews: [], reviewComments: [] };
  let blockPoll = false;
  let markPollStarted;
  const pollStarted = new Promise((resolve) => { markPollStarted = resolve; });
  let releasePoll;
  const pollGate = new Promise((resolve) => { releasePoll = resolve; });
  const f = fixture({
    pullRequests: new Map([
      [PR_URL, { number: 42, url: PR_URL, title: "Widgets", state: "OPEN" }],
      [otherUrl, { number: 7, url: otherUrl, title: "Gadgets", state: "OPEN" }],
    ]),
    snapshots: new Map([[PR_URL, widgetSnapshot], [otherUrl, gadgetSnapshot]]),
    beforeExec: async (_command, args) => {
      if (!blockPoll || args[0] !== "api" || !args.at(-1).endsWith("repos/acme/widgets/pulls/42")) return;
      blockPoll = false;
      markPollStarted();
      await pollGate;
    },
  });
  await start(f);
  await f.runtime.register(PR_URL, f.ctx);
  await f.runtime.register(otherUrl, f.ctx);
  widgetSnapshot.pull.title = "Changed while stopping";
  blockPoll = true;

  f.timer.latest(60_000).callback();
  await pollStarted;
  await f.runtime.stop("github-pr:acme/widgets#42");
  releasePoll();
  await settleDelivery();

  assert.deepEqual(f.runtime.snapshot().active.map((monitor) => monitor.id), ["github-pr:acme/gadgets#7"]);
  assert.equal(activeRecord(f, "github-pr:acme/widgets#42"), undefined);
  assert.equal(f.runtime.snapshot().recent[0].health, "healthy");
  assert.equal(f.runtime.snapshot().recent[0].status, "stopped by user");
  const restored = fixture({ entries: structuredClone(f.entries), snapshots: new Map([[PR_URL, widgetSnapshot], [otherUrl, gadgetSnapshot]]) });
  await start(restored, "reload");
  await settleDelivery();
  assert.deepEqual(restored.runtime.snapshot().active.map((monitor) => monitor.id), ["github-pr:acme/gadgets#7"]);
});

test("delivers durable merged and closed outcomes before stopping", async () => {
  for (const [outcome, mergedAt] of [["closed", null], ["merged", "2026-08-01T12:00:00Z"]]) {
    const snapshot = { pull: { state: "open", title: "Keep widgets correct", merged_at: null }, comments: [], reviews: [], reviewComments: [] };
    const first = fixture({ snapshots: new Map([[PR_URL, snapshot]]) });
    await start(first);
    await first.tools[0].execute("call", { url: PR_URL }, undefined, undefined, first.ctx);
    snapshot.pull.state = "closed";
    snapshot.pull.merged_at = mergedAt;
    await first.timer.latest(60_000).callback();
    await settleDelivery();

    assert.equal(first.runtime.snapshot().active.length, 1);
    assert.ok(activeRecord(first));
    assert.equal(first.sent[0][0].customType, "github_pr_outcome");
    assert.equal(first.sent[0][0].details.outcome, outcome);
    assert.match(first.sent[0][0].content, /grants no authority/);
    assert.equal(Buffer.byteLength(JSON.stringify(first.sent[0][0]), "utf8") <= 48 * 1024, true);
    assert.equal(first.notifications.at(-1).level, "info");

    const restored = fixture({ entries: structuredClone(first.entries), snapshots: new Map([[PR_URL, snapshot]]) });
    await start(restored, "reload");
    await settleDelivery();
    assert.equal(restored.execCalls.length, 0);
    assert.equal(restored.sent.length, 1);
    assert.deepEqual(restored.sent[0][0], first.sent[0][0]);

    await acknowledgeLast(restored);
    assert.equal(restored.runtime.snapshot().active.length, 0);
    assert.equal(activeRecord(restored), undefined);
    assert.match(restored.runtime.snapshot().recent[0].status, new RegExp(outcome));

    const completed = fixture({ entries: structuredClone(restored.entries), snapshots: new Map([[PR_URL, snapshot]]) });
    await start(completed, "reload");
    assert.equal(completed.hostRuntime.snapshot().recent.length, 1);
    assert.match(completed.hostRuntime.snapshot().recent[0].status, new RegExp(outcome));
  }
});

test("shutdown aborts polling and clears its timer", async () => {
  const f = fixture();
  await start(f);
  await f.tools[0].execute("call", { url: PR_URL }, undefined, undefined, f.ctx);
  const pollTimer = f.timer.latest(60_000);
  await f.handlers.get("session_shutdown")({}, f.ctx);
  assert.equal(pollTimer.cancelled, true);
});
