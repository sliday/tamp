// Per-command stdout rewriters for the `cmd-strip` stage.
// Each rewriter module lives in ./commands/<name>.js and exports:
//   { name, match(text) -> bool, rewrite(text) -> string }
//
// Priority order is frozen — most specific signatures first so that a noisy
// output like `npm install` never gets eaten by a looser matcher.

import npm from './commands/npm.js';
import pip from './commands/pip.js';
import cargo from './commands/cargo.js';
import docker from './commands/docker.js';
import prisma from './commands/prisma.js';
import terraform from './commands/terraform.js';
import git from './commands/git.js';
import pytest from './commands/pytest.js';
import jest from './commands/jest.js';
import wgetCurl from './commands/wget-curl.js';

const REGISTRY = Object.freeze({
  npm,
  pip,
  cargo,
  docker,
  prisma,
  terraform,
  git,
  pytest,
  jest,
  'wget-curl': wgetCurl,
});

export const PRIORITY = Object.freeze([
  'npm',
  'pip',
  'cargo',
  'docker',
  'prisma',
  'terraform',
  'git',
  'pytest',
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
  for (const name of PRIORITY) {
    const mod = REGISTRY[name];
    if (!mod) continue;
    let hit = false;
    try {
      hit = !!mod.match(text);
    } catch {
      hit = false;
    }
    if (!hit) continue;
    let out = text;
    try {
      out = mod.rewrite(text);
    } catch {
      out = text;
    }
    if (typeof out !== 'string') out = text;
    const savedBytes = Math.max(0, Buffer.byteLength(text, 'utf8') - Buffer.byteLength(out, 'utf8'));
    return { text: out, rewriter: mod.name || name, savedBytes };
  }
  return { text, rewriter: null, savedBytes: 0 };
}

export default { getRewriter, rewriteCommandOutput, PRIORITY };
