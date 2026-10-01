/**
 * autoresearch — Pi Extension
 *
 * Generic autonomous experiment loop infrastructure.
 * Domain-specific behavior comes from skills (what command to run, what to optimize).
 *
 * Provides:
 * - `run_experiment` tool — runs any command, times it, captures output, detects pass/fail
 * - `log_experiment` tool — records results with session-persisted state
 * - Status widget showing experiment count + best metric
 * - Fullscreen dashboard overlay via /autoresearch dashboard (opt-in shortcuts available)
 * - Adds autoresearch guidance to the system prompt and points the agent at .auto/prompt.md
 * - Injects .auto/prompt.md into context on every turn via before_agent_start
 */

import type {
  CustomEntry,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateTail, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text, truncateToWidth, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server, type ServerResponse } from "node:http";

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";

import {
  runHook,
  steerMessageFor,
  appendHookLogEntryIfConfigured,
  type HookPayload,
  type SessionSnapshot,
} from "./hooks.ts";
import {
  parseJsonlEntry,
  isAutoresearchRunEntry,
  entryBelongsToExperiment,
  extractAutoresearchSessionName,
  reconstructJsonlState,
} from "./jsonl.ts";
import {
  autoresearchSummaryPathsFor,
  buildAutoresearchCompactionSummary,
} from "./compaction.ts";
import { resolveAutoresearchShortcuts, SHORTCUT_ACTIONS } from "./shortcuts.ts";
import { sessionFilePath, sessionFileCandidates, ensureParentDir, AUTO_DIR } from "./paths.ts";
import {
  branchFor,
  concurrentExperiments,
  createExperiment,
  createWorktree,
  deleteExperiment,
  experimentDir,
  findExperimentByWorkDir,
  getExperiment,
  gitLockPath,
  listExperiments,
  readRegistry,
  removeWorktree,
  resolveRegistryRoot,
  uniqueId,
  updateExperiment,
  type ExperimentRecord,
} from "./experiments.ts";
import {
  claimedBy,
  dirtyEntries,
  dirtyPaths,
  headSha,
  scopedCommit,
  scopedRevert,
  withGitLock,
  type GitRunner,
} from "./git.ts";

// ---------------------------------------------------------------------------
// Experiment output limits (sent to LLM — keep small to save context)
// ---------------------------------------------------------------------------
const EXPERIMENT_MAX_LINES = 10;
const EXPERIMENT_MAX_BYTES = 4 * 1024; // 4KB

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Actionable Side Information (ASI) — free-form diagnostics per experiment run.
 * The agent decides what to record. Any key/value pair is valid.
 */
interface ASI {
  [key: string]: unknown;
}

interface ExperimentResult {
  commit: string;
  metric: number;
  /** Additional tracked metrics: { name: value } */
  metrics: Record<string, number>;
  status: "keep" | "discard" | "crash" | "checks_failed";
  description: string;
  timestamp: number;
  /** Segment index — increments on each config header. Current segment = highest. */
  segment: number;
  /** Session-level confidence score at the time this result was logged. null if insufficient data. */
  confidence: number | null;
  /** Actionable Side Information — structured diagnostics for this run */
  asi?: ASI;
}

interface MetricDef {
  name: string;
  unit: string;
}

interface ExperimentState {
  results: ExperimentResult[];
  /** Baseline primary metric (from first experiment in current segment) */
  bestMetric: number | null;
  bestDirection: "lower" | "higher";
  metricName: string;
  metricUnit: string;
  /** Definitions for secondary metrics (order preserved) */
  secondaryMetrics: MetricDef[];
  name: string | null;
  /** Current segment index (incremented on each init_experiment) */
  currentSegment: number;
  /** Maximum number of experiments before auto-stopping. null = unlimited. */
  maxExperiments: number | null;
  /** Current session confidence score (best improvement / noise floor). null if insufficient data. */
  confidence: number | null;
}

export const AUTORESUME_TURN_LIMIT = 200;
export const CONSECUTIVE_FAILURE_OVERRIDE_LIMIT = 20;

type AutoResumeGuardState = Pick<ExperimentState, "results" | "currentSegment">;
type AutoResumeGuardRuntime = {
  autoResumeTurns: number;
  state: AutoResumeGuardState;
};

/** Count trailing discard/crash results in the current segment. */
export function countConsecutiveDiscardOrCrashResults(state: AutoResumeGuardState): number {
  let count = 0;
  for (let i = state.results.length - 1; i >= 0; i--) {
    const result = state.results[i];
    if (result.segment !== state.currentSegment) break;
    if (result.status === "discard" || result.status === "crash") {
      count++;
      continue;
    }
    break;
  }
  return count;
}

export function autoResumeStopReasonFor(runtime: AutoResumeGuardRuntime): string | null {
  if (runtime.autoResumeTurns >= AUTORESUME_TURN_LIMIT) {
    return `Autoresearch auto-resume limit reached (${AUTORESUME_TURN_LIMIT} turns)`;
  }
  const failures = countConsecutiveDiscardOrCrashResults(runtime.state);
  if (failures > CONSECUTIVE_FAILURE_OVERRIDE_LIMIT) {
    return `Autoresearch auto-resume stopped — ${failures} consecutive discards/crashes`;
  }
  return null;
}

interface RunDetails {
  command: string;
  exitCode: number | null;
  durationSeconds: number;
  passed: boolean;
  crashed: boolean;
  timedOut: boolean;
  tailOutput: string;
  /** null = checks not run (no file or benchmark failed), true/false = ran */
  checksPass: boolean | null;
  checksTimedOut: boolean;
  checksOutput: string;
  checksDuration: number;
  /** Metrics parsed from METRIC lines in output. null if none found. */
  parsedMetrics: Record<string, number> | null;
  /** Primary metric value extracted from parsedMetrics (matching metricName). null if not found. */
  parsedPrimary: number | null;
  /** Name of the primary metric (for display) */
  metricName: string;
  metricUnit: string;

}

interface LogDetails {
  experimentId: string | null;
  experiment: ExperimentResult;
  state: ExperimentState;
  wallClockSeconds: number | null;
}

interface AutoresearchRuntime {
  autoresearchMode: boolean;
  experimentsThisSession: number;
  autoResumeTurns: number;
  lastRunChecks: { pass: boolean; output: string; duration: number } | null;
  lastRunDuration: number | null;
  runningExperiment: { startedAt: number; command: string } | null;
  state: ExperimentState;
  /** Pending auto-resume timer; cancelled when the agent starts a new run or compacts. */
  pendingResumeTimer: ReturnType<typeof setTimeout> | null;
  /** Resume message to send when the pending timer fires. */
  pendingResumeMessage: string | null;
  /** Experiment this session is bound to, or null before first use. */
  experimentId: string | null;
  /** Main worktree that holds the registry and every `.auto/` state file. */
  stateRoot: string | null;
}

// ---------------------------------------------------------------------------
// Tool Schemas
// ---------------------------------------------------------------------------

const RunParams = Type.Object({
  command: Type.String({
    description:
      "Shell command to run (e.g. 'pnpm test:vitest', 'uv run train.py')",
  }),
  timeout_seconds: Type.Optional(
    Type.Number({
      description: "Kill after this many seconds (default: 600)",
    })
  ),
  checks_timeout_seconds: Type.Optional(
    Type.Number({
      description:
        "Kill .auto/checks.sh after this many seconds (default: 300). Only relevant when the checks file exists.",
    })
  ),
});

const InitParams = Type.Object({
  name: Type.String({
    description:
      'Human-readable name for this experiment session (e.g. "Optimizing liquid for fastest execution and parsing")',
  }),
  metric_name: Type.String({
    description:
      'Display name for the primary metric (e.g. "total_µs", "bundle_kb", "val_bpb"). Shown in dashboard headers.',
  }),
  metric_unit: Type.Optional(
    Type.String({
      description:
        'Unit for the primary metric. Use "µs", "ms", "s", "kb", "mb", or "" for unitless. Affects number formatting. Default: ""',
    })
  ),
  direction: Type.Optional(
    Type.String({
      description:
        'Whether "lower" or "higher" is better for the primary metric. Default: "lower".',
    })
  ),
});

export const LogParams = Type.Object({
  commit: Type.String({ description: "Git commit hash (short, 7 chars)" }),
  metric: Type.Number({
    description:
      "The primary optimization metric value (e.g. seconds, val_bpb). 0 for crashes.",
  }),
  status: StringEnum(["keep", "discard", "crash", "checks_failed"] as const),
  description: Type.String({
    description: "Short description of what this experiment tried",
  }),
  metrics: Type.Optional(
    Type.Object({}, {
      additionalProperties: Type.Number(),
      description:
        'Additional metrics to track as { name: value } pairs, e.g. { "compile_µs": 4200, "render_µs": 9800 }. These are shown alongside the primary metric for tradeoff monitoring.',
    })
  ),
  force: Type.Optional(
    Type.Boolean({
      description:
        "Set to true to allow adding a new secondary metric that wasn't tracked before. Only use for metrics that have proven very valuable to watch.",
    })
  ),
  asi: Type.Optional(
    Type.Object({}, {
      additionalProperties: Type.Unknown(),
      description:
        'Actionable Side Information — structured diagnostics for this run. Free-form key/value pairs. Parsed ASI from run_experiment output is merged automatically; use this to add or override fields.',
    })
  ),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Prefix for structured metric output lines: `METRIC name=value` */
const METRIC_LINE_PREFIX = "METRIC";

/**
 * Parse structured METRIC lines from command output.
 * Format: METRIC name=value (one per line)
 * Example:
 *   METRIC total_µs=15200
 *   METRIC compile_µs=4200
 *
 * Names must be word chars, dots, or µ (rejects `=` and other specials).
 * Values must be finite numbers (rejects Infinity, NaN, hex, etc.).
 * Duplicate names: last occurrence wins (allows scripts to refine values).
 * Returns a Map preserving insertion order of first occurrence per key.
 */
/** Metric names that could cause prototype pollution if used as object keys */
const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function parseMetricLines(output: string): Map<string, number> {
  const metrics = new Map<string, number>();
  const regex = new RegExp(`^${METRIC_LINE_PREFIX}\\s+([\\w.µ]+)=(\\S+)\\s*$`, "gm");
  let match;
  while ((match = regex.exec(output)) !== null) {
    const name = match[1];
    if (DENIED_METRIC_NAMES.has(name)) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) {
      metrics.set(name, value);
    }
  }
  return metrics;
}

/** Format a number with comma-separated thousands: 15586 → "15,586" */
function commas(n: number): string {
  const s = String(Math.round(n));
  const parts: string[] = [];
  for (let i = s.length; i > 0; i -= 3) {
    parts.unshift(s.slice(Math.max(0, i - 3), i));
  }
  return parts.join(",");
}

/** Format number with commas, preserving one decimal for fractional values */
function fmtNum(n: number, decimals: number = 0): string {
  if (decimals > 0) {
    const int = Math.floor(Math.abs(n));
    const frac = (Math.abs(n) - int).toFixed(decimals).slice(1); // ".3"
    return (n < 0 ? "-" : "") + commas(int) + frac;
  }
  return commas(n);
}

function formatNum(value: number | null, unit: string): string {
  if (value === null) return "—";
  const u = unit || "";
  // Integers: no decimals
  if (value === Math.round(value)) return fmtNum(value) + u;
  // Fractional: 2 decimal places
  return fmtNum(value, 2) + u;
}

/** Lazy temp file allocator — returns the same path on subsequent calls */
function createTempFileAllocator(): () => string {
  let p: string | undefined;
  return () => {
    if (!p) {
      const id = randomBytes(8).toString("hex");
      p = path.join(tmpdir(), `pi-experiment-${id}.log`);
    }
    return p;
  };
}

/** Format elapsed milliseconds as "Xm XXs" or "XXs" */
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Kill a process tree (best effort, tries process group first) */
function killTree(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may have already exited
    }
  }
}

/**
 * Check if a command's primary purpose is running the benchmark script.
 *
 * Strategy: strip common harmless prefixes (env vars, env/time/nice wrappers)
 * then check that the core command is the benchmark script invoked via a known
 * pattern. Rejects chaining tricks like "evil.py; measure.sh" because we require
 * the benchmark script to be the *first* real command.
 */
export function isAutoresearchShCommand(command: string): boolean {
  let cmd = command.trim();

  // Strip leading env variable assignments: FOO=bar BAZ="qux" ...
  cmd = cmd.replace(/^(?:\w+=\S*\s+)+/, "");

  // Strip known harmless command wrappers (env, time, nice, nohup) repeatedly
  // Allows flags and their numeric values: e.g. "nice -n 10 time env ..."
  let prev: string;
  do {
    prev = cmd;
    cmd = cmd.replace(/^(?:env|time|nice|nohup)(?:\s+-\S+(?:\s+\d+)?)*\s+/, "");
  } while (cmd !== prev);

  // Now the core command must be the benchmark script via a known invocation.
  // Strip an interpreter, then require the first token to be the script itself
  // inside an autoresearch location: `.auto/experiments/<id>/measure.sh` for the
  // per-experiment layout, `.auto/measure.sh` for the pre-experiment one, and the
  // legacy `autoresearch.sh` for in-flight sessions. A chaining trick like
  // `evil.py; measure.sh` fails, because the script must come first.
  const withoutInterpreter = cmd.replace(/^(?:bash|sh|source)\s+(?:-\w+\s+)*/, "");
  const scriptPath = (withoutInterpreter.split(/\s+/)[0] ?? "").replace(/^(?:\.{1,2}\/)+/, "");

  return (
    /\.auto\/(?:experiments\/[\w.-]+\/)?measure\.sh$/.test(scriptPath) ||
    scriptPath === "autoresearch.sh" ||
    scriptPath.endsWith("/autoresearch.sh")
  );
}

function isBetter(
  current: number,
  best: number,
  direction: "lower" | "higher"
): boolean {
  return direction === "lower" ? current < best : current > best;
}

/** Compute the median of a numeric array (returns 0 for empty arrays) */
function sortedMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Compute confidence score for the best improvement vs. session noise floor.
 *
 * Uses Median Absolute Deviation (MAD) of all metric values in the current
 * segment as a robust noise estimator. Returns `|best_delta| / MAD`, where
 * best_delta is the improvement of the best kept metric over baseline.
 *
 * Returns null when there are fewer than 3 data points (insufficient data)
 * or when MAD is 0 (all values identical — no measurable noise).
 */
function computeConfidence(
  results: ExperimentResult[],
  segment: number,
  direction: "lower" | "higher"
): number | null {
  const cur = currentResults(results, segment).filter((r) => r.metric > 0);
  if (cur.length < 3) return null;

  const values = cur.map((r) => r.metric);
  const median = sortedMedian(values);
  const deviations = values.map((v) => Math.abs(v - median));
  const mad = sortedMedian(deviations);

  if (mad === 0) return null;

  const baseline = findBaselineMetric(results, segment);
  if (baseline === null) return null;

  // Find best kept metric in current segment
  let bestKept: number | null = null;
  for (const r of cur) {
    if (r.status === "keep" && r.metric > 0) {
      if (bestKept === null || isBetter(r.metric, bestKept, direction)) {
        bestKept = r.metric;
      }
    }
  }
  if (bestKept === null || bestKept === baseline) return null;

  const delta = Math.abs(bestKept - baseline);
  return delta / mad;
}

/** Get results in the current segment only */
function currentResults(results: ExperimentResult[], segment: number): ExperimentResult[] {
  return results.filter((r) => r.segment === segment);
}

interface AutoresearchConfig {
  maxIterations?: number;
  workingDir?: string;
}

/** Read the config file (.auto/config.json, legacy autoresearch.config.json) from the given directory (always ctx.cwd) */
function readConfig(cwd: string, experimentId: string | null = null): AutoresearchConfig {
  try {
    const configPath = autoresearchConfigPath(cwd, experimentId);
    if (!fs.existsSync(configPath)) return {};
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

/** Read maxExperiments from the config file (if it exists) */
function readMaxExperiments(cwd: string, experimentId: string | null = null): number | null {
  const config = readConfig(cwd, experimentId);
  return (typeof config.maxIterations === "number" && config.maxIterations > 0)
    ? Math.floor(config.maxIterations)
    : null;
}

/**
 * Resolve the effective working directory.
 * Reads workingDir from the config file (.auto/config.json) in ctxCwd.
 * Returns ctxCwd if not set. Supports relative (resolved against ctxCwd) and absolute paths.
 */
function resolveWorkDir(ctxCwd: string): string {
  const config = readConfig(ctxCwd);
  if (!config.workingDir) return ctxCwd;
  return path.isAbsolute(config.workingDir)
    ? config.workingDir
    : path.resolve(ctxCwd, config.workingDir);
}

function canonicalPath(existingPath: string): string {
  try {
    return fs.realpathSync.native(existingPath);
  } catch {
    return path.resolve(existingPath);
  }
}

function samePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
}

const AUTORESEARCH_ACTIVATION_ENTRY = "pi-autoresearch.activation";
const AUTORESEARCH_BINDING_ENTRY = "pi-autoresearch.binding";

interface AutoresearchBindingEntryData {
  version?: number;
  root?: string;
  experimentId?: string;
}

/**
 * The experiment this session is bound to, replayed from the session's own
 * entries. Scoped to the registry root so a session that moves repositories
 * does not inherit a binding from somewhere else.
 */
function recordedBinding(ctx: ExtensionContext, stateRoot: string): string | null {
  const root = canonicalPath(stateRoot);
  let experimentId: string | null = null;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom") continue;
    if (entry.customType !== AUTORESEARCH_BINDING_ENTRY) continue;

    const data = entry.data as AutoresearchBindingEntryData | undefined;
    if (!data || typeof data.experimentId !== "string") continue;
    if (typeof data.root !== "string" || canonicalPath(data.root) !== root) continue;

    experimentId = data.experimentId;
  }

  return experimentId;
}

