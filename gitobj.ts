// Pure-Node git object model: blob/tree/commit/tag objects, SHA-1 addressing, packfile
// read/write and delta application. Standard library only (node:crypto, node:zlib).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export interface StoredObject {
  type: ObjType;
  data: Buffer;
}

/** One repository's content-addressed object store. */
export class ObjectStore {
  readonly objects = new Map<string, StoredObject>();

  put(type: ObjType, data: Buffer): string {
    const sha = hashObject(type, data);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }

  putKnown(sha: string, type: ObjType, data: Buffer): void {
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
  }

  get(sha: string): StoredObject | undefined {
    return this.objects.get(sha);
  }

  has(sha: string): boolean {
    return this.objects.has(sha);
  }
}

// --------------------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string; // as stored, e.g. '100644', '40000' for a subtree
  name: string;
  sha: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree (recursively) into a path -> blob sha map. */
export function flattenTree(store: ObjectStore, treeSha: string | null, prefix = '', out = new Map<string, string>()): Map<string, string> {
  if (treeSha === null) return out;
  const object = store.get(treeSha);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000' || entry.mode === '040000') flattenTree(store, entry.sha, path, out);
    else out.set(path, entry.sha);
  }
  return out;
}

/** Build nested trees from a flat path -> blob sha map; answers the root tree sha. */
export function buildTreeFromFlat(store: ObjectStore, flat: Map<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, sha] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = node.dirs.get(parts[i]);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1], sha);
  }
  const write = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, sha] of node.files) entries.push({ mode: '100644', name, sha });
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, sha: write(dir) });
    return store.put('tree', buildTree(entries));
  };
  return write(root);
}

// --------------------------------------------------------------------------- commits and tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export function parseTagTarget(data: Buffer): string {
  const match = /^object ([0-9a-f]{40})$/m.exec(data.toString('utf8'));
  return match === null ? '' : match[1];
}

/** Peel any object to the commit it ultimately names (through tag objects), or null. */
export function peelToCommit(store: ObjectStore, sha: string): string | null {
  let current = sha;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTagTarget(object.data);
      continue;
    }
    return null;
  }
  return null;
}

/** Peel an annotated tag one level for advertisement `^{}` lines; non-tags answer themselves. */
export function peelOne(store: ObjectStore, sha: string): string | null {
  const object = store.get(sha);
  if (object === undefined) return null;
  if (object.type !== 'tag') return sha;
  return peelToCommit(store, sha);
}

// --------------------------------------------------------------------------- reachability

/**
 * Every object reachable from `roots`. Commits in `parentless` are included but their
 * parents are not followed (the shallow-fetch boundary rule).
 */
export function collectReachable(store: ObjectStore, roots: Iterable<string>, parentless: ReadonlySet<string> = new Set()): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...roots];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    const object = store.get(sha);
    if (object === undefined) continue;
    seen.add(sha);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (!parentless.has(sha)) for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.sha);
    } else if (object.type === 'tag') {
      const target = parseTagTarget(object.data);
      if (target !== '') stack.push(target);
    }
  }
  return seen;
}

/** All ancestors of a commit (including itself), following parents. */
export function commitAncestors(store: ObjectStore, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    const object = store.get(sha);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(sha);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return seen;
}

export function isAncestor(store: ObjectStore, ancestor: string, tip: string): boolean {
  return commitAncestors(store, tip).has(ancestor);
}

