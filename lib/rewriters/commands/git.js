// Targets:
//   git clone <url>
//   git fetch / git pull
//   git push
//
// Strips: "remote: Counting objects: 42% (3/7)" repeated percentage lines,
// "remote: Compressing objects: 50% (1/2)", "Receiving objects: 42% (3/7)",
// "Resolving deltas: 50% (5/10)" — keeps only the final 100% line of each
// phase so the ratios/totals are preserved. Also strips carriage-return
// overwrite artifacts.
// Keeps: "Cloning into ...", remote: lines that are messages (not progress),
// "done.", final delta summary, error lines, "Unpacking objects" final 100%.

const PHASES = [
  /^(remote:\s+)?Counting objects:\s+/,
  /^(remote:\s+)?Compressing objects:\s+/,
  /^(remote:\s+)?Enumerating objects:\s+/,
  /^Receiving objects:\s+/,
  /^Resolving deltas:\s+/,
  /^Unpacking objects:\s+/,
  /^Writing objects:\s+/,
  /^remote:\s+Total\s+\d+/,
];
const GIT_SIG = /(^|\n)(Cloning into |remote: (Counting|Compressing|Enumerating) objects|Receiving objects:|Resolving deltas:|Unpacking objects:|Writing objects:|Fetching origin|To github\.com|Already up to date)/;

function phaseIndex(line) {
  for (let i = 0; i < PHASES.length; i++) {
    if (PHASES[i].test(line)) return i;
  }
  return -1;
}

export default {
  name: 'git',

  match(text) {
    if (typeof text !== 'string' || text.length === 0) return false;
    return GIT_SIG.test(text);
  },

  rewrite(text) {
    if (!text) return text;

    // Split on both \n and \r so carriage-return overwritten progress frames
    // become distinct lines we can filter. Normalize back to \n.
    const lines = text.replace(/\r/g, '\n').split('\n');
    const out = [];
    const phaseBuffer = new Map(); // phaseIdx -> last line seen

    const flush = () => {
      if (phaseBuffer.size === 0) return;
      // Emit in insertion order.
      for (const line of phaseBuffer.values()) out.push(line);
      phaseBuffer.clear();
    };

    for (const line of lines) {
      const idx = phaseIndex(line);
      if (idx >= 0) {
        phaseBuffer.set(idx, line); // overwrite — keep the latest frame per phase
        continue;
      }
      flush();
      out.push(line);
    }
    flush();

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
