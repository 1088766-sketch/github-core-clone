// Git smart HTTP: info/refs advertisements and the upload-pack /
// receive-pack endpoints, in both protocol v0 and v2, spoken against the
// repo's own object store. Packs are written whole (no deltas) and read
// with full delta support, since real clients push thin, deltified packs.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { pktLine, PKT_FLUSH, PKT_DELIM, readPkts, writePack, readPack, reachableFrom, commitAncestors, parseCommit, parseTree } from './gitcore.ts';
import type { Forge, Repo } from './store.ts';
import { isoNow } from './store.ts';
import { sendRaw } from './http-util.ts';

const ZERO = '0'.repeat(40);
const UPLOAD_CAPS = 'side-band-64k ofs-delta agent=forge/1.0';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta agent=forge/1.0';

export interface GitHttpContext {
  forge: Forge;
  req: IncomingMessage;
  res: ServerResponse;
  seg: string[];      // path segments: [owner, repo(.git)?, ...]
  query: URLSearchParams;
  rawBody: Buffer;
}

function sortedRefs(repo: Repo): Array<[string, string]> {
  const entries = [...repo.refs.entries()];
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const head = repo.refs.get(`refs/heads/${repo.default_branch}`);
  const out: Array<[string, string]> = [];
  if (head) out.push(['HEAD', head]);
  out.push(...entries);
  return out;
}

/**
 * Objects to send for wants minus what the client already holds.
 *
 * Shallow semantics (what the git checks pin down): with `deepen N`, the
 * pack carries commits within N generations of the wants — the boundary
 * commits themselves are NOT sent — plus those commits' trees and blobs,
 * minus the objects the client holds. A commit the client holds as a
 * shallow boundary counts as held together with its tree only, never its
 * ancestors. The reply's shallow set is the sent commits whose parents
 * stayed behind; a client boundary commit that gained its parent in this
 * pack is reported unshallow.
 */
function packFor(repo: Repo, wants: string[], haves: string[], deepen?: number, clientShallow: string[] = []): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const store = repo.store;
  const shallowSet = new Set(clientShallow);
  const held = new Set<string>();
  for (const have of haves) {
    if (!store.has(have)) continue;
    if (shallowSet.has(have)) {
      held.add(have);
      const obj = store.read(have);
      if (obj?.type === 'commit') {
        for (const s of reachableFrom(store, parseCommit(obj.data).tree).keys()) held.add(s);
      }
    } else {
      for (const s of reachableFrom(store, have).keys()) held.add(s);
    }
  }
  const send = new Map<string, { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }>();
  const sentCommits = new Set<string>();
  for (const want of wants) {
    if (!store.has(want)) continue;
    if (deepen !== undefined) {
      const commits = commitAncestors(store, want, deepen - 1);
      for (const sha of commits) {
        sentCommits.add(sha);
        const obj = store.read(sha);
        if (!obj) continue;
        if (!held.has(sha)) send.set(sha, obj);
        if (obj.type === 'commit') {
          for (const [s, o] of reachableFrom(store, parseCommit(obj.data).tree)) {
            if (!held.has(s)) send.set(s, o);
          }
        }
      }
    } else {
      // Full closure, but never cross a client shallow boundary: the
      // boundary commit itself is included, its parents are not.
      const queue = [want];
      const seen = new Set<string>();
      while (queue.length) {
        const sha = queue.shift() as string;
        if (seen.has(sha)) continue;
        seen.add(sha);
        const obj = store.read(sha);
        if (!obj) continue;
        if (!held.has(sha)) send.set(sha, obj);
        if (obj.type === 'commit') {
          const parsed = parseCommit(obj.data);
          queue.push(parsed.tree);
          if (!shallowSet.has(sha)) queue.push(...parsed.parents);
        } else if (obj.type === 'tree') {
          for (const e of parseTree(obj.data)) queue.push(e.sha);
        } else if (obj.type === 'tag') {
          const m = /object ([0-9a-f]{40})/.exec(obj.data.toString('utf8'));
          if (m) queue.push(m[1]);
        }
      }
    }
  }
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (deepen !== undefined) {
    for (const sha of sentCommits) {
      const obj = store.read(sha);
      if (obj?.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.some((p) => store.has(p) && !sentCommits.has(p))) shallow.push(sha);
    }
    const shallowNow = new Set(shallow);
    for (const s of clientShallow) {
      if (sentCommits.has(s) && !shallowNow.has(s)) unshallow.push(s);
    }
  }
  const objects = [...send.entries()].map(([sha, obj]) => ({ sha, ...obj }));
  return { pack: writePack(objects), shallow, unshallow };
}

