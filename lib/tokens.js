// Safe token counting (C5).
//
// `@anthropic-ai/tokenizer`'s `countTokens` is NOT fixed-cost: it has a ~22ms
// floor on small inputs, goes superlinear on large low-entropy payloads, and
// HARD CRASHES (tiktoken WASM trap) on megabyte-scale whitespace runs:
//
//   80KB  ->  8.7s      200KB ->  22.4s      400KB -> 88.9s
//   1MB   ->  RuntimeError: unreachable   (tiktoken WASM trap)
//
// A WASM trap is not catchable as a normal error in every runtime, so the
// primary defence is the 4KB cap; the try/catch is only the backstop.
//
//   spaces:  1KB 22ms   4KB 31ms   8KB 58ms   16KB 167ms   32KB 609ms
//   prose:   8KB 22ms  32KB 24ms  64KB 27ms
//
// 4KB bounds the worst case to ~31ms. Three windows spread across the body
// give representative density on logs/files whose head differs from their tail.

import { countTokens as rawCountTokens } from '@anthropic-ai/tokenizer'

const COUNT_CAP = 4 * 1024
const SAMPLES = 3

export function safeCountTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  try {
    if (text.length <= COUNT_CAP) return rawCountTokens(text)
    const each = Math.floor(COUNT_CAP / SAMPLES)
    const stride = Math.floor((text.length - each) / (SAMPLES - 1))
    let sampled = 0
    let counted = 0
    for (let s = 0; s < SAMPLES; s++) {
      const start = Math.min(s * stride, text.length - each)
      const window = text.slice(start, start + each)
      counted += rawCountTokens(window)
      sampled += window.length
    }
    if (sampled === 0) return Math.max(1, Math.ceil(text.length / 4))
    return Math.max(1, Math.round(counted * (text.length / sampled)))
  } catch {
    // Tokenizer refused this input. Fall back to a coarse estimate rather than
    // aborting compression for the whole request.
    return Math.max(1, Math.ceil(text.length / 4))
  }
}

export const countTokens = safeCountTokens
