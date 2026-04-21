#!/usr/bin/env node
// Probe proxy: logs every request + returns minimal provider-shaped stubs.
// Zero deps. HTTP only (explicit-config clients send plaintext to 127.0.0.1).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PROBE_PORT || 7877);
const LOG = path.join(__dirname, 'results', 'probe.log.jsonl');
fs.mkdirSync(path.dirname(LOG), { recursive: true });

const classifyAuth = (h) => {
  const a = h.authorization || h.Authorization || h['x-api-key'] || h['X-Api-Key'] || '';
  if (!a) return { type: 'none', truncated: '' };
  const raw = String(a);
  const stripped = raw.replace(/^Bearer\s+/i, '');
  if (stripped.startsWith('sk-')) return { type: 'sk-*', truncated: stripped.slice(0, 7) + '…' };
  if (/^eyJ/.test(stripped)) return { type: 'jwt', truncated: stripped.slice(0, 10) + '…' };
  return { type: 'other', truncated: raw.slice(0, 14) + '…' };
};

const stubAnthropic = { id: 'msg_stub', type: 'message', content: [{ type: 'text', text: 'OK' }], model: 'claude-stub', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
const stubOpenAIChat = { id: 'chatcmpl-stub', object: 'chat.completion', choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, model: 'gpt-stub' };
const stubOpenAIResp = { id: 'resp_stub', object: 'response', output: [{ type: 'output_text', text: 'OK' }], status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } };

const pickStub = (p) => {
  if (p.includes('/v1/messages')) return stubAnthropic;
  if (p.includes('/responses')) return stubOpenAIResp;
  if (p.includes('/chat/completions') || p.includes('/completions')) return stubOpenAIChat;
  if (p.includes('/models')) return { object: 'list', data: [{ id: 'stub-model', object: 'model' }] };
  return stubOpenAIChat;
};

const server = http.createServer((req, res) => {
  if (req.url === '/_probe/log' && req.method === 'GET') {
    const raw = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim() : '';
    const entries = raw ? raw.split('\n').map((l) => JSON.parse(l)) : [];
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(entries));
  }
  if (req.url === '/_probe/reset' && req.method === 'POST') {
    fs.writeFileSync(LOG, '');
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"ok":true}');
  }

  let bodyLen = 0;
  req.on('data', (c) => { bodyLen += c.length; });
  req.on('end', () => {
    const auth = classifyAuth(req.headers);
    const entry = {
      ts: new Date().toISOString(),
      method: req.method,
      path: req.url,
      host: req.headers.host || '',
      auth_type: auth.type,
      auth_truncated: auth.truncated,
      content_length: bodyLen,
      ua: req.headers['user-agent'] || '',
      chatgpt_account_id: req.headers['chatgpt-account-id'] || '',
    };
    fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');
    const stub = pickStub(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(stub));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`probe listening http://127.0.0.1:${PORT}`);
  console.log(`log: ${LOG}`);
});

const shutdown = () => { server.close(() => process.exit(0)); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
