// Pure JS text metrics for evaluating LLMLingua-2 compression quality

export function tokenize(text) {
  return text.toLowerCase().split(/\s+/).filter(Boolean)
}

function ngrams(tokens, n) {
  const result = []
  for (let i = 0; i <= tokens.length - n; i++) {
    result.push(tokens.slice(i, i + n).join(' '))
  }
  return result
}

export function ngramOverlap(original, compressed, n = 1) {
  const origTokens = tokenize(original)
  const compTokens = tokenize(compressed)
  const origNgrams = ngrams(origTokens, n)
  const compNgrams = ngrams(compTokens, n)
  if (!origNgrams.length) return { precision: 0, recall: 0, f1: 0 }

  const origSet = new Set(origNgrams)
  const compSet = new Set(compNgrams)
  const intersection = [...compSet].filter(g => origSet.has(g)).length

  const precision = compSet.size > 0 ? intersection / compSet.size : 0
  const recall = origSet.size > 0 ? intersection / origSet.size : 0
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0
  return { precision, recall, f1 }
}

export function lcsRatio(original, compressed) {
  const a = tokenize(original)
  const b = tokenize(compressed)
  if (!a.length) return 0

  // Hunt-Szymanski LCS for token sequences
  const m = a.length
  const n = b.length
  const dp = new Array(n + 1).fill(0)
  for (let i = 0; i < m; i++) {
    let prev = 0
    for (let j = 0; j < n; j++) {
      const temp = dp[j + 1]
      if (a[i] === b[j]) {
        dp[j + 1] = prev + 1
      } else {
        dp[j + 1] = Math.max(dp[j + 1], dp[j])
      }
      prev = temp
    }
  }
  return dp[n] / m
}

export function extractEntities(text) {
  const names = [...new Set((text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || []))]
  const numbers = [...new Set((text.match(/\b\d+(?:\.\d+)?\b/g) || []))]
  const paths = [...new Set((text.match(/(?:\/[\w.-]+){2,}/g) || []))]
  const urls = [...new Set((text.match(/https?:\/\/[^\s)]+/g) || []))]
  const codeRefs = [...new Set((text.match(/\b[a-z]\w*(?:\.\w+)+\b/g) || []))]
  return { names, numbers, paths, urls, codeRefs }
}

export function entityRecall(origEntities, compEntities) {
  const allOrig = [
    ...origEntities.names, ...origEntities.numbers,
    ...origEntities.paths, ...origEntities.urls, ...origEntities.codeRefs,
  ]
  if (!allOrig.length) return 1

  const allComp = new Set([
    ...compEntities.names, ...compEntities.numbers,
    ...compEntities.paths, ...compEntities.urls, ...compEntities.codeRefs,
  ])

  let found = 0
  for (const e of allOrig) {
    if (allComp.has(e)) found++
  }
  return found / allOrig.length
}

export function charTrigramJaccard(a, b) {
  function charTrigrams(s) {
    const set = new Set()
    for (let i = 0; i <= s.length - 3; i++) set.add(s.slice(i, i + 3))
    return set
  }
  const setA = charTrigrams(a)
  const setB = charTrigrams(b)
  if (!setA.size && !setB.size) return 1
  let intersection = 0
  for (const t of setA) { if (setB.has(t)) intersection++ }
  const union = setA.size + setB.size - intersection
  return union > 0 ? intersection / union : 0
}

export function sentenceCount(text) {
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0)
  return sentences.length
}

export function extractActionPhrases(text) {
  const verbs = 'install|run|create|build|add|remove|delete|update|configure|set|use|import|export|call|return|check|verify|test|deploy|start|stop'
  const re = new RegExp(`\\b(${verbs})\\s+\\w[\\w\\s]{0,30}?(?=[.,;!?\\n]|$)`, 'gi')
  return (text.match(re) || []).map(s => s.trim().toLowerCase())
}

export function charEntropy(text) {
  if (!text.length) return 0
  const freq = {}
  for (const c of text) freq[c] = (freq[c] || 0) + 1
  let entropy = 0
  const len = text.length
  for (const count of Object.values(freq)) {
    const p = count / len
    entropy -= p * Math.log2(p)
  }
  return entropy
}
