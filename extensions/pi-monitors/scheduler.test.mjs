import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeCheckScheduler } from "./scheduler.ts";

function timers() {
  const scheduled = [];
  return {
    scheduled,
    schedule(callback, delayMs) {
      const handle = { callback, delayMs, cancelled: false };
      scheduled.push(handle);
      return handle;
    },
    cancelSchedule(handle) { handle.cancelled = true; },
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("runs authoritative checks and owns capped retry scheduling", async () => {
  const timer = timers();
  const outcomes = [
    { ok: false, error: "offline" },
    { ok: false, error: "offline" },
    { ok: false, error: "offline" },
    { ok: true },
  ];
  let checks = 0;
  let changes = 0;
  const scheduler = new RuntimeCheckScheduler({
    intervalMs: 10,
    maxBackoffMs: 40,
    now: () => Date.parse("2026-08-03T22:00:00.000Z"),
    schedule: timer.schedule,
    cancelSchedule: timer.cancelSchedule,
    canCheck: () => true,
    onChange: () => { changes++; },
    async check() { return outcomes[checks++]; },
  });

  assert.deepEqual(await scheduler.start(), { ok: false, error: "offline" });
  assert.equal(timer.scheduled.at(-1).delayMs, 20);
  assert.equal(scheduler.nextCheckAt, "2026-08-03T22:00:00.020Z");

  timer.scheduled.at(-1).callback();
  await settle();
  assert.equal(timer.scheduled.at(-1).delayMs, 40);
  timer.scheduled.at(-1).callback();
  await settle();
  assert.equal(timer.scheduled.at(-1).delayMs, 40);
  timer.scheduled.at(-1).callback();
  await settle();
  assert.equal(timer.scheduled.at(-1).delayMs, 10);
  assert.equal(checks, 4);
  assert.ok(changes >= 7);
});

test("a superseded check cannot install a stale timer", async () => {
  const timer = timers();
  const resolvers = [];
  const scheduler = new RuntimeCheckScheduler({
    intervalMs: 10,
    maxBackoffMs: 20,
    schedule: timer.schedule,
    cancelSchedule: timer.cancelSchedule,
    canCheck: () => true,
    onChange() {},
    check() { return new Promise((resolve) => resolvers.push(resolve)); },
  });

  const first = scheduler.start();
  await settle();
  const second = scheduler.start();
  await settle();
  resolvers[0]({ ok: true });
  await first;
  assert.equal(timer.scheduled.length, 0);
  resolvers[1]({ ok: true });
  await second;
  assert.equal(timer.scheduled.length, 1);
});

test("stop cancels the timer and aborts an in-flight check", async () => {
  const timer = timers();
  let observedAbort = false;
  let beginCheck;
  const started = new Promise((resolve) => { beginCheck = resolve; });
  const scheduler = new RuntimeCheckScheduler({
    intervalMs: 10,
    maxBackoffMs: 20,
    schedule: timer.schedule,
    cancelSchedule: timer.cancelSchedule,
    canCheck: () => true,
    onChange() {},
    check(signal) {
      beginCheck();
      return new Promise((resolve) => signal.addEventListener("abort", () => {
        observedAbort = true;
        resolve({ ok: true });
      }, { once: true }));
    },
  });

  const check = scheduler.start();
  await started;
  scheduler.stop();
  await check;

  assert.equal(observedAbort, true);
  assert.equal(scheduler.nextCheckAt, undefined);
  assert.equal(timer.scheduled.length, 0);
});

test("contains thrown check failures and does not run when the parent is already aborted", async () => {
  const timer = timers();
  let calls = 0;
  const scheduler = new RuntimeCheckScheduler({
    intervalMs: 10,
    maxBackoffMs: 20,
    schedule: timer.schedule,
    cancelSchedule: timer.cancelSchedule,
    canCheck: () => true,
    onChange() {},
    async check(signal) {
      calls++;
      if (signal.aborted) throw new Error("cancelled");
      throw new Error("bad\ncheck");
    },
  });

  assert.deepEqual(await scheduler.start(), { ok: false, error: "bad check" });
  assert.equal(timer.scheduled.at(-1).delayMs, 20);

  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await scheduler.start(controller.signal), { ok: true });
  assert.equal(calls, 2);
  assert.equal(timer.scheduled.filter((handle) => !handle.cancelled).length, 0);
});
