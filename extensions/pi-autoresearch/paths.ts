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
