// Issues, comments, labels and pull requests — the second half of the
// REST v3 surface. Pull requests live in the repo's shared issue number
// sequence, exactly as on GitHub, and their merges run through the
// repo-git three-way merge.

import type { RestContext } from './rest.ts';
import { commitJson } from './rest.ts';
import { isoNow, labelJson, issueJson, commentJson, userJson, type Repo, type Issue, type Label } from './store.ts';
import { resolveRef, peelToCommit, commitOf, commitLog, diffCommits, mergeInto, mergeBase, filesOf } from './repo-git.ts';
import { sendJson, notFound, validationFailed, pageOf, paginate, baseUrlOf } from './http-util.ts';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const strArr = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined);

function findIssue(repo: Repo, n: number): Issue | undefined {
  return repo.issues.find((i) => i.number === n);
}

function resolveLabels(repo: Repo, names: string[]): Label[] | null {
  const out: Label[] = [];
  for (const name of names) {
    const label = repo.labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (!label) return null;
    out.push(label);
  }
  return out;
}

/** Would merging head into base conflict? (Same per-file rule as mergeInto.) */
function wouldConflict(repo: Repo, baseSha: string, headSha: string): boolean {
  const store = repo.store;
  const base = mergeBase(store, baseSha, headSha);
  if (!base) return true;
  const baseFiles = filesOf(store, (commitOf(store, base) as { tree: string }).tree);
  const oursFiles = filesOf(store, (commitOf(store, baseSha) as { tree: string }).tree);
  const theirsFiles = filesOf(store, (commitOf(store, headSha) as { tree: string }).tree);
  const all = new Set([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()]);
  for (const path of all) {
    const b = baseFiles.get(path), o = oursFiles.get(path), t = theirsFiles.get(path);
    if (o === t || b === o || b === t) continue;
    return true;
  }
  return false;
}

function pullJson(ctx: RestContext, repo: Repo, issue: Issue): Record<string, unknown> {
  const pull = issue.pull as NonNullable<Issue['pull']>;
  const baseSha = resolveRef(repo, pull.baseRef) ?? pull.baseSha;
  // The head branch may have moved since the pull request was opened;
  // GitHub reads the pull request against the branch's current tip.
  const liveHead = resolveRef(repo, `refs/heads/${pull.headRef}`);
  if (liveHead) {
    const peeled = peelToCommit(repo.store, liveHead);
    if (peeled) pull.headSha = peeled;
  }
  const headSha = pull.headSha;
  const baseCommit = baseSha ? peelToCommit(repo.store, baseSha) : undefined;
  const mb = baseCommit ? mergeBase(repo.store, baseCommit, headSha) : undefined;
  const changes = mb ? diffCommits(repo.store, mb, headSha) : [];
  const additions = changes.reduce((s, c) => s + c.additions, 0);
  const deletions = changes.reduce((s, c) => s + c.deletions, 0);
  const mergeable = issue.state === 'closed' && pull.merged ? true
    : baseCommit ? !wouldConflict(repo, baseCommit, headSha) : null;
  const refObj = (ref: string, sha: string) => ({
    label: `${repo.owner.login}:${ref}`,
    ref,
    sha,
    user: userJson(repo.owner),
    repo: {
      id: repo.id, name: repo.name, full_name: `${repo.owner.login}/${repo.name}`,
      owner: userJson(repo.owner), private: repo.private,
      url: `/api/v3/repos/${repo.owner.login}/${repo.name}`,
      description: repo.description, default_branch: repo.default_branch,
    },
  });
  return {
    ...issueJson(repo, issue),
    head: refObj(pull.headRef, headSha),
    base: refObj(pull.baseRef, baseCommit ?? pull.baseSha),
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    mergeable,
    mergeable_state: pull.merged ? 'clean' : mergeable === null ? 'unknown' : mergeable ? 'clean' : 'dirty',
    draft: pull.draft,
    additions,
    deletions,
    changed_files: changes.length,
    commits: 0,
    comments: issue.comments.length,
    review_comments: 0,
    maintainer_can_modify: false,
    _links: {
      self: { href: `/api/v3/repos/${repo.owner.login}/${repo.name}/pulls/${issue.number}` },
      html: { href: `https://github.com/${repo.owner.login}/${repo.name}/pull/${issue.number}` },
      issue: { href: `/api/v3/repos/${repo.owner.login}/${repo.name}/issues/${issue.number}` },
      comments: { href: `/api/v3/repos/${repo.owner.login}/${repo.name}/issues/${issue.number}/comments` },
      review_comments: { href: `/api/v3/repos/${repo.owner.login}/${repo.name}/pulls/${issue.number}/comments` },
      review_comment: { href: `/api/v3/repos/${repo.owner.login}/${repo.name}/pulls/comments{/number}` },
      commits: { href: `/api/v3/repos/${repo.owner.login}/${repo.name}/pulls/${issue.number}/commits` },
      statuses: { href: '' },
    },
  };
}