interface AutoresearchActivationEntryData {
  version?: number;
  workDir?: string;
  experimentId?: string | null;
  active?: boolean;
}

export function shouldAutoActivateAutoresearch(
  ctxCwd: string,
  workDir: string,
  hasPersistedLog: boolean,
  recordedDecision: boolean | null = null,
): boolean {
  if (!hasPersistedLog) return false;
  // An explicit `/autoresearch on|off` in this session always wins, so a manual
  // off survives /tree, compaction, and reloads instead of snapping back on.
  if (recordedDecision !== null) return recordedDecision;
  // With no recorded decision, same-cwd sessions default on (a log implies intent);
  // redirected workingDir sessions default off until this session opts in.
  return samePath(ctxCwd, workDir);
}

function autoresearchActivationData(entry: CustomEntry): AutoresearchActivationEntryData | null {
  if (entry.customType !== AUTORESEARCH_ACTIVATION_ENTRY) return null;

  const data = entry.data as AutoresearchActivationEntryData | undefined;
  if (typeof data?.workDir !== "string") return null;

  return data;
}

/**
 * Replay an explicit `/autoresearch on|off` from this session. Matched on the
 * experiment as well as the directory: two experiments sharing a checkout each
 * keep their own on/off state.
 */
function recordedActivationDecision(
  ctx: ExtensionContext,
  workDir: string,
  experimentId: string | null = null,
): boolean | null {
  const canonicalWorkDir = canonicalPath(workDir);
  let decision: boolean | null = null;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom") continue;

    const data = autoresearchActivationData(entry);
    if (!data || typeof data.workDir !== "string") continue;
    if (canonicalPath(data.workDir) !== canonicalWorkDir) continue;
    if ((data.experimentId ?? null) !== experimentId) continue;

    decision = data.active === true;
  }

  return decision;
}

/**
 * Validate that the resolved working directory exists.
 * Returns an error message if it doesn't exist, or null if OK.
 */
function validateWorkDir(ctxCwd: string): string | null {
  const workDir = resolveWorkDir(ctxCwd);
  if (workDir === ctxCwd) return null;
  try {
    const stat = fs.statSync(workDir);
    if (!stat.isDirectory()) {
      return `workingDir "${workDir}" (from .auto/config.json) is not a directory.`;
    }
  } catch {
    return `workingDir "${workDir}" (from .auto/config.json) does not exist.`;
  }
  return null;
}

/** Baseline = first experiment in current segment */
function findBaselineMetric(results: ExperimentResult[], segment: number): number | null {
  const cur = currentResults(results, segment);
  return cur.length > 0 ? cur[0].metric : null;
}

/** Best = optimal metric across kept experiments in current segment (min for lower, max for higher) */
function findBestMetric(
  results: ExperimentResult[],
  segment: number,
  direction: "lower" | "higher",
): number | null {
  const kept = currentResults(results, segment)
    .filter((r) => r.status === "keep")
    .map((r) => r.metric);
  if (kept.length === 0) return null;
  return direction === "lower" ? Math.min(...kept) : Math.max(...kept);
}

// -----------------------------------------------------------------------
// Session file paths (single source of truth for autoresearch.* filenames)
//
// `dir` is always the state root — the main worktree holding `.auto/` — which
// is the session cwd in shared mode and the main checkout in worktree mode.
// The optional experiment id selects that experiment's private state folder.
// -----------------------------------------------------------------------

const autoresearchJsonlPath  = (dir: string, id?: string | null) => sessionFilePath(dir, "log", id);
const autoresearchMdPath     = (dir: string, id?: string | null) => sessionFilePath(dir, "prompt", id);
const autoresearchIdeasPath  = (dir: string, id?: string | null) => sessionFilePath(dir, "ideas", id);
const autoresearchChecksPath = (dir: string, id?: string | null) => sessionFilePath(dir, "checks", id);
const autoresearchScriptPath = (dir: string, id?: string | null) => sessionFilePath(dir, "measure", id);
const autoresearchConfigPath = (dir: string, id?: string | null) => sessionFilePath(dir, "config", id);

function findBaselineRunNumber(results: ExperimentResult[], segment: number): number | null {
  const index = results.findIndex((result) => result.segment === segment);
  return index >= 0 ? index + 1 : null;
}

/**
 * Find secondary metric baselines from the first experiment in current segment.
 * For metrics that didn't exist at baseline time, falls back to the first
 * occurrence of that metric in the current segment.
 */
function findBaselineSecondary(
  results: ExperimentResult[],
  segment: number,
  knownMetrics?: MetricDef[]
): Record<string, number> {
  const cur = currentResults(results, segment);
  const base: Record<string, number> = cur.length > 0
    ? { ...(cur[0].metrics ?? {}) }
    : {};

  // Fill in any known metrics missing from baseline with their first occurrence
  if (knownMetrics) {
    for (const sm of knownMetrics) {
      if (base[sm.name] === undefined) {
        for (const r of cur) {
          const val = (r.metrics ?? {})[sm.name];
          if (val !== undefined) {
            base[sm.name] = val;
            break;
          }
        }
      }
    }
  }

  return base;
}