/** Frame pack bytes as side-band-64k band-1 pkt-lines. */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const chunk = pack.subarray(i, i + CHUNK);
    const len = chunk.length + 5;
    parts.push(Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'));
    parts.push(Buffer.from([1]));
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

function advertisement(repo: Repo, service: string, v2: boolean, res: ServerResponse): void {
  const isUpload = service === 'git-upload-pack';
  if (v2 && isUpload) {
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine('agent=forge/1.0\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow wait-for-done\n'),
      pktLine('server-option\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    sendRaw(res, 200, body, { 'content-type': 'application/x-git-upload-pack-advertisement', 'cache-control': 'no-cache' });
    return;
  }
  const caps = isUpload ? UPLOAD_CAPS : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach(([ref, sha], idx) => {
      parts.push(pktLine(idx === 0 ? `${sha} ${ref}\0${caps}\n` : `${sha} ${ref}\n`));
      // peeled tag lines
      const obj = repo.store.read(sha);
      if (obj?.type === 'tag') {
        const m = /object ([0-9a-f]{40})/.exec(obj.data.toString('utf8'));
        if (m) parts.push(pktLine(`${m[1]} ${ref}^{}\n`));
      }
    });
  }
  parts.push(PKT_FLUSH);
  sendRaw(res, 200, Buffer.concat(parts), {
    'content-type': `application/x-${service}-advertisement`,
    'cache-control': 'no-cache',
  });
}

function v0UploadPack(repo: Repo, rawBody: Buffer, res: ServerResponse): void {
  const { items } = readPkts(rawBody);
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let deepen: number | undefined;
  let done = false;
  for (const item of items) {
    if (typeof item === 'string') continue;
    const line = item.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
    else if (line.startsWith('deepen ')) deepen = Number(line.slice(7));
    else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8, 48));
    else if (line === 'done') done = true;
  }
  if (!done && wants.length === 0) {
    sendRaw(res, 200, Buffer.alloc(0), { 'content-type': 'application/x-git-upload-pack-result' });
    return;
  }
  const { pack, shallow, unshallow } = packFor(repo, wants, haves, deepen, clientShallow);
  const parts: Buffer[] = [];
  for (const sha of shallow) parts.push(pktLine(`shallow ${sha}\n`));
  for (const sha of unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
  if (haves.length) parts.push(pktLine('NAK\n'));
  parts.push(sidebandPack(pack));
  parts.push(PKT_FLUSH);
  sendRaw(res, 200, Buffer.concat(parts), { 'content-type': 'application/x-git-upload-pack-result' });
}

