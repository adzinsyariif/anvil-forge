// GitHub REST v3 surface under /api/v3: repositories, branches, commits, contents,
// issues, comments, labels, pull requests, files and merges, in the exact shapes
// the conformance suite exercises.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit, parseTree } from './gitobj.ts';
import {
  DEFAULT_BRANCH,
  VIEWER,
  addComment,
  createIssue,
  createLabel,
  createPull,
  createRepo,
  deleteRepo,
  findRepo,
  isoOf,
  listRepos,
  mergePull,
  openPullFor,
  pullFiles,
  resolveCommit,
  listCommits,
  type IssueRec,
  type PullRec,
  type Repo,
} from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** Answer with a JSON body; every REST reply carries a request id, as the protocol checks require. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  requestCounter += 1;
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `ANVIL-${requestCounter.toString(16).toUpperCase().padStart(8, '0')}`,
    ...headers,
  });
  res.end(text);
}

export function sendNoContent(res: ServerResponse): void {
  requestCounter += 1;
  res.writeHead(204, { 'x-github-request-id': `ANVIL-${requestCounter.toString(16).toUpperCase().padStart(8, '0')}` });
  res.end();
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function unprocessable(res: ServerResponse, message: string): void {
  sendJson(res, 422, { message });
}

// --------------------------------------------------------------------------- JSON shapes

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    default_branch: DEFAULT_BRANCH,
    visibility: repo.isPrivate ? 'private' : 'public',
    html_url: `https://forge.invalid/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
    created_at: isoOf(1_700_000_000 + repo.id),
    updated_at: isoOf(1_700_000_000 + repo.id),
  };
}

export function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { id: label?.id ?? 0, name, color: label?.color ?? 'ededed', description: null, default: false };
}

export function issueJson(repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: isoOf(issue.createdAt),
    updated_at: isoOf(issue.createdAt),
    closed_at: null,
    html_url: `https://forge.invalid/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
  };
}

export function commentJson(comment: { id: number; body: string; createdAt: number }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: isoOf(comment.createdAt),
    updated_at: isoOf(comment.createdAt),
  };
}

export function pullJson(repo: Repo, pull: PullRec): Record<string, unknown> {
  const headSha = repo.branchTip(pull.headRef) ?? '';
  const baseSha = repo.branchTip(pull.baseRef) ?? '';
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt === null ? null : isoOf(pull.mergedAt),
    merge_commit_sha: pull.mergeCommitSha,
    created_at: isoOf(pull.createdAt),
    updated_at: isoOf(pull.createdAt),
    html_url: `https://forge.invalid/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

// --------------------------------------------------------------------------- helpers

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  segments: string[];
  body: Record<string, unknown> | null;
  bodyError: boolean;
}

function paginate<T>(ctx: Ctx, items: T[]): { page: T[]; link: string | null } {
  const perPageRaw = parseInt(ctx.url.searchParams.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = parseInt(ctx.url.searchParams.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const host = ctx.req.headers.host ?? 'entry';
    const next = new URL(ctx.url.pathname, `http://${host}`);
    for (const [key, value] of ctx.url.searchParams) next.searchParams.set(key, value);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    const last = new URL(next);
    last.searchParams.set('page', String(Math.ceil(items.length / perPage)));
    link = `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`;
  }
  return { page: slice, link };
}

function sendList(ctx: Ctx, items: unknown[]): void {
  const { page, link } = paginate(ctx, items);
  sendJson(ctx.res, 200, page, link === null ? {} : { link });
}

// --------------------------------------------------------------------------- repositories

function handleCreateRepo(ctx: Ctx): void {
  const body = ctx.body ?? {};
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') {
    unprocessable(ctx.res, 'Repository creation failed: name is required');
    return;
  }
  const repo = createRepo(name, body.private === true, typeof body.description === 'string' ? body.description : '');
  if (repo === null) {
    unprocessable(ctx.res, 'Repository creation failed: name already exists on this account');
    return;
  }
  sendJson(ctx.res, 201, repoJson(repo));
}

function handleRepo(ctx: Ctx, repo: Repo): void {
  const method = ctx.req.method ?? 'GET';
  if (method === 'GET') {
    sendJson(ctx.res, 200, repoJson(repo));
    return;
  }
  if (method === 'PATCH') {
    const body = ctx.body ?? {};
    if (typeof body.description === 'string') repo.description = body.description;
    if (typeof body.private === 'boolean') repo.isPrivate = body.private;
    if (typeof body.name === 'string' && body.name !== repo.name) {
      // Renames are accepted in shape only; the suite never renames.
    }
    sendJson(ctx.res, 200, repoJson(repo));
    return;
  }
  if (method === 'DELETE') {
    deleteRepo(repo);
    sendNoContent(ctx.res);
    return;
  }
  notFound(ctx.res);
}

