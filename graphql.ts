// GitHub GraphQL v4 at POST /api/graphql: a small parser and executor covering exactly
// the documents the suite sends — viewer, repository, issues, pull requests, the mutation
// set, Relay node(id:), cursor pagination, introspection probes and operation batching.

import {
  DEFAULT_BRANCH,
  VIEWER,
  addComment,
  createIssue,
  createPull,
  findRepo,
  issuesByGlobalId,
  mergePull,
  openPullFor,
  pullFiles,
  pullMergeable,
  pullsByGlobalId,
  repos,
  type IssueRec,
  type PullRec,
  type Repo,
} from './store.ts';

// --------------------------------------------------------------------------- global ids

export function globalId(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

function decodeGlobalId(raw: string): { kind: string; id: number } | null {
  try {
    const text = Buffer.from(raw, 'base64').toString('utf8');
    const match = /^([A-Za-z]+):(\d+)$/.exec(text);
    if (match === null) return null;
    return { kind: match[1], id: parseInt(match[2], 10) };
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- tokenizer & parser

type Token = { kind: 'name' | 'string' | 'number' | 'punct' | 'spread'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:=@$!|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end === -1 ? source.length : end) });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      tokens.push({ kind: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string' | 'number' | 'boolean' | 'enum' | 'null'; value: string | number | boolean | null }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Map<string, Value>;
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition: string | null; selection: SelectionNode[] };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string | null; selection: SelectionNode[] }>;
}

class Parser {
  pos = 0;
  tokens: Token[];
  constructor(tokens: Token[]) { this.tokens = tokens; }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    if (token === undefined) throw new Error('unexpected end of document');
    return token;
  }

  expect(value: string): void {
    const token = this.next();
    if (token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  skipBalanced(open: string, close: string): void {
    this.expect(open);
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.value === open) depth += 1;
      else if (token.value === close) depth -= 1;
    }
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selection: SelectionNode[] }>();
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === undefined) break;
      if (token.value === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        let name: string | null = null;
        if (this.peek()?.kind === 'name') name = this.next().value;
        if (this.peek()?.value === '(') this.skipBalanced('(', ')');
        if (this.peek()?.value === '@') {
          this.next();
          this.next();
          if (this.peek()?.value === '(') this.skipBalanced('(', ')');
        }
        operations.push({ type: token.value === 'mutation' ? 'mutation' : 'query', name, selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.next().value;
        this.expect('on');
        const typeCondition = this.next().value;
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
      } else {
        this.next();
      }
    }
    return { operations, fragments };
  }

  parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek()?.value !== '}') {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'spread') {
        this.next();
        if (this.peek()?.kind === 'name' && this.peek()?.value === 'on') {
          this.next();
          const typeCondition = this.next().value;
          selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.next().value });
        }
        continue;
      }
      // A field, possibly aliased.
      let name = this.next().value;
      let alias: string | null = null;
      if (this.peek()?.value === ':') {
        this.next();
        alias = name;
        name = this.next().value;
      }
      const args = new Map<string, Value>();
      if (this.peek()?.value === '(') {
        this.next();
        while (this.peek()?.value !== ')') {
          const argName = this.next().value;
          this.expect(':');
          args.set(argName, this.parseValue());
        }
        this.expect(')');
      }
      if (this.peek()?.value === '@') {
        this.next();
        this.next();
        if (this.peek()?.value === '(') this.skipBalanced('(', ')');
      }
      let selection: SelectionNode[] | null = null;
      if (this.peek()?.value === '{') selection = this.parseSelectionSet();
      selections.push({ kind: 'field', field: { alias, name, args, selection } });
    }
    this.expect('}');
    return selections;
  }

  parseValue(): Value {
    const token = this.next();
    if (token.value === '$') {
      return { kind: 'variable', name: this.next().value };
    }
    if (token.value === '[') {
      const items: Value[] = [];
      while (this.peek()?.value !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token.value === '{') {
      const fields = new Map<string, Value>();
      while (this.peek()?.value !== '}') {
        const key = this.next().value;
        this.expect(':');
        fields.set(key, this.parseValue());
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, field] of value.fields) out[key] = resolveValue(field, variables);
      return out;
    }
  }
}

// --------------------------------------------------------------------------- typed values

interface Typed {
  __typename: string;
  [key: string]: unknown;
}

function typed(typename: string, props: Record<string, unknown>): Typed {
  return { __typename: typename, ...props };
}

