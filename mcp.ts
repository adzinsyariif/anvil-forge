// Model Context Protocol over streamable HTTP at POST /mcp: the modern server/discover
// revision and the legacy initialize handshake, tools/list and tools/call over the same
// forge state the REST surface serves.

import {
  VIEWER,
  createIssue,
  createPull,
  createRepo,
  findRepo,
  listRepos,
  mergePull,
  openPullFor,
  type Repo,
} from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'anvilforge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Record<string, unknown>;
}

function stringProp(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

function toolResult(value: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function needString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function repoOf(args: Record<string, unknown>): Repo | null {
  const owner = needString(args, 'owner');
  const repo = needString(args, 'repo');
  if (owner === null || repo === null) return null;
  return findRepo(owner, repo);
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: stringProp('The repository name'),
        description: stringProp('A short description of the repository'),
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
    run: (args) => {
      const name = needString(args, 'name');
      if (name === null) return toolError('create_repo requires a name');
      const existing = findRepo(VIEWER.login, name);
      if (existing !== null) return toolResult(repoJson(existing));
      const repo = createRepo(name, args.private === true, typeof args.description === 'string' ? args.description : '');
      if (repo === null) return toolError(`repository ${name} already exists`);
      return toolResult(repoJson(repo));
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: stringProp('The repository owner login'), repo: stringProp('The repository name') },
      required: ['owner', 'repo'],
    },
    run: (args) => {
      const repo = repoOf(args);
      if (repo === null) return toolError('repository not found');
      return toolResult(repoJson(repo));
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    inputSchema: { type: 'object', properties: {} },
    run: () => toolResult({ repositories: listRepos().map((repo) => repoJson(repo)) }),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login'),
        repo: stringProp('The repository name'),
        title: stringProp('The issue title'),
        body: stringProp('The issue body'),
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (args) => {
      const repo = repoOf(args);
      const title = needString(args, 'title');
      if (repo === null) return toolError('repository not found');
      if (title === null) return toolError('create_issue requires a title');
      const issue = createIssue(repo, title, typeof args.body === 'string' ? args.body : '', []);
      return toolResult(issueJson(repo, issue));
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login'),
        repo: stringProp('The repository name'),
        state: stringProp('open, closed or all'),
      },
      required: ['owner', 'repo'],
    },
    run: (args) => {
      const repo = repoOf(args);
      if (repo === null) return toolError('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()].sort((a, b) => a.seq - b.seq);
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      return toolResult({ issues: issues.map((issue) => issueJson(repo, issue)) });
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login'),
        repo: stringProp('The repository name'),
        issue_number: { type: 'number', description: 'The issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
    run: (args) => {
      const repo = repoOf(args);
      if (repo === null) return toolError('repository not found');
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) return toolError('issue not found');
      return toolResult(issueJson(repo, issue));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login'),
        repo: stringProp('The repository name'),
        title: stringProp('The pull request title'),
        body: stringProp('The pull request body'),
        head: stringProp('The head branch name'),
        base: stringProp('The base branch name'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (args) => {
      const repo = repoOf(args);
      if (repo === null) return toolError('repository not found');
      const title = needString(args, 'title');
      const head = needString(args, 'head');
      const base = needString(args, 'base');
      if (title === null || head === null || base === null) return toolError('create_pull_request requires title, head and base');
      if (repo.branchTip(head) === null || repo.branchTip(base) === null) return toolError('head or base branch does not exist');
      const existing = openPullFor(repo, head, base);
      if (existing !== null) return toolResult(pullJson(repo, existing));
      const pull = createPull(repo, title, typeof args.body === 'string' ? args.body : '', head, base);
      return toolResult(pullJson(repo, pull));
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login'),
        repo: stringProp('The repository name'),
        pull_number: { type: 'number', description: 'The pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (args) => {
      const repo = repoOf(args);
      if (repo === null) return toolError('repository not found');
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return toolError('pull request not found');
      if (pull.merged) return toolResult({ number: pull.number, merged: true, sha: pull.mergeCommitSha ?? '', state: pull.state });
      const outcome = mergePull(repo, pull, 'squash');
      if (!outcome.ok) return toolError('pull request is not mergeable');
      return toolResult({ number: pull.number, merged: true, sha: outcome.sha, state: pull.state });
    },
  },
];

const TOOL_LIST = TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));

export interface McpOutcome {
  status: number;
  body: unknown | null; // null answers an empty body (notifications)
}

/** Handle one POST /mcp body (already authenticated by the caller). */
export function handleMcp(rawBody: string): McpOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    const answers = parsed.map((entry) => handleOne(entry)).filter((answer) => answer !== null);
    return { status: 200, body: answers };
  }
  const answer = handleOne(parsed);
  if (answer === null) return { status: 202, body: null };
  return { status: 200, body: answer };
}

function handleOne(entry: unknown): Record<string, unknown> | null {
  if (entry === null || typeof entry !== 'object') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const request = entry as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
  const isNotification = request.id === undefined;
  if (isNotification) return null; // notifications are accepted silently
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = request.params ?? {};
  const ok = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result });
  const failWith = (code: number, message: string): Record<string, unknown> => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'server/discover':
      return ok({
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return ok({ protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOL_LIST });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (tool === undefined) return failWith(-32602, `unknown tool: ${name}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const schema = tool.inputSchema as { required?: string[] };
      const missing = (schema.required ?? []).filter((key) => args[key] === undefined || args[key] === '');
      if (missing.length > 0) return ok(toolError(`missing required arguments: ${missing.join(', ')}`));
      try {
        return ok(tool.run(args));
      } catch (err) {
        return ok(toolError(err instanceof Error ? err.message : 'tool failed'));
      }
    }
    default:
      return failWith(-32601, `method not found: ${method}`);
  }
}
