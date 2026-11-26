# Evidence Bundle: cli-preset-flag

## Summary
- Overall status: PASS
- Last updated: 2026-11-26T23:10:00+00:00

## Acceptance criteria evidence

### AC1
- Status: PASS
- Proof:
  - `config.js` (`loadConfig(env, options)`): supports `options.presetOverride` and enforces the exact 7-tier precedence (`TAMP_STAGES` -> `options.levelOverride` -> `options.presetOverride` -> `TAMP_LEVEL` -> `TAMP_COMPRESSION_PRESET` -> config-file `level` -> `DEFAULT_LEVEL`).
  - Sets `levelSource: 'preset-flag'`, `preset: presetFlagRaw` (overriding any `TAMP_COMPRESSION_PRESET`), `level: 4|5|8|null`, and `stages: [...preset.stages]` (fresh array copy; 14 stages excluding `'llmlingua'` for `recommended`).
  - Verified by `test/config.test.js` (`loadConfig — options.presetOverride precedence & safety`: 4/4 tests pass; full `node --test test/config.test.js` passes).
  - See `.agent/tasks/cli-preset-flag/raw/test-unit.txt`.
- Gaps:
  - None.

### AC2
- Status: PASS
- Proof:
  - `config.js` (`loadConfig`): validates `typeof presetFlagRaw === 'string' && Object.hasOwn(COMPRESSION_PRESETS, presetFlagRaw)`.
  - `undefined`, `null`, and `''` silently fall through without stderr warnings.
  - Unknown strings (`'bogus'`), non-strings (`123`, `true`, `{}`), and prototype-chain keys (`'constructor'`, `'toString'`, `'valueOf'`, `'hasOwnProperty'`, `'__proto__'`) never crash, warn to `process.stderr` naming `--preset` and the invalid value, and fall through cleanly to `TAMP_LEVEL` -> `TAMP_COMPRESSION_PRESET` -> config-file `level` -> `DEFAULT_LEVEL` without clobbering `cfg.preset`.
  - All existing `TAMP_LEVEL` and `TAMP_COMPRESSION_PRESET` tests in `test/config.test.js` remain green.
  - See `.agent/tasks/cli-preset-flag/raw/test-unit.txt`.
- Gaps:
  - None.

### AC3
- Status: PASS
- Proof:
  - `metadata.js` (`resolveLevel`): uses `Object.hasOwn(LEVEL_ALIASES, input)` instead of `input in LEVEL_ALIASES`.
  - Verified by `test/metadata.test.js` (`resolveLevel` -> `returns null for prototype-chain keys (Object.hasOwn guard)`): `toString`, `constructor`, `valueOf`, `hasOwnProperty`, and `__proto__` all strictly return `null` (`=== null`), and all 1–9 `COMPRESSION_LEVELS` ladder prefix-preserving invariants pass.
  - See `.agent/tasks/cli-preset-flag/raw/test-unit.txt`.
- Gaps:
  - None.

### AC4
- Status: PASS
- Proof:
  - `bin/tamp.js`: exports pure helpers `parsePresetArgv(argv)` and `parseCliFlags(argv)` validating `--preset NAME` / `--preset=NAME` via `Object.hasOwn(COMPRESSION_PRESETS, raw)` without calling `process.exit`.
  - `main()` prints structured error messages to stderr and exits with code `2` on missing value (`--preset`), empty value (`--preset=`), unknown value (`--preset bogus`), prototype-chain keys (`--preset toString`, `--preset=constructor`, `--preset __proto__`), and mutually exclusive `--level` + `--preset` in any order/form.
  - Verified by unit tests and real `node bin/tamp.js` subprocess checks in `test/cli-hardening.test.js` and manual CLI runs.
  - See `.agent/tasks/cli-preset-flag/raw/test-unit.txt` and `.agent/tasks/cli-preset-flag/raw/test-integration.txt`.
- Gaps:
  - None.

### AC5
- Status: PASS
- Proof:
  - `bin/tamp.js` (`resolveNonInteractiveConfig`): accepts `argvPreset = null` and sets `loadOpts.presetOverride = argvPreset` when `argvPreset !== null`; `main()` threads `argvPreset` into `resolveNonInteractiveConfig`.
  - Zero `process.env` mutation (`TAMP_STAGES`, `TAMP_COMPRESSION_PRESET`, `TAMP_LEVEL`, `TAMP_LLMLINGUA_URL` remain untouched).
  - Verified by `test/cli-hardening.test.js` (`resolves --preset recommended non-interactively without starting sidecar or mutating process.env`): `probe.preset === 'recommended'`, `probe.level === null`, `probe.levelSource === 'preset-flag'`, 14 stages excluding `'llmlingua'`, `startSidecarFn` never called, and `createProxy(res.overrides, res.loadOpts)` produces identical config properties.
  - See `.agent/tasks/cli-preset-flag/raw/test-unit.txt` and `.agent/tasks/cli-preset-flag/raw/lint.txt`.