const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'databaseId', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'isPrivate', 'description', 'url',
  ],
  Ref: ['name', 'target'],
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'labels', 'comments', 'author', 'repository', 'createdAt', 'updatedAt', 'url'],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'author', 'repository', 'createdAt', 'updatedAt', 'url', 'mergeCommit',
  ],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt'],
  Label: ['id', 'name', 'color'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  __Schema: ['queryType', 'mutationType', 'types'],
};

const TYPE_KINDS: Record<string, string> = {
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  Repository: 'OBJECT',
  User: 'OBJECT',
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  MergeableState: 'ENUM',
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

// --------------------------------------------------------------------------- resolvers

function repoTyped(repo: Repo): Typed {
  return typed('Repository', { repo });
}

function issueTyped(repo: Repo, issue: IssueRec): Typed {
  return typed('Issue', { repo, issue });
}

function pullTyped(repo: Repo, pull: PullRec): Typed {
  return typed('PullRequest', { repo, pull });
}

function cursorOf(kind: string, number: number): string {
  return Buffer.from(`${kind}:${number}`, 'utf8').toString('base64');
}

function issueConnection(repo: Repo, args: Map<string, unknown>): Typed {
  let issues = [...repo.issues.values()];
  const states = args.get('states');
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.get('orderBy') as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction === 'ASC' ? 'ASC' : 'DESC';
  issues.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq || a.number - b.number : b.seq - a.seq || b.number - a.number));
  return connection('IssueConnection', issues.map((issue) => issueTyped(repo, issue)), args, (node) => cursorOf('issue', (node.issue as IssueRec).number));
}

function pullConnection(repo: Repo, args: Map<string, unknown>): Typed {
  const pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
  return connection('PullRequestConnection', pulls.map((pull) => pullTyped(repo, pull)), args, (node) => cursorOf('pull', (node.pull as PullRec).number));
}

function connection(kind: string, allNodes: Typed[], args: Map<string, unknown>, cursorFor: (node: Typed) => string): Typed {
  let startIndex = 0;
  const after = args.get('after');
  if (typeof after === 'string' && after !== '') {
    const index = allNodes.findIndex((node) => cursorFor(node) === after);
    if (index >= 0) startIndex = index + 1;
  }
  const firstRaw = args.get('first');
  const first = typeof firstRaw === 'number' ? firstRaw : allNodes.length;
  const nodes = allNodes.slice(startIndex, startIndex + first);
  const hasNextPage = startIndex + nodes.length < allNodes.length;
  const endCursor = nodes.length > 0 ? cursorFor(nodes[nodes.length - 1]) : null;
  return typed(kind, {
    nodes,
    pageInfo: typed('PageInfo', { hasNextPage, hasPreviousPage: startIndex > 0, startCursor: nodes.length > 0 ? cursorFor(nodes[0]) : null, endCursor }),
    totalCount: allNodes.length,
    __nodes: nodes,
    __cursorFor: cursorFor,
  });
}

type Args = Map<string, unknown>;

function argsOf(field: FieldNode, variables: Record<string, unknown>): Args {
  const out = new Map<string, unknown>();
  for (const [key, value] of field.args) out.set(key, resolveValue(value, variables));
  return out;
}

interface ExecCtx {
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string | null; selection: SelectionNode[] }>;
  errors: { message: string }[];
}

