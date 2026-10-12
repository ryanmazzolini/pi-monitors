import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createMonitorUi, MonitorOverlayComponent } from "./ui.ts";

const theme = {
  bg: (_color, text) => text,
  bold: (text) => text,
  fg: (_color, text) => text,
};

function view(overrides = {}) {
  return {
    id: "monitor-1",
    kind: "test",
    label: "widgets@abc12345",
    lifecycle: "active",
    health: "healthy",
    attentionCount: 0,
    status: "2/3 jobs",
    detail: ["Target: test", "Revision: abc12345"],
    ...overrides,
  };
}

function fixture(snapshot, rows = 30) {
  let current = snapshot;
  let listener;
  const calls = [];
  const runtime = {
    snapshot: () => current,
    subscribe(nextListener) {
      listener = nextListener;
      return () => { listener = undefined; };
    },
    async refresh() { calls.push("refresh"); },
    async stop(id) {
      calls.push(`stop:${id}`);
      current = {
        ...current,
        summary: { ...current.summary, active: 0 },
        active: [],
      };
      listener?.();
    },
    dismiss(id) {
      calls.push(`dismiss:${id}`);
      current = {
        ...current,
        summary: { ...current.summary, recent: current.summary.recent - 1 },
        recent: current.recent.filter((monitor) => monitor.id !== id),
      };
      listener?.();
    },
  };
  let renders = 0;
  let closes = 0;
  const component = new MonitorOverlayComponent(
    runtime,
    { requestRender() { renders++; }, terminal: { rows } },
    theme,
    () => { closes++; },
  );
  return { calls, component, get closes() { return closes; }, get renders() { return renders; } };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("renders active and recent monitor sections with bounded detail", () => {
  const active = view();
  const recent = view({
    id: "monitor-2",
    label: "older@def67890",
    lifecycle: "completed",
    status: "succeeded",
    completedAt: "2026-08-03T22:00:00.000Z",
  });
  const subject = fixture({
    generatedAt: "2026-08-03T22:01:00.000Z",
    summary: { active: 1, degraded: 0, attention: 0, recent: 1 },
    active: [active],
    recent: [recent],
  });

  const listLines = subject.component.render(100);
  const list = listLines.join("\n");
  assert.match(list, /Monitors · 1 active · 1 recent/);
  assert.match(list, /ACTIVE/);
  assert.match(list, /widgets@abc12345 · 2\/3 jobs/);
  assert.match(list, /RECENT/);
  assert.match(list, /older@def67890 · succeeded/);
  assert.match(list, /s stop/);
  assert.doesNotMatch(list, /d dismiss/);
  assert.equal(listLines.length, 10);

  subject.component.handleInput("\r");
  const detailLines = subject.component.render(80);
  const detail = detailLines.join("\n");
  assert.match(detail, /Target: test/);
  assert.match(detail, /Revision: abc12345/);
  assert.match(detail, /q\/Esc monitors/);
  assert.equal(detailLines.length, 7);
  subject.component.dispose();
});

test("uses the minimum content height within width-safe terminal budgets", () => {
  const snapshot = {
    generatedAt: "2026-08-03T22:01:00.000Z",
    summary: { active: 1, degraded: 0, attention: 0, recent: 0 },
    active: [view()],
    recent: [],
  };

  for (const rows of [1, 2, 4, 24, 40]) {
    const subject = fixture(snapshot, rows);
    for (const width of [1, 2, 20, 54, 100]) {
      const lines = subject.component.render(width);
      assert.equal(lines.length, Math.min(10, Math.max(1, Math.floor(rows * 0.85))));
      assert.equal(lines.every((line) => visibleWidth(line) <= width), true);
    }
    subject.component.dispose();
  }

  const narrow = fixture(snapshot).component.render(20).join("\n");
  assert.match(narrow, /q\/Esc close/);

  const empty = fixture({
    generatedAt: "2026-08-03T22:01:00.000Z",
    summary: { active: 0, degraded: 0, attention: 0, recent: 0 },
    active: [],
    recent: [],
  }).component.render(100).join("\n");
  assert.match(empty, /ACTIVE MONITORS/);
  assert.match(empty, /No active monitors\./);
  assert.match(empty, /RECENT OUTCOMES/);
  assert.match(empty, /No recent outcomes\./);
});

test("opens the minimal monitor panel beside the input area", async () => {
  let overlayOptions;
  const runtime = {
    snapshot: () => ({
      generatedAt: "2026-08-03T22:01:00.000Z",
      summary: { active: 0, degraded: 0, attention: 0, recent: 0 },
      active: [],
      recent: [],
    }),
    subscribe: () => () => {},
  };
  await createMonitorUi(runtime).open({
    mode: "tui",
    ui: {
      async custom(factory, options) {
        overlayOptions = options.overlayOptions;
        factory({ requestRender() {}, terminal: { rows: 30 } }, theme, {}, () => {});
      },
    },
  });

  assert.equal(overlayOptions.anchor, "bottom-center");
  assert.equal(overlayOptions.maxHeight, "85%");
});

test("dismisses only the selected recent row when active and recent IDs collide", () => {
  const subject = fixture({
    generatedAt: "2026-08-03T22:01:00.000Z",
    summary: { active: 1, degraded: 0, attention: 0, recent: 1 },
    active: [view()],
    recent: [view({ id: "monitor-1", label: "Recent monitor", lifecycle: "completed", completedAt: "2026-08-03T22:00:00.000Z" })],
  });

  subject.component.handleInput("d");
  assert.deepEqual(subject.calls, []);
  subject.component.handleInput("j");
  const recentSelection = subject.component.render(80).join("\n");
  assert.match(recentSelection, /d dismiss/);
  assert.doesNotMatch(recentSelection, /s stop/);
  subject.component.handleInput("d");

  assert.deepEqual(subject.calls, ["dismiss:monitor-1"]);
  assert.doesNotMatch(subject.component.render(80).join("\n"), /Recent monitor/);
  subject.component.dispose();
});

test("refreshes, stops the selected active monitor, and closes idempotently", async () => {
  const subject = fixture({
    generatedAt: "2026-08-03T22:01:00.000Z",
    summary: { active: 1, degraded: 0, attention: 0, recent: 0 },
    active: [view()],
    recent: [],
  });

  subject.component.handleInput("r");
  await settle();
  subject.component.handleInput("s");
  await settle();
  subject.component.handleInput("q");
  subject.component.handleInput("q");

  assert.deepEqual(subject.calls, ["refresh", "stop:monitor-1"]);
  assert.equal(subject.closes, 2);
  assert.ok(subject.renders >= 4);
  subject.component.dispose();
});
