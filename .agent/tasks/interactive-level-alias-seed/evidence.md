# Evidence Bundle: interactive-level-alias-seed

## Summary
- Overall status: PASS
- Last updated: 2026-11-27T01:38:00+00:00
- Changed files (4 allowlisted files only):
  - `bin/ui/LevelPicker.js`
  - `bin/ui/App.js`
  - `test/level-picker.test.js`
  - `test/tui-state-telemetry.test.js`

## Acceptance criteria evidence

### AC1 (`LevelPicker.js` alias resolution in `initialLevel`)
- Status: PASS
- Proof:
  - `bin/ui/LevelPicker.js`: imports `LEVEL_ALIASES` from `../../metadata.js` and resolves own-key alias strings in `initialLevel(envLevel)` via `typeof envLevel === 'string' && Object.hasOwn(LEVEL_ALIASES, envLevel)` while returning integers `1..9` unchanged and falling back to `DEFAULT_LEVEL` (`5`) for numeric strings (`'1'`, `'5'`, `'9'`), out-of-range/non-integer numbers, `null`/`undefined`/empty/unknown/case-or-whitespace-mismatched strings, and prototype-chain keys (`'toString'`, `'constructor'`, `'valueOf'`, `'hasOwnProperty'`, `'__proto__'`).
  - Targeted unit tests (`node --test test/level-picker.test.js test/tui-state-telemetry.test.js test/cli-hardening.test.js`, exit `0`, 54/54 pass): `LevelPicker reducer` tests verify all 4 aliases (`conservative`->4, `balanced`->5, `aggressive`->8, `max`->9), prototype-chain key rejection, numeric string rejection (`initialLevel('5') === DEFAULT_LEVEL`), and invalid number/string fallbacks.
  - Raw artifacts: `.agent/tasks/interactive-level-alias-seed/raw/lint.txt`, `.agent/tasks/interactive-level-alias-seed/raw/test-unit.txt`.
- Gaps:
  - None.

### AC2 (`App.js` `argvLevel` normalization in `resolveInteractiveSeed`)
- Status: PASS
- Proof:
  - `bin/ui/App.js`: imports `LEVEL_ALIASES` from `../../metadata.js` and normalizes `argvLevel` into `normalizedLevel` (valid integer `1..9` -> `argvLevel`, own-key `LEVEL_ALIASES` string -> `LEVEL_ALIASES[argvLevel]`, all else -> `null`) prior to `COMPRESSION_PRESETS` handling. Anchored presets return `{ envLevel: normalizedLevel ?? preset.level, envStages }`, `recommended` (`preset.level === null`) returns `{ envLevel: normalizedLevel, envStages: envStages ?? new Set(preset.stages) }`, and missing/invalid/prototype `argvPreset` returns `{ envLevel: normalizedLevel, envStages }`.
  - Targeted unit tests (`node --test test/level-picker.test.js test/tui-state-telemetry.test.js test/cli-hardening.test.js`, exit `0`, 54/54 pass): `resolveInteractiveSeed: level alias normalization and preset interactions` verifies all 4 aliases, invalid/prototype/numeric/out-of-range normalization to `null`, non-masking of anchored presets, valid alias/integer precedence over anchored presets, `recommended` preset + `envStages` precedence, and `initialLevel` parity.
  - Raw artifacts: `.agent/tasks/interactive-level-alias-seed/raw/lint.txt`, `.agent/tasks/interactive-level-alias-seed/raw/test-unit.txt`.
- Gaps:
  - None.

### AC3 (Backward compatibility with existing hardening tests)
- Status: PASS
- Proof:
  - `test/cli-hardening.test.js` was not modified (`git status --short` in `.agent/tasks/interactive-level-alias-seed/raw/lint.txt`).
  - Existing `test/level-picker.test.js` assertions (including `assert.equal(initialLevel('5'), DEFAULT_LEVEL)`) and all `test/cli-hardening.test.js` suites (including `resolveInteractiveSeed`) passed with exit `0` (`54/54` tests in targeted run; `1001/1001` in full `npm test`).
  - Raw artifacts: `.agent/tasks/interactive-level-alias-seed/raw/lint.txt`, `.agent/tasks/interactive-level-alias-seed/raw/test-unit.txt`.