function resolveField(typeName: string, source: Typed | null, field: FieldNode, ctx: ExecCtx): unknown {
  const args = argsOf(field, ctx.variables);
  const name = field.name;

  if (name === '__typename') return typeName;
  if (typeName === 'Query' || typeName === 'Mutation') return resolveRoot(typeName, name, args, ctx);
  if (source === null) return null;

  switch (typeName) {
    case 'User':
      if (name === 'login') return VIEWER.login;
      if (name === 'id') return globalId('User', VIEWER.id);
      if (name === 'databaseId') return VIEWER.id;
      if (name === 'name') return VIEWER.name;
      if (name === 'email') return VIEWER.email;
      break;
    case 'Repository': {
      const repo = source.repo as Repo;
      switch (name) {
        case 'id': return globalId('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return repo.fullName;
        case 'owner': return typed('User', {});
        case 'defaultBranchRef': {
          const tip = repo.branchTip(DEFAULT_BRANCH);
          return tip === null ? null : typed('Ref', { name: DEFAULT_BRANCH });
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'isPrivate': return repo.isPrivate;
        case 'description': return repo.description;
        case 'issue': {
          const issue = repo.issues.get(Number(args.get('number')));
          return issue === undefined ? null : issueTyped(repo, issue);
        }
        case 'issues': return issueConnection(repo, args);
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.get('number')));
          return pull === undefined ? null : pullTyped(repo, pull);
        }
        case 'pullRequests': return pullConnection(repo, args);
      }
      break;
    }
    case 'Ref':
      if (name === 'name') return source.name;
      break;
    case 'Issue': {
      const issue = source.issue as IssueRec;
      switch (name) {
        case 'id': return globalId('Issue', issue.id);
        case 'databaseId': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'repository': return repoTyped(source.repo as Repo);
        case 'author': return typed('User', {});
      }
      break;
    }
    case 'PullRequest': {
      const repo = source.repo as Repo;
      const pull = source.pull as PullRec;
      switch (name) {
        case 'id': return globalId('PullRequest', pull.id);
        case 'databaseId': return pull.id;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'mergeable': return pullMergeable(repo, pull);
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'repository': return repoTyped(repo);
        case 'author': return typed('User', {});
        case 'files': {
          const files = pullFiles(repo, pull).map((file) =>
            typed('PullRequestChangedFile', { path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status.toUpperCase() }),
          );
          return connection('PullRequestChangedFileConnection', files, args, (node) => cursorOf('file', files.indexOf(node)));
        }
      }
      break;
    }
    case 'IssueComment': {
      if (name === 'id') return globalId('IssueComment', source.commentId as number);
      if (name === 'databaseId') return source.commentId;
      if (name === 'body') return source.body;
      if (name === 'author') return typed('User', {});
      break;
    }
    case 'PageInfo':
      return source[name] ?? null;
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      if (name === 'nodes') return source.nodes;
      if (name === 'pageInfo') return source.pageInfo;
      if (name === 'totalCount') return source.totalCount;
      if (name === 'edges') {
        const cursorFor = source.__cursorFor as (node: Typed) => string;
        return (source.__nodes as Typed[]).map((node) => typed(typeName === 'IssueConnection' ? 'IssueEdge' : 'PullRequestEdge', { node, cursor: cursorFor(node) }));
      }
      break;
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
      return source[name] ?? null;
    case 'PullRequestChangedFile':
      return source[name] ?? null;
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
    case 'AddCommentPayload':
    case 'CommentEdge':
      return source[name] ?? null;
    case '__Type': {
      if (name === 'name') return source.typeName;
      if (name === 'kind') return TYPE_KINDS[source.typeName as string] ?? 'OBJECT';
      if (name === 'fields') {
        const fields = SCHEMA_FIELDS[source.typeName as string] ?? [];
        return fields.map((fieldName) => typed('__Field', { name: fieldName }));
      }
      if (name === 'enumValues') {
        const values = ENUM_VALUES[source.typeName as string] ?? [];
        return values.map((valueName) => typed('__EnumValue', { name: valueName }));
      }
      break;
    }
    case '__Field':
    case '__EnumValue':
      if (name === 'name') return source.name;
      return null;
  }
  return undefined; // signals "unknown field" to the executor
}

