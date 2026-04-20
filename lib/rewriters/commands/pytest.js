// Targets:
//   pytest / python -m pytest
//
// Strips: the "collected N items" banner line, the per-test dot-progress line
// ("tests/foo_test.py ........                    [ 50%]"), and the session
// start banner "platform darwin -- Python 3.11.4 ...". Keeps: FAIL summaries,
// the short test summary info block, and the final "=== N passed in Xs ===".

const COLLECTED = /^collected\s+\d+\s+items?\b/;
const DOT_PROGRESS = /^\S.*\s+[.FsxE]{2,}\s*(\[\s*\d+%\s*\])?\s*$/;
const SESSION_START = /^platform\s+\S+\s+--\s+Python\s+\d/;
const ROOTDIR = /^rootdir:\s+/;
const PLUGINS = /^plugins:\s+/;
const CACHEDIR = /^cachedir:\s+/;
const PYTEST_SIG = /(^|\n)(={3,}\s+test session starts\s+={3,}|collected\s+\d+\s+items?|={3,}\s+\d+\s+(passed|failed|error)s?\b)/;

export default {
  name: 'pytest',

  match(text) {
    if (typeof text !== 'string' || text.length === 0) return false;
    return PYTEST_SIG.test(text);
  },

  rewrite(text) {
    if (!text) return text;
    const lines = text.split('\n');
    const out = [];

    for (const line of lines) {
      if (COLLECTED.test(line)) continue;
      if (SESSION_START.test(line)) continue;
      if (ROOTDIR.test(line)) continue;
      if (PLUGINS.test(line)) continue;
      if (CACHEDIR.test(line)) continue;
      // Drop dot-progress only if the line contains ONLY test status chars
      // (not a traceback line that happens to end with dots).
      if (DOT_PROGRESS.test(line) && !/error|FAILED|PASSED/.test(line)) continue;
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
