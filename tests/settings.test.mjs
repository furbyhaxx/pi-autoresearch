import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import autoresearchExtension from "../extensions/pi-autoresearch/index.ts";

const THEME = { fg: (_c, t) => String(t), bold: (t) => String(t) };

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ar-set-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", ".");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, ".gitignore"), ".auto/\n");
  writeFileSync(join(dir, "a.txt"), "x\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return dir;
}

function harness(dir) {
  const captured = {};
  const ctx = {
    cwd: dir,
    ui: {
      notify: (message, type) => { captured.notified = captured.notified ?? []; captured.notified.push([type, message]); },
      setWidget: () => {},
      setStatus: () => {},
      custom: async (factory, options) => { captured.factory = factory; captured.options = options; },
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
    },
    sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
    hasUI: true,
    isUI: true,
    sendMessage: async () => {},
  };
  const pi = {
    on() {}, registerShortcut() {}, registerTool() {}, appendEntry() {},
    exec: async (command, args, opts = {}) => {
      try {
        return { code: 0, stdout: execFileSync(command, args, { cwd: opts.cwd, encoding: "utf8" }), stderr: "" };
      } catch (error) {
        return { code: error.status ?? 1, stdout: "", stderr: "" };
      }
    },
    registerCommand: (name, options) => { captured.command = options; },
  };
  autoresearchExtension(pi);
  return { cmd: captured.command, ctx, captured };
}

const configOf = (dir) => {
  const path = join(dir, ".auto", "config.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : null;
};

test("/autoresearch settings opens an interactive editor", async () => {
  const dir = makeRepo();
  try {
    const { cmd, ctx, captured } = harness(dir);
    await cmd.handler("settings", ctx);

    assert.equal(typeof captured.factory, "function", "an editor component is built");
    assert.ok(captured.options?.overlay, "it is a fullscreen overlay, so it can take mouse input");

    const tui = { requestRender() {} };
    let closed = false;
    const component = await captured.factory(tui, THEME, {}, () => { closed = true; });

    const text = component.render(60).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
    assert.match(text, /autoresearch settings/);
    assert.match(text, /Collapsed by default/);
    assert.match(text, /Max height/);
    assert.match(text, /Metrics shown/);
    assert.match(text, /Metric choice/);
    assert.match(text, /Verbose/);
    assert.match(text, /esc close/, "the keys are discoverable");

    component.handleInput("\x1b");
    assert.equal(closed, true, "escape closes it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toggling a setting persists it to the experiment config", async () => {
  const dir = makeRepo();
  try {
    const { cmd, ctx, captured } = harness(dir);
    await cmd.handler("settings", ctx);
    const tui = { requestRender() {} };
    const component = await captured.factory(tui, THEME, {}, () => {});

    // Row 0 is "Collapsed by default", which starts on.
    component.handleInput("\r");
    const after = configOf(dir);
    assert.ok(after, "config.json was written");
    assert.equal(after.widget.collapsed, false, "the toggle actually changed the value");

    // Move to "Max height" and bump it twice.
    component.handleInput("[B");
    component.handleInput("\r");
    component.handleInput("\r");
    assert.equal(configOf(dir).widget.maxHeight, 10, "default 8 plus two presses");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settings never clobber the rest of config.json", async () => {
  const dir = makeRepo();
  try {
    mkdirSync(join(dir, ".auto"), { recursive: true });
    writeFileSync(
      join(dir, ".auto", "config.json"),
      JSON.stringify({ maxIterations: 42, workingDir: dir, widget: { collapsed: true } })
    );

    const { cmd, ctx, captured } = harness(dir);
    await cmd.handler("settings", ctx);
    const component = await captured.factory({ requestRender() {} }, THEME, {}, () => {});
    component.handleInput("\r");

    const after = configOf(dir);
    assert.equal(after.maxIterations, 42, "maxIterations survives");
    assert.equal(after.workingDir, dir, "workingDir survives");
    assert.equal(after.widget.collapsed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clicking a row in the settings editor toggles that row", async () => {
  const dir = makeRepo();
  try {
    const { cmd, ctx, captured } = harness(dir);
    await cmd.handler("settings", ctx);
    const component = await captured.factory({ requestRender() {} }, THEME, {}, () => {});

    // Border, title, then the rows. Row 2 is "Metric choice".
    const result = component.handleMouse({ type: "click", button: "left", y: 5, x: 4 });
    assert.equal(result.handled, true, "the click is consumed");
    assert.equal(configOf(dir).widget.metricMode, "pinned", "auto advanced to pinned");

    // A click outside any row is left alone.
    const miss = component.handleMouse({ type: "click", button: "left", y: 99, x: 4 });
    assert.equal(miss.handled, undefined, "no row, no handling");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed config is replaced rather than crashing the editor", async () => {
  const dir = makeRepo();
  try {
    mkdirSync(join(dir, ".auto"), { recursive: true });
    writeFileSync(join(dir, ".auto", "config.json"), "{ not json");

    const { cmd, ctx, captured } = harness(dir);
    await cmd.handler("settings", ctx);
    const component = await captured.factory({ requestRender() {} }, THEME, {}, () => {});

    assert.ok(component.render(60).length > 0, "the editor still renders");
    component.handleInput("\r");
    assert.equal(configOf(dir).widget.collapsed, false, "and still saves");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
