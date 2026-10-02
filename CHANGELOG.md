# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- **Concurrent experiments in one repository.** Each experiment now owns an id and a private state folder, `.auto/experiments/<id>/`, holding its `log.jsonl`, `prompt.md`, `measure.sh`, `checks.sh`, `ideas.md`, `config.json` and `hooks/`. Previously all of these were single slots at `.auto/`, so a second session in the same codebase overwrote the first one's log, config and hook scripts, and both sessions reconstructed their state from the same merged file.
- A registry at `.auto/experiments.json` tracks every experiment in the repository. It lives in the *main* worktree, so a session running inside a linked worktree still finds it.
- Per-session binding, recorded in the session transcript and keyed by registry root. A session that has not claimed an experiment gets its own on first use; `shouldAutoActivateAutoresearch` now matches the activation decision per experiment instead of per working directory, so one session's `/autoresearch off` no longer silences another's.
- `/autoresearch new <name>` creates an experiment in a dedicated git worktree on branch `autoresearch/<id>`, and prints the `cd … && pi` line needed to start it. A session launched inside a worktree adopts that experiment with no further command.
- `/autoresearch new <name> --shared` creates an experiment in the current checkout; `/autoresearch list` shows them all with `*` marking the current session's; `/autoresearch join <id>` rebinds; `/autoresearch drop <id>` removes an experiment, its state and its worktree.
- Hook payloads gained `experiment` and `state_root`, and the compaction summary is built from the bound experiment's paths.
- **Autocompletion for `/autoresearch`.** `Tab` offers the subcommands, and for `join` and `drop` it reads `.auto/experiments.json` and offers the live experiment ids with their mode, name and result count — ids are generated at runtime and are not guessable.
- `/autoresearch settings` opens an interactive editor for the status widget: collapsed vs expanded, height ceiling, metric density, which metrics to show, and verbose mode. It writes to the experiment's own `config.json` and leaves the rest of that file untouched.
- The fullscreen dashboard accepts the mouse: the wheel scrolls, and clicking a result row expands that run's full metric list. `e` does the same from the keyboard.

### Changed

- **The status widget is bounded, and defaults to a single line.** It previously emitted every configured secondary metric and wrapped them to the terminal width, so a run with a few hundred metrics filled roughly half a 32" ultrawide and made the transcript unreadable. Wrapping changed the shape, not the volume, so a wider terminal never made it shorter. The widget now defaults to one summary line, and when expanded shows at most `widget.maxHeight` lines — further capped by the terminal's row count — with the rest pointed at the dashboard.
- `widget.metricMode` defaults to `auto`, ranking secondary metrics by movement since the baseline run rather than printing all of them. `pinned` shows a named list in order, `all` shows everything.
- Below roughly 54 columns the metric block is dropped rather than truncated, since a name and its value cannot both survive the cut.
- `widget.verbose` restores the previous full output for people who want it on a large display.

- **Git operations in a shared working tree are now scoped instead of repository-wide.** `log_experiment` no longer runs `git add -A` or `git checkout -- .` when other experiments are live in the same checkout: `keep` stages only the files this experiment changed, and `discard` restores only those files. A discard is refused when another experiment moved `HEAD` in the meantime, since the experiment's diff no longer has a meaningful baseline. Mutations are serialized across processes by a lockfile at `.auto/git.lock` that breaks itself if the owning process died.
- The first result of an experiment in a shared checkout is never committed or reverted automatically. With no prior record of which changes belong to which experiment, the two are indistinguishable and guessing would destroy a sibling's work. The measurement is still logged and the agent is told to stage or revert by hand, or to move to a worktree.
- A sole experiment in a repository is unaffected: shared mode with no siblings keeps the original repository-wide commit and revert behaviour.
- `isAutoresearchShCommand` accepts the per-experiment `measure.sh` path, so the benchmark gate still fires once state moved under `.auto/experiments/<id>/`.
- `finalize.sh` accepts an optional `ideas_file` and finds the backlog under `.auto/experiments/*/ideas.md`.

### Fixed

