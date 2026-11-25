// Targets:
//   pnpm install / pnpm i / pnpm add / pnpm update
//   bun install / bun i / bun add / bun update
//
// Strips: pnpm/bun progress bars, "Progress: resolved ...", spinner frames,
// "Resolving dependencies", and "Saved lockfile" progress lines.
// Keeps: errors, warnings, and final package summaries ("Done in ...",
// "Installed N packages", "N packages installed", "Packages: +N").

const SIGNAL_GUARD = /\b(?:err(?:or)?|warn(?:ing)?|fail(?:ed)?|fatal)\b|ERR_PNPM_/i;
const PROGRESS_RESOLVED = /^\s*Progress:\s+resolved\s+\d+/;
const SPINNER_LINE = /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+/;
const ASCII_BAR = /^\s*\[[=>#\-.\s]{4,}\]\s*\d+\/\d+/;
const BLOCK_BAR = /^\s*[█▏▎▍▌▋▊▉▐░▒▓]{4,}/;
const PLUS_BAR = /^\s*\+{10,}\s*$/;
const RESOLVING_LINE = /^\s*Resolving dependencies\.{0,3}\s*$/;
const SAVED_LOCKFILE_LINE = /^\s*(?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+)?Saved lockfile\s*$/;

const PNPM_BUN_SIG = /(^|\n)(?:pnpm (?:install|i|add|update|up)\b|bun (?:install|i|add|update)\b|Progress:\s+resolved\s+\d+|Packages:\s+[+-]\d+|Done in \d+(?:\.\d+)?m?s\b|\s*\d+\s+packages?\s+installed\b|Installed\s+\d+\s+packages?\b|ERR_PNPM_)/;

export default {
  name: 'pnpm-bun',

  match(text) {
    if (typeof text !== 'string' || text.length === 0) return false;
    return PNPM_BUN_SIG.test(text);
  },

  rewrite(text) {
    if (!text) return text;

    // Normalize carriage-return overwritten progress frames into lines.
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const out = [];

    for (const line of lines) {
      if (!SIGNAL_GUARD.test(line)) {
        if (PROGRESS_RESOLVED.test(line)) continue;
        if (SPINNER_LINE.test(line)) continue;
        if (ASCII_BAR.test(line)) continue;
        if (BLOCK_BAR.test(line)) continue;
        if (PLUS_BAR.test(line)) continue;
        if (RESOLVING_LINE.test(line)) continue;
        if (SAVED_LOCKFILE_LINE.test(line)) continue;
      }
      out.push(line);
    }

    const collapsed = [];
    let blank = 0;
    for (const l of out) {
      if (l.trim() === '') {
        blank++;
        if (blank > 1) continue;
      } else {
        blank = 0;
      }
      collapsed.push(l);
    }
    return collapsed.join('\n');
  },
};