- Gaps:
  - None.

### AC6
- Status: PASS
- Proof:
  - `bin/tamp.js`: passes `argvPreset` to `App` without mutating `process.env`.
  - `bin/ui/App.js`: exports `resolveInteractiveSeed({ argvLevel, argvPreset, envStages })` and uses it when rendering `LevelPicker`:
    - Anchored presets (`conservative` -> `4`, `balanced` -> `5`, `aggressive` -> `8`) return `envLevel: argvLevel ?? preset.level` and preserve `envStages`.
    - `recommended` (`level: null`) keeps `envLevel: argvLevel` (`null`) and seeds `envStages: envStages ?? new Set(preset.stages)` (preserving `TAMP_STAGES > --preset` when `envStages` is already set).
    - Absent/null/invalid/prototype-key `argvPreset` passes `argvLevel` and `envStages` through unchanged.
  - Verified by `test/cli-hardening.test.js` (`resolveInteractiveSeed maps anchored presets to envLevel and recommended to envStages Set`) and `test/tui-state-telemetry.test.js` (18/18 tests pass, including zero `process.env.TAMP_*` mutation guard).
  - See `.agent/tasks/cli-preset-flag/raw/test-unit.txt`.
- Gaps:
  - None.

### AC7
- Status: PASS
- Proof:
  - `bin/tamp.js`: `help` / `--help` / `-h` prints `  --preset NAME    Compression preset (conservative, balanced, aggressive, recommended)` under `Options:` and exits `0`.
  - Verified by `test/cli-hardening.test.js` (`subprocess: tamp help / --help / -h exits 0 and documents --preset NAME`) and manual CLI output capture.
  - See `.agent/tasks/cli-preset-flag/raw/test-integration.txt`.
- Gaps:
  - None.

### AC8
- Status: PASS
- Proof:
  - Targeted unit & subprocess tests (`node --test test/config.test.js test/metadata.test.js test/cli-hardening.test.js test/tui-state-telemetry.test.js`): 118/118 pass, 0 fail.
  - Full test suite (`npm test`): 943/943 tests pass across 213 suites, 0 fail + `bench/retrieval-eval.js` PASS (mean NDCG@10 0.931, Recall 100.0%, definition survival 100.0%).
  - Integration smoke suite (`node smoke.js`): All checks passed! (exit 0).
  - Syntax checks (`node --check config.js metadata.js bin/tamp.js bin/ui/App.js`): exit 0.
  - Diff strictly scoped to 7 files (`config.js`, `metadata.js`, `bin/tamp.js`, `bin/ui/App.js`, `test/config.test.js`, `test/metadata.test.js`, `test/cli-hardening.test.js`), zero new dependencies.
  - See `.agent/tasks/cli-preset-flag/raw/build.txt`, `.agent/tasks/cli-preset-flag/raw/lint.txt`, `.agent/tasks/cli-preset-flag/raw/test-unit.txt`, and `.agent/tasks/cli-preset-flag/raw/test-integration.txt`.
- Gaps:
  - None.

## Commands run
- `node --check config.js && node --check metadata.js && node --check bin/tamp.js && node --check bin/ui/App.js` (exit 0)
- `node --test test/config.test.js test/metadata.test.js test/cli-hardening.test.js test/tui-state-telemetry.test.js` (exit 0; 118/118 pass)
- `npm test` (exit 0; 943/943 pass + `bench/retrieval-eval.js` PASS)
- `node smoke.js` (exit 0; All checks passed!)
- Manual CLI subprocess invocations (`help`, `--help`, `-h`, `--preset`, `--preset=`, `--preset bogus`, `--preset toString`, `--preset=constructor`, `--preset __proto__`, `--level 5 --preset recommended`, `--preset=balanced --level=5`)
- `git status --short` and `git diff --stat`

## Raw artifacts
- `.agent/tasks/cli-preset-flag/raw/build.txt`
- `.agent/tasks/cli-preset-flag/raw/lint.txt`
- `.agent/tasks/cli-preset-flag/raw/test-unit.txt`
- `.agent/tasks/cli-preset-flag/raw/test-integration.txt`

## Known gaps
- None.
