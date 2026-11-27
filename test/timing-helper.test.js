import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  measureCpuMs,
  measureCpuMsAsync,
  assertCpuBudget,
  assertCpuBudgetAsync,
} from './helpers/timing.js'

function burnCpuMs(targetMs) {
  const start = process.cpuUsage()
  let acc = 0
  while (true) {
    for (let i = 0; i < 50_000; i++) acc = (acc + i) | 0
    const delta = process.cpuUsage(start)
    if ((delta.user + delta.system) / 1000 >= targetMs) return acc
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('test/helpers/timing.js', () => {
  it('measureCpuMs returns result and measurable non-negative cpuMs/wallMs for sync CPU work', () => {
    const measured = measureCpuMs(() => {
      burnCpuMs(10)
      return 'done'
    })
    assert.equal(measured.result, 'done')
    assert.equal(typeof measured.cpuMs, 'number')
    assert.equal(typeof measured.wallMs, 'number')
    assert.ok(measured.cpuMs >= 5, `expected measurable cpuMs >= 5, got ${measured.cpuMs}`)
    assert.ok(measured.wallMs >= 0, `expected non-negative wallMs, got ${measured.wallMs}`)
  })

  it('measureCpuMsAsync tracks wallMs across async idle delay while cpuMs stays small', async () => {
    const measured = await measureCpuMsAsync(async () => {
      await sleep(80)
      return 'slept'
    })
    assert.equal(measured.result, 'slept')
    assert.equal(typeof measured.cpuMs, 'number')
    assert.equal(typeof measured.wallMs, 'number')
    assert.ok(measured.cpuMs >= 0)
    assert.ok(measured.wallMs >= 60, `expected wallMs >= 60, got ${measured.wallMs}`)
    assert.ok(measured.cpuMs < 50, `expected small cpuMs during idle sleep, got ${measured.cpuMs}`)
  })

  it('assertCpuBudget returns { result, cpuMs, wallMs } on pass', () => {
    const out = assertCpuBudget('sync-pass', () => 42, 500)
    assert.equal(out.result, 42)
    assert.ok(out.cpuMs >= 0 && out.cpuMs < 500)
    assert.ok(out.wallMs >= 0 && out.wallMs < 5000)
  })

  it('assertCpuBudget throws AssertionError with label, cpuMs, and wallMs on CPU breach', () => {
    assert.throws(
      () => assertCpuBudget('sync-cpu-breach', () => burnCpuMs(15), 5, { maxWallMs: 5000 }),
      (err) => {
        assert.ok(err instanceof assert.AssertionError)
        assert.match(err.message, /sync-cpu-breach/)
        assert.match(err.message, /cpu=\d+\.\d+ms \(max 5ms\)/)
        assert.match(err.message, /wall=\d+\.\d+ms \(max 5000ms\)/)
        return true
      }
    )
  })

  it('assertCpuBudget throws AssertionError with label, cpuMs, and wallMs on wall-clock backstop breach', () => {
    const sab = new Int32Array(new SharedArrayBuffer(4))
    assert.throws(
      () => assertCpuBudget('sync-wall-breach', () => { Atomics.wait(sab, 0, 0, 30) }, 500, { maxWallMs: 10 }),
      (err) => {
        assert.ok(err instanceof assert.AssertionError)
        assert.match(err.message, /sync-wall-breach/)
        assert.match(err.message, /wall-clock backstop/)
        assert.match(err.message, /cpu=\d+\.\d+ms \(max 500ms\)/)
        assert.match(err.message, /wall=\d+\.\d+ms \(max 10ms\)/)
        return true
      }
    )
  })

  it('assertCpuBudgetAsync passes when async sleep exceeds maxCpuMs but stays under CPU and wall budgets', async () => {
    const out = await assertCpuBudgetAsync('async-idle-pass', async () => {
      await sleep(80)
      return 'ok'
    }, 50)
    assert.equal(out.result, 'ok')
    assert.ok(out.wallMs > 50, `expected wallMs > maxCpuMs (50), got ${out.wallMs}`)
    assert.ok(out.cpuMs < 50, `expected cpuMs < 50, got ${out.cpuMs}`)
    assert.ok(out.wallMs < 2000, `expected wallMs < default maxWallMs (2000), got ${out.wallMs}`)
  })

  it('assertCpuBudgetAsync applies default maxWallMs formula and reports diagnostics on CPU breach', async () => {
    await assert.rejects(
      () => assertCpuBudgetAsync('async-cpu-breach', async () => {
        burnCpuMs(15)
      }, 5),
      (err) => {
        assert.ok(err instanceof assert.AssertionError)
        assert.match(err.message, /async-cpu-breach/)
        assert.match(err.message, /cpu=\d+\.\d+ms \(max 5ms\)/)
        assert.match(err.message, /wall=\d+\.\d+ms \(max 2000ms\)/)
        return true
      }
    )
  })

  it('assertCpuBudgetAsync throws AssertionError with label, cpuMs, and wallMs on wall-clock backstop breach', async () => {
    await assert.rejects(
      () => assertCpuBudgetAsync('async-wall-breach', async () => {
        await sleep(40)
      }, 500, { maxWallMs: 15 }),
      (err) => {
        assert.ok(err instanceof assert.AssertionError)
        assert.match(err.message, /async-wall-breach/)
        assert.match(err.message, /wall-clock backstop/)
        assert.match(err.message, /cpu=\d+\.\d+ms \(max 500ms\)/)
        assert.match(err.message, /wall=\d+\.\d+ms \(max 15ms\)/)
        return true
      }
    )
  })
})
