// The forge's in-memory state and the operations every surface (REST, GraphQL, MCP, git)
// shares. Everything is deterministic: ids come from sequence counters and timestamps from
// a logical clock seeded at a fixed epoch, never from the wall clock or randomness.

import {
  ObjectStore,
  buildCommit,
  buildTreeFromFlat,
  collectReachable,
  commitInfo,
  flattenTree,
  isAncestor,
  mergeBase,
  peelToCommit,
} from './gitobj.ts';

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export const DEFAULT_BRANCH = 'main';
const EPOCH_SEC = 1_700_000_000;

let logicalTick = 0;
/** The next deterministic timestamp (seconds since the epoch base), strictly increasing. */
export function nextTimestamp(): number {
  logicalTick += 1;
  return EPOCH_SEC + logicalTick * 60;
}

export function isoOf(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function gitIdent(seconds: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${seconds} +0000`;
}

export interface CommentRec {
  id: number;
  body: string;
  createdAt: number;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdAt: number;
  seq: number;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  createdAt: number;
  seq: number;
}

export interface LabelRec {
  id: number;
  name: string;
  color: string;
}

export class Repo {
  readonly store = new ObjectStore();
  readonly refs = new Map<string, string>(); // full ref name -> object sha
  readonly issues = new Map<number, IssueRec>();
  readonly pulls = new Map<number, PullRec>();
  readonly labels = new Map<string, LabelRec>();
  nextNumber = 1; // issues and pull requests share one counter, as on GitHub
  seq = 0;
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  isPrivate: boolean;
  description: string;

  constructor(id: number, owner: string, name: string, isPrivate: boolean, description: string) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.isPrivate = isPrivate;
    this.description = description;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  headRef(): string {
    return `refs/heads/${DEFAULT_BRANCH}`;
  }

  branchTip(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }

  tipTreeSha(branch: string): string | null {
    const tip = this.branchTip(branch);
    if (tip === null) return null;
    return commitInfo(this.store, tip)?.tree ?? null;
  }

  /** The flat path -> blob sha map at a branch tip (empty when unborn). */
  flatAt(branch: string): Map<string, string> {
    const tree = this.tipTreeSha(branch);
    return tree === null ? new Map() : flattenTree(this.store, tree);
  }

  /** The flat map at an arbitrary commit sha. */
  flatAtCommit(commitSha: string): Map<string, string> {
    const info = commitInfo(this.store, commitSha);
    if (info === null) return new Map();
    return flattenTree(this.store, info.tree);
  }

  /**
   * Commit a new flat file map on `branch`, creating the branch (from the default branch's
   * tip, or unborn) when it does not exist yet. Answers the new commit sha.
   */
  commitFlat(branch: string, flat: Map<string, string>, message: string): string {
    const treeSha = buildTreeFromFlat(this.store, flat);
    const parent = this.branchTip(branch) ?? (branch === DEFAULT_BRANCH ? null : this.branchTip(DEFAULT_BRANCH));
    const at = nextTimestamp();
    const commitSha = this.store.put(
      'commit',
      buildCommit({
        tree: treeSha,
        parents: parent === null ? [] : [parent],
        author: gitIdent(at),
        committer: gitIdent(at),
        message,
      }),
    );
    this.refs.set(`refs/heads/${branch}`, commitSha);
    return commitSha;
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }
}

// --------------------------------------------------------------------------- the forge

let nextRepoId = 5000;
let nextIssueId = 100_000;
let nextCommentId = 200_000;
let nextLabelId = 300_000;

export const repos = new Map<string, Repo>(); // "owner/name" -> Repo
export const issuesByGlobalId = new Map<number, { repo: Repo; issue: IssueRec }>();
export const pullsByGlobalId = new Map<number, { repo: Repo; pull: PullRec }>();

export function findRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return repos.get(`${owner}/${name}`) ?? null;
}

export function createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
  const key = `${VIEWER.login}/${name}`;
  if (repos.has(key)) return null;
  const repo = new Repo(nextRepoId, VIEWER.login, name, isPrivate, description);
  nextRepoId += 1;
  repos.set(key, repo);
  return repo;
}

export function deleteRepo(repo: Repo): void {
  repos.delete(repo.fullName);
  for (const issue of repo.issues.values()) issuesByGlobalId.delete(issue.id);
  for (const pull of repo.pulls.values()) pullsByGlobalId.delete(pull.id);
}

export function listRepos(): Repo[] {
  return [...repos.values()].sort((a, b) => a.id - b.id);
}

// --------------------------------------------------------------------------- issues & pulls

export function createIssue(repo: Repo, title: string, body: string, labels: string[]): IssueRec {
  const issue: IssueRec = {
    id: nextIssueId,
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    createdAt: nextTimestamp(),
    seq: repo.nextSeq(),
  };
  nextIssueId += 1;
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  issuesByGlobalId.set(issue.id, { repo, issue });
  return issue;
}

export function addComment(issue: IssueRec, body: string): CommentRec {
  const comment: CommentRec = { id: nextCommentId, body, createdAt: nextTimestamp() };
  nextCommentId += 1;
  issue.comments.push(comment);
  return comment;
}

export function createLabel(repo: Repo, name: string, color: string): LabelRec | null {
  if (repo.labels.has(name)) return null;
  const label: LabelRec = { id: nextLabelId, name, color };
  nextLabelId += 1;
  repo.labels.set(name, label);
  return label;
}

export function createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRec {
  const pull: PullRec = {
    id: nextIssueId,
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef,
    baseRef,
    createdAt: nextTimestamp(),
    seq: repo.nextSeq(),
  };
  nextIssueId += 1;
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  pullsByGlobalId.set(pull.id, { repo, pull });
  return pull;
}

/** An open pull request for the same head/base pair, if one exists. */
export function openPullFor(repo: Repo, headRef: string, baseRef: string): PullRec | null {
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef) return pull;
  }
  return null;
}

// --------------------------------------------------------------------------- merging

export type MergeOutcome =
  | { ok: true; sha: string }
  | { ok: false; reason: 'conflict' | 'unmergeable' };

/**
 * A file-level three-way merge of head into base over their merge base. When the two sides
 * changed the same path to different bytes the merge conflicts, exactly the case the suite
 * builds. On success the merged tree is committed on the base branch (squash shape: one
 * parent, the base tip; merge shape: both parents) and the commit sha answers.
 */
export function mergePull(repo: Repo, pull: PullRec, method: 'merge' | 'squash' | 'rebase'): MergeOutcome {
  const baseTip = repo.branchTip(pull.baseRef);
  const headTip = repo.branchTip(pull.headRef);
  if (baseTip === null || headTip === null) return { ok: false, reason: 'unmergeable' };
  const base = mergeBase(repo.store, baseTip, headTip) ?? baseTip;
  const origin = repo.flatAtCommit(base);
  const baseFlat = repo.flatAtCommit(baseTip);
  const headFlat = repo.flatAtCommit(headTip);
  const result = new Map<string, string>();
  const paths = new Set([...origin.keys(), ...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const o = origin.get(path);
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    if (h === b) {
      if (b !== undefined) result.set(path, b);
    } else if (o === b) {
      if (h !== undefined) result.set(path, h);
    } else if (o === h) {
      if (b !== undefined) result.set(path, b);
    } else {
      return { ok: false, reason: 'conflict' };
    }
  }
  const treeSha = buildTreeFromFlat(repo.store, result);
  const at = nextTimestamp();
  const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
  const message =
    method === 'merge'
      ? `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`
      : `${pull.title} (#${pull.number})`;
  const sha = repo.store.put(
    'commit',
    buildCommit({ tree: treeSha, parents, author: gitIdent(at), committer: gitIdent(at), message }),
  );
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = at;
  pull.mergeCommitSha = sha;
  return { ok: true, sha };
}

/** Whether a pull request would merge cleanly right now (GraphQL's mergeable). */
export function pullMergeable(repo: Repo, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.branchTip(pull.baseRef);
  const headTip = repo.branchTip(pull.headRef);
  if (baseTip === null || headTip === null) return 'UNKNOWN';
  if (isAncestor(repo.store, headTip, baseTip)) return 'MERGEABLE';
  const base = mergeBase(repo.store, baseTip, headTip);
  if (base === null) return 'UNKNOWN';
  const origin = repo.flatAtCommit(base);
  const baseFlat = repo.flatAtCommit(baseTip);
  const headFlat = repo.flatAtCommit(headTip);
  const paths = new Set([...origin.keys(), ...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const o = origin.get(path);
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    if (h !== b && o !== b && o !== h) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

/** Changed paths between the merge base of base/head and the head tip, with line counts. */
export function pullFiles(repo: Repo, pull: PullRec): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const baseTip = repo.branchTip(pull.baseRef);
  const headTip = repo.branchTip(pull.headRef);
  if (baseTip === null || headTip === null) return [];
  const base = mergeBase(repo.store, baseTip, headTip) ?? baseTip;
  const from = repo.flatAtCommit(base);
  const to = repo.flatAtCommit(headTip);
  const files: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  const paths = [...new Set([...from.keys(), ...to.keys()])].sort();
  for (const path of paths) {
    const before = from.get(path);
    const after = to.get(path);
    if (before === after) continue;
    const beforeText = before === undefined ? '' : (repo.store.get(before)?.data.toString('utf8') ?? '');
    const afterText = after === undefined ? '' : (repo.store.get(after)?.data.toString('utf8') ?? '');
    const { additions, deletions } = lineDiff(beforeText, afterText);
    files.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return files;
}

/** Line-level diff counts via a longest-common-subsequence over lines (files here are small). */
export function lineDiff(before: string, after: string): { additions: number; deletions: number } {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = dp[j];
      if (a[i - 1] === b[j - 1]) dp[j] = diagonal + 1;
      else dp[j] = Math.max(dp[j], dp[j - 1]);
      diagonal = above;
    }
  }
  const common = dp[b.length];
  return { additions: b.length - common, deletions: a.length - common };
}

/** Resolve a ref-ish (branch name, full ref, or sha) to a commit sha in this repo. */
export function resolveCommit(repo: Repo, ref: string): string | null {
  const byRef = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`);
  const candidate = byRef ?? ref;
  const peeled = peelToCommit(repo.store, candidate);
  return peeled;
}

/** Commits reachable from a tip, newest first (a stack walk; histories here are near-linear). */
export function listCommits(repo: Repo, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    const object = repo.store.get(sha);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(sha);
    order.push(sha);
    const parents = commitInfo(repo.store, sha)?.parents ?? [];
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
  }
  return order;
}

export { collectReachable };