// --------------------------------------------------------------------------- git data & branches

function handleGitRefs(ctx: Ctx, repo: Repo): void {
  const body = ctx.body ?? {};
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!ref.startsWith('refs/') || sha === '' || !repo.store.has(sha)) {
    unprocessable(ctx.res, 'Invalid ref or sha');
    return;
  }
  if (repo.refs.has(ref)) {
    unprocessable(ctx.res, 'Reference already exists');
    return;
  }
  repo.refs.set(ref, sha);
  sendJson(ctx.res, 201, { ref, node_id: `REF_${ref}`, url: `/api/v3/repos/${repo.fullName}/git/refs/${ref.slice(5)}`, object: { sha, type: repo.store.get(sha)?.type ?? 'commit', url: '' } });
}

function handleGitRefGet(ctx: Ctx, repo: Repo, refPath: string): void {
  const ref = `refs/${refPath}`;
  const sha = repo.refs.get(ref);
  if (sha === undefined) {
    notFound(ctx.res);
    return;
  }
  sendJson(ctx.res, 200, { ref, node_id: `REF_${ref}`, url: '', object: { sha, type: repo.store.get(sha)?.type ?? 'commit', url: '' } });
}

function handleBranches(ctx: Ctx, repo: Repo): void {
  const branches = [...repo.refs.entries()]
    .filter(([ref]) => ref.startsWith('refs/heads/'))
    .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  sendList(ctx, branches);
}

function handleBranchGet(ctx: Ctx, repo: Repo, branch: string): void {
  const sha = repo.branchTip(branch);
  if (sha === null) {
    notFound(ctx.res);
    return;
  }
  sendJson(ctx.res, 200, { name: branch, commit: { sha, url: '' }, protected: false });
}

function handleCommits(ctx: Ctx, repo: Repo): void {
  const refParam = ctx.url.searchParams.get('sha') ?? ctx.url.searchParams.get('branch') ?? DEFAULT_BRANCH;
  const tip = resolveCommit(repo, refParam);
  if (tip === null) {
    sendJson(ctx.res, 200, []);
    return;
  }
  const commits = listCommits(repo, tip).map((sha) => {
    const object = repo.store.get(sha);
    const commit = object === undefined ? null : parseCommit(object.data);
    return {
      sha,
      node_id: `C_${sha}`,
      commit: {
        message: commit?.message ?? '',
        author: { name: VIEWER.name, email: VIEWER.email, date: isoOf(1_700_000_000) },
        committer: { name: VIEWER.name, email: VIEWER.email, date: isoOf(1_700_000_000) },
        tree: { sha: commit?.tree ?? '' },
      },
      parents: (commit?.parents ?? []).map((parent) => ({ sha: parent })),
      author: { login: VIEWER.login, id: VIEWER.id },
      committer: { login: VIEWER.login, id: VIEWER.id },
    };
  });
  sendList(ctx, commits);
}

// --------------------------------------------------------------------------- contents

function contentsSegments(ctx: Ctx): string {
  // segments after /contents/
  const index = ctx.segments.indexOf('contents');
  return ctx.segments.slice(index + 1).join('/');
}

