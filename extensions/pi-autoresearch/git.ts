/**
 * Git helpers for experiment isolation.
 *
 * Two modes exist, and they deliberately use different primitives:
 *
 * - worktree mode: the experiment owns a whole git worktree, so the original
 *   repo-wide `git add -A` / `git checkout -- .` remain correct and untouched.
 * - shared mode: several experiments share one working tree. The repo-wide
 *   operations are unusable there — `git checkout -- .` would destroy a sibling
 *   session's in-flight edits — so every mutation is scoped to the files this
 *   experiment actually dirtied, serialized by a cross-process lockfile, and
 *   refused outright when HEAD moved underneath us.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AUTO_DIR } from "./paths.ts";

export interface GitExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[], cwd: string, timeoutMs?: number) => Promise<GitExecResult>;

/** A tracked or untracked path that differs from HEAD. */
export interface DirtyEntry {
  path: string;
  untracked: boolean;
}

export async function headSha(runner: GitRunner, cwd: string): Promise<string | null> {
  const result = await runner(["rev-parse", "--short=7", "HEAD"], cwd, 5000);
  if (result.code !== 0) return null;
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
}

/**
 * Paths that belong to autoresearch itself and must survive any experiment
 * revert. Mirrors the exclusions the repo-wide revert script used.
 */
export function isAutoresearchArtifact(candidate: string): boolean {
  const normalized = candidate.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized
    .split("/")
    .some((segment) => segment === AUTO_DIR || segment.startsWith("autoresearch."));
}

/**
 * Parse `git status --porcelain -z` output into dirty entries.
 *
 * Rename and copy records span two NUL-separated fields: the destination, then
 * the original path. Both are reported, because a rename has to be undone (or
 * staged) at both ends — tracking only the destination would leave the original
 * deleted forever after a discard.
 */
export function parsePorcelainZ(output: string): DirtyEntry[] {
  const entries: DirtyEntry[] = [];
  const fields = output.split("\0");

  const push = (filePath: string, untracked: boolean): void => {
    if (!filePath || isAutoresearchArtifact(filePath)) return;
    entries.push({ path: filePath, untracked });
  };

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field || field.length < 4) continue;
    const status = field.slice(0, 2);
    const filePath = field.slice(3);
    const isRename = status.includes("R") || status.includes("C");

    if (isRename) {
      push(filePath, false);
      push(fields[++i] ?? "", false);
      continue;
    }
    push(filePath, status === "??");
  }

  return entries;
}

/** Current dirty entries for a working tree, autoresearch artifacts excluded. */
export async function dirtyEntries(runner: GitRunner, cwd: string): Promise<DirtyEntry[]> {
  const result = await runner(["status", "--porcelain", "-z", "--untracked-files=all"], cwd, 10000);
  if (result.code !== 0) return [];
  return parsePorcelainZ(result.stdout);
}

export function dirtyPaths(entries: DirtyEntry[]): string[] {
  return entries.map((entry) => entry.path);
}

/**
 * Paths this experiment introduced: everything dirty now that was already dirty
 * when it started. In a shared tree this is a best effort attribution — an
 * edit made by a sibling session after our baseline also shows up here, which
 * is why commits and reverts stay serialized and claim-checked.
 */
export function claimedBy(
  current: DirtyEntry[],
  baselineDirty: readonly string[],
): DirtyEntry[] {
  const baseline = new Set(baselineDirty);
  return current.filter((entry) => !baseline.has(entry.path));
}

// ---------------------------------------------------------------------------
// Cross-process lock
// ---------------------------------------------------------------------------

interface LockPayload {
  pid: number;
  host: string;
  acquiredAt: number;
}

/** A lock file younger than this may still be mid-write, so never steal it. */
const LOCK_WRITE_GRACE_MS = 5_000;
const LOCK_POLL_MS = 50;

function readLockPayload(lockPath: string): LockPayload | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    if (typeof parsed?.pid !== "number" || typeof parsed?.host !== "string") return null;
    return parsed as LockPayload;
  } catch {
    return null;
  }
}

