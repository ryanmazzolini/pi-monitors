import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { FileMonitorLease } from "./leases.ts";

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-monitor-lease-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function lease(directory, now = Date.now) {
  return new FileMonitorLease({ directory, now, resourceName: "test monitor" });
}

function lockPath(directory, key) {
  return path.join(directory, `${createHash("sha256").update(key).digest("hex")}.lock`);
}

test("release atomically hands the lease path to a new owner", async (t) => {
  const directory = await temporaryDirectory(t);
  const key = "shared-target";
  let reportMoved;
  let resumeRelease;
  const moved = new Promise((resolve) => { reportMoved = resolve; });
  const resume = new Promise((resolve) => { resumeRelease = resolve; });
  class PausedReleaseLease extends FileMonitorLease {
    async releasePathMoved() {
      reportMoved();
      await resume;
    }
  }
  const first = new PausedReleaseLease({ directory, resourceName: "test monitor" });
  const second = lease(directory);
  const competitor = lease(directory);
  await first.acquire(key, "first");

  let releaseFinished = false;
  const releasing = first.release().then(() => { releaseFinished = true; });
  await moved;
  assert.equal(releaseFinished, false);

  await second.acquire(key, "second");
  resumeRelease();
  await releasing;

  await assert.rejects(() => competitor.acquire(key, "competitor"), /already owned/);
  await second.release();
  await competitor.release();
});

test("recovers an old malformed lease but refuses symlinked lease paths", async (t) => {
  const directory = await temporaryDirectory(t);
  const key = "stale-target";
  const stalePath = lockPath(directory, key);
  await fs.mkdir(stalePath, { recursive: true });
  const old = new Date("2020-01-01T00:00:00.000Z");
  await fs.utimes(stalePath, old, old);

  const recovered = lease(directory, () => Date.parse("2026-08-03T22:00:00.000Z"));
  await recovered.acquire(key, "recovered");
  await recovered.release();

  const target = await fs.mkdtemp(path.join(os.tmpdir(), "pi-monitor-lease-target-"));
  t.after(() => fs.rm(target, { recursive: true, force: true }));
  await fs.symlink(target, stalePath);
  const guarded = lease(directory);
  await assert.rejects(() => guarded.acquire(key, "guarded"), /already owned/);
  assert.deepEqual(await fs.readdir(target), []);
});