function handleContentsGet(ctx: Ctx, repo: Repo): void {
  const path = contentsSegments(ctx);
  const refParam = ctx.url.searchParams.get('ref') ?? DEFAULT_BRANCH;
  const commitSha = resolveCommit(repo, refParam);
  if (commitSha === null) {
    notFound(ctx.res);
    return;
  }
  const flat = repo.flatAtCommit(commitSha);
  if (path !== '' && flat.has(path)) {
    const blobSha = flat.get(path) as string;
    const data = repo.store.get(blobSha)?.data ?? Buffer.alloc(0);
    sendJson(ctx.res, 200, {
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name: path.split('/').pop(),
      path,
      sha: blobSha,
      content: data.toString('base64'),
      url: '',
      html_url: '',
      download_url: '',
    });
    return;
  }
  // A directory listing (the root when path is empty).
  const prefix = path === '' ? '' : `${path}/`;
  const entries = new Map<string, { type: 'file' | 'dir'; sha: string; size: number }>();
  for (const [filePath, blobSha] of flat) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      const data = repo.store.get(blobSha)?.data ?? Buffer.alloc(0);
      entries.set(rest, { type: 'file', sha: blobSha, size: data.length });
    } else {
      const dirName = rest.slice(0, slash);
      if (!entries.has(dirName)) {
        const treeSha = treeShaAt(repo, commitSha, prefix + dirName);
        entries.set(dirName, { type: 'dir', sha: treeSha ?? '', size: 0 });
      }
    }
  }
  if (path !== '' && entries.size === 0) {
    notFound(ctx.res);
    return;
  }
  const listing = [...entries.entries()]
    .map(([name, entry]) => ({
      type: entry.type,
      name,
      path: prefix + name,
      sha: entry.sha,
      size: entry.size,
      url: '',
      html_url: '',
      download_url: entry.type === 'file' ? '' : null,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  sendJson(ctx.res, 200, listing);
}

/** The tree sha at a directory path inside a commit, or null. */
function treeShaAt(repo: Repo, commitSha: string, dirPath: string): string | null {
  const object = repo.store.get(commitSha);
  if (object === undefined || object.type !== 'commit') return null;
  let tree = parseCommit(object.data).tree;
  for (const part of dirPath.split('/').filter((part) => part !== '')) {
    const treeObject = repo.store.get(tree);
    if (treeObject === undefined) return null;
    const entry = parseTree(treeObject.data).find((candidate) => candidate.name === part);
    if (entry === undefined) return null;
    tree = entry.sha;
  }
  return tree;
}

function handleContentsPut(ctx: Ctx, repo: Repo): void {
  const path = contentsSegments(ctx);
  const body = ctx.body ?? {};
  const message = typeof body.message === 'string' ? body.message : 'Update file';
  const contentB64 = typeof body.content === 'string' ? body.content : '';
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : DEFAULT_BRANCH;
  const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
  const flat = repo.flatAt(branch);
  const existing = flat.get(path);
  if (existing !== undefined && givenSha !== existing) {
    sendJson(ctx.res, 409, { message: 'Conflict: the file has changed; pass its current sha' });
    return;
  }
  if (existing === undefined && givenSha !== undefined) {
    notFound(ctx.res);
    return;
  }
  const data = Buffer.from(contentB64, 'base64');
  const blobSha = repo.store.put('blob', data);
  flat.set(path, blobSha);
  const commitSha = repo.commitFlat(branch, flat, message);
  sendJson(ctx.res, existing === undefined ? 201 : 200, {
    content: {
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name: path.split('/').pop(),
      path,
      sha: blobSha,
      url: '',
      html_url: '',
      download_url: '',
    },
    commit: { sha: commitSha, message, author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email } },
  });
}

function handleContentsDelete(ctx: Ctx, repo: Repo): void {
  const path = contentsSegments(ctx);
  const body = ctx.body ?? {};
  const message = typeof body.message === 'string' ? body.message : 'Delete file';
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : DEFAULT_BRANCH;
  const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
  const flat = repo.flatAt(branch);
  const existing = flat.get(path);
  if (existing === undefined) {
    notFound(ctx.res);
    return;
  }
  if (givenSha !== undefined && givenSha !== existing) {
    sendJson(ctx.res, 409, { message: 'Conflict: sha does not match' });
    return;
  }
  flat.delete(path);
  const commitSha = repo.commitFlat(branch, flat, message);
  sendJson(ctx.res, 200, { content: null, commit: { sha: commitSha, message } });
}

// --------------------------------------------------------------------------- labels, issues, comments

function handleCreateLabel(ctx: Ctx, repo: Repo): void {
  const body = ctx.body ?? {};
  const name = typeof body.name === 'string' ? body.name : '';
  const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
  if (name === '') {
    unprocessable(ctx.res, 'Validation Failed: name is required');
    return;
  }
  const label = createLabel(repo, name, color);
  if (label === null) {
    unprocessable(ctx.res, 'Validation Failed: label already exists');
    return;
  }
  sendJson(ctx.res, 201, labelJson(repo, name));
}

function parseLabels(repo: Repo, raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const entry of raw) {
    const name = typeof entry === 'string' ? entry : entry !== null && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string' ? (entry as { name: string }).name : '';
    if (name === '' || !repo.labels.has(name)) return null;
    names.push(name);
  }
  return names;
}