export function handleIssuesAndPulls(ctx: RestContext, repo: Repo, rest: string[]): boolean {
  const { forge, req, res, query, body } = ctx;
  const method = req.method ?? 'GET';
  const owner = forge.owner;
  const repoBase = `/api/v3/repos/${repo.owner.login}/${repo.name}`;

  // ----- labels -----
  if (rest[0] === 'labels') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const page = pageOf(query);
        const all = [...repo.labels].sort((a, b) => a.name.localeCompare(b.name)).map((l) => labelJson(repo, l));
        const { slice, link } = paginate(all, page, baseUrlOf(req, `${repoBase}/labels`));
        sendJson(res, 200, slice, link ? { link } : {});
        return true;
      }
      if (method === 'POST') {
        const name = str(body.name);
        if (!name) { validationFailed(res, 'Label', 'name', 'missing_field'); return true; }
        if (repo.labels.some((l) => l.name.toLowerCase() === name.toLowerCase())) {
          validationFailed(res, 'Label', 'name', 'already_exists');
          return true;
        }
        const label: Label = {
          id: repo.nextLabelId++,
          name,
          color: (str(body.color) ?? 'ededed').replace(/^#/, '').toLowerCase(),
          description: str(body.description) ?? null,
          default: false,
        };
        repo.labels.push(label);
        sendJson(res, 201, labelJson(repo, label));
        return true;
      }
      return false;
    }
    if (rest.length === 2) {
      const name = decodeURIComponent(rest[1]);
      const label = repo.labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
      if (method === 'GET') {
        if (!label) { notFound(res); return true; }
        sendJson(res, 200, labelJson(repo, label));
        return true;
      }
      if (method === 'PATCH') {
        if (!label) { notFound(res); return true; }
        if (str(body.new_name)) label.name = str(body.new_name) as string;
        if (str(body.color)) label.color = (str(body.color) as string).replace(/^#/, '').toLowerCase();
        if (body.description !== undefined) label.description = str(body.description) ?? null;
        sendJson(res, 200, labelJson(repo, label));
        return true;
      }
      if (method === 'DELETE') {
        if (!label) { notFound(res); return true; }
        repo.labels = repo.labels.filter((l) => l !== label);
        for (const issue of repo.issues) issue.labels = issue.labels.filter((l) => l !== label);
        sendJson(res, 204, undefined);
        return true;
      }
      return false;
    }
    return false;
  }

  // ----- issues -----
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const title = str(body.title);
        if (!title) { validationFailed(res, 'Issue', 'title', 'missing_field'); return true; }
        let labels: Label[] = [];
        const labelNames = strArr(body.labels);
        if (labelNames) {
          const resolved = resolveLabels(repo, labelNames);
          if (!resolved) { validationFailed(res, 'Issue', 'labels', 'custom'); return true; }
          labels = resolved;
        }
        const now = isoNow();
        const issue: Issue = {
          id: repo.nextIssueId++,
          number: repo.issues.length ? Math.max(...repo.issues.map((i) => i.number)) + 1 : 1,
          title,
          body: str(body.body) ?? null,
          state: 'open',
          user: owner,
          labels,
          comments: [],
          created_at: now,
          updated_at: now,
          closed_at: null,
        };
        repo.issues.push(issue);
        sendJson(res, 201, issueJson(repo, issue));
        return true;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        const labelFilter = query.get('labels')?.split(',').filter(Boolean).map((s) => s.toLowerCase());
        let list = repo.issues.filter((i) => state === 'all' || i.state === state);
        if (labelFilter?.length) {
          list = list.filter((i) => labelFilter.every((lf) => i.labels.some((l) => l.name.toLowerCase() === lf)));
        }
        list = [...list].sort((a, b) => {
          const ka = sort === 'updated' ? a.updated_at : a.created_at;
          const kb = sort === 'updated' ? b.updated_at : b.created_at;
          const cmp = ka === kb ? a.number - b.number : ka < kb ? -1 : 1;
          return direction === 'asc' ? cmp : -cmp;
        });
        const page = pageOf(query);
        const all = list.map((i) => issueJson(repo, i));
        const { slice, link } = paginate(all, page, baseUrlOf(req, `${repoBase}/issues`));
        sendJson(res, 200, slice, link ? { link } : {});
        return true;
      }
      return false;
    }
    // /issues/comments/{id}
    if (rest[1] === 'comments' && rest.length === 3) {
      const id = Number(rest[2]);
      let holder: { issue: Issue; comment: Issue['comments'][number] } | undefined;
      for (const issue of repo.issues) {
        const comment = issue.comments.find((c) => c.id === id);
        if (comment) { holder = { issue, comment }; break; }
      }
      if (!holder) { notFound(res); return true; }
      if (method === 'GET') { sendJson(res, 200, commentJson(repo, holder.issue, holder.comment)); return true; }
      if (method === 'PATCH') {
        if (str(body.body) !== undefined) holder.comment.body = str(body.body) as string;
        holder.comment.updated_at = isoNow();
        sendJson(res, 200, commentJson(repo, holder.issue, holder.comment));
        return true;
      }
      if (method === 'DELETE') {
        holder.issue.comments = holder.issue.comments.filter((c) => c !== holder?.comment);
        sendJson(res, 204, undefined);
        return true;
      }
      return false;
    }
    const number = Number(rest[1]);
    const issue = Number.isInteger(number) ? findIssue(repo, number) : undefined;
    if (!issue) { notFound(res); return true; }
    if (rest.length === 2) {
      if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return true; }
      if (method === 'PATCH') {
        if (str(body.title) !== undefined) issue.title = str(body.title) as string;
        if (body.body !== undefined) issue.body = str(body.body) ?? null;
        const state = str(body.state);
        if (state === 'open' || state === 'closed') {
          issue.state = state;
          issue.closed_at = state === 'closed' ? isoNow() : null;
        }
        const labelNames = strArr(body.labels);
        if (labelNames) {
          const resolved = resolveLabels(repo, labelNames);
          if (!resolved) { validationFailed(res, 'Issue', 'labels', 'custom'); return true; }
          issue.labels = resolved;
        }
        issue.updated_at = isoNow();
        sendJson(res, 200, issueJson(repo, issue));
        return true;
      }
      return false;
    }
    if (rest[2] === 'comments' && rest.length === 3) {
      if (method === 'GET') {
        const page = pageOf(query);
        const all = issue.comments.map((c) => commentJson(repo, issue, c));
        const { slice, link } = paginate(all, page, baseUrlOf(req, `${repoBase}/issues/${issue.number}/comments`));
        sendJson(res, 200, slice, link ? { link } : {});
        return true;
      }
      if (method === 'POST') {
        const text = str(body.body);
        if (!text) { validationFailed(res, 'IssueComment', 'body', 'missing_field'); return true; }
        const now = isoNow();
        const comment = { id: repo.nextCommentId++, user: owner, body: text, created_at: now, updated_at: now };
        issue.comments.push(comment);
        issue.updated_at = now;
        sendJson(res, 201, commentJson(repo, issue, comment));
        return true;
      }
      return false;
    }
    if (rest[2] === 'labels') {
      if (rest.length === 3) {
        if (method === 'GET') { sendJson(res, 200, issue.labels.map((l) => labelJson(repo, l))); return true; }
        if (method === 'POST') {
          const names = strArr(body.labels) ?? (str(body.name) ? [str(body.name) as string] : []);
          const resolved = resolveLabels(repo, names);
          if (!resolved) { notFound(res); return true; }
          for (const l of resolved) if (!issue.labels.includes(l)) issue.labels.push(l);
          sendJson(res, 200, issue.labels.map((l) => labelJson(repo, l)));
          return true;
        }
        if (method === 'PUT') {
          const names = strArr(body.labels) ?? [];
          const resolved = resolveLabels(repo, names);
          if (!resolved) { notFound(res); return true; }
          issue.labels = resolved;
          sendJson(res, 200, issue.labels.map((l) => labelJson(repo, l)));
          return true;
        }
        if (method === 'DELETE') {
          issue.labels = [];
          sendJson(res, 200, []);
          return true;
        }
        return false;
      }
      if (rest.length === 4 && method === 'DELETE') {
        const name = decodeURIComponent(rest[3]).toLowerCase();
        issue.labels = issue.labels.filter((l) => l.name.toLowerCase() !== name);
        sendJson(res, 200, issue.labels.map((l) => labelJson(repo, l)));
        return true;
      }
      return false;
    }
    return false;
  }

  // ----- pull requests -----
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const title = str(body.title);
        const headRaw = str(body.head);
        const baseRaw = str(body.base);
        if (!title || !headRaw || !baseRaw) { validationFailed(res, 'PullRequest', !title ? 'title' : !headRaw ? 'head' : 'base', 'missing_field'); return true; }
        const headRef = headRaw.includes(':') ? headRaw.split(':').slice(1).join(':') : headRaw;
        const headSha = resolveRef(repo, `refs/heads/${headRef}`);
        const baseSha = resolveRef(repo, `refs/heads/${baseRaw}`);
        if (!headSha || !baseSha) { validationFailed(res, 'PullRequest', !headSha ? 'head' : 'base', 'invalid'); return true; }
        const headCommit = peelToCommit(repo.store, headSha) as string;
        const baseCommit = peelToCommit(repo.store, baseSha) as string;
        if (headCommit === baseCommit || (commitOf(repo.store, baseCommit) && isAncestorOf(repo, headCommit, baseCommit))) {
          sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'custom', message: `No commits between ${baseRaw} and ${headRef}` }] });
          return true;
        }
        const dupe = repo.issues.some((i) => i.pull && i.state === 'open' && i.pull.headRef === headRef && i.pull.baseRef === baseRaw);
        if (dupe) {
          sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'custom', message: `A pull request already exists for ${headRaw}.` }] });
          return true;
        }
        const now = isoNow();
        const issue: Issue = {
          id: repo.nextIssueId++,
          number: repo.issues.length ? Math.max(...repo.issues.map((i) => i.number)) + 1 : 1,
          title,
          body: str(body.body) ?? null,
          state: 'open',
          user: owner,
          labels: [],
          comments: [],
          created_at: now,
          updated_at: now,
          closed_at: null,
          pull: {
            headRef, headSha: headCommit, baseRef: baseRaw, baseSha: baseCommit,
            merged: false, merged_at: null, merge_commit_sha: null, mergeable: null,
            draft: body.draft === true,
          },
        };
        repo.issues.push(issue);
        const ctxFull: RestContext = { ...ctx, repo } as RestContext;
        sendJson(res, 201, pullJson(ctxFull, repo, issue));
        return true;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let list = repo.issues.filter((i) => i.pull && (state === 'all' || i.state === state));
        list = [...list].sort((a, b) => {
          const ka = sort === 'updated' ? a.updated_at : a.created_at;
          const kb = sort === 'updated' ? b.updated_at : b.created_at;
          const cmp = ka === kb ? a.number - b.number : ka < kb ? -1 : 1;
          return direction === 'asc' ? cmp : -cmp;
        });
        const page = pageOf(query);
        const all = list.map((i) => pullJson(ctx, repo, i));
        const { slice, link } = paginate(all, page, baseUrlOf(req, `${repoBase}/pulls`));
        sendJson(res, 200, slice, link ? { link } : {});
        return true;
      }
      return false;
    }
    const number = Number(rest[1]);
    const issue = Number.isInteger(number) ? findIssue(repo, number) : undefined;
    if (!issue || !issue.pull) { notFound(res); return true; }
    const pull = issue.pull;
    const liveHead = resolveRef(repo, `refs/heads/${pull.headRef}`);
    if (liveHead) {
      const peeled = peelToCommit(repo.store, liveHead);
      if (peeled) pull.headSha = peeled;
    }
    if (rest.length === 2) {
      if (method === 'GET') { sendJson(res, 200, pullJson(ctx, repo, issue)); return true; }
      if (method === 'PATCH') {
        if (str(body.title) !== undefined) issue.title = str(body.title) as string;
        if (body.body !== undefined) issue.body = str(body.body) ?? null;
        const state = str(body.state);
        if (state === 'open' || state === 'closed') {
          issue.state = state;
          issue.closed_at = state === 'closed' ? isoNow() : null;
        }
        if (str(body.base)) {
          const newBase = resolveRef(repo, `refs/heads/${str(body.base)}`);
          if (!newBase) { validationFailed(res, 'PullRequest', 'base', 'invalid'); return true; }
          pull.baseRef = str(body.base) as string;
          pull.baseSha = peelToCommit(repo.store, newBase) as string;
        }
        issue.updated_at = isoNow();
        sendJson(res, 200, pullJson(ctx, repo, issue));
        return true;
      }
      return false;
    }
    if (rest[2] === 'files' && rest.length === 3 && method === 'GET') {
      const baseCommit = peelToCommit(repo.store, resolveRef(repo, pull.baseRef) ?? pull.baseSha) as string;
      const mb = mergeBase(repo.store, baseCommit, pull.headSha);
      const changes = mb ? diffCommits(repo.store, mb, pull.headSha) : [];
      const headFiles = filesOf(repo.store, (commitOf(repo.store, pull.headSha) as { tree: string }).tree);
      const page = pageOf(query);
      const all = changes.map((c) => ({
        sha: headFiles.get(c.path) ?? '',
        filename: c.path,
        status: c.status,
        additions: c.additions,
        deletions: c.deletions,
        changes: c.additions + c.deletions,
        patch: c.patch,
        blob_url: `${repoBase}/git/blobs/${headFiles.get(c.path) ?? ''}`,
        raw_url: `https://raw.githubusercontent.com/${repo.owner.login}/${repo.name}/${pull.headSha}/${c.path}`,
        contents_url: `${repoBase}/contents/${c.path}?ref=${pull.headSha}`,
      }));
      const { slice, link } = paginate(all, page, baseUrlOf(req, `${repoBase}/pulls/${issue.number}/files`));
      sendJson(res, 200, slice, link ? { link } : {});
      return true;
    }
    if (rest[2] === 'commits' && rest.length === 3 && method === 'GET') {
      const baseCommit = peelToCommit(repo.store, resolveRef(repo, pull.baseRef) ?? pull.baseSha) as string;
      const baseAncestors = new Set<string>();
      const queue = [baseCommit];
      while (queue.length) {
        const sha = queue.shift() as string;
        if (baseAncestors.has(sha)) continue;
        baseAncestors.add(sha);
        const c = commitOf(repo.store, sha);
        if (c) queue.push(...c.parents);
      }
      const log = commitLog(repo.store, pull.headSha, 250).filter((e) => !baseAncestors.has(e.sha));
      const all = log.map((e) => commitJson(repo, e.sha)).filter(Boolean);
      const page = pageOf(query);
      const { slice, link } = paginate(all, page, baseUrlOf(req, `${repoBase}/pulls/${issue.number}/commits`));
      sendJson(res, 200, slice, link ? { link } : {});
      return true;
    }
    if (rest[2] === 'merge' && rest.length === 3) {
      if (method === 'GET') {
        if (pull.merged) { sendJson(res, 204, undefined); return true; }
        notFound(res);
        return true;
      }
      if (method === 'PUT') {
        if (pull.merged || issue.state === 'closed') {
          sendJson(res, 405, { message: 'Pull Request is not mergeable', documentation_url: 'https://docs.github.com/rest/pulls/pulls#merge-a-pull-request' });
          return true;
        }
        const expectedSha = str(body.sha);
        if (expectedSha && expectedSha !== pull.headSha) {
          sendJson(res, 409, { message: 'Head branch was modified. Review and try the merge again.' });
          return true;
        }
        const methodRaw = str(body.merge_method) ?? 'merge';
        const mergeMethod = methodRaw === 'squash' ? 'squash' : methodRaw === 'rebase' ? 'rebase' : 'merge';
        const baseTip = peelToCommit(repo.store, resolveRef(repo, pull.baseRef) as string) as string;
        // refresh head: the branch may have moved since creation
        const headTip = peelToCommit(repo.store, resolveRef(repo, `refs/heads/${pull.headRef}`) ?? pull.headSha) as string;
        pull.headSha = headTip;
        const title = str(body.commit_title) ?? (mergeMethod === 'squash'
          ? `${issue.title} (#${issue.number})`
          : `Merge pull request #${issue.number} from ${repo.owner.login}:${pull.headRef}`);
        const outcome = mergeInto(repo, baseTip, headTip, mergeMethod, title, owner.name, owner.email);
        if (!outcome.ok) {
          sendJson(res, 405, { message: 'Pull Request is not mergeable', documentation_url: 'https://docs.github.com/rest/pulls/pulls#merge-a-pull-request' });
          return true;
        }
        repo.refs.set(`refs/heads/${pull.baseRef}`, outcome.sha as string);
        pull.merged = true;
        pull.merged_at = isoNow();
        pull.merge_commit_sha = outcome.sha as string;
        issue.state = 'closed';
        issue.closed_at = pull.merged_at;
        issue.updated_at = pull.merged_at;
        repo.pushed_at = pull.merged_at;
        sendJson(res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
        return true;
      }
      return false;
    }
    return false;
  }

  return false;
}

import { isAncestor } from './repo-git.ts';
function isAncestorOf(repo: Repo, ancestor: string, tip: string): boolean {
  return isAncestor(repo.store, ancestor, tip);
}
