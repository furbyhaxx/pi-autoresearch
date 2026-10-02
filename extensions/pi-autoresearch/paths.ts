/**
 * Session file path resolution.
 *
 * All autoresearch session files live under a `.auto/` subfolder (one folder
 * to preserve across reverts, gitignore, and clean up). Within it, each
 * experiment owns `.auto/experiments/<id>/` so concurrent experiments in one
 * repository never share a log, a config, or a hook script.
 *
 * An unbound session — one that has not started an experiment yet — resolves
 * to the pre-experiment flat `.auto/` layout, which is also where the legacy
 * `autoresearch.*` files live and are still read for backwards compatibility.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const AUTO_DIR = ".auto";
/** Per-experiment state root, relative to the repository root. */
export const EXPERIMENTS_DIR = path.join(AUTO_DIR, "experiments");
/** Per-experiment git worktrees, relative to the repository root. */
export const WORKTREES_DIR = path.join(AUTO_DIR, "worktrees");

export type SessionFileKind = "log" | "prompt" | "ideas" | "checks" | "measure" | "config";
export type HookStage = "before" | "after";

const CURRENT_HOOKS_DIR = "hooks";
const LEGACY_HOOKS_DIR = "autoresearch.hooks";

const SESSION_FILE_NAMES: Record<SessionFileKind, { current: string; legacy: string }> = {
  log:    { current: "log.jsonl",   legacy: "autoresearch.jsonl" },
  prompt: { current: "prompt.md",  legacy: "autoresearch.md" },
  ideas:  { current: "ideas.md",    legacy: "autoresearch.ideas.md" },
  checks: { current: "checks.sh",   legacy: "autoresearch.checks.sh" },
  measure:{ current: "measure.sh",  legacy: "autoresearch.sh" },
  config: { current: "config.json", legacy: "autoresearch.config.json" },
};

export interface SessionFileCandidates {
  current: string;
  legacy: string;
}

function currentSessionPath(dir: string, kind: SessionFileKind, experimentId?: string | null): string {
  if (experimentId) {
    return path.join(dir, EXPERIMENTS_DIR, experimentId, SESSION_FILE_NAMES[kind].current);
  }
  return path.join(dir, AUTO_DIR, SESSION_FILE_NAMES[kind].current);
}

function legacySessionPath(dir: string, kind: SessionFileKind): string {
  return path.join(dir, SESSION_FILE_NAMES[kind].legacy);
}

function currentHookPath(workDir: string, stage: HookStage, experimentId?: string | null): string {
  if (experimentId) {
    return path.join(workDir, EXPERIMENTS_DIR, experimentId, CURRENT_HOOKS_DIR, `${stage}.sh`);
  }
  return path.join(workDir, AUTO_DIR, CURRENT_HOOKS_DIR, `${stage}.sh`);
}

function legacyHookPath(workDir: string, stage: HookStage): string {
  return path.join(workDir, LEGACY_HOOKS_DIR, `${stage}.sh`);
}

function currentLayoutExists(dir: string, experimentId?: string | null): boolean {
  for (const kind of Object.keys(SESSION_FILE_NAMES) as SessionFileKind[]) {
    if (fs.existsSync(currentSessionPath(dir, kind, experimentId))) return true;
  }
  return fs.existsSync(hooksDir(dir, experimentId));
}

function hooksDir(dir: string, experimentId?: string | null): string {
  if (experimentId) {
    return path.join(dir, EXPERIMENTS_DIR, experimentId, CURRENT_HOOKS_DIR);
  }
  return path.join(dir, AUTO_DIR, CURRENT_HOOKS_DIR);
}

/** Return both physical paths for destructive or migration operations. */
export function sessionFileCandidates(
  dir: string,
  kind: SessionFileKind,
  experimentId?: string | null,
): SessionFileCandidates {
  return {
    current: currentSessionPath(dir, kind, experimentId),
    legacy: legacySessionPath(dir, kind),
  };
}

/**
 * Effective path for a session file.
 *
 * With an experiment id the layout choice is per experiment and the legacy flat
 * files are never consulted — they belong to whichever unbound session wrote
 * them. Without one, an existing `.auto/` artifact claims the flat layout and
 * legacy files are honoured only as a last resort.
 */