- Gaps:
  - None.

### AC4 (Deterministic TTY-free unit test coverage)
- Status: PASS
- Proof:
  - `test/level-picker.test.js`: adds deterministic TTY-free tests for all 4 `LEVEL_ALIASES`, prototype-chain keys (`'toString'`, `'constructor'`, `'valueOf'`, `'hasOwnProperty'`, `'__proto__'`), numeric strings (`'1'`, `'5'`, `'9'`), unknown/empty/case-mismatched/padded strings, out-of-range integers (`0`, `10`, `-1`), and `NaN`/non-integers (`4.5`, `Infinity`, `-Infinity`).
  - `test/tui-state-telemetry.test.js`: adds deterministic TTY-free `resolveInteractiveSeed` tests covering all 4 aliases with `argvPreset: null`, invalid/prototype/numeric/out-of-range/NaN normalization to `null`, `argvLevel` + `argvPreset` combinations (anchored presets non-masking, valid alias/integer precedence, `recommended` preset with `envStages: null` and caller-supplied `Set`), and `initialLevel(resolveInteractiveSeed({ argvLevel: alias }).envLevel)` parity across every entry in `LEVEL_ALIASES`.
  - Targeted test run passed cleanly with exit `0` (`54/54` pass, `0` fail, `779.5ms`).
  - Raw artifacts: `.agent/tasks/interactive-level-alias-seed/raw/test-unit.txt`.
- Gaps:
  - None.

### AC5 (Scope, stack, and full regression gate)
- Status: PASS
- Proof:
  - Plain Node.js ESM JavaScript only; zero new external dependencies (`package.json` untouched).
  - `git status --short` and `git diff --stat` confirm only the 4 allowlisted files (`bin/ui/LevelPicker.js`, `bin/ui/App.js`, `test/level-picker.test.js`, `test/tui-state-telemetry.test.js`) were edited (plus `.agent/tasks/interactive-level-alias-seed/` workflow artifacts).
  - `node --check bin/ui/LevelPicker.js bin/ui/App.js test/level-picker.test.js test/tui-state-telemetry.test.js` exited `0`.
  - `npm test` exited `0` (`1001` tests, `228` suites, `1001` pass, `0` fail, `8486.3ms`; `bench/retrieval-eval.js` `PASS` with `100.0%` definition survival).
  - `node smoke.js` exited `0` (Tests 1–6 all `PASS`).
  - Raw artifacts: `.agent/tasks/interactive-level-alias-seed/raw/build.txt`, `.agent/tasks/interactive-level-alias-seed/raw/lint.txt`, `.agent/tasks/interactive-level-alias-seed/raw/test-unit.txt`, `.agent/tasks/interactive-level-alias-seed/raw/test-integration.txt`.
- Gaps:
  - None.

## Commands run
- `node --version` (exit `0`: `v22.17.0`)
- `node --check bin/ui/LevelPicker.js bin/ui/App.js test/level-picker.test.js test/tui-state-telemetry.test.js` (exit `0`)
- `node --test test/level-picker.test.js test/tui-state-telemetry.test.js test/cli-hardening.test.js` (exit `0`: 54/54 pass, 13 suites)
- `npm test` (exit `0`: 1001/1001 pass, 228 suites + `bench/retrieval-eval.js` PASS)
- `node smoke.js` (exit `0`: Tests 1–6 PASS)
- `git status --short` and `git diff --stat` (exit `0`: 4 allowlisted files changed, +198/-7)

## Raw artifacts
- `.agent/tasks/interactive-level-alias-seed/raw/build.txt`
- `.agent/tasks/interactive-level-alias-seed/raw/lint.txt`
- `.agent/tasks/interactive-level-alias-seed/raw/test-unit.txt`
- `.agent/tasks/interactive-level-alias-seed/raw/test-integration.txt`

## Known gaps
- None.