function resolveRoot(typeName: 'Query' | 'Mutation', name: string, args: Args, ctx: ExecCtx): unknown {
  if (name === '__type') {
    const typeNameArg = String(args.get('name') ?? '');
    if (!(typeNameArg in SCHEMA_FIELDS) && !(typeNameArg in ENUM_VALUES) && !(typeNameArg in TYPE_KINDS)) return null;
    return typed('__Type', { typeName: typeNameArg });
  }
  if (name === '__schema') return typed('__Schema', {});
  if (typeName === 'Query') {
    switch (name) {
      case 'viewer':
        return typed('User', {});
      case 'repository': {
        const repo = findRepo(String(args.get('owner') ?? ''), String(args.get('name') ?? ''));
        return repo === null ? null : repoTyped(repo);
      }
      case 'node': {
        const decoded = decodeGlobalId(String(args.get('id') ?? ''));
        if (decoded === null) return null;
        if (decoded.kind === 'Repository') {
          for (const repo of repos.values()) if (repo.id === decoded.id) return repoTyped(repo);
          return null;
        }
        if (decoded.kind === 'Issue') {
          const found = issuesByGlobalId.get(decoded.id);
          return found === undefined ? null : issueTyped(found.repo, found.issue);
        }
        if (decoded.kind === 'PullRequest') {
          const found = pullsByGlobalId.get(decoded.id);
          return found === undefined ? null : pullTyped(found.repo, found.pull);
        }
        return null;
      }
    }
    return undefined;
  }
  // Mutations.
  const input = (args.get('input') ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'createIssue': {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.kind !== 'Repository') {
        ctx.errors.push({ message: 'createIssue: repository not found' });
        return null;
      }
      let target: Repo | null = null;
      for (const repo of repos.values()) if (repo.id === decoded.id) target = repo;
      if (target === null) {
        ctx.errors.push({ message: 'createIssue: repository not found' });
        return null;
      }
      const issue = createIssue(target, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
      return typed('CreateIssuePayload', { issue: issueTyped(target, issue) });
    }
    case 'closeIssue': {
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      const found = decoded === null ? undefined : issuesByGlobalId.get(decoded.id);
      if (found === undefined) {
        ctx.errors.push({ message: 'closeIssue: issue not found' });
        return null;
      }
      found.issue.state = 'closed';
      return typed('CloseIssuePayload', { issue: issueTyped(found.repo, found.issue) });
    }
    case 'createPullRequest': {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      let target: Repo | null = null;
      if (decoded !== null && decoded.kind === 'Repository') {
        for (const repo of repos.values()) if (repo.id === decoded.id) target = repo;
      }
      if (target === null) {
        ctx.errors.push({ message: 'createPullRequest: repository not found' });
        return null;
      }
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const existing = openPullFor(target, head, base);
      const pull =
        existing ??
        createPull(target, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', head, base);
      return typed('CreatePullRequestPayload', { pullRequest: pullTyped(target, pull) });
    }
    case 'mergePullRequest': {
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      const found = decoded === null ? undefined : pullsByGlobalId.get(decoded.id);
      if (found === undefined) {
        ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
        return null;
      }
      if (!found.pull.merged) {
        const methodRaw = String(input.mergeMethod ?? 'MERGE').toLowerCase();
        const method = methodRaw === 'squash' ? 'squash' : methodRaw === 'rebase' ? 'rebase' : 'merge';
        const outcome = mergePull(found.repo, found.pull, method);
        if (!outcome.ok) ctx.errors.push({ message: 'mergePullRequest: the pull request is not mergeable' });
      }
      return typed('MergePullRequestPayload', { pullRequest: pullTyped(found.repo, found.pull) });
    }
    case 'addComment': {
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      const body = String(input.body ?? '');
      if (decoded !== null && decoded.kind === 'Issue') {
        const found = issuesByGlobalId.get(decoded.id);
        if (found !== undefined) {
          const comment = addComment(found.issue, body);
          const node = typed('IssueComment', { commentId: comment.id, body: comment.body });
          return typed('AddCommentPayload', { commentEdge: typed('CommentEdge', { node, cursor: cursorOf('comment', comment.id) }), subject: issueTyped(found.repo, found.issue) });
        }
      }
      if (decoded !== null && decoded.kind === 'PullRequest') {
        const found = pullsByGlobalId.get(decoded.id);
        if (found !== undefined) {
          // Comments on a pull request live on its issue thread.
          let issue = found.repo.issues.get(found.pull.number);
          if (issue === undefined) {
            issue = {
              id: found.pull.id, number: found.pull.number, title: found.pull.title, body: found.pull.body,
              state: found.pull.state, labels: [], comments: [], createdAt: found.pull.createdAt, seq: found.pull.seq,
            };
            found.repo.issues.set(issue.number, issue);
          }
          const comment = addComment(issue, body);
          const node = typed('IssueComment', { commentId: comment.id, body: comment.body });
          return typed('AddCommentPayload', { commentEdge: typed('CommentEdge', { node, cursor: cursorOf('comment', comment.id) }), subject: pullTyped(found.repo, found.pull) });
        }
      }
      ctx.errors.push({ message: 'addComment: subject not found' });
      return null;
    }
  }
  return undefined;
}

// --------------------------------------------------------------------------- execution

function executeSelection(typeName: string, source: Typed | null, selections: SelectionNode[], ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === null || fragment.typeCondition === typeName)) {
        Object.assign(out, executeSelection(typeName, source, fragment.selection, ctx));
      }
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, executeSelection(typeName, source, selection.selection, ctx));
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    const value = resolveField(typeName, source, field, ctx);
    if (value === undefined) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(value, field, ctx);
  }
  return out;
}

function completeValue(value: unknown, field: FieldNode, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, field, ctx));
  if (typeof value === 'object' && (value as Typed).__typename !== undefined) {
    const typedValue = value as Typed;
    if (field.selection === null) return typedValue;
    return executeSelection(typedValue.__typename, typedValue, field.selection, ctx);
  }
  return value;
}

/** Execute one GraphQL operation document; answers the {data, errors?} envelope. */
export function executeGraphQL(query: string, variables: Record<string, unknown>): { data: unknown; errors?: { message: string }[] } {
  let document: DocumentNode;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operation = document.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation in document' }] };
  const ctx: ExecCtx = { variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(rootType, null, operation.selection, ctx);
  const envelope: { data: unknown; errors?: { message: string }[] } = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}