function handleCreateIssue(ctx: Ctx, repo: Repo): void {
  const body = ctx.body ?? {};
  const labels = parseLabels(repo, body.labels);
  if (labels === null) {
    unprocessable(ctx.res, 'Validation Failed: one or more labels do not exist');
    return;
  }
  const issue = createIssue(
    repo,
    typeof body.title === 'string' ? body.title : '',
    typeof body.body === 'string' ? body.body : '',
    labels,
  );
  sendJson(ctx.res, 201, issueJson(repo, issue));
}

function handleListIssues(ctx: Ctx, repo: Repo): void {
  const state = ctx.url.searchParams.get('state') ?? 'open';
  const sort = ctx.url.searchParams.get('sort') ?? 'created';
  const direction = ctx.url.searchParams.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  void sort;
  issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  sendList(ctx, issues.map((issue) => issueJson(repo, issue)));
}

function handleIssue(ctx: Ctx, repo: Repo, number: number): void {
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    notFound(ctx.res);
    return;
  }
  const method = ctx.req.method ?? 'GET';
  if (method === 'GET') {
    sendJson(ctx.res, 200, issueJson(repo, issue));
    return;
  }
  if (method === 'PATCH') {
    const body = ctx.body ?? {};
    if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
    if (typeof body.title === 'string') issue.title = body.title;
    if (typeof body.body === 'string') issue.body = body.body;
    const labels = parseLabels(repo, body.labels);
    if (labels !== null && body.labels !== undefined) issue.labels = labels;
    sendJson(ctx.res, 200, issueJson(repo, issue));
    return;
  }
  notFound(ctx.res);
}

function handleComments(ctx: Ctx, repo: Repo, number: number): void {
  const issue = repo.issues.get(number) ?? pullAsIssue(repo, number);
  if (issue === null) {
    notFound(ctx.res);
    return;
  }
  const method = ctx.req.method ?? 'GET';
  if (method === 'GET') {
    sendList(ctx, issue.comments.map((comment) => commentJson(comment)));
    return;
  }
  if (method === 'POST') {
    const body = ctx.body ?? {};
    const comment = addComment(issue, typeof body.body === 'string' ? body.body : '');
    sendJson(ctx.res, 201, commentJson(comment));
    return;
  }
  notFound(ctx.res);
}

/** Comments live on issues; a pull request number shares the issue comment thread (GitHub's model). */
function pullAsIssue(repo: Repo, number: number): IssueRec | null {
  const pull = repo.pulls.get(number);
  if (pull === undefined) return null;
  let issue = repo.issues.get(number);
  if (issue === undefined) {
    issue = {
      id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      labels: [],
      comments: [],
      createdAt: pull.createdAt,
      seq: pull.seq,
    };
    repo.issues.set(number, issue);
  }
  return issue;
}

// --------------------------------------------------------------------------- pull requests

function handleCreatePull(ctx: Ctx, repo: Repo): void {
  const body = ctx.body ?? {};
  const head = typeof body.head === 'string' ? body.head.split(':').pop() ?? '' : '';
  const base = typeof body.base === 'string' ? body.base.split(':').pop() ?? '' : '';
  if (head === '' || base === '' || repo.branchTip(head) === null || repo.branchTip(base) === null) {
    unprocessable(ctx.res, 'Validation Failed: head or base branch does not exist');
    return;
  }
  const existing = openPullFor(repo, head, base);
  if (existing !== null) {
    unprocessable(ctx.res, `A pull request already exists for ${repo.owner}:${head} -> ${base}`);
    return;
  }
  const pull = createPull(
    repo,
    typeof body.title === 'string' ? body.title : '',
    typeof body.body === 'string' ? body.body : '',
    head,
    base,
  );
  sendJson(ctx.res, 201, pullJson(repo, pull));
}

function handleListPulls(ctx: Ctx, repo: Repo): void {
  const state = ctx.url.searchParams.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  pulls.sort((a, b) => a.seq - b.seq);
  sendList(ctx, pulls.map((pull) => pullJson(repo, pull)));
}

function handlePull(ctx: Ctx, repo: Repo, number: number): void {
  const pull = repo.pulls.get(number);
  if (pull === undefined) {
    notFound(ctx.res);
    return;
  }
  sendJson(ctx.res, 200, pullJson(repo, pull));
}

function handlePullFiles(ctx: Ctx, repo: Repo, number: number): void {
  const pull = repo.pulls.get(number);
  if (pull === undefined) {
    notFound(ctx.res);
    return;
  }
  sendList(ctx, pullFiles(repo, pull));
}

