// Targets:
//   node --test (TAP and spec reporters)
//
// Strips: passing "✔ ..." and "ok N - ..." lines ONLY when "# fail 0" (or
// "ℹ fail 0") is present and no "✖" or "not ok" failure lines appear.
// Keeps: summary lines ("# tests", "# pass", "# fail", "# duration_ms", etc.)
// and any failure diagnostics verbatim.

const PASS_SPEC_LINE = /^\s*✔\s/;
const PASS_TAP_LINE = /^\s*ok\s+\d+\s+-/;
const FAIL_LINE = /^\s*(?:✖\s|not ok\s+\d+)/m;
const ZERO_FAIL = /(^|\n)(?:#|ℹ)\s*fail\s+0\b/;
const TESTS_SUMMARY = /(^|\n)(?:#|ℹ)\s*tests\s+\d+\b/;
const DETAIL_SUMMARY = /(^|\n)(?:#|ℹ)\s*(?:pass|fail|duration_ms)\s+\d/;

export default {
  name: 'node-test',

  match(text) {
    if (typeof text !== 'string' || text.length === 0) return false;
    return TESTS_SUMMARY.test(text) && DETAIL_SUMMARY.test(text);
  },

  rewrite(text) {
    if (!text) return text;

    const allPass = ZERO_FAIL.test(text) && !FAIL_LINE.test(text);
    if (!allPass) {
      // Safety net: do not touch failing or incomplete runs.
      return text;
    }

    const lines = text.split('\n');
    const out = [];
    for (const line of lines) {
      if (PASS_SPEC_LINE.test(line)) continue;
      if (PASS_TAP_LINE.test(line)) continue;
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
