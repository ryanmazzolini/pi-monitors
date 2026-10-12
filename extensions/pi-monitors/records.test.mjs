import assert from "node:assert/strict";
import test from "node:test";
import {
  completionKey,
  loadMonitorRecordState,
  MAX_RECENT_MONITORS,
  normalizeMonitorRecords,
  toMonitorRecord,
} from "./records.ts";

function record(index, overrides = {}) {
  return {
    id: `monitor-${index}`,
    kind: "test",
    label: `Monitor ${index}`,
    lifecycle: "completed",
    health: "healthy",
    attentionCount: 0,
    status: "succeeded",
    detail: [],
    completedAt: new Date(Date.parse("2026-08-03T22:00:00.000Z") + index * 1_000).toISOString(),
    ...overrides,
  };
}

test("loads the latest valid bounded record state and ignores corrupt successors", () => {
  const valid = {
    version: 1,
    active: [],
    recent: [record(1)],
    dismissed: [completionKey(record(2))],
  };
  const ctx = {
    sessionManager: {
      getBranch: () => [
        { type: "custom", customType: "pi-monitors-records", data: valid },
        { type: "custom", customType: "pi-monitors-records", data: { ...valid, recent: [record(3, { label: "bad\nlabel" })] } },
      ],
    },
  };

  assert.deepEqual(loadMonitorRecordState(ctx), valid);
});

test("ignores record formats from before pi-monitors", () => {
  const ctx = {
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: "pi-events-records",
          data: { version: 1, active: [], recent: [record(1)], dismissed: [] },
        },
        {
          type: "custom",
          customType: "pi-monitor-events-records",
          data: { version: 2, active: [], initializedAdapters: [], recent: [record(1)], dismissed: [] },
        },
      ],
    },
  };

  assert.deepEqual(loadMonitorRecordState(ctx), {
    version: 1,
    active: [],
    recent: [],
    dismissed: [],
  });
});

test("normalizes recent records by monitor identity and bounds retention", () => {
  const records = Array.from({ length: MAX_RECENT_MONITORS + 3 }, (_, index) => record(index));
  records.push(record(2, { completedAt: "2026-08-04T22:00:00.000Z", status: "failed", health: "degraded" }));
  const dismissed = new Set([completionKey(record(4))]);

  const normalized = normalizeMonitorRecords(records, dismissed);

  assert.equal(normalized.length, MAX_RECENT_MONITORS);
  assert.equal(normalized[0].id, "monitor-2");
  assert.equal(normalized[0].status, "failed");
  assert.equal(normalized.some((candidate) => candidate.id === "monitor-4"), false);
});

test("rejects unbounded or active views before persistence", () => {
  assert.equal(toMonitorRecord(record(1, { label: "x".repeat(257) })), undefined);
  assert.equal(toMonitorRecord(record(1, { lifecycle: "active" })), undefined);
});
