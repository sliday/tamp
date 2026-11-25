// Per-command stdout rewriters for the `cmd-strip` stage.
// Each rewriter module lives in ./commands/<name>.js and exports:
//   { name, match(text) -> bool, rewrite(text) -> string }
//
// Priority order is frozen — most specific signatures first so that a noisy
// output like `npm install` never gets eaten by a looser matcher.

import npm from './commands/npm.js';
import pnpmBun from './commands/pnpm-bun.js';
import pip from './commands/pip.js';
import cargo from './commands/cargo.js';
import docker from './commands/docker.js';
import prisma from './commands/prisma.js';
import terraform from './commands/terraform.js';
import git from './commands/git.js';
import pytest from './commands/pytest.js';
import vitest from './commands/vitest.js';
import goTest from './commands/go-test.js';
import nodeTest from './commands/node-test.js';
import jest from './commands/jest.js';
import wgetCurl from './commands/wget-curl.js';

// Linear-time SGR/CSI ANSI escape sequence matcher: the four classes (\x1b[,
// [0-9;?], [ -/], [@-~]) are pairwise disjoint, preventing backtracking.
const ANSI_CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text) {
  if (typeof text !== 'string' || text.length === 0) return text ?? '';
  if (!text.includes('\x1b')) return text;
  return text.replace(ANSI_CSI_RE, '');
}

const REGISTRY = Object.freeze({
  npm,
  'pnpm-bun': pnpmBun,
  pip,
  cargo,
  docker,
  prisma,
  terraform,
  git,
  pytest,
  vitest,
  'go-test': goTest,
  'node-test': nodeTest,
  jest,
  'wget-curl': wgetCurl,
});

export const PRIORITY = Object.freeze([
  'npm',
  'pnpm-bun',
  'pip',
  'cargo',
  'docker',
  'prisma',
  'terraform',
  'git',
  'pytest',
  'vitest',
  'go-test',
  'node-test',
  'jest',
  'wget-curl',
]);

export function getRewriter(name) {
  if (!name) return null;
  return REGISTRY[name] || null;
}

export function rewriteCommandOutput(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: text ?? '', rewriter: null, savedBytes: 0 };
  }
  const clean = stripAnsi(text);
  const ansiStripped = clean.length < text.length;

  for (const name of PRIORITY) {
    const mod = REGISTRY[name];
    if (!mod) continue;
    let hit = false;
    try {
      hit = !!mod.match(clean);
    } catch {
      hit = false;
    }
    if (!hit) continue;
    let out = clean;
    try {
      out = mod.rewrite(clean);
    } catch {
      out = clean;
    }
    if (typeof out !== 'string') out = clean;
    const savedBytes = Math.max(0, Buffer.byteLength(text, 'utf8') - Buffer.byteLength(out, 'utf8'));
    return { text: out, rewriter: mod.name || name, savedBytes };
  }

  if (ansiStripped) {
    const savedBytes = Math.max(0, Buffer.byteLength(text, 'utf8') - Buffer.byteLength(clean, 'utf8'));
    return { text: clean, rewriter: 'ansi', savedBytes };
  }

  return { text, rewriter: null, savedBytes: 0 };
}

export default { getRewriter, rewriteCommandOutput, stripAnsi, PRIORITY };
