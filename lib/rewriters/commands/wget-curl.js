// Targets:
//   curl -O/-o <url>, curl <url>
//   wget <url>
//
// Strips: the "% Total ... Time ... Current" header block and all mid-download
// percentage rows from curl; the tick-mark ASCII bar + per-line percentage
// rows from wget; leaves the final summary row / "100%" tail line intact.
// Keeps: final size/time summary, error lines, HTTP response headers if
// requested (-v / --verbose are untouched — we only match the download grid).

const CURL_HEADER = /^\s*%\s+Total\s+%\s+Received/;
const CURL_SECOND_HEADER = /^\s+Dload\s+Upload/;
const CURL_ROW = /^\s*\d{1,3}\s+\d[\d.kKMmGgTt]*\s+\d{1,3}\s+\d[\d.kKMmGgTt]*\s+\d+\s+\d+\s+\d[\d.kKMmGgTt]*\s+\d+\s+/;
const WGET_PROGRESS = /^\s*\d{1,3}%\s*\[[=> .]+\]/;
const WGET_TICKS = /^\s*[\d,]+[KMG]?\s+[.=]+\s+\d+%/;
const WGET_SIG = /(^|\n)(--\d{4}-\d{2}-\d{2}|Resolving |Connecting to |HTTP request sent|Length: |Saving to: )/;
const CURL_SIG = /(^|\n)\s*%\s+Total\s+%\s+Received/;

export default {
  name: 'wget-curl',

  match(text) {
    if (typeof text !== 'string' || text.length === 0) return false;
    return CURL_SIG.test(text) || WGET_SIG.test(text);
  },

  rewrite(text) {
    if (!text) return text;
    const lines = text.split('\n');
    const out = [];
    let lastCurlRow = null;

    for (const line of lines) {
      if (CURL_HEADER.test(line)) continue;
      if (CURL_SECOND_HEADER.test(line)) continue;
      if (WGET_PROGRESS.test(line)) continue;
      if (WGET_TICKS.test(line)) continue;

      if (CURL_ROW.test(line)) {
        // Keep only the final row (last one seen) — buffer it.
        lastCurlRow = line;
        continue;
      }

      if (lastCurlRow !== null) {
        // Flush the last curl row right before the next non-row line.
        out.push(lastCurlRow);
        lastCurlRow = null;
      }
      out.push(line);
    }
    if (lastCurlRow !== null) out.push(lastCurlRow);

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
