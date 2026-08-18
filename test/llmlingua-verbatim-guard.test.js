import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compressText, hasVerbatimCriticalContent } from '../compress.js'

// LLMLingua-2 paraphrases. Measured against the live sidecar at the default
// rate of 0.7, ordinary command output came back mutilated:
//   /Users/stas/.config/tamp/tamp.err.log  ->  /Users/stas./tamp..
//   "version":"0.8.17"                     ->  "version""0.. 17"
//   launchctl bootout gui/501/dev.tamp.proxy -> ... gui/501/dev..
// An agent handed that cannot open the file or parse the JSON. The guard keeps
// such content away from the sidecar; prose still goes through.
describe('llmlingua verbatim guard', () => {
  const critical = {
    'unix path': 'Logs written to /Users/stas/.config/tamp/tamp.err.log for review',
    'relative path': 'see ./src/components/Button.tsx for the change',
    'parent path': 'moved to ../shared/utils/dates.js last week',
    'windows path': 'open C:\\Users\\stas\\project\\notes.txt now',
    url: 'docs live at https://tamp.dev/whitepaper-latest today',
    'json pair': 'response was {"status":"ok"} from the server',
    'hex id': 'commit 6a68830ff12ab34 landed on main yesterday',
    semver: 'upgrade tamp to v0.8.17 before running the suite',
  }

  for (const [name, text] of Object.entries(critical)) {
    it(`flags ${name}`, () => {
      assert.equal(hasVerbatimCriticalContent(text), true)
    })
  }

  const prose = {
    'plain sentence': 'The proxy sits between the agent and the upstream API and shrinks payloads.',
    'wrapped prose': 'Compression happens per block. Error results are skipped so failures stay readable for the model.',
  }

  for (const [name, text] of Object.entries(prose)) {
    it(`passes ${name} through`, () => {
      assert.equal(hasVerbatimCriticalContent(text), false)
    })
  }

  it('does not hand path-bearing command output to the sidecar', () => {
    const text = [
      'LaunchAgent installed: /Users/stas/Library/LaunchAgents/dev.tamp.proxy.plist',
      '  Status:  tamp status',
      '  Logs:    tail -f /Users/stas/.config/tamp/tamp.err.log',
      '  Stop:    launchctl bootout gui/501/dev.tamp.proxy',
    ].join('\n')
    const out = compressText(text, {
      minSize: 10,
      stages: ['whitespace', 'llmlingua'],
      llmLinguaUrl: 'http://localhost:8788',
      log: false,
    })
    assert.notEqual(out?.asyncMethod, 'llmlingua')
  })

  it('still routes prose to the sidecar', () => {
    const text = ('The proxy compresses each block before forwarding it upstream. '
      + 'Nothing about the agent changes and no code is rewritten. ').repeat(6)
    const out = compressText(text, {
      minSize: 10,
      stages: ['llmlingua'],
      llmLinguaUrl: 'http://localhost:8788',
      log: false,
    })
    assert.equal(out?.asyncMethod, 'llmlingua')
  })
})
