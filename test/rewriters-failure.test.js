import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { rewriteCommandOutput, PRIORITY } from '../lib/rewriters/index.js'

// Guardrail: a command-output rewriter may strip progress/spinner/banner noise,
// but it must NEVER drop failure/error context. If a command FAILED, every
// diagnostic line the agent needs (error codes, failed assertions, non-zero
// exit summaries, HTTP errors, fatal:/ERROR: lines) must survive compression.
// This locks in tamp's core promise for the lossy cmd-strip stage. Existing
// fixtures cover only the success path; these cover the failure path.
//
// Each case: a realistic FAILED-command output that triggers the named
// rewriter, plus the failure-signal substrings that must remain intact.
const FAILURE_CASES = [
  {
    name: 'npm',
    lines: [
      'npm install leftpadx',
      'npm error code E404',
      'npm error 404 Not Found - GET https://registry.npmjs.org/leftpadx - Not found',
      "npm error 404  'leftpadx@*' is not in this registry.",
      'npm error A complete log of this run can be found in: /Users/x/.npm/_logs/2026.log',
    ],
    mustKeep: [
      'npm error code E404',
      'npm error 404 Not Found - GET https://registry.npmjs.org/leftpadx',
      'npm error A complete log of this run can be found in:',
    ],
  },
  {
    name: 'pip',
    lines: [
      'Collecting frobnicate',
      'ERROR: Could not find a version that satisfies the requirement frobnicate (from versions: none)',
      'ERROR: No matching distribution found for frobnicate',
    ],
    mustKeep: [
      'ERROR: Could not find a version that satisfies the requirement frobnicate',
      'ERROR: No matching distribution found for frobnicate',
    ],
  },
  {
    name: 'cargo',
    lines: [
      '   Compiling myapp v0.1.0 (/work/myapp)',
      'error[E0277]: the trait bound `String: Copy` is not satisfied',
      ' --> src/main.rs:4:20',
      'error: could not compile `myapp` (bin "myapp") due to 1 previous error',
    ],
    mustKeep: [
      'error[E0277]: the trait bound `String: Copy` is not satisfied',
      'error: could not compile `myapp` (bin "myapp") due to 1 previous error',
    ],
  },
  {
    name: 'docker',
    lines: [
      '#8 [builder 5/7] RUN npm ci',
      '#8 DONE 4.2s',
      '#9 [builder 6/7] RUN npm run build',
      '#9 12.34 npm ERR! Build failed',
      '#9 ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1',
      'ERROR: failed to solve: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1',
    ],
    mustKeep: [
      '#9 12.34 npm ERR! Build failed',
      'ERROR: failed to solve: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1',
    ],
  },
  {
    name: 'prisma',
    lines: [
      'Prisma schema loaded from prisma/schema.prisma',
      'Datasource "db": PostgreSQL database "app" at "localhost:5432"',
      "Error: P1001: Can't reach database server at `localhost:5432`",
      'Please make sure your database server is running at `localhost:5432`.',
    ],
    mustKeep: [
      "Error: P1001: Can't reach database server at `localhost:5432`",
      'Please make sure your database server is running',
    ],
  },
  {
    name: 'terraform',
    lines: [
      'aws_instance.web: Refreshing state... [id=i-0abc123]',
      'Terraform will perform the following actions',
      'Plan: 0 to add, 0 to change, 0 to destroy.',
      'Error: creating EC2 Instance: InvalidAMIID.NotFound: The image id does not exist',
      '  status code: 400, request id: abcd-1234',
    ],
    mustKeep: [
      'Plan: 0 to add, 0 to change, 0 to destroy.',
      'Error: creating EC2 Instance: InvalidAMIID.NotFound',
      'status code: 400',
    ],
  },
  {
    name: 'git',
    lines: [
      "Cloning into 'missing'...",
      'remote: Counting objects: 100% (5/5), done.',
      'remote: Repository not found.',
      "fatal: repository 'https://github.com/x/missing.git/' not found",
    ],
    mustKeep: [
      'remote: Repository not found.',
      "fatal: repository 'https://github.com/x/missing.git/' not found",
    ],
  },
  {
    name: 'pytest',
    lines: [
      '=================== test session starts ===================',
      'collected 1 item',
      'tests/test_math.py F                                [100%]',
      '    def test_add():',
      '>       assert add(1, 2) == 4',
      'E       assert 3 == 4',
      'FAILED tests/test_math.py::test_add - assert 3 == 4',
      '=== 1 failed in 0.12s ===',
    ],
    mustKeep: [
      'FAILED tests/test_math.py::test_add - assert 3 == 4',
      'E       assert 3 == 4',
      '=== 1 failed in 0.12s ===',
    ],
  },
  {
    name: 'jest',
    lines: [
      'FAIL src/sum.test.js',
      '  ✕ adds 1 + 2 (3 ms)',
      '    expect(received).toBe(expected)',
      '    Expected: 4',
      '    Received: 3',
      'Tests:       1 failed, 1 total',
    ],
    mustKeep: [
      'FAIL src/sum.test.js',
      'Expected: 4',
      'Received: 3',
      'Tests:       1 failed, 1 total',
    ],
  },
  {
    name: 'wget-curl',
    lines: [
      '  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current',
      '                                 Dload  Upload   Total   Spent    Left  Speed',
      '  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0',
      'HTTP request sent, awaiting response... 404 Not Found',
      'curl: (22) The requested URL returned error: 404',
    ],
    mustKeep: [
      'curl: (22) The requested URL returned error: 404',
      'HTTP request sent, awaiting response... 404 Not Found',
    ],
  },
]

describe('rewriters — failure context is never stripped', () => {
  // Sanity: a case for every registered rewriter.
  it('covers every rewriter in PRIORITY', () => {
    assert.deepEqual(
      [...PRIORITY].sort(),
      FAILURE_CASES.map((c) => c.name).sort()
    )
  })

  for (const { name, lines, mustKeep } of FAILURE_CASES) {
    it(`${name}: preserves failure-signal lines`, () => {
      const input = lines.join('\n')
      const { text, rewriter } = rewriteCommandOutput(input)
      assert.equal(rewriter, name, `failure output should route to the ${name} rewriter`)
      for (const signal of mustKeep) {
        assert.ok(
          text.includes(signal),
          `${name} rewriter dropped failure context: ${JSON.stringify(signal)}`
        )
      }
    })
  }
})