function tryAcquire(lockPath: string): boolean {
  try {
    const fd = fs.openSync(lockPath, "wx");
    const payload: LockPayload = { pid: process.pid, host: os.hostname(), acquiredAt: Date.now() };
    fs.writeSync(fd, JSON.stringify(payload));
    fs.closeSync(fd);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

interface StaleLock {
  /** Payload observed when the lock was judged stale, used to avoid stealing a fresh one. */
  payload: LockPayload | null;
}

/** Judge a lock stale, returning the evidence so a later steal can be re-checked. */
function inspectStale(lockPath: string): StaleLock | null {
  const payload = readLockPayload(lockPath);
  if (!payload) {
    // Unreadable or half-written: only treat as stale once it has settled.
    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs <= LOCK_WRITE_GRACE_MS) return null;
      return { payload: null };
    } catch {
      return { payload: null };
    }
  }
  // Another host's pid is not inspectable, so leave its lock alone.
  if (payload.host !== os.hostname()) return null;
  try {
    process.kill(payload.pid, 0);
    return null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? { payload } : null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` while holding an exclusive lock on `lockPath`. Breaks a lock whose
 * owning process is gone, and fails loudly rather than waiting forever.
 */
export async function withGitLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  timeoutMs = 15_000,
): Promise<T> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (tryAcquire(lockPath)) break;

    const stale = inspectStale(lockPath);
    if (stale) {
      // Remove only the exact lock we judged stale. Two waiters can both see the
      // same dead lock, and unlinking blindly would let the second one delete
      // the lock the first just took — putting both inside the critical section.
      const current = readLockPayload(lockPath);
      const stillTheSame = stale.payload === null
        ? current === null
        : current !== null && current.pid === stale.payload.pid && current.acquiredAt === stale.payload.acquiredAt;
      if (stillTheSame) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Another waiter got there first; retry the acquire.
        }
      }
      continue;
    }

    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for the experiment git lock (${lockPath})`);
    }
    await sleep(LOCK_POLL_MS);
  }

  try {
    return await fn();
  } finally {
    // Release only our own lock, identified by the payload we wrote.
    const mine = readLockPayload(lockPath);
    if (mine && mine.pid === process.pid && mine.host === os.hostname()) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Already released.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Scoped mutations (shared working tree only)
// ---------------------------------------------------------------------------

export interface ScopedCommitResult {
  committed: boolean;
  sha: string | null;
  staged: string[];
  message: string;
}

/**
 * Stage and commit only the given paths. Refuses to use `-A` here: a sibling
 * session's uncommitted work is not ours to record.
 */
export async function scopedCommit(
  runner: GitRunner,
  opts: { cwd: string; paths: string[]; message: string },
): Promise<ScopedCommitResult> {
  const { cwd, paths, message } = opts;
  if (paths.length === 0) {
    return { committed: false, sha: null, staged: [], message: "no changed files to commit" };
  }

  const addResult = await runner(["add", "--", ...paths], cwd, 10_000);
  if (addResult.code !== 0) {
    const detail = (addResult.stdout + addResult.stderr).trim();
    return {
      committed: false,
      sha: null,
      staged: [],
      message: `git add failed (exit ${addResult.code}): ${detail.slice(0, 200)}`,
    };
  }

  const diffResult = await runner(["diff", "--cached", "--quiet"], cwd, 10_000);
  if (diffResult.code === 0) {
    return { committed: false, sha: null, staged: paths, message: "nothing to commit (working tree clean)" };
  }

  // The pathspec matters: without it the commit would take down everything
  // else that happens to be staged in this shared tree, under this message.
  const commitResult = await runner(["commit", "-m", message, "--", ...paths], cwd, 10_000);
  const output = (commitResult.stdout + commitResult.stderr).trim();
  if (commitResult.code !== 0) {
    return {
      committed: false,
      sha: null,
      staged: paths,
      message: `git commit failed (exit ${commitResult.code}): ${output.slice(0, 200)}`,
    };
  }

  return {
    committed: true,
    sha: await headSha(runner, cwd),
    staged: paths,
    message: output.split("\n")[0] || "committed",
  };
}

export interface ScopedRevertResult {
  reverted: boolean;
  /** Set when the revert was refused or failed; explains why. */
  reason: string | null;
  restored: string[];
  removed: string[];
  /** Paths git refused to undo. */
  failed: string[];
}

/**
 * Undo only this experiment's changes.
 *
 * A discard is a destructive act on a tree we share, so it is gated on HEAD
 * still being where this experiment left it. If a sibling committed in the
 * meantime the revert is refused: the experiment's diff no longer has a
 * meaningful baseline and guessing would risk their work.
 */
export async function scopedRevert(
  runner: GitRunner,
  opts: {
    cwd: string;
    paths: string[];
    headBefore: string | null;
    headNow: string | null;
  },
): Promise<ScopedRevertResult> {
  const { cwd, paths, headBefore, headNow } = opts;
  const restored: string[] = [];
  const removed: string[] = [];
  const failed: string[] = [];

  if (headBefore === null) {
    return {
      reverted: false,
      reason: "no baseline HEAD recorded for this experiment, refusing to discard",
      restored,
      removed,
      failed,
    };
  }
  if (headNow !== headBefore) {
    return {
      reverted: false,
      reason:
        `HEAD moved from ${headBefore} to ${headNow ?? "unknown"} (another experiment committed) — ` +
        "refusing to discard so no one else's work is lost. Re-baseline or land the change by hand.",
      restored,
      removed,
      failed,
    };
  }
  if (paths.length === 0) {
    return { reverted: false, reason: null, restored, removed, failed };
  }

  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const entry of await dirtyEntries(runner, cwd)) {
    if (!paths.includes(entry.path)) continue;
    (entry.untracked ? untracked : tracked).push(entry.path);
  }

  if (tracked.length > 0) {
    // --staged as well as --worktree: a change this experiment staged for a
    // commit that then failed would otherwise stay staged and be swept into
    // some later commit in this shared tree.
    const result = await runner(
      ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked],
      cwd,
      10_000,
    );
    (result.code === 0 ? restored : failed).push(...tracked);
  }
  if (untracked.length > 0) {
    const result = await runner(["clean", "-fd", "--", ...untracked], cwd, 10_000);
    (result.code === 0 ? removed : failed).push(...untracked);
  }

  return {
    reverted: restored.length + removed.length > 0,
    reason: failed.length > 0 ? `git could not revert: ${failed.join(", ")}` : null,
    restored,
    removed,
    failed,
  };
}