function cloneExperimentState(state: ExperimentState): ExperimentState {
  return {
    ...state,
    results: state.results.map((result) => ({
      ...result,
      metrics: { ...result.metrics },
    })),
    secondaryMetrics: state.secondaryMetrics.map((metric) => ({ ...metric })),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function truncateDisplayText(text: string, width: number): string {
  if (width <= 0) return "";
  return truncateToWidth(text, width, "…", true);
}

function joinPartsToWidth(parts: string[], width: number): string {
  let line = "";
  for (const part of parts) {
    if (!part) continue;
    const next = line + part;
    if (visibleWidth(next) <= width) {
      line = next;
      continue;
    }
    return truncateToWidth(line || part, width, "…", true);
  }
  return truncateToWidth(line, width, "…", true);
}

function appendRightAlignedAdaptiveHint(
  left: string,
  width: number,
  theme: Theme,
  candidates: string[]
): string {
  if (width <= 0) return "";
  const leftWidth = visibleWidth(left);
  for (const candidate of candidates) {
    const hint = theme.fg("dim", ` ${candidate}`);
    const hintWidth = visibleWidth(hint);
    if (hintWidth > width) continue;
    if (leftWidth + hintWidth <= width) {
      return left + " ".repeat(Math.max(0, width - leftWidth - hintWidth)) + hint;
    }
    const availableLeftWidth = Math.max(0, width - hintWidth);
    const truncatedLeft = truncateToWidth(left, availableLeftWidth, "…", true);
    const truncatedLeftWidth = visibleWidth(truncatedLeft);
    return truncatedLeft + " ".repeat(Math.max(0, width - truncatedLeftWidth - hintWidth)) + hint;
  }
  return truncateToWidth(left, width, "…", true);
}

function getTuiSize(tui: { terminal?: { columns?: number; rows?: number } }): { width: number; height: number } {
  return {
    width: tui.terminal?.columns ?? process.stdout.columns ?? 120,
    height: tui.terminal?.rows ?? process.stdout.rows ?? 40,
  };
}

function createExperimentState(): ExperimentState {
  return {
    results: [],
    bestMetric: null,
    bestDirection: "lower",
    metricName: "metric",
    metricUnit: "",
    secondaryMetrics: [],
    name: null,
    currentSegment: 0,
    maxExperiments: null,
    confidence: null,
  };
}

function createSessionRuntime(): AutoresearchRuntime {
  return {
    autoresearchMode: false,
    experimentsThisSession: 0,
    autoResumeTurns: 0,
    lastRunChecks: null,
    lastRunDuration: null,
    runningExperiment: null,
    state: createExperimentState(),
    pendingResumeTimer: null,
    pendingResumeMessage: null,
    experimentId: null,
    stateRoot: null,
  };
}

function createRuntimeStore() {
  const runtimes = new Map<string, AutoresearchRuntime>();

  return {
    ensure(sessionKey: string): AutoresearchRuntime {
      let runtime = runtimes.get(sessionKey);
      if (!runtime) {
        runtime = createSessionRuntime();
        runtimes.set(sessionKey, runtime);
      }
      return runtime;
    },

    clear(sessionKey: string): void {
      runtimes.delete(sessionKey);
    },
  };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dashboard table renderer (pure function, no UI deps)
// ---------------------------------------------------------------------------

function renderDashboardLines(
  st: ExperimentState,
  width: number,
  th: Theme,
  maxRows: number = 6,
  headerHints: string[] = []
): string[] {
  const lines: string[] = [];

  if (st.results.length === 0) {
    lines.push(`  ${th.fg("dim", "No experiments yet.")}`);
    return lines;
  }

  const cur = currentResults(st.results, st.currentSegment);
  const kept = cur.filter((r) => r.status === "keep").length;
  const discarded = cur.filter((r) => r.status === "discard").length;
  const crashed = cur.filter((r) => r.status === "crash").length;
  const checksFailed = cur.filter((r) => r.status === "checks_failed").length;

  const baseline = st.bestMetric;
  const baselineRunNumber = findBaselineRunNumber(st.results, st.currentSegment);
  const baselineSec = findBaselineSecondary(st.results, st.currentSegment, st.secondaryMetrics);

  // Find best kept primary metric and its run number (current segment only)
  let bestPrimary: number | null = null;
  let bestSecondary: Record<string, number> = {};
  let bestRunNum = 0;
  for (let i = st.results.length - 1; i >= 0; i--) {
    const r = st.results[i];
    if (r.segment !== st.currentSegment) continue;
    if (r.status === "keep" && r.metric > 0) {
      if (bestPrimary === null || isBetter(r.metric, bestPrimary, st.bestDirection)) {
        bestPrimary = r.metric;
        bestSecondary = r.metrics ?? {};
        bestRunNum = i + 1;
      }
    }
  }

  // Runs summary
  const confSuffix = st.confidence !== null
    ? (() => {
        const confStr = st.confidence!.toFixed(1);
        const confColor: Parameters<typeof th.fg>[0] = st.confidence! >= 2.0 ? "success" : st.confidence! >= 1.0 ? "warning" : "error";
        return `  ${th.fg(confColor, `(conf: ${confStr}×)`)}`;
      })()
    : "";
  lines.push(
    truncateToWidth(
      `  ${th.fg("muted", "Runs:")} ${th.fg("text", String(st.results.length))}` +
        `  ${th.fg("success", `${kept} kept`)}` +
        confSuffix +
        (discarded > 0 ? `  ${th.fg("warning", `${discarded} discarded`)}` : "") +
        (crashed > 0 ? `  ${th.fg("error", `${crashed} crashed`)}` : "") +
        (checksFailed > 0 ? `  ${th.fg("error", `${checksFailed} checks failed`)}` : ""),
      width
    )
  );

  // Baseline: first run's primary metric
  const baselineSuffix = baselineRunNumber === null ? "" : ` #${baselineRunNumber}`;
  lines.push(
    truncateToWidth(
      `  ${th.fg("muted", "Baseline:")} ${th.fg("muted", `★ ${st.metricName}: ${formatNum(baseline, st.metricUnit)}${baselineSuffix}`)}`,
      width
    )
  );


  // Progress: best primary metric with delta + run number
  if (bestPrimary !== null) {
    let progressLine = `  ${th.fg("muted", "Progress:")} ${th.fg("warning", th.bold(`★ ${st.metricName}: ${formatNum(bestPrimary, st.metricUnit)}`))}${th.fg("dim", ` #${bestRunNum}`)}`;

    if (baseline !== null && baseline !== 0 && bestPrimary !== baseline) {
      const pct = ((bestPrimary - baseline) / baseline) * 100;
      const sign = pct > 0 ? "+" : "";
      const color = isBetter(bestPrimary, baseline, st.bestDirection) ? "success" : "error";
      progressLine += th.fg(color, ` (${sign}${pct.toFixed(1)}%)`);
    }

    lines.push(truncateToWidth(progressLine, width));

    // Progress secondary metrics — wrap into lines that fit width, indented
    if (st.secondaryMetrics.length > 0) {
      const indent = "            "; // 12 chars to align under progress value
      const maxLineW = width - 2 - indent.length; // 2 for leading "  "

      // Build individually-colored parts
      const secParts: string[] = [];
      for (const sm of st.secondaryMetrics) {
        const val = bestSecondary[sm.name];
        const bv = baselineSec[sm.name];
        if (val !== undefined) {
          let part = th.fg("muted", `${sm.name}: ${formatNum(val, sm.unit)}`);
          if (bv !== undefined && bv !== 0 && val !== bv) {
            const p = ((val - bv) / bv) * 100;
            const s = p > 0 ? "+" : "";
            const c = val <= bv ? "success" : "error";
            part += th.fg(c, ` ${s}${p.toFixed(1)}%`);
          }
          secParts.push(part);
        }
      }

      // Flow-wrap parts into lines
      if (secParts.length > 0) {
        let curLine = "";
        let curVisW = 0;
        for (const part of secParts) {
          const partVisW = visibleWidth(part);
          const sep = curLine ? "  " : "";
          if (curLine && curVisW + sep.length + partVisW > maxLineW) {
            lines.push(truncateToWidth(`  ${th.fg("dim", indent)}${curLine}`, width));
            curLine = part;
            curVisW = partVisW;
          } else {
            curLine += sep + part;
            curVisW += sep.length + partVisW;
          }
        }
        if (curLine) {
          lines.push(truncateToWidth(`  ${th.fg("dim", indent)}${curLine}`, width));
        }
      }
    }
  }

  lines.push("");

  // Determine visible rows once — used for both column sizing and rendering
  const effectiveMax = maxRows <= 0 ? st.results.length : maxRows;
  const startIdx = Math.max(0, st.results.length - effectiveMax);
  const rowsToRender = st.results.slice(startIdx);

  // Only show secondary metric columns that have at least one value in rendered rows
  const secMetrics = st.secondaryMetrics.filter((sm) =>
    rowsToRender.some((r) => (r.metrics ?? {})[sm.name] !== undefined)
  );

  // Column definitions
  // Primary column: "★ " prefix (2 visible) + metric name + 1 padding, clamped to 25% of width
  const primaryLabel = "★ " + (st.metricName || "metric");
  const primaryW = Math.max(11, Math.min(Math.floor(width * 0.25), visibleWidth(primaryLabel) + 1));
  const col = { idx: 3, commit: 8, primary: primaryW, status: 15 };
  const minDescW = Math.max(10, Math.floor(width * 0.25));
  const fixedW = col.idx + col.commit + col.primary + col.status + 6;

  // Compute each secondary column width from actual content: max(name, widest value) + 1 padding
  const secColWidths: number[] = secMetrics.map((sm) => {
    let maxW = visibleWidth(sm.name);
    for (const r of rowsToRender) {
      const val = (r.metrics ?? {})[sm.name];
      if (val !== undefined) {
        maxW = Math.max(maxW, visibleWidth(formatNum(val, sm.unit)));
      }
    }
    return maxW + 1;
  });

  const totalSecWidth = () => secColWidths.slice(0, visibleSecMetrics.length).reduce((a, b) => a + b, 0);

  // Drop secondary columns from the right until they fit
  let visibleSecMetrics = secMetrics;
  while (visibleSecMetrics.length > 0 && totalSecWidth() > width - fixedW - minDescW) {
    visibleSecMetrics = visibleSecMetrics.slice(0, -1);
  }

  const descW = Math.max(minDescW, width - fixedW - totalSecWidth());

  // Table header — primary metric name bolded with ★
  let headerLine =
    `  ${th.fg("muted", "#".padEnd(col.idx))}` +
    `${th.fg("muted", "commit".padEnd(col.commit))}` +
    `${th.fg("warning", th.bold(truncateToWidth(primaryLabel, col.primary - 1).padEnd(col.primary)))}`;

  for (let si = 0; si < visibleSecMetrics.length; si++) {
    const sm = visibleSecMetrics[si];
    headerLine += th.fg(
      "muted",
      sm.name.padEnd(secColWidths[si])
    );
  }

  headerLine +=
    `${th.fg("muted", "status".padEnd(col.status))}` +
    `${th.fg("muted", "description")}`;

  lines.push(
    headerHints.length > 0
      ? appendRightAlignedAdaptiveHint(headerLine, width, th, headerHints)
      : truncateToWidth(headerLine, width, "…", true)
  );
  lines.push(
    truncateToWidth(
      `  ${th.fg("borderMuted", "─".repeat(Math.max(0, width - 4)))}`,
      width
    )
  );

  // Baseline values for delta display (current segment only)
  const baselinePrimary = findBaselineMetric(st.results, st.currentSegment);
  const baselineSecondary = findBaselineSecondary(
    st.results,
    st.currentSegment,
    st.secondaryMetrics
  );

  // Show max 6 recent runs, with a note about hidden earlier ones
  if (startIdx > 0) {
    lines.push(
      truncateToWidth(
        `  ${th.fg("dim", `… ${startIdx} earlier run${startIdx === 1 ? "" : "s"}`)}`,
        width
      )
    );
  }

  const baselineIndex = st.results.findIndex((x) => x.segment === st.currentSegment);

  for (let i = startIdx; i < st.results.length; i++) {
    const r = st.results[i];
    const isOld = r.segment !== st.currentSegment;
    const isBaseline = !isOld && i === baselineIndex;

    const color = isOld
      ? "dim"
      : r.status === "keep"
        ? "success"
        : r.status === "crash" || r.status === "checks_failed"
          ? "error"
          : "warning";

    // Primary metric with color coding
    const primaryStr = formatNum(r.metric, st.metricUnit);
    let primaryColor: Parameters<typeof th.fg>[0] = isOld ? "dim" : "text";
    if (!isOld) {
      if (isBaseline) {
        primaryColor = "text"; // baseline row — normal text
      } else if (
        baselinePrimary !== null &&
        r.status === "keep" &&
        r.metric > 0
      ) {
        if (isBetter(r.metric, baselinePrimary, st.bestDirection)) {
          primaryColor = "success";
        } else if (r.metric !== baselinePrimary) {
          primaryColor = "error";
        }
      }
    }

    const idxStr = th.fg("dim", String(i + 1).padEnd(col.idx));
    const commitStr = isOld
      ? "(old)".padEnd(col.commit)
      : r.status !== "keep"
        ? "—".padStart(Math.ceil(col.commit / 2)).padEnd(col.commit)
        : r.commit.padEnd(col.commit);

    let rowLine =
      `  ${idxStr}` +
      `${th.fg(isOld ? "dim" : "accent", commitStr)}` +
      `${th.fg(primaryColor, isOld ? primaryStr.padEnd(col.primary) : th.bold(primaryStr.padEnd(col.primary)))}`;

    // Secondary metrics (only visible columns)
    const rowMetrics = r.metrics ?? {};
    for (let si = 0; si < visibleSecMetrics.length; si++) {
      const sm = visibleSecMetrics[si];
      const colW = secColWidths[si];
      const val = rowMetrics[sm.name];
      if (val !== undefined) {
        const secStr = formatNum(val, sm.unit);
        let secColor: Parameters<typeof th.fg>[0] = "dim";
        if (!isOld) {
          const bv = baselineSecondary[sm.name];
          if (isBaseline) {
            secColor = "text";
          } else if (bv !== undefined && bv !== 0) {
            secColor = val <= bv ? "success" : "error";
          }
        }
        rowLine += th.fg(secColor, secStr.padEnd(colW));
      } else {
        rowLine += th.fg("dim", "—".padEnd(colW));
      }
    }

    rowLine +=
      `${th.fg(color, r.status.padEnd(col.status))}` +
      `${th.fg("muted", r.description.slice(0, descW))}`;

    lines.push(truncateToWidth(rowLine, width));
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function autoresearchExtension(pi: ExtensionAPI) {
  const BENCHMARK_GUARDRAIL =
    "Be careful not to overfit to the benchmarks and do not cheat on the benchmarks.";

  // Outlasts pi's internal retry (setTimeout 0) and compaction-continue
  // (setTimeout 100); see badlogic/pi-mono#2023, #2110.
  const SETTLED_WINDOW_MS = 800;
  const shortcuts = resolveAutoresearchShortcuts();

  const dashboardHintVariants = (): string[] => {
    if (shortcuts.fullscreenDashboard) {
      return [
        `${shortcuts.fullscreenDashboard} fullscreen`,
        shortcuts.fullscreenDashboard,
      ];
    }
    return ["/autoresearch dashboard fullscreen", "/autoresearch dashboard"];
  };

  const runtimeStore = createRuntimeStore();
  const getSessionKey = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
  const getRuntime = (ctx: ExtensionContext): AutoresearchRuntime =>
    runtimeStore.ensure(getSessionKey(ctx));

  const gitRunner: GitRunner = async (args, cwd, timeoutMs = 10_000) => {
    const result = await pi.exec("git", args, { cwd, timeout: timeoutMs });
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  };

  /** Main worktree holding the registry and every `.auto/` state file. */
  const stateRoot = (ctx: ExtensionContext): string => getRuntime(ctx).stateRoot ?? ctx.cwd;

  /** Experiment this session is bound to, or null before its first use. */
  const experimentId = (ctx: ExtensionContext): string | null => getRuntime(ctx).experimentId;

  const experimentRecord = (ctx: ExtensionContext): ExperimentRecord | null => {
    const id = experimentId(ctx);
    if (!id) return null;
    return getExperiment(stateRoot(ctx), id);
  };

  /**
   * Where this experiment's code and git operations live. A worktree
   * experiment owns its directory outright; a shared experiment works in the
   * checkout the session was started in.
   */
  const codeDir = (ctx: ExtensionContext): string => {
    const record = experimentRecord(ctx);
    if (record?.mode === "worktree") return record.workDir;
    return resolveWorkDir(ctx.cwd);
  };

  const bindExperiment = (ctx: ExtensionContext, root: string, id: string): void => {
    const runtime = getRuntime(ctx);
    runtime.stateRoot = root;
    runtime.experimentId = id;
    pi.appendEntry(AUTORESEARCH_BINDING_ENTRY, {
      version: 2,
      root: canonicalPath(root),
      experimentId: id,
    });
  };

  /**
   * Resolve the experiment this session belongs to.
   *
   * A recorded binding wins; otherwise a session physically sitting inside a
   * registered worktree adopts that experiment, which is what makes relaunching
   * pi inside a worktree pick the experiment back up with no extra command.
   */
  const resolveExperiment = async (
    ctx: ExtensionContext,
  ): Promise<{ root: string; record: ExperimentRecord | null }> => {
    // Without a git repository there is no registry, so keep the pre-experiment
    // layout — which honours a `workingDir` redirect in config.json.
    const root = await resolveRegistryRoot(gitRunner, ctx.cwd) ?? resolveWorkDir(ctx.cwd);
    if (!root) return { root: ctx.cwd, record: null };

    const runtime = getRuntime(ctx);
    runtime.stateRoot = root;

    const bound = recordedBinding(ctx, root);
    if (bound) {
      const record = getExperiment(root, bound);
      if (record) {
        runtime.experimentId = record.id;
        return { root, record };
      }
    }

    // Only a worktree makes "I am sitting in this directory" a reliable signal.
    // A shared experiment shares its directory with every other shared
    // experiment by definition, so adopting one there would hand this session
    // somebody else's history.
    const byWorkDir = findExperimentByWorkDir(root, ctx.cwd);
    if (byWorkDir && byWorkDir.mode === "worktree") {
      runtime.experimentId = byWorkDir.id;
      return { root, record: byWorkDir };
    }

    return { root, record: null };
  };

  /**
   * Bind the session to an experiment, creating one on first use.
   *
   * An implicitly created experiment is always `shared`: the session is already
   * sitting in this checkout, and silently redirecting its edits into a
   * worktree it was never launched in would split code from measurement. Worktree
   * isolation is opt-in through `/autoresearch new <name>`, which scaffolds the
   * worktree and tells you to relaunch pi inside it.
   */
  const ensureExperiment = async (
    ctx: ExtensionContext,
    suggestedName?: string,
  ): Promise<{ root: string; record: ExperimentRecord }> => {
    const resolved = await resolveExperiment(ctx);
    if (resolved.record) {
      bindExperiment(ctx, resolved.root, resolved.record.id);
      return { root: resolved.root, record: resolved.record };
    }

    const root = resolved.root;
    const cwd = resolveWorkDir(ctx.cwd);

    // Under the lock so two sessions claiming an experiment for the first time
    // cannot both read the same registry and race each other's write.
    const record = await withGitLock(gitLockPath(root), async () => {
      const [head, dirty] = await Promise.all([headSha(gitRunner, cwd), dirtyEntries(gitRunner, cwd)]);
      return createExperiment(root, {
        name: suggestedName ?? null,
        mode: "shared",
        workDir: cwd,
        branch: null,
        baselineHead: head,
        baselineDirty: dirtyPaths(dirty),
      });
    });
    bindExperiment(ctx, root, record.id);
    return { root, record };
  };

  // Registering through this gates the tool, so a new one can't slip in ungated.
  const gatedToolNames = new Set<string>();

  /**
   * Decide whether the git layer may act on this working tree, and explain
   * itself when it may not.
   *
   * With no other experiment around, a shared tree behaves exactly as it always
   * has — one experiment, full repository operations, nothing to protect.
   *
   * Once a sibling is live, the tree is genuinely shared and change attribution
   * becomes guesswork: nothing distinguishes this agent's edit to a file from a
   * sibling's edit to the same file. So the rules tighten. The first result is
   * refused outright, because there is no prior claim to diff against. After
   * that, paths already claimed by a sibling are off limits and a discard is
   * refused if HEAD moved.
   */
  /**
   * Record that a result was observed. Must be called while holding the git
   * lock, so a concurrent write cannot discard this.
   *
   * A refused result still counts: the experiment has now been measured, which
   * is exactly what the first-result gate compares against. Without this the
   * gate would re-fire forever and the experiment could never commit or discard
   * anything, however many results it logged.
   */
  const countResult = (root: string, record: ExperimentRecord): void => {
    updateExperiment(root, record.id, { resultCount: record.resultCount + 1 });
  };

  const sharedTreeVerdict = (
    root: string,
    record: ExperimentRecord,
  ): { allowed: true } | { allowed: false; message: string } => {
    const siblings = concurrentExperiments(root, record.id);
    if (siblings.length === 0) return { allowed: true };

    const names = siblings.map((s) => s.id).join(", ");
    if (record.resultCount === 0) {
      return {
        allowed: false,
        message:
          `\n⚠️ Git: not touching git. Experiment "${record.id}" shares this working tree with ` +
          `${names}, and its first result cannot be told apart from their uncommitted work.\n` +
          "   The measurement is logged; the keep or discard is left to you. Revert or stage it by hand,\n" +
          "   or give this experiment its own worktree: /autoresearch new <name>",
      };
    }
    return { allowed: true };
  };

  /** Paths a sibling has already claimed; never ours to stage or revert. */
  const pathsOwnedBySiblings = (root: string, id: string): Set<string> => {
    const owned = new Set<string>();
    for (const other of listExperiments(root)) {
      if (other.id === id) continue;
      for (const p of other.claimedPaths) owned.add(p);
    }
    return owned;
  };

  /**
   * The original repository-wide commit, used whenever nothing else shares this
   * working tree. Kept as it was so a solo run behaves exactly as it did before
   * experiments existed.
   */
  const repoWideKeepCommit = async (
    workDir: string,
    commitMsg: string,
    experiment: ExperimentResult,
  ): Promise<string> => {
    try {
      const execOpts = { cwd: workDir, timeout: 10000 };
      const addResult = await pi.exec("git", ["add", "-A"], execOpts);
      if (addResult.code !== 0) {
        const addErr = (addResult.stdout + addResult.stderr).trim();
        throw new Error(`git add failed (exit ${addResult.code}): ${addErr.slice(0, 200)}`);
      }

      const diffResult = await pi.exec("git", ["diff", "--cached", "--quiet"], execOpts);
      if (diffResult.code === 0) {
        return `\n📝 Git: nothing to commit (working tree clean)`;
      }

      const gitResult = await pi.exec("git", ["commit", "-m", commitMsg], execOpts);
      const gitOutput = (gitResult.stdout + gitResult.stderr).trim();
      if (gitResult.code !== 0) {
        return `\n⚠️ Git commit failed (exit ${gitResult.code}): ${gitOutput.slice(0, 200)}`;
      }

      const newSha = await headSha(gitRunner, workDir);
      if (newSha && newSha.length >= 7) {
        experiment.commit = newSha;
      }
      return `\n📝 Git: committed — ${gitOutput.split("\n")[0] || ""}`;
    } catch (e) {
      return `\n⚠️ Git commit error: ${e instanceof Error ? e.message : String(e)}`;
    }
  };

  /** The original repository-wide revert, used whenever nothing else shares this tree. */
  const repoWideRevert = async (workDir: string): Promise<string> => {
    try {
      const revertScript = `
        git checkout -- . ':(exclude,glob)**/${AUTO_DIR}' ':(exclude,glob)**/${AUTO_DIR}/**' ':(exclude,glob)**/autoresearch.*' ':(exclude,glob)**/autoresearch.*/**'
        git clean -fd -e '${AUTO_DIR}' -e '**/${AUTO_DIR}/**' -e 'autoresearch.*' -e '**/autoresearch.*/**' 2>/dev/null
      `;
      await pi.exec("bash", ["-c", revertScript], { cwd: workDir, timeout: 10000 });
      return `\n📝 Git: reverted changes — autoresearch files preserved`;
    } catch (e) {
      return `\n⚠️ Git revert failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  };

  /**
   * Commit inside a shared working tree: stage only what this experiment
   * changed, and never `git add -A` — that would sweep a sibling's in-flight
   * work into this experiment's commit.
   */
  const scopedKeepCommit = async (
    ctx: ExtensionContext,
    record: ExperimentRecord | null,
    workDir: string,
    commitMsg: string,
    experiment: ExperimentResult,
  ): Promise<string> => {
    if (!record) return "\n⚠️ No experiment record — skipping git commit.";
    const root = stateRoot(ctx);

    try {
      return await withGitLock(gitLockPath(root), async () => {
        // Re-read under the lock: a sibling may have committed since the caller
        // built this record, and the verdict depends on live registry state.
        const fresh = getExperiment(root, record.id) ?? record;
        const verdict = sharedTreeVerdict(root, fresh);
        if (!verdict.allowed) {
          countResult(root, fresh);
          return verdict.message;
        }

        const current = await dirtyEntries(gitRunner, workDir);
        const siblingOwned = pathsOwnedBySiblings(root, fresh.id);
        const claimed = dirtyPaths(claimedBy(current, fresh.baselineDirty));
        const paths = claimed.filter((p) => !siblingOwned.has(p));
        const skipped = claimed.filter((p) => siblingOwned.has(p));

        const result = await scopedCommit(gitRunner, { cwd: workDir, paths, message: commitMsg });
        if (result.committed && result.sha) {
          experiment.commit = result.sha;
          // A clean commit is a clean slate for the next run's attribution.
          updateExperiment(root, fresh.id, {
            baselineHead: result.sha,
            baselineDirty: [],
            claimedPaths: [],
            resultCount: fresh.resultCount + 1,
          });
          return `\n📝 Git: committed ${result.staged.length} file(s) — ${result.message}`;
        }
        updateExperiment(root, fresh.id, {
          claimedPaths: paths,
          resultCount: fresh.resultCount + 1,
        });
        const skipNote = skipped.length > 0
          ? `\n   Left alone (claimed by another experiment): ${skipped.join(", ")}`
          : "";
        return `\n📝 Git: ${result.message}${skipNote}`;
      });
    } catch (e) {
      return `\n⚠️ Git commit error: ${e instanceof Error ? e.message : String(e)}`;
    }
  };

  /**
   * Discard inside a shared working tree: undo only this experiment's files,
   * and refuse outright when HEAD moved under us.
   */
  const scopedDiscard = async (
    ctx: ExtensionContext,
    record: ExperimentRecord | null,
    workDir: string,
  ): Promise<string> => {
    if (!record) {
      return "\n⚠️ No experiment record — refusing to discard in a shared working tree.";
    }
    const root = stateRoot(ctx);

    try {
      return await withGitLock(gitLockPath(root), async () => {
        const fresh = getExperiment(root, record.id) ?? record;
        const verdict = sharedTreeVerdict(root, fresh);
        if (!verdict.allowed) {
          countResult(root, fresh);
          return verdict.message;
        }

        const [current, headNow] = await Promise.all([
          dirtyEntries(gitRunner, workDir),
          headSha(gitRunner, workDir),
        ]);
        const siblingOwned = pathsOwnedBySiblings(root, fresh.id);
        const all = dirtyPaths(claimedBy(current, fresh.baselineDirty));
        const paths = all.filter((p) => !siblingOwned.has(p));

        const result = await scopedRevert(gitRunner, {
          cwd: workDir,
          paths,
          headBefore: fresh.baselineHead,
          headNow,
        });

        if (!result.reverted) {
          const keepNote = all.length > paths.length
            ? `\n   Left alone (claimed by another experiment): ${all.filter((p) => siblingOwned.has(p)).join(", ")}`
            : "";
          return result.reason
            ? `\n⚠️ Git: ${result.reason}${keepNote}`
            : `\n📝 Git: nothing to revert${keepNote}`;
        }
        if (result.failed.length > 0) {
          return `\n⚠️ Git: reverted ${result.restored.length + result.removed.length} file(s), ` +
            `but could not revert: ${result.failed.join(", ")}`;
        }
        updateExperiment(root, fresh.id, { claimedPaths: [], resultCount: fresh.resultCount + 1 });
        return (
          `\n📝 Git: reverted ${result.restored.length} changed and ${result.removed.length} new file(s)` +
          " — autoresearch files preserved"
        );
      });
    } catch (e) {
      return `\n⚠️ Git revert failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  };

  const registerGatedTool = (tool: Parameters<typeof pi.registerTool>[0]): void => {
    gatedToolNames.add(tool.name);
    pi.registerTool(tool);
  };

  // The one place mode flips: gated tools follow the flag, never drifting from it.
  const setAutoresearchMode = (ctx: ExtensionContext, enabled: boolean): void => {
    getRuntime(ctx).autoresearchMode = enabled;
    const activeTools = new Set(pi.getActiveTools()); // setActiveTools replaces the whole set
    for (const tool of gatedToolNames) {
      enabled ? activeTools.add(tool) : activeTools.delete(tool);
    }
    pi.setActiveTools([...activeTools]);
  };

  const recordAutoresearchActivation = (
    ctx: ExtensionContext,
    workDir: string,
    active: boolean,
  ): void => {
    pi.appendEntry(AUTORESEARCH_ACTIVATION_ENTRY, {
      version: 2,
      workDir: canonicalPath(workDir),
      experimentId: experimentId(ctx),
      active,
    });
  };

  const isAgentSettled = (ctx: ExtensionContext): boolean =>
    ctx.isIdle() && !ctx.hasPendingMessages();

  const hasPendingResume = (runtime: AutoresearchRuntime): boolean =>
    runtime.pendingResumeMessage !== null;

  const pausePendingResume = (runtime: AutoresearchRuntime): void => {
    if (!runtime.pendingResumeTimer) return;
    clearTimeout(runtime.pendingResumeTimer);
    runtime.pendingResumeTimer = null;
  };

  const cancelPendingResume = (runtime: AutoresearchRuntime): void => {
    pausePendingResume(runtime);
    runtime.pendingResumeMessage = null;
  };

  const markAutoResumeSent = (runtime: AutoresearchRuntime): void => {
    runtime.autoResumeTurns++;
  };

  const sendPendingResumeIfReady = (ctx: ExtensionContext, runtime: AutoresearchRuntime): void => {
    const message = runtime.pendingResumeMessage;

    if (!message) return;
    if (!runtime.autoresearchMode) {
      cancelPendingResume(runtime);
      return;
    }
    if (!isAgentSettled(ctx)) return;
    const stopReason = autoResumeStopReasonFor(runtime);
    if (stopReason !== null) {
      cancelPendingResume(runtime);
      notifyAutoResumeLimitReached(ctx, stopReason);
      return;
    }

    cancelPendingResume(runtime);
    markAutoResumeSent(runtime);
    pi.sendUserMessage(message);
  };

  const schedulePendingResume = (ctx: ExtensionContext, runtime: AutoresearchRuntime, message: string): void => {
    pausePendingResume(runtime);
    runtime.pendingResumeMessage = message;
    runtime.pendingResumeTimer = setTimeout(
      () => sendPendingResumeIfReady(ctx, runtime),
      SETTLED_WINDOW_MS,
    );
  };

  const reschedulePendingResume = (ctx: ExtensionContext, runtime: AutoresearchRuntime): void => {
    if (!hasPendingResume(runtime)) return;
    schedulePendingResume(ctx, runtime, runtime.pendingResumeMessage!);
  };

  const hasRunExperimentsThisSession = (runtime: AutoresearchRuntime): boolean =>
    runtime.experimentsThisSession > 0;

  // Why the experiment gate: a chat-only turn would otherwise loop forever,
  // because every agent_end would re-prompt the agent, which would chat again.
  const shouldAutoResumeAfterTurn = (runtime: AutoresearchRuntime): boolean =>
    runtime.autoresearchMode && hasRunExperimentsThisSession(runtime);

  const shouldAutoResumeAfterCompact = (runtime: AutoresearchRuntime): boolean =>
    runtime.autoresearchMode;

  const notifyAutoResumeLimitReached = (ctx: ExtensionContext, reason?: string | null): void => {
    ctx.ui.notify(reason ?? `Autoresearch auto-resume limit reached`, "info");
  };

  const composeResumeMessage = (_ctx: ExtensionContext): string => {
    return [
      "Run the next iteration now.",
      "Use the persisted autoresearch state as needed, pick the most promising hypothesis, then call run_experiment + log_experiment.",
      BENCHMARK_GUARDRAIL,
    ].join(" ");
  };

  const composeCompactionResumeMessage = (_ctx: ExtensionContext): string => {
    // The compaction summary already contains the rules, ideas, and recent
    // runs — so this resume message just kicks the loop forward.
    return [
      "Run the next iteration now.",
      "Pick the most promising hypothesis from the ideas backlog or the latest `next:` hints in recent runs, then call run_experiment + log_experiment.",
      "Do not re-read .auto/prompt.md or .auto/log.jsonl — the compaction summary already contains them.",
      BENCHMARK_GUARDRAIL,
    ].join(" ");
  };

  const autoresearchCompactionFor = (
    ctx: ExtensionContext,
    event: SessionBeforeCompactEvent,
  ) => {
    if (!getRuntime(ctx).autoresearchMode) return undefined;
    return {
      compaction: {
        summary: buildAutoresearchCompactionSummary(
          autoresearchSummaryPathsFor(stateRoot(ctx), experimentId(ctx)),
        ),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  };

  // Without `expandPromptTemplates` a `/skill:<name>` kickoff reaches the model as literal text.
  const sendWhenReady = (ctx: ExtensionContext, message: string): void => {
    if (ctx.isIdle()) {
      pi.sendUserMessage(message, { expandPromptTemplates: true });
      return;
    }
    pi.sendUserMessage(message, { expandPromptTemplates: true, deliverAs: "followUp" });
  };

  const hasAutoresearchRules = (ctx: ExtensionContext): boolean =>
    fs.existsSync(autoresearchMdPath(stateRoot(ctx), experimentId(ctx)));

  const readJsonlLines = (ctx: ExtensionContext): string[] => {
    const jsonlPath = autoresearchJsonlPath(stateRoot(ctx), experimentId(ctx));
    if (!fs.existsSync(jsonlPath)) return [];
    return fs.readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
  };

  const readLastRun = (ctx: ExtensionContext): Record<string, unknown> | null => {
    const id = experimentId(ctx);
    const lines = readJsonlLines(ctx);
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = parseJsonlEntry(lines[i]);
      if (isAutoresearchRunEntry(entry) && entryBelongsToExperiment(entry, id)) return entry;
    }
    return null;
  };

  const buildSessionSnapshot = (ctx: ExtensionContext, state: ExperimentState): SessionSnapshot => ({
    experiment: experimentId(ctx),
    metric_name: state.metricName,
    metric_unit: state.metricUnit,
    direction: state.bestDirection,
    baseline_metric: state.bestMetric,
    best_metric: findBestMetric(state.results, state.currentSegment, state.bestDirection),
    run_count: state.results.length,
    goal: state.name ?? "",
  });

  const fireHook = async (ctx: ExtensionContext, payload: HookPayload): Promise<string | null> => {
    const result = await runHook(payload);
    appendHookLogEntryIfConfigured(
      autoresearchJsonlPath(stateRoot(ctx), payload.experiment),
      payload.event,
      result,
      payload.experiment,
    );
    return steerMessageFor(payload.event, result);
  };

  // Running experiment state (for spinner in fullscreen overlay).
  // Tagged with the owning session so one session's shutdown cannot tear down
  // an overlay another session in this process is still driving.
  let overlayTui: { requestRender: () => void } | null = null;
  let overlaySessionKey: string | null = null;
  let spinnerInterval: ReturnType<typeof setInterval> | null = null;
  let spinnerFrame = 0;
  const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  const ownsOverlay = (ctx?: ExtensionContext): boolean =>
    ctx === undefined || overlaySessionKey === null || overlaySessionKey === getSessionKey(ctx);

  const claimOverlay = (ctx: ExtensionContext, tui: { requestRender: () => void }): void => {
    if (!ownsOverlay(ctx)) return;
    overlayTui = tui;
    overlaySessionKey = getSessionKey(ctx);
  };

  const requestOverlayRender = (ctx: ExtensionContext): void => {
    if (ownsOverlay(ctx)) overlayTui?.requestRender();
  };

  const clearOverlay = (ctx?: ExtensionContext) => {
    if (!ownsOverlay(ctx)) return;
    overlayTui = null;
    overlaySessionKey = null;
    if (spinnerInterval) {
      clearInterval(spinnerInterval);
      spinnerInterval = null;
    }
  };

  const clearSessionUi = (ctx: ExtensionContext) => {
    clearOverlay(ctx);
    if (ctx.hasUI) {
      ctx.ui.setWidget("autoresearch", undefined);
    }
  };

  const autoresearchHelp = () =>
    [
      "Usage: /autoresearch [off|clear|export|dashboard|list|new|join|drop|<text>]",
      "",
      "<text> enters autoresearch mode and starts or resumes the loop.",
      "  A session that has not claimed an experiment gets its own on first use.",
      "off leaves autoresearch mode.",
      "clear deletes this experiment's log and turns autoresearch mode off.",
      "export opens a local live dashboard for this experiment in your browser.",
      "dashboard opens the fullscreen dashboard overlay in the terminal.",
      "",
      "list shows every experiment in this repository (* marks this session).",
      "new <name> creates an experiment in its own git worktree — full isolation.",
      "new <name> --shared creates one in this checkout, with scoped git operations.",
      "join <id> binds this session to an existing experiment.",
      "drop <id> removes an experiment, its state, and its worktree.",

      "",
      "Running two experiments at once? Give each its own worktree:",
      "  /autoresearch new parser-speed          # then: cd .auto/worktrees/parser-speed && pi",
      "  /autoresearch new render-cache --shared  # if a second checkout is not possible",
      "",
      "Examples:",
      "  /autoresearch optimize unit test runtime, monitor correctness",
      "  /autoresearch model training, run 5 minutes of train.py and note the loss ratio as optimization target",
      "  /autoresearch list",
      "  /autoresearch export",
      "  /autoresearch dashboard",
    ].join("\n");

  // -----------------------------------------------------------------------
  // State reconstruction
  // -----------------------------------------------------------------------

  const reconstructState = async (ctx: ExtensionContext) => {
    const runtime = getRuntime(ctx);
    cancelPendingResume(runtime);

    // Work out which experiment this session is before touching any state, so
    // a session never reconstructs from a sibling's log.
    await resolveExperiment(ctx);
    runtime.lastRunChecks = null;
    runtime.lastRunDuration = null;
    runtime.runningExperiment = null;
    runtime.experimentsThisSession = 0;
    runtime.autoResumeTurns = 0;
    runtime.state = createExperimentState();

    let state = runtime.state;

    // State lives in the main worktree; the experiment id selects this
    // session's private folder inside it.
    const root = stateRoot(ctx);
    const id = experimentId(ctx);
    const workDir = codeDir(ctx);

    // Primary: read from .auto/log.jsonl (alongside .auto/prompt.md and .auto/measure.sh)
    const jsonlPath = autoresearchJsonlPath(root, id);
    const hasPersistedLog = fs.existsSync(jsonlPath);
    let loadedFromJsonl = false;
    try {
      if (hasPersistedLog) {
        const reconstructed = reconstructJsonlState(fs.readFileSync(jsonlPath, "utf-8"), id);
        state.name = reconstructed.name;
        state.metricName = reconstructed.metricName;
        state.metricUnit = reconstructed.metricUnit;
        state.bestDirection = reconstructed.bestDirection;
        state.currentSegment = reconstructed.currentSegment;
        state.results = reconstructed.results.map((result) => ({
          ...result,
          metrics: { ...result.metrics },
        }));
        state.secondaryMetrics = reconstructed.secondaryMetrics.map((metric) => ({ ...metric }));

        if (state.results.length > 0) {
          loadedFromJsonl = true;
          state.bestMetric = findBaselineMetric(state.results, state.currentSegment);
          state.confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection);
        }
      }
    } catch {
      // Fall through to session history
    }

    // Fallback: reconstruct from session history (backward compat)
    if (!loadedFromJsonl) {
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "message") continue;
        const msg = entry.message;
        if (msg.role !== "toolResult" || msg.toolName !== "log_experiment")
          continue;
        const details = msg.details as LogDetails | undefined;
        if (details?.state && (details.experimentId === undefined || details.experimentId === id)) {
          runtime.state = cloneExperimentState(details.state);
          state = runtime.state;
          if (!state.secondaryMetrics) state.secondaryMetrics = [];
          if (state.metricUnit === "s" && state.metricName === "metric") {
            state.metricUnit = "";
          }
          for (const r of state.results) {
            if (!r.metrics) r.metrics = {};
            if (r.confidence === undefined) r.confidence = null;
          }
          if (state.confidence === undefined) {
            state.confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection);
          }
        }
      }
    }


    // Read max experiments from config file
    state.maxExperiments = readMaxExperiments(ctx.cwd, id);

    // Auto-enter autoresearch mode only when a persisted experiment log exists.
    // A recorded `/autoresearch on|off` in this session wins; otherwise a session
    // sitting in its own worktree defaults on, and a shared-directory session
    // defaults on too — but only for the experiment it is actually bound to, so
    // an unrelated chat in the same checkout never adopts someone else's run.
    setAutoresearchMode(
      ctx,
      shouldAutoActivateAutoresearch(
        ctx.cwd,
        workDir,
        hasPersistedLog,
        recordedActivationDecision(ctx, workDir, id),
      ),
    );

    updateWidget(ctx);
  };

  const updateWidget = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    const runtime = getRuntime(ctx);
    const state = runtime.state;
    const id = experimentId(ctx);

    if (!runtime.autoresearchMode) {
      ctx.ui.setWidget("autoresearch", undefined);
      return;
    }

    if (state.results.length === 0) {
      if (!runtime.runningExperiment) {
        ctx.ui.setWidget("autoresearch", undefined);
        return;
      }

      ctx.ui.setWidget("autoresearch", (tui, theme) => ({
        render(width: number): string[] {
          const safeWidth = Math.max(1, width || getTuiSize(tui).width);
          const runningLine = joinPartsToWidth(
            [
              theme.fg("accent", "🔬"),
              theme.fg("warning", " running…"),
              state.name ? theme.fg("dim", ` │ ${state.name}`) : "",
              theme.fg("dim", ` │ ${runtime.runningExperiment?.command ?? ""}`),
              theme.fg("dim", " │ waiting for first logged result"),
            ],
            safeWidth
          );
          return [runningLine];
        },
        invalidate(): void {},
      }));
      return;
    }

    // Full dashboard table rendered as widget
    ctx.ui.setWidget("autoresearch", (tui, theme) => ({
        render(width: number): string[] {
          const safeWidth = Math.max(1, width || getTuiSize(tui).width);
          const title = truncateDisplayText(
            `🔬 autoresearch${id ? ` [${id}]` : ""}${state.name ? `: ${state.name}` : ""}`,
            Math.max(0, safeWidth - 5)
          );
          const fillLen = Math.max(0, safeWidth - 3 - 1 - visibleWidth(title) - 1);
          const rows = safeWidth < 95 ? 4 : 6;

          return [
            truncateToWidth(
              theme.fg("borderMuted", "───") +
                theme.fg("accent", ` ${title} `) +
                theme.fg("borderMuted", "─".repeat(fillLen)),
              safeWidth,
              "…",
              true
            ),
            ...renderDashboardLines(
              state,
              safeWidth,
              theme,
              rows,
              dashboardHintVariants()
            ),
          ];
        },
        invalidate(): void {},
      }));
  };

  pi.on("session_start", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_tree", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_before_switch", async (_e, ctx) => {
    clearOverlay(ctx);
  });
  pi.on("session_shutdown", async (_e, ctx) => {
    clearSessionUi(ctx);
    cancelPendingResume(getRuntime(ctx));
    const ownedTheServer = dashboardServerSessionKey === getSessionKey(ctx);
    runtimeStore.clear(getSessionKey(ctx));
    // Only tear down the export server this session started; another session
    // sharing this process may still be streaming from it.
    if (ownedTheServer) stopDashboardServer();
  });

  pi.on("agent_start", async (_event, ctx) => {
    const runtime = getRuntime(ctx);
    runtime.experimentsThisSession = 0;
    pausePendingResume(runtime);
  });

  const ensurePendingResume = (
    ctx: ExtensionContext,
    gate: (runtime: AutoresearchRuntime) => boolean,
    composeMessage: (ctx: ExtensionContext) => string = composeResumeMessage,
  ): void => {
    const runtime = getRuntime(ctx);
    if (hasPendingResume(runtime)) {
      reschedulePendingResume(ctx, runtime);
      return;
    }
    if (!gate(runtime)) return;
    const stopReason = autoResumeStopReasonFor(runtime);
    if (stopReason !== null) {
      notifyAutoResumeLimitReached(ctx, stopReason);
      return;
    }
    schedulePendingResume(ctx, runtime, composeMessage(ctx));
  };

  pi.on("session_before_compact", async (event, ctx) => {
    pausePendingResume(getRuntime(ctx));
    return autoresearchCompactionFor(ctx, event);
  });

  pi.on("session_compact", async (_event, ctx) => {
    ensurePendingResume(ctx, shouldAutoResumeAfterCompact, composeCompactionResumeMessage);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const runtime = getRuntime(ctx);
    runtime.runningExperiment = null;
    if (overlayTui) overlayTui.requestRender();
    ensurePendingResume(ctx, shouldAutoResumeAfterTurn);
  });

  // When in autoresearch mode, add a static note to the system prompt.
  // Only a short pointer — no file content, fully cache-safe.
  pi.on("before_agent_start", async (event, ctx) => {
    const runtime = getRuntime(ctx);
    if (!runtime.autoresearchMode) return;

    const mdPath = autoresearchMdPath(stateRoot(ctx), experimentId(ctx));
    const ideasPath = autoresearchIdeasPath(stateRoot(ctx), experimentId(ctx));
    const hasIdeas = fs.existsSync(ideasPath);

    const checksPath = autoresearchChecksPath(stateRoot(ctx), experimentId(ctx));
    const hasChecks = fs.existsSync(checksPath);

    const measurePath = autoresearchScriptPath(stateRoot(ctx), experimentId(ctx));
    const hasMeasure = fs.existsSync(measurePath);

    const id = experimentId(ctx);
    const modeNote = experimentRecord(ctx)?.mode === "worktree"
      ? "\nThis experiment owns a dedicated git worktree; its commits and discards cannot affect other experiments."
      : "\nThis experiment shares a working tree with any others in this repo. Only edit files this experiment owns — a commit that touches another experiment's files is refused, and a discard is refused if another experiment moved HEAD.";

    let extra =
      "\n\n## Autoresearch Mode (ACTIVE)" +
      "\nYou are in autoresearch mode. Optimize the primary metric through an autonomous experiment loop." +
      "\nUse init_experiment, run_experiment, and log_experiment tools. NEVER STOP until interrupted." +
      (id ? `\nExperiment id: ${id}.` : "") +
      modeNote +
      // The benchmark lives with the state in the main worktree, while commands
      // run in the experiment's code directory — so a relative path to it does
      // not resolve in worktree mode. Hand over the absolute path.
      (hasMeasure
        ? `\nBenchmark: run it as \`${measurePath}\`. Use this absolute path, not a relative one.`
        : "") +
      `\nExperiment rules: ${mdPath} — read this file at the start of every session and after compaction.` +
      `\nWrite promising but deferred optimizations as bullet points to ${ideasPath} — don't let good ideas get lost.` +
      `\n${BENCHMARK_GUARDRAIL}` +
      "\nIf the user sends a follow-on message while an experiment is running, finish the current run_experiment + log_experiment cycle first, then address their message in the next iteration.";

    if (hasChecks) {
      extra +=
        "\n\n## Backpressure Checks (ACTIVE)" +
        `\n${checksPath} exists and runs automatically after every passing benchmark in run_experiment.` +
        "\nIf the benchmark passes but checks fail, run_experiment will report it clearly." +
        "\nUse status 'checks_failed' in log_experiment when this happens — it behaves like a crash (no commit, changes auto-reverted)." +
        "\nYou cannot use status 'keep' when checks have failed." +
        "\nThe checks execution time does NOT affect the primary metric.";
    }

    if (hasIdeas) {
      extra += `\n\n💡 Ideas backlog exists at ${ideasPath} — check it for promising experiment paths. Prune stale entries.`;
    }

    return {
      systemPrompt: event.systemPrompt + extra,
    };
  });

  // -----------------------------------------------------------------------
  // init_experiment tool — one-time setup
  // -----------------------------------------------------------------------

  registerGatedTool({
    name: "init_experiment",
    label: "Init Experiment",
    description:
      "Initialize the experiment session. Call once before the first run_experiment to set the name, primary metric, unit, and direction. Writes the config header to .auto/log.jsonl.",
    promptSnippet:
      "Initialize experiment session (name, metric, unit, direction). Call once before first run.",
    promptGuidelines: [
      "Call init_experiment exactly once at the start of an autoresearch session, before the first run_experiment.",
      "If the session log (.auto/log.jsonl) already exists with a config, do NOT call init_experiment again.",
      "If the optimization target changes (different benchmark, metric, or workload), call init_experiment again to insert a new config header and reset the baseline.",
    ],
    parameters: InitParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      const state = runtime.state;

      // Validate working directory exists
      const workDirError = validateWorkDir(ctx.cwd);
      if (workDirError) {
        return {
          content: [{ type: "text", text: `❌ ${workDirError}` }],
          details: {},
        };
      }

      const isReinit = state.results.length > 0;

      // First tool call in a session claims an experiment; every later write
      // is stamped so a sibling session can never read or clobber it.
      const { root, record } = await ensureExperiment(ctx, params.name);
      const id = record.id;
      const workDir = codeDir(ctx);
      const jsonlPath = autoresearchJsonlPath(root, id);
      if (record.name === null) updateExperiment(root, id, { name: params.name });

      state.name = params.name;
      state.metricName = params.metric_name;
      state.metricUnit = params.metric_unit ?? "";
      if (params.direction === "lower" || params.direction === "higher") {
        state.bestDirection = params.direction;
      }
      // Start a new segment — keep history for dashboard, but reset baseline tracking.
      // Old results remain accessible (filtered by segment in rendering).
      if (isReinit) {
        state.currentSegment++;
      }
      state.bestMetric = null;
      state.secondaryMetrics = [];
      state.confidence = null;

      // Read max experiments from config file (config always in ctx.cwd)
      state.maxExperiments = readMaxExperiments(ctx.cwd, id);

      // Write config header to jsonl (append for re-init, create for first)
      try {
        ensureParentDir(jsonlPath);
        const config = JSON.stringify({
          type: "config",
          experiment: id,
          name: state.name,
          metricName: state.metricName,
          metricUnit: state.metricUnit,
          bestDirection: state.bestDirection,
        });
        if (fs.existsSync(jsonlPath)) {
          fs.appendFileSync(jsonlPath, config + "\n");
        } else {
          fs.writeFileSync(jsonlPath, config + "\n");
        }
        broadcastDashboardUpdate(jsonlPath);
      } catch (e) {
        return {
          content: [{
            type: "text",
            text: `⚠️ Failed to write .auto/log.jsonl: ${e instanceof Error ? e.message : String(e)}`,
          }],
          details: {},
        };
      }

      const wasInactive = !runtime.autoresearchMode;
      recordAutoresearchActivation(ctx, workDir, true);
      setAutoresearchMode(ctx, true);
      updateWidget(ctx);

      if (wasInactive) {
        const steer = await fireHook(ctx, {
          event: "before",
          cwd: workDir,
          state_root: root,
          experiment: id,
          next_run: state.results.length + 1,
          last_run: readLastRun(ctx),
          session: buildSessionSnapshot(ctx, state),
        });
        if (steer) pi.sendUserMessage(steer, { deliverAs: "steer" });
      }

      const reinitNote = isReinit ? " (re-initialized — previous results archived, new baseline needed)" : "";
      const limitNote = state.maxExperiments !== null ? `\nMax iterations: ${state.maxExperiments} (from .auto/config.json)` : "";
      const workDirNote = workDir !== ctx.cwd ? `\nWorking directory: ${workDir}` : "";
      const isolationNote = record.mode === "worktree"
        ? ""
        : "\n⚠️ Shared working tree: commits and discards are scoped to the files this experiment changed, and a discard is refused if another experiment moved HEAD. Use '/autoresearch new <name>' for full worktree isolation.";
      return {
        content: [{
          type: "text",
          text: `✅ Experiment initialized: "${state.name}"${reinitNote}\nExperiment id: ${id}\nMetric: ${state.metricName} (${state.metricUnit || "unitless"}, ${state.bestDirection} is better)${limitNote}${workDirNote}\nConfig written to .auto/experiments/${id}/log.jsonl. Now run the baseline with run_experiment.${isolationNote}`,
        }],
        details: { experimentId: id, state: cloneExperimentState(state) },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("init_experiment "));
      text += theme.fg("accent", args.name ?? "");
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const t = result.content[0];
      return new Text(t?.type === "text" ? t.text : "", 0, 0);
    },
  });

  // -----------------------------------------------------------------------
  // run_experiment tool
  // -----------------------------------------------------------------------

  registerGatedTool({
    name: "run_experiment",
    label: "Run Experiment",
    description:
      `Run a shell command as an experiment. Times wall-clock duration, captures output, detects pass/fail via exit code. Output is truncated to last ${EXPERIMENT_MAX_LINES} lines or ${EXPERIMENT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Use for any autoresearch experiment.`,
    promptSnippet:
      "Run a timed experiment command (captures duration, output, exit code)",
    promptGuidelines: [
      "Use run_experiment instead of bash when running experiment commands — it handles timing and output capture automatically.",
      "After run_experiment, always call log_experiment to record the result.",
      "If the benchmark script outputs structured METRIC lines (e.g. 'METRIC total_µs=15200'), run_experiment will parse them automatically and suggest exact values for log_experiment. Use these parsed values directly instead of extracting them manually from the output.",

    ],
    parameters: RunParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      const state = runtime.state;

      // Validate working directory exists
      const workDirError = validateWorkDir(ctx.cwd);
      if (workDirError) {
        return {
          content: [{ type: "text", text: `❌ ${workDirError}` }],
          details: {},
        };
      }
      // Runs happen in the experiment's own code directory: a worktree
      // experiment measures its worktree, a shared one measures this checkout.
      const root = stateRoot(ctx);
      const id = experimentId(ctx);
      const workDir = codeDir(ctx);

      // Block if max experiments limit already reached
      if (state.maxExperiments !== null) {
        const segCount = currentResults(state.results, state.currentSegment).length;
        if (segCount >= state.maxExperiments) {
          return {
            content: [{ type: "text", text: `🛑 Maximum experiments reached (${state.maxExperiments}). The experiment loop is done. To continue, call init_experiment to start a new segment.` }],
            details: {},
          };
        }
      }

      const timeout = (params.timeout_seconds ?? 600) * 1000;

      // Guard: if the benchmark script exists, only allow running it
      const autoresearchShPath = autoresearchScriptPath(root, id);
      const benchmarkScriptRel = path.relative(workDir, autoresearchShPath) || path.basename(autoresearchShPath);
      if (fs.existsSync(autoresearchShPath) && !isAutoresearchShCommand(params.command)) {
        return {
          content: [{
            type: "text",
            text: `❌ ${benchmarkScriptRel} exists — you must run it instead of a custom command.\n\nFound: ${autoresearchShPath}\nYour command: ${params.command}\n\nUse the absolute path: run_experiment({ command: "bash ${autoresearchShPath}" })\nA relative path will not resolve — the benchmark lives with the session state, which is not inside this experiment's code directory.`,
          }],
          details: {
            command: params.command,
            exitCode: null,
            durationSeconds: 0,
            passed: false,
            crashed: true,
            timedOut: false,
            tailOutput: "",
            checksPass: null,
            checksTimedOut: false,
            checksOutput: "",
            checksDuration: 0,
          } as RunDetails,
        };
      }

      // TODO(/tree): replace compaction-based resume with a checkpoint-per-iteration model.
      runtime.runningExperiment = { startedAt: Date.now(), command: params.command };
      updateWidget(ctx);
      requestOverlayRender(ctx);

      const t0 = Date.now();

      // Spawn the process directly (like the bash tool) for streaming output
      const getTempFile = createTempFileAllocator();
      const { exitCode, killed: timedOut, output, tempFilePath: streamTempFile, actualTotalBytes } = await new Promise<{
        exitCode: number | null;
        killed: boolean;
        output: string;
        tempFilePath: string | undefined;
        actualTotalBytes: number;
      }>((resolve, reject) => {
        let processTimedOut = false;

        const child = spawn("bash", ["-c", params.command], {
          cwd: workDir,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        // Rolling buffer for tail truncation (keep 2x what we need)
        const chunks: Buffer[] = [];
        let chunksBytes = 0;
        const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

        // Temp file for full output when it overflows
        let tempFilePath: string | undefined;
        let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
        let totalBytes = 0;

        // Cache for Buffer.concat — only rebuild when chunks change
        let chunksGeneration = 0;
        let cachedGeneration = -1;
        let cachedText = "";

        function getBufferText(): string {
          if (cachedGeneration === chunksGeneration) return cachedText;
          cachedText = Buffer.concat(chunks).toString("utf-8");
          cachedGeneration = chunksGeneration;
          return cachedText;
        }

        // Timer interval — update every second with elapsed time + tail output
        const timerInterval = setInterval(() => {
          if (!onUpdate) return;
          const elapsed = formatElapsed(Date.now() - t0);
          const trunc = truncateTail(getBufferText(), {
            maxLines: DEFAULT_MAX_LINES,
            maxBytes: DEFAULT_MAX_BYTES,
          });
          onUpdate({
            content: [{ type: "text", text: trunc.content || "" }],
            details: {
              phase: "running",
              elapsed,
              truncation: trunc.truncated ? trunc : undefined,
              fullOutputPath: tempFilePath,
            },
          });
        }, 1000);

        const handleData = (data: Buffer) => {
          totalBytes += data.length;

          // Start writing to temp file once we exceed the threshold
          if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
            tempFilePath = getTempFile();
            tempFileStream = createWriteStream(tempFilePath);
            for (const chunk of chunks) {
              tempFileStream.write(chunk);
            }
          }

          if (tempFileStream) {
            tempFileStream.write(data);
          }

          // Keep rolling buffer of recent data
          chunks.push(data);
          chunksBytes += data.length;

          // Evict old chunks, then trim the first surviving chunk to a line
          // boundary. This avoids splitting multi-byte UTF-8 characters that
          // straddle chunk boundaries (which would produce U+FFFD on decode).
          while (chunksBytes > maxChunksBytes && chunks.length > 1) {
            const removed = chunks.shift()!;
            chunksBytes -= removed.length;
          }
          // Trim first surviving chunk to a newline boundary
          if (chunks.length > 0 && chunksBytes > maxChunksBytes) {
            const buf = chunks[0];
            const nlIdx = buf.indexOf(0x0a); // '\n'
            if (nlIdx !== -1 && nlIdx < buf.length - 1) {
              chunks[0] = buf.subarray(nlIdx + 1);
              chunksBytes -= nlIdx + 1;
            }
          }

          chunksGeneration++;
        };

        if (child.stdout) child.stdout.on("data", handleData);
        if (child.stderr) child.stderr.on("data", handleData);

        // Timeout
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        if (timeout > 0) {
          timeoutHandle = setTimeout(() => {
            processTimedOut = true;
            if (child.pid) killTree(child.pid);
          }, timeout);
        }

        // Abort signal — kill immediately if pid exists, otherwise queue for spawn.
        // Using child.kill() as fallback ensures the signal is never silently swallowed.
        const onAbort = () => {
          if (child.pid) killTree(child.pid);
          else {
            // pid not yet assigned — try child.kill() which works without pid,
            // and also queue killTree for spawn in case child.kill() isn't enough
            // to clean up the full process tree.
            child.kill();
            child.once("spawn", () => { if (child.pid) killTree(child.pid); });
          }
        };
        if (signal) {
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener("abort", onAbort, { once: true });
          }
        }

        child.on("error", (err) => {
          clearInterval(timerInterval);
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (signal) signal.removeEventListener("abort", onAbort);
          if (tempFileStream) tempFileStream.end();
          reject(err);
        });

        child.on("close", (code) => {
          clearInterval(timerInterval);
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (signal) signal.removeEventListener("abort", onAbort);
          if (tempFileStream) tempFileStream.end();

          if (signal?.aborted) {
            reject(new Error("aborted"));
            return;
          }

          const fullBuffer = Buffer.concat(chunks);
          resolve({
            exitCode: code,
            killed: processTimedOut,
            output: fullBuffer.toString("utf-8"),
            tempFilePath,
            actualTotalBytes: totalBytes,
          });
        });
      }).finally(() => {
        runtime.runningExperiment = null;
        updateWidget(ctx);
        requestOverlayRender(ctx);
      });

      const durationSeconds = (Date.now() - t0) / 1000;
      runtime.lastRunDuration = durationSeconds;
      const benchmarkPassed = exitCode === 0 && !timedOut;

      // Run backpressure checks if benchmark passed and checks file exists
      let checksPass: boolean | null = null;
      let checksTimedOut = false;
      let checksOutput = "";
      let checksDuration = 0;

      const checksPath = autoresearchChecksPath(root, id);
      if (benchmarkPassed && fs.existsSync(checksPath)) {
        const checksTimeout = (params.checks_timeout_seconds ?? 300) * 1000;
        const ct0 = Date.now();
        try {
          const checksResult = await pi.exec("bash", [checksPath], {
            signal,
            timeout: checksTimeout,
            cwd: workDir,
          });
          checksDuration = (Date.now() - ct0) / 1000;
          checksTimedOut = !!checksResult.killed;
          checksPass = checksResult.code === 0 && !checksResult.killed;
          checksOutput = (checksResult.stdout + "\n" + checksResult.stderr).trim();
        } catch (e) {
          checksDuration = (Date.now() - ct0) / 1000;
          checksPass = false;
          checksOutput = e instanceof Error ? e.message : String(e);
        }
      }

      // Store checks result for log_experiment gate
      runtime.lastRunChecks = checksPass !== null ? { pass: checksPass, output: checksOutput, duration: checksDuration } : null;

      const passed = benchmarkPassed && (checksPass === null || checksPass);

      // Reuse streaming temp file if it exists, otherwise create one for large output
      let fullOutputPath: string | undefined = streamTempFile;
      const totalLines = output.split("\n").length;
      if (!fullOutputPath && (actualTotalBytes > EXPERIMENT_MAX_BYTES || totalLines > EXPERIMENT_MAX_LINES)) {
        fullOutputPath = getTempFile();
        fs.writeFileSync(fullOutputPath, output);
      }

      // Wider truncation for TUI display (details.tailOutput)
      const displayTruncation = truncateTail(output, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      // Tight truncation for LLM context (10 lines / 4KB)
      const llmTruncation = truncateTail(output, {
        maxLines: EXPERIMENT_MAX_LINES,
        maxBytes: EXPERIMENT_MAX_BYTES,
      });

      // Parse structured METRIC lines from output
      const parsedMetricMap = parseMetricLines(output);
      const parsedMetrics = parsedMetricMap.size > 0
        ? Object.fromEntries(parsedMetricMap)
        : null;
      const parsedPrimary = parsedMetricMap.get(state.metricName) ?? null;

      const details: RunDetails = {
        command: params.command,
        exitCode,
        durationSeconds,
        passed,
        crashed: !passed,
        timedOut,
        tailOutput: displayTruncation.content,
        checksPass,
        checksTimedOut,
        checksOutput: checksOutput.split("\n").slice(-80).join("\n"),
        checksDuration,
        parsedMetrics,
        parsedPrimary,
        metricName: state.metricName,
        metricUnit: state.metricUnit,
      };

      // Build LLM response
      let text = "";
      if (details.timedOut) {
        text += `⏰ TIMEOUT after ${durationSeconds.toFixed(1)}s\n`;
      } else if (!benchmarkPassed) {
        text += `💥 FAILED (exit code ${exitCode}) in ${durationSeconds.toFixed(1)}s\n`;
        // A worktree experiment's benchmark lives with the state in the main
        // worktree, so a relative path to it cannot resolve from the code
        // directory. Say so instead of leaving a bare "No such file".
        if (isAutoresearchShCommand(params.command)) {
          text +=
            `The benchmark exists at ${autoresearchShPath} but this command could not run it.\n` +
            `Use its absolute path: run_experiment({ command: "bash ${autoresearchShPath}" })\n`;
        }
      } else if (checksTimedOut) {
        text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
        text += `⏰ CHECKS TIMEOUT (.auto/checks.sh) after ${checksDuration.toFixed(1)}s\n`;
        text += `Log this as 'checks_failed' — the benchmark metric is valid but checks timed out.\n`;
      } else if (checksPass === false) {
        text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
        text += `💥 CHECKS FAILED (.auto/checks.sh) in ${checksDuration.toFixed(1)}s\n`;
        text += `Log this as 'checks_failed' — the benchmark metric is valid but correctness checks did not pass.\n`;
      } else {
        text += `✅ PASSED in ${durationSeconds.toFixed(1)}s\n`;
        if (checksPass === true) {
          text += `✅ Checks passed in ${checksDuration.toFixed(1)}s\n`;
        }
      }

      if (state.bestMetric !== null) {
        text += `📊 Current best ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}\n`;
      }

      // Show parsed METRIC lines to the LLM
      if (parsedMetrics) {
        const secondary = Object.entries(parsedMetrics).filter(([k]) => k !== state.metricName);

        // Human-readable summary
        text += `\n📐 Parsed metrics:`;
        if (parsedPrimary !== null) {
          text += ` ★ ${state.metricName}=${formatNum(parsedPrimary, state.metricUnit)}`;
        }
        for (const [name, value] of secondary) {
          // Infer unit from name suffix for display
          const sm = state.secondaryMetrics.find((m) => m.name === name);
          const unit = sm?.unit ?? "";
          text += ` ${name}=${formatNum(value, unit)}`;
        }

        // Machine-ready values for log_experiment (raw numbers, not formatted)
        text += `\nUse these values directly in log_experiment (metric: ${parsedPrimary ?? "?"}, metrics: {${secondary.map(([k, v]) => `"${k}": ${v}`).join(", ")}})\n`;
      }

      text += `\n${llmTruncation.content}`;

      if (llmTruncation.truncated) {
        if (llmTruncation.truncatedBy === "lines") {
          text += `\n\n[Showing last ${llmTruncation.outputLines} of ${llmTruncation.totalLines} lines.`;
        } else {
          text += `\n\n[Showing last ${llmTruncation.outputLines} lines (${formatSize(EXPERIMENT_MAX_BYTES)} limit).`;
        }
        if (fullOutputPath) {
          text += ` Full output: ${fullOutputPath}`;
        }
        text += `]`;
      }

      if (checksPass === false) {
        text += `\n\n── Checks output (last 80 lines) ──\n${details.checksOutput}`;
      }

      return {
        content: [{ type: "text", text }],
        details: { ...details, truncation: llmTruncation.truncated ? llmTruncation : undefined, fullOutputPath },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("run_experiment "));
      text += theme.fg("muted", args.command);
      if (args.timeout_seconds) {
        text += theme.fg("dim", ` (timeout: ${args.timeout_seconds}s)`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const PREVIEW_LINES = 5;

      if (isPartial) {
        // Streaming: show elapsed timer + tail of output
        const d = result.details as { phase?: string; elapsed?: string; truncation?: any; fullOutputPath?: string } | undefined;
        const elapsed = d?.elapsed ?? "";
        const outputText = result.content[0]?.type === "text" ? result.content[0].text : "";

        let text = theme.fg("warning", `⏳ Running${elapsed ? ` ${elapsed}` : ""}…`);

        // Always show tail of streaming output (like bash tool shows preview lines)
        if (outputText) {
          const lines = outputText.split("\n");
          const maxLines = expanded ? 20 : PREVIEW_LINES;
          const tail = lines.slice(-maxLines).join("\n");
          if (tail.trim()) {
            text += "\n" + theme.fg("dim", tail);
          }
        }

        return new Text(text, 0, 0);
      }

      const d = result.details as (RunDetails & { truncation?: any; fullOutputPath?: string }) | undefined;
      if (!d) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "", 0, 0);
      }

      // Helper: append tail output preview or full output
      const appendOutput = (text: string, output: string): string => {
        if (!output) return text;
        const lines = output.split("\n");
        if (expanded) {
          text += "\n" + theme.fg("dim", output.slice(-2000));
        } else {
          const tail = lines.slice(-PREVIEW_LINES).join("\n");
          if (tail.trim()) {
            const hidden = lines.length - PREVIEW_LINES;
            if (hidden > 0) {
              text += "\n" + theme.fg("muted", `… ${hidden} more lines`);
            }
            text += "\n" + theme.fg("dim", tail);
          }
        }
        return text;
      };

      if (d.timedOut) {
        let text = theme.fg("error", `⏰ TIMEOUT ${d.durationSeconds.toFixed(1)}s`);
        text = appendOutput(text, d.tailOutput);
        return new Text(text, 0, 0);
      }

      // Helper: format parsed primary metric suffix (empty string if not available)
      const parsedSuffix = d.parsedPrimary !== null
        ? theme.fg("accent", `, ${d.metricName}: ${formatNum(d.parsedPrimary, d.metricUnit)}`)
        : "";

      if (d.checksTimedOut) {
        let text =
          theme.fg("success", `✅ wall: ${d.durationSeconds.toFixed(1)}s`) +
          parsedSuffix +
          theme.fg("error", ` ⏰ checks timeout ${d.checksDuration.toFixed(1)}s`);
        text = appendOutput(text, d.checksOutput);
        return new Text(text, 0, 0);
      }

      if (d.checksPass === false) {
        let text =
          theme.fg("success", `✅ wall: ${d.durationSeconds.toFixed(1)}s`) +
          parsedSuffix +
          theme.fg("error", ` 💥 checks failed ${d.checksDuration.toFixed(1)}s`);
        text = appendOutput(text, d.checksOutput);
        return new Text(text, 0, 0);
      }

      if (d.crashed) {
        let text = theme.fg("error", `💥 FAIL exit=${d.exitCode} ${d.durationSeconds.toFixed(1)}s`) + parsedSuffix;
        text = appendOutput(text, d.tailOutput);
        return new Text(text, 0, 0);
      }

      let text = theme.fg("success", "✅ ");

      // Show wall-clock and parsed primary metric together
      const parts: string[] = [`wall: ${d.durationSeconds.toFixed(1)}s`];
      if (d.parsedPrimary !== null) {
        parts.push(`${d.metricName}: ${formatNum(d.parsedPrimary, d.metricUnit)}`);
      }
      text += theme.fg("accent", parts.join(", "));

      if (d.checksPass === true) {
        text += theme.fg("success", ` ✓ checks ${d.checksDuration.toFixed(1)}s`);
      }

      if (d.truncation?.truncated && d.fullOutputPath) {
        text += theme.fg("warning", " (truncated)");
      }

      text = appendOutput(text, d.tailOutput);

      if (expanded && d.truncation?.truncated && d.fullOutputPath) {
        if (d.truncation.truncatedBy === "lines") {
          text += "\n" + theme.fg("warning", `[Truncated: showing ${d.truncation.outputLines} of ${d.truncation.totalLines} lines. Full output: ${d.fullOutputPath}]`);
        } else {
          text += "\n" + theme.fg("warning", `[Truncated: ${d.truncation.outputLines} lines shown (${formatSize(EXPERIMENT_MAX_BYTES)} limit). Full output: ${d.fullOutputPath}]`);
        }
      }

      return new Text(text, 0, 0);
    },
  });

  // -----------------------------------------------------------------------
  // log_experiment tool
  // -----------------------------------------------------------------------

  registerGatedTool({
    name: "log_experiment",
    label: "Log Experiment",
    description:
      "Record an experiment result. Tracks metrics, updates the status widget and dashboard. Call after every run_experiment.",
    promptSnippet:
      "Log experiment result (commit, metric, status, description)",
    promptGuidelines: [
      "Always call log_experiment after run_experiment to record the result.",
      "log_experiment automatically runs git add -A && git commit on 'keep', and auto-reverts code changes on 'discard'/'crash'/'checks_failed' (autoresearch files are preserved). Do NOT commit or revert manually.",
      "Use status 'keep' if the PRIMARY metric improved. 'discard' if worse or unchanged. 'crash' if it failed. Secondary metrics are for monitoring — they almost never affect keep/discard. Only discard a primary improvement if a secondary metric degraded catastrophically, and explain why in the description.",
      "log_experiment reports a confidence score after 3+ runs (best improvement as a multiple of the noise floor). ≥2.0× = likely real, <1.0× = within noise. If confidence is below 1.0×, consider re-running the same experiment to confirm before keeping. The score is advisory — it never auto-discards.",
      "If you discover complex but promising optimizations you won't pursue immediately, append them as bullet points to .auto/ideas.md. Don't let good ideas get lost.",
      "Always include the asi parameter. At minimum: {\"hypothesis\": \"what you tried\"}. On discard/crash, also include rollback_reason and next_action_hint. Add any other key/value pairs that capture what you learned — dead ends, surprising findings, error details, bottlenecks. This is the only structured memory that survives reverts.",
      "When log_experiment records a retry of a previously discarded idea after its assumptions changed, set asi.revisits_run to the earlier run number (a positive integer) and explain what changed in description. Omit revisits_run for new ideas and verification reruns.",
    ],
    parameters: LogParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      const state = runtime.state;

      // Validate working directory exists
      const workDirError = validateWorkDir(ctx.cwd);
      if (workDirError) {
        return {
          content: [{ type: "text", text: `❌ ${workDirError}` }],
          details: {},
        };
      }
      const root = stateRoot(ctx);
      const id = experimentId(ctx);
      const workDir = codeDir(ctx);
      const record = experimentRecord(ctx);
      const secondaryMetrics = params.metrics ?? {};

      // Gate: prevent "keep" when last run's checks failed
      if (params.status === "keep" && runtime.lastRunChecks && !runtime.lastRunChecks.pass) {
        return {
          content: [{
            type: "text",
            text: `❌ Cannot keep — .auto/checks.sh failed.\n\n${runtime.lastRunChecks.output.slice(-500)}\n\nLog as 'checks_failed' instead. The benchmark metric is valid but correctness checks did not pass.`,
          }],
          details: {},
        };
      }

      // Validate secondary metrics consistency (after first experiment establishes them)
      if (state.secondaryMetrics.length > 0) {
        const knownNames = new Set(state.secondaryMetrics.map((m) => m.name));
        const providedNames = new Set(Object.keys(secondaryMetrics));

        // Check for missing metrics
        const missing = [...knownNames].filter((n) => !providedNames.has(n));
        if (missing.length > 0) {
          return {
            content: [{
              type: "text",
              text: `❌ Missing secondary metrics: ${missing.join(", ")}\n\nYou must provide all previously tracked metrics. Expected: ${[...knownNames].join(", ")}\nGot: ${[...providedNames].join(", ") || "(none)"}\n\nFix: include ${missing.map((m) => `"${m}": <value>`).join(", ")} in the metrics parameter.`,
            }],
            details: {},
          };
        }

        // Check for new metrics not yet tracked
        const newMetrics = [...providedNames].filter((n) => !knownNames.has(n));
        if (newMetrics.length > 0 && !params.force) {
          return {
            content: [{
              type: "text",
              text: `❌ New secondary metric${newMetrics.length > 1 ? "s" : ""} not previously tracked: ${newMetrics.join(", ")}\n\nExisting metrics: ${[...knownNames].join(", ")}\n\nIf this metric has proven very valuable to watch, call log_experiment again with force: true to add it. Otherwise, remove it from the metrics parameter.`,
            }],
            details: {},
          };
        }
      }

      // ASI: agent-supplied free-form diagnostics
      const mergedASI = (params.asi && Object.keys(params.asi).length > 0)
        ? params.asi as ASI
        : undefined;

      const experiment: ExperimentResult = {
        commit: params.commit.slice(0, 7),
        metric: params.metric,
        metrics: secondaryMetrics,
        status: params.status,
        description: params.description,
        timestamp: Date.now(),
        segment: state.currentSegment,
        confidence: null,
        asi: mergedASI,
      };

      state.results.push(experiment);
      runtime.experimentsThisSession++;

      // Register any new secondary metric names
      for (const name of Object.keys(secondaryMetrics)) {
        if (!state.secondaryMetrics.find((m) => m.name === name)) {
          let unit = "";
          if (name.endsWith("µs")) unit = "µs";
          else if (name.endsWith("_ms")) unit = "ms";
          else if (name.endsWith("_s") || name.endsWith("_sec")) unit = "s";
          else if (name.endsWith("_kb")) unit = "kb";
          else if (name.endsWith("_mb")) unit = "mb";
          state.secondaryMetrics.push({ name, unit });
        }
      }

      // Baseline = first run in current segment
      state.bestMetric = findBaselineMetric(state.results, state.currentSegment);

      // Compute confidence score (best improvement as multiple of noise floor)
      state.confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection);
      experiment.confidence = state.confidence;

      // Build response text
      const segmentCount = currentResults(state.results, state.currentSegment).length;
      let text = `Logged #${state.results.length}: ${experiment.status} — ${experiment.description}`;

      if (state.bestMetric !== null) {
        text += `\nBaseline ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}`;
        if (segmentCount > 1 && params.status === "keep" && params.metric > 0) {
          const delta = params.metric - state.bestMetric;
          const pct = ((delta / state.bestMetric) * 100).toFixed(1);
          const sign = delta > 0 ? "+" : "";
          text += ` | this: ${formatNum(params.metric, state.metricUnit)} (${sign}${pct}%)`;
        }
      }

      // Show secondary metrics
      if (Object.keys(secondaryMetrics).length > 0) {
        const baselines = findBaselineSecondary(state.results, state.currentSegment, state.secondaryMetrics);
        const parts: string[] = [];
        for (const [name, value] of Object.entries(secondaryMetrics)) {
          const def = state.secondaryMetrics.find((m) => m.name === name);
          const unit = def?.unit ?? "";
          let part = `${name}: ${formatNum(value, unit)}`;
          const bv = baselines[name];
          if (bv !== undefined && state.results.length > 1 && bv !== 0) {
            const d = value - bv;
            const p = ((d / bv) * 100).toFixed(1);
            const s = d > 0 ? "+" : "";
            part += ` (${s}${p}%)`;
          }
          parts.push(part);
        }
        text += `\nSecondary: ${parts.join("  ")}`;
      }

      // Show ASI summary
      if (mergedASI) {
        const asiParts: string[] = [];
        for (const [k, v] of Object.entries(mergedASI)) {
          const s = typeof v === "string" ? v : JSON.stringify(v);
          asiParts.push(`${k}: ${s.length > 80 ? s.slice(0, 77) + "…" : s}`);
        }
        if (asiParts.length > 0) {
          text += `\n📋 ASI: ${asiParts.join(" | ")}`;
        }
      }

      // Show confidence score
      if (state.confidence !== null) {
        const confStr = state.confidence.toFixed(1);
        if (state.confidence >= 2.0) {
          text += `\n📊 Confidence: ${confStr}× noise floor — improvement is likely real`;
        } else if (state.confidence >= 1.0) {
          text += `\n📊 Confidence: ${confStr}× noise floor — improvement is above noise but marginal`;
        } else {
          text += `\n⚠️ Confidence: ${confStr}× noise floor — improvement is within noise. Consider re-running to confirm before keeping.`;
        }
      }

      text += `\n(${segmentCount} experiments`;
      if (state.maxExperiments !== null) {
        text += ` / ${state.maxExperiments} max`;
      }
      text += `)`;

      // Git strategy is decided once, from the shape of the working tree.
      //
      // A worktree experiment owns its tree outright, and a shared experiment
      // with no live sibling has nothing to protect — both keep the original
      // repository-wide behaviour. Only a shared experiment sharing its checkout
      // with a live sibling needs the scoped, locked path, because repository-wide
      // operations there would reach into somebody else's experiment.
      const siblings = record ? concurrentExperiments(root, record.id) : [];
      const repoWideGit = record === null || record.mode === "worktree" || siblings.length === 0;

      if (params.status === "keep") {
        const resultData: Record<string, unknown> = {
          status: params.status,
          [state.metricName || "metric"]: params.metric,
          ...secondaryMetrics,
        };
        const commitMsg = `${params.description}\n\nResult: ${JSON.stringify(resultData)}`;

        if (repoWideGit) {
          text += await repoWideKeepCommit(workDir, commitMsg, experiment);
          if (record) updateExperiment(root, record.id, { resultCount: record.resultCount + 1 });
        } else {
          text += await scopedKeepCommit(ctx, record, workDir, commitMsg, experiment);
        }
      }

      const jsonlEntry: Record<string, unknown> = {
        run: state.results.length,
        ...(id ? { experiment: id } : {}),
        ...experiment,
      };
      if (!mergedASI) delete jsonlEntry.asi;
      const jsonlLine = JSON.stringify(jsonlEntry);

      try {
        const jsonlPath = autoresearchJsonlPath(root, id);
        ensureParentDir(jsonlPath);
        fs.appendFileSync(jsonlPath, jsonlLine + "\n");
        broadcastDashboardUpdate(jsonlPath);
      } catch (e) {
        text += `\n⚠️ Failed to write .auto/log.jsonl: ${e instanceof Error ? e.message : String(e)}`;
      }

      if (params.status !== "keep") {
        if (repoWideGit) {
          text += await repoWideRevert(workDir);
          if (record) updateExperiment(root, record.id, { resultCount: record.resultCount + 1 });
        } else {
          text += await scopedDiscard(ctx, record, workDir);
        }
      }

      const afterSteer = await fireHook(ctx, {
        event: "after",
        cwd: workDir,
        state_root: root,
        experiment: id,
        run_entry: jsonlEntry,
        session: buildSessionSnapshot(ctx, state),
      });
      if (afterSteer) pi.sendUserMessage(afterSteer, { deliverAs: "steer" });

      const wallClockSeconds = runtime.lastRunDuration;
      runtime.runningExperiment = null;
      runtime.lastRunChecks = null;
      runtime.lastRunDuration = null;

      const limitReached = state.maxExperiments !== null && segmentCount >= state.maxExperiments;
      if (limitReached) {
        text += `\n\n🛑 Maximum experiments reached (${state.maxExperiments}). STOP the experiment loop now.`;
        recordAutoresearchActivation(ctx, workDir, false);
        setAutoresearchMode(ctx, false);
        ctx.abort();
      } else if (runtime.autoresearchMode) {
        text += "\n\nBefore choosing the next experiment, consider whether this result or discovery invalidates a previous discard's rollback reason. If so, name what changed and weigh a targeted retry against other candidates. Otherwise, move on. Don't revive a discarded idea without a changed assumption. Verification reruns to resolve measurement noise are separate.";
        const beforeSteer = await fireHook(ctx, {
          event: "before",
          cwd: workDir,
          state_root: root,
          experiment: id,
          next_run: state.results.length + 1,
          last_run: jsonlEntry,
          session: buildSessionSnapshot(ctx, state),
        });
        if (beforeSteer) pi.sendUserMessage(beforeSteer, { deliverAs: "steer" });
      }

      updateWidget(ctx);

      // Refresh fullscreen overlay if open
      requestOverlayRender(ctx);

      return {
        content: [{ type: "text", text }],
        details: {
          experiment: { ...experiment, metrics: { ...experiment.metrics } },
          state: cloneExperimentState(state),
          wallClockSeconds,
        } as LogDetails,
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("log_experiment "));
      const color =
        args.status === "keep"
          ? "success"
          : args.status === "crash" || args.status === "checks_failed"
            ? "error"
            : "warning";
      text += theme.fg(color, args.status);
      text += " " + theme.fg("dim", args.description);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const d = result.details as LogDetails | undefined;
      if (!d) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "", 0, 0);
      }

      const { experiment: exp, state: s } = d;
      const color =
        exp.status === "keep"
          ? "success"
          : exp.status === "crash" || exp.status === "checks_failed"
            ? "error"
            : "warning";
      const icon =
        exp.status === "keep" ? "✓" : exp.status === "crash" ? "✗" : exp.status === "checks_failed" ? "⚠" : "–";

      let text =
        theme.fg(color, `${icon} `) +
        theme.fg("accent", `#${s.results.length}`);

      // Show wall-clock and primary metric together
      const metricParts: string[] = [];
      if (d.wallClockSeconds !== null && d.wallClockSeconds !== undefined) {
        metricParts.push(`wall: ${d.wallClockSeconds.toFixed(1)}s`);
      }
      if (exp.metric > 0) {
        metricParts.push(`${s.metricName}: ${formatNum(exp.metric, s.metricUnit)}`);
      }
      if (metricParts.length > 0) {
        text += theme.fg("dim", " (") + theme.fg("warning", metricParts.join(theme.fg("dim", ", "))) + theme.fg("dim", ")");
      }

      text += " " + theme.fg("muted", exp.description);

      // Show best metric for context (overall best, not just this run)
      if (s.bestMetric !== null) {
        // Find the actual best kept metric in the current segment
        let best = s.bestMetric;
        for (const r of s.results) {
          if (r.segment === s.currentSegment && r.status === "keep" && r.metric > 0) {
            if (isBetter(r.metric, best, s.bestDirection)) best = r.metric;
          }
        }
        text +=
          theme.fg("dim", " │ ") +
          theme.fg("warning", `★ best: ${formatNum(best, s.metricUnit)}`);
      }

      // Show secondary metrics inline
      if (Object.keys(exp.metrics).length > 0) {
        const parts: string[] = [];
        for (const [name, value] of Object.entries(exp.metrics)) {
          const def = s.secondaryMetrics.find((m) => m.name === name);
          parts.push(`${name}=${formatNum(value, def?.unit ?? "")}`);
        }
        text += theme.fg("dim", `  ${parts.join(" ")}`);
      }

      const revisitsRun = exp.asi?.revisits_run;
      if (typeof revisitsRun === "number" && Number.isInteger(revisitsRun) && revisitsRun > 0) {
        text += "\n" + theme.fg("accent", `↻ Revisiting #${revisitsRun}`);
      }

      return new Text(text, 0, 0);
    },
  });

  // -----------------------------------------------------------------------
  // Fullscreen scrollable dashboard overlay
  // -----------------------------------------------------------------------

  function canOpenFullscreenDashboard(ctx: ExtensionContext): boolean {
    const mode = (ctx as ExtensionContext & { mode?: string }).mode;
    return mode === undefined ? ctx.hasUI : mode === "tui";
  }

  async function openFullscreenDashboard(ctx: ExtensionContext): Promise<void> {
    if (!canOpenFullscreenDashboard(ctx)) {
      ctx.ui.notify("The fullscreen dashboard is only available in TUI mode", "info");
      return;
    }

    const runtime = getRuntime(ctx);
    const state = runtime.state;
    if (!runtime.autoresearchMode) {
      ctx.ui.notify("Autoresearch mode is not active", "info");
      return;
    }
    if (state.results.length === 0) {
      ctx.ui.notify("No experiments yet", "info");
      return;
    }

    await ctx.ui.custom<void>(
      (tui, theme, _kb, done) => {
      let scrollOffset = 0;
      let lastViewportRows = 8;
      let lastTotalRows = 0;
      claimOverlay(ctx, tui);

      spinnerInterval = setInterval(() => {
        spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
        if (runtime.runningExperiment) tui.requestRender();
      }, 80);

      const buildOverlayContent = (renderWidth: number): string[] => {
        const content = renderDashboardLines(state, renderWidth, theme, 0);
        if (runtime.runningExperiment) {
          const elapsed = formatElapsed(Date.now() - runtime.runningExperiment.startedAt);
          const frame = SPINNER[spinnerFrame % SPINNER.length];
          const nextIdx = state.results.length + 1;
          content.push(
            truncateToWidth(
              `  ${theme.fg("dim", String(nextIdx).padEnd(3))}` +
                theme.fg("warning", `${frame} running… ${elapsed}`),
              renderWidth,
              "…",
              true
            )
          );
        }
        return content;
      };

      return {
        render(width: number): string[] {
          const { height } = getTuiSize(tui);
          const safeWidth = Math.max(1, width || getTuiSize(tui).width);
          // Match overlayOptions.maxHeight so pi doesn't clip the footer.
          const overlayRows = Math.max(4, Math.floor(height * 0.9));
          const viewportRows = Math.max(1, overlayRows - 3);
          const content = buildOverlayContent(Math.max(4, safeWidth - 2));

          const totalRows = content.length;
          const maxScroll = Math.max(0, totalRows - viewportRows);
          scrollOffset = clamp(scrollOffset, 0, maxScroll);
          lastViewportRows = viewportRows;
          lastTotalRows = totalRows;

          const out: string[] = [];

          // Full box border: the overlay floats over the transcript, so every
          // row must be padded to full width or the background bleeds through.
          const innerWidth = Math.max(4, safeWidth - 2);
          const border = (text: string) => theme.fg("border", text);
          const boxRow = (line: string): string => {
            const clipped = truncateToWidth(line, innerWidth, "…", true);
            const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
            return border("│") + clipped + pad + border("│");
          };

          const title = truncateDisplayText(
            `🔬 autoresearch${state.name ? `: ${state.name}` : ""}`,
            Math.max(0, innerWidth - 2)
          );

          out.push(border(`╭${"─".repeat(innerWidth)}╮`));
          out.push(boxRow(` ${theme.fg("accent", title)}`));

          const visible = content.slice(scrollOffset, scrollOffset + viewportRows);
          for (const line of visible) out.push(boxRow(line));
          for (let i = visible.length; i < viewportRows; i++) out.push(boxRow(""));

          const scrollInfo = totalRows > viewportRows
            ? ` ${scrollOffset + 1}-${Math.min(scrollOffset + viewportRows, totalRows)}/${totalRows}`
            : "";
          const helpText = safeWidth >= 85
            ? ` ↑↓/j/k scroll • pgup/pgdn • g/G • esc close${scrollInfo} `
            : ` j/k scroll • esc close${scrollInfo} `;
          const footFill = Math.max(0, safeWidth - 2 - visibleWidth(helpText));

          out.push(
            truncateToWidth(
              border("╰" + "─".repeat(footFill)) + theme.fg("dim", helpText) + border("╯"),
              safeWidth,
              "…",
              true
            )
          );

          return out;
        },

        handleInput(data: string): void {
          const maxScroll = Math.max(0, lastTotalRows - lastViewportRows);

          if (matchesKey(data, "escape") || data === "q") {
            done(undefined);
            return;
          }
          if (matchesKey(data, "up") || data === "k") {
            scrollOffset = Math.max(0, scrollOffset - 1);
          } else if (matchesKey(data, "down") || data === "j") {
            scrollOffset = Math.min(maxScroll, scrollOffset + 1);
          } else if (matchesKey(data, "pageUp") || data === "u") {
            scrollOffset = Math.max(0, scrollOffset - lastViewportRows);
          } else if (matchesKey(data, "pageDown") || data === "d") {
            scrollOffset = Math.min(maxScroll, scrollOffset + lastViewportRows);
          } else if (data === "g") {
            scrollOffset = 0;
          } else if (data === "G") {
            scrollOffset = maxScroll;
          }
          tui.requestRender();
        },

        invalidate(): void {},

        dispose(): void {
          clearOverlay();
        },
      };
      },
      {
        overlay: true,
        overlayOptions: {
          width: "95%",
          maxHeight: "90%",
          anchor: "center" as const,
        },
      }
    );
  }

  // -----------------------------------------------------------------------
  // Opt-in keyboard shortcuts (none bound by default; see shortcuts.ts)
  // -----------------------------------------------------------------------

  const shortcutActions: Record<
    (typeof SHORTCUT_ACTIONS)[number],
    { description: string; handler: (ctx: ExtensionContext) => Promise<void> | void }
  > = {
    fullscreenDashboard: {
      description: "Fullscreen autoresearch dashboard",
      handler: openFullscreenDashboard,
    },
    export: {
      description: "Open the autoresearch browser dashboard",
      handler: (ctx) => exportDashboard(ctx),
    },
    off: {
      description: "Turn autoresearch mode off",
      handler: (ctx) => turnAutoresearchOff(ctx),
    },
  };

  for (const action of SHORTCUT_ACTIONS) {
    const chord = shortcuts[action];
    if (chord) pi.registerShortcut(chord, shortcutActions[action]);
  }

  // -----------------------------------------------------------------------
  // Export: local live dashboard
  // -----------------------------------------------------------------------

  const TITLE_PLACEHOLDER = "__AUTORESEARCH_TITLE__";
  const LOGO_PLACEHOLDER = "__AUTORESEARCH_LOGO__";

  let cachedPackageRoot: string | null = null;

  function packageRoot(): string {
    if (cachedPackageRoot) return cachedPackageRoot;
    const extensionDir = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
    cachedPackageRoot = path.resolve(extensionDir, "../..");
    return cachedPackageRoot;
  }

  function templatePath(): string {
    return path.join(packageRoot(), "assets/template.html");
  }

  function readTemplate(): string {
    return fs.readFileSync(templatePath(), "utf-8");
  }

  let cachedLogoDataUrl: string | null = null;

  function logoDataUrl(): string {
    if (cachedLogoDataUrl) return cachedLogoDataUrl;
    const logoPath = path.join(packageRoot(), "assets/logo.webp");
    const bytes = fs.readFileSync(logoPath);
    cachedLogoDataUrl = `data:image/webp;base64,${bytes.toString("base64")}`;
    return cachedLogoDataUrl;
  }

  function readJsonlContent(workDir: string, experimentId: string | null = null): string {
    const jsonlPath = autoresearchJsonlPath(workDir, experimentId);
    try {
      return fs.readFileSync(jsonlPath, "utf-8").trim();
    } catch {
      // The log can be created between the export pre-check and here, and a
      // missing file just means an empty dashboard.
      return "";
    }
  }

  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function injectDataIntoTemplate(template: string, title: string): string {
    const escapedTitle = escapeHtml(title);
    return template.replace(TITLE_PLACEHOLDER, () => escapedTitle);
  }

  let dashboardServer: Server | null = null;
  let dashboardServerPort: number | null = null;
  let dashboardServerWorkDir: string | null = null;
  let dashboardServerHtmlPath: string | null = null;
  /** Session that started the export server; only it may stop it. */
  let dashboardServerSessionKey: string | null = null;
  /** Exact log file the running server streams, so it can never serve a sibling's. */
  let dashboardServerJsonlPath: string | null = null;
  const dashboardSseClients = new Set<ServerResponse>();

  function openInBrowser(url: string): void {
    const child = process.platform === "win32"
      ? spawn("cmd", ["/c", "start", "", url], {
          detached: true,
          shell: true,
          stdio: "ignore",
        })
      : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
          detached: true,
          stdio: "ignore",
        });
    // Swallow launcher errors (e.g. xdg-open missing); caller prints the URL
    // so the user can open it manually.
    child.on("error", () => { /* ignore */ });
    child.unref();
  }

  function stopDashboardServer(): void {
    for (const client of dashboardSseClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    dashboardSseClients.clear();

    if (dashboardServer) {
      try { dashboardServer.close(); } catch { /* ignore */ }
    }

    dashboardServer = null;
    dashboardServerPort = null;
    dashboardServerWorkDir = null;
    dashboardServerHtmlPath = null;
    dashboardServerSessionKey = null;
    dashboardServerJsonlPath = null;
  }

  function writeDashboardFile(workDir: string, experimentId: string | null): string {
    const jsonlContent = readJsonlContent(workDir, experimentId);
    const sessionName = extractAutoresearchSessionName(jsonlContent, experimentId);
    const html = injectDataIntoTemplate(readTemplate(), sessionName)
      .replace(LOGO_PLACEHOLDER, logoDataUrl());
    const exportDir = fs.mkdtempSync(path.join(tmpdir(), "pi-autoresearch-dashboard-"));
    const dest = path.join(exportDir, "index.html");
    fs.writeFileSync(dest, html);
    return dest;
  }

  const CONTENT_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".jsonl": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".webp": "image/webp",
  };

  function fileContentType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    return CONTENT_TYPES[ext] ?? "application/octet-stream";
  }

  function resolveServedFile(requestPath: string): string | null {
    if (requestPath === "/") return dashboardServerHtmlPath;
    if (requestPath === "/autoresearch.jsonl") return dashboardServerJsonlPath;
    return null;
  }

  function registerSseClient(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 1000\n\n");
    dashboardSseClients.add(res);
    res.on("close", () => dashboardSseClients.delete(res));
  }

  function broadcastDashboardUpdate(jsonlPath: string): void {
    if (!dashboardServer || dashboardServerJsonlPath !== jsonlPath) return;
    for (const res of dashboardSseClients) {
      try {
        res.write("event: jsonl-updated\n");
        res.write(`data: ${Date.now()}\n\n`);
      } catch {
        dashboardSseClients.delete(res);
      }
    }
  }

  function startStaticServer(
    workDir: string,
    jsonlPath: string,
    dashboardHtmlPath: string,
    sessionKey: string,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const resolvedWorkDir = path.resolve(workDir);
      const resolvedJsonlPath = path.resolve(jsonlPath);
      const resolvedDashboardHtmlPath = path.resolve(dashboardHtmlPath);

      if (dashboardServer && dashboardServerWorkDir === resolvedWorkDir && dashboardServerPort) {
        dashboardServerHtmlPath = resolvedDashboardHtmlPath;
        dashboardServerJsonlPath = resolvedJsonlPath;
        dashboardServerSessionKey = sessionKey;
        resolve(dashboardServerPort);
        return;
      }

      stopDashboardServer();
      dashboardServerHtmlPath = resolvedDashboardHtmlPath;
      dashboardServerJsonlPath = resolvedJsonlPath;

      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");

        if (url.pathname === "/events") {
          registerSseClient(res);
          return;
        }

        const filePath = resolveServedFile(url.pathname);
        if (!filePath) {
          res.writeHead(404);
          res.end();
          return;
        }

        fs.readFile(filePath, (err, data) => {
          if (err) {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, { "Content-Type": fileContentType(filePath) });
          res.end(data);
        });
      });

      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to bind dashboard server"));
          return;
        }
        dashboardServer = server;
        dashboardServerPort = address.port;
        dashboardServerWorkDir = resolvedWorkDir;
        dashboardServerSessionKey = sessionKey;
        resolve(address.port);
      });

      server.on("error", reject);
    });
  }

  async function exportDashboard(ctx: ExtensionContext): Promise<void> {
    const root = stateRoot(ctx);
    const id = experimentId(ctx);
    const jsonlPath = autoresearchJsonlPath(root, id);

    if (!fs.existsSync(jsonlPath)) {
      ctx.ui.notify(`No ${path.basename(jsonlPath)} found \u2014 run some experiments first`, "error");
      return;
    }

    try {
      const dashboardHtmlPath = writeDashboardFile(root, id);
      const port = await startStaticServer(root, jsonlPath, dashboardHtmlPath, getSessionKey(ctx));
      const url = `http://127.0.0.1:${port}`;
      openInBrowser(url);
      ctx.ui.notify(
        `Dashboard at ${url} (live updates)${id ? ` — experiment ${id}` : ""}`,
        "info"
      );
    } catch (error) {
      ctx.ui.notify(
        `Export failed: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
    }
  }

  // -----------------------------------------------------------------------
  // Experiment management subcommands
  // -----------------------------------------------------------------------

  async function listExperimentsCommand(ctx: ExtensionContext): Promise<void> {
    const root = await resolveRegistryRoot(gitRunner, ctx.cwd);
    if (!root) {
      ctx.ui.notify("Not a git repository — no experiment registry here.", "error");
      return;
    }
    const records = listExperiments(root);
    const bound = experimentId(ctx);
    if (records.length === 0) {
      ctx.ui.notify("No experiments yet. Start one with '/autoresearch <goal>' or '/autoresearch new <name>'.", "info");
      return;
    }
    const lines = records.map((r) => {
      const marker = r.id === bound ? "*" : " ";
      const when = new Date(r.lastUsedAt).toISOString().slice(0, 16).replace("T", " ");
      return `${marker} ${r.id.padEnd(20)} ${r.mode.padEnd(9)} ${when}  ${r.name ?? ""}`.trimEnd();
    });
    ctx.ui.notify(
      `Experiments in ${root} (* = this session):\n${lines.join("\n")}`,
      "info",
    );
  }

  /**
   * Create an experiment and, by default, give it a worktree.
   *
   * The session cannot relocate itself — pi's file tools are pinned to the
   * directory pi was launched in — so a worktree experiment is created for the
   * *next* session and the user is told exactly where to start it. `--shared`
   * instead binds this session immediately and relies on scoped git operations.
   */
  async function newExperimentCommand(ctx: ExtensionContext, spec: string): Promise<void> {
    const root = await resolveRegistryRoot(gitRunner, ctx.cwd);
    if (!root) {
      ctx.ui.notify("Not a git repository — worktree isolation needs git.", "error");
      return;
    }

    const shared = spec.includes("--shared");
    const name = spec.replace("--shared", "").trim();
    if (!name) {
      ctx.ui.notify("Usage: /autoresearch new <name> [--shared]", "error");
      return;
    }

    if (getRuntime(ctx).autoresearchMode) {
      ctx.ui.notify("Turn autoresearch off before switching experiments: '/autoresearch off'", "error");
      return;
    }

    const id = uniqueId(readRegistry(root), name);

    if (shared) {
      const record = createExperiment(root, { name, mode: "shared", workDir: resolveWorkDir(ctx.cwd) });
      bindExperiment(ctx, root, record.id);
      await reconstructState(ctx);
      ctx.ui.notify(
        `Created shared experiment "${record.id}" and bound this session to it.\n` +
        `State: .auto/experiments/${record.id}/\n` +
        "Commits and discards are scoped to the files this experiment changed.",
        "info",
      );
      return;
    }

    const created = await createWorktree(gitRunner, root, id);
    if (!created.ok) {
      ctx.ui.notify(`Could not create worktree: ${created.error}`, "error");
      return;
    }

    const record = createExperiment(root, {
      id,
      name,
      mode: "worktree",
      workDir: created.workDir,
      branch: branchFor(id),
    });

    ctx.ui.notify(
      `Created worktree experiment "${record.id}".\n` +
      `  Branch: ${record.branch}\n` +
      `  Worktree: ${created.workDir}\n` +
      `  State: .auto/experiments/${record.id}/\n\n` +
      "Start a new session inside it so its edits, commits and discards are fully isolated:\n" +
      `  cd ${created.workDir} && pi\n` +
      "It binds itself automatically — no further command needed.",
      "info",
    );
  }

  async function joinExperimentCommand(ctx: ExtensionContext, rawId: string): Promise<void> {
    const root = await resolveRegistryRoot(gitRunner, ctx.cwd);
    if (!root) {
      ctx.ui.notify("Not a git repository — no experiment registry here.", "error");
      return;
    }

    const wanted = rawId.trim();
    if (!wanted) {
      ctx.ui.notify("Usage: /autoresearch join <experiment-id>", "error");
      return;
    }

    const record = getExperiment(root, wanted) ?? listExperiments(root).find((r) => r.id.includes(wanted));
    if (!record) {
      ctx.ui.notify(`No experiment matching "${wanted}". Try '/autoresearch list'.`, "error");
      return;
    }

    if (record.mode === "worktree" && !samePath(ctx.cwd, record.workDir)) {
      ctx.ui.notify(
        `Experiment "${record.id}" runs in its own worktree and this session is in ${ctx.cwd}.\n` +
        "Start pi inside the worktree so its file tools operate there:\n" +
        `  cd ${record.workDir} && pi`,
        "error",
      );
      return;
    }

    bindExperiment(ctx, root, record.id);
    await reconstructState(ctx);
    ctx.ui.notify(
      `Joined experiment "${record.id}" (${record.mode}). ${getRuntime(ctx).state.results.length} run(s) loaded.`,
      "info",
    );
  }

  async function dropExperimentCommand(ctx: ExtensionContext, rawId: string): Promise<void> {
    const root = await resolveRegistryRoot(gitRunner, ctx.cwd);
    if (!root) {
      ctx.ui.notify("Not a git repository — no experiment registry here.", "error");
      return;
    }

    const wanted = rawId.trim();
    if (!wanted) {
      ctx.ui.notify("Usage: /autoresearch drop <experiment-id>", "error");
      return;
    }

    // Drop is destructive, so it needs an exact id — a fuzzy match could
    // remove the wrong experiment's worktree.
    const record = getExperiment(root, wanted);
    if (!record) {
      const known = listExperiments(root).map((r) => r.id).join(", ") || "none";
      ctx.ui.notify(`No experiment with id "${wanted}". Available: ${known}`, "error");
      return;
    }

    const removed = await removeWorktree(gitRunner, root, record);
    deleteExperiment(root, record.id);
    try {
      fs.rmSync(experimentDir(root, record.id), { recursive: true, force: true });
    } catch {
      // Losing the state directory is not worth blocking the drop.
    }

    if (experimentId(ctx) === record.id) {
      getRuntime(ctx).experimentId = null;
      getRuntime(ctx).state = createExperimentState();
      updateWidget(ctx);
    }

    ctx.ui.notify(
      removed.ok
        ? `Dropped experiment "${record.id}" and removed its worktree and state.`
        : `Dropped experiment "${record.id}" from the registry, but its worktree could not be removed: ${removed.error}`,
      removed.ok ? "info" : "error",
    );
  }

  // -----------------------------------------------------------------------
  // /autoresearch command — enter autoresearch mode
  // -----------------------------------------------------------------------

  function turnAutoresearchOff(ctx: ExtensionContext): void {
    const runtime = getRuntime(ctx);
    const wasRunning = !ctx.isIdle();
    const workDir = codeDir(ctx);

    recordAutoresearchActivation(ctx, workDir, false);
    setAutoresearchMode(ctx, false);
    runtime.autoResumeTurns = 0;
    runtime.experimentsThisSession = 0;
    runtime.lastRunChecks = null;
    runtime.lastRunDuration = null;
    runtime.runningExperiment = null;
    cancelPendingResume(runtime);
    if (dashboardServerSessionKey === getSessionKey(ctx)) stopDashboardServer();
    clearSessionUi(ctx);
    if (wasRunning) ctx.abort();
    ctx.ui.notify(
      wasRunning ? "Autoresearch mode OFF — aborting current run" : "Autoresearch mode OFF",
      "info"
    );
  }

  pi.registerCommand("autoresearch", {
    description: "Start, stop, clear, export, or open dashboards for autoresearch mode",
    handler: async (args, ctx) => {
      const runtime = getRuntime(ctx);
      const trimmedArgs = (args ?? "").trim();
      const command = trimmedArgs.toLowerCase();

      if (!trimmedArgs) {
        ctx.ui.notify(autoresearchHelp(), "info");
        return;
      }

      if (command === "off") {
        turnAutoresearchOff(ctx);
        return;
      }

      if (command === "export") {
        await exportDashboard(ctx);
        return;
      }

      if (command === "dashboard") {
        await openFullscreenDashboard(ctx);
        return;
      }

      if (command === "clear") {
        const root = stateRoot(ctx);
        const id = experimentId(ctx);
        const jsonlPaths = sessionFileCandidates(root, "log", id);
        const workDir = codeDir(ctx);
        recordAutoresearchActivation(ctx, workDir, false);
        setAutoresearchMode(ctx, false);
        runtime.autoResumeTurns = 0;
        runtime.experimentsThisSession = 0;
        runtime.lastRunChecks = null;
        runtime.lastRunDuration = null;
        runtime.runningExperiment = null;
        cancelPendingResume(runtime);
        runtime.state = createExperimentState();
        if (dashboardServerSessionKey === getSessionKey(ctx)) stopDashboardServer();
        updateWidget(ctx);

        const deletedPaths: string[] = [];
        for (const jsonlPath of Object.values(jsonlPaths)) {
          if (!fs.existsSync(jsonlPath)) continue;
          try {
            fs.unlinkSync(jsonlPath);
            deletedPaths.push(path.relative(root, jsonlPath) || path.basename(jsonlPath));
          } catch (error) {
            ctx.ui.notify(
              `Failed to delete ${path.relative(root, jsonlPath) || path.basename(jsonlPath)}: ${error instanceof Error ? error.message : String(error)}`,
              "error"
            );
            return;
          }
        }

        const scope = id ? `experiment ${id}` : "this session";
        if (deletedPaths.length > 0) {
          ctx.ui.notify(`Deleted ${deletedPaths.join(", ")} for ${scope} and turned autoresearch mode OFF`, "info");
        } else {
          ctx.ui.notify(`No session log found for ${scope}. Autoresearch mode OFF`, "info");
        }
        return;
      }

      if (command === "list" || command === "ls") {
        await listExperimentsCommand(ctx);
        return;
      }

      if (command === "new" || command.startsWith("new ")) {
        await newExperimentCommand(ctx, trimmedArgs.slice(3).trim());
        return;
      }

      if (command === "join" || command.startsWith("join ")) {
        await joinExperimentCommand(ctx, trimmedArgs.slice(4).trim());
        return;
      }

      if (command === "drop" || command.startsWith("drop ")) {
        await dropExperimentCommand(ctx, trimmedArgs.slice(4).trim());
        return;
      }

      if (runtime.autoresearchMode) {
        ctx.ui.notify("Autoresearch already active — use '/autoresearch off' to stop first", "info");
        return;
      }

      // Entering the loop implies a claim on an experiment, so the first turn
      // already has somewhere private to write.
      const { root, record } = await ensureExperiment(ctx);
      const workDir = codeDir(ctx);
      recordAutoresearchActivation(ctx, workDir, true);
      setAutoresearchMode(ctx, true);
      runtime.autoResumeTurns = 0;
      const rulesLoaded = hasAutoresearchRules(ctx);
      // No prompt.md yet — load the create skill so the agent follows the
      // setup guidelines. `/skill:<name>` is expanded to the full SKILL.md when
      // sent with `expandPromptTemplates` (see sendWhenReady), and trailing args
      // are appended as the session goal. Must be sent as its own message that
      // STARTS with `/skill:` so expansion triggers — don't prepend hook output.
      const kickoff = rulesLoaded
        ? `Autoresearch mode active. ${trimmedArgs} ${BENCHMARK_GUARDRAIL}`
        : `/skill:autoresearch-create ${trimmedArgs} ${BENCHMARK_GUARDRAIL}`.replace(/\s+/g, " ").trim();

      ctx.ui.notify(
        `${rulesLoaded
          ? "Autoresearch mode ON — rules loaded from"
          : "Autoresearch mode ON — no prompt.md found, loading autoresearch-create skill"}` +
        ` .auto/experiments/${record.id}/prompt.md. Experiment: ${record.id} (${record.mode}).`,
        "info",
      );

      const state = runtime.state;
      const activationSteer = await fireHook(ctx, {
        event: "before",
        cwd: workDir,
        state_root: root,
        experiment: record.id,
        next_run: state.results.length + 1,
        last_run: readLastRun(ctx),
        session: buildSessionSnapshot(ctx, state),
      });

      // Prepend hook output only when prompt.md exists; otherwise the message
      // must stay `/skill:...`-prefixed for command expansion.
      const message = activationSteer && rulesLoaded ? `${activationSteer}\n\n${kickoff}` : kickoff;
      sendWhenReady(ctx, message);
    },
  });
}
