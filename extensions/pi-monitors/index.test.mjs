import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FILES_CHANGED_EVENT } from "./filesystem.ts";
import { createPiMonitorsExtension } from "./index.ts";
import { MONITOR_ADAPTER_DISCOVERY_EVENT } from "./types.ts";

function fixture(adapters) {
  const handlers = new Map();
  const commands = new Map();
  const entries = [];
  const sent = [];
  const eventListeners = new Map();
  const pi = {
    on(name, handler) {
      const previous = handlers.get(name);
      handlers.set(name, previous
        ? async (...args) => { await previous(...args); return handler(...args); }
        : handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data, timestamp: new Date().toISOString() });
    },
    sendMessage(...args) { sent.push(args); },
    events: {
      on(channel, listener) {
        const listeners = eventListeners.get(channel) ?? new Set();
        listeners.add(listener);
        eventListeners.set(channel, listeners);
        return () => listeners.delete(listener);
      },
      emit(channel, data) {
        for (const listener of eventListeners.get(channel) ?? []) {
          try { listener(data); } catch {}
        }
      },
    },
  };
  const runtime = createPiMonitorsExtension(pi, adapters);
  return { commands, entries, handlers, pi, runtime, sent };
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function adapter(id, calls, options = {}) {
  return {
    id,
    bind() {
      calls.push(`${id}:bind`);
      let listener;
      return {
        async startSession(ctx) {
          calls.push(`${id}:start:${ctx.cwd}`);
          if (options.failStart) throw new Error(`${id} start failed`);
        },
        async rebindBranch(ctx) {
          calls.push(`${id}:tree:${ctx.cwd}`);
        },
        async messageEnded(message) {
          calls.push(`${id}:message:${message.id}`);
        },
        async dispose() {
          calls.push(`${id}:dispose`);
          if (options.failDispose) throw new Error(`${id} dispose failed`);
        },
        snapshot() {
          return options.snapshot ?? { active: [], recent: [] };
        },
        subscribe(nextListener) {
          listener = nextListener;
          return () => { listener = undefined; };
        },
        async refresh(monitorId) {
          calls.push(`${id}:refresh:${monitorId ?? "all"}`);
          listener?.();
          return options.monitorId === undefined || monitorId === undefined || monitorId === options.monitorId;
        },
        async stop(monitorId) {
          calls.push(`${id}:stop:${monitorId}`);
          listener?.();
          return monitorId === options.monitorId;
        },
      };
    },
  };
}

test("binds adapters once and forwards Pi lifecycle events in registration order", async () => {
  const calls = [];
  const subject = fixture([adapter("alpha", calls), adapter("beta", calls)]);
  const statuses = [];
  const ctx = {
    cwd: "/work",
    sessionManager: { getBranch: () => [] },
    ui: {
      theme: { fg: (_color, text) => text },
      setStatus(id, value) { statuses.push({ id, value }); },
    },
  };

  await subject.handlers.get("session_start")({}, ctx);
  await subject.handlers.get("session_tree")({}, ctx);
  await subject.handlers.get("message_end")({ message: { id: "message-1" } }, ctx);
  await subject.handlers.get("session_shutdown")({}, ctx);

  assert.deepEqual(calls, [
    "alpha:bind",
    "beta:bind",
    "alpha:start:/work",
    "beta:start:/work",
    "alpha:tree:/work",
    "beta:tree:/work",
    "alpha:message:message-1",
    "beta:message:message-1",
    "alpha:dispose",
    "beta:dispose",
  ]);
  assert.deepEqual(statuses.at(-1), { id: "pi-monitors", value: undefined });
  assert.match(subject.commands.get("monitors").description, /Inspect and manage monitors/);
  assert.equal(subject.commands.has("events"), false);
  assert.deepEqual([...subject.handlers.keys()], [
    "session_start",
    "session_tree",
    "message_end",
    "agent_start",
    "agent_settled",
    "session_shutdown",
  ]);
});

test("discovers external adapters before starting their session", async () => {
  const calls = [];
  const subject = fixture([adapter("builtin", calls)]);
  let discoveryCount = 0;
  subject.pi.events.on(MONITOR_ADAPTER_DISCOVERY_EVENT, (discovery) => {
    discoveryCount++;
    assert.equal(discovery.version, 1);
    discovery.register(adapter("external", calls));
  });
  const ctx = {
    cwd: "/work",
    sessionManager: { getBranch: () => [] },
    ui: { theme: { fg: (_color, text) => text }, setStatus() {} },
  };

  await subject.handlers.get("session_start")({}, ctx);

  assert.equal(discoveryCount, 1);
  assert.deepEqual(calls, [
    "builtin:bind",
    "external:bind",
    "builtin:start:/work",
    "external:start:/work",
  ]);
});

test("validates discovered adapters and closes registration after startup", async () => {
  const calls = [];
  const subject = fixture([adapter("builtin", calls)]);
  let discovery;
  let invalidError;
  let duplicateError;
  subject.pi.events.on(MONITOR_ADAPTER_DISCOVERY_EVENT, (value) => {
    discovery = value;
    try { discovery.register({ id: "invalid" }); } catch (error) { invalidError = error; }
    try { discovery.register(adapter("builtin", calls)); } catch (error) { duplicateError = error; }
  });
  const ctx = {
    cwd: "/work",
    sessionManager: { getBranch: () => [] },
    ui: { theme: { fg: (_color, text) => text }, setStatus() {} },
  };

  await subject.handlers.get("session_start")({}, ctx);

  assert.match(invalidError.message, /require an ID and bind function/);
  assert.match(duplicateError.message, /Duplicate monitor adapter ID: builtin/);
  assert.throws(
    () => discovery.register(adapter("late", calls)),
    /must register before session startup/,
  );
  assert.deepEqual(calls, ["builtin:bind", "builtin:start:/work"]);
});

test("reserves discovered adapter IDs during binding", async () => {
  const calls = [];
  const subject = fixture([adapter("builtin", calls)]);
  let nestedError;
  subject.pi.events.on(MONITOR_ADAPTER_DISCOVERY_EVENT, (discovery) => {
    discovery.register({
      id: "external",
      bind(pi, services) {
        try { discovery.register(adapter("external", calls)); } catch (error) { nestedError = error; }
        return adapter("external", calls).bind(pi, services);
      },
    });
  });
  const ctx = {
    cwd: "/work",
    sessionManager: { getBranch: () => [] },
    ui: { theme: { fg: (_color, text) => text }, setStatus() {} },
  };

  await subject.handlers.get("session_start")({}, ctx);

  assert.match(nestedError.message, /Duplicate monitor adapter ID: external/);
  assert.deepEqual(calls, [
    "builtin:bind",
    "external:bind",
    "builtin:start:/work",
    "external:start:/work",
  ]);
});

