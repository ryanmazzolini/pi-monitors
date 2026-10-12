import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FILES_CHANGED_EVENT, FilesystemWakeups } from "./filesystem.ts";

class FakeWatcher extends EventEmitter {
  constructor(directory, listener) {
    super();
    this.directory = directory;
    this.listener = listener;
    this.closed = false;
  }

  change(filename, eventType = "rename") {
    this.listener(eventType, filename);
  }

  close() {
    this.closed = true;
  }
}

function fixture(options = {}) {
  const emitted = [];
  const scheduled = [];
  const watchers = [];
  const attempts = [];
  let now = Date.parse("2026-06-01T12:00:00.000Z");
  let watchFailures = options.watchFailures ?? 0;
  const wakeups = new FilesystemWakeups({
    emit(event) { emitted.push({ channel: FILES_CHANGED_EVENT, event }); },
    now: () => now,
    retryMs: 1_000,
    maxRetryMs: 4_000,
    watch(directory, listener) {
      attempts.push(directory);
      if (watchFailures-- > 0) throw new Error("watch unavailable");
      const watcher = new FakeWatcher(directory, listener);
      watchers.push(watcher);
      return watcher;
    },
    schedule(callback, delayMs) {
      const handle = { callback, delayMs, cancelled: false, unref() {} };
      scheduled.push(handle);
      return handle;
    },
    cancelSchedule(handle) { handle.cancelled = true; },
  });
  return {
    attempts,
    emitted,
    scheduled,
    watchers,
    wakeups,
    advance(ms) { now += ms; },
    run(delayMs) {
      const handle = scheduled.find((candidate) => !candidate.cancelled && candidate.delayMs === delayMs);
      assert.ok(handle, `missing ${delayMs}ms timer`);
      handle.cancelled = true;
      handle.callback();
      return handle;
    },
  };
}

function event(subject, index = 0) {
  return subject.emitted[index]?.event;
}

test("coalesces atomic replacements into one bounded file-change event", () => {
  const subject = fixture();
  subject.wakeups.watch({
    watchId: "scheduler-manifest",
    directory: "/work/.pi",
    filenames: ["scheduled-jobs.json"],
  });
  subject.wakeups.start();

  subject.watchers[0].change("scheduled-jobs.json", "rename");
  subject.watchers[0].change("unrelated.json", "change");
  subject.watchers[0].change(Buffer.from("scheduled-jobs.json"), "change");
  subject.advance(100);
  subject.run(100);

  assert.deepEqual(subject.attempts, ["/work/.pi"]);
  assert.deepEqual(event(subject), {
    watchId: "scheduler-manifest",
    paths: ["/work/.pi/scheduled-jobs.json"],
    observedAt: "2026-06-01T12:00:00.100Z",
  });
});

test("uses null when the platform omits or cannot safely identify a filename", () => {
  for (const filename of [null, "nested/unsafe.txt", Buffer.from([0xff])]) {
    const subject = fixture();
    subject.wakeups.watch({ watchId: "project-files", directory: "/work" });
    subject.wakeups.start();
    subject.watchers[0].change(filename);
    subject.run(100);
    assert.equal(event(subject).paths, null);
  }
});

