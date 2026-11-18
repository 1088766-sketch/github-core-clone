// The MCP endpoint: Model Context Protocol over streamable HTTP
// (JSON-RPC 2.0, plain-JSON responses), with the github-mcp-server tool
// set operating on the same store the REST surface serves — an issue
// created here is the same object there, ids stable.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Forge, isoNow, repoJson, issueJson, commentJson, type Repo, type Issue } from './store.ts';
import { resolveRef, peelToCommit, commitOf, mergeInto, entryAtPath } from './repo-git.ts';
import { commitFileChange } from './rest.ts';
import { sendJson } from './http-util.ts';

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, Record<string, unknown>>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  { name: 'create_repository', description: 'Create a new repository for the authenticated user', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string' }, private: { type: 'boolean' }, autoInit: { type: 'boolean' } }, required: ['name'] },
  { name: 'search_repositories', description: 'Search for repositories by name or owner', properties: { query: { type: 'string' }, page: { type: 'number' }, perPage: { type: 'number' } }, required: ['query'] },
  { name: 'create_issue', description: 'Create a new issue in a repository', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } }, required: ['owner', 'repo', 'title'] },
  { name: 'list_issues', description: 'List issues in a repository', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed', 'all'] }, labels: { type: 'array', items: { type: 'string' } }, page: { type: 'number' }, perPage: { type: 'number' } }, required: ['owner', 'repo'] },
  { name: 'get_issue', description: 'Get details of a specific issue', properties: { owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'number' } }, required: ['owner', 'repo', 'issue_number'] },
  { name: 'add_issue_comment', description: 'Add a comment to an issue', properties: { owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'number' }, body: { type: 'string' } }, required: ['owner', 'repo', 'issue_number', 'body'] },
  { name: 'create_pull_request', description: 'Create a new pull request', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' }, draft: { type: 'boolean' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  { name: 'list_pull_requests', description: 'List pull requests in a repository', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed', 'all'] }, page: { type: 'number' }, perPage: { type: 'number' } }, required: ['owner', 'repo'] },
  { name: 'get_pull_request', description: 'Get details of a specific pull request', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] },
  { name: 'merge_pull_request', description: 'Merge a pull request', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' }, merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'] }, commit_title: { type: 'string' }, commit_message: { type: 'string' } }, required: ['owner', 'repo', 'pull_number'] },
  { name: 'get_repo', description: 'Get details of a repository', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] },
  { name: 'get_file_contents', description: 'Get the contents of a file or directory from a repository', properties: { owner: { type: 'string' }, repo: { type: 'string' }, path: { type: 'string' }, branch: { type: 'string' } }, required: ['owner', 'repo', 'path'] },
  { name: 'create_or_update_file', description: 'Create or update a file in a repository', properties: { owner: { type: 'string' }, repo: { type: 'string' }, path: { type: 'string' }, content: { type: 'string' }, message: { type: 'string' }, branch: { type: 'string' }, sha: { type: 'string' } }, required: ['owner', 'repo', 'path', 'content', 'message', 'branch'] },
];

function toolsListResult(): Record<string, unknown> {
  return {
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: 'object', properties: t.properties, required: t.required },
    })),
  };
}

function textResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError: false };
}
function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> | 'unknown-tool' {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) return 'unknown-tool';
  for (const req of def.required) {
    if (args[req] === undefined || args[req] === null || args[req] === '') {
      return errorResult(`missing required argument: ${req}`);
    }
  }
  const owner = forge.owner;
  const repoOf = (): Repo | undefined => forge.repo(String(args.owner ?? ''), String(args.repo ?? ''));
  switch (name) {
    case 'create_repository': {
      const repoName = String(args.name);
      const existingRepo = forge.repo(owner.login, repoName);
      if (existingRepo) return textResult(repoJson(existingRepo));
      const repo = forge.createRepo(owner.login, repoName, {
        description: (args.description as string) ?? null,
        private: args.private === true,
      });
      return textResult(repoJson(repo));
    }
    case 'search_repositories': {
      const q = String(args.query ?? '').toLowerCase();
      const all = [...forge.repos.values()].filter((r) => `${r.owner.login}/${r.name}`.toLowerCase().includes(q));
      return textResult({ total_count: all.length, incomplete_results: false, items: all.map(repoJson) });
    }
    case 'create_issue': {
      const repo = repoOf();
      if (!repo) return errorResult('repository not found');
      const labels: Issue['labels'] = [];
      for (const labelName of (args.labels as string[] | undefined) ?? []) {
        const label = repo.labels.find((l) => l.name.toLowerCase() === labelName.toLowerCase());
        if (!label) return errorResult(`label not found: ${labelName}`);
        labels.push(label);
      }
      const now = isoNow();
      const issue: Issue = {
        id: repo.nextIssueId++,
        number: repo.issues.length ? Math.max(...repo.issues.map((i) => i.number)) + 1 : 1,
        title: String(args.title),
        body: (args.body as string) ?? null,
        state: 'open', user: owner, labels, comments: [],
        created_at: now, updated_at: now, closed_at: null,
      };
      repo.issues.push(issue);
      return textResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = repoOf();
      if (!repo) return errorResult('repository not found');
      const state = String(args.state ?? 'open');
      const list = repo.issues.filter((i) => !i.pull && (state === 'all' || i.state === state));
      return textResult(list.map((i) => issueJson(repo, i)));
    }
    case 'get_issue': {
      const repo = repoOf();
      if (!repo) return errorResult('repository not found');
      const issue = repo.issues.find((i) => i.number === Number(args.issue_number));
      if (!issue) return errorResult('issue not found');
      return textResult(issueJson(repo, issue));
    }
    case 'add_issue_comment': {
      const repo = repoOf();
      if (!repo) return errorResult('repository not found');
      const issue = repo.issues.find((i) => i.number === Number(args.issue_number));
      if (!issue) return errorResult('issue not found');
      const now = isoNow();
      const comment = { id: repo.nextCommentId++, user: owner, body: String(args.body), created_at: now, updated_at: now };
      issue.comments.push(comment);
      issue.updated_at = now;
      return textResult(commentJson(repo, issue, comment));
    }
    case 'create_pull_request': {
      const repo = repoOf();
      if (!repo) return errorResult('repository not found');
      const headRef = String(args.head).includes(':') ? String(args.head).split(':').slice(1).join(':') : String(args.head);
      const baseRef = String(args.base);
      const headSha = resolveRef(repo, `refs/heads/${headRef}`);
      const baseSha = resolveRef(repo, `refs/heads/${baseRef}`);
      if (!headSha || !baseSha) return errorResult('head or base branch not found');
      const now = isoNow();
      const issue: Issue = {
        id: repo.nextIssueId++,
        number: repo.issues.length ? Math.max(...repo.issues.map((i) => i.number)) + 1 : 1,
        title: String(args.title),
        body: (args.body as string) ?? null,
        state: 'open', user: owner, labels: [], comments: [],
        created_at: now, updated_at: now, closed_at: null,
        pull: {
          headRef, headSha: peelToCommit(repo.store, headSha) as string,
          baseRef, baseSha: peelToCommit(repo.store, baseSha) as string,
          merged: false, merged_at: null, merge_commit_sha: null, mergeable: null,
          draft: args.draft === true,
        },
      };
      repo.issues.push(issue);
      return textResult(issueJson(repo, issue));
    }
    case 'list_pull_requests': {
      const repo = repoOf();
      if (!repo) return errorResult('repository not found');
      const state = String(args.state ?? 'open');
      const list = repo.issues.filter((i) => i.pull && (state === 'all' || i.state === state));
      return textResult(list.map((i) => issueJson(repo, i)));
    }
    case 'get_pull_request': {
      const repo = repoOf();
      if (!repo) return errorResult('repository not found');
      const issue = repo.issues.find((i) => i.number === Number(args.pull_number) && i.pull);
      if (!issue) return errorResult('pull request not found');
      return textResult(issueJson(repo, issue));
    }
    case 'merge_pull_request': {
      const repo = repoOf();
      if (!repo) return errorResult('repository not found');
      const issue = repo.issues.find((i) => i.number === Number(args.pull_number) && i.pull);
      if (!issue || !issue.pull) return errorResult('pull request not found');
      const pull = issue.pull;
      if (pull.merged) return errorResult('Pull Request is not mergeable');
      const methodRaw = String(args.merge_method ?? 'merge');
      const method = methodRaw === 'squash' ? 'squash' : methodRaw === 'rebase' ? 'rebase' : 'merge';
      const baseTip = peelToCommit(repo.store, resolveRef(repo, pull.baseRef) as string) as string;
      const headTip = peelToCommit(repo.store, resolveRef(repo, `refs/heads/${pull.headRef}`) ?? pull.headSha) as string;
      const title = (args.commit_title as string) ?? (method === 'squash' ? `${issue.title} (#${issue.number})` : `Merge pull request #${issue.number} from ${repo.owner.login}:${pull.headRef}`);
      const outcome = mergeInto(repo, baseTip, headTip, method, title, owner.name, owner.email);
      if (!outcome.ok) return errorResult('Pull Request is not mergeable');
      repo.refs.set(`refs/heads/${pull.baseRef}`, outcome.sha as string);
      pull.merged = true;
      pull.merged_at = isoNow();
      pull.merge_commit_sha = outcome.sha as string;
      issue.state = 'closed';
      issue.closed_at = pull.merged_at;
      void commitOf;
      return textResult({ sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
    }
    case 'get_repo': {
      const repo = repoOf();
      if (!repo) return errorResult('repository not found');
      return textResult(repoJson(repo));
    }
    case 'get_file_contents': {
      const repo = repoOf();
      if (!repo) return errorResult('repository not found');
      const branch = String(args.branch ?? repo.default_branch);
      const tip = resolveRef(repo, branch);
      const commitSha = tip ? peelToCommit(repo.store, tip) : undefined;
      if (!commitSha) return errorResult('branch not found');
      const tree = (commitOf(repo.store, commitSha) as { tree: string }).tree;
      const entry = entryAtPath(repo.store, tree, String(args.path));
      if (!entry) return errorResult('path not found');
      if (entry.type === 'tree') return errorResult('path is a directory');
      const blob = repo.store.read(entry.sha);
      return textResult({
        type: 'file', encoding: 'base64', size: blob?.data.length ?? 0,
        name: String(args.path).split('/').pop(), path: String(args.path), sha: entry.sha,
        content: (blob?.data ?? Buffer.alloc(0)).toString('base64'),
      });
    }
    case 'create_or_update_file': {
      const repo = repoOf();
      if (!repo) return errorResult('repository not found');
      const branch = String(args.branch);
      const { sha, fileSha } = commitFileChange(repo, branch, String(args.path), Buffer.from(String(args.content), 'utf8'), String(args.message), owner.name, owner.email);
      return textResult({
        content: { name: String(args.path).split('/').pop(), path: String(args.path), sha: fileSha, size: String(args.content).length },
        commit: { sha },
      });
    }
  }
  return errorResult('tool not implemented');
}

export function handleMcp(ctx: { forge: Forge; req: IncomingMessage; res: ServerResponse; rawBody: Buffer }): void {
  const { forge, req, res, rawBody } = ctx;
  if (req.method === 'GET' || req.method === 'DELETE') {
    sendJson(res, 405, { jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' }, id: null });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    // The protocol check: a non-JSON body is HTTP 400 with -32700.
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
    return;
  }
  const handleOne = (msg: Record<string, unknown>): Record<string, unknown> | null => {
    const id = (msg.id ?? null) as string | number | null;
    const method = String(msg.method ?? '');
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const isNotification = msg.id === undefined;
    const result = (value: unknown): Record<string, unknown> | null => (isNotification ? null : { jsonrpc: '2.0', id, result: value });
    const error = (code: number, message: string): Record<string, unknown> | null => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize': {
        const requested = String((params.protocolVersion as string) ?? '2024-11-05');
        const supported = ['2024-11-05', '2025-03-26', '2025-06-18'];
        return result({
          protocolVersion: supported.includes(requested) ? requested : '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'github-mcp-server', version: '1.0.0' },
        });
      }
      case 'server/discover':
        return result({
          supportedVersions: ['2024-11-05', '2025-03-26'],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'github-mcp-server', version: '1.0.0' },
        });
      case 'ping': return result({});
      case 'tools/list': return result(toolsListResult());
      case 'tools/call': {
        const toolName = String(params.name ?? '');
        const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
        const outcome = callTool(forge, toolName, toolArgs);
        if (outcome === 'unknown-tool') return error(-32602, `unknown tool: ${toolName}`);
        return result(outcome);
      }
      case 'resources/list': return result({ resources: [] });
      case 'resources/templates/list': return result({ resourceTemplates: [] });
      case 'prompts/list': return result({ prompts: [] });
      case 'logging/setLevel': return result({});
      case 'notifications/initialized': case 'notifications/cancelled': return null;
      default:
        if (method.startsWith('notifications/')) return null;
        return error(-32601, `method not found: ${method}`);
    }
  };
  const respond = (payload: unknown, status = 200) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'mcp-session-id': randomBytes(16).toString('hex'),
    });
    res.end(JSON.stringify(payload));
  };
  if (Array.isArray(parsed)) {
    const responses = parsed.map((m) => handleOne((m ?? {}) as Record<string, unknown>)).filter(Boolean);
    if (!responses.length) { res.writeHead(202); res.end(); return; }
    respond(responses);
    return;
  }
  const response = handleOne((parsed ?? {}) as Record<string, unknown>);
  if (!response) { res.writeHead(202); res.end(); return; }
  respond(response);
}