test("disposes a discovered session when subscription fails", async () => {
  const calls = [];
  const subject = fixture([adapter("builtin", calls)]);
  let registrationError;
  let disposed = 0;
  subject.pi.events.on(MONITOR_ADAPTER_DISCOVERY_EVENT, (discovery) => {
    try {
      discovery.register({
        id: "broken-subscription",
        bind() {
          return {
            subscribe() { throw new Error("subscription failed"); },
            async dispose() { disposed++; },
          };
        },
      });
    } catch (error) {
      registrationError = error;
    }
  });
  const ctx = {
    cwd: "/work",
    sessionManager: { getBranch: () => [] },
    ui: { theme: { fg: (_color, text) => text }, setStatus() {} },
  };

  await subject.handlers.get("session_start")({}, ctx);
  await waitFor(() => disposed === 1, "failed discovered session disposal");

  assert.match(registrationError.message, /subscription failed/);
  assert.deepEqual(calls, ["builtin:bind", "builtin:start:/work"]);
});

test("rejects invalid adapter IDs before binding any adapter", () => {
  const calls = [];
  assert.throws(
    () => fixture([adapter("duplicate", calls), adapter("duplicate", calls)]),
    /Duplicate monitor adapter ID: duplicate/,
  );
  assert.deepEqual(calls, []);

  assert.throws(() => fixture([adapter("  ", calls)]), /non-empty ID/);
  assert.doesNotThrow(() => fixture([adapter("a".repeat(64), [])]));
  assert.throws(() => fixture([adapter("a".repeat(65), calls)]), /bounded printable strings/);
  assert.deepEqual(calls, []);
});

test("visits every adapter before reporting lifecycle failures", async () => {
  const calls = [];
  const subject = fixture([
    adapter("broken", calls, { failStart: true, failDispose: true }),
    adapter("healthy", calls),
  ]);
  const ctx = {
    cwd: "/work",
    sessionManager: { getBranch: () => [] },
    ui: {
      theme: { fg: (_color, text) => text },
      setStatus() {},
    },
  };

  await assert.rejects(
    subject.handlers.get("session_start")({}, ctx),
    (error) => error instanceof AggregateError && error.errors[0].message === "broken session start failed",
  );
  await assert.rejects(
    subject.handlers.get("session_shutdown")({}, ctx),
    (error) => error instanceof AggregateError && error.errors[0].message === "broken shutdown failed",
  );

  assert.deepEqual(calls.slice(-2), ["broken:dispose", "healthy:dispose"]);
  assert.equal(calls.includes("healthy:start:/work"), true);
});

test("shutdown stops host schedulers even when another cleanup fails", async () => {
  let scheduled;
  let disposed = 0;
  const subject = fixture([{
    id: "scheduled",
    bind(_pi, services) {
      const scheduler = services.createCheckScheduler({
        intervalMs: 10,
        maxBackoffMs: 20,
        canCheck: () => true,
        onChange() {},
        schedule(callback, delayMs) {
          scheduled = { callback, delayMs, cancelled: false };
          return scheduled;
        },
        cancelSchedule(handle) { handle.cancelled = true; },
        async check() { return { ok: true }; },
      });
      return {
        async startSession() { await scheduler.start(); },
        async rebindBranch() {},
        async messageEnded() {},
        async dispose() { disposed++; },
        snapshot: () => ({ active: [], recent: [] }),
        subscribe: () => () => undefined,
        async refresh() { return false; },
        async stop() { return false; },
      };
    },
  }]);
  subject.runtime.addCleanup(() => { throw new Error("overlay cleanup failed"); });
  const ctx = {
    cwd: "/work",
    sessionManager: { getBranch: () => [] },
    ui: { theme: { fg: (_color, text) => text }, setStatus() {} },
  };

  await subject.handlers.get("session_start")({}, ctx);
  await assert.rejects(subject.handlers.get("session_shutdown")({}, ctx), /Monitor shutdown failed/);

  assert.equal(disposed, 1);
  assert.equal(scheduled.cancelled, true);
});

