/**
 * Experiment registry.
 *
 * A single repository can host several independent autoresearch experiments at
 * once, one per pi session. Each one owns a slug, its own state directory, and
 * — in worktree mode — its own git worktree.
 *
 * The registry lives in the *main* worktree's `.auto/experiments.json` so that
 * a session running inside a linked worktree still finds it: every worktree
 * shares one git common dir, and its parent is the main worktree.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { AUTO_DIR, EXPERIMENTS_DIR, WORKTREES_DIR } from "./paths.ts";
import type { GitRunner } from "./git.ts";

export type ExperimentMode = "worktree" | "shared";

export interface ExperimentRecord {
  id: string;
  /** Display name, set by init_experiment. */
  name: string | null;
  mode: ExperimentMode;
  /** Where this experiment's code lives. Equals the session cwd in worktree mode. */
  workDir: string;
  branch: string | null;
  createdAt: number;
  lastUsedAt: number;
  /**
   * Shared mode only: the HEAD this experiment's changes are anchored to, and
   * the paths that were already dirty when it started. Together these decide
   * what a commit or a discard is allowed to touch.
   */
  baselineHead: string | null;
  baselineDirty: string[];
  /**
   * Shared mode only: the paths this experiment most recently claimed. Lets a
   * sibling report an overlap instead of silently committing someone's work.
   */
  claimedPaths: string[];
  /** Results logged so far; the first one has no prior claim to diff against. */
  resultCount: number;
}

export interface Registry {
  version: 1;
  experiments: Record<string, ExperimentRecord>;
}

export { EXPERIMENTS_DIR, WORKTREES_DIR };
export const BRANCH_PREFIX = "autoresearch/";

const REGISTRY_FILE = "experiments.json";
const LOCK_FILE = "git.lock";

export function autoDir(root: string): string {
  return path.join(root, AUTO_DIR);
}

export function experimentsDir(root: string): string {
  return path.join(root, EXPERIMENTS_DIR);
}

export function experimentDir(root: string, id: string): string {
  return path.join(experimentsDir(root), id);
}

export function registryPath(root: string): string {
  return path.join(autoDir(root), REGISTRY_FILE);
}

export function gitLockPath(root: string): string {
  return path.join(autoDir(root), LOCK_FILE);
}

export function worktreePath(root: string, id: string): string {
  return path.join(root, WORKTREES_DIR, id);
}

export function branchFor(id: string): string {
  return `${BRANCH_PREFIX}${id}`;
}

function emptyRegistry(): Registry {
  return { version: 1, experiments: {} };
}

export function readRegistry(root: string): Registry {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath(root), "utf-8"));
    if (parsed?.version !== 1 || typeof parsed.experiments !== "object" || parsed.experiments === null) {
      return emptyRegistry();
    }
    return { version: 1, experiments: parsed.experiments as Record<string, ExperimentRecord> };
  } catch {
    return emptyRegistry();
  }
}

/** Write via temp file + rename so a crash mid-write cannot truncate the registry. */
export function writeRegistry(root: string, registry: Registry): void {
  const target = registryPath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`);
  fs.renameSync(temp, target);
}

/** Normalize a user-supplied name into a filesystem- and git-safe slug. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "experiment";
}

export function uniqueId(registry: Registry, base: string): string {
  const slug = slugify(base);
  if (!registry.experiments[slug]) return slug;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${slug}-${n}`;
    if (!registry.experiments[candidate]) return candidate;
  }
  throw new Error(`Could not derive a unique experiment id from "${base}"`);
}

export function listExperiments(root: string): ExperimentRecord[] {
  return Object.values(readRegistry(root).experiments).sort(
    (a, b) => b.lastUsedAt - a.lastUsedAt,
  );
}

/**
 * Other *shared* experiments in this checkout that were touched recently enough
 * to be running.
 *
 * Worktree experiments are excluded on purpose: they own a separate working
 * tree and cannot touch this one's files, so treating them as siblings would
 * needlessly disable git for a solo shared experiment.
 */
export function concurrentExperiments(
  root: string,
  id: string | null,
  windowMs = 10 * 60_000,
): ExperimentRecord[] {
  const cutoff = Date.now() - windowMs;
  return listExperiments(root).filter(
    (record) =>
      record.id !== id &&
      record.mode === "shared" &&
      (record.lastUsedAt > cutoff || record.resultCount > 0),
  );
}

export function getExperiment(root: string, id: string): ExperimentRecord | null {
  return readRegistry(root).experiments[id] ?? null;
}

/** The experiment whose worktree is exactly `dir`, if any. */
export function findExperimentByWorkDir(root: string, dir: string): ExperimentRecord | null {
  let target: string;
  try {
    target = fs.realpathSync.native(dir);
  } catch {
    target = path.resolve(dir);
  }
  for (const record of Object.values(readRegistry(root).experiments)) {
    let candidate: string;
    try {
      candidate = fs.realpathSync.native(record.workDir);
    } catch {
      candidate = path.resolve(record.workDir);
    }
    if (candidate === target) return record;
  }
  return null;
}

