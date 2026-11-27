# Task Spec: interactive-level-alias-seed

## Metadata
- Task ID: interactive-level-alias-seed
- Created: 2026-11-27T01:33:40+00:00
- Frozen: 2026-11-27T01:34:30+00:00
- Repo root: /Users/stas/Playground/tamp
- Working directory at init: /Users/stas/Playground/tamp

## Guidance sources
- `AGENTS.md`
- `CLAUDE.md`
- `metadata.js` (`LEVEL_ALIASES`, `COMPRESSION_PRESETS`, `DEFAULT_LEVEL`, `resolveLevel`)
- `bin/ui/LevelPicker.js` (`initialLevel`)
- `bin/ui/App.js` (`resolveInteractiveSeed`)
- `test/level-picker.test.js`
- `test/tui-state-telemetry.test.js`
- `test/cli-hardening.test.js`

## Original task statement
Fix T-09 (RICE #1, score 5.7): Interactive --level <alias> seed parity. 1) In bin/ui/LevelPicker.js, update initialLevel(envLevel) so valid LEVEL_ALIASES strings (conservative=4, balanced=5, aggressive=8, max=9) resolve via Object.hasOwn(LEVEL_ALIASES, envLevel) to their canonical integer level, while continuing to reject numeric strings like "5" (preserving existing test/level-picker.test.js contract) and prototype-chain keys (toString, constructor, __proto__) back to DEFAULT_LEVEL. 2) In bin/ui/App.js, update resolveInteractiveSeed({ argvLevel, argvPreset, envStages }) to normalize argvLevel via Object.hasOwn(LEVEL_ALIASES, argvLevel) (so tamp --level aggressive seeds envLevel: 8 instead of raw string "aggressive", and invalid/prototype strings do not mask argvPreset). 3) Add deterministic unit tests in test/level-picker.test.js and test/tui-state-telemetry.test.js covering all 4 aliases, prototype-chain keys, numeric string rejection, and argvLevel + argvPreset interactions.

## Acceptance criteria
- **AC1 (`LevelPicker.js` alias resolution in `initialLevel`)**:
  - `initialLevel(envLevel)` in `bin/ui/LevelPicker.js` imports `LEVEL_ALIASES` from `../../metadata.js`.
  - Returns `envLevel` unchanged when `Number.isInteger(envLevel) && envLevel >= 1 && envLevel <= 9`.
  - Returns `LEVEL_ALIASES[envLevel]` when `typeof envLevel === 'string' && Object.hasOwn(LEVEL_ALIASES, envLevel)` (`'conservative'` -> `4`, `'balanced'` -> `5`, `'aggressive'` -> `8`, `'max'` -> `9`).
  - Returns `DEFAULT_LEVEL` (`5`) for all other inputs, specifically including:
    - numeric strings (`'1'`, `'5'`, `'9'`), preserving `assert.equal(initialLevel('5'), DEFAULT_LEVEL)` in `test/level-picker.test.js`,
    - out-of-range integers (`0`, `10`, `-1`), non-integer numbers (`4.5`, `NaN`, `Infinity`),
    - `null`, `undefined`, empty string `''`, unknown strings (`'bogus'`), case/whitespace variants (`'Aggressive'`, `' aggressive '`),
    - prototype-chain keys (`'toString'`, `'constructor'`, `'valueOf'`, `'hasOwnProperty'`, `'__proto__'`).

- **AC2 (`App.js` `argvLevel` normalization in `resolveInteractiveSeed`)**:
  - `resolveInteractiveSeed({ argvLevel = null, argvPreset = null, envStages = null } = {})` in `bin/ui/App.js` imports `LEVEL_ALIASES` from `../../metadata.js` and normalizes `argvLevel` into `normalizedLevel` before preset handling:
    - valid integer `1..9` -> `argvLevel`,
    - valid own-key string (`typeof argvLevel === 'string' && Object.hasOwn(LEVEL_ALIASES, argvLevel)`) -> `LEVEL_ALIASES[argvLevel]` (`4`/`5`/`8`/`9`),
    - anything else (`null`, `undefined`, numeric strings such as `'5'`, out-of-range integers `0`/`10`/`-1`, floats, `NaN`, unknown/case-mismatched strings, and prototype-chain keys `'toString'`, `'constructor'`, `'valueOf'`, `'hasOwnProperty'`, `'__proto__'`) -> `null`.
  - When `typeof argvPreset === 'string' && Object.hasOwn(COMPRESSION_PRESETS, argvPreset)`:
    - If `Number.isInteger(preset.level)` (`conservative`, `balanced`, `aggressive`), returns `{ envLevel: normalizedLevel ?? preset.level, envStages }`, so valid integer or alias `argvLevel` wins while invalid/prototype `argvLevel` does not mask `preset.level`.
    - If `preset.level === null` (`recommended`), returns `{ envLevel: normalizedLevel, envStages: envStages ?? new Set(preset.stages) }`.
  - Otherwise (missing, invalid, or prototype-chain `argvPreset`), returns `{ envLevel: normalizedLevel, envStages }`.

- **AC3 (Backward compatibility with existing hardening tests)**:
  - All existing tests in `test/cli-hardening.test.js` (including the `resolveInteractiveSeed` suite) and `test/level-picker.test.js` (including `initialLevel('5') === DEFAULT_LEVEL`) pass without modification to `test/cli-hardening.test.js`.

- **AC4 (Deterministic TTY-free unit test coverage)**:
  - `test/level-picker.test.js` adds deterministic unit tests covering:
    - all 4 `LEVEL_ALIASES` (`conservative` -> `4`, `balanced` -> `5`, `aggressive` -> `8`, `max` -> `9`),
    - prototype-chain keys (`'toString'`, `'constructor'`, `'valueOf'`, `'hasOwnProperty'`, `'__proto__'`),
    - numeric strings (`'5'`, `'1'`, `'9'`), unknown/empty/case-mismatched strings, out-of-range integers (`0`, `10`, `-1`), and `NaN`/non-integers falling back to `DEFAULT_LEVEL`.
  - `test/tui-state-telemetry.test.js` adds deterministic unit tests for `resolveInteractiveSeed` covering:
    - all 4 `LEVEL_ALIASES` resolving to canonical integers (`4`, `5`, `8`, `9`) with `argvPreset: null`,
    - prototype-chain keys, numeric strings, out-of-range integers, `NaN`, and unknown strings normalizing to `envLevel: null`,
    - `argvLevel` + `argvPreset` combinations: invalid/prototype/numeric-string/out-of-range `argvLevel` not masking anchored presets (`conservative`/`balanced`/`aggressive`), valid alias/integer `argvLevel` taking precedence over anchored preset level, and `recommended` preset interactions (both with `envStages: null` and caller-supplied `envStages` `Set`),
    - parity check confirming `initialLevel(resolveInteractiveSeed({ argvLevel: alias }).envLevel)` returns the canonical integer for every alias in `LEVEL_ALIASES`.

- **AC5 (Scope, stack, and full regression gate)**:
  - Only plain Node.js ESM JavaScript is used (no TypeScript, no new external dependencies).
  - Source and test edits are restricted strictly to:
    - `bin/ui/LevelPicker.js`
    - `bin/ui/App.js`
    - `test/level-picker.test.js`
    - `test/tui-state-telemetry.test.js`
  - Full test suite (`npm test`) and smoke check (`node smoke.js`) pass with zero failures.

## Constraints
- Stack: Plain Node.js ESM JavaScript only (no TypeScript, no build step, no new dependencies).
- Strict edit allowlist: `bin/ui/LevelPicker.js`, `bin/ui/App.js`, `test/level-picker.test.js`, `test/tui-state-telemetry.test.js` (plus `.agent/tasks/interactive-level-alias-seed/` workflow artifacts).
- Use `Object.hasOwn(LEVEL_ALIASES, ...)` for alias lookup to guard against `Object.prototype` keys.
- Keep diffs minimal: no unrelated reformatting, comment churn, or refactors outside the targeted functions and test additions.
- All unit tests must be deterministic and TTY-free (no live Ink rendering or terminal I/O required).
- Never push to `main`.

## Non-goals
- Changing CLI flag parsing in `bin/tamp.js` (`parseLevelFlag` already returns own-key alias strings and integers `1..9`, and `--level` + `--preset` mutual exclusion remains untouched).
- Changing `metadata.js` (`LEVEL_ALIASES`, `COMPRESSION_PRESETS`, `COMPRESSION_LEVELS`, `resolveLevel`), `config.js`, or non-interactive config resolution.
- Accepting numeric strings (`'1'`..`'9'`) or case-insensitive/whitespace-padded alias strings in `initialLevel` or `resolveInteractiveSeed`.
- Modifying `test/cli-hardening.test.js`, `LevelPicker` UI layout/keybindings, `levelReducer`, or `buildLevelPayload`.

## Narrow ambiguity resolutions & assumptions
- **Case sensitivity and trimming**: Alias matching is exact and case-sensitive against `Object.hasOwn(LEVEL_ALIASES, value)`, matching `resolveLevel` in `metadata.js` and `parseLevelFlag` in `bin/tamp.js`. Uppercase or padded strings (e.g., `'Aggressive'`, `' max '`) are rejected (`DEFAULT_LEVEL` in `initialLevel`, `null` in `resolveInteractiveSeed`).
- **Numeric strings**: Explicitly rejected by both `initialLevel` (returns `DEFAULT_LEVEL`) and `resolveInteractiveSeed` (normalizes `argvLevel` to `null`), preserving the documented `test/level-picker.test.js` contract (`initialLevel('5') === DEFAULT_LEVEL`).
- **Out-of-range or non-integer `argvLevel` in `resolveInteractiveSeed`**: Normalized to `null` (not passed through raw) so invalid programmatic inputs cannot mask `argvPreset` or leak invalid values into `LevelPicker`.
- **Single-source alias map**: Both files read from `LEVEL_ALIASES` exported by `metadata.js` rather than duplicating a literal map, keeping the alias table single-sourced.

## Verification plan
- **Build**: None required (plain Node.js ESM; no transpile/build step).
- **Unit tests**:
  - `node --test test/level-picker.test.js test/tui-state-telemetry.test.js test/cli-hardening.test.js`
  - `npm test` (full `node --test test/*.test.js` suite)
- **Integration / smoke tests**:
  - `node smoke.js`
- **Lint / diff checks**:
  - `git status --short` and `git diff --stat` confirming only the 4 allowlisted source/test files (plus `.agent/tasks/interactive-level-alias-seed/` artifacts) changed, with minimal diff and no new dependencies.
- **Manual checks**:
  - Inspect `bin/ui/LevelPicker.js` and `bin/ui/App.js` diffs to confirm `Object.hasOwn(LEVEL_ALIASES, ...)` guards, `DEFAULT_LEVEL` / `null` fallback paths, and zero `process.env` mutations.