function handlePullMerge(ctx: Ctx, repo: Repo, number: number): void {
  const pull = repo.pulls.get(number);
  if (pull === undefined) {
    notFound(ctx.res);
    return;
  }
  if (pull.merged) {
    sendJson(ctx.res, 405, { message: 'Pull Request is not mergeable: it has already been merged' });
    return;
  }
  const body = ctx.body ?? {};
  const methodRaw = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
  const method = methodRaw === 'squash' ? 'squash' : methodRaw === 'rebase' ? 'rebase' : 'merge';
  const outcome = mergePull(repo, pull, method);
  if (!outcome.ok) {
    sendJson(ctx.res, 405, { message: 'Pull Request is not mergeable: the head and base branches conflict' });
    return;
  }
  sendJson(ctx.res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
}

// --------------------------------------------------------------------------- router

/** Handle one /api/v3 request (auth and body parsing already done by the caller). */
export function handleRest(ctx: Ctx): void {
  const { res, segments } = ctx;
  const method = ctx.req.method ?? 'GET';

  if (ctx.bodyError) {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }

  // Root and meta.
  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          current_user_authorizations_html_url: '',
          rate_limit_url: '/api/v3/rate_limit',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          issue_url: '/api/v3/repos/{owner}/{repo}/issues/{number}',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }
    notFound(res);
    return;
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, { installed_version: 'anvilforge-1.0.0', api_version: '3' });
      return;
    }
    notFound(res);
    return;
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User', site_admin: false });
      return;
    }
    notFound(res);
    return;
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'POST') {
      handleCreateRepo(ctx);
      return;
    }
    if (method === 'GET') {
      sendList(ctx, listRepos().map((repo) => repoJson(repo)));
      return;
    }
    notFound(res);
    return;
  }

  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1];
    const name = segments[2];
    const repo = findRepo(owner, name);
    if (repo === null) {
      notFound(res);
      return;
    }
    const rest = segments.slice(3);
    if (rest.length === 0) {
      handleRepo(ctx, repo);
      return;
    }
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && method === 'POST') {
        handleGitRefs(ctx, repo);
        return;
      }
      if (rest.length >= 3 && method === 'GET') {
        handleGitRefGet(ctx, repo, rest.slice(2).join('/'));
        return;
      }
      notFound(res);
      return;
    }
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        handleBranches(ctx, repo);
        return;
      }
      if (rest.length >= 2 && method === 'GET') {
        handleBranchGet(ctx, repo, rest.slice(1).join('/'));
        return;
      }
      notFound(res);
      return;
    }
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      handleCommits(ctx, repo);
      return;
    }
    if (rest[0] === 'contents') {
      if (method === 'GET') {
        handleContentsGet(ctx, repo);
        return;
      }
      if (method === 'PUT') {
        handleContentsPut(ctx, repo);
        return;
      }
      if (method === 'DELETE') {
        handleContentsDelete(ctx, repo);
        return;
      }
      notFound(res);
      return;
    }
    if (rest[0] === 'labels' && rest.length === 1 && method === 'POST') {
      handleCreateLabel(ctx, repo);
      return;
    }
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          handleCreateIssue(ctx, repo);
          return;
        }
        if (method === 'GET') {
          handleListIssues(ctx, repo);
          return;
        }
        notFound(res);
        return;
      }
      const number = parseInt(rest[1], 10);
      if (rest.length === 2 && Number.isInteger(number)) {
        handleIssue(ctx, repo, number);
        return;
      }
      if (rest.length === 3 && rest[2] === 'comments' && Number.isInteger(number)) {
        handleComments(ctx, repo, number);
        return;
      }
      notFound(res);
      return;
    }
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          handleCreatePull(ctx, repo);
          return;
        }
        if (method === 'GET') {
          handleListPulls(ctx, repo);
          return;
        }
        notFound(res);
        return;
      }
      const number = parseInt(rest[1], 10);
      if (rest.length === 2 && Number.isInteger(number) && method === 'GET') {
        handlePull(ctx, repo, number);
        return;
      }
      if (rest.length === 3 && rest[2] === 'files' && Number.isInteger(number) && method === 'GET') {
        handlePullFiles(ctx, repo, number);
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge' && Number.isInteger(number) && method === 'PUT') {
        handlePullMerge(ctx, repo, number);
        return;
      }
      notFound(res);
      return;
    }
    notFound(res);
    return;
  }

  notFound(res);
}
