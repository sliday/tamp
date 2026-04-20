// Targets:
//   jest / npx jest / yarn test (jest)
//
// Strips: "PASS path/to/file.test.ts (12 ms)" lines ONLY when the final Tests
// summary reports zero failures. Preserves every FAIL line verbatim, plus
// the Tests/Suites/Time/Snapshots summary and any stack traces.

const PASS_LINE = /^\s*PASS\s+\S+/;
const FAIL_LINE = /^\s*FAIL\s+\S+/;
const JEST_SIG = /(^|\n)(PASS\s+\S+|FAIL\s+\S+|Tests:\s+.*\d+\s+(passed|failed|total)|Test Suites:\s+\d)/;

export default {
  name: 'jest',

  match(text) {
    if (typeof text !== 'string' || text.length === 0) return false;
    return JEST_SIG.test(text);
  },

  rewrite(text) {
    if (!text) return text;

    const allPass = !FAIL_LINE.test(text) && /Tests:\s+[^,\n]*\d+\s+passed/.test(text);
    if (!allPass) {
      // Safety net: do not touch mixed / failing runs.
      return text;
    }

    const lines = text.split('\n');
    const out = [];
    for (const line of lines) {
      if (PASS_LINE.test(line)) continue;
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
