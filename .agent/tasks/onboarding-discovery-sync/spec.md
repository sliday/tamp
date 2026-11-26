# Task Spec: onboarding-discovery-sync

## Metadata
- Task ID: onboarding-discovery-sync
- Created: 2026-11-26T20:17:44+00:00
- Repo root: /Users/stas/Playground/tamp
- Working directory at init: /Users/stas/Playground/tamp

## Guidance sources
- AGENTS.md
- CLAUDE.md

## Original task statement
Fix T-02 (RICE #1, score 19.0): Onboarding and discovery drift across setup.sh, site/setup.sh, site/index.md, and site/index.html. 1) Keep setup.sh and site/setup.sh byte-identical; use http://localhost:$PORT/v1 for OPENAI_API_BASE; upgrade existing installs with npm install -g @sliday/tamp@latest instead of npm update -g; accurately describe the Claude Code plugin (auto-starts Tamp; still requires ANTHROPIC_BASE_URL in ~/.claude/settings.json). 2) In site/index.md, replace nonexistent 'tamp start' with 'tamp' (or 'tamp -y') and keep OPENAI_API_BASE guidance consistent with /v1. 3) In site/index.html, update WebMCP get_config_example preset enum to include 'recommended', update the stale 'no need to memorize 10 stage names' copy to 20 stage names, and document the 'recommended' preset in the Compression Presets section while preserving light/dark WCAG AA contrast. 4) Add regression assertions in test/docs.test.js covering setup.sh === site/setup.sh parity, /v1 on OPENAI_API_BASE, no 'tamp start' in site/index.md, and 'recommended' in site/index.html WebMCP schema.

## Acceptance criteria
- **AC1 (`setup.sh` / `site/setup.sh` parity, syntax, and permissions):** `setup.sh` and `site/setup.sh` are byte-identical (`cmp -s setup.sh site/setup.sh`), both retain their executable bit (`0755` / `+x`), and both pass `bash -n`.
- **AC2 (`OPENAI_API_BASE` includes `/v1` in setup scripts):** Both `setup.sh` and `site/setup.sh` configure `OPENAI_API_BASE` with `"http://localhost:$PORT/v1"` while keeping `ANTHROPIC_BASE_URL` at `"http://localhost:$PORT"`.
- **AC3 (Safe npm upgrade path in setup scripts):** In both `setup.sh` and `site/setup.sh`, when `tamp` is already installed, the script upgrades via `npm install -g @sliday/tamp@latest --silent 2>/dev/null` and does not invoke `npm update -g`.
- **AC4 (Accurate Claude Code plugin note in setup scripts):** Both `setup.sh` and `site/setup.sh` replace the misleading `"skip all this and use the plugin"` copy with an accurate note stating that the Claude Code plugin auto-starts Tamp and still requires `ANTHROPIC_BASE_URL` in `~/.claude/settings.json`, while keeping the two plugin install commands (`claude plugin marketplace add sliday/claude-plugins` and `claude plugin install tamp@sliday`) and clean box alignment.
- **AC5 (`site/index.md` CLI start command and `/v1` guidance):** `site/index.md` replaces `tamp start` with `tamp` (or `tamp -y`), has zero occurrences of `tamp start`, and documents `OPENAI_API_BASE="http://localhost:7778/v1"` consistently alongside `ANTHROPIC_BASE_URL="http://localhost:7778"` in the "Wire it up in 30 seconds" section.
- **AC6 (`site/index.html` WebMCP `get_config_example` preset enum):** The WebMCP `get_config_example` tool schema in `site/index.html` includes `'recommended'` in `inputSchema.properties.preset.enum` (`['conservative', 'balanced', 'aggressive', 'recommended']`), matching `COMPRESSION_PRESETS` in `metadata.js`.
- **AC7 (`site/index.html` Compression Presets section update):** In `#caveman-features` → `Compression Presets`:
  - The stale copy `"Three intensity levels simplify configuration—no need to memorize 10 stage names:"` is updated to reflect all 4 presets and `20 stage names` (matching `ALL_STAGES.length === 20` in `metadata.js`).
  - A fourth `.db-card.db-surface--raised.preset-card` documents the `recommended` preset (`TAMP_COMPRESSION_PRESET=recommended`, `63–80%` expected savings, aggressive stages minus `llmlingua`, paired with `TAMP_MIN_SIZE=1024`), matching `COMPRESSION_PRESETS.recommended` in `metadata.js`.
  - The `Balanced` card's sublabel is disambiguated from the `Recommended` preset name (while keeping `Balanced` badged as `Default`).
  - Only existing semantic CSS classes and theme variables are used so light/dark WCAG AA contrast is preserved.
- **AC8 (Regression tests in `test/docs.test.js`):** `test/docs.test.js` includes assertions covering:
  1. `setup.sh` and `site/setup.sh` byte-for-byte equality.
  2. `setup.sh` setting `OPENAI_API_BASE` to `http://localhost:$PORT/v1`, upgrading with `npm install -g @sliday/tamp@latest` (and not `npm update -g`), and mentioning `~/.claude/settings.json` instead of `"skip all this"`.
  3. `site/index.md` containing no `tamp start` and documenting `OPENAI_API_BASE` with `/v1`.
  4. `site/index.html` containing `'recommended'` in the WebMCP `get_config_example` preset enum, referencing `20 stage names` (and not `10 stage names`), and documenting the `recommended` preset in the Compression Presets section.

## Constraints
- Preserve the executable permission bit (`+x`) on both `setup.sh` and `site/setup.sh`.
- Both `setup.sh` and `site/setup.sh` must pass `bash -n` syntax validation.
- Keep existing light and dark WCAG AA CSS color tokens (`:root` / `[data-theme]` variables) in `site/index.html` untouched and reuse existing card/typography classes and tokens for new markup.
- Keep diffs strictly minimal and scoped to `setup.sh`, `site/setup.sh`, `site/index.md`, `site/index.html`, and `test/docs.test.js` — no unrelated reformatting, prose churn, or changes to runtime proxy/compression code.
- Never introduce new dependencies; keep ESM plain JavaScript conventions in `test/docs.test.js`.

## Non-goals
- Changing `metadata.js`, `compress.js`, `index.js`, `bin/tamp.js`, or any runtime compression/preset behavior.
- Editing unrelated documentation files (`README.md`, whitepapers, `.well-known/*`, etc.).
- Redesigning the `site/index.html` theme, palette, or sections outside `#caveman-features` (Compression Presets) and the WebMCP `get_config_example` registration block.
- Modifying `setup.sh` shell-detection logic, `PORT` default, or fresh-install `npm install` flow beyond the targeted upgrade, `OPENAI_API_BASE`, and plugin-note fixes.

## Assumptions and narrow resolutions
- **CLI command in `site/index.md`:** Replace `tamp start` with `tamp` (with an optional inline comment noting `# or: tamp -y` for non-interactive mode), consistent with `setup.sh`.
- **`OPENAI_API_BASE` in `site/index.md`:** Add `export OPENAI_API_BASE="http://localhost:7778/v1"` directly beneath `export ANTHROPIC_BASE_URL="http://localhost:7778"` in the "Wire it up in 30 seconds" fenced shell block, with short inline comments (`# Claude Code` / `# Aider, Cursor, Cline`).
- **Fresh-install line in `setup.sh`:** Leave `npm install -g @sliday/tamp --silent 2>/dev/null` unchanged in the `else` branch; only replace `npm update -g @sliday/tamp --silent 2>/dev/null` in the existing-install branch with `npm install -g @sliday/tamp@latest --silent 2>/dev/null`.
- **ASCII box alignment in `setup.sh`:** Keep the Done summary box neatly aligned and within ~80 columns, using an extra wrapped line if needed so the accurate Claude Code plugin note ("auto-starts Tamp; still needs ANTHROPIC_BASE_URL in ~/.claude/settings.json") fits cleanly.
- **Preset grid in `site/index.html`:** Keep the responsive CSS grid container on the 4 preset cards (reusing `.db-card.db-surface--raised.preset-card`); optionally tune only the grid `minmax(...)` inline if needed for clean wrapping, without altering any theme color tokens.
- **Balanced card sublabel in `site/index.html`:** Change `Balanced`'s `<span class="preset-savings-label">Recommended</span>` to `Default` / `Everyday default` (e.g. `Everyday default`) so it does not collide with the dedicated `Recommended` preset card.

## Verification plan
- **Build:** N/A (plain ESM Node.js + static HTML/Markdown/Bash).
- **Unit tests:**
  - `node --test test/docs.test.js`
  - `npm test` (runs `node --test test/*.test.js && node bench/retrieval-eval.js`)
- **Integration tests:** N/A (no runtime proxy behavior changed; `npm test` covers existing proxy/stage tests).
- **Lint / static checks:**
  - `bash -n setup.sh && bash -n site/setup.sh`
  - `cmp -s setup.sh site/setup.sh`
  - `test -x setup.sh && test -x site/setup.sh`
- **Manual checks:**
  - `git diff --stat` confirms only the 5 scoped files changed (`setup.sh`, `site/setup.sh`, `site/index.md`, `site/index.html`, `test/docs.test.js`) plus task artifacts.
  - Inspect rendered text of the `setup.sh` Done box for clean border alignment and verify `#caveman-features` preset cards in `site/index.html` use existing WCAG AA CSS tokens with no hardcoded low-contrast colors.
