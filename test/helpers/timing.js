import assert from 'node:assert/strict'

/**
 * Measure process CPU time (user + system) and wall-clock elapsed time for a
 * synchronous function. Process CPU time is immune to OS scheduling preemption
 * under parallel `node --test` contention, while wall-clock time serves as a
 * finite backstop against blocking syscalls or hangs.
 *
 * @template T
 * @param {() => T} fn
 * @returns {{ result: T, cpuMs: number, wallMs: number }}
 */
export function measureCpuMs(fn) {
  const startCpu = process.cpuUsage()
  const startWall = process.hrtime.bigint()
  const result = fn()
  const delta = process.cpuUsage(startCpu)
  const wallMs = Number(process.hrtime.bigint() - startWall) / 1e6
  const cpuMs = (delta.user + delta.system) / 1000
  return { result, cpuMs, wallMs }
}

/**
 * Measure process CPU time (user + system) and wall-clock elapsed time across
 * an awaited async function invocation.
 *
 * @template T
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<{ result: T, cpuMs: number, wallMs: number }>}
 */
export async function measureCpuMsAsync(fn) {
  const startCpu = process.cpuUsage()
  const startWall = process.hrtime.bigint()
  const result = await fn()
  const delta = process.cpuUsage(startCpu)
  const wallMs = Number(process.hrtime.bigint() - startWall) / 1e6
  const cpuMs = (delta.user + delta.system) / 1000
  return { result, cpuMs, wallMs }
}

function checkBudget(label, timing, maxCpuMs, opts = {}) {
  const { cpuMs, wallMs } = timing
  const maxWallMs = opts.maxWallMs ?? Math.max(maxCpuMs * 10, 2000)
  assert.ok(
    cpuMs < maxCpuMs,
    `${label} exceeded CPU budget: cpu=${cpuMs.toFixed(2)}ms (max ${maxCpuMs}ms), wall=${wallMs.toFixed(2)}ms (max ${maxWallMs}ms)`
  )
  assert.ok(
    wallMs < maxWallMs,
    `${label} exceeded wall-clock backstop: cpu=${cpuMs.toFixed(2)}ms (max ${maxCpuMs}ms), wall=${wallMs.toFixed(2)}ms (max ${maxWallMs}ms)`
  )
  return timing
}

/**
 * Execute `fn` synchronously and assert both a strict process CPU budget and a
 * generous wall-clock safety backstop.
 *
 * @template T
 * @param {string} label
 * @param {() => T} fn
 * @param {number} maxCpuMs
 * @param {{ maxWallMs?: number }} [opts]
 * @returns {{ result: T, cpuMs: number, wallMs: number }}
 */
export function assertCpuBudget(label, fn, maxCpuMs, opts = {}) {
  return checkBudget(label, measureCpuMs(fn), maxCpuMs, opts)
}

/**
 * Execute `fn` asynchronously and assert both a strict process CPU budget and a
 * generous wall-clock safety backstop.
 *
 * @template T
 * @param {string} label
 * @param {() => Promise<T> | T} fn
 * @param {number} maxCpuMs
 * @param {{ maxWallMs?: number }} [opts]
 * @returns {Promise<{ result: T, cpuMs: number, wallMs: number }>}
 */
export async function assertCpuBudgetAsync(label, fn, maxCpuMs, opts = {}) {
  return checkBudget(label, await measureCpuMsAsync(fn), maxCpuMs, opts)
}
