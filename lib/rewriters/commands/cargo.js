// Targets:
//   cargo build / cargo check / cargo run / cargo test
//
// Strips: "   Compiling foo v1.0.0 (path)" intermediate lines when followed by
// a "Finished" line; progress bar spinner lines like "   Building [===>  ]".
// Keeps: "Finished" line, warnings, errors, test results, panic traces.

const COMPILING_LINE = /^\s{2,}Compiling\s+[A-Za-z0-9_.\-]+\s+v[\d.]+/;
const PROGRESS_LINE = /^\s*Building\s+\[[=> ]+\]/;
const DOWNLOADING = /^\s{2,}(Downloading|Downloaded)\s+[A-Za-z0-9_.\-]+\s+v[\d.]+/;
const CARGO_SIG = /(^|\n)(\s{2,}(Compiling|Finished|Building|Downloading|Downloaded|Running|Fresh)\s|error\[E\d+\]|warning:\s)/;

export default {
  name: 'cargo',

  match(text) {
    if (typeof text !== 'string' || text.length === 0) return false;
    return CARGO_SIG.test(text);
  },

  rewrite(text) {
    if (!text) return text;

    // Only strip Compiling lines when a Finished line is present (build succeeded).
    const hasFinished = /^\s{2,}Finished\s+/m.test(text);

    const lines = text.split('\n');
    const out = [];

    for (const line of lines) {
      if (PROGRESS_LINE.test(line)) continue;
      if (DOWNLOADING.test(line)) continue;
      if (hasFinished && COMPILING_LINE.test(line)) continue;
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