- `stopDashboardServer()` ran on every session's shutdown, so one session exiting killed the export dashboard another session in the same process was streaming from. The server is now tagged with its owning session and only that session tears it down. The fullscreen overlay and its spinner interval had the same problem and are now tagged too.
- The export dashboard served a single fixed `log.jsonl` route; it now serves the bound experiment's log.
- Experiment names and metrics are read per experiment, so a session no longer picks up the name and metric of a sibling experiment's config header.
- `/autoresearch settings` could not save for anyone without an existing `config.json`, because it never created the `.auto` directory before writing. Clicking a settings row also toggled the row above it, and then toggled nothing at all, because the row list was rebuilt between the lookup and the index search.

## [1.8.1] - 2026-09-08

### Fixed

- `/autoresearch <goal>` without a `.auto/prompt.md` sent the literal text `/skill:autoresearch-create …` to the model instead of the skill's contents, because `pi.sendUserMessage()` does not expand skill commands by default. Models would reply with things like `Unknown command: /skill:autoresearch-create` (#93). The kickoff is now sent with `expandPromptTemplates: true` (pi ≥ 0.84.2).

## [1.8.0] - 2026-09-08

### Added
- After every logged experiment, `log_experiment` now asks the agent to check whether the latest result invalidates a previous discard's rollback reason before choosing the next experiment. Ideas discarded because "X was the bottleneck" get a second look once X stops being the bottleneck.
- Intentional retries can be annotated with `asi.revisits_run: <run number>`; the transcript then shows a `↻ Revisiting #N` line under the logged result so a retry is distinguishable from the agent forgetting a failure.
- The `.auto/prompt.md` template's "What's Been Tried" section now asks for the conditions that would justify revisiting a discarded idea, so that knowledge survives compaction.

## [1.7.0] - 2026-08-31

### Changed

- **Breaking:** no keyboard shortcuts are bound by default anymore. The fullscreen dashboard default chord `ctrl+shift+f` collided with pi 0.84.2's new built-in transcript search (#86) — and any hardcoded default will eventually collide with a future pi built-in. Shortcuts are now strictly opt-in via `<agent-dir>/extensions/pi-autoresearch.json`. To restore the old behavior: `{ "shortcuts": { "fullscreenDashboard": "ctrl+shift+f" } }`.

### Added

- `/autoresearch dashboard` subcommand opens the fullscreen dashboard overlay — the keyboard-free way to reach it.
- The `export` (`/autoresearch export`) and `off` (`/autoresearch off`) actions can now be bound to opt-in shortcuts alongside `fullscreenDashboard`.
- README guidance (aimed at agents) for verifying a chord against the installed pi's built-in keymap before writing it to the shortcut config.

## [1.6.2] - 2026-07-09

### Changed

- Raised the autoresearch auto-resume ceiling from 20 to 200 turns, while adding a stuck-loop override that stops auto-resume after more than 20 consecutive `discard` or `crash` results in the current segment.

## [1.6.1] - 2026-07-02

### Fixed

- Redirected `workingDir` logs no longer auto-activate autoresearch in unrelated pi sessions.
- `/autoresearch off` now persists across `/tree`, compaction, and reloads: a manual off is recorded as a session activation decision and is no longer overridden just because `log.jsonl` still exists.

## [1.6.0] - 2026-06-08

### Changed

- Autoresearch now stores session files under the `.auto/` subfolder by default, with legacy file fallback for existing sessions.
- The dashboard widget is now always expanded — the full results table renders inline above the editor at all times. Removed the collapsed one-liner mode and the `Ctrl+Shift+T` expand/collapse toggle (and its `shortcuts.toggleDashboard` config key). Fullscreen (`Ctrl+Shift+F`) remains the only dashboard toggle.
- Migrated Pi package imports and dependencies from the `@mariozechner` npm scope to `@earendil-works`.

## [1.5.0] - 2026-06-04

### Changed

- The `init_experiment`, `run_experiment`, and `log_experiment` tools are now revealed to the agent only while autoresearch mode is active, instead of being callable in every session. Outside autoresearch mode the tools are absent from the LLM's schema and system prompt, so the agent can no longer self-start a research loop — entry is via `/autoresearch` or resuming a session with an existing `autoresearch.jsonl`.

