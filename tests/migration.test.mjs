import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import autoresearchExtension from "../extensions/pi-autoresearch/index.ts";
import { reconstructJsonlState } from "../extensions/pi-autoresearch/jsonl.ts";
import { adoptFlatState, findUnclaimedFlatState, nameFromFlatLog } from "../extensions/pi-autoresearch/paths.ts";
import { stampExperiment } from "../extensions/pi-autoresearch/jsonl.ts";

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ar-mig-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", ".");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, ".gitignore"), ".auto/\n");
  writeFileSync(join(dir, "app.py"), "print(1)\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return dir;
}

const CONFIG_HEADER = '{"type":"config","name":"JEV and CLM inspired","metricName":"top1","metricUnit":"","bestDirection":"higher"}';
const RUN = (i, status) =>
  JSON.stringify({ run: i + 1, commit: "c" + i, metric: i, status, description: "run " + i, timestamp: i, segment: 0, confidence: null });

/** The shape a pre-registry single-experiment run leaves behind. */
function seedFlatState(dir) {
  mkdirSync(join(dir, ".auto"), { recursive: true });
  writeFileSync(join(dir, ".auto", "log.jsonl"), [CONFIG_HEADER, RUN(1, "keep"), RUN(2, "discard"), RUN(3, "keep")].join("\n") + "\n");
  writeFileSync(join(dir, ".auto", "prompt.md"), "# goal\nmake it fast\n");
  writeFileSync(join(dir, ".auto", "measure.sh"), "#!/bin/bash\necho ok\n");
  writeFileSync(join(dir, ".auto", "config.json"), JSON.stringify({ maxIterations: 50 }));
  writeFileSync(join(dir, ".auto", "ideas.md"), "- try a thing\n");
  mkdirSync(join(dir, ".auto", "hooks"), { recursive: true });
  writeFileSync(join(dir, ".auto", "hooks", "before.sh"), "echo before\n");
}

function harness(dir) {
  const captured = {};
  const ctx = {
    cwd: dir,
    ui: {
      notify: (m) => { captured.notified = captured.notified ?? []; captured.notified.push(m); },
      setWidget() {}, setStatus() {},
      custom: async () => {},
      select: async () => undefined, confirm: async () => false, input: async () => undefined,
    },
    sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
    hasUI: true, isUI: true,
    isIdle: () => true, waitForIdle: async () => {},
    sendMessage: async () => {},
  };
  const pi = {
    on() {}, registerShortcut() {}, registerTool() {}, appendEntry() {},
    getActiveTools: () => [], setActiveTools() {}, getCommands: () => [],
    sendUserMessage() {},
    exec: async (command, args, opts = {}) => {
      try {
        return { code: 0, stdout: execFileSync(command, args, { cwd: opts.cwd, encoding: "utf8" }), stderr: "" };
      } catch (error) {
        return { code: error.status ?? 1, stdout: "", stderr: "" };
      }
    },
    registerCommand: (name, options) => { if (name === "autoresearch") captured.cmd = options; },
  };
  autoresearchExtension(pi);
  return { cmd: captured.cmd, ctx, captured };
}

