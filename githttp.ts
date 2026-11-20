// git smart HTTP: info/refs advertisement, git-upload-pack (protocol v2 with a v0
// fallback) and git-receive-pack (v0), all over the pure-Node object model in gitobj.ts.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  collectReachable,
  commitAncestors,
  commitInfo,
  isAncestor,
  peelOne,
  peelToCommit,
  readPack,
  writePack,
} from './gitobj.ts';
import { DEFAULT_BRANCH, findRepo, type Repo } from './store.ts';

const AGENT = 'anvilforge/1.0';

// --------------------------------------------------------------------------- pkt-lines

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

interface PktReader {
  lines: (Buffer | 'flush' | 'delim' | 'response-end')[];
  rest: Buffer;
}

export function readPkts(body: Buffer, start = 0): PktReader {
  const lines: PktReader['lines'] = [];
  let offset = start;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      lines.push('flush');
      offset += 4;
      break;
    }
    if (length === 1) {
      lines.push('delim');
      offset += 4;
      continue;
    }
    if (length === 2) {
      lines.push('response-end');
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) break;
    lines.push(body.subarray(offset + 4, offset + length));
    offset += length;
  }
  return { lines, rest: body.subarray(offset) };
}

/** Read every pkt-line in a command stream, keeping the trailing pack bytes aside. */
function readAllPkts(body: Buffer): { lines: (Buffer | 'flush' | 'delim')[]; rest: Buffer } {
  const lines: (Buffer | 'flush' | 'delim')[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      lines.push('flush');
      offset += 4;
      break;
    }
    if (length === 1) {
      lines.push('delim');
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) break;
    lines.push(body.subarray(offset + 4, offset + length));
    offset += length;
  }
  return { lines, rest: body.subarray(offset) };
}

// --------------------------------------------------------------------------- helpers

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headTarget(repo: Repo): string {
  return `refs/heads/${DEFAULT_BRANCH}`;
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'cache-control': 'no-cache' });
  res.end(body);
}

export function readBody(req: IncomingMessage, maxBytes = 128 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// --------------------------------------------------------------------------- info/refs

/** The v2 upload-pack advertisement names no repository state, so it is built once. */
const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  pktLine('# service=git-upload-pack\n'),
  PKT_FLUSH,
  pktLine('version 2\n'),
  pktLine(`agent=${AGENT}\n`),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow\n'),
  pktLine('object-format=sha1\n'),
  PKT_FLUSH,
]);

