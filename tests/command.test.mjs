import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import autoresearchExtension from "../extensions/pi-autoresearch/index.ts";

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ar-cmd-"));
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

function seedExperiments(dir, records) {
  mkdirSync(join(dir, ".auto"), { recursive: true });
  writeFileSync(
    join(dir, ".auto", "experiments.json"),
    JSON.stringify({
      version: 1,
      experiments: records.map((r) => ({
        branch: null, baselineHead: null, baselineDirty: [], claimedPaths: [], resultCount: 0, ...r,
      })),
    })
  );
}

/** `pi.exec` really runs git, because the registry is only found through it. */
function harness(dir) {
  const registered = new Map();
  const ctx = {
    cwd: dir,
    ui: {
      notify() {}, setWidget() {}, setStatus() {},
      select: async () => undefined, confirm: async () => false, input: async () => undefined,
    },
    sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
    hasUI: true, isUI: true, sendMessage: async () => {},
  };
  const pi = {
    on() {}, registerShortcut() {}, registerTool() {},
    exec: async (command, args, opts = {}) => {
      try {
        const stdout = execFileSync(command, args, {
          cwd: opts.cwd, encoding: "utf8", timeout: opts.timeout ?? 10_000,
        });
        return { code: 0, stdout, stderr: "" };
      } catch (error) {
        return {
          code: typeof error.status === "number" ? error.status : 1,
          stdout: error.stdout?.toString?.() ?? "",
          stderr: error.stderr?.toString?.() ?? "",
        };
      }
    },
    registerCommand: (name, options) => registered.set(name, options),
  };
  autoresearchExtension(pi);
  return { cmd: registered.get("autoresearch"), ctx };
}

const inDir = (dir, fn) => {
  const prior = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(prior);
  }
};

test("an empty prefix offers every subcommand", async () => {
  const dir = makeRepo();
  try {
    seedExperiments(dir, [{ id: "speed-up-app", name: "Speed up app", mode: "worktree" }]);
    const { cmd } = harness(dir);

    const values = (await cmd.getArgumentCompletions("")).map((i) => i.value);
    for (const expected of ["list", "new", "join", "drop", "dashboard", "export", "clear", "settings", "off"]) {
      assert.ok(values.includes(expected), `expected "${expected}" in ${values.join(", ")}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every advertised subcommand is one the handler actually accepts", async () => {
  const dir = makeRepo();
  try {
    const { cmd } = harness(dir);
    const source = readFileSync(new URL("../extensions/pi-autoresearch/index.ts", import.meta.url), "utf-8");

    // The completion list drifted from the dispatch chain once already, so
    // pin the two together: anything offered must be handled, and the
    // single-word subcommands handled must be offered.
    const offered = (await cmd.getArgumentCompletions("")).map((i) => i.value);
    const handled = [...source.matchAll(/command === "([a-z]+)"/g)].map((m) => m[1]);
    const unique = [...new Set(handled)].filter((h) => h !== "ls" && h !== "config");

    for (const name of unique) {
      assert.ok(offered.includes(name), `"${name}" is handled but not offered in completion`);
    }
    for (const name of ["settings"]) {
      assert.ok(unique.includes(name), `"${name}" is offered but the handler does not check for it`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a partial subcommand filters the list", async () => {
  const dir = makeRepo();
  try {
    const { cmd } = harness(dir);
    const values = (await cmd.getArgumentCompletions("d")).map((i) => i.value);
    assert.deepEqual(values, ["drop", "dashboard"]);
    assert.deepEqual((await cmd.getArgumentCompletions("dash")).map((i) => i.value), ["dashboard"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("join and drop complete live experiment ids from the registry", async () => {
  const dir = makeRepo();
  try {
    seedExperiments(dir, [
      { id: "speed-up-app", name: "Speed up app", mode: "worktree", resultCount: 12 },
      { id: "embedding-v2", name: "Better embeddings", mode: "shared", resultCount: 0 },
    ]);
    const { cmd } = harness(dir);

    const items = await inDir(dir, () => cmd.getArgumentCompletions("join "));
    assert.deepEqual(items.map((i) => i.value), ["speed-up-app", "embedding-v2"]);
    assert.match(items[0].description, /worktree/);
    assert.match(items[0].description, /Speed up app/);
    assert.match(items[0].description, /12 results/);
    assert.match(items[1].description, /no results yet/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an experiment id prefix narrows the completion", async () => {
  const dir = makeRepo();
  try {
    seedExperiments(dir, [
      { id: "speed-up-app", mode: "worktree" },
      { id: "embedding-v2", mode: "shared" },
      { id: "embedding-v3", mode: "shared" },
    ]);
    const { cmd } = harness(dir);

    const items = await inDir(dir, () => cmd.getArgumentCompletions("drop embedding-v"));
    assert.deepEqual(items.map((i) => i.value), ["embedding-v2", "embedding-v3"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("new offers the shared flag once a flag has been started", async () => {
  const dir = makeRepo();
  try {
    const { cmd } = harness(dir);
    const items = await cmd.getArgumentCompletions("new my-exp -");
    assert.deepEqual(items.map((i) => i.value), ["--shared"]);
    assert.match(items[0].description, /checkout/, "the default is explained");
    assert.equal(await cmd.getArgumentCompletions("new my-exp"), null, "a name takes free text");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an argument that takes free text offers nothing", async () => {
  const dir = makeRepo();
  try {
    const { cmd } = harness(dir);
    assert.equal(await cmd.getArgumentCompletions("my own free text goal"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
