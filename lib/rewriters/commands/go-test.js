// Targets:
//   go test ./... / go test -v ./...
//
// Strips: "=== RUN ..." and "--- PASS: ..." lines ONLY when no "--- FAIL:" or
// "FAIL\t" appears. Keeps package "ok ..." summary lines and any failing test
// output verbatim.

const RUN_LINE = /^\s*=== (?:RUN|PAUSE|CONT)\s+/;
const PASS_LINE = /^\s*---\s+PASS:\s+/;
const FAIL_INDICATOR = /^\s*---\s+FAIL:|^FAIL\t|^FAIL\s*$/m;
const GO_TEST_SIG = /(^|\n)(?:=== (?:RUN|PAUSE|CONT)\s+\S+|\s*---\s+(?:PASS|FAIL|SKIP):\s+\S+|FAIL\t\S+|ok\s+\S+\t[\d.]+s)/;

export default {
  name: 'go-test',

  match(text) {
    if (typeof text !== 'string' || text.length === 0) return false;
    return GO_TEST_SIG.test(text);
  },

  rewrite(text) {
    if (!text) return text;

    if (FAIL_INDICATOR.test(text)) {
      // Safety net: do not touch failing runs.
      return text;
    }

    const lines = text.split('\n');
    const out = [];
    for (const line of lines) {
      if (RUN_LINE.test(line)) continue;
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