test("flat state is detected before any experiment exists", () => {
  const dir = makeRepo();
  try {
    assert.equal(findUnclaimedFlatState(dir).length, 0, "an empty repo has nothing to adopt");
    seedFlatState(dir);
    assert.equal(findUnclaimedFlatState(dir).length, 6, "six files, including the hooks directory");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a repo that already has experiments is never re-adopted", () => {
  const dir = makeRepo();
  try {
    seedFlatState(dir);
    mkdirSync(join(dir, ".auto", "experiments", "other"), { recursive: true });
    assert.deepEqual(findUnclaimedFlatState(dir), [], "one experiment means the flat files are stale");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the registry and the worktree directory are never treated as adoptable state", () => {
  const dir = makeRepo();
  try {
    mkdirSync(join(dir, ".auto"), { recursive: true });
    writeFileSync(join(dir, ".auto", "experiments.json"), JSON.stringify({ version: 1, experiments: {} }));
    mkdirSync(join(dir, ".auto", "worktrees", "w"), { recursive: true });
    writeFileSync(join(dir, ".auto", "git.lock"), "{}");
    assert.deepEqual(findUnclaimedFlatState(dir), [], "only known state files move");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the migrated name is read from the run's own log", () => {
  const dir = makeRepo();
  try {
    assert.equal(nameFromFlatLog(dir), null, "no log, no name");
    seedFlatState(dir);
    assert.equal(nameFromFlatLog(dir), "JEV and CLM inspired");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a first use adopts a pre-registry run instead of orphaning it", async () => {
  const dir = makeRepo();
  try {
    seedFlatState(dir);
    const { cmd, ctx, captured } = harness(dir);

    await cmd.handler("speed up the model", ctx);

    assert.ok(
      captured.notified.some((m) => /Adopted 6 pre-existing state file/.test(m)),
      `expected an adoption notice, got ${JSON.stringify(captured.notified)}`
    );

    const registry = JSON.parse(readFileSync(join(dir, ".auto", "experiments.json"), "utf-8"));
    const id = Object.keys(registry.experiments)[0];
    assert.ok(id, "an experiment was created");

    const adoptedDir = join(dir, ".auto", "experiments", id);
    for (const file of ["log.jsonl", "prompt.md", "measure.sh", "config.json", "ideas.md", "hooks"]) {
      assert.ok(existsSync(join(adoptedDir, file)), `${file} was adopted`);
    }
    assert.ok(!existsSync(join(dir, ".auto", "log.jsonl")), "the old flat log is gone");
    assert.deepEqual(
      readdirSync(join(dir, ".auto")).sort(),
      ["experiments", "experiments.json"],
      ".auto/ is left holding only the registry and the experiments tree"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the adopted history actually reads back", async () => {
  const dir = makeRepo();
  try {
    seedFlatState(dir);
    const { cmd, ctx } = harness(dir);
    await cmd.handler("speed up the model", ctx);

    const registry = JSON.parse(readFileSync(join(dir, ".auto", "experiments.json"), "utf-8"));
    const id = Object.keys(registry.experiments)[0];
    const content = readFileSync(join(dir, ".auto", "experiments", id, "log.jsonl"), "utf-8");

    const state = reconstructJsonlState(content, id);
    assert.equal(state.results.length, 3, "three runs, not zero");
    assert.equal(state.metricName, "top1");
    assert.equal(state.bestDirection, "higher");
    assert.equal(state.name, "JEV and CLM inspired");

    // Stamping must not weaken the default-deny rule for other sessions.
    assert.equal(reconstructJsonlState(content, null).results.length, 0, "an unbound session sees nothing");
    assert.equal(reconstructJsonlState(content, "someone-else").results.length, 0, "nor does a sibling");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the experiment id follows the directory so it stays short and stable", async () => {
  const dir = makeRepo();
  try {
    seedFlatState(dir);
    const { cmd, ctx } = harness(dir);
    await cmd.handler("speed up the model", ctx);

    const registry = JSON.parse(readFileSync(join(dir, ".auto", "experiments.json"), "utf-8"));
    const [id] = Object.keys(registry.experiments);
    // The display name comes from the log, the id from the directory.
    assert.equal(registry.experiments[id].name, "JEV and CLM inspired");
    assert.equal(id, dir.split("/").pop().toLowerCase().replace(/[^a-z0-9]+/g, "-"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a second session starts its own experiment and never re-adopts", async () => {
  const dir = makeRepo();
  try {
    seedFlatState(dir);
    const first = harness(dir);
    await first.cmd.handler("speed up the model", first.ctx);

    const registry1 = JSON.parse(readFileSync(join(dir, ".auto", "experiments.json"), "utf-8"));
    const [firstId] = Object.keys(registry1.experiments);
    const firstLog = readFileSync(join(dir, ".auto", "experiments", firstId, "log.jsonl"), "utf-8");

    const second = harness(dir);
    await second.cmd.handler("keep going", second.ctx);

    const registry2 = JSON.parse(readFileSync(join(dir, ".auto", "experiments.json"), "utf-8"));
    const ids = Object.keys(registry2.experiments);
    assert.equal(ids.length, 2, "shared-mode sessions each get their own experiment");
    assert.ok(!second.captured.notified.some((m) => /Adopted/.test(m)), "no second adoption");
    assert.equal(
      readFileSync(join(dir, ".auto", "experiments", firstId, "log.jsonl"), "utf-8"),
      firstLog,
      "the first experiment's log is untouched"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the legacy autoresearch.* filenames are migrated too", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "autoresearch.jsonl"), [CONFIG_HEADER, RUN(1, "keep")].join("\n") + "\n");
    writeFileSync(join(dir, "autoresearch.md"), "# old prompt\n");
    mkdirSync(join(dir, "autoresearch.hooks"), { recursive: true });
    writeFileSync(join(dir, "autoresearch.hooks", "before.sh"), "echo hi\n");

    assert.equal(findUnclaimedFlatState(dir).length, 3);
    assert.equal(nameFromFlatLog(dir), "JEV and CLM inspired");

    adoptFlatState(dir, "old-run");
    assert.ok(existsSync(join(dir, ".auto", "experiments", "old-run", "log.jsonl")));
    assert.ok(existsSync(join(dir, ".auto", "experiments", "old-run", "prompt.md")));
    assert.ok(existsSync(join(dir, ".auto", "experiments", "old-run", "hooks", "before.sh")));
    assert.ok(!existsSync(join(dir, "autoresearch.jsonl")));
    assert.ok(!existsSync(join(dir, "autoresearch.hooks")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a real run's whole log survives adoption byte for byte apart from the stamp", async () => {
  const dir = makeRepo();
  try {
    seedFlatState(dir);
    const original = readFileSync(join(dir, ".auto", "log.jsonl"), "utf-8");

    adoptFlatState(dir, "big");
    stampExperiment(join(dir, ".auto", "experiments", "big", "log.jsonl"), "big");
    const migrated = readFileSync(join(dir, ".auto", "experiments", "big", "log.jsonl"), "utf-8");

    const originalEntries = original.trim().split("\n").map((l) => JSON.parse(l));
    const migratedEntries = migrated.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(migratedEntries.length, originalEntries.length);
    for (const [i, entry] of originalEntries.entries()) {
      const { experiment, ...rest } = migratedEntries[i];
      assert.equal(experiment, "big", "each entry is stamped");
      assert.deepEqual(rest, entry, "nothing else changed");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a real 400KB log migrates intact", async () => {
  const source = join(process.env.HOME, "Projects/furbyhaxx/experiments/jev-and-clm-inspired");
  if (!existsSync(join(source, ".auto", "log.jsonl"))) return;

  const dir = makeRepo();
  try {
    mkdirSync(join(dir, ".auto"), { recursive: true });
    cpSync(join(source, ".auto", "log.jsonl"), join(dir, ".auto", "log.jsonl"));
    const before = readFileSync(join(dir, ".auto", "log.jsonl"), "utf-8").trim().split("\n").length;

    const { cmd, ctx } = harness(dir);
    await cmd.handler("resume", ctx);

    const registry = JSON.parse(readFileSync(join(dir, ".auto", "experiments.json"), "utf-8"));
    const [id] = Object.keys(registry.experiments);
    const after = readFileSync(join(dir, ".auto", "experiments", id, "log.jsonl"), "utf-8");

    assert.equal(after.trim().split("\n").length, before, "every line survives");
    assert.ok(before > 50, `the real log is substantial, got ${before} lines`);
    assert.ok(
      after.length >= readFileSync(join(source, ".auto", "log.jsonl"), "utf-8").length,
      "and it did not shrink"
    );

    const state = reconstructJsonlState(after, id);
    assert.ok(state.results.length > 0, "the run's history is readable again");
    assert.ok(state.name && state.name.length > 0, "and it kept its name");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
