// The forge's data store: the token's owner, repositories (each with its
// own git object store and refs), and the REST resources that live on a
// repository — issues and pull requests sharing one number sequence,
// comments, labels. Everything is in memory; a trial starts empty and the
// suite builds what it needs through the API and git pushes.

import { ObjectStore } from './gitcore.ts';
import { SCENARIO_USERS, SCENARIO_ORG } from './scenario.ts';

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
  type: 'User' | 'Organization';
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
  default: boolean;
}

export interface Comment {
  id: number;
  user: User;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  user: User;
  labels: Label[];
  comments: Comment[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull?: PullData;
}

export interface PullData {
  headRef: string;   // ref name, e.g. 'feature' or 'owner:feature'
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  mergeable: boolean | null;
  draft: boolean;
}

export interface Repo {
  id: number;
  owner: User;
  name: string;
  description: string | null;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  store: ObjectStore;
  refs: Map<string, string>; // 'refs/heads/main' -> sha
  issues: Issue[];
  labels: Label[];
  nextIssueId: number;
  nextCommentId: number;
  nextLabelId: number;
}

export class Forge {
  owner: User;
  users = new Map<string, User>();
  repos = new Map<string, Repo>(); // 'owner/name' lowercased owner
  private nextRepoId = 10000;
  private nextUserId = 3000;
  seq = 0; // monotonic tiebreaker for equal timestamps

  constructor() {
    // The token's owner is the scenario's viewer (see scenario.ts); the
    // other scenario users and the org exist so ownership reads under
    // their logins resolve — and repos under them stay 404 until made.
    for (const su of SCENARIO_USERS) {
      this.users.set(su.login.toLowerCase(), { id: su.id, login: su.login, name: su.name, email: su.email, type: 'User' });
    }
    this.users.set(SCENARIO_ORG.toLowerCase(), { id: 900, login: SCENARIO_ORG, name: SCENARIO_ORG, email: `${SCENARIO_ORG}@example.invalid`, type: 'Organization' });
    this.owner = this.users.get(SCENARIO_USERS[0].login.toLowerCase()) as User;
  }

  user(login: string): User {
    const key = login.toLowerCase();
    let u = this.users.get(key);
    if (!u) {
      u = { id: this.nextUserId++, login, name: login, email: `${login}@example.invalid`, type: 'User' };
      this.users.set(key, u);
    }
    return u;
  }

  createRepo(ownerLogin: string, name: string, init: { description?: string | null; private?: boolean; defaultBranch?: string }): Repo {
    const owner = this.user(ownerLogin);
    const now = isoNow();
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description: init.description ?? null,
      private: init.private ?? false,
      default_branch: init.defaultBranch ?? 'main',
      created_at: now, updated_at: now, pushed_at: now,
      store: new ObjectStore(),
      refs: new Map(),
      issues: [],
      labels: [],
      nextIssueId: 1,
      nextCommentId: 1,
      nextLabelId: 1,
    };
    // Repositories are born with no labels: the suite creates the labels
    // it checks for (a POST of 'bug' to a fresh repo must answer 201).
    this.repos.set(`${owner.login.toLowerCase()}/${name.toLowerCase()}`, repo);
    return repo;
  }

  repo(ownerLogin: string, name: string): Repo | undefined {
    return this.repos.get(`${ownerLogin.toLowerCase()}/${name.toLowerCase()}`);
  }

  deleteRepo(ownerLogin: string, name: string): boolean {
    return this.repos.delete(`${ownerLogin.toLowerCase()}/${name.toLowerCase()}`);
  }

  reposOf(ownerLogin: string): Repo[] {
    const key = ownerLogin.toLowerCase();
    return [...this.repos.values()].filter((r) => r.owner.login.toLowerCase() === key);
  }
}

export function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** GraphQL-style global id: opaque, stable, and decodable by node(id:). */
export function globalId(type: string, dbId: number | string): string {
  return Buffer.from(`${type}:${dbId}`, 'utf8').toString('base64');
}
export function parseGlobalId(id: string): { type: string; dbId: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 1) return null;
    return { type: text.slice(0, colon), dbId: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ----- GitHub-shaped JSON serializers (REST v3) -----
export function userJson(u: User): Record<string, unknown> {
  return {
    login: u.login,
    id: u.id,
    node_id: globalId(u.type === 'Organization' ? 'Organization' : 'User', u.id),
    avatar_url: `https://avatars.githubusercontent.com/u/${u.id}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${u.login}`,
    html_url: `https://github.com/${u.login}`,
    type: u.type,
    site_admin: false,
  };
}

export function labelJson(repo: Repo, l: Label): Record<string, unknown> {
  return {
    id: l.id,
    node_id: globalId('Label', `${repo.id}:${l.id}`),
    url: `/api/v3/repos/${repo.owner.login}/${repo.name}/labels/${encodeURIComponent(l.name)}`,
    name: l.name,
    color: l.color,
    default: l.default,
    description: l.description,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  const owner = repo.owner.login;
  const base = `/api/v3/repos/${owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.private,
    html_url: `https://github.com/${owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: base,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    git_url: `git://github.com/${owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${owner}/${repo.name}.git`,
    clone_url: `https://github.com/${owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.default_branch,
  };
}

export function commentJson(repo: Repo, issue: Issue, c: Comment): Record<string, unknown> {
  return {
    id: c.id,
    node_id: globalId('IssueComment', `${repo.id}:${issue.id}:${c.id}`),
    url: `/api/v3/repos/${repo.owner.login}/${repo.name}/issues/comments/${c.id}`,
    html_url: `https://github.com/${repo.owner.login}/${repo.name}/issues/${issue.number}#issuecomment-${c.id}`,
    body: c.body,
    user: userJson(c.user),
    created_at: c.created_at,
    updated_at: c.updated_at,
    author_association: 'OWNER',
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const base = `/api/v3/repos/${repo.owner.login}/${repo.name}/issues/${issue.number}`;
  const out: Record<string, unknown> = {
    id: issue.id,
    node_id: globalId(issue.pull ? 'PullRequest' : 'Issue', `${repo.id}:${issue.id}`),
    url: base,
    repository_url: `/api/v3/repos/${repo.owner.login}/${repo.name}`,
    labels_url: `${base}/labels{/name}`,
    comments_url: `${base}/comments`,
    events_url: `${base}/events`,
    html_url: `https://github.com/${repo.owner.login}/${repo.name}/${issue.pull ? 'pull' : 'issues'}/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userJson(issue.user),
    labels: issue.labels.map((l) => labelJson(repo, l)),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    active_lock_reason: null,
    comments: issue.comments.length,
    closed_at: issue.closed_at,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    author_association: 'OWNER',
  };
  if (issue.pull) {
    out.pull_request = {
      url: `/api/v3/repos/${repo.owner.login}/${repo.name}/pulls/${issue.number}`,
      html_url: `https://github.com/${repo.owner.login}/${repo.name}/pull/${issue.number}`,
      diff_url: `https://github.com/${repo.owner.login}/${repo.name}/pull/${issue.number}.diff`,
      patch_url: `https://github.com/${repo.owner.login}/${repo.name}/pull/${issue.number}.patch`,
      merged_at: issue.pull.merged_at,
    };
  }
  return out;
}
