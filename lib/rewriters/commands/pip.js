// Targets:
//   pip install <pkg>
//   pip install -r requirements.txt
//
// Strips: wheel download percentage lines, repeated "Collecting X" entries
// when the same package appears twice, "Using cached" blocks, progress bar
// block art.
// Keeps: "Successfully installed" summary, ERROR/WARNING lines, version pins.

const PROGRESS_BAR = /[█▏▎▍▌▋▊▉▐░▒▓|]{4,}/;
const PERCENT_LINE = /^\s*\|.*\|\s*\d+(\.\d+)?\s*[kKmMgG]?B\s/;
const DOWNLOADING = /^\s*Downloading\s+.*\([\d.]+\s*[kKmMgG]?B\)\s*$/;
const PIP_SIG = /(^|\n)(Collecting |Requirement already satisfied|Successfully installed|Installing collected packages)/;

export default {
  name: 'pip',

  match(text) {
    if (typeof text !== 'string' || text.length === 0) return false;
    return PIP_SIG.test(text);
  },

  rewrite(text) {
    if (!text) return text;
    const lines = text.split('\n');
    const out = [];
    const seenCollecting = new Set();

    for (const line of lines) {
      if (PROGRESS_BAR.test(line)) continue;
      if (PERCENT_LINE.test(line)) continue;
      if (DOWNLOADING.test(line)) continue;
      if (/^\s*Using cached\s+\S+\.whl\s*\([^)]+\)\s*$/.test(line)) continue;

      const m = /^\s*Collecting\s+([A-Za-z0-9_.\-]+)/.exec(line);
      if (m) {
        const key = m[1].toLowerCase();
        if (seenCollecting.has(key)) continue;
        seenCollecting.add(key);
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