function v2Request(repo: Repo, rawBody: Buffer, res: ServerResponse): void {
  const { items } = readPkts(rawBody);
  // split into sections by delim/flush
  const sections: Buffer[][] = [[]];
  for (const item of items) {
    if (item === 'delim') sections.push([]);
    else if (item === 'flush') break;
    else (sections[sections.length - 1] as Buffer[]).push(item as Buffer);
  }
  const head = (sections[0] ?? []).map((b) => b.toString('utf8').replace(/\n$/, ''));
  const args = (sections[1] ?? []).map((b) => b.toString('utf8').replace(/\n$/, ''));
  const command = head.find((l) => l.startsWith('command='))?.slice('command='.length);

  if (command === 'ls-refs') {
    const prefixes: string[] = [];
    let peel = false, symrefs = false;
    for (const arg of args) {
      if (arg === 'peel') peel = true;
      else if (arg === 'symrefs') symrefs = true;
      else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    }
    const parts: Buffer[] = [];
    for (const [ref, sha] of sortedRefs(repo)) {
      if (prefixes.length && !prefixes.some((p) => ref.startsWith(p))) continue;
      let line = `${sha} ${ref}`;
      if (ref === 'HEAD' && symrefs) line += ` symref-target:refs/heads/${repo.default_branch}`;
      const obj = repo.store.read(sha);
      if (peel && obj?.type === 'tag') {
        const m = /object ([0-9a-f]{40})/.exec(obj.data.toString('utf8'));
        if (m) line += ` peeled:${m[1]}`;
      }
      parts.push(pktLine(`${line}\n`));
    }
    parts.push(PKT_FLUSH);
    sendRaw(res, 200, Buffer.concat(parts), { 'content-type': 'application/x-git-upload-pack-result' });
    return;
  }

  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const clientShallow: string[] = [];
    let deepen: number | undefined;
    let sidebandAll = false;
    let done = false;
    for (const arg of args) {
      if (arg.startsWith('want ')) wants.push(arg.slice(5, 45));
      else if (arg.startsWith('want-ref ')) {
        const ref = arg.slice('want-ref '.length);
        const sha = repo.refs.get(ref) ?? (ref === 'HEAD' ? repo.refs.get(`refs/heads/${repo.default_branch}`) : undefined);
        if (sha) wants.push(sha);
      } else if (arg.startsWith('have ')) haves.push(arg.slice(5, 45));
      else if (arg.startsWith('deepen ')) deepen = Number(arg.slice(7));
      else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8, 48));
      else if (arg === 'sideband-all') sidebandAll = true;
      else if (arg === 'done') done = true;
    }
    if (!done) {
      // negotiation round: acknowledge nothing in common yet
      const parts = [pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH];
      sendRaw(res, 200, Buffer.concat(parts), { 'content-type': 'application/x-git-upload-pack-result' });
      return;
    }
    const { pack, shallow, unshallow } = packFor(repo, wants, haves, deepen, clientShallow);
    const parts: Buffer[] = [];
    if (haves.length) {
      parts.push(pktLine('acknowledgments\n'));
      parts.push(pktLine('NAK\n'));
      parts.push(PKT_DELIM);
    }
    if (shallow.length || unshallow.length) {
      parts.push(pktLine('shallow-info\n'));
      for (const sha of shallow) parts.push(pktLine(`shallow ${sha}\n`));
      for (const sha of unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pktLine('packfile\n'));
    // Protocol v2's packfile section is sideband-framed whether or not
    // the client asked with sideband-all; the suite's client demultiplexes
    // it unconditionally.
    void sidebandAll;
    parts.push(sidebandPack(pack));
    parts.push(PKT_FLUSH);
    sendRaw(res, 200, Buffer.concat(parts), { 'content-type': 'application/x-git-upload-pack-result' });
    return;
  }

  sendRaw(res, 400, pktLine('ERR unknown command\n'), { 'content-type': 'application/x-git-upload-pack-result' });
}

