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

// Changed files between two commits: [{ status, path, oldPath?, score?, oldBlob, newBlob }].
// `status` is the letter git prints (A, M, D, T, R, C). With renames on, a rename carries its
// similarity in `score`, but only equal blob ids prove the content did not change: git can score a
// file whose lines were only reordered as R100.
export function changedFiles(from, to, { renames = true } = {}) {
  const parts = git(['diff', '--raw', '-z', '--no-abbrev', renames ? '--find-renames' : '--no-renames', from, to])
    .split('\0')
    .filter((part) => part !== '');
  const changes = [];
  for (let i = 0; i < parts.length; ) {
    // ":<old mode> <new mode> <old blob> <new blob> <status>", then one path, or two for R and C.
    const [, , oldBlob, newBlob, code] = parts[i++].split(' ');
    const status = code[0];
    if (status === 'R' || status === 'C') {
      changes.push({ status, score: Number(code.slice(1)), oldPath: parts[i++], path: parts[i++], oldBlob, newBlob });
    } else {
      changes.push({ status, path: parts[i++], oldBlob, newBlob });
    }
  }
  return changes;
}

export function listTree(ref, dir) {
  return git(['ls-tree', '-r', '--name-only', '-z', ref, '--', dir]).split('\0').filter(Boolean);
}

// Text of many files at one commit, in a single git process: Map(path -> text). Paths that are
// missing or are not files are left out. `cat-file --batch` reads one request per line, so a path
// holding a line break would shift every answer after it: such a path throws instead.
export function readBlobs(ref, paths) {
  const result = new Map();
  if (paths.length === 0) return result;
  const broken = paths.find((path) => /[\r\n]/.test(path));
  if (broken !== undefined) {
    throw new Error(`a file name holds a line break, which the gate cannot read safely: ${JSON.stringify(broken)}`);
  }
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