test("observes a real atomic file replacement through its parent directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-monitors-filesystem-"));
  const target = join(directory, "state.json");
  const replacement = join(directory, ".state.json.tmp");
  const emitted = [];
  const wakeups = new FilesystemWakeups({ emit: (changed) => emitted.push(changed) });
  try {
    wakeups.watch({ watchId: "atomic", directory, filenames: ["state.json"], debounceMs: 20 });
    wakeups.start();
    await writeFile(replacement, "next");
    await rename(replacement, target);
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("timed out waiting for fs.watch")), 2_000);
      const check = () => {
        if (emitted.length > 0) {
          clearTimeout(deadline);
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });
    assert.equal(emitted[0].watchId, "atomic");
    assert.ok(emitted[0].paths === null || emitted[0].paths.includes(target));
  } finally {
    wakeups.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("deduplicates directory handles across independently filtered watches", () => {
  const subject = fixture();
  const removeFirst = subject.wakeups.watch({ watchId: "first", directory: "/work", filenames: ["first.txt"] });
  const removeSecond = subject.wakeups.watch({ watchId: "second", directory: "/work", filenames: ["second.txt"] });
  subject.wakeups.start();

  assert.equal(subject.watchers.length, 1);
  subject.watchers[0].change("second.txt");
  subject.run(100);
  assert.deepEqual(subject.emitted.map(({ event: emitted }) => emitted.watchId), ["second"]);

  removeFirst();
  assert.equal(subject.watchers[0].closed, false);
  removeSecond();
  assert.equal(subject.watchers[0].closed, true);
});

test("emits a rescan and retries a failed watcher with capped backoff", () => {
  const subject = fixture({ watchFailures: 2 });
  subject.wakeups.watch({ watchId: "retrying", directory: "/missing" });
  subject.wakeups.start();

  subject.run(100);
  assert.equal(event(subject).paths, null);
  subject.run(1_000);
  subject.run(100);
  assert.equal(event(subject, 1).paths, null);
  subject.run(2_000);

  assert.deepEqual(subject.attempts, ["/missing", "/missing", "/missing"]);
  assert.equal(subject.watchers.length, 1);

  subject.watchers[0].emit("error", new Error("watcher failed"));
  assert.equal(subject.watchers[0].closed, true);
  subject.run(100);
  subject.run(1_000);
  assert.equal(subject.watchers.length, 2);
});

test("shutdown closes watchers and cancels pending debounce and retry work", () => {
  const subject = fixture();
  subject.wakeups.watch({ watchId: "files", directory: "/work" });
  subject.wakeups.start();
  subject.watchers[0].change("changed.txt");
  subject.watchers[0].emit("error", new Error("watcher failed"));

  subject.wakeups.dispose();

  assert.equal(subject.watchers[0].closed, true);
  assert.equal(subject.scheduled.every((handle) => handle.cancelled), true);
  assert.throws(
    () => subject.wakeups.watch({ watchId: "late", directory: "/work" }),
    /disposed/,
  );
});

test("falls back to a full rescan when a burst exceeds path count or byte limits", () => {
  const countBound = fixture();
  countBound.wakeups.watch({ watchId: "count", directory: "/work" });
  countBound.wakeups.start();
  for (let index = 0; index < 101; index++) countBound.watchers[0].change(`file-${index}`);
  countBound.run(100);
  assert.equal(event(countBound).paths, null);

  const byteBound = fixture();
  byteBound.wakeups.watch({ watchId: "bytes", directory: `/${"d".repeat(4_000)}` });
  byteBound.wakeups.start();
  for (let index = 0; index < 16; index++) byteBound.watchers[0].change(`file-${index}`);
  byteBound.run(100);
  assert.equal(event(byteBound).paths, null);
});

test("validates the registration boundary before opening filesystem resources", () => {
  const subject = fixture();

  assert.throws(() => subject.wakeups.watch({ watchId: "relative", directory: "work" }), /absolute paths/);
  assert.throws(() => subject.wakeups.watch({ watchId: "nested", directory: "/work", filenames: ["a/b"] }), /base names/);
  assert.throws(
    () => subject.wakeups.watch({ watchId: "many-files", directory: "/work", filenames: Array.from({ length: 129 }, (_, index) => `file-${index}`) }),
    /between 1 and 128/,
  );
  subject.wakeups.watch({ watchId: "unique", directory: "/work" });
  assert.throws(() => subject.wakeups.watch({ watchId: "unique", directory: "/other" }), /Duplicate/);
  for (let index = 1; index < 64; index++) subject.wakeups.watch({ watchId: `watch-${index}`, directory: "/work" });
  assert.throws(() => subject.wakeups.watch({ watchId: "watch-65", directory: "/work" }), /watch limit/);
  assert.equal(subject.attempts.length, 0);
});