export interface CreateExperimentInput {
  /** Pre-allocated id, required when the caller already created resources keyed by it. */
  id?: string;
  name?: string | null;
  mode: ExperimentMode;
  workDir: string;
  branch?: string | null;
  baselineHead?: string | null;
  baselineDirty?: string[];
}

export function createExperiment(root: string, input: CreateExperimentInput): ExperimentRecord {
  const registry = readRegistry(root);
  const id = input.id ?? uniqueId(registry, input.name ?? "experiment");
  if (registry.experiments[id]) {
    throw new Error(`Experiment "${id}" already exists`);
  }
  const now = Date.now();

  const record: ExperimentRecord = {
    id,
    name: input.name ?? null,
    mode: input.mode,
    workDir: input.workDir,
    branch: input.branch ?? null,
    createdAt: now,
    lastUsedAt: now,
    baselineHead: input.baselineHead ?? null,
    baselineDirty: input.baselineDirty ?? [],
    claimedPaths: [],
    resultCount: 0,
  };

  registry.experiments[id] = record;
  fs.mkdirSync(experimentDir(root, id), { recursive: true });
  writeRegistry(root, registry);
  return record;
}

export function updateExperiment(
  root: string,
  id: string,
  patch: Partial<Omit<ExperimentRecord, "id">>,
): ExperimentRecord | null {
  const registry = readRegistry(root);
  const existing = registry.experiments[id];
  if (!existing) return null;

  const updated: ExperimentRecord = { ...existing, ...patch, id, lastUsedAt: Date.now() };
  registry.experiments[id] = updated;
  writeRegistry(root, registry);
  return updated;
}

export function deleteExperiment(root: string, id: string): ExperimentRecord | null {
  const registry = readRegistry(root);
  const existing = registry.experiments[id];
  if (!existing) return null;
  delete registry.experiments[id];
  writeRegistry(root, registry);
  return existing;
}

// ---------------------------------------------------------------------------
// Locating the registry root from a session cwd
// ---------------------------------------------------------------------------

/**
 * The main worktree for whichever repository `cwd` belongs to, or null when
 * `cwd` is not in a git repository at all.
 *
 * A linked worktree reports the *shared* git dir, whose parent is the main
 * worktree — that is what keeps one registry reachable from both the main
 * checkout and every experiment worktree.
 */
export async function resolveRegistryRoot(runner: GitRunner, cwd: string): Promise<string | null> {
  const result = await runner(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd, 5000);
  if (result.code !== 0) return null;

  const commonDir = result.stdout.trim();
  if (!commonDir) return null;

  // Bare repositories have no worktree to host `.auto/`.
  const parent = path.dirname(commonDir);
  if (path.basename(commonDir) !== ".git") return null;
  return fs.existsSync(parent) ? parent : null;
}

/** True when `dir` is already a registered worktree directory. */
export async function isRegisteredWorktree(
  runner: GitRunner,
  root: string,
  dir: string,
): Promise<boolean> {
  const record = findExperimentByWorkDir(root, dir);
  if (!record || record.mode !== "worktree") return false;
  const result = await runner(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir, 5000);
  if (result.code !== 0) return false;
  const parent = path.dirname(result.stdout.trim());
  return fs.existsSync(parent) && path.resolve(parent) === path.resolve(root);
}

/**
 * Scaffold a git worktree for a new experiment, on its own branch, from HEAD.
 * Returns the created worktree path.
 */
export async function createWorktree(
  runner: GitRunner,
  root: string,
  id: string,
): Promise<{ ok: true; workDir: string } | { ok: false; error: string }> {
  const target = worktreePath(root, id);
  if (fs.existsSync(target)) {
    return { ok: false, error: `${target} already exists` };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const branch = branchFor(id);
  const result = await runner(["worktree", "add", "-b", branch, target, "HEAD"], root, 60_000);
  if (result.code !== 0) {
    return { ok: false, error: (result.stdout + result.stderr).trim().slice(0, 300) };
  }
  return { ok: true, workDir: target };
}

/** Remove an experiment's worktree and branch. Never touches the main worktree. */
export async function removeWorktree(
  runner: GitRunner,
  root: string,
  record: ExperimentRecord,
): Promise<{ ok: boolean; error?: string }> {
  if (record.mode !== "worktree") return { ok: true };

  const workDir = record.workDir;
  if (fs.existsSync(workDir)) {
    const result = await runner(["worktree", "remove", "--force", workDir], root, 30_000);
    if (result.code !== 0) {
      return { ok: false, error: (result.stdout + result.stderr).trim().slice(0, 300) };
    }
  }
  if (record.branch) {
    // The branch may still be checked out elsewhere; that failure is not fatal.
    await runner(["branch", "-D", record.branch], root, 10_000);
  }
  return { ok: true };
}