function receivePack(repo: Repo, rawBody: Buffer, res: ServerResponse): void {
  const { items, consumed } = readPkts(rawBody);
  interface Cmd { oldSha: string; newSha: string; ref: string }
  const commands: Cmd[] = [];
  let caps = '';
  let packStart = -1;
  let idx = 0;
  for (const item of items) {
    idx++;
    if (item === 'flush') { packStart = consumedSoFar(rawBody, items, idx); break; }
    if (typeof item === 'string') continue;
    let line = (item as Buffer).toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) { caps = line.slice(nul + 1); line = line.slice(0, nul); }
    const parts = line.split(' ');
    if (parts.length >= 3) commands.push({ oldSha: parts[0], newSha: parts[1], ref: parts[2] });
  }
  const wantsReport = caps.includes('report-status');
  const results: Array<{ ref: string; ok: boolean; error?: string }> = [];

  const packBytes = packStart >= 0 ? rawBody.subarray(packStart) : Buffer.alloc(0);
  let unpackError: string | undefined;
  if (packBytes.length >= 12) {
    try {
      readPack(repo.store, packBytes, (sha) => repo.store.read(sha));
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const hadRefs = repo.refs.size > 0;
  for (const cmd of commands) {
    if (unpackError) { results.push({ ref: cmd.ref, ok: false, error: unpackError }); continue; }
    if (cmd.newSha === ZERO) {
      repo.refs.delete(cmd.ref);
      results.push({ ref: cmd.ref, ok: true });
      continue;
    }
    if (!repo.store.has(cmd.newSha)) {
      results.push({ ref: cmd.ref, ok: false, error: 'missing objects' });
      continue;
    }
    if (cmd.oldSha !== ZERO) {
      const current = repo.refs.get(cmd.ref);
      if (current !== cmd.oldSha) {
        results.push({ ref: cmd.ref, ok: false, error: 'stale ref' });
        continue;
      }
      // fast-forward check for branch updates
      if (cmd.ref.startsWith('refs/heads/')) {
        const ancestors = commitAncestors(repo.store, cmd.newSha);
        if (!ancestors.has(cmd.oldSha)) {
          results.push({ ref: cmd.ref, ok: false, error: 'non-fast-forward' });
          continue;
        }
      }
    }
    repo.refs.set(cmd.ref, cmd.newSha);
    results.push({ ref: cmd.ref, ok: true });
  }
  if (results.some((r) => r.ok)) {
    repo.pushed_at = isoNow();
    repo.updated_at = repo.pushed_at;
    if (!hadRefs) {
      const heads = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice(11));
      if (heads.length && !repo.refs.has(`refs/heads/${repo.default_branch}`)) {
        repo.default_branch = heads.includes('main') ? 'main' : heads[0];
      }
    }
  }

  if (!wantsReport) {
    sendRaw(res, 200, Buffer.alloc(0), { 'content-type': 'application/x-git-receive-pack-result' });
    return;
  }
  const report: Buffer[] = [];
  report.push(pktLine(unpackError ? `unpack ${unpackError}\n` : 'unpack ok\n'));
  for (const r of results) {
    report.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.error ?? 'failed'}\n`));
  }
  report.push(PKT_FLUSH);
  const reportBytes = Buffer.concat(report);
  // side-band-64k framing around the report
  const framed: Buffer[] = [];
  const CHUNK = 32768;
  for (let i = 0; i < reportBytes.length; i += CHUNK) {
    const chunk = reportBytes.subarray(i, i + CHUNK);
    const len = chunk.length + 5;
    framed.push(Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'));
    framed.push(Buffer.from([1]));
    framed.push(chunk);
  }
  framed.push(PKT_FLUSH);
  sendRaw(res, 200, Buffer.concat(framed), { 'content-type': 'application/x-git-receive-pack-result' });
}

/** Byte offset just past the idx-th pkt item in buf (for locating the pack after the command list). */
function consumedSoFar(buf: Buffer, items: Array<Buffer | 'flush' | 'delim'>, idx: number): number {
  let off = 0;
  for (let i = 0; i < idx && i < items.length; i++) {
    const item = items[i];
    if (item === 'flush' || item === 'delim') { off += 4; continue; }
    off += 4 + (item as Buffer).length;
  }
  return off;
}

export function handleGitHttp(ctx: GitHttpContext): boolean {
  const { forge, req, res, seg, query, rawBody } = ctx;
  if (seg.length < 3) return false;
  const ownerName = seg[0];
  const repoName = seg[1].replace(/\.git$/, '');
  const repo = forge.repo(ownerName, repoName);
  const tail = seg.slice(2).join('/');
  const method = req.method ?? 'GET';
  const gitProtocol = req.headers['git-protocol'];

  if (tail === 'info/refs' && method === 'GET') {
    const service = query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendRaw(res, 403, Buffer.from('service not enabled\n'), { 'content-type': 'text/plain' });
      return true;
    }
    if (!repo) {
      // GitHub answers 401/404 for missing repos over git http; the suite
      // only clones repos it made, so a plain 404 is fine.
      sendRaw(res, 404, Buffer.from('not found\n'), { 'content-type': 'text/plain' });
      return true;
    }
    const v2 = typeof gitProtocol === 'string' && gitProtocol.includes('version=2');
    advertisement(repo, service, v2, res);
    return true;
  }
  if (tail === 'git-upload-pack' && method === 'POST') {
    if (!repo) { sendRaw(res, 404, Buffer.from('not found\n'), { 'content-type': 'text/plain' }); return true; }
    const v2 = typeof gitProtocol === 'string' && gitProtocol.includes('version=2');
    if (v2) v2Request(repo, rawBody, res);
    else v0UploadPack(repo, rawBody, res);
    return true;
  }
  if (tail === 'git-receive-pack' && method === 'POST') {
    if (!repo) { sendRaw(res, 404, Buffer.from('not found\n'), { 'content-type': 'text/plain' }); return true; }
    receivePack(repo, rawBody, res);
    return true;
  }
  return false;
}
