# Evidence Bundle: onboarding-discovery-sync

## Summary
- Overall status: PASS
- Last updated: 2026-11-26T20:26:00+00:00

## Acceptance criteria evidence

### AC1
- Status: PASS
- Proof:
  - `setup.sh` and `site/setup.sh` are byte-identical (`cmp -s setup.sh site/setup.sh` → exit 0, both 4058 bytes).
  - Both retain executable permissions (`test -x setup.sh && test -x site/setup.sh` → exit 0; `-rwxr-xr-x`).
  - Both pass syntax check (`bash -n setup.sh && bash -n site/setup.sh` → exit 0).
  - Raw proof: `.agent/tasks/onboarding-discovery-sync/raw/lint.txt`, `.agent/tasks/onboarding-discovery-sync/raw/test-unit.txt`.
- Gaps:
  - None.

### AC2
- Status: PASS
- Proof:
  - `setup.sh:63-64` and `site/setup.sh:63-64` configure `ANTHROPIC_BASE_URL` as `http://localhost:$PORT` and `OPENAI_API_BASE` as `http://localhost:$PORT/v1`.
  - Verified by `node --test test/docs.test.js` (exit 0).
  - Raw proof: `.agent/tasks/onboarding-discovery-sync/raw/test-unit.txt`.
- Gaps:
  - None.

### AC3
- Status: PASS
- Proof:
  - `setup.sh:30` and `site/setup.sh:30` upgrade existing installs with `npm install -g @sliday/tamp@latest --silent 2>/dev/null` and contain no `npm update -g` (fresh install on line 33 left unchanged).
  - Verified by `node --test test/docs.test.js` (exit 0).
  - Raw proof: `.agent/tasks/onboarding-discovery-sync/raw/test-unit.txt`.
- Gaps:
  - None.

### AC4
- Status: PASS
- Proof:
  - `setup.sh:68-78` and `site/setup.sh:68-78` replace `"skip all this and use the plugin"` with `Claude Code plugin: auto-starts Tamp; still requires` / `ANTHROPIC_BASE_URL in ~/.claude/settings.json` while retaining both `claude plugin` commands.
  - ANSI-stripped border width check confirms all 11 Done box lines align to exactly 61 visible characters.
  - Raw proof: `.agent/tasks/onboarding-discovery-sync/raw/lint.txt`, `.agent/tasks/onboarding-discovery-sync/raw/test-unit.txt`.
- Gaps:
  - None.

### AC5
- Status: PASS
- Proof:
  - `site/index.md:29` replaces `tamp start` with `tamp # or: tamp -y` (zero occurrences of `tamp start`).
  - `site/index.md:37-38` documents `export OPENAI_API_BASE="http://localhost:7778/v1"` directly beneath `export ANTHROPIC_BASE_URL="http://localhost:7778"`.
  - Verified by `node --test test/docs.test.js` (exit 0).
  - Raw proof: `.agent/tasks/onboarding-discovery-sync/raw/test-unit.txt`.
- Gaps:
  - None.

### AC6
- Status: PASS
- Proof:
  - `site/index.html:1680` updates WebMCP `get_config_example` `inputSchema.properties.preset.enum` to `['conservative','balanced','aggressive','recommended']` (and `execute` returns `TAMP_MIN_SIZE: '1024'` for `recommended`).
  - Verified by `node --test test/docs.test.js` (exit 0).
  - Raw proof: `.agent/tasks/onboarding-discovery-sync/raw/test-unit.txt`.
- Gaps:
  - None.

### AC7
- Status: PASS
- Proof:
  - `site/index.html:1435` updates stale copy to `Four presets simplify configuration—no need to memorize 20 stage names:`.
  - `site/index.html:1449-1460` preserves `Default` badge on `Balanced` and changes sublabel to `Everyday default`.
  - `site/index.html:1475-1485` adds a fourth `.db-card.db-surface--raised.preset-card` documenting `Recommended` (`63–80%`, aggressive minus `llmlingua`, `TAMP_COMPRESSION_PRESET=recommended`, `TAMP_MIN_SIZE=1024`).
  - Static diff check confirms zero new hardcoded hex/rgb/hsl colors were added to `site/index.html`; only existing theme classes and `var(--tamp-inline-code-bg)` are used.
  - Raw proof: `.agent/tasks/onboarding-discovery-sync/raw/lint.txt`, `.agent/tasks/onboarding-discovery-sync/raw/test-unit.txt`.
- Gaps:
  - None.

### AC8
- Status: PASS
- Proof:
  - `test/docs.test.js:39-70` adds regression tests for all 4 required assertion groups.
  - `node --test test/docs.test.js` → 6/6 pass (exit 0).
  - `npm test` → 911/911 pass across 207 suites + `bench/retrieval-eval.js` PASS at 100.0% definition survival (exit 0).
  - Raw proof: `.agent/tasks/onboarding-discovery-sync/raw/test-unit.txt`, `.agent/tasks/onboarding-discovery-sync/raw/test-integration.txt`.
- Gaps:
  - None.

## Commands run
- `bash -n setup.sh && bash -n site/setup.sh` (exit 0)
- `cmp -s setup.sh site/setup.sh` (exit 0)
- `test -x setup.sh && test -x site/setup.sh` (exit 0)
- `node --test test/docs.test.js` (exit 0, 6/6 pass)
- `npm test` (exit 0, 911/911 pass, retrieval-eval PASS)
- `git status --short` / `git diff --stat` (exit 0, only the 5 scoped files modified)

## Raw artifacts
- `.agent/tasks/onboarding-discovery-sync/raw/build.txt`
- `.agent/tasks/onboarding-discovery-sync/raw/test-unit.txt`
- `.agent/tasks/onboarding-discovery-sync/raw/test-integration.txt`
- `.agent/tasks/onboarding-discovery-sync/raw/lint.txt`

## Known gaps
- No live browser screenshot was captured for `site/index.html`; light/dark WCAG AA contrast preservation is verified via static diff inspection confirming zero new hardcoded color literals and exclusive reuse of existing theme CSS classes and variables.