## [1.4.0] - 2026-05-06

### Added

- Configurable dashboard keyboard shortcuts. Users can now override or disable the toggle and fullscreen shortcuts with a profile-aware `<agent-dir>/extensions/pi-autoresearch.json` config file, helping autoresearch coexist with other pi extensions that bind the same keys.
- Shortcut resolution tests covering defaults, overrides, disabled shortcuts, partial configs, malformed configs, and extension registration.

### Changed

- Dashboard hints and README documentation now reflect the effective shortcuts from config.

## [1.3.0] - 2026-04-29

### Added

- Deterministic compaction summary. When pi compacts context, autoresearch now bypasses the LLM summarization and injects a lossless markdown summary built from persisted state (experiment rules, ideas backlog, and last 50 runs with ASI fields). This eliminates information loss across compaction boundaries.
- Recent-run deltas in the compaction summary use the full segment baseline, not just the first visible run in the window — percentages stay accurate even for long sessions.
- New test coverage for compaction summary assembly, empty state, re-init segments, 50-run cap, and hidden-baseline delta correctness.

### Fixed

- Post-turn auto-resume no longer tells the agent "don't re-read files" when no compaction happened. Split into two resume messages: a generic one for normal turns and a compaction-specific one that correctly references the summary.

## [1.2.0] - 2026-04-28

### Changed

- Long-running loops now ride pi's auto-compaction instead of stopping. When pi summarizes older messages on context overflow, autoresearch detects the resulting idle and re-prompts the agent to re-read `autoresearch.md`, the tail of `autoresearch.jsonl`, `autoresearch.ideas.md`, and `git log` before continuing.

### Fixed

- Manual `/compact` mid-iteration no longer leaves the loop stuck. `session_compact` now schedules a fresh resume even when no `agent_end` fired for the interrupted turn (so no `pendingResumeMessage` was waiting to be rescheduled). Same fix covers split-turn auto-compactions.
- Compaction during agent setup (before the first `log_experiment`) now resumes. The post-turn gate still requires an experiment this turn to avoid resuming on plain chat replies, but the post-compaction gate is permissive — compaction itself is evidence the loop should continue.
- Rapid back-to-back compactions all resume. Dropped the 5-minute auto-resume cooldown that was sized for a different threat model (chat-only `agent_end` loops); the experiment-this-turn gate plus `MAX_AUTORESUME_TURNS = 20` already cover the looping cases the cooldown was guarding against.

### Removed

- Removed the next-iteration token-cost prediction and its `isContextExhausted` guard — pi's auto-compaction handles overflow, so autoresearch no longer needs to estimate or stop early.
- Removed the `iterationTokens` field from `ExperimentResult` and `autoresearch.jsonl`. Existing log files remain readable; the field is simply ignored. The `token-budget.sh` hook example, which relied on it, has been dropped.
- Removed the never-shipped `autoCompactResume` config option (it was opt-in for an earlier draft of this change).

## [1.1.1] - 2026-04-28

### Added

- Published to the npm registry. Install with `pi install npm:pi-autoresearch`.
- Releases now publish automatically from GitHub Actions via npm trusted publisher (OIDC) with provenance attestation.

## [1.1.0] - 2026-04-24

### Added

- Added optional `autoresearch.hooks/before.sh` and `autoresearch.hooks/after.sh` lifecycle hooks for prospective and retrospective iteration automation.
- Added the `autoresearch-hooks` skill plus example hook scripts for research fetching, learnings capture, notifications, anti-thrash, and idea rotation.

## [1.0.1] - 2026-04-22

### Fixed

- Updated the default dashboard shortcuts to `Ctrl+Shift+T` (toggle) and `Ctrl+Shift+F` (fullscreen).
- Avoided the shortcut conflict with Pi's built-in `Ctrl+X` binding introduced in newer Pi releases.

## [1.0.0] - 2026-04-20

### Added

- Initial stable release of `pi-autoresearch`.
