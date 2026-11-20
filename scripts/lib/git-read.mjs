// Reading a repository through git, without touching the working tree. Used by
// scripts/review-areas.mjs and scripts/check-pr.mjs. Every function throws on a git failure;
// the CLIs turn that into exit 2, so a check built on them never passes by accident.
import { execFileSync } from 'node:child_process';

const BIG = 256 * 1024 * 1024;

export function git(args) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: BIG,
  });
}

export function mergeBase(a, b) {
  return git(['merge-base', a, b]).trim();
}

export function commitExists(ref) {
  try {
    git(['cat-file', '-e', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export function isAncestor(a, b) {
  try {
    git(['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

// Changed files between two commits: [{ status, path, oldPath?, score? }]. `status` is the letter
// git prints (A, M, D, T, R, C). With renames on, a rename carries its similarity in `score`
// (100 = the same content under a new name).
export function changedFiles(from, to, { renames = true } = {}) {
  const parts = git(['diff', '--name-status', '-z', renames ? '--find-renames' : '--no-renames', from, to])
    .split('\0')
    .filter((part) => part !== '');
  const changes = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++];
    const status = code[0];
    if (status === 'R' || status === 'C') {
      changes.push({ status, score: Number(code.slice(1)), oldPath: parts[i++], path: parts[i++] });
    } else {
      changes.push({ status, path: parts[i++] });
    }
  }
  return changes;
}

export function listTree(ref, dir) {
  return git(['ls-tree', '-r', '--name-only', '-z', ref, '--', dir]).split('\0').filter(Boolean);
}

// Text of many files at one commit, in a single git process: Map(path -> text). Paths that are
// missing or are not files are left out.
export function readBlobs(ref, paths) {
  const result = new Map();
  if (paths.length === 0) return result;
  const out = execFileSync('git', ['cat-file', '--batch'], {
    input: paths.map((path) => `${ref}:${path}`).join('\n') + '\n',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: BIG,
  });
  let offset = 0;
  for (const path of paths) {
    const newline = out.indexOf(0x0a, offset);
    const header = out.toString('utf8', offset, newline);
    offset = newline + 1;
    if (header.endsWith(' missing') || header.endsWith(' ambiguous')) continue;
    const [, type, size] = header.split(' ');
    const length = Number(size);
    if (type === 'blob') result.set(path, out.toString('utf8', offset, offset + length));
    offset += length + 1;
  }
  return result;
}
