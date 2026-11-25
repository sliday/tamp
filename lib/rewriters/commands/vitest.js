// Targets:
//   vitest / npx vitest run / pnpm test (vitest)
//
// Strips: passing "✓ path/to/test.ts (...)" lines ONLY when the run has zero
// failures (no FAIL lines / failed counts and "Test Files ... passed" present).
// Keeps: failures, stack traces, and the Test Files/Tests/Duration summary
// verbatim.

const PASS_LINE = /^\s*[✓✔]\s+\S+/;
const FAIL_LINE = /^\s*(?:FAIL\b|[×✕❯]\s)/m;
const FAILED_COUNT = /^\s*(?:Test Files|Tests)\s+[^\n]{0,120}\b[1-9]\d*\s+failed\b/m;
const ALL_FILES_PASSED = /^\s*Test Files\s+[^\n]{0,120}\b\d+\s+passed\b/m;
const VITEST_SIG = /(^|\n)\s*(?:Test Files\s+\d|RUN\s+v\d+\.\d+\.\d+)/;

export default {
  name: 'vitest',

  match(text) {
    if (typeof text !== 'string' || text.length === 0) return false;
    return VITEST_SIG.test(text);
  },

  rewrite(text) {
    if (!text) return text;

    const allPass = !FAIL_LINE.test(text) && !FAILED_COUNT.test(text) && ALL_FILES_PASSED.test(text);
    if (!allPass) {
      // Safety net: do not touch mixed or failing runs.
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
