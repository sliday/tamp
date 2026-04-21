#!/usr/bin/env node
// Harness driver: spawns probe, resets log, prints runbook step, captures verdict.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const agent = getArg('--agent');
const mode = getArg('--mode', 'byok');
const auto = args.includes('--auto');
const port = Number(process.env.PROBE_PORT || 7877);

if (!agent) { console.error('usage: run.mjs --agent <name> --mode <byok|sub> [--auto]'); process.exit(2); }

const RESULTS = path.join(__dirname, 'results');
fs.mkdirSync(RESULTS, { recursive: true });

const probe = spawn(process.execPath, [path.join(__dirname, 'probe-proxy.js')], {
  env: { ...process.env, PROBE_PORT: String(port) }, stdio: ['ignore', 'inherit', 'inherit'],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fetchJSON = async (u, o) => (await fetch(u, o)).json();

const waitKey = () => new Promise((resolve) => {
  process.stdin.setRawMode?.(true); process.stdin.resume();
  process.stdin.once('data', () => { process.stdin.setRawMode?.(false); process.stdin.pause(); resolve(); });
});

(async () => {
  try {
    await sleep(300);
    await fetch(`http://127.0.0.1:${port}/_probe/reset`, { method: 'POST' });

    console.log(`\n=== ${agent} / ${mode} ===`);
    console.log(`Probe: http://127.0.0.1:${port}`);
    console.log(`See runbook: test/compat/runbook.md (section: ${agent} / ${mode})\n`);

    if (!auto) {
      console.log('Run the agent in another terminal per runbook, then press any key here...');
      await waitKey();
    } else {
      console.log('--auto: assuming the agent has already been triggered. Giving 2s grace...');
      await sleep(2000);
    }

    const entries = await fetchJSON(`http://127.0.0.1:${port}/_probe/log`);
    const intercepted = entries.length > 0;
    const verdict = intercepted ? 'intercepted' : 'bypassed';
    const result = {
      agent, mode,
      intercepted,
      entryCount: entries.length,
      firstEntry: entries[0] || null,
      verdict,
      notes: intercepted ? `Probe saw ${entries.length} request(s).` : 'Probe log empty — agent bypassed explicit config.',
      ts: new Date().toISOString(),
    };
    const out = path.join(RESULTS, `${agent}-${mode}.json`);
    fs.writeFileSync(out, JSON.stringify(result, null, 2));
    console.log(`\nVerdict: ${verdict} (${entries.length} entries)`);
    console.log(`Wrote ${out}`);
  } finally {
    probe.kill('SIGTERM');
  }
})();
