// The git object layer: an in-memory object database with SHA-1 ids,
// zlib-packed storage format compatibility, tree/commit codecs, packfile
// writing (full objects) and packfile reading (including ofs/ref delta
// application, which real clients send on push). No git binary anywhere —
// this is the whole engine the smart-HTTP layer and the REST contents
// views are built on.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export const TYPE_IDS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const ID_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface GitObject { type: GitObjectType; data: Buffer }

export function objectId(type: GitObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export class ObjectStore {
  private objects = new Map<string, GitObject>();

  write(type: GitObjectType, data: Buffer): string {
    const sha = objectId(type, data);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }
  read(sha: string): GitObject | undefined { return this.objects.get(sha); }
  has(sha: string): boolean { return this.objects.has(sha); }
  get size(): number { return this.objects.size; }
  entries(): IterableIterator<[string, GitObject]> { return this.objects.entries(); }
}

// ----- trees -----
export interface TreeEntry { mode: string; name: string; sha: string }

export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const mode = data.toString('utf8', i, sp);
    const nul = data.indexOf(0x00, sp);
    const name = data.toString('utf8', sp + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    out.push({ mode, name, sha });
    i = nul + 21;
  }
  return out;
}

// ----- commits -----
export interface Commit {
  tree: string;
  parents: string[];
  author: string;     // full "Name <email> ts tz" line value
  committer: string;
  message: string;
  extra: Array<[string, string]>;
}

export function serializeCommit(c: Commit): Buffer {
  const lines = [`tree ${c.tree}`];
  for (const p of c.parents) lines.push(`parent ${p}`);
  lines.push(`author ${c.author}`);
  lines.push(`committer ${c.committer}`);
  for (const [k, v] of c.extra) lines.push(`${k} ${v}`);
  return Buffer.from(`${lines.join('\n')}\n\n${c.message}`, 'utf8');
}

export function parseCommit(data: Buffer): Commit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const c: Commit = { tree: '', parents: [], author: '', committer: '', message, extra: [] };
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const key = line.slice(0, sp), value = line.slice(sp + 1);
    if (key === 'tree') c.tree = value;
    else if (key === 'parent') c.parents.push(value);
    else if (key === 'author') c.author = value;
    else if (key === 'committer') c.committer = value;
    else c.extra.push([key, value]);
  }
  return c;
}

export function ident(name: string, email: string, date = new Date()): string {
  const ts = Math.floor(date.getTime() / 1000);
  return `${name} <${email}> ${ts} +0000`;
}

// ----- walking -----
/** All objects reachable from a commit (commits, trees, blobs). */
export function reachableFrom(store: ObjectStore, tip: string, depthLimit = Infinity): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const queue: Array<{ sha: string; depth: number }> = [{ sha: tip, depth: 0 }];
  let head = 0;
  while (head < queue.length) {
    const { sha, depth } = queue[head++];
    if (out.has(sha)) continue;
    const obj = store.read(sha);
    if (!obj) continue;
    out.set(sha, obj);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push({ sha: c.tree, depth });
      if (depth < depthLimit) for (const p of c.parents) queue.push({ sha: p, depth: depth + 1 });
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) queue.push({ sha: e.sha, depth });
    } else if (obj.type === 'tag') {
      const m = /object ([0-9a-f]{40})/.exec(obj.data.toString('utf8'));
      if (m) queue.push({ sha: m[1], depth });
    }
  }
  return out;
}

/** Commit ancestry set (commit shas only), optionally depth-limited. */
export function commitAncestors(store: ObjectStore, tip: string, depthLimit = Infinity): Set<string> {
  const out = new Set<string>();
  const queue: Array<{ sha: string; depth: number }> = [{ sha: tip, depth: 0 }];
  let head = 0;
  while (head < queue.length) {
    const { sha, depth } = queue[head++];
    if (out.has(sha) || depth > depthLimit) continue;
    const obj = store.read(sha);
    if (!obj || obj.type !== 'commit') continue;
    out.add(sha);
    for (const p of parseCommit(obj.data).parents) queue.push({ sha: p, depth: depth + 1 });
  }
  return out;
}

