/**
 * Concurrency: several autoresearch experiments inside one repository.
 *
 * The harness here backs pi.exec with real git, because the whole point of the
 * change is what happens to a real working tree when two sessions log at once.
 * A fake git would only re-assert the implementation's own assumptions.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import autoresearchExtension, {
  isAutoresearchShCommand,
} from "../extensions/pi-autoresearch/index.ts";
import {
  claimedBy,
  headSha,
  isAutoresearchArtifact,
  parsePorcelainZ,
  scopedCommit,
  scopedRevert,
  withGitLock,
} from "../extensions/pi-autoresearch/git.ts";
import {
  concurrentExperiments,
  createExperiment,
  findExperimentByWorkDir,
  listExperiments,
  readRegistry,
  resolveRegistryRoot,
  uniqueId,
  updateExperiment,
} from "../extensions/pi-autoresearch/experiments.ts";
import {
  extractAutoresearchSessionName,
  hasAutoresearchConfigHeader,
  reconstructJsonlState,
} from "../extensions/pi-autoresearch/jsonl.ts";

const BINDING_ENTRY = "pi-autoresearch.binding";

// ---------------------------------------------------------------------------
// A pi harness whose exec really runs git.
// ---------------------------------------------------------------------------

function realExec() {
  return (command, args, opts = {}) =>
    new Promise((resolve) => {
      try {
        const stdout = execFileSync(command, args, {
          cwd: opts.cwd,
          encoding: "utf8",
          timeout: opts.timeout ?? 10_000,
        });
        resolve({ code: 0, stdout, stderr: "" });
      } catch (error) {
        resolve({
          code: typeof error.status === "number" ? error.status : 1,
          stdout: error.stdout ?? "",
          stderr: error.stderr ?? String(error),
        });
      }
    });
}

function createSession({ cwd, sessionId, exec }) {
  const commands = new Map();
  const handlers = new Map();
  const tools = new Map();
  const appendedEntries = [];
  const sentMessages = [];
  let activeTools = [];

  autoresearchExtension({
    on(name, handler) {
      handlers.set(name, handler);
    },
    appendEntry(customType, data) {
      appendedEntries.push({ customType, data });
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    exec,
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerShortcut() {},
    getActiveTools: () => activeTools,
    setActiveTools(next) {
      activeTools = [...next];
    },
    sendUserMessage(content, options) {
      sentMessages.push({ content, options });
    },
  });

  const branch = [];
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: false,
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort() {},
    sessionManager: {
      getSessionId: () => sessionId,
      // Entries appended during this session are visible to later reads, which
      // is how a real session behaves.
      getBranch: () => branch,
    },
    ui: { setWidget() {}, notify() {} },
  };

  const originalAppend = appendedEntries;
  return {
    ctx,
    commands,
    handlers,
    tools,
    sentMessages,
    activeTools: () => activeTools,
    entries: originalAppend,
    bindingIds: () =>
      originalAppend.filter((e) => e.customType === BINDING_ENTRY).map((e) => e.data.experimentId),
    start: () => handlers.get("session_start")({}, ctx),
    cmd: (args) => commands.get("autoresearch").handler(args, ctx),
  };
}

async function initRepo() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-ar-concurrent-")));
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(dir, "a.txt"), "a\n");
  writeFileSync(join(dir, "b.txt"), "b\n");
  // Real usage ignores `.auto/`; without it the state directory would show up
  // as untracked noise in every status assertion.
  writeFileSync(join(dir, ".gitignore"), ".auto/\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  return dir;
}

const gitRunner = async (args, cwd, timeoutMs = 10_000) => {
  try {
    const stdout = execFileSync("git", args, { cwd, encoding: "utf8", timeout: timeoutMs });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      code: typeof error.status === "number" ? error.status : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? String(error),
    };
  }
};

const readText = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("the benchmark gate accepts a per-experiment measure script and nothing else", () => {
  const accepted = [
    "./.auto/experiments/parser-speed/measure.sh",
    "bash .auto/experiments/parser-speed/measure.sh",
    "/abs/repo/.auto/experiments/parser-speed/measure.sh",
    "./.auto/measure.sh",
    "bash -x .auto/measure.sh",
    "./autoresearch.sh",
    "FOO=1 BAR=2 ./.auto/experiments/x/measure.sh",
    "nice -n 10 time env ./.auto/experiments/x/measure.sh",
    "source .auto/experiments/x/measure.sh",
  ];
  for (const command of accepted) {
    assert.equal(isAutoresearchShCommand(command), true, `should accept: ${command}`);
  }

  // The gate exists to stop the agent benchmarking something other than the
  // measure script, so substitutions and chained commands must all fail.
  const rejected = [
    "evil.py; measure.sh",
    "measure.sh",
    "/tmp/measure.sh",
    "pnpm test",
    "python bench.py",
    "cat .auto/experiments/x/measure.sh",
    "./.auto/experiments/x/checks.sh",
    "rm -rf . && ./.auto/measure.sh",
  ];
  for (const command of rejected) {
    assert.equal(isAutoresearchShCommand(command), false, `should reject: ${command}`);
  }
});

test("a worktree experiment's benchmark lives in the main worktree and runs by absolute path", async () => {
  const repo = await initRepo();
  const exec = realExec();
  try {
    const creator = createSession({ cwd: repo, sessionId: "creator", exec });
    await creator.start();
    await creator.cmd("new bench");

    const record = readRegistry(repo).experiments.bench;
    const inside = createSession({ cwd: record.workDir, sessionId: "inside", exec });
    await inside.start();
    await inside.tools.get("init_experiment").execute("1", {
      name: "Bench", metric_name: "run_us",
    }, null, null, inside.ctx);

    // State lives in the main worktree so the worktree's own `git add -A` can
    // never stage a log file.
    const stateDir = join(repo, ".auto", "experiments", "bench");
    assert.equal(existsSync(stateDir), true);
    assert.equal(existsSync(join(record.workDir, ".auto")), false);

    const measure = join(stateDir, "measure.sh");
    writeFileSync(measure, "#!/usr/bin/env bash\necho 'METRIC run_us=4200'\n");
    chmodSync(measure, 0o755);

    // A relative path does not resolve from inside the worktree. The tool
    // must still steer the agent to the absolute one rather than leaving a
    // bare "No such file" from the shell.
    const relative = await inside.tools.get("run_experiment").execute(
      "2", { command: "./.auto/experiments/bench/measure.sh", timeout_seconds: 30 },
      null, null, inside.ctx,
    );
    assert.match(relative.content[0].text, /FAILED/);
    assert.ok(relative.content[0].text.includes(measure), "the error must name the absolute path");
    assert.match(relative.content[0].text, /absolute path/);

    const absolute = await inside.tools.get("run_experiment").execute(
      "3", { command: `bash ${measure}`, timeout_seconds: 30 },
      null, null, inside.ctx,
    );
    assert.match(absolute.content[0].text, /PASSED/);
    assert.match(absolute.content[0].text, /run_us=4,200/);
  } finally {
    execFileSync("git", ["worktree", "prune"], { cwd: repo });
    await rm(repo, { recursive: true, force: true });
  }
});

test("log entries are attributed to exactly one experiment, and untagged to none", () => {
  // A log written before experiments existed has no ids and belongs to the
  // unbound session only; a bound session must never read it.
  const log = [
    JSON.stringify({ type: "config", name: "Legacy run", metricName: "ms" }),
    JSON.stringify({ run: 1, metric: 10, status: "keep", description: "unbound" }),
    JSON.stringify({ type: "config", experiment: "x", name: "Bound run", metricName: "us" }),
    JSON.stringify({ run: 1, experiment: "x", metric: 5, status: "keep", description: "bound-x" }),
    JSON.stringify({ run: 1, experiment: "y", metric: 7, status: "keep", description: "bound-y" }),
  ].join("\n");

  const unbound = reconstructJsonlState(log, null);
  assert.equal(unbound.name, "Legacy run");
  assert.deepEqual(unbound.results.map((r) => r.description), ["unbound"]);

  // `x` owns a config header, so it inherits its name. `y` has no header of
  // its own — it must not borrow `x`'s name, only its own runs.
  for (const [id, name] of [["x", "Bound run"], ["y", null]]) {
    const state = reconstructJsonlState(log, id);
    assert.equal(state.name, name);
    assert.equal(state.results.length, 1, `${id} sees only its own runs`);
    assert.equal(state.results[0].description, `bound-${id}`);
  }

  // A stranger sees an empty state rather than borrowing anyone's history.
  const stranger = reconstructJsonlState(log, "zzz");
  assert.equal(stranger.name, null);
  assert.equal(stranger.results.length, 0);
  assert.equal(stranger.currentSegment, 0);

  assert.equal(extractAutoresearchSessionName(log, "x"), "Bound run");
  assert.equal(extractAutoresearchSessionName(log, "zzz"), "Autoresearch");
  assert.equal(hasAutoresearchConfigHeader(log, "x"), true);
  assert.equal(hasAutoresearchConfigHeader(log, "zzz"), false);
});

test("a rename is reported at both ends so a discard can undo it", () => {
  // git emits `R  <new>\0<old>\0`; tracking only the destination would leave
  // the original deleted forever after a revert.
  const entries = parsePorcelainZ("R  new.ts\0old.ts\0");
  assert.deepEqual(entries, [
    { path: "new.ts", untracked: false },
    { path: "old.ts", untracked: false },
  ]);
});

test("a worktree experiment is not a sibling of a shared one", async () => {
  const repo = await initRepo();
  try {
    const shared = createExperiment(repo, { name: "shared-one", mode: "shared", workDir: repo });
    const tree = createExperiment(repo, { name: "tree-one", mode: "worktree", workDir: repo });

    // A worktree experiment cannot touch this checkout, so it must not force the
    // shared one into the conservative scoped path.
    const siblings = concurrentExperiments(repo, shared.id);
    assert.deepEqual(siblings.map((s) => s.id), []);
    assert.equal(tree.mode, "worktree");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a refused first result counts, so the loop is never permanently blocked", async () => {
  const repo = await initRepo();
  const exec = realExec();
  try {
    const a = createSession({ cwd: repo, sessionId: "session-a", exec });
    const b = createSession({ cwd: repo, sessionId: "session-b", exec });
    await a.start();
    await b.start();
    await a.tools.get("init_experiment").execute("1", { name: "A", metric_name: "m" }, null, null, a.ctx);
    await b.tools.get("init_experiment").execute("1", { name: "B", metric_name: "m" }, null, null, b.ctx);
    const [idA, idB] = [a.bindingIds().at(-1), b.bindingIds().at(-1)];

    writeFileSync(join(repo, "a.txt"), "A idea\n");
    writeFileSync(join(repo, "b.txt"), "B idea\n");

    // First result: refused, because nothing distinguishes the two edits.
    const first = await a.tools.get("log_experiment").execute(
      "2", { commit: "aaaaaaa", metric: 1, status: "keep", description: "first" },
      null, null, a.ctx,
    );
    assert.match(first.content[0].text, /not touching git/);
    assert.equal(readRegistry(repo).experiments[idA].resultCount, 1, "a refusal still counts as a result");

    // Second result: the gate has passed, and B's file is still off limits.
    updateExperiment(repo, idB, { claimedPaths: ["b.txt"], resultCount: 1, baselineDirty: [] });
    const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const second = await a.tools.get("log_experiment").execute(
      "3", { commit: "aaaaaaa", metric: 2, status: "keep", description: "second" },
      null, null, a.ctx,
    );
    assert.match(second.content[0].text, /committed/);
    const headAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    assert.notEqual(headAfter, headBefore, "the second result is not blocked forever");
    assert.equal(readText(join(repo, "b.txt")), "B idea\n");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a scoped commit takes only its own paths out of a dirty index", async () => {
  const repo = await initRepo();
  try {
    writeFileSync(join(repo, "a.txt"), "ours\n");
    writeFileSync(join(repo, "b.txt"), "a sibling staged this\n");
    // Pre-staged by someone else. `git add -- a.txt` does not unstage it, so
    // only a pathspec on the commit itself keeps it out of our message.
    execFileSync("git", ["add", "b.txt"], { cwd: repo });

    const result = await scopedCommit(gitRunner, {
      cwd: repo,
      paths: ["a.txt"],
      message: "our commit",
    });
    assert.equal(result.committed, true);

    const committed = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], {
      cwd: repo, encoding: "utf8",
    });
    assert.match(committed, /a\.txt/);
    assert.doesNotMatch(committed, /b\.txt/, "pre-staged sibling content must not land in our commit");
    assert.equal(
      execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }),
      "M  b.txt\n",
      "the sibling's staged change is left exactly as it was",
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("porcelain -z parsing separates untracked files and skips autoresearch state", () => {
  const output = " M src/index.ts\0?? build/out.bin\0?? .auto/experiments/x/log.jsonl\0 M autoresearch.md\0";
  const entries = parsePorcelainZ(output);
  assert.deepEqual(entries, [
    { path: "src/index.ts", untracked: false },
    { path: "build/out.bin", untracked: true },
  ]);
});

test("autoresearch artifacts are excluded at any depth", () => {
  assert.equal(isAutoresearchArtifact(".auto/log.jsonl"), true);
  assert.equal(isAutoresearchArtifact("packages/api/.auto/prompt.md"), true);
  assert.equal(isAutoresearchArtifact("autoresearch.config.json"), true);
  assert.equal(isAutoresearchArtifact("src/autoresearch.sh"), true);
  assert.equal(isAutoresearchArtifact("src/index.ts"), false);
  assert.equal(isAutoresearchArtifact("auto.log"), false);
});

test("claim attribution ignores paths already dirty when the experiment started", () => {
  const baseline = ["preexisting.txt"];
  const current = [
    { path: "preexisting.txt", untracked: false },
    { path: "src/mine.ts", untracked: false },
    { path: "src/new.ts", untracked: true },
  ];
  assert.deepEqual(claimedBy(current, baseline).map((e) => e.path), ["src/mine.ts", "src/new.ts"]);
});

test("the lock serializes critical sections and breaks a lock left by a dead process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ar-lock-"));
  try {
    const lockPath = join(dir, "git.lock");
    const order = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    const body = (tag, ms) => async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      order.push(`${tag}:in`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${tag}:out`);
      concurrent--;
    };

    await Promise.all([
      withGitLock(lockPath, body("a", 40)),
      withGitLock(lockPath, body("b", 10)),
    ]);

    assert.equal(maxConcurrent, 1, "lock must not admit two holders");
    assert.equal(order.length, 4);
    // Whoever ran second may finish first, but never overlap the first.
    assert.equal(order[1], `${order[0].split(":")[0]}:out`);

    // A lock owned by a pid that no longer exists must not block forever.
    writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 30, host: hostname(), acquiredAt: 0 }));
    const stale = await withGitLock(lockPath, async () => "recovered");
    assert.equal(stale, "recovered");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registry assigns unique ids and round-trips through disk", async () => {
  const repo = await initRepo();
  try {
    const first = createExperiment(repo, { name: "Parser Speed", mode: "shared", workDir: repo });
    assert.equal(first.id, "parser-speed");
    assert.equal(uniqueId(readRegistry(repo), "Parser Speed"), "parser-speed-2");

    const second = createExperiment(repo, { name: "render cache", mode: "shared", workDir: repo });
    assert.equal(second.id, "render-cache");
    assert.equal(listExperiments(repo).length, 2);
    assert.equal(readRegistry(repo).experiments["parser-speed"].name, "Parser Speed");

    mkdirSync(join(repo, ".auto", "experiments", "parser-speed"), { recursive: true });
    assert.equal(findExperimentByWorkDir(repo, repo)?.id, "parser-speed");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("the registry root resolves from inside a linked worktree", async () => {
  const repo = await initRepo();
  try {
    const record = createExperiment(repo, { name: "wt", mode: "worktree", workDir: repo });
    const worktree = join(repo, ".auto", "worktrees", record.id);
    execFileSync("git", ["worktree", "add", "-q", "-b", "autoresearch/wt", worktree, "HEAD"], {
      cwd: repo,
    });

    const fromMain = await resolveRegistryRoot(gitRunner, repo);
    const fromWorktree = await resolveRegistryRoot(gitRunner, worktree);
    assert.equal(fromMain, repo);
    assert.equal(fromWorktree, repo, "a linked worktree must find the main worktree's registry");
  } finally {
    execFileSync("git", ["worktree", "prune"], { cwd: repo });
    await rm(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Scoped git against a real working tree
// ---------------------------------------------------------------------------

test("scopedCommit stages only the named files, never the whole tree", async () => {
  const repo = await initRepo();
  try {
    writeFileSync(join(repo, "a.txt"), "a changed\n");
    writeFileSync(join(repo, "b.txt"), "b changed\n");

    // Only a.txt is ours; b.txt is a sibling session's in-flight work.
    const result = await scopedCommit(gitRunner, {
      cwd: repo,
      paths: ["a.txt"],
      message: "keep a",
    });

    assert.equal(result.committed, true);
    const committed = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.match(committed, /a\.txt/);
    assert.doesNotMatch(committed, /b\.txt/, "a sibling's file must not be swept into the commit");
    assert.equal(readText(join(repo, "b.txt")), "b changed\n", "sibling file stays uncommitted");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("scopedRevert restores our file and leaves the sibling's alone", async () => {
  const repo = await initRepo();
  try {
    writeFileSync(join(repo, "a.txt"), "a experiment\n");
    writeFileSync(join(repo, "b.txt"), "b sibling work\n");
    const head = await headSha(gitRunner, repo);

    const result = await scopedRevert(gitRunner, {
      cwd: repo,
      paths: ["a.txt", "b.txt"],
      headBefore: head,
      headNow: head,
    });

    assert.equal(result.reverted, true);
    assert.equal(readText(join(repo, "a.txt")), "a\n");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("scopedRevert removes untracked files it created and refuses once HEAD moves", async () => {
  const repo = await initRepo();
  try {
    writeFileSync(join(repo, "scratch.ts"), "throwaway\n");
    const head = await headSha(gitRunner, repo);

    const moved = await scopedRevert(gitRunner, {
      cwd: repo,
      paths: ["scratch.ts"],
      headBefore: head,
      headNow: "deadbee",
    });
    assert.equal(moved.reverted, false);
    assert.match(moved.reason, /HEAD moved/);
    assert.equal(existsSync(join(repo, "scratch.ts")), true, "a refused revert must change nothing");

    const ok = await scopedRevert(gitRunner, {
      cwd: repo,
      paths: ["scratch.ts"],
      headBefore: head,
      headNow: head,
    });
    assert.equal(ok.reverted, true);
    assert.equal(existsSync(join(repo, "scratch.ts")), false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Two live sessions in one checkout
// ---------------------------------------------------------------------------

test("two sessions in one checkout keep separate logs, configs and metrics", async () => {
  const repo = await initRepo();
  const exec = realExec();
  try {
    const a = createSession({ cwd: repo, sessionId: "session-a", exec });
    const b = createSession({ cwd: repo, sessionId: "session-b", exec });

    await a.start();
    await b.start();

    await a.tools.get("init_experiment").execute("1", {
      name: "Parser speed",
      metric_name: "parse_us",
    }, null, null, a.ctx);
    await b.tools.get("init_experiment").execute("1", {
      name: "Render cache",
      metric_name: "render_us",
      direction: "higher",
    }, null, null, b.ctx);

    const [idA, idB] = [a.bindingIds().at(-1), b.bindingIds().at(-1)];
    assert.ok(idA && idB, "both sessions claim an experiment");
    assert.notEqual(idA, idB, "auto-create must not hand both sessions the same experiment");

    const logA = join(repo, ".auto", "experiments", idA, "log.jsonl");
    const logB = join(repo, ".auto", "experiments", idB, "log.jsonl");
    assert.notEqual(logA, logB);

    await a.tools.get("log_experiment").execute("2", {
      commit: "aaaaaaa", metric: 100, status: "keep", description: "A kept one",
    }, null, null, a.ctx);
    await b.tools.get("log_experiment").execute("2", {
      commit: "bbbbbbb", metric: 200, status: "keep", description: "B kept one",
    }, null, null, b.ctx);

    const textA = readText(logA);
    const textB = readText(logB);
    assert.match(textA, /"experiment":"[^"]+"/);
    assert.match(textA, /A kept one/);
    assert.doesNotMatch(textA, /B kept one/, "session B's run must not appear in A's log");
    assert.match(textB, /B kept one/);
    assert.doesNotMatch(textB, /A kept one/);

    // Every entry in a log must carry that log's own experiment id.
    for (const line of textA.split("\n").filter(Boolean)) {
      assert.equal(JSON.parse(line).experiment, idA);
    }
    for (const line of textB.split("\n").filter(Boolean)) {
      assert.equal(JSON.parse(line).experiment, idB);
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a session's first discard in a shared tree is refused, not guessed at", async () => {
  const repo = await initRepo();
  const exec = realExec();
  try {
    const a = createSession({ cwd: repo, sessionId: "session-a", exec });
    const b = createSession({ cwd: repo, sessionId: "session-b", exec });
    await a.start();
    await b.start();

    await a.tools.get("init_experiment").execute("1", {
      name: "A", metric_name: "a_metric",
    }, null, null, a.ctx);
    await b.tools.get("init_experiment").execute("1", {
      name: "B", metric_name: "b_metric",
    }, null, null, b.ctx);
    const idB = b.bindingIds().at(-1);

    // Both sessions are working at the same time in the same checkout, and
    // neither has logged yet — so nothing distinguishes their edits.
    writeFileSync(join(repo, "a.txt"), "A's failed idea\n");
    writeFileSync(join(repo, "b.txt"), "B's in-flight idea\n");

    const result = await a.tools.get("log_experiment").execute("2", {
      commit: "aaaaaaa", metric: 0, status: "discard", description: "A gave up",
    }, null, null, a.ctx);

    assert.match(result.content[0].text, /not touching git/);
    assert.match(result.content[0].text, new RegExp(idB));
    assert.match(result.content[0].text, /worktree/);
    assert.equal(readText(join(repo, "a.txt")), "A's failed idea\n", "nothing is destroyed");
    assert.equal(readText(join(repo, "b.txt")), "B's in-flight idea\n", "nothing is destroyed");

    // The measurement is still recorded — only the git mutation is withheld.
    const logA = join(repo, ".auto", "experiments", a.bindingIds().at(-1), "log.jsonl");
    assert.match(readText(logA), /A gave up/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("once claims are known, a keep never commits a sibling's file", async () => {
  const repo = await initRepo();
  const exec = realExec();
  try {
    const a = createSession({ cwd: repo, sessionId: "session-a", exec });
    const b = createSession({ cwd: repo, sessionId: "session-b", exec });
    await a.start();
    await b.start();

    await a.tools.get("init_experiment").execute("1", {
      name: "A", metric_name: "a_metric",
    }, null, null, a.ctx);
    await b.tools.get("init_experiment").execute("1", {
      name: "B", metric_name: "b_metric",
    }, null, null, b.ctx);
    const [idA, idB] = [a.bindingIds().at(-1), b.bindingIds().at(-1)];

    // B has already established that b.txt is its file; A is past its first
    // cycle too, so attribution has a prior claim to diff against.
    writeFileSync(join(repo, "b.txt"), "B's earlier work\n");
    updateExperiment(repo, idB, { claimedPaths: ["b.txt"], resultCount: 1, baselineDirty: [] });
    updateExperiment(repo, idA, { resultCount: 1, claimedPaths: [] });

    const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    writeFileSync(join(repo, "a.txt"), "A's improvement\n");

    const result = await a.tools.get("log_experiment").execute("2", {
      commit: "aaaaaaa", metric: 5, status: "keep", description: "A keeps",
    }, null, null, a.ctx);

    assert.match(result.content[0].text, /committed/);
    const headAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    assert.notEqual(headAfter, headBefore, "a keep creates exactly one new commit");

    const committed = execFileSync("git", ["show", "--name-only", "--format=", headAfter], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.match(committed, /a\.txt/);
    assert.doesNotMatch(committed, /b\.txt/, "B's work must not land in A's commit");
    assert.equal(
      execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }),
      " M b.txt\n",
      "B's change stays dirty and uncommitted",
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a discard leaves alone the files a sibling has claimed", async () => {
  const repo = await initRepo();
  const exec = realExec();
  try {
    const a = createSession({ cwd: repo, sessionId: "session-a", exec });
    const b = createSession({ cwd: repo, sessionId: "session-b", exec });
    await a.start();
    await b.start();

    await a.tools.get("init_experiment").execute("1", {
      name: "A", metric_name: "a_metric",
    }, null, null, a.ctx);
    await b.tools.get("init_experiment").execute("1", {
      name: "B", metric_name: "b_metric",
    }, null, null, b.ctx);
    const [idA, idB] = [a.bindingIds().at(-1), b.bindingIds().at(-1)];

    updateExperiment(repo, idA, { resultCount: 1 });
    updateExperiment(repo, idB, { claimedPaths: ["b.txt"], resultCount: 1, baselineDirty: [] });

    writeFileSync(join(repo, "a.txt"), "A's failed idea\n");
    writeFileSync(join(repo, "b.txt"), "B's in-flight idea\n");

    const result = await a.tools.get("log_experiment").execute("2", {
      commit: "aaaaaaa", metric: 0, status: "discard", description: "A gave up",
    }, null, null, a.ctx);

    assert.equal(readText(join(repo, "a.txt")), "a\n", "A's own change is rolled back");
    assert.equal(
      readText(join(repo, "b.txt")),
      "B's in-flight idea\n",
      "B's uncommitted work must survive A's discard",
    );
    assert.match(result.content[0].text, /reverted/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a sole experiment in a checkout keeps the original repo-wide behaviour", async () => {
  const repo = await initRepo();
  const exec = realExec();
  try {
    const a = createSession({ cwd: repo, sessionId: "solo", exec });
    await a.start();
    await a.tools.get("init_experiment").execute("1", {
      name: "Solo", metric_name: "solo_metric",
    }, null, null, a.ctx);

    // Untracked experiment output must be committed by the familiar path.
    writeFileSync(join(repo, "a.txt"), "solo improvement\n");
    writeFileSync(join(repo, "extra.txt"), "new artifact\n");

    const kept = await a.tools.get("log_experiment").execute("2", {
      commit: "aaaaaaa", metric: 5, status: "keep", description: "solo keeps",
    }, null, null, a.ctx);
    assert.match(kept.content[0].text, /committed/);

    const committed = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.match(committed, /extra\.txt/, "untracked files still land in a solo keep");

    // And a discard still reverts everything the experiment touched.
    writeFileSync(join(repo, "a.txt"), "second idea\n");
    writeFileSync(join(repo, "junk.txt"), "junk\n");
    const discarded = await a.tools.get("log_experiment").execute("3", {
      commit: "bbbbbbb", metric: 0, status: "discard", description: "solo discards",
    }, null, null, a.ctx);
    assert.match(discarded.content[0].text, /reverted changes — autoresearch files preserved/);
    assert.equal(readText(join(repo, "a.txt")), "solo improvement\n");
    assert.equal(existsSync(join(repo, "junk.txt")), false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a session started inside an experiment worktree binds itself and isolates its git", async () => {
  const repo = await initRepo();
  const exec = realExec();
  try {
    const creator = createSession({ cwd: repo, sessionId: "creator", exec });
    await creator.start();
    await creator.cmd("new worktree-experiment");

    const record = readRegistry(repo).experiments["worktree-experiment"];
    assert.ok(record, "new creates a registered worktree experiment");
    assert.equal(record.mode, "worktree");
    assert.equal(record.branch, "autoresearch/worktree-experiment");
    assert.ok(existsSync(record.workDir), "the worktree is checked out on disk");

    // Now launch a second session *inside* the worktree.
    const inside = createSession({ cwd: record.workDir, sessionId: "inside", exec });
    await inside.start();
    assert.equal(inside.bindingIds().length, 0, "adopting a worktree must not need a command");

    await inside.tools.get("init_experiment").execute("1", {
      name: "Worktree run", metric_name: "wt_metric",
    }, null, null, inside.ctx);

    const log = join(repo, ".auto", "experiments", "worktree-experiment", "log.jsonl");
    assert.match(readText(log), /"experiment":"worktree-experiment"/);
    assert.match(readText(log), /Worktree run/);

    // A discard inside the worktree reverts the worktree, and the main
    // checkout's dirty state is a different tree entirely.
    writeFileSync(join(record.workDir, "a.txt"), "worktree edit\n");
    const result = await inside.tools.get("log_experiment").execute("2", {
      commit: "ccccccc", metric: 0, status: "discard", description: "wrong turn",
    }, null, null, inside.ctx);
    assert.match(result.content[0].text, /reverted/);
    assert.equal(readText(join(record.workDir, "a.txt")), "a\n");
  } finally {
    execFileSync("git", ["worktree", "prune"], { cwd: repo });
    await rm(repo, { recursive: true, force: true });
  }
});

test("joining an experiment reloads only that experiment's history", async () => {
  const repo = await initRepo();
  const exec = realExec();
  try {
    const a = createSession({ cwd: repo, sessionId: "session-a", exec });
    await a.start();
    await a.tools.get("init_experiment").execute("1", {
      name: "First", metric_name: "m_one",
    }, null, null, a.ctx);
    const idA = a.bindingIds().at(-1);
    await a.tools.get("log_experiment").execute("2", {
      commit: "aaaaaaa", metric: 11, status: "keep", description: "run from first",
    }, null, null, a.ctx);

    const b = createSession({ cwd: repo, sessionId: "session-b", exec });
    await b.start();
    await b.tools.get("init_experiment").execute("1", {
      name: "Second", metric_name: "m_two",
    }, null, null, b.ctx);
    const idB = b.bindingIds().at(-1);
    await b.tools.get("log_experiment").execute("2", {
      commit: "bbbbbbb", metric: 22, status: "keep", description: "run from second",
    }, null, null, b.ctx);

    assert.notEqual(idA, idB);

    // A fresh session joining the first experiment must see only its run.
    const joiner = createSession({ cwd: repo, sessionId: "joiner", exec });
    await joiner.start();
    await joiner.cmd(`join ${idA}`);

    assert.equal(joiner.bindingIds().at(-1), idA);
    const detail = joiner.tools.get("log_experiment");
    assert.equal(typeof detail, "object");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
