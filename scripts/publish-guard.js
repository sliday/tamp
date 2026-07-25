#!/usr/bin/env node
// Blocks `npm publish` while known-critical defects sit unfixed on main.
//
// Context: PR #26 (6d5572e) landed the bm25 retrieval work with 11 critical
// defects open, three of them denial-of-service vectors reachable from
// untrusted tool_result content. Nothing shipped — no version bump, no CI —
// but a routine bump-and-publish from main would carry all of them.
//
// This guard exists so that publish is a deliberate act, not an accident.
//
// To publish anyway (you have read the list and accept it):
//   TAMP_ALLOW_PUBLISH=1 npm publish
//
// To remove this guard permanently: delete the `prepublishOnly` script from
// package.json and delete this file. Do that once the list below is empty.

const OPEN_CRITICALS = [
  ['C3', 'lib/code-chunks.js', 'detectIndentBlocks rescans blanks per header; 2.2MB -> 10.8s (DoS)'],
  ['F2', 'lib/code-chunks.js', '/* scanned before strings are stripped; any /* substring swallows the rest of the body'],
  ['C4', 'lib/bm25.js', 'chars-per-token estimate gameable; measured 7.8x over the stated token budget'],
  ['C5', 'lib/bm25.js', 'countTokens superlinear on low-entropy input; 400KB whitespace -> 88.9s, 1MB -> WASM trap (DoS)'],
  ['C6', 'lib/bm25.js', 'closureFor O(candidates x depth^2)'],
  ['C7', 'lib/bm25.js', 'docTokens retains ~10x body size; OOM path'],
  ['C8', 'lib/bm25.js', 'df loop O(uniqQ x N x tokens/line)'],
  ['C9', 'bench/retrieval-eval.js', 'recall scored against untrimmed text when no trim occurs; the gate cannot fail'],
  ['C10', 'package.json', 'that gate never runs: not in npm test, no CI'],
]

if (process.env.TAMP_ALLOW_PUBLISH === '1') {
  console.warn(`\n[publish-guard] OVERRIDDEN — publishing with ${OPEN_CRITICALS.length} known criticals open.\n`)
  process.exit(0)
}

console.error('\n  npm publish BLOCKED by scripts/publish-guard.js\n')
console.error(`  ${OPEN_CRITICALS.length} critical defects are open on this tree:\n`)
for (const [id, file, desc] of OPEN_CRITICALS) {
  console.error(`    ${id.padEnd(4)} ${file.padEnd(24)} ${desc}`)
}
console.error('\n  All of them sit behind the `bm25-trim` stage, which is L8 while')
console.error('  DEFAULT_LEVEL = 5 — a user must opt in before any can execute.')
console.error('  Full record: docs/designs/bm25-hotpath-hardening.md\n')
console.error('  Publish anyway:  TAMP_ALLOW_PUBLISH=1 npm publish')
console.error('  Remove guard:    delete prepublishOnly from package.json + this file\n')
process.exit(1)
