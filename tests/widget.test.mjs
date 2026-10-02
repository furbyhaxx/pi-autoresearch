import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_WIDGET_SETTINGS,
  rankSecondaryByMovement,
  readWidgetSettings,
  renderDashboardLines,
  renderWidgetSummaryLine,
  selectDisplayMetrics,
  widgetHeightCeiling,
} from "../extensions/pi-autoresearch/index.ts";

/** Colors are irrelevant here; the assertions are about geometry. */
const TH = { fg: (_color, text) => String(text), bold: (text) => String(text) };

/** Mirrors a real run: 300 secondary metrics, as the reported case had. */
function bigRun(metricCount = 300) {
  const secondaryMetrics = Array.from({ length: metricCount }, (_, i) => ({
    name: `metric_${String(i).padStart(3, "0")}`,
    unit: "ms",
  }));
  const results = [
    { commit: "aaa", metric: 1, metrics: {}, status: "keep", description: "baseline", timestamp: 1, segment: 0, confidence: null },
    { commit: "bbb", metric: 900, metrics: {}, status: "keep", description: "better", timestamp: 2, segment: 0, confidence: 3 },
  ];
  return {
    results,
    bestMetric: 1,
    bestDirection: "higher",
    metricName: "e6_typed_top1",
    metricUnit: "",
    secondaryMetrics,
    name: "Evaluate the pi-trained head",
    currentSegment: 0,
    maxExperiments: null,
    confidence: 110276.4,
  };
}

function withMetrics(state) {
  state.results[0].metrics = Object.fromEntries(state.secondaryMetrics.map((m) => [m.name, 1]));
  state.results[1].metrics = Object.fromEntries(
    state.secondaryMetrics.map((m, i) => [m.name, i % 3 === 0 ? 500 : 1])
  );
  return state;
}

function strip(lines) {
  return lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
}

test("the default widget collapses to a single line regardless of metric count", () => {
  const state = withMetrics(bigRun());
  const line = renderWidgetSummaryLine(state, 120, TH, "speed-up-app");

  assert.equal(strip([line]).length, 1, "collapsed output is exactly one line");
  const text = line.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(text, /\[speed-up-app\]/);
  assert.match(text, /2 runs/);
  assert.match(text, /★ e6_typed_top1 900/);
  assert.doesNotMatch(text, /metric_000/, "no secondary metrics leak into the one-liner");
});

test("the one-liner degrades gracefully on a narrow terminal", () => {
  const state = withMetrics(bigRun());
  const wide = strip([renderWidgetSummaryLine(state, 200, TH, "x")])[0];
  const narrow = strip([renderWidgetSummaryLine(state, 40, TH, "x")])[0];

  assert.ok(narrow.length <= 40, `line respects the 40-col budget, got ${narrow.length}`);
  assert.ok(wide.length > narrow.length, "narrow really is more truncated");
  assert.ok(!narrow.includes("\n"));
});

test("the expanded widget honours its height ceiling with 300 metrics configured", () => {
  const state = withMetrics(bigRun());
  const settings = { ...DEFAULT_WIDGET_SETTINGS, collapsed: false, maxHeight: 8 };

  const lines = renderDashboardLines(state, 200, TH, 6, [], settings, 8);

  assert.ok(lines.length <= 8, `expected at most 8 lines, got ${lines.length}`);
  const text = strip(lines).join("\n");
  assert.match(text, /★ e6_typed_top1/, "the primary metric survives");
  assert.match(text, /metrics? — \/autoresearch dashboard/, "it says where the rest went");
});

test("a narrow terminal drops the metric block instead of fragmenting it", () => {
  const state = withMetrics(bigRun());
  const settings = { ...DEFAULT_WIDGET_SETTINGS, collapsed: false, metricsShown: 4 };

  const wide = strip(renderDashboardLines(state, 210, TH, 6, [], settings, 8));
  const phone = strip(renderDashboardLines(state, 46, TH, 6, [], settings, 8)).join("\n");

  assert.ok(wide.join("\n").includes("metric_"), "a wide terminal does show metrics");
  assert.ok(!phone.includes("metric_00"), "a 46-col phone shows no metric fragments");
  assert.match(phone, /300 metrics — \/autoresearch dashboard/, "it still says where they went");
});

test("the height ceiling binds the whole block, table included", () => {
  const state = withMetrics(bigRun());
  const settings = { ...DEFAULT_WIDGET_SETTINGS, collapsed: false, maxHeight: 6 };

  for (const ceiling of [3, 4, 5, 6, 8]) {
    const lines = renderDashboardLines(state, 210, TH, 6, [], settings, ceiling);
    assert.ok(lines.length <= ceiling, `ceiling ${ceiling} produced ${lines.length} lines`);
  }
});

