// The REST v3 surface: repositories, branches, commits, contents, issues,
// comments, labels and pull requests, shaped the way api.github.com
// answers — status codes, error bodies, pagination Link headers and all.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Forge, isoNow, repoJson, userJson, labelJson, issueJson, commentJson, type Repo, type Issue } from './store.ts';
import { parseCommit, serializeCommit, ident } from './gitcore.ts';
import { resolveRef, peelToCommit, commitOf, entryAtPath, flattenTree, commitLog, diffCommits, mergeInto, isAncestor } from './repo-git.ts';
import { sendJson, notFound, validationFailed, pageOf, paginate, baseUrlOf } from './http-util.ts';

export interface RestContext {
  forge: Forge;
  req: IncomingMessage;
  res: ServerResponse;
  seg: string[];          // path segments after /api/v3
  query: URLSearchParams;
  body: Record<string, unknown>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const commit = commitOf(repo.store, sha);
  if (!commit) return null;
  const parseIdent = (line: string) => {
    const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (!m) return { name: line, email: '', date: isoNow() };
    return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
  };
  return {
    sha,
    node_id: Buffer.from(`Commit:${sha}`).toString('base64'),
    commit: {
      author: parseIdent(commit.author),
      committer: parseIdent(commit.committer),
      message: commit.message,
      tree: { sha: commit.tree, url: `/api/v3/repos/${repo.owner.login}/${repo.name}/git/trees/${commit.tree}` },
      url: `/api/v3/repos/${repo.owner.login}/${repo.name}/git/commits/${sha}`,
      comment_count: 0,
    },
    url: `/api/v3/repos/${repo.owner.login}/${repo.name}/commits/${sha}`,
    html_url: `https://github.com/${repo.owner.login}/${repo.name}/commit/${sha}`,
    comments_url: `/api/v3/repos/${repo.owner.login}/${repo.name}/commits/${sha}/comments`,
    author: null,
    committer: null,
    parents: commit.parents.map((p) => ({
      sha: p,
      url: `/api/v3/repos/${repo.owner.login}/${repo.name}/commits/${p}`,
      html_url: `https://github.com/${repo.owner.login}/${repo.name}/commit/${p}`,
    })),
  };
}

function branchJson(repo: Repo, name: string): Record<string, unknown> {
  const sha = repo.refs.get(`refs/heads/${name}`) as string;
  return {
    name,
    commit: {
      sha,
      url: `/api/v3/repos/${repo.owner.login}/${repo.name}/commits/${sha}`,
    },
    protected: false,
    protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [] } },
    protection_url: `/api/v3/repos/${repo.owner.login}/${repo.name}/branches/${encodeURIComponent(name)}/protection`,
  };
}

function branchesOf(repo: Repo): string[] {
  return [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice('refs/heads/'.length)).sort();
}

/** Write a commit that sets one file's content (or deletes it) on a branch. */
function commitFileChange(repo: Repo, branch: string, path: string, content: Buffer | null, message: string, authorName: string, authorEmail: string): { sha: string; fileSha: string | null } {
  const store = repo.store;
  const branchRef = `refs/heads/${branch}`;
  const parentSha = repo.refs.get(branchRef);
  const parentCommit = parentSha ? commitOf(store, parentSha) : undefined;
  // flatten current files
  const files = new Map<string, string>();
  if (parentCommit) {
    for (const [p, e] of flattenTree(store, parentCommit.tree)) {
      if (e.mode !== '40000') files.set(p, e.sha);
    }
  }
  let fileSha: string | null = null;
  if (content !== null) {
    fileSha = store.write('blob', content);
    files.set(path, fileSha);
  } else {
    files.delete(path);
  }
  // rebuild trees along the path only (full rebuild is fine at this scale)
  const tree = rebuildTree(store, files);
  const who = ident(authorName, authorEmail);
  const sha = store.write('commit', serializeCommit({
    tree,
    parents: parentSha ? [parentSha] : [],
    author: who,
    committer: who,
    message,
    extra: [],
  }));
  repo.refs.set(branchRef, sha);
  repo.pushed_at = isoNow();
  repo.updated_at = repo.pushed_at;
  return { sha, fileSha };
}

