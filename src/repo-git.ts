// Repository-level git operations on the object store: ref resolution,
// tree walking, commit logs, tree diffs with unified patches, and the
// three-way merges pull requests need (merge commits and squashes, with
// file-level conflict detection).

import { ObjectStore, parseTree, parseCommit, serializeCommit, serializeTree, ident, type Commit, type TreeEntry } from './gitcore.ts';
import type { Repo } from './store.ts';

export function resolveRef(repo: Repo, ref: string): string | undefined {
  if (/^[0-9a-f]{40}$/.test(ref)) return repo.store.has(ref) ? ref : undefined;
  if (ref === 'HEAD') {
    const head = repo.refs.get(`refs/heads/${repo.default_branch}`);
    return head;
  }
  const candidates = [
    ref,
    `refs/heads/${ref}`,
    `refs/tags/${ref}`,
    `refs/${ref}`,
  ];
  for (const c of candidates) {
    const sha = repo.refs.get(c);
    if (sha) return sha;
  }
  return undefined;
}

/** Peel a ref/sha to a commit sha (through tags). */
export function peelToCommit(store: ObjectStore, sha: string): string | undefined {
  let cur = sha;
  for (let i = 0; i < 8; i++) {
    const obj = store.read(cur);
    if (!obj) return undefined;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      const m = /object ([0-9a-f]{40})/.exec(obj.data.toString('utf8'));
      if (!m) return undefined;
      cur = m[1];
      continue;
    }
    return undefined;
  }
  return undefined;
}

export function commitOf(store: ObjectStore, sha: string): Commit | undefined {
  const obj = store.read(sha);
  if (!obj || obj.type !== 'commit') return undefined;
  return parseCommit(obj.data);
}

/** Walk a tree to the entry at `path` ('' = the tree itself). */
export function entryAtPath(store: ObjectStore, treeSha: string, path: string): { mode: string; sha: string; type: 'blob' | 'tree' } | undefined {
  if (path === '' || path === '/') return { mode: '40000', sha: treeSha, type: 'tree' };
  const parts = path.split('/').filter(Boolean);
  let cur = treeSha;
  for (let i = 0; i < parts.length; i++) {
    const obj = store.read(cur);
    if (!obj || obj.type !== 'tree') return undefined;
    const entry = parseTree(obj.data).find((e) => e.name === parts[i]);
    if (!entry) return undefined;
    if (i === parts.length - 1) {
      return { mode: entry.mode, sha: entry.sha, type: entry.mode === '40000' ? 'tree' : 'blob' };
    }
    cur = entry.sha;
  }
  return undefined;
}

/** Flatten a tree into path -> entry (blobs and trees), recursively. */
export function flattenTree(store: ObjectStore, treeSha: string, prefix = '', out = new Map<string, TreeEntry & { path: string }>()): Map<string, TreeEntry & { path: string }> {
  const obj = store.read(treeSha);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    out.set(path, { ...e, path });
    if (e.mode === '40000') flattenTree(store, e.sha, path, out);
  }
  return out;
}

/** Only the files (blobs) of a tree, path -> blob sha. */
export function filesOf(store: ObjectStore, treeSha: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, e] of flattenTree(store, treeSha)) {
    if (e.mode !== '40000') out.set(path, e.sha);
  }
  return out;
}

/** Build nested trees from a flat path -> blob sha map; returns root tree sha. */
export function buildTree(store: ObjectStore, files: Map<string, string>): string {
  interface Node { files: Map<string, string>; dirs: Map<string, Node> }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, sha] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { files: new Map(), dirs: new Map() });
      node = node.dirs.get(parts[i]) as Node;
    }
    node.files.set(parts[parts.length - 1], sha);
  }
  const emit = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, sha] of node.files) entries.push({ mode: '100644', name, sha });
    for (const [name, sub] of node.dirs) entries.push({ mode: '40000', name, sha: emit(sub) });
    return store.write('tree', serializeTree(entries));
  };
  return emit(root);
}

/** Newest-first commit list from a tip, following first parents and merges. */
export function commitLog(store: ObjectStore, tip: string, limit = 100): Array<{ sha: string; commit: Commit }> {
  const out: Array<{ sha: string; commit: Commit }> = [];
  const seen = new Set<string>();
  const queue = [tip];
  let head = 0;
  while (head < queue.length && out.length < limit) {
    const sha = queue[head++];
    if (seen.has(sha)) continue;
    seen.add(sha);
    const commit = commitOf(store, sha);
    if (!commit) continue;
    out.push({ sha, commit });
    queue.push(...commit.parents);
  }
  return out;
}