export function sessionFilePath(dir: string, kind: SessionFileKind, experimentId?: string | null): string {
  const candidates = sessionFileCandidates(dir, kind, experimentId);
  if (experimentId) return candidates.current;
  if (currentLayoutExists(dir)) return candidates.current;
  return fs.existsSync(candidates.legacy) ? candidates.legacy : candidates.current;
}

/** Effective path for a hook script, with the same layout choice as session files. */
export function hookScriptPath(workDir: string, stage: HookStage, experimentId?: string | null): string {
  const current = currentHookPath(workDir, stage, experimentId);
  if (experimentId) return current;
  const legacy = legacyHookPath(workDir, stage);
  if (currentLayoutExists(workDir)) return current;
  return fs.existsSync(legacy) ? legacy : current;
}

/** Ensure the parent directory for a session file exists before writing. */
export function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

const MIGRATABLE_KINDS = Object.keys(SESSION_FILE_NAMES) as SessionFileKind[];

export interface FlatStateEntry {
  from: string;
  /** Resolved against an experiment id; directories keep their shape. */
  to: (experimentId: string) => string;
  isDirectory: boolean;
}

/**
 * Flat state files left by a pre-registry version of this extension.
 *
 * A repository that only ever ran one experiment has its state directly in
 * `.auto/`, written before experiments had ids. Claiming an id makes every
 * lookup resolve under `.auto/experiments/<id>/`, so those files would be
 * orphaned and the run's history would read as empty. Detecting them here is
 * what lets the caller adopt them instead of stranding them.
 *
 * Anything unrecognised in `.auto/` is left alone: that directory also holds
 * the registry, the worktree directory and the git lockfile.
 */
export function findUnclaimedFlatState(dir: string): FlatStateEntry[] {
  if (fs.existsSync(path.join(dir, EXPERIMENTS_DIR))) return [];

  const entries: FlatStateEntry[] = [];

  for (const kind of MIGRATABLE_KINDS) {
    const { current, legacy } = sessionFileCandidates(dir, kind);
    for (const from of [current, legacy]) {
      if (fs.existsSync(from)) {
        entries.push({ from, to: (id) => currentSessionPath(dir, kind, id), isDirectory: false });
      }
    }
  }

  const currentHooks = hooksDir(dir, null);
  if (fs.existsSync(currentHooks)) {
    entries.push({
      from: currentHooks,
      to: (id) => hooksDir(dir, id),
      isDirectory: true,
    });
  }

  const legacyHooks = path.join(dir, LEGACY_HOOKS_DIR);
  if (fs.existsSync(legacyHooks)) {
    entries.push({
      from: legacyHooks,
      to: (id) => hooksDir(dir, id),
      isDirectory: true,
    });
  }

  return entries;
}

/**
 * Move flat state under an experiment id. Rename first, so a crash part way
 * through cannot leave a duplicated log; copy is only a fallback for when the
 * two paths land on different filesystems.
 */
export function adoptFlatState(dir: string, experimentId: string): string[] {
  const adopted: string[] = [];
  for (const { from, to, isDirectory } of findUnclaimedFlatState(dir)) {
    const target = to(experimentId);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try {
        fs.renameSync(from, target);
      } catch {
        if (!isDirectory) {
          fs.copyFileSync(from, target);
          fs.unlinkSync(from);
        }
      }
      adopted.push(target);
    } catch {
      // Leave anything we could not move where it is rather than half-copy it.
    }
  }
  return adopted;
}

/** Best-effort experiment name for a migrated run, taken from its own log. */
export function nameFromFlatLog(dir: string): string | null {
  for (const candidate of [path.join(dir, AUTO_DIR, "log.jsonl"), path.join(dir, "autoresearch.jsonl")]) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const handle = fs.openSync(candidate, "r");
      try {
        // The config header is the first line, and the log can be large.
        const buffer = Buffer.alloc(64 * 1024);
        const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
        const [firstLine] = buffer.toString("utf-8", 0, read).split("\n");
        if (!firstLine?.trim()) continue;
        const parsed = JSON.parse(firstLine) as { type?: string; name?: string };
        if (parsed.type === "config" && typeof parsed.name === "string" && parsed.name.trim()) {
          return parsed.name.trim();
        }
      } finally {
        fs.closeSync(handle);
      }
    } catch {
      return null;
    }
  }
  return null;
}