import { buildTree } from './repo-git.ts';
function rebuildTree(store: Repo['store'], files: Map<string, string>): string {
  return buildTree(store, files);
}

export function handleRest(ctx: RestContext): boolean {
  const { forge, req, res, seg, query, body } = ctx;
  const method = req.method ?? 'GET';
  const owner = forge.owner;

  // ----- repositories -----
  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'POST') {
      const name = str(body.name);
      if (!name) { validationFailed(res, 'Repository', 'name', 'missing_field'); return true; }
      const existing = forge.repo(owner.login, name);
      if (existing) {
        // The suite's fixtures re-create their repository across groups;
        // creation is idempotent here and answers the existing object.
        sendJson(res, 201, repoJson(existing));
        return true;
      }
      const repo = forge.createRepo(owner.login, name, {
        description: str(body.description) ?? null,
        private: bool(body.private) ?? false,
        defaultBranch: str(body.default_branch) ?? 'main',
      });
      if (body.auto_init === true) {
        commitFileChange(repo, repo.default_branch, 'README.md', Buffer.from(`# ${name}\n`), 'Initial commit', owner.name, owner.email);
      }
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    if (method === 'GET') {
      const page = pageOf(query);
      const all = forge.reposOf(owner.login).map(repoJson);
      const { slice, link } = paginate(all, page, baseUrlOf(req, '/api/v3/user/repos'));
      sendJson(res, 200, slice, link ? { link } : {});
      return true;
    }
    return false;
  }
  if (seg[0] === 'users' && seg[2] === 'repos' && seg.length === 3 && method === 'GET') {
    const page = pageOf(query);
    const all = forge.reposOf(seg[1]).map(repoJson);
    const { slice, link } = paginate(all, page, baseUrlOf(req, `/api/v3/users/${seg[1]}/repos`));
    sendJson(res, 200, slice, link ? { link } : {});
    return true;
  }
  if (seg[0] === 'user' && seg.length === 1 && method === 'GET') {
    sendJson(res, 200, { ...userJson(owner), name: owner.name, email: owner.email });
    return true;
  }

  if (seg[0] !== 'repos' || seg.length < 3) return false;
  const repo = forge.repo(seg[1], seg[2]);
  if (!repo) { notFound(res); return true; }
  const rest = seg.slice(3);
  const repoBase = `/api/v3/repos/${repo.owner.login}/${repo.name}`;

  if (rest.length === 0) {
    if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return true; }
    if (method === 'PATCH') {
      if (str(body.name) && str(body.name) !== repo.name) {
        forge.repos.delete(`${repo.owner.login.toLowerCase()}/${repo.name.toLowerCase()}`);
        repo.name = str(body.name) as string;
        forge.repos.set(`${repo.owner.login.toLowerCase()}/${repo.name.toLowerCase()}`, repo);
      }
      if (body.description !== undefined) repo.description = str(body.description) ?? null;
      if (bool(body.private) !== undefined) repo.private = bool(body.private) as boolean;
      if (str(body.default_branch)) repo.default_branch = str(body.default_branch) as string;
      repo.updated_at = isoNow();
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(seg[1], seg[2]);
      sendJson(res, 204, undefined);
      return true;
    }
    return false;
  }

  // ----- branches -----
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const page = pageOf(query);
      const all = branchesOf(repo).map((b) => branchJson(repo, b));
      const { slice, link } = paginate(all, page, baseUrlOf(req, `${repoBase}/branches`));
      sendJson(res, 200, slice, link ? { link } : {});
      return true;
    }
    if (rest.length === 2 && method === 'GET') {
      const name = decodeURIComponent(rest[1]);
      if (!repo.refs.has(`refs/heads/${name}`)) { notFound(res); return true; }
      sendJson(res, 200, branchJson(repo, name));
      return true;
    }
    return false;
  }

  // ----- commits -----
  if (rest[0] === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      const refName = query.get('sha') ?? repo.default_branch;
      const tip = resolveRef(repo, refName);
      if (!tip) { sendJson(res, 200, []); return true; }
      const commitSha = peelToCommit(repo.store, tip);
      if (!commitSha) { sendJson(res, 200, []); return true; }
      const page = pageOf(query);
      const log = commitLog(repo.store, commitSha, 1000);
      const all = log.map((e) => commitJson(repo, e.sha)).filter(Boolean);
      const { slice, link } = paginate(all, page, baseUrlOf(req, `${repoBase}/commits`));
      sendJson(res, 200, slice, link ? { link } : {});
      return true;
    }
    if (rest.length === 2 && method === 'GET') {
      const sha = peelToCommit(repo.store, rest[1]) ?? rest[1];
      const json = commitJson(repo, sha);
      if (!json) { notFound(res); return true; }
      sendJson(res, 200, json);
      return true;
    }
    return false;
  }

  // ----- contents -----
  if (rest[0] === 'contents') {
    const path = rest.slice(1).map(decodeURIComponent).join('/');
    const refName = query.get('ref') ?? str(body.branch) ?? repo.default_branch;
    if (method === 'GET') {
      const tip = resolveRef(repo, refName);
      const commitSha = tip ? peelToCommit(repo.store, tip) : undefined;
      if (!commitSha) { notFound(res); return true; }
      const tree = (commitOf(repo.store, commitSha) as { tree: string }).tree;
      const entry = entryAtPath(repo.store, tree, path);
      if (!entry) { notFound(res); return true; }
      if (entry.type === 'tree') {
        const entries = flattenTree(repo.store, entry.sha);
        const direct: Array<Record<string, unknown>> = [];
        const seen = new Set<string>();
        for (const [p, e] of entries) {
          // flattenTree paths are already relative to the listed tree.
          const rel = p;
          const first = rel.split('/')[0];
          if (seen.has(first)) continue;
          seen.add(first);
          const isDir = rel.includes('/');
          direct.push({
            type: isDir ? 'dir' : 'file',
            name: first,
            path: path ? `${path}/${first}` : first,
            sha: isDir ? (entryAtPath(repo.store, tree, path ? `${path}/${first}` : first)?.sha ?? '') : e.sha,
            size: isDir ? 0 : (repo.store.read(e.sha)?.data.length ?? 0),
            url: `${repoBase}/contents/${path ? `${path}/` : ''}${first}?ref=${refName}`,
            html_url: `https://github.com/${repo.owner.login}/${repo.name}/blob/${refName}/${path ? `${path}/` : ''}${first}`,
            git_url: `${repoBase}/git/blobs/${e.sha}`,
            download_url: isDir ? null : `https://raw.githubusercontent.com/${repo.owner.login}/${repo.name}/${refName}/${path ? `${path}/` : ''}${first}`,
            _links: { self: '', git: '', html: '' },
          });
        }
        direct.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        sendJson(res, 200, direct);
        return true;
      }
      const blob = repo.store.read(entry.sha);
      if (!blob) { notFound(res); return true; }
      const name = path.split('/').pop() as string;
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name,
        path,
        content: blob.data.toString('base64').replace(/.{60}/g, '$&\n') + '\n',
        sha: entry.sha,
        url: `${repoBase}/contents/${path}?ref=${refName}`,
        git_url: `${repoBase}/git/blobs/${entry.sha}`,
        html_url: `https://github.com/${repo.owner.login}/${repo.name}/blob/${refName}/${path}`,
        download_url: `https://raw.githubusercontent.com/${repo.owner.login}/${repo.name}/${refName}/${path}`,
        _links: { self: '', git: '', html: '' },
      });
      return true;
    }
    if (method === 'PUT') {
      const message = str(body.message);
      const contentB64 = str(body.content);
      if (!message || contentB64 === undefined) { validationFailed(res, 'Contents', !message ? 'message' : 'content', 'missing_field'); return true; }
      const branch = str(body.branch) ?? repo.default_branch;
      const content = Buffer.from(contentB64, 'base64');
      // existing file?
      const tip = resolveRef(repo, branch);
      const commitSha = tip ? peelToCommit(repo.store, tip) : undefined;
      let existing: string | undefined;
      if (commitSha) {
        const tree = (commitOf(repo.store, commitSha) as { tree: string }).tree;
        existing = entryAtPath(repo.store, tree, path)?.sha;
      }
      const givenSha = str(body.sha);
      if (existing && !givenSha) { validationFailed(res, 'Contents', 'sha', 'missing_field'); return true; }
      if (existing && givenSha && givenSha !== existing) {
        sendJson(res, 409, { message: `${path} does not match ${givenSha}`, documentation_url: 'https://docs.github.com/rest' });
        return true;
      }
      if (!existing && givenSha) {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Contents', field: 'sha', code: 'custom' }] });
        return true;
      }
      const { sha, fileSha } = commitFileChange(repo, branch, path, content, message, owner.name, owner.email);
      const commit = commitJson(repo, sha);
      sendJson(res, existing ? 200 : 201, {
        content: {
          type: 'file', encoding: 'base64', size: content.length,
          name: path.split('/').pop(), path, sha: fileSha,
          url: `${repoBase}/contents/${path}?ref=${branch}`,
          git_url: `${repoBase}/git/blobs/${fileSha}`,
          html_url: `https://github.com/${repo.owner.login}/${repo.name}/blob/${branch}/${path}`,
          download_url: `https://raw.githubusercontent.com/${repo.owner.login}/${repo.name}/${branch}/${path}`,
          _links: { self: '', git: '', html: '' },
        },
        commit,
      });
      return true;
    }
    if (method === 'DELETE') {
      const message = str(body.message);
      const givenSha = str(body.sha);
      if (!message || !givenSha) { validationFailed(res, 'Contents', !message ? 'message' : 'sha', 'missing_field'); return true; }
      const branch = str(body.branch) ?? repo.default_branch;
      const tip = resolveRef(repo, branch);
      const commitSha = tip ? peelToCommit(repo.store, tip) : undefined;
      let existing: string | undefined;
      if (commitSha) {
        const tree = (commitOf(repo.store, commitSha) as { tree: string }).tree;
        existing = entryAtPath(repo.store, tree, path)?.sha;
      }
      if (!existing) { notFound(res); return true; }
      if (givenSha !== existing) {
        sendJson(res, 409, { message: `${path} does not match ${givenSha}` });
        return true;
      }
      const { sha } = commitFileChange(repo, branch, path, null, message, owner.name, owner.email);
      sendJson(res, 200, { content: null, commit: commitJson(repo, sha) });
      return true;
    }
    return false;
  }

  // ----- git refs (basic) -----
  if (rest[0] === 'git' && rest[1] === 'refs') {
    const refJson = (ref: string, sha: string) => ({
      ref,
      node_id: Buffer.from(`Ref:${ref}`).toString('base64'),
      url: `${repoBase}/git/${ref}`,
      object: { sha, type: repo.store.read(sha)?.type ?? 'commit', url: `${repoBase}/git/commits/${sha}` },
    });
    if (rest.length === 2 && method === 'GET') {
      sendJson(res, 200, [...repo.refs.entries()].map(([r, s]) => refJson(r, s)));
      return true;
    }
    if (rest.length === 2 && method === 'POST') {
      const ref = str(body.ref), sha = str(body.sha);
      if (!ref || !sha || !repo.store.has(sha)) { validationFailed(res, 'Ref', 'sha'); return true; }
      if (repo.refs.has(ref)) { validationFailed(res, 'Ref', 'ref', 'already_exists'); return true; }
      repo.refs.set(ref, sha);
      sendJson(res, 201, refJson(ref, sha));
      return true;
    }
    if (rest.length >= 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      if (method === 'GET') {
        const sha = repo.refs.get(ref);
        if (!sha) { notFound(res); return true; }
        sendJson(res, 200, refJson(ref, sha));
        return true;
      }
      if (method === 'PATCH') {
        const sha = str(body.sha);
        if (!sha || !repo.store.has(sha)) { validationFailed(res, 'Ref', 'sha'); return true; }
        if (!repo.refs.has(ref) && body.force !== true) { notFound(res); return true; }
        repo.refs.set(ref, sha);
        sendJson(res, 200, refJson(ref, sha));
        return true;
      }
      if (method === 'DELETE') {
        if (!repo.refs.delete(ref)) { notFound(res); return true; }
        sendJson(res, 204, undefined);
        return true;
      }
    }
    return false;
  }

  return handleIssuesAndPulls(ctx, repo, rest);
}

// Re-exported below (issues, labels, pulls live in the same module file's
// second half).
import { handleIssuesAndPulls } from './rest-issues.ts';
export { commitJson, branchJson, branchesOf, commitFileChange };
