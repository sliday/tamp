// Targets:
//   npm install [pkg...]
//   npm i [pkg...]
//   npm ci
//   npm run <script>
//
// Strips: spinner frames, progress dots, "npm fund" / "npm audit" preamble
// lines when no vulnerabilities follow, repeated ".........." lines, leading
// "⠋ idealTree" style lines.
// Keeps: error/warn lines, final "added N packages in Ns", vulnerability
// counts, "up to date", package trees.

const SPINNER_CHARS = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
const PROGRESS_LINE = /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+/;
const DOTS_ONLY = /^\s*\.{3,}\s*$/;
const NPM_SIG = /(^|\n)(npm (install|i|ci|run)\b|added \d+ packages?|up to date|changed \d+ packages?|removed \d+ packages?)/;

export default {
  name: 'npm',

  match(text) {
    if (typeof text !== 'string' || text.length === 0) return false;
    if (!NPM_SIG.test(text)) return false;
    // Near-zero false positives: require either an npm invocation echo OR a
    // characteristic npm summary line.
    return (
      /(^|\n)npm (install|i|ci|run)\b/.test(text) ||
      /(^|\n)(added|removed|changed|up to date)/.test(text)
    );
  },

  rewrite(text) {
    if (!text) return text;
    const lines = text.split('\n');
    const out = [];
    let lastWasDots = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Drop spinner lines and sole-dot lines.
      if (PROGRESS_LINE.test(line) || SPINNER_CHARS.test(line)) continue;
      if (DOTS_ONLY.test(line)) {
        if (lastWasDots) continue;
        lastWasDots = true;
        continue; // drop dot-only lines entirely
      }
      lastWasDots = false;

      // Drop the "run `npm fund` for details" preamble when no funding count follows.
      if (/^\s*\d+ packages? are looking for funding\s*$/.test(line)) {
        // Peek ahead — if next non-empty line is "run `npm fund`", drop both.
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        if (j < lines.length && /run `npm fund`/.test(lines[j])) {
          i = j; // skip the "run `npm fund`" line too
          continue;
        }
      }
      if (/^\s*run `npm fund` for details\s*$/.test(line)) continue;

      // Drop "found 0 vulnerabilities" trailing audit preamble? Keep — it's signal.

      out.push(line);
    }

    // Collapse runs of blank lines to max 1.
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
