# Task Spec: cli-preset-flag

## Metadata
- Task ID: cli-preset-flag
- Created: 2026-11-26T21:33:51+00:00
- Frozen: 2026-11-26T23:04:00+00:00
- Repo root: /Users/stas/Playground/tamp
- Working directory at init: /Users/stas/Playground/tamp
- Status: FROZEN

## Guidance sources
- `AGENTS.md`
- `CLAUDE.md`
- Existing modules & tests: `config.js`, `metadata.js`, `bin/tamp.js`, `bin/ui/App.js`, `bin/ui/LevelPicker.js`, `bin/ui/StagePicker.js`, `test/config.test.js`, `test/cli-hardening.test.js`, `test/metadata.test.js`

## Original task statement
Fix T-05 (RICE #1, score 8.1): Add --preset CLI flag and recommended preset ergonomics. 1) In config.js, support options.presetOverride in loadConfig(env, options) with explicit precedence (TAMP_STAGES > --level > --preset > TAMP_LEVEL > TAMP_COMPRESSION_PRESET > config-file level > default), levelSource="preset-flag", prototype-chain safety via Object.hasOwn, and accurate cfg.preset/cfg.level/cfg.stages (including recommended with level=null and 14 stages). 2) In metadata.js, guard resolveLevel() against prototype-chain keys using Object.hasOwn(LEVEL_ALIASES, input) so resolveLevel("toString") returns null instead of undefined. 3) In bin/tamp.js, parse --preset NAME / --preset=NAME for all COMPRESSION_PRESETS keys (conservative, balanced, aggressive, recommended), reject invalid/empty --preset or mutually conflicting --level + --preset with exit code 2, thread argvPreset into resolveNonInteractiveConfig() via loadOpts.presetOverride (and pass preset defaults to interactive mode when applicable), and document --preset in tamp help. 4) Add deterministic unit and CLI tests covering config precedence, prototype-key safety, CLI flag parsing/validation/conflict handling, non-interactive resolution for --preset recommended, and help output.

## Acceptance criteria

- **AC1 (`config.js` — `options.presetOverride` resolution & precedence)**:
  - `loadConfig(env, options)` accepts `options.presetOverride`.
  - Stage/level resolution strictly enforces the 7-tier precedence:
    1. `TAMP_STAGES` (`levelSource: 'stages-env'`)
    2. `options.levelOverride` (`levelSource: 'level-flag'`)
    3. `options.presetOverride` (`levelSource: 'preset-flag'`)
    4. `TAMP_LEVEL` (`levelSource: 'level-env'`)
    5. `TAMP_COMPRESSION_PRESET` (`levelSource: 'preset-env'`)
    6. config-file `level` (`levelSource: 'config-file'`)
    7. `DEFAULT_LEVEL` (`levelSource: 'default'`)
  - When `options.presetOverride` is a valid own key in `COMPRESSION_PRESETS` (`conservative`, `balanced`, `aggressive`, `recommended`) and neither `TAMP_STAGES` nor a valid `options.levelOverride` takes precedence:
    - `cfg.levelSource` is `'preset-flag'`.
    - `cfg.preset` is the winning preset name (e.g., `'recommended'`), overriding any `TAMP_COMPRESSION_PRESET` env/file value.
    - `cfg.level` is the preset's numeric level for anchored presets (`4` for `conservative`, `5` for `balanced`, `8` for `aggressive`) and `null` for `recommended`.
    - `cfg.stages` is a fresh array copy of `COMPRESSION_PRESETS[name].stages` (`cfg.stages !== COMPRESSION_PRESETS[name].stages`). For `recommended`, `cfg.stages` contains all 14 stages and excludes `'llmlingua'`.

- **AC2 (`config.js` — prototype-chain safety & invalid `presetOverride` fallthrough)**:
  - `options.presetOverride` validation checks `typeof raw === 'string' && Object.hasOwn(COMPRESSION_PRESETS, raw)`.
  - `undefined`, `null`, and `''` are treated as unset (no warning, silent fallthrough).
  - Any other invalid value — including unknown strings, non-strings, and prototype-chain keys (`constructor`, `toString`, `valueOf`, `hasOwnProperty`, `__proto__`) — never crashes, writes a warning naming `--preset` and the invalid value to `process.stderr`, and falls through cleanly to lower-precedence candidates (`TAMP_LEVEL` -> `TAMP_COMPRESSION_PRESET` -> config-file `level` -> `DEFAULT_LEVEL`) without clobbering `cfg.preset`.
  - Existing `TAMP_LEVEL` and `TAMP_COMPRESSION_PRESET` behavior (including invalid-input fallback and all existing `test/config.test.js` assertions) remains unchanged.

- **AC3 (`metadata.js` — `resolveLevel()` prototype-chain safety)**:
  - `resolveLevel(input)` uses `Object.hasOwn(LEVEL_ALIASES, input)` instead of `input in LEVEL_ALIASES`.
  - `resolveLevel('toString')`, `resolveLevel('constructor')`, `resolveLevel('valueOf')`, `resolveLevel('hasOwnProperty')`, and `resolveLevel('__proto__')` all return `null` (strictly `=== null`, never `undefined`).
  - The 1–9 `COMPRESSION_LEVELS` ladder remains prefix-preserving and all existing `test/metadata.test.js` invariants remain unchanged.

- **AC4 (`bin/tamp.js` — `--preset` CLI parsing, validation, and `--level` conflict handling)**:
  - Parses `--preset NAME` and `--preset=NAME` against `Object.hasOwn(COMPRESSION_PRESETS, name)` (`conservative`, `balanced`, `aggressive`, `recommended`).
  - Exports pure helper function(s) (e.g., `parsePresetArgv(argv)` and/or `parseCliFlags(argv)`) that return structured parse/validation results without calling `process.exit`, enabling deterministic unit tests.
  - When invoked via CLI (`main()`):
    - Missing value (e.g., trailing `--preset` with no argument), empty value (`--preset=`), unknown value (`--preset bogus`), or prototype-chain key (`--preset toString`, `--preset=constructor`, `--preset __proto__`) writes a clear error to stderr listing valid presets and exits with code `2`.
    - Passing both `--level` and `--preset` together (in any form/order, e.g., `--level 5 --preset recommended`, `--preset=balanced --level=5`) writes a clear mutual-exclusion error to stderr and exits with code `2`.

- **AC5 (`bin/tamp.js` — non-interactive `--preset` threading)**:
  - `resolveNonInteractiveConfig({ env, argvLevel, argvPreset, startSidecarFn, onSidecarReady, onSidecarUnavailable })` accepts `argvPreset = null` and sets `loadOpts.presetOverride = argvPreset` when `argvPreset !== null`.
  - `main()` passes the parsed `argvPreset` into `resolveNonInteractiveConfig`.
  - No `process.env` key (`TAMP_STAGES`, `TAMP_COMPRESSION_PRESET`, `TAMP_LEVEL`, `TAMP_LLMLINGUA_URL`) is mutated.
  - When `argvPreset === 'recommended'`:
    - `probe.preset === 'recommended'`, `probe.level === null`, `probe.levelSource === 'preset-flag'`.
    - `selectedStages` equals the 14 `recommended` stages (no `'llmlingua'`).
    - `startSidecarFn` is never called.
    - Passing `(overrides, loadOpts)` to `createProxy(overrides, loadOpts)` produces a proxy config with `preset === 'recommended'`, `level === null`, `levelSource === 'preset-flag'`, and the 14 `recommended` stages.

- **AC6 (`bin/tamp.js` & `bin/ui/App.js` — interactive mode preset seeding)**:
  - `bin/tamp.js` passes `argvPreset` to `App` without mutating `process.env`.
  - `bin/ui/App.js` resolves interactive picker seed props via an exported pure helper (e.g., `resolveInteractiveSeed({ argvLevel, argvPreset, envStages })`):
    - If `argvPreset` is a valid own key in `COMPRESSION_PRESETS` and `Number.isInteger(preset.level)` (`conservative` -> `4`, `balanced` -> `5`, `aggressive` -> `8`): passes `envLevel = argvLevel ?? preset.level` to `LevelPicker` and leaves `envStages` unchanged.
    - If `argvPreset` is a valid own key in `COMPRESSION_PRESETS` and `preset.level === null` (`recommended`): keeps `envLevel = argvLevel` (`null`) and seeds `envStages = envStages ?? new Set(preset.stages)` (preserving `TAMP_STAGES > --preset` precedence when `envStages` is already set).
    - If `argvPreset` is absent/null/invalid: passes `argvLevel` and `envStages` through unchanged.

- **AC7 (`bin/tamp.js` — `tamp help` documentation)**:
  - `tamp help` (as well as `--help` and `-h`) includes `--preset NAME` under `Options:` documenting the valid preset names (`conservative, balanced, aggressive, recommended`).

- **AC8 (Automated test coverage & zero regressions)**:
  - Deterministic unit tests cover AC1–AC6 across `test/config.test.js`, `test/metadata.test.js`, and `test/cli-hardening.test.js` (or focused sibling test blocks in those existing test files).
  - Subprocess CLI tests invoking `node bin/tamp.js` verify real exit code `2` + stderr for missing/empty/invalid/prototype-key `--preset` and mutually exclusive `--level` + `--preset`, and exit code `0` + `--preset` help output for `tamp help`.
  - `npm test` and `node smoke.js` pass completely with zero regressions.

## Constraints
- Plain Node.js ESM JavaScript only (no TypeScript, no build step).
- Zero new external npm dependencies (`package.json` unchanged).
- Keep the 1–9 `COMPRESSION_LEVELS` ladder prefix-preserving and do not alter existing stage definitions or preset stage lists.
- Preserve all existing contracts in `test/config.test.js`, `test/metadata.test.js`, `test/cli-hardening.test.js`, and `test/tui-state-telemetry.test.js`.
- Never mutate `process.env` in CLI preset/level resolution paths.
- Never bypass secret redaction ordering or alter `compress.js` stage dispatch.
- Keep diffs minimal and scoped strictly to the files needed for this task (`config.js`, `metadata.js`, `bin/tamp.js`, `bin/ui/App.js`, and tests).
- Never push to `main`.

## Ambiguity resolutions & assumptions
1. **Mutual exclusion scope**: CLI argument validation (`bin/tamp.js`) rejects passing `--level` and `--preset` together with exit code `2`. Programmatic callers of `loadConfig(env, { levelOverride, presetOverride })` follow the documented precedence (`levelOverride > presetOverride`) rather than throwing, matching how `loadConfig` handles every other config source.
2. **Invalid `options.presetOverride` vs invalid `TAMP_COMPRESSION_PRESET`**: An invalid `options.presetOverride` warns to stderr and falls through to lower-precedence sources (`TAMP_LEVEL` -> `TAMP_COMPRESSION_PRESET` -> config-file `level` -> `DEFAULT_LEVEL`), mirroring invalid `options.levelOverride`. Existing `TAMP_COMPRESSION_PRESET` invalid behavior (warn + fallback to balanced/default) is preserved untouched to avoid breaking existing tests.
3. **Trailing `--preset` without value**: Unlike `--preset` being absent (returns `null`), a trailing `--preset` with no following argument (`['--preset']` or `['-y', '--preset']`) is explicitly detected as a missing value and rejected with exit code `2`. Similarly `--preset=` (empty string) and `--preset -y` (flag token not in `COMPRESSION_PRESETS`) are rejected with exit code `2`.
4. **Flag parsing placement vs `help`/`version`**: `tamp help` / `tamp --help` / `tamp -h` / `tamp --version` without `--preset` or `--level` continue to exit `0`. Parsing `--preset` alongside `parseLevelArgv` at the top of `main()` matches existing `--level` behavior.
5. **Interactive mode for `--preset recommended`**: `LevelPicker` represents the 1–9 ladder and does not have a rung for `recommended` (`level: null`). Seeding `envStages = envStages ?? new Set(COMPRESSION_PRESETS.recommended.stages)` in `App.js` keeps `LevelPicker` unchanged, avoids mutating `process.env`, respects `TAMP_STAGES` precedence, and pre-selects the exact 14 `recommended` stages when the user opens the advanced per-stage picker (`A`).
6. **`recommended` preset `minSize`**: Adding `--preset recommended` does NOT silently override `TAMP_MIN_SIZE` (`cfg.minSize` remains controlled by `TAMP_MIN_SIZE` / default `200`), matching existing `TAMP_COMPRESSION_PRESET=recommended` behavior.

## Non-goals
- Changing `COMPRESSION_PRESETS` stage lists, `COMPRESSION_LEVELS` 1–9 ladder rungs, or `DEFAULT_LEVEL`.
- Adding a new TUI picker view or redesigning `LevelPicker` / `StagePicker` to display named presets as a separate UI widget.
- Persisting `--preset` to `~/.config/tamp/config` or modifying `tamp settings` / `tamp init` / `install-service`.
- Auto-overriding `TAMP_MIN_SIZE` when `--preset recommended` is passed.
- Editing website docs (`site/index.html`) or `README.md` (unless a doc test requires it — none currently asserts `--preset` CLI flags).

## Verification plan
- **Build**: N/A (plain Node.js ESM, no build step).
- **Unit tests**:
  - `node --test test/config.test.js`
  - `node --test test/metadata.test.js`
  - `node --test test/cli-hardening.test.js`
  - `node --test test/tui-state-telemetry.test.js`
- **Full test suite & integration**:
  - `npm test` (runs `node --test test/*.test.js && node bench/retrieval-eval.js`)
  - `node smoke.js`
- **Lint**: N/A (no lint script in `package.json`; verify clean syntax via `node --check config.js metadata.js bin/tamp.js bin/ui/App.js`).
- **Manual / CLI checks**:
  - `node bin/tamp.js help` exits `0` and shows `--preset NAME`.
  - `node bin/tamp.js --preset` / `--preset=` / `--preset bogus` / `--preset toString` exit `2` with clear stderr errors.
  - `node bin/tamp.js --level 5 --preset recommended` exits `2` with clear mutual-exclusion stderr error.
  - `git diff --stat` confirms minimal, strictly scoped diff and zero unintended file changes.
