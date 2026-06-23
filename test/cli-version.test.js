import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { VERSION } from '../metadata.js'

const BIN = fileURLToPath(new URL('../bin/tamp.js', import.meta.url))

// Run `tamp <arg>` and resolve with { code, stdout, timedOut }. A version flag
// must print and exit quickly; if it instead starts the proxy it will time out.
function runCli(arg) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, arg],
      // Unlikely port so a regression that starts the proxy still won't collide.
      { timeout: 6000, env: { ...process.env, TAMP_PORT: '17991' } },
      (err, stdout) => {
        resolve({
          code: err?.code,
          timedOut: !!(err && err.killed),
          stdout: stdout || '',
        })
      },
    )
  })
}

describe('tamp version flag', () => {
  for (const arg of ['--version', '-v', 'version']) {
    it(`\`tamp ${arg}\` prints the version and exits without starting the proxy`, async () => {
      const r = await runCli(arg)
      assert.equal(r.timedOut, false, `\`tamp ${arg}\` did not exit (started the proxy?)`)
      assert.ok(r.stdout.includes(VERSION), `expected version ${VERSION} in output, got: ${r.stdout.slice(0, 120)}`)
      assert.ok(!/READY|listening/i.test(r.stdout), 'must not start the proxy')
    })
  }
})