/** The best common ancestor of two commits (BFS from both). */
export function mergeBase(store: ObjectStore, a: string, b: string): string | undefined {
  const ancestorsOf = (tip: string): Map<string, number> => {
    const map = new Map<string, number>();
    const queue: Array<{ sha: string; depth: number }> = [{ sha: tip, depth: 0 }];
    let head = 0;
    while (head < queue.length) {
      const { sha, depth } = queue[head++];
      if (map.has(sha)) continue;
      const c = commitOf(store, sha);
      if (!c) continue;
      map.set(sha, depth);
      for (const p of c.parents) queue.push({ sha: p, depth: depth + 1 });
    }
    return map;
  };
  const aa = ancestorsOf(a);
  const bb = ancestorsOf(b);
  let best: string | undefined;
  let bestScore = Infinity;
  for (const [sha, da] of aa) {
    const db = bb.get(sha);
    if (db !== undefined && da + db < bestScore) { bestScore = da + db; best = sha; }
  }
  return best;
}

export function isAncestor(store: ObjectStore, ancestor: string, tip: string): boolean {
  const seen = new Set<string>();
  const queue = [tip];
  let head = 0;
  while (head < queue.length) {
    const sha = queue[head++];
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const c = commitOf(store, sha);
    if (c) queue.push(...c.parents);
  }
  return false;
}

// ----- diffs -----
export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  patch?: string;
  previousPath?: string;
}

function linesOf(store: ObjectStore, sha: string | undefined): string[] {
  if (!sha) return [];
  const obj = store.read(sha);
  if (!obj || obj.type !== 'blob') return [];
  const text = obj.data.toString('utf8');
  if (text.includes('\0')) return [];
  return text.split('\n');
}

/** A compact LCS-based unified diff for one file (test files are small). */
export function unifiedDiff(path: string, oldLines: string[], newLines: string[]): { patch: string; additions: number; deletions: number } {
  const m = oldLines.length, n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Array<{ kind: ' ' | '-' | '+'; line: string }> = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) { ops.push({ kind: ' ', line: oldLines[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ kind: '-', line: oldLines[i] }); i++; }
    else { ops.push({ kind: '+', line: newLines[j] }); j++; }
  }
  while (i < m) ops.push({ kind: '-', line: oldLines[i++] });
  while (j < n) ops.push({ kind: '+', line: newLines[j++] });
  const additions = ops.filter((o) => o.kind === '+').length;
  const deletions = ops.filter((o) => o.kind === '-').length;
  const body = ops.map((o) => `${o.kind}${o.line}`).join('\n');
  const patch = `@@ -1,${m} +1,${n} @@\n${body}`;
  return { patch, additions, deletions };
}

export function diffCommits(store: ObjectStore, baseSha: string | undefined, headSha: string | undefined): FileChange[] {
  const baseFiles = baseSha ? filesOf(store, (commitOf(store, baseSha) as Commit).tree) : new Map<string, string>();
  const headFiles = headSha ? filesOf(store, (commitOf(store, headSha) as Commit).tree) : new Map<string, string>();
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before === after) continue;
    const status = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
    const { patch, additions, deletions } = unifiedDiff(path, linesOf(store, before), linesOf(store, after));
    changes.push({ path, status, additions, deletions, patch });
  }
  return changes;
}

// ----- merging -----
export interface MergeOutcome {
  ok: boolean;
  conflict?: boolean;
  sha?: string;
  fastForward?: boolean;
}

/**
 * Three-way merge of `headSha` into the branch at `baseSha`. With
 * method 'merge' a merge commit is created (or a fast-forward taken);
 * with 'squash' a single-parent commit carries the combined tree.
 * Conflicts are detected per file: both sides changed the same file to
 * different contents since the merge base.
 */
export function mergeInto(repo: Repo, baseSha: string, headSha: string, method: 'merge' | 'squash' | 'rebase', title: string, authorName: string, authorEmail: string): MergeOutcome {
  const store = repo.store;
  if (isAncestor(store, headSha, baseSha)) return { ok: true, sha: baseSha }; // already up to date
  if (method !== 'squash' && isAncestor(store, baseSha, headSha)) {
    return { ok: true, sha: headSha, fastForward: true };
  }
  const base = mergeBase(store, baseSha, headSha);
  const baseFiles = base ? filesOf(store, (commitOf(store, base) as Commit).tree) : new Map<string, string>();
  const oursFiles = filesOf(store, (commitOf(store, baseSha) as Commit).tree);
  const theirsFiles = filesOf(store, (commitOf(store, headSha) as Commit).tree);
  const merged = new Map<string, string>(oursFiles);
  const allPaths = new Set([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()]);
  for (const path of allPaths) {
    const b = baseFiles.get(path), o = oursFiles.get(path), t = theirsFiles.get(path);
    if (o === t) { if (o === undefined) merged.delete(path); else merged.set(path, o); continue; }
    if (b === o) { // only theirs changed
      if (t === undefined) merged.delete(path); else merged.set(path, t);
      continue;
    }
    if (b === t) { // only ours changed
      if (o === undefined) merged.delete(path); else merged.set(path, o);
      continue;
    }
    return { ok: false, conflict: true };
  }
  const tree = buildTree(store, merged);
  const who = ident(authorName, authorEmail);
  const commit: Commit = {
    tree,
    parents: method === 'squash' ? [baseSha] : [baseSha, headSha],
    author: who,
    committer: who,
    message: title,
    extra: [],
  };
  const sha = store.write('commit', serializeCommit(commit));
  return { ok: true, sha };
}