/** A merge base of two commits (nearest common ancestor by BFS from `b`), or null. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsOfA = commitAncestors(store, a);
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (ancestorsOfA.has(sha)) return sha;
    const object = store.get(sha);
    if (object !== undefined && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
  }
  return null;
}

// --------------------------------------------------------------------------- deltas

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { copyOffset |= delta[offset] << (8 * i); offset += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { copySize |= delta[offset] << (8 * i); offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

// --------------------------------------------------------------------------- packfiles

/** Serialize the named objects as a version-2 pack with no deltas. */
export function writePack(store: ObjectStore, shas: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'utf8');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(shas.length, 8);
  parts.push(header);
  for (const sha of shas) {
    const object = store.get(sha);
    if (object === undefined) continue;
    const typeCode = TYPE_CODES[object.type];
    let size = object.data.length;
    const first = (typeCode << 4) | (size & 0x0f);
    size >>= 4;
    const bytes: number[] = [];
    if (size === 0) {
      bytes.push(first);
    } else {
      bytes.push(first | 0x80);
      while (size > 0) {
        let byte = size & 0x7f;
        size >>= 7;
        if (size > 0) byte |= 0x80;
        bytes.push(byte);
      }
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

interface PackEntry {
  type: ObjType;
  data: Buffer;
  /** Byte offset of this object's header inside the pack (for OFS_DELTA bases). */
  offset: number;
}

/** Parse a pack into the store, resolving OFS/REF deltas. Answers the object count. */
export function readPack(store: ObjectStore, pack: Buffer): number {
  if (pack.length < 12 || pack.subarray(0, 4).toString('utf8') !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const byOffset = new Map<number, PackEntry>();
  const pendingRef: { base: string; delta: Buffer; offset: number }[] = [];

  const readObjectHeader = (at: number): { typeCode: number; size: number; next: number } => {
    let byte = pack[at];
    let next = at + 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[next];
      next += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    return { typeCode, size, next };
  };

  for (let i = 0; i < count; i += 1) {
    const start = offset;
    const { typeCode, next } = readObjectHeader(offset);
    offset = next;
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset varint names the base object in this pack.
      let byte = pack[offset];
      offset += 1;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset];
        offset += 1;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      const baseEntry = byOffset.get(start - back);
      const inflated = inflateSync(pack.subarray(offset));
      offset += compressedLength(pack, offset);
      if (baseEntry === undefined) throw new Error('ofs-delta base missing');
      const data = applyDelta(baseEntry.data, inflated);
      const entry: PackEntry = { type: baseEntry.type, data, offset: start };
      byOffset.set(start, entry);
      store.put(entry.type, entry.data);
    } else if (typeCode === 7) {
      // REF_DELTA: the base is named by sha, in this pack or already in the store.
      const baseSha = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateSync(pack.subarray(offset));
      offset += compressedLength(pack, offset);
      const baseEntry = [...byOffset.values()].find((entry) => hashObject(entry.type, entry.data) === baseSha) ?? (() => {
        const stored = store.get(baseSha);
        return stored === undefined ? undefined : { type: stored.type, data: stored.data, offset: -1 };
      })();
      if (baseEntry === undefined) {
        pendingRef.push({ base: baseSha, delta: inflated, offset: start });
        continue;
      }
      const data = applyDelta(baseEntry.data, inflated);
      const entry: PackEntry = { type: baseEntry.type, data, offset: start };
      byOffset.set(start, entry);
      store.put(entry.type, entry.data);
    } else {
      const type = CODE_TYPES[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const inflated = inflateSync(pack.subarray(offset));
      offset += compressedLength(pack, offset);
      const entry: PackEntry = { type, data: inflated, offset: start };
      byOffset.set(start, entry);
      store.put(entry.type, entry.data);
    }
  }
  for (const pending of pendingRef) {
    const stored = store.get(pending.base);
    if (stored === undefined) throw new Error('ref-delta base missing');
    store.put(stored.type, applyDelta(stored.data, pending.delta));
  }
  return count;
}

/** The compressed length of the zlib stream starting at `offset` (inflate and measure). */
function compressedLength(pack: Buffer, offset: number): number {
  // zlib streams are self-terminating; inflateSync ignores trailing bytes, so measure by
  // binary search on the smallest prefix that inflates cleanly.
  let lo = 1;
  let hi = pack.length - offset;
  // Fast path: most streams end well before the buffer does; grow exponentially first.
  let probe = Math.min(hi, 64);
  const inflates = (length: number): boolean => {
    try {
      inflateSync(pack.subarray(offset, offset + length));
      return true;
    } catch {
      return false;
    }
  };
  while (probe < hi && !inflates(probe)) probe = Math.min(hi, probe * 2);
  if (!inflates(probe)) return hi;
  lo = Math.max(1, Math.floor(probe / 2));
  hi = probe;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (inflates(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
