// --- Secret redaction (security, not compression) ---
//
// Masks or removes high-confidence secrets in outbound tool_result bodies
// before anything leaves the machine — and before any stage that ships text
// to a third party (llmlingua sidecar, textpress/OpenRouter) ever sees it.
//
// Design bias: precision over recall. A false positive corrupts legitimate
// content the model needs; a false negative leaks a secret. We only match
// patterns with a recognizable shape (provider-prefixed keys, PEM blocks,
// JWTs) plus assignment lines whose KEY name is unambiguously a secret. We do
// NOT do entropy guessing — too noisy for code/log payloads.
//
// Why: https://github.com/sliday/tamp/issues/6

// Each rule: a global regex and a short label used in the mask marker. Where a
// rule needs to keep surrounding structure (assignments), it captures the
// secret in group 1 and rebuilds the line via `replace`.
const TOKEN_RULES = [
  { label: 'aws-access-key', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b/g },
  { label: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { label: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { label: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { label: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { label: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: 'stripe-key', re: /\b[rs]k_live_[A-Za-z0-9]{20,}\b/g },
  { label: 'google-oauth', re: /\bya29\.[A-Za-z0-9_-]{20,}\b/g },
  { label: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { label: 'private-key', re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g },
]

// Assignment lines from .env / shell / config where the KEY name names a
// secret. We mask only the VALUE, keeping the key so the model still sees the
// variable exists.
//
// Precision rules learned the hard way:
//   - Case-SENSITIVE uppercase keys only. Real secret env vars are UPPER_SNAKE
//     (`API_KEY`, `AUTH_TOKEN`); camelCase like `apiKey = getKey()` is code,
//     not a secret, and must not match.
//   - The secret word is anchored to the END of the key (immediately before
//     the `=`/`:`), so `AUTHOR=`, `COMPASS=`, `PASSWORD_HINT=` don't trip it.
//   - Value must be 6+ non-space chars to skip empty/placeholder assignments.
const SECRET_KEY = '[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|CREDENTIALS?|AUTH|PASSPHRASE|SESSION[_-]?KEY)'
const ASSIGN_RE = new RegExp(
  `((?:export\\s+)?${SECRET_KEY})(\\s*[:=]\\s*)(["']?)([^\\s"']{6,})(["']?)`,
  'g'
)

function marker(label, mode) {
  return mode === 'remove' ? '' : `‹redacted:${label}›`
}

// Returns { text, count }. `count` is the number of secrets masked/removed.
// When count is 0 the returned text is referentially the input (no allocation
// churn for the common no-secret case).
export function redactText(text, mode = 'mask') {
  if (typeof text !== 'string' || text.length === 0) return { text, count: 0 }

  let count = 0
  let out = text

  for (const { label, re } of TOKEN_RULES) {
    out = out.replace(re, () => { count++; return marker(label, mode) })
  }

  out = out.replace(ASSIGN_RE, (m, key, sep, q1, _val, q2) => {
    count++
    if (mode === 'remove') return `${key}${sep}`
    return `${key}${sep}${q1}${marker('secret', mode)}${q2}`
  })

  return count > 0 ? { text: out, count } : { text, count: 0 }
}