export function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo, service: string): void {
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  const preamble = pktLine(`# service=${service}\n`);
  if (service === 'git-upload-pack' && isV2) {
    sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', V2_ADVERTISEMENT);
    return;
  }
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow symref=HEAD:${headTarget(repo)} agent=${AGENT}`
      : `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;
  const lines: Buffer[] = [preamble, PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headSha = repo.refs.get(headTarget(repo));
  let first = true;
  const pushLine = (text: string): void => {
    if (first) {
      lines.push(pktLine(`${text}\0${caps}\n`));
      first = false;
    } else {
      lines.push(pktLine(`${text}\n`));
    }
  };
  if (refs.length === 0) {
    pushLine(`${ZERO_OID} capabilities^{}`);
  } else {
    if (headSha !== undefined) pushLine(`${headSha} HEAD`);
    for (const [ref, sha] of refs) {
      pushLine(`${sha} ${ref}`);
      if (ref.startsWith('refs/tags/')) {
        const peeled = peelOne(repo.store, sha);
        if (peeled !== null && peeled !== sha) pushLine(`${peeled} ${ref}^{}`);
      }
    }
  }
  lines.push(PKT_FLUSH);
  const type = service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
  sendBuffer(res, 200, type, Buffer.concat(lines));
}

// --------------------------------------------------------------------------- ls-refs (v2)

function handleLsRefs(repo: Repo, args: string[], res: ServerResponse): void {
  let peel = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const target = headTarget(repo);
  const headSha = repo.refs.get(target);
  if (matches('HEAD')) {
    if (headSha !== undefined) out.push(pktLine(`${headSha} HEAD symref-target:${target}\n`));
    else if (unborn) out.push(pktLine(`unborn HEAD symref-target:${target}\n`));
  }
  for (const [ref, sha] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${sha} ${ref}`;
    if (peel && ref.startsWith('refs/tags/')) {
      const peeled = peelOne(repo.store, sha);
      if (peeled !== null && peeled !== sha) line += ` peeled:${peeled}`;
    }
    out.push(pktLine(`${line}\n`));
  }
  out.push(PKT_FLUSH);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
}

// --------------------------------------------------------------------------- fetch core

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepen: number | null;
  done: boolean;
}

/**
 * The objects a fetch must deliver: everything reachable from the wants (with the shallow
 * boundary treated as parentless) that is not already reachable from the haves, plus the
 * shallow bookkeeping lines the client verifies.
 */
function planFetch(repo: Repo, request: FetchRequest): { objects: string[]; shallowLines: string[] } {
  const store = repo.store;
  const clientShallow = new Set(request.shallow);
  const parentless = new Set<string>(clientShallow);
  let shallowLines: string[] = [];

  const depth = request.deepen !== null ? request.deepen : request.depth;
  let includedCommits: Set<string> | null = null;
  if (depth !== null && depth > 0) {
    // BFS by generation from the wants.
    includedCommits = new Set<string>();
    let frontier = request.wants.map((want) => peelToCommit(store, want) ?? want);
    const boundary = new Set<string>();
    for (let level = 1; level <= depth; level += 1) {
      const next: string[] = [];
      for (const sha of frontier) {
        const info = commitInfo(store, sha);
        if (info === null) continue;
        if (includedCommits.has(sha)) continue;
        includedCommits.add(sha);
        const parents = info.parents;
        if (level === depth) {
          if (parents.length > 0) boundary.add(sha);
        } else {
          next.push(...parents);
        }
      }
      frontier = next;
    }
    for (const sha of boundary) parentless.add(sha);
    for (const sha of boundary) shallowLines.push(`shallow ${sha}`);
    for (const sha of clientShallow) {
      if (includedCommits.has(sha) && !boundary.has(sha)) shallowLines.push(`unshallow ${sha}`);
    }
  }

  const haveClosure = collectReachable(store, request.haves, clientShallow);
  let objects: string[];
  if (includedCommits !== null) {
    // A depth-bounded fetch: every included commit contributes itself and its whole tree;
    // the boundary commits' parents stay behind the shallow line. Building from the BFS
    // set (not from the wants) is what lets a deepen request expand a shallow want.
    const delivered = new Set<string>();
    for (const commitSha of includedCommits) {
      for (const sha of collectReachable(store, [commitSha], new Set([commitSha]))) delivered.add(sha);
    }
    // Tags naming an included commit travel with it.
    for (const want of request.wants) {
      if (!includedCommits.has(want)) {
        for (const sha of collectReachable(store, [want], parentless)) delivered.add(sha);
      }
    }
    objects = [...delivered].filter((sha) => !haveClosure.has(sha));
  } else {
    const wantClosure = collectReachable(store, request.wants, parentless);
    objects = [...wantClosure].filter((sha) => !haveClosure.has(sha));
  }
  // Commits first, then trees, then blobs: a stable, parent-before-child friendly order.
  const rank = (sha: string): number => {
    const type = store.get(sha)?.type;
    return type === 'commit' ? 0 : type === 'tag' ? 1 : type === 'tree' ? 2 : 3;
  };
  objects.sort((a, b) => rank(a) - rank(b));
  return { objects, shallowLines };
}

// --------------------------------------------------------------------------- fetch response cache

/**
 * A fetch answer is a pure function of the request and the object graph: objects are
 * content-addressed and immutable, and the closure reachable from a commit is fixed by its
 * hash, so an answer built while every want exists stays correct for that request. The
 * clone workload asks for the same depth-1 pack fifty times in parallel; building it once
 * serves them all. The cache is per repository object, so a deleted repository takes its
 * answers with it, and it is cleared rather than grown past FETCH_CACHE_MAX entries.
 */
const fetchResponses = new WeakMap<Repo, Map<string, Buffer>>();
const FETCH_CACHE_MAX = 128;

function fetchKey(variant: string, request: FetchRequest, sideband: boolean): string {
  return [
    variant,
    sideband ? 'sb' : 'raw',
    `w=${request.wants.join(',')}`,
    `h=${request.haves.join(',')}`,
    `s=${request.shallow.join(',')}`,
    `d=${request.depth ?? ''}`,
    `e=${request.deepen ?? ''}`,
  ].join('|');
}

function cachedFetch(repo: Repo, key: string, build: () => Buffer): Buffer {
  let cache = fetchResponses.get(repo);
  if (cache === undefined) {
    cache = new Map<string, Buffer>();
    fetchResponses.set(repo, cache);
  }
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const built = build();
  if (cache.size >= FETCH_CACHE_MAX) cache.clear();
  cache.set(key, built);
  return built;
}

function packResponse(repo: Repo, request: FetchRequest, sideband: boolean): Buffer {
  const { objects, shallowLines } = planFetch(repo, request);
  const pack = writePack(repo.store, objects);
  const out: Buffer[] = [];
  if (shallowLines.length > 0) {
    out.push(pktLine('shallow-info\n'));
    for (const line of shallowLines) out.push(pktLine(`${line}\n`));
    out.push(PKT_DELIM);
  }
  out.push(pktLine('packfile\n'));
  if (sideband) {
    const CHUNK = 32768;
    for (let offset = 0; offset < pack.length; offset += CHUNK) {
      const slice = pack.subarray(offset, offset + CHUNK);
      const band = Buffer.concat([Buffer.from([1]), slice]);
      out.push(pktLine(band));
    }
    if (pack.length === 0) out.push(pktLine(Buffer.from([1])));
  } else {
    out.push(pack);
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

// --------------------------------------------------------------------------- upload-pack v2

export async function handleUploadPackV2(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  const { lines } = readAllPkts(body);
  const texts = lines.filter((line): line is Buffer => Buffer.isBuffer(line)).map((line) => line.toString('utf8').replace(/\n$/, ''));
  const command = texts.find((text) => text.startsWith('command='));
  if (command === 'command=ls-refs') {
    const delimIndex = lines.findIndex((line) => line === 'delim');
    const args = texts.slice(1);
    void delimIndex;
    handleLsRefs(repo, args, res);
    return;
  }
  if (command === 'command=fetch') {
    const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, deepen: null, done: false };
    for (const text of texts.slice(1)) {
      if (text.startsWith('want ')) request.wants.push(text.slice(5).trim());
      else if (text.startsWith('have ')) request.haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) request.shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) request.deepen = parseInt(text.slice(7), 10);
      else if (text.startsWith('deepen-since ') || text.startsWith('deepen-not ')) request.deepen = request.deepen ?? 1;
      else if (text === 'done') request.done = true;
    }
    // A depth-only request names its depth in the args before the delim as `deepen`.
    for (const text of texts.slice(1)) {
      if (text.startsWith('deepen ')) request.depth = request.depth ?? parseInt(text.slice(7), 10);
    }
    if (!request.done) {
      // Negotiation round: acknowledge the haves we hold and say we are ready.
      const out: Buffer[] = [pktLine('acknowledgments\n')];
      let any = false;
      for (const have of request.haves) {
        if (repo.store.has(have)) {
          out.push(pktLine(`ACK ${have}\n`));
          any = true;
        }
      }
      if (!any) out.push(pktLine('NAK\n'));
      else out.push(pktLine('ready\n'));
      out.push(PKT_DELIM);
      out.push(PKT_RESPONSE_END);
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
      return;
    }
    const body = request.wants.every((want) => repo.store.has(want))
      ? cachedFetch(repo, fetchKey('v2', request, true), () => packResponse(repo, request, true))
      : packResponse(repo, request, true);
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', body);
    return;
  }
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', PKT_FLUSH);
}

// --------------------------------------------------------------------------- upload-pack v0

export async function handleUploadPackV0(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  const { lines } = readAllPkts(body);
  const texts = lines.filter((line): line is Buffer => Buffer.isBuffer(line)).map((line) => line.toString('utf8').replace(/\n$/, ''));
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, deepen: null, done: false };
  let sideband = false;
  for (const text of texts) {
    if (text.startsWith('want ')) {
      const rest = text.slice(5);
      const space = rest.indexOf(' ');
      request.wants.push((space === -1 ? rest : rest.slice(0, space)).trim());
      if (rest.includes('side-band-64k') || rest.includes('side-band')) sideband = true;
    } else if (text.startsWith('have ')) request.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) request.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      request.depth = parseInt(text.slice(7), 10);
      request.deepen = request.depth;
    } else if (text === 'done') request.done = true;
  }
  const build = (): Buffer => {
    const { objects, shallowLines } = planFetch(repo, request);
    const pack = writePack(repo.store, objects);
    const out: Buffer[] = [];
    for (const line of shallowLines) {
      const [kind, sha] = line.split(' ');
      out.push(pktLine(`${kind} ${sha}\n`));
    }
    out.push(pktLine('NAK\n'));
    if (sideband) {
      const CHUNK = 32768;
      for (let offset = 0; offset < pack.length; offset += CHUNK) {
        out.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + CHUNK)])));
      }
    } else {
      out.push(pack);
    }
    out.push(PKT_FLUSH);
    return Buffer.concat(out);
  };
  const answer = request.wants.every((want) => repo.store.has(want)) ? cachedFetch(repo, fetchKey('v0', request, sideband), build) : build();
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', answer);
}

// --------------------------------------------------------------------------- receive-pack

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
  caps: string;
}

export async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  const { lines, rest } = readAllPkts(body);
  const commands: RefCommand[] = [];
  let clientCaps = '';
  for (const line of lines) {
    if (!Buffer.isBuffer(line)) continue;
    const text = line.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const commandText = nul === -1 ? text : text.slice(0, nul);
    if (nul !== -1 && clientCaps === '') clientCaps = text.slice(nul + 1);
    const parts = commandText.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' '), caps: clientCaps });
  }

  let unpackOk = true;
  let unpackError = '';
  if (rest.length >= 12 && rest.subarray(0, 4).toString('utf8') === 'PACK') {
    try {
      readPack(repo.store, rest);
    } catch (err) {
      unpackOk = false;
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  } else if (rest.length > 0 && commands.some((command) => command.newOid !== ZERO_OID)) {
    // Commands that create/update need their pack; a missing one is an unpack failure.
    unpackOk = false;
    unpackError = 'pack missing';
  }

  const report: string[] = [];
  report.push(unpackOk ? 'unpack ok\n' : `unpack ${unpackError}\n`);
  for (const command of commands) {
    const fail = (reason: string): void => {
      report.push(`ng ${command.ref} ${reason}\n`);
    };
    if (!unpackOk) {
      fail('unpacker error');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      fail('stale info');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      report.push(`ok ${command.ref}\n`);
      continue;
    }
    const object = repo.store.get(command.newOid);
    if (object === undefined) {
      fail('missing object');
      continue;
    }
    if (command.oldOid !== ZERO_OID) {
      // Branch updates must be fast-forward; tag moves are free.
      if (command.ref.startsWith('refs/heads/')) {
        const oldCommit = peelToCommit(repo.store, command.oldOid);
        const newCommit = peelToCommit(repo.store, command.newOid);
        if (oldCommit === null || newCommit === null || !isAncestor(repo.store, oldCommit, newCommit)) {
          fail('non-fast-forward');
          continue;
        }
      }
    }
    repo.refs.set(command.ref, command.newOid);
    report.push(`ok ${command.ref}\n`);
  }

  const wantsReport = clientCaps.includes('report-status');
  const wantsSideband = clientCaps.includes('side-band-64k') || clientCaps.includes('side-band');
  const out: Buffer[] = [];
  if (wantsReport) {
    const reportBytes = Buffer.concat(report.map((line) => pktLine(line)));
    const stream = Buffer.concat([reportBytes, PKT_FLUSH]);
    if (wantsSideband) {
      const CHUNK = 32768;
      for (let offset = 0; offset < stream.length; offset += CHUNK) {
        out.push(pktLine(Buffer.concat([Buffer.from([1]), stream.subarray(offset, offset + CHUNK)])));
      }
    } else {
      out.push(stream);
    }
  }
  out.push(PKT_FLUSH);
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(out));
}

/** Route one git smart-HTTP request. Answers false when the path is not a git path. */
export async function handleGitRequest(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  const match = /^\/([^/]+)\/(.+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (match === null) return false;
  const owner = decodeURIComponent(match[1]);
  const name = decodeURIComponent(match[2]);
  const repo = findRepo(owner, name);
  if (repo === null) return false; // the caller answers the JSON 404 (missing repo included)
  const route = match[3];
  if (route === 'info/refs') {
    const url = new URL(req.url ?? '/', 'http://entry');
    const service = url.searchParams.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return false;
    handleInfoRefs(req, res, repo, service);
    return true;
  }
  if (route === 'git-upload-pack') {
    const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    if (isV2) await handleUploadPackV2(req, res, repo);
    else await handleUploadPackV0(req, res, repo);
    return true;
  }
  await handleReceivePack(req, res, repo);
  return true;
}

export { commitAncestors };
