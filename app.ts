// AnvilForge: a GitHub-compatible git forge in one Node process, standard library only.
// app.ts wires the surfaces together — health probe, REST v3 (rest.ts), GraphQL v4
// (graphql.ts), MCP (mcp.ts) and git smart HTTP (githttp.ts) — over the shared in-memory
// state in store.ts. main.ts is the entry <-> env lifecycle and stays as the starter's.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest, sendJson } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGitRequest, readBody } from './githttp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The bearer token every surface expects: the env's MAKEFUN_SHOP_TOKEN. */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/**
 * Whether the request carries the token. With a token configured the match is exact;
 * without one (a local smoke run) any presented bearer token passes, a missing one does not.
 */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const expected = expectedToken();
  if (expected !== '') return header === `Bearer ${expected}`;
  return header.startsWith('Bearer ') && header.length > 'Bearer '.length;
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Bad credentials' });
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  if (Array.isArray(parsed)) {
    const answers = parsed.map((entry) => {
      const operation = entry as { query?: unknown; variables?: unknown };
      return executeGraphQL(
        typeof operation.query === 'string' ? operation.query : '',
        (operation.variables ?? {}) as Record<string, unknown>,
      );
    });
    const text = `${JSON.stringify(answers)}\n`;
    res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
    res.end(text);
    return;
  }
  const operation = parsed as { query?: unknown; variables?: unknown };
  const envelope = executeGraphQL(
    typeof operation.query === 'string' ? operation.query : '',
    (operation.variables ?? {}) as Record<string, unknown>,
  );
  sendJson(res, 200, envelope);
}

async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if ((req.method ?? 'POST') === 'DELETE') {
    res.writeHead(200, { 'content-type': JSON_TYPE });
    res.end('{}');
    return;
  }
  const raw = (await readBody(req)).toString('utf8');
  const outcome = handleMcp(raw);
  if (outcome.body === null) {
    res.writeHead(outcome.status, { 'content-type': JSON_TYPE, 'content-length': 0 });
    res.end();
    return;
  }
  const text = `${JSON.stringify(outcome.body)}\n`;
  res.writeHead(outcome.status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // The path is all routing needs; the parsed URL is built only for the REST branch,
  // whose handlers read query parameters. Slicing at '?' matches the URL parser's
  // pathname for the origin-form request targets the suite sends.
  const rawUrl = req.url ?? '/';
  const queryAt = rawUrl.indexOf('?');
  const pathname = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
  const method = req.method ?? 'GET';

  // The env's boot probe: no token, called twice.
  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // GraphQL v4.
  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      notFound(res);
      return;
    }
    if (!authorized(req)) {
      unauthorized(res);
      return;
    }
    await handleGraphQL(req, res);
    return;
  }

  // MCP over streamable HTTP.
  if (pathname === '/mcp') {
    if (!authorized(req)) {
      unauthorized(res);
      return;
    }
    await handleMcpRequest(req, res);
    return;
  }

  // REST v3.
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    const url = new URL(rawUrl, 'http://entry');
    const segments = pathname
      .replace(/^\/api\/v3\/?/, '')
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => (segment.includes('%') ? decodeURIComponent(segment) : segment));
    const isPublicRoot = segments.length === 0 || (segments.length === 1 && segments[0] === 'meta');
    if (!isPublicRoot && !authorized(req)) {
      unauthorized(res);
      return;
    }
    let body: Record<string, unknown> | null = null;
    let bodyError = false;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          const parsedBody: unknown = JSON.parse(raw.toString('utf8'));
          body = parsedBody !== null && typeof parsedBody === 'object' && !Array.isArray(parsedBody) ? (parsedBody as Record<string, unknown>) : {};
        } catch {
          bodyError = true;
        }
      }
    }
    handleRest({ req, res, url, segments, body, bodyError });
    return;
  }

  // git smart HTTP.
  if (pathname.includes('.git/')) {
    if (!authorized(req)) {
      unauthorized(res);
      return;
    }
    const handled = await handleGitRequest(req, res, pathname);
    if (!handled) notFound(res);
    return;
  }

  notFound(res);
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    route(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } else {
        res.end();
      }
    });
  });
}