test("height is capped by the terminal, not just by config", () => {
  const settings = { ...DEFAULT_WIDGET_SETTINGS, collapsed: false, maxHeight: 40 };

  assert.equal(widgetHeightCeiling(settings, 24), 8, "a 24-row phone window wins");
  assert.equal(widgetHeightCeiling(settings, 60), 20, "a 60-row terminal gets the thirds rule");
  assert.equal(widgetHeightCeiling(settings, 400), 40, "a tall terminal gets the configured ceiling");
  assert.equal(widgetHeightCeiling({ ...settings, collapsed: true }, 400), 1, "collapsed is one line");
});

test("auto mode shows movers, not the whole metric list", () => {
  const state = withMetrics(bigRun());
  const defs = state.secondaryMetrics;
  const current = state.results[1].metrics;
  const baseline = state.results[0].metrics;

  const shown = selectDisplayMetrics(defs, current, baseline, {
    ...DEFAULT_WIDGET_SETTINGS, metricMode: "auto", metricsShown: 4,
  });

  assert.equal(shown.length, 4, "exactly the configured number");
  // Every third metric moved 1 -> 500; those must be the ones chosen.
  const expected = defs.filter((_, i) => i % 3 === 0).map((d) => d.name).slice(0, 4);
  assert.deepEqual(shown.map((d) => d.name), expected, "picks the metrics that actually moved");
  assert.ok(shown.every((d) => current[d.name] === 500));
});

test("pinned mode follows the user's order and ignores movement", () => {
  const state = withMetrics(bigRun());
  const chosen = ["metric_007", "metric_001", "metric_300_missing"];
  const shown = selectDisplayMetrics(state.secondaryMetrics, state.results[1].metrics, state.results[0].metrics, {
    ...DEFAULT_WIDGET_SETTINGS, metricMode: "pinned", pinnedMetrics: chosen,
  });

  assert.deepEqual(shown.map((d) => d.name), ["metric_007", "metric_001"], "unknown names are dropped");
});

test("movement ranking is stable when scores tie", () => {
  const defs = [
    { name: "a", unit: "" }, { name: "b", unit: "" }, { name: "c", unit: "" },
  ];
  const ranked = rankSecondaryByMovement(defs, { a: 2, b: 2, c: 1 }, { a: 1, b: 1, c: 1 });
  assert.deepEqual(ranked.map((d) => d.name), ["a", "b"], "equal scores keep config order");
});

test("a metric that started at zero still counts as a move", () => {
  const defs = [{ name: "zeroed", unit: "" }, { name: "flat", unit: "" }];
  const ranked = rankSecondaryByMovement(defs, { zeroed: 3, flat: 0 }, { zeroed: 0, flat: 0 });
  assert.deepEqual(ranked.map((d) => d.name), ["zeroed"]);
});

test("verbose restores the pre-budget wall of metrics", () => {
  const state = withMetrics(bigRun());
  const settings = { ...DEFAULT_WIDGET_SETTINGS, collapsed: false, verbose: true };

  const lines = strip(renderDashboardLines(state, 200, TH, 6, [], settings, 8));

  assert.ok(lines.length > 8, `verbose ignores the ceiling, got ${lines.length} lines`);
  assert.ok(!lines.join("\n").includes("— /autoresearch dashboard"), "nothing is hidden, so nothing is announced");
});

test("widget settings come from config with sane fallbacks", () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-widget-"));
  mkdirSync(join(dir, ".auto"), { recursive: true });
  writeFileSync(join(dir, ".auto", "config.json"), JSON.stringify({
    widget: { collapsed: false, maxHeight: 12, metricsShown: 2, metricMode: "pinned", pinnedMetrics: ["x"] },
  }));

  const settings = readWidgetSettings(dir);
  assert.equal(settings.collapsed, false);
  assert.equal(settings.maxHeight, 12);
  assert.equal(settings.metricsShown, 2);
  assert.equal(settings.metricMode, "pinned");
  assert.deepEqual(settings.pinnedMetrics, ["x"]);
});

test("a missing or nonsense config still yields a usable widget", () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-widget-"));
  assert.deepEqual(readWidgetSettings(dir), DEFAULT_WIDGET_SETTINGS, "no config file");

  mkdirSync(join(dir, ".auto"), { recursive: true });
  writeFileSync(join(dir, ".auto", "config.json"), JSON.stringify({
    widget: { collapsed: "yes", maxHeight: -4, metricsShown: null, metricMode: "sideways", pinnedMetrics: "nope" },
  }));
  const settings = readWidgetSettings(dir);
  assert.equal(settings.collapsed, DEFAULT_WIDGET_SETTINGS.collapsed);
  assert.equal(settings.maxHeight, DEFAULT_WIDGET_SETTINGS.maxHeight);
  assert.equal(settings.metricMode, DEFAULT_WIDGET_SETTINGS.metricMode);
  assert.deepEqual(settings.pinnedMetrics, []);
});