// ----- packfiles -----
export function writePack(objects: Array<{ sha: string } & GitObject>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(packEntryHeader(TYPE_IDS[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function packEntryHeader(typeId: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeId << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

interface PackEntry {
  offset: number;
  typeId: number;
  baseOffset?: number;   // ofs-delta
  baseSha?: string;      // ref-delta
  data: Buffer;          // inflated payload (delta instructions for deltas)
}

/** Parse a pack into the given store; returns the object ids written. */
export function readPack(store: ObjectStore, pack: Buffer, externalBase?: (sha: string) => GitObject | undefined): string[] {
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  const entries: PackEntry[] = [];
  let off = 12;
  const byOffset = new Map<number, PackEntry & { resolved?: GitObject }>();
  for (let n = 0; n < count; n++) {
    const start = off;
    let b = pack[off++];
    const typeId = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) { b = pack[off++]; size |= (b & 0x7f) << shift; shift += 7; }
    const entry: PackEntry = { offset: start, typeId, data: Buffer.alloc(0) };
    if (typeId === 6) { // ofs-delta
      let c = pack[off++];
      let baseOff = c & 0x7f;
      while (c & 0x80) { c = pack[off++]; baseOff = ((baseOff + 1) << 7) | (c & 0x7f); }
      entry.baseOffset = start - baseOff;
    } else if (typeId === 7) { // ref-delta
      entry.baseSha = pack.toString('hex', off, off + 20);
      off += 20;
    }
    const inflated = inflateExact(pack, off, size);
    entry.data = inflated;
    off += inflated.consumedBytes;
    entries.push(entry);
    byOffset.set(start, entry as PackEntry & { resolved?: GitObject });
  }
  const written: string[] = [];
  const resolve = (entry: PackEntry & { resolved?: GitObject }): GitObject => {
    if (entry.resolved) return entry.resolved;
    let resolved: GitObject;
    if (entry.typeId === 6 || entry.typeId === 7) {
      let base: GitObject | undefined;
      if (entry.typeId === 6) {
        const baseEntry = byOffset.get(entry.baseOffset as number);
        if (baseEntry) base = resolve(baseEntry);
      } else {
        base = store.read(entry.baseSha as string) ?? (externalBase ? externalBase(entry.baseSha as string) : undefined);
      }
      if (!base) throw new Error('delta base not found');
      resolved = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      resolved = { type: ID_TYPES[entry.typeId], data: entry.data };
    }
    entry.resolved = resolved;
    return resolved;
  };
  for (const entry of entries) {
    const obj = resolve(entry as PackEntry & { resolved?: GitObject });
    written.push(store.write(obj.type, obj.data));
  }
  return written;
}

/**
 * Inflate one deflate stream starting at `off`, knowing its exact output
 * size from the pack entry header. Node's inflateSync tolerates trailing
 * bytes but does not report how many it consumed, so binary-search the
 * shortest prefix that inflates to exactly `expectedSize`.
 */
function inflateExact(buf: Buffer, off: number, expectedSize: number): Buffer & { consumedBytes: number } {
  const remaining = buf.length - off;
  const attempt = (len: number): Buffer | null => {
    try {
      const out = inflateSync(buf.subarray(off, off + len));
      return out.length === expectedSize ? out : null;
    } catch { return null; }
  };
  // Fast path: a deflate stream is rarely larger than its plaintext plus
  // a small overhead, so try that window first; grow exponentially to a
  // working length, then binary-search the exact end inside it.
  let hi = Math.min(remaining, expectedSize + 64);
  let found = attempt(hi);
  let lo = 1;
  if (!found) {
    lo = hi + 1;
    hi = Math.min(remaining, hi * 2);
    for (;;) {
      found = attempt(hi);
      if (found) break;
      if (hi >= remaining) throw new Error('pack entry does not inflate');
      lo = hi + 1;
      hi = Math.min(remaining, hi * 2);
    }
  }
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const out = attempt(mid);
    if (out) { found = out; hi = mid; } else lo = mid + 1;
  }
  const result = found as Buffer & { consumedBytes: number };
  result.consumedBytes = lo;
  return result;
}

/** Apply a git delta buffer to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVarint = (): number => {
    let v = 0, s = 0;
    for (;;) { const b = delta[i++]; v |= (b & 0x7f) << s; s += 7; if (!(b & 0x80)) break; }
    return v;
  };
  const srcSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const dstSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      let cpOff = 0, cpSize = 0;
      if (op & 0x01) cpOff = delta[i++];
      if (op & 0x02) cpOff |= delta[i++] << 8;
      if (op & 0x04) cpOff |= delta[i++] << 16;
      if (op & 0x08) cpOff |= delta[i++] << 24;
      if (op & 0x10) cpSize = delta[i++];
      if (op & 0x20) cpSize |= delta[i++] << 8;
      if (op & 0x40) cpSize |= delta[i++] << 16;
      if (cpSize === 0) cpSize = 0x10000;
      parts.push(base.subarray(cpOff, cpOff + cpSize));
      produced += cpSize;
    } else if (op > 0) {
      parts.push(delta.subarray(i, i + op));
      produced += op;
      i += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== dstSize || produced !== dstSize) throw new Error('delta result size mismatch');
  return out;
}

// ----- pkt-line -----
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface PktReader { lines: Array<Buffer | 'flush' | 'delim'> }
export function readPkts(buf: Buffer, start = 0): { items: Array<Buffer | 'flush' | 'delim'>; consumed: number } {
  const items: Array<Buffer | 'flush' | 'delim'> = [];
  let i = start;
  while (i + 4 <= buf.length) {
    const lenHex = buf.toString('ascii', i, i + 4);
    if (!/^[0-9a-f]{4}$/.test(lenHex)) break;
    const len = parseInt(lenHex, 16);
    if (len === 0) { items.push('flush'); i += 4; continue; }
    if (len === 1) { items.push('delim'); i += 4; continue; }
    if (len === 2) { items.push('flush'); i += 4; continue; } // response-end (v2)
    if (i + len > buf.length) break;
    items.push(buf.subarray(i + 4, i + len));
    i += len;
  }
  return { items, consumed: i - start };
}
