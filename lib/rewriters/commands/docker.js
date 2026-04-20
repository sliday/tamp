// Targets:
//   docker build ...
//   docker buildx build ...
//
// Strips: BuildKit spinner lines ("#5 [2/7] RUN ... 0.3s"), transferred-bytes
// progress ("=> => transferring context: 123kB 0.1s"), cache-hit duplicates
// "=> CACHED [foo] ..." retained, but "=> => resolve sha256:..." noise stripped.
// Keeps: "Successfully built <id>", "Successfully tagged <name>", ERROR lines,
// final image sha, step headings.

const BUILDKIT_SUB = /^#\d+\s+=>\s+=>\s+/; // "#5 => => transferring ..." / "=> => resolve sha256:..."
const BUILDKIT_TRANSFER = /^=>\s+=>\s+(transferring|resolve|sha256|naming to|writing image|exporting)/;
const SPINNER_BRAILLE = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
const LEGACY_PROGRESS = /^\s*[0-9a-f]{12}: (Downloading|Extracting|Pulling fs layer|Waiting|Verifying Checksum|Download complete|Pull complete)\s/;
const DOCKER_SIG = /(^|\n)(Successfully built |Successfully tagged |Step \d+\/\d+\s*:|Sending build context|#\d+\s+\[|ERROR: |=>\s+\[)/;

export default {
  name: 'docker',

  match(text) {
    if (typeof text !== 'string' || text.length === 0) return false;
    return DOCKER_SIG.test(text);
  },

  rewrite(text) {
    if (!text) return text;
    const lines = text.split('\n');
    const out = [];

    for (const line of lines) {
      if (BUILDKIT_SUB.test(line)) continue;
      if (BUILDKIT_TRANSFER.test(line)) continue;
      if (SPINNER_BRAILLE.test(line)) continue;
      if (LEGACY_PROGRESS.test(line)) continue;
      // BuildKit "in-progress" duplicated step lines end with a fractional second
      // marker and are re-emitted as DONE later; strip the non-DONE variants.
      if (/^#\d+\s+\S.*\s\d+\.\d+s$/.test(line) && !/\sDONE\b/.test(line)) continue;
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