test("filesystem observation starts only after every adapter session initializes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-monitors-startup-wakeup-"));
  const target = join(directory, "state.json");
  const received = [];
  let releaseStart;
  let shutdown = false;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const subject = fixture([{
    id: "delayed-file-source",
    bind(_pi, services) {
      const unwatch = services.watchFiles({ watchId: "delayed:state", directory, filenames: ["state.json"] });
      return {
        async startSession() {}, async rebindBranch() {}, async messageEnded() {}, async dispose() { unwatch(); },
        snapshot: () => ({ active: [], recent: [] }), subscribe: () => () => undefined,
        async refresh() { return false; }, async stop() { return false; },
      };
    },
  }, {
    id: "delayed-session",
    bind() {
      return {
        async startSession() { await startGate; }, async rebindBranch() {}, async messageEnded() {}, async dispose() {},
        snapshot: () => ({ active: [], recent: [] }), subscribe: () => () => undefined,
        async refresh() { return false; }, async stop() { return false; },
      };
    },
  }]);
  const unsubscribe = subject.pi.events.on(FILES_CHANGED_EVENT, (value) => received.push(value));
  const ctx = {
    cwd: directory,
    sessionManager: { getBranch: () => [] },
    ui: { theme: { fg: (_color, text) => text }, setStatus() {} },
  };
  try {
    const starting = subject.handlers.get("session_start")({}, ctx);
    const first = join(directory, ".first.tmp");
    await writeFile(first, "first");
    await rename(first, target);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(received.length, 0);

    releaseStart();
    await starting;
    const second = join(directory, ".second.tmp");
    await writeFile(second, "second");
    await rename(second, target);
    await waitFor(() => received.length === 1, "post-start filesystem event");
    await subject.handlers.get("session_shutdown")({}, ctx);
    shutdown = true;
  } finally {
    releaseStart();
    unsubscribe();
    if (!shutdown) await subject.handlers.get("session_shutdown")({}, ctx).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed adapter startup leaves filesystem observation dormant", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-monitors-failed-wakeup-"));
  const target = join(directory, "state.json");
  const received = [];
  let shutdown = false;
  const subject = fixture([{
    id: "failed-file-source",
    bind(_pi, services) {
      const unwatch = services.watchFiles({ watchId: "failed:state", directory, filenames: ["state.json"] });
      return {
        async startSession() {}, async rebindBranch() {}, async messageEnded() {}, async dispose() { unwatch(); },
        snapshot: () => ({ active: [], recent: [] }), subscribe: () => () => undefined,
        async refresh() { return false; }, async stop() { return false; },
      };
    },
  }, {
    id: "failed-session",
    bind() {
      return {
        async startSession() { throw new Error("initialization failed"); },
        async rebindBranch() {}, async messageEnded() {}, async dispose() {},
        snapshot: () => ({ active: [], recent: [] }), subscribe: () => () => undefined,
        async refresh() { return false; }, async stop() { return false; },
      };
    },
  }]);
  const unsubscribe = subject.pi.events.on(FILES_CHANGED_EVENT, (value) => received.push(value));
  const ctx = {
    cwd: directory,
    sessionManager: { getBranch: () => [] },
    ui: { theme: { fg: (_color, text) => text }, setStatus() {} },
  };
  try {
    await assert.rejects(subject.handlers.get("session_start")({}, ctx), /session start failed/);
    const replacement = join(directory, ".state.json.tmp");
    await writeFile(replacement, "next");
    await rename(replacement, target);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(received.length, 0);
    await subject.handlers.get("session_shutdown")({}, ctx);
    shutdown = true;
  } finally {
    unsubscribe();
    if (!shutdown) await subject.handlers.get("session_shutdown")({}, ctx).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("filesystem events wake a monitor's authoritative check", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-monitors-monitor-wakeup-"));
  const target = join(directory, "state.json");
  let checks = 0;
  let shutdown = false;
  const subject = fixture([{
    id: "file-monitor",
    bind(pi, services) {
      const scheduler = services.createCheckScheduler({
        intervalMs: 60_000,
        maxBackoffMs: 60_000,
        canCheck: () => true,
        onChange() {},
        async check() { checks++; return { ok: true }; },
      });
      const unwatch = services.watchFiles({ watchId: "file-monitor:state", directory, filenames: ["state.json"] });
      const unsubscribe = pi.events.on(FILES_CHANGED_EVENT, (value) => {
        if (value?.watchId === "file-monitor:state") void scheduler.start();
      });
      return {
        async startSession() { await scheduler.start(); },
        async rebindBranch() {}, async messageEnded() {},
        async dispose() { unsubscribe(); unwatch(); },
        snapshot: () => ({ active: [], recent: [] }), subscribe: () => () => undefined,
        async refresh() { return false; }, async stop() { return false; },
      };
    },
  }]);
  const ctx = {
    cwd: directory,
    sessionManager: { getBranch: () => [] },
    ui: { theme: { fg: (_color, text) => text }, setStatus() {} },
  };
  try {
    await subject.handlers.get("session_start")({}, ctx);
    assert.equal(checks, 1);
    const replacement = join(directory, ".state.json.tmp");
    await writeFile(replacement, "next");
    await rename(replacement, target);
    await waitFor(() => checks === 2, "filesystem monitor check");
    await subject.handlers.get("session_shutdown")({}, ctx);
    shutdown = true;

    const later = join(directory, ".later.tmp");
    await writeFile(later, "later");
    await rename(later, target);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(checks, 2);
  } finally {
    if (!shutdown) await subject.handlers.get("session_shutdown")({}, ctx).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("filesystem wakeups notify an event-only subscriber without creating a monitor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-monitors-subscriber-"));
  const target = join(directory, "manifest.json");
  const received = [];
  let shutdown = false;
  const subject = fixture([{
    id: "file-source",
    bind(_pi, services) {
      const unwatch = services.watchFiles({ watchId: "scheduler:manifest", directory, filenames: ["manifest.json"] });
      return {
        async startSession() {}, async rebindBranch() {}, async messageEnded() {},
        async dispose() { unwatch(); },
        snapshot: () => ({ active: [], recent: [] }), subscribe: () => () => undefined,
        async refresh() { return false; }, async stop() { return false; },
      };
    },
  }]);
  const unsubscribe = subject.pi.events.on(FILES_CHANGED_EVENT, (value) => received.push(value));
  const ctx = {
    cwd: directory,
    sessionManager: { getBranch: () => [] },
    ui: { theme: { fg: (_color, text) => text }, setStatus() {} },
  };
  try {
    await subject.handlers.get("session_start")({}, ctx);
    const replacement = join(directory, ".manifest.json.tmp");
    await writeFile(replacement, "next");
    await rename(replacement, target);
    await waitFor(() => received.length === 1, "filesystem subscriber event");

    assert.equal(received[0].watchId, "scheduler:manifest");
    assert.ok(received[0].paths === null || received[0].paths.includes(target));
    assert.deepEqual(subject.runtime.snapshot().summary, { active: 0, degraded: 0, attention: 0, recent: 0 });
    await subject.handlers.get("session_shutdown")({}, ctx);
    shutdown = true;
  } finally {
    unsubscribe();
    if (!shutdown) await subject.handlers.get("session_shutdown")({}, ctx).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("active stores persist bounded adapter state and roll back failed writes", async () => {
  let store;
  const storedAdapter = {
    id: "stored",
    bind(_pi, services) {
      store = services.createActiveStore({
        version: 1,
        decodeState(value) {
          return value && typeof value === "object" && Number.isSafeInteger(value.count) ? value : undefined;
        },
      });
      return {
        async startSession() {},
        async rebindBranch() {},
        async messageEnded() {},
        async dispose() {},
        snapshot: () => ({ active: [], recent: [] }),
        subscribe: () => () => undefined,
        async refresh() { return false; },
        async stop() { return false; },
      };
    },
  };
  const subject = fixture([storedAdapter]);
  const ctx = {
    cwd: "/work",
    sessionManager: { getBranch: () => subject.entries },
    ui: { theme: { fg: (_color, text) => text }, setStatus() {} },
  };
  await subject.handlers.get("session_start")({}, ctx);

  const saved = store.save("stored:one", { count: 1 });
  saved.state.count = 9;
  assert.equal(store.load()[0].state.count, 1);
  assert.equal(store.remove("stored:one"), true);
  assert.equal(store.load().length, 0);
  assert.deepEqual(subject.entries.at(-1).data.active, []);

  const previousAppend = subject.pi.appendEntry;
  subject.pi.appendEntry = () => { throw new Error("disk full"); };
  assert.throws(() => store.save("stored:two", { count: 2 }), /disk full/);
  assert.equal(store.load().length, 0);
  subject.pi.appendEntry = previousAppend;
});

test("purges durable records that the current adapter version cannot load", async () => {
  let firstStore;
  const first = fixture([{
    id: "versioned",
    bind(_pi, services) {
      firstStore = services.createActiveStore({ version: 1, decodeState: (value) => value });
      return {
        async startSession() {}, async rebindBranch() {}, async messageEnded() {}, async dispose() {},
        snapshot: () => ({ active: [], recent: [] }), subscribe: () => () => undefined,
        async refresh() { return false; }, async stop() { return false; },
      };
    },
  }]);
  const firstCtx = {
    cwd: "/work",
    sessionManager: { getBranch: () => first.entries },
    ui: { theme: { fg: (_color, text) => text }, setStatus() {} },
  };
  await first.handlers.get("session_start")({}, firstCtx);
  firstStore.save("versioned:old", { value: 1 });

  let loaded;
  const restored = fixture([{
    id: "versioned",
    bind(_pi, services) {
      const store = services.createActiveStore({ version: 2, decodeState: (value) => value });
      return {
        async startSession() { loaded = store.load(); }, async rebindBranch() {}, async messageEnded() {}, async dispose() {},
        snapshot: () => ({ active: [], recent: [] }), subscribe: () => () => undefined,
        async refresh() { return false; }, async stop() { return false; },
      };
    },
  }]);
  const restoredCtx = {
    cwd: "/work",
    sessionManager: { getBranch: () => [...first.entries, ...restored.entries] },
    ui: { theme: { fg: (_color, text) => text }, setStatus() {} },
  };
  await restored.handlers.get("session_start")({}, restoredCtx);

  assert.deepEqual(loaded, []);
  assert.deepEqual(restored.entries.at(-1).data.active, []);
});

test("delivery persists a receipt before sending and deduplicates acknowledgement", async () => {
  let store;
  let delivery;
  const subject = fixture([{
    id: "delivery",
    bind(_pi, services) {
      store = services.createActiveStore({ version: 1, decodeState: (value) => value });
      delivery = services.createDelivery();
      return {
        async startSession() {}, async rebindBranch() {}, async messageEnded() {}, async dispose() {},
        snapshot: () => ({ active: [], recent: [] }), subscribe: () => () => undefined,
        async refresh() { return false; }, async stop() { return false; },
      };
    },
  }]);
  const ctx = {
    cwd: "/work",
    sessionManager: { getBranch: () => subject.entries },
    ui: { theme: { fg: (_color, text) => text }, setStatus() {} },
  };
  await subject.handlers.get("session_start")({}, ctx);
  store.save("delivery:one", { value: 1 });
  const fingerprint = "a".repeat(64);
  const notification = {
    fingerprint,
    customType: "test_event",
    content: "done",
    details: { result: "succeeded" },
  };

  assert.equal(delivery.deliver("delivery:one", notification), true);
  assert.equal(delivery.deliver("delivery:one", notification), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subject.sent.length, 1);
  assert.deepEqual(subject.sent[0][0].details, {
    result: "succeeded",
    eventId: "delivery:one",
    fingerprint,
  });
  assert.equal(store.load()[0].pendingNotification.fingerprint, fingerprint);

  assert.equal(delivery.acknowledge("delivery:one", { role: "custom", ...subject.sent[0][0] }), true);
  assert.equal(delivery.acknowledge("delivery:one", { role: "custom", ...subject.sent[0][0] }), false);
  assert.equal(store.load()[0].pendingNotification, undefined);
  assert.deepEqual(store.load()[0].deliveredFingerprints, [fingerprint]);

  assert.throws(() => delivery.deliver("delivery:one", {
    fingerprint: "b".repeat(64),
    customType: "test_event",
    content: "x".repeat(30 * 1024),
    details: { payload: "y".repeat(30 * 1024) },
  }), /complete delivery limit/);

  assert.equal(store.remove("delivery:one"), true);
  store.save("delivery:one", { value: 2 });
  assert.equal(delivery.deliver("delivery:one", { ...notification, fingerprint: "c".repeat(64) }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subject.sent.length, 2);
});

test("batches pending monitor notifications into one follow-up and waits for it to settle", async () => {
  let store;
  let delivery;
  const deliveredContent = [];
  const subject = fixture([{
    id: "delivery",
    bind(_pi, services) {
      store = services.createActiveStore({ version: 1, decodeState: (value) => value });
      delivery = services.createDelivery();
      return {
        async startSession() {}, async rebindBranch() {},
        async messageEnded(message) {
          const eventId = message?.details?.eventId;
          if (typeof eventId === "string") {
            deliveredContent.push(message.content);
            delivery.acknowledge(eventId, message);
          }
        },
        async dispose() {}, snapshot: () => ({ active: [], recent: [] }), subscribe: () => () => undefined,
        async refresh() { return false; }, async stop() { return false; },
      };
    },
  }]);
  const ctx = {
    cwd: "/work",
    sessionManager: { getBranch: () => subject.entries },
    ui: { theme: { fg: (_color, text) => text }, setStatus() {} },
  };
  await subject.handlers.get("session_start")({}, ctx);
  for (const id of ["delivery:one", "delivery:two", "delivery:three"]) store.save(id, { id });
  const notification = (fingerprint, content) => ({
    fingerprint,
    customType: "test_event",
    content,
    details: { content },
  });

  assert.equal(delivery.deliver("delivery:one", notification("a".repeat(64), "first")), true);
  assert.equal(delivery.deliver("delivery:two", notification("b".repeat(64), "second")), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(subject.sent.length, 1);
  assert.equal(subject.sent[0][0].customType, "pi-monitors-notification-batch");
  assert.match(subject.sent[0][0].content, /first[\s\S]*second/);
  assert.equal(subject.sent[0][0].details.items.length, 2);
  assert.equal(Buffer.byteLength(JSON.stringify(subject.sent[0][0]), "utf8") <= 48 * 1024, true);
  assert.deepEqual(subject.sent[0][1], { deliverAs: "followUp", triggerTurn: true });

  const duplicated = structuredClone(subject.sent[0][0]);
  duplicated.details.items.push(structuredClone(duplicated.details.items[0]));
  await subject.handlers.get("message_end")({ message: { role: "custom", ...duplicated } }, ctx);
  assert.deepEqual(deliveredContent, []);

  await subject.handlers.get("message_end")({ message: { role: "custom", ...subject.sent[0][0] } }, ctx);
  assert.equal(store.load().filter((record) => record.pendingNotification).length, 0);
  assert.deepEqual(deliveredContent, ["first", "second"]);

  assert.equal(delivery.deliver("delivery:three", notification("c".repeat(64), "third")), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subject.sent.length, 1);

  await subject.handlers.get("agent_settled")({}, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subject.sent.length, 2);
  assert.equal(subject.sent[1][0].customType, "test_event");
  assert.equal(subject.sent[1][0].content, "third");
});

test("branch navigation discards notifications queued by the previous branch", async () => {
  let store;
  let delivery;
  const subject = fixture([{
    id: "delivery",
    bind(_pi, services) {
      store = services.createActiveStore({ version: 1, decodeState: (value) => value });
      delivery = services.createDelivery();
      return {
        async startSession() {}, async rebindBranch() {}, async messageEnded() {}, async dispose() {},
        snapshot: () => ({ active: [], recent: [] }), subscribe: () => () => undefined,
        async refresh() { return false; }, async stop() { return false; },
      };
    },
  }]);
  const ctx = {
    cwd: "/work",
    sessionManager: { getBranch: () => subject.entries },
    ui: { theme: { fg: (_color, text) => text }, setStatus() {} },
  };
  await subject.handlers.get("session_start")({}, ctx);
  store.save("delivery:one", { id: 1 });
  store.save("delivery:two", { id: 2 });
  delivery.deliver("delivery:one", {
    fingerprint: "a".repeat(64), customType: "test_event", content: "old branch first", details: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  delivery.deliver("delivery:two", {
    fingerprint: "b".repeat(64), customType: "test_event", content: "old branch queued", details: {},
  });

  const newBranchCtx = {
    ...ctx,
    sessionManager: { getBranch: () => [] },
  };
  await subject.handlers.get("session_tree")({}, newBranchCtx);
  await subject.handlers.get("agent_settled")({}, newBranchCtx);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(subject.sent.length, 1);
  assert.doesNotMatch(subject.sent[0][0].content, /old branch queued/);
});

test("malformed reserved batches are not forwarded to adapters", async () => {
  const calls = [];
  const subject = fixture([adapter("alpha", calls)]);
  const ctx = {
    cwd: "/work",
    sessionManager: { getBranch: () => [] },
    ui: { theme: { fg: (_color, text) => text }, setStatus() {} },
  };
  await subject.handlers.get("session_start")({}, ctx);
  await subject.handlers.get("message_end")({
    message: {
      role: "custom",
      customType: "pi-monitors-notification-batch",
      content: "malformed",
      details: { version: 1, items: [{ eventId: "forged" }] },
    },
  }, ctx);
  assert.equal(calls.some((call) => call.startsWith("alpha:message:")), false);
});

test("restores every durable receipt from a batched notification", async () => {
  let firstStore;
  let firstDelivery;
  const first = fixture([{
    id: "delivery",
    bind(_pi, services) {
      firstStore = services.createActiveStore({ version: 1, decodeState: (value) => value });
      firstDelivery = services.createDelivery();
      return {
        async startSession() {}, async rebindBranch() {}, async messageEnded() {}, async dispose() {},
        snapshot: () => ({ active: [], recent: [] }), subscribe: () => () => undefined,
        async refresh() { return false; }, async stop() { return false; },
      };
    },
  }]);
  const firstCtx = {
    cwd: "/work",
    sessionManager: { getBranch: () => first.entries },
    ui: { theme: { fg: (_color, text) => text }, setStatus() {} },
  };
  await first.handlers.get("session_start")({}, firstCtx);
  firstStore.save("delivery:one", { id: 1 });
  firstStore.save("delivery:two", { id: 2 });
  firstDelivery.deliver("delivery:one", {
    fingerprint: "a".repeat(64), customType: "test_event", content: "first", details: {},
  });
  firstDelivery.deliver("delivery:two", {
    fingerprint: "b".repeat(64), customType: "test_event", content: "second", details: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  const delivered = first.sent[0][0];
  const durableBranch = [
    ...first.entries,
    { type: "custom_message", customType: delivered.customType, content: delivered.content, details: delivered.details },
  ];

  let restoredStore;
  const restored = fixture([{
    id: "delivery",
    bind(_pi, services) {
      restoredStore = services.createActiveStore({ version: 1, decodeState: (value) => value });
      return {
        async startSession() {}, async rebindBranch() {}, async messageEnded() {}, async dispose() {},
        snapshot: () => ({ active: [], recent: [] }), subscribe: () => () => undefined,
        async refresh() { return false; }, async stop() { return false; },
      };
    },
  }]);
  const restoredCtx = {
    cwd: "/work",
    sessionManager: { getBranch: () => [...durableBranch, ...restored.entries] },
    ui: { theme: { fg: (_color, text) => text }, setStatus() {} },
  };
  await restored.handlers.get("session_start")({}, restoredCtx);

  assert.deepEqual(restoredStore.load().map((record) => ({
    id: record.id,
    pending: record.pendingNotification,
    delivered: record.deliveredFingerprints,
  })), [
    { id: "delivery:one", pending: undefined, delivered: ["a".repeat(64)] },
    { id: "delivery:two", pending: undefined, delivered: ["b".repeat(64)] },
  ]);
  assert.equal(restored.sent.length, 0);
});

test("aggregates adapter views and routes refresh and stop by monitor ID", async () => {
  const calls = [];
  const monitor = (id, label, health = "healthy") => ({
    id,
    kind: "test",
    label,
    lifecycle: "active",
    health,
    attentionCount: health === "degraded" ? 1 : 0,
    status: health,
    detail: [],
  });
  const subject = fixture([
    adapter("alpha", calls, {
      monitorId: "monitor-a",
      snapshot: { active: [monitor("monitor-a", "Alpha")], recent: [] },
    }),
    adapter("beta", calls, {
      monitorId: "monitor-b",
      snapshot: { active: [monitor("monitor-b", "Beta", "degraded")], recent: [] },
    }),
  ]);
  const statuses = [];
  const ctx = {
    cwd: "/work",
    sessionManager: { getBranch: () => [] },
    ui: {
      theme: { fg: (_color, text) => text },
      setStatus(id, value) { statuses.push({ id, value }); },
    },
  };

  await subject.handlers.get("session_start")({}, ctx);
  assert.deepEqual(subject.runtime.snapshot().summary, {
    active: 2,
    degraded: 1,
    attention: 1,
    recent: 0,
  });
  assert.deepEqual(statuses.at(-1), {
    id: "pi-monitors",
    value: "! Monitors · 2 active · 1 degraded · 1 attention",
  });

  await subject.runtime.refresh("monitor-b");
  await subject.runtime.stop("monitor-a");
  assert.equal(calls.includes("alpha:refresh:monitor-b"), true);
  assert.equal(calls.includes("beta:refresh:monitor-b"), true);
  assert.equal(calls.includes("alpha:stop:monitor-a"), true);
});

test("persists completed records, restores them, and keeps dismissals branch-local", async () => {
  const calls = [];
  const completed = {
    id: "monitor-completed",
    kind: "test",
    label: "Completed monitor",
    lifecycle: "completed",
    health: "healthy",
    attentionCount: 0,
    status: "succeeded",
    detail: ["Outcome: succeeded"],
    completedAt: "2026-08-03T22:00:00.000Z",
  };
  const first = fixture([adapter("alpha", calls, { snapshot: { active: [], recent: [completed] } })]);
  const firstCtx = {
    cwd: "/work",
    sessionManager: { getBranch: () => first.entries },
    ui: { theme: { fg: (_color, text) => text }, setStatus() {} },
  };

  await first.handlers.get("session_start")({}, firstCtx);
  assert.deepEqual(first.runtime.snapshot().recent, [completed]);
  assert.equal(first.entries.at(-1).customType, "pi-monitors-records");

  const second = fixture([adapter("alpha", calls)]);
  const secondCtx = {
    cwd: "/work",
    sessionManager: { getBranch: () => [...first.entries, ...second.entries] },
    ui: { theme: { fg: (_color, text) => text }, setStatus() {} },
  };
  await second.handlers.get("session_start")({}, secondCtx);
  assert.deepEqual(second.runtime.snapshot().recent, [completed]);

  const appendEntry = second.pi.appendEntry;
  second.pi.appendEntry = () => { throw new Error("disk full"); };
  assert.throws(() => second.runtime.dismiss(completed.id), /Could not persist the monitor dismissal/);
  assert.deepEqual(second.runtime.snapshot().recent, [completed]);
  second.pi.appendEntry = appendEntry;

  second.runtime.dismiss(completed.id);
  assert.deepEqual(second.runtime.snapshot().recent, []);
  assert.equal(second.entries.at(-1).data.dismissed.length, 1);

  const third = fixture([adapter("alpha", calls, { snapshot: { active: [], recent: [completed] } })]);
  const thirdCtx = {
    cwd: "/work",
    sessionManager: { getBranch: () => [...first.entries, ...second.entries, ...third.entries] },
    ui: { theme: { fg: (_color, text) => text }, setStatus() {} },
  };
  await third.handlers.get("session_start")({}, thirdCtx);
  assert.deepEqual(third.runtime.snapshot().recent, []);
});

async function configuredExtension(t, raw, prepare) {
	const directory = await mkdtemp(join(tmpdir(), "pi-monitors-config-"));
	const file = join(directory, "pi-monitors.json");
	t.after(() => rm(directory, { recursive: true, force: true }));
	if (prepare) raw = await prepare(directory);
	if (raw !== undefined) await writeFile(file, raw);
	const { default: loadExtension } = await import("./index.ts");
	const handlers = new Map();
	const tools = [];
	const renderers = new Map();
	const notices = [];
	const entries = [];
	const ctx = {
		cwd: directory,
		sessionManager: {
			getBranch: () => entries,
			getSessionId: () => "config-test",
			getSessionFile: () => join(directory, "session.jsonl"),
		},
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus() {},
			notify(message, level) {
				notices.push({ message, level });
			},
		},
	};
	const pi = {
		on(name, handler) {
			const previous = handlers.get(name);
			handlers.set(name, async (...args) => {
				await previous?.(...args);
				return handler(...args);
			});
		},
		registerTool(tool) {
			tools.push(tool);
		},
		registerMessageRenderer(type, renderer) {
			renderers.set(type, renderer);
		},
		registerCommand() {},
		appendEntry(customType, data) {
			entries.push({ type: "custom", customType, data });
		},
		events: { emit() {} },
	};
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = directory;
		loadExtension(pi);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
	t.after(() => handlers.get("session_shutdown")({}, ctx));
	return { directory, file, handlers, tools, renderers, notices, entries, ctx };
}

for (const [label, raw] of [["missing config file", undefined], ["missing concourse key", "{}"]]) {
	test(`${label} silently leaves Concourse off`, async (t) => {
		const subject = await configuredExtension(t, raw);
		await subject.handlers.get("session_start")({}, subject.ctx);
		assert.deepEqual(subject.tools.map((tool) => tool.name), ["monitor_github_pr"]);
		assert.equal(subject.renderers.has("concourse_deployment_outcome"), false);
		assert.deepEqual(subject.notices, []);
	});
}

for (const [label, raw, key] of [
	["leading-dash target", '{"concourse":{"target":"-private-value"}}', "concourse.target"],
	["relative flyPath", '{"concourse":{"target":"ci","flyPath":"private-value"}}', "concourse.flyPath"],
	["unknown key", '{"concourse":{"target":"ci","typo":"private-value"}}', "concourse.typo"],
	["malformed JSON", '{"concourse": private-value}', "JSON"],
]) {
	test(`${label} disables Concourse with one warning and keeps GitHub registered`, async (t) => {
		const subject = await configuredExtension(t, raw);
		assert.deepEqual(subject.notices, []);
		await subject.handlers.get("session_start")({}, subject.ctx);
		await subject.handlers.get("session_start")({}, subject.ctx);
		assert.deepEqual(subject.tools.map((tool) => tool.name), ["monitor_github_pr"]);
		assert.equal(subject.renderers.has("concourse_deployment_outcome"), false);
		assert.equal(subject.notices.length, 1);
		assert.equal(subject.notices[0].level, "warning");
		assert.ok(subject.notices[0].message.includes(subject.file));
		assert.ok(subject.notices[0].message.includes(key));
		assert.doesNotMatch(subject.notices[0].message, /private-value/);
	});
}

test("Concourse rejects invalid config shapes, names, and executable paths", async (t) => {
	const invalid = [
		[null, "must be an object"],
		[[], "must be an object"],
		[{ concourse: null }, "concourse"],
		[{ concourse: [] }, "concourse"],
		[{ concourse: {} }, "concourse.target"],
		[{ concourse: { target: 1 } }, "concourse.target"],
		[{ concourse: { target: "a".repeat(129) } }, "concourse.target"],
		[{ concourse: { target: " ci" } }, "concourse.target"],
		[{ concourse: { target: "ci/path" } }, "concourse.target"],
		[{ concourse: { target: "ci", team: "-team" } }, "concourse.team"],
		[{ concourse: { target: "ci", team: null } }, "concourse.team"],
		[{ concourse: { target: "ci", resource: "" } }, "concourse.resource"],
		[{ concourse: { target: "ci", resource: "a".repeat(129) } }, "concourse.resource"],
		[{ concourse: { target: "ci", flyPath: null } }, "concourse.flyPath"],
		[{ concourse: { target: "ci", flyPath: "/fly\n" } }, "concourse.flyPath"],
		[{ concourse: { target: "ci", flyPath: "/fly\u0085" } }, "concourse.flyPath"],
		[{ concourse: { target: "ci", flyPath: `/${"é".repeat(256)}` } }, "concourse.flyPath"],
	];
	for (const [config, key] of invalid) {
		const subject = await configuredExtension(t, JSON.stringify(config));
		await subject.handlers.get("session_start")({}, subject.ctx);
		assert.deepEqual(subject.tools.map((tool) => tool.name), ["monitor_github_pr"]);
		assert.equal(subject.notices.length, 1);
		assert.ok(subject.notices[0].message.includes(key));
	}
});

test("Concourse config follows PI_CODING_AGENT_DIR and applies defaults", async (t) => {
	const subject = await configuredExtension(t, '{"concourse":{"target":"ci"}}');
	const { loadConcourseConfig } = await import("./adapters/concourse-config.ts");
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = subject.directory;
		assert.deepEqual(loadConcourseConfig(), {
			config: { target: "ci", team: "main", resource: "repo", flyPath: "/usr/local/bin/fly" },
		});
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
	assert.deepEqual(subject.tools.map((tool) => tool.name), ["monitor_github_pr", "monitor_concourse_deployment"]);
	assert.equal(subject.renderers.has("concourse_deployment_outcome"), true);
	assert.deepEqual(subject.notices, []);
});

test("Concourse config accepts name and UTF-8 path boundaries", async (t) => {
	const subject = await configuredExtension(t, JSON.stringify({
		unrelated: { setting: true },
		concourse: {
			target: `c${"i".repeat(62)}`,
			team: "Team_1.2-prod",
			resource: "Repo_1.2-main",
			flyPath: `/${"é".repeat(255)}x`,
		},
	}));
	await subject.handlers.get("session_start")({}, subject.ctx);
	assert.equal(subject.tools.some((tool) => tool.name === "monitor_concourse_deployment"), true);
	assert.deepEqual(subject.notices, []);
});

test("Concourse runs the configured executable, target, team, and resource after loading config once", async (t) => {
	const subject = await configuredExtension(t, undefined, async (directory) => {
		const flyPath = join(directory, "configured-fly");
		const calls = join(directory, "calls.jsonl");
		const script = [
			`#!${process.execPath}`,
			'const fs = require("node:fs");',
			"const args = process.argv.slice(2);",
			`fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");`,
			'const jobs = [{ name: "deploy", inputs: [{ name: "source", resource: "source-code" }] }];',
			'process.stdout.write(JSON.stringify(args[2] === "jobs" ? jobs : []));',
		].join("\n");
		await writeFile(flyPath, script, { mode: 0o700 });
		return JSON.stringify({ concourse: { target: "build-ci", team: "release", resource: "source-code", flyPath } });
	});
	await writeFile(subject.file, "not JSON after extension load");
	await subject.handlers.get("session_start")({}, subject.ctx);
	const tool = subject.tools.find((candidate) => candidate.name === "monitor_concourse_deployment");
	const result = await tool.execute("configured", {
		pipeline: "my-service-deploy",
		revision: "a".repeat(40),
	}, undefined, undefined, subject.ctx);
	assert.equal(result.details.health, "healthy");
	assert.deepEqual(subject.notices, []);
	const { readFile } = await import("node:fs/promises");
	const calls = (await readFile(join(subject.directory, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
	assert.deepEqual(calls[0], ["-t", "build-ci", "jobs", "-p", "my-service-deploy", "--team=release", "--json"]);
	assert.deepEqual(calls[1], [
		"-t", "build-ci", "curl",
		`/api/v1/teams/release/pipelines/my-service-deploy/resources/source-code/versions?filter=ref%3A${"a".repeat(40)}`,
		"--", "--silent", "--show-error",
	]);
	const registration = subject.entries.findLast((entry) => entry.customType === "pi-monitors-records")
		.data.active[0].state.registration;
	assert.equal(registration.target, "build-ci");
	assert.equal(registration.team, "release");
	assert.equal(registration.resource, "source-code");
});

for (const kind of ["FIFO", "symlink to FIFO"]) {
	test(`Concourse config rejects a ${kind} promptly and keeps GitHub registered`, async (t) => {
		const { spawnSync } = await import("node:child_process");
		const directory = await mkdtemp(join(tmpdir(), "pi-monitors-fifo-"));
		t.after(() => rm(directory, { recursive: true, force: true }));
		const fifo = join(directory, "fifo");
		const created = spawnSync("mkfifo", [fifo], { timeout: 1_000 });
		if (created.error?.code === "ENOENT") {
			t.skip("mkfifo is unavailable");
			return;
		}
		assert.ifError(created.error);
		assert.equal(created.status, 0);
		// A test-runner timeout cannot interrupt a synchronous FIFO read.
		const source = `
			import assert from "node:assert/strict";
			import { mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
			import { tmpdir } from "node:os";
			import { join } from "node:path";
			${configuredExtension.toString()}
			const cleanup = [];
			try {
				const subject = await configuredExtension({ after: (fn) => cleanup.push(fn) }, undefined, async (directory) => {
					await ${kind === "FIFO" ? "rename" : "symlink"}(${JSON.stringify(fifo)}, join(directory, "pi-monitors.json"));
				});
				await subject.handlers.get("session_start")({}, subject.ctx);
				await subject.handlers.get("session_start")({}, subject.ctx);
				assert.deepEqual(subject.tools.map((tool) => tool.name), ["monitor_github_pr"]);
				assert.equal(subject.notices.length, 1);
				assert.equal(subject.notices[0].level, "warning");
				assert.ok(subject.notices[0].message.includes(subject.file));
				assert.match(subject.notices[0].message, /must be a regular file/);
			} finally {
				for (const fn of cleanup.reverse()) await fn();
			}
		`;
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
			cwd: new URL("./", import.meta.url),
			env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory },
			timeout: 3_000,
			killSignal: "SIGKILL",
			encoding: "utf8",
		});
		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stderr);
	});
}

test("Concourse config rejects a file just over 64 KiB and keeps GitHub registered", async (t) => {
	const raw = JSON.stringify({ concourse: { target: "ci" } }).padEnd(64 * 1024 + 1, " ");
	const subject = await configuredExtension(t, raw);
	await subject.handlers.get("session_start")({}, subject.ctx);
	await subject.handlers.get("session_start")({}, subject.ctx);
	assert.deepEqual(subject.tools.map((tool) => tool.name), ["monitor_github_pr"]);
	assert.equal(subject.notices.length, 1);
	assert.equal(subject.notices[0].level, "warning");
	assert.ok(subject.notices[0].message.includes(subject.file));
	assert.match(subject.notices[0].message, /must be at most 64 KiB/);
});

test("Concourse config accepts a regular file of exactly 64 KiB", async (t) => {
	const raw = JSON.stringify({ concourse: { target: "ci" } }).padEnd(64 * 1024, " ");
	const subject = await configuredExtension(t, raw);
	await subject.handlers.get("session_start")({}, subject.ctx);
	assert.deepEqual(subject.tools.map((tool) => tool.name), ["monitor_github_pr", "monitor_concourse_deployment"]);
	assert.deepEqual(subject.notices, []);
});

for (const field of ["target", "team", "resource"]) {
	test(`Concourse config rejects a 64-character ${field} with one warning`, async (t) => {
		const raw = JSON.stringify({ concourse: { target: "ci", [field]: "a".repeat(64) } });
		const subject = await configuredExtension(t, raw);
		await subject.handlers.get("session_start")({}, subject.ctx);
		assert.deepEqual(subject.tools.map((tool) => tool.name), ["monitor_github_pr"]);
		assert.equal(subject.notices.length, 1);
		assert.equal(subject.notices[0].level, "warning");
		assert.ok(subject.notices[0].message.includes(subject.file));
		assert.ok(subject.notices[0].message.includes(`concourse.${field} must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`));
	});
}

test("Concourse registers 63-character names and a 128-character pipeline with configured fly arguments", async (t) => {
	const target = "t".repeat(63);
	const team = "m".repeat(63);
	const resource = "r".repeat(63);
	const pipeline = "p".repeat(128);
	const revision = "a".repeat(40);
	const subject = await configuredExtension(t, undefined, async (directory) => {
		const flyPath = join(directory, "configured-fly");
		const calls = join(directory, "calls.jsonl");
		const jobs = [{ name: "deploy", inputs: [{ name: "source", resource }] }];
		const script = [
			`#!${process.execPath}`,
			'const fs = require("node:fs");',
			"const args = process.argv.slice(2);",
			`fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");`,
			`process.stdout.write(JSON.stringify(args[2] === "jobs" ? ${JSON.stringify(jobs)} : []));`,
		].join("\n");
		await writeFile(flyPath, script, { mode: 0o700 });
		return JSON.stringify({ concourse: { target, team, resource, flyPath } });
	});
	await subject.handlers.get("session_start")({}, subject.ctx);
	const tool = subject.tools.find((candidate) => candidate.name === "monitor_concourse_deployment");
	const result = await tool.execute("name-boundaries", { pipeline, revision }, undefined, undefined, subject.ctx);
	assert.equal(result.details.health, "healthy");
	assert.deepEqual(subject.notices, []);
	const { readFile } = await import("node:fs/promises");
	const calls = (await readFile(join(subject.directory, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
	assert.deepEqual(calls[0], ["-t", target, "jobs", "-p", pipeline, `--team=${team}`, "--json"]);
	assert.deepEqual(calls[1], [
		"-t", target, "curl",
		`/api/v1/teams/${team}/pipelines/${pipeline}/resources/${resource}/versions?filter=ref%3A${revision}`,
		"--", "--silent", "--show-error",
	]);
	const record = subject.entries.findLast((entry) => entry.customType === "pi-monitors-records").data.active[0];
	assert.ok(record.id.length <= 512);
	assert.equal(record.state.registration.target, target);
	assert.equal(record.state.registration.team, team);
	assert.equal(record.state.registration.resource, resource);
});

test("Concourse warnings replace U+200E and all control and format characters in unknown keys", async (t) => {
	const key = "typo\u0000\u0085\u061c\u200e\u200f\u202e\u2066\u200b";
	const raw = JSON.stringify({ concourse: { target: "ci", [key]: "private-value" } });
	const subject = await configuredExtension(t, raw);
	await subject.handlers.get("session_start")({}, subject.ctx);
	assert.deepEqual(subject.tools.map((tool) => tool.name), ["monitor_github_pr"]);
	assert.equal(subject.notices.length, 1);
	assert.equal(subject.notices[0].level, "warning");
	assert.ok(subject.notices[0].message.includes(subject.file));
	assert.doesNotMatch(subject.notices[0].message, /[\p{Cc}\p{Cf}]/u);
	assert.ok(subject.notices[0].message.includes(`concourse.typo${"\uFFFD".repeat(8)} is an unknown key`));
	assert.doesNotMatch(subject.notices[0].message, /private-value/);
});

test("Concourse config rejects control and format characters in flyPath", async (t) => {
	for (const character of ["\u0000", "\u0085", "\u061c", "\u200e", "\u200f", "\u202e", "\u2066", "\u200b"]) {
		const raw = JSON.stringify({ concourse: { target: "ci", flyPath: `/private-value${character}/fly` } });
		const subject = await configuredExtension(t, raw);
		await subject.handlers.get("session_start")({}, subject.ctx);
		assert.deepEqual(subject.tools.map((tool) => tool.name), ["monitor_github_pr"]);
		assert.equal(subject.notices.length, 1);
		assert.equal(subject.notices[0].level, "warning");
		assert.ok(subject.notices[0].message.includes(subject.file));
		assert.match(subject.notices[0].message, /concourse.flyPath/);
		assert.doesNotMatch(subject.notices[0].message, /[\p{Cc}\p{Cf}]|private-value/u);
	}
});
