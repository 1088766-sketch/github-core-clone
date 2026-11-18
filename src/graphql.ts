// The GraphQL v4 surface: a small executor over the forge store, shaped
// for the documents gh and github-mcp-server send — viewer, repository,
// node(id:), issue/pullRequest connections with cursor paging, the
// mutation set (createIssue, addComment, closeIssue, createPullRequest,
// mergePullRequest), and the introspection gh feature-detects with.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseGraphql, argsOf, valueOf, GqlSyntaxError, type Document, type SelectionNode, type FieldNode } from './gql-parse.ts';
import { Forge, globalId, parseGlobalId, isoNow, type Repo, type Issue, type User, type Comment } from './store.ts';
import { commitLog, diffCommits, mergeBase, mergeInto, filesOf, flattenTree, entryAtPath, resolveRef as resolveRefShim } from './repo-git.ts';
import { peelToCommit, commitOf as rawCommitOf } from './repo-git.ts';
import { sendJson } from './http-util.ts';

// ---------- object wrappers ----------
export interface GObj { __type: string; [key: string]: unknown }
const wrap = (type: string, fields: Record<string, unknown>): GObj => ({ __type: type, ...fields });

function userObj(u: User): GObj { return wrap('User', { user: u }); }
function repoObj(repo: Repo): GObj { return wrap('Repository', { repo }); }
function issueObj(repo: Repo, issue: Issue): GObj { return wrap(issue.pull ? 'PullRequest' : 'Issue', { repo, issue }); }
function commentObj(repo: Repo, issue: Issue, comment: Comment): GObj { return wrap('IssueComment', { repo, issue, comment }); }
function labelObj(repo: Repo, label: Issue['labels'][number]): GObj { return wrap('Label', { repo, label }); }
function commitObj(repo: Repo, sha: string): GObj { return wrap('Commit', { repo, sha }); }

// ---------- connections ----------
interface Conn { __type: 'Connection'; itemType: string; total: number; slice: GObj[]; startIndex: number; hasNext: boolean; hasPrev: boolean }
const cursorOf = (index: number) => Buffer.from(`cursor:${index}`).toString('base64');
function decodeCursor(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}
function conn(items: GObj[], itemType: string, args: Record<string, unknown>): Conn {
  let start = 0;
  if (typeof args.after === 'string') start = decodeCursor(args.after) + 1;
  let end = items.length;
  if (typeof args.before === 'string') end = decodeCursor(args.before);
  let slice = items.slice(start, end);
  let hasNext = false, hasPrev = start > 0;
  if (typeof args.first === 'number') {
    hasNext = slice.length > (args.first as number);
    slice = slice.slice(0, args.first as number);
  }
  if (typeof args.last === 'number') {
    hasPrev = slice.length > (args.last as number) || hasPrev;
    slice = slice.slice(-(args.last as number));
    start = start + (items.slice(start, end).length - slice.length);
  }
  return { __type: 'Connection', itemType, total: items.length, slice, startIndex: start, hasNext, hasPrev };
}

// ---------- type registry for introspection ----------
type TypeRef = { kind: string; name: string | null; ofType?: TypeRef | null };
const ref = (kind: string, name: string | null, ofType?: TypeRef): TypeRef => ({ kind, name, ofType: ofType ?? null });
const SC = (name: string) => ref('SCALAR', name);
const OB = (name: string) => ref('OBJECT', name);
const EN = (name: string) => ref('ENUM', name);
const NN = (t: TypeRef) => ref('NON_NULL', null, t);
const LI = (t: TypeRef) => ref('LIST', null, t);

interface TypeDef { kind: string; fields?: Array<{ name: string; type: TypeRef }>; values?: string[] }
const F = (name: string, type: TypeRef) => ({ name, type });
const TYPE_DEFS: Record<string, TypeDef> = {
  Query: { kind: 'OBJECT', fields: [F('viewer', NN(OB('User'))), F('repository', OB('Repository')), F('node', OB('Node')), F('user', OB('User')), F('organization', OB('Organization')), F('search', NN(OB('SearchResultItemConnection'))), F('rateLimit', OB('RateLimit'))] },
  Mutation: { kind: 'OBJECT', fields: [F('createIssue', OB('CreateIssuePayload')), F('addComment', OB('AddCommentPayload')), F('closeIssue', OB('CloseIssuePayload')), F('reopenIssue', OB('ReopenIssuePayload')), F('updateIssue', OB('UpdateIssuePayload')), F('createPullRequest', OB('CreatePullRequestPayload')), F('mergePullRequest', OB('MergePullRequestPayload')), F('createRepository', OB('CreateRepositoryPayload'))] },
  User: { kind: 'OBJECT', fields: [F('id', NN(SC('ID'))), F('login', NN(SC('String'))), F('name', SC('String')), F('email', NN(SC('String'))), F('url', NN(SC('URI'))), F('avatarUrl', NN(SC('URI'))), F('isViewer', NN(SC('Boolean'))), F('repositories', NN(OB('RepositoryConnection'))), F('repository', OB('Repository')), F('createdAt', NN(SC('DateTime'))), F('updatedAt', NN(SC('DateTime'))), F('bio', SC('String')), F('company', SC('String')), F('location', SC('String')), F('followers', NN(OB('FollowerConnection'))), F('following', NN(OB('FollowingConnection')))] },
  Organization: { kind: 'OBJECT', fields: [F('id', NN(SC('ID'))), F('login', NN(SC('String'))), F('name', SC('String')), F('url', NN(SC('URI'))), F('repositories', NN(OB('RepositoryConnection'))), F('repository', OB('Repository'))] },
  Repository: { kind: 'OBJECT', fields: [
    F('id', NN(SC('ID'))), F('name', NN(SC('String'))), F('nameWithOwner', NN(SC('String'))), F('owner', NN(OB('RepositoryOwner'))),
    F('description', SC('String')), F('isPrivate', NN(SC('Boolean'))), F('isFork', NN(SC('Boolean'))), F('url', NN(SC('URI'))),
    F('createdAt', NN(SC('DateTime'))), F('updatedAt', NN(SC('DateTime'))), F('pushedAt', SC('DateTime')),
    F('defaultBranchRef', OB('Ref')), F('stargazerCount', NN(SC('Int'))), F('forkCount', NN(SC('Int'))),
    F('issues', NN(OB('IssueConnection'))), F('issue', OB('Issue')), F('issueOrPullRequest', OB('IssueOrPullRequest')),
    F('pullRequests', NN(OB('PullRequestConnection'))), F('pullRequest', OB('PullRequest')),
    F('labels', OB('LabelConnection')), F('label', OB('Label')), F('refs', OB('RefConnection')), F('ref', OB('Ref')),
    F('object', OB('GitObject')), F('homepageUrl', SC('URI')), F('isArchived', NN(SC('Boolean'))), F('isDisabled', NN(SC('Boolean'))),
    F('primaryLanguage', OB('Language')), F('repositoryTopics', NN(OB('RepositoryTopicConnection'))), F('viewerPermission', EN('RepositoryPermission')),
    F('databaseId', SC('Int')), F('hasIssuesEnabled', NN(SC('Boolean'))), F('hasProjectsEnabled', NN(SC('Boolean'))),
    F('hasWikiEnabled', NN(SC('Boolean'))), F('hasDownloadsEnabled', NN(SC('Boolean'))), F('isEmpty', NN(SC('Boolean'))),
    F('isTemplate', NN(SC('Boolean'))), F('visibility', NN(EN('RepositoryVisibility'))), F('viewerCanAdminister', NN(SC('Boolean'))),
    F('mergeCommitAllowed', NN(SC('Boolean'))), F('squashMergeAllowed', NN(SC('Boolean'))), F('rebaseMergeAllowed', NN(SC('Boolean'))),
    F('deleteBranchOnMerge', NN(SC('Boolean'))), F('licenseInfo', OB('License')), F('sshUrl', NN(SC('GitSSHRemote'))),
    F('resourcePath', NN(SC('URI'))), F('shortDescriptionHTML', SC('String')), F('isInOrganization', NN(SC('Boolean'))),
    F('isUserConfigurationRepository', NN(SC('Boolean'))), F('isSecurityAdvisoryEnabled', NN(SC('Boolean'))),
  ] },
  Issue: { kind: 'OBJECT', fields: [
    F('id', NN(SC('ID'))), F('number', NN(SC('Int'))), F('title', NN(SC('String'))), F('body', NN(SC('String'))), F('bodyText', NN(SC('String'))),
    F('state', NN(EN('IssueState'))), F('url', NN(SC('URI'))), F('author', OB('Actor')), F('editor', OB('Actor')),
    F('labels', OB('LabelConnection')), F('comments', NN(OB('IssueCommentConnection'))), F('assignees', NN(OB('UserConnection'))),
    F('milestone', OB('Milestone')), F('repository', NN(OB('Repository'))), F('createdAt', NN(SC('DateTime'))), F('updatedAt', NN(SC('DateTime'))),
    F('closedAt', SC('DateTime')), F('reactions', NN(OB('ReactionConnection'))), F('participants', NN(OB('UserConnection'))),
    F('activeLockReason', EN('LockReason')), F('locked', NN(SC('Boolean'))), F('viewerDidAuthor', NN(SC('Boolean'))),
    F('authorAssociation', NN(EN('CommentAuthorAssociation'))), F('timelineItems', NN(OB('IssueTimelineItemsConnection'))),
  ] },
  PullRequest: { kind: 'OBJECT', fields: [
    F('id', NN(SC('ID'))), F('number', NN(SC('Int'))), F('title', NN(SC('String'))), F('body', NN(SC('String'))),
    F('state', NN(EN('PullRequestState'))), F('url', NN(SC('URI'))), F('permalink', NN(SC('URI'))), F('author', OB('Actor')),
    F('labels', OB('LabelConnection')), F('comments', NN(OB('IssueCommentConnection'))), F('repository', NN(OB('Repository'))),
    F('createdAt', NN(SC('DateTime'))), F('updatedAt', NN(SC('DateTime'))), F('closedAt', SC('DateTime')),
    F('merged', NN(SC('Boolean'))), F('mergedAt', SC('DateTime')), F('mergedBy', OB('Actor')), F('mergeable', NN(EN('MergeableState'))),
    F('isDraft', NN(SC('Boolean'))), F('headRefName', NN(SC('String'))), F('baseRefName', NN(SC('String'))),
    F('headRefOid', NN(SC('GitObjectID'))), F('baseRefOid', NN(SC('GitObjectID'))),
    F('headRepository', OB('Repository')), F('baseRepository', OB('Repository')), F('headRef', OB('Ref')), F('baseRef', OB('Ref')),
    F('files', OB('PullRequestChangedFileConnection')), F('commits', NN(OB('PullRequestCommitConnection'))),
    F('mergeCommit', OB('Commit')), F('additions', NN(SC('Int'))), F('deletions', NN(SC('Int'))), F('changedFiles', NN(SC('Int'))),
    F('reviewDecision', EN('PullRequestReviewDecision')), F('latestReviews', OB('PullRequestReviewConnection')),
  ] },
  Label: { kind: 'OBJECT', fields: [F('id', NN(SC('ID'))), F('name', NN(SC('String'))), F('color', NN(SC('String'))), F('description', SC('String')), F('url', NN(SC('URI'))), F('isDefault', NN(SC('Boolean'))), F('createdAt', NN(SC('DateTime'))), F('updatedAt', NN(SC('DateTime')))] },
  IssueComment: { kind: 'OBJECT', fields: [F('id', NN(SC('ID'))), F('body', NN(SC('String'))), F('author', OB('Actor')), F('createdAt', NN(SC('DateTime'))), F('updatedAt', NN(SC('DateTime'))), F('url', NN(SC('URI'))), F('issue', NN(OB('Issue'))), F('repository', NN(OB('Repository'))), F('authorAssociation', NN(EN('CommentAuthorAssociation')))] },
  Commit: { kind: 'OBJECT', fields: [F('id', NN(SC('ID'))), F('oid', NN(SC('GitObjectID'))), F('message', NN(SC('String'))), F('messageHeadline', NN(SC('String'))), F('messageBody', NN(SC('String'))), F('committedDate', NN(SC('DateTime'))), F('authoredDate', NN(SC('DateTime'))), F('author', OB('GitActor')), F('committer', OB('GitActor')), F('tree', NN(OB('Tree'))), F('treeResourcePath', NN(SC('URI'))), F('url', NN(SC('URI'))), F('parents', NN(OB('CommitConnection'))), F('history', NN(OB('CommitHistoryConnection'))), F('associatedPullRequests', OB('PullRequestConnection'))] },
  Blob: { kind: 'OBJECT', fields: [F('id', NN(SC('ID'))), F('oid', NN(SC('GitObjectID'))), F('text', SC('String')), F('byteSize', NN(SC('Int'))), F('isTruncated', NN(SC('Boolean'))), F('isBinary', SC('Boolean'))] },
  Tree: { kind: 'OBJECT', fields: [F('id', NN(SC('ID'))), F('oid', NN(SC('GitObjectID'))), F('entries', LI(NN(OB('TreeEntry'))))] },
  TreeEntry: { kind: 'OBJECT', fields: [F('name', NN(SC('String'))), F('path', SC('String')), F('type', NN(SC('String'))), F('mode', NN(SC('Int'))), F('object', OB('GitObject')), F('extension', SC('String'))] },
  Ref: { kind: 'OBJECT', fields: [F('id', NN(SC('ID'))), F('name', NN(SC('String'))), F('prefix', NN(SC('String'))), F('target', OB('GitObject')), F('repository', NN(OB('Repository'))), F('associatedPullRequests', NN(OB('PullRequestConnection')))] },
  GitActor: { kind: 'OBJECT', fields: [F('name', SC('String')), F('email', SC('String')), F('date', SC('DateTime')), F('user', OB('User')), F('avatarUrl', NN(SC('URI')))] },
  PageInfo: { kind: 'OBJECT', fields: [F('hasNextPage', NN(SC('Boolean'))), F('hasPreviousPage', NN(SC('Boolean'))), F('startCursor', SC('String')), F('endCursor', SC('String'))] },
  SearchType: { kind: 'ENUM', values: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  IssueState: { kind: 'ENUM', values: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', values: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', values: ['MERGE', 'SQUASH', 'REBASE'] },
  OrderDirection: { kind: 'ENUM', values: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  CommentAuthorAssociation: { kind: 'ENUM', values: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'NONE'] },
  RepositoryVisibility: { kind: 'ENUM', values: ['PUBLIC', 'PRIVATE', 'INTERNAL'] },
  SearchResultItemConnection: { kind: 'OBJECT', fields: [F('issueCount', NN(SC('Int'))), F('repositoryCount', NN(SC('Int'))), F('userCount', NN(SC('Int'))), F('edges', LI(OB('SearchResultItemEdge'))), F('nodes', LI(OB('SearchResultItem'))), F('pageInfo', NN(OB('PageInfo')))] },
  CreateIssuePayload: { kind: 'OBJECT', fields: [F('clientMutationId', SC('String')), F('issue', OB('Issue'))] },
  AddCommentPayload: { kind: 'OBJECT', fields: [F('clientMutationId', SC('String')), F('commentEdge', OB('IssueCommentEdge')), F('subject', OB('Node'))] },
  CloseIssuePayload: { kind: 'OBJECT', fields: [F('clientMutationId', SC('String')), F('issue', OB('Issue'))] },
  ReopenIssuePayload: { kind: 'OBJECT', fields: [F('clientMutationId', SC('String')), F('issue', OB('Issue'))] },
  UpdateIssuePayload: { kind: 'OBJECT', fields: [F('clientMutationId', SC('String')), F('issue', OB('Issue'))] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: [F('clientMutationId', SC('String')), F('pullRequest', OB('PullRequest'))] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: [F('clientMutationId', SC('String')), F('pullRequest', OB('PullRequest'))] },
  CreateRepositoryPayload: { kind: 'OBJECT', fields: [F('clientMutationId', SC('String')), F('repository', OB('Repository'))] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: [F('path', NN(SC('String'))), F('additions', NN(SC('Int'))), F('deletions', NN(SC('Int'))), F('changeType', NN(EN('PatchStatus')))] },
  PatchStatus: { kind: 'ENUM', values: ['ADDED', 'DELETED', 'MODIFIED', 'RENAMED', 'COPIED', 'CHANGED', 'UNCHANGED'] },
  RateLimit: { kind: 'OBJECT', fields: [F('limit', NN(SC('Int'))), F('cost', NN(SC('Int'))), F('remaining', NN(SC('Int'))), F('resetAt', NN(SC('DateTime'))), F('nodeCount', NN(SC('Int'))), F('used', NN(SC('Int')))] },
};

const TYPE_INTERFACES: Record<string, string[]> = {
  User: ['Node', 'Actor', 'RepositoryOwner', 'UniformResourceLocatable'],
  Organization: ['Node', 'Actor', 'RepositoryOwner', 'UniformResourceLocatable'],
  Repository: ['Node', 'RepositoryOwner', 'UniformResourceLocatable'],
  Issue: ['Node', 'Closable', 'Comment', 'Labelable', 'Reactable', 'UniformResourceLocatable', 'Updatable'],
  PullRequest: ['Node', 'Closable', 'Comment', 'Labelable', 'Reactable', 'UniformResourceLocatable', 'Updatable'],
  IssueComment: ['Node', 'Comment', 'Reactable', 'Updatable', 'Deletable'],
  Label: ['Node'],
  Commit: ['Node', 'GitObject', 'UniformResourceLocatable'],
  Blob: ['Node', 'GitObject'],
  Tree: ['Node', 'GitObject'],
  Ref: ['Node'],
};

// ---------- execution ----------
interface ExecCtx {
  forge: Forge;
  doc: Document;
  variables: Record<string, unknown>;
  errors: Array<Record<string, unknown>>;
}

function parseIdentDate(line: string): string {
  const m = /(\d+) [+-]\d{4}$/.exec(line);
  if (!m) return isoNow();
  return new Date(Number(m[1]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
function parseIdentParts(line: string): { name: string; email: string; date: string } {
  const m = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (!m) return { name: line, email: '', date: isoNow() };
  return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
}

export function handleGraphql(ctx: { forge: Forge; req: IncomingMessage; res: ServerResponse; body: unknown }): void {
  const { forge, res, body } = ctx;
  const runOne = (request: Record<string, unknown>): Record<string, unknown> => {
    const query = typeof request.query === 'string' ? request.query : '';
    const variables = (request.variables && typeof request.variables === 'object' ? request.variables : {}) as Record<string, unknown>;
    const operationName = typeof request.operationName === 'string' ? request.operationName : undefined;
    let doc: Document;
    try {
      doc = parseGraphql(query);
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'syntax error', extensions: { code: 'GRAPHQL_PARSE_FAILED' } }] };
    }
    const op = operationName ? doc.operations.find((o) => o.name === operationName) ?? doc.operations[0] : doc.operations[0];
    if (!op) return { errors: [{ message: 'No operation found' }] };
    const execCtx: ExecCtx = { forge, doc, variables, errors: [] };
    const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
    const data = execSelection(wrap(rootType, {}), rootType, op.selection, execCtx);
    const out: Record<string, unknown> = { data };
    if (execCtx.errors.length) out.errors = execCtx.errors;
    return out;
  };
  if (Array.isArray(body)) {
    sendJson(res, 200, body.map((entry) => runOne((entry ?? {}) as Record<string, unknown>)));
    return;
  }
  const result = runOne((body ?? {}) as Record<string, unknown>);
  sendJson(res, 200, result);
}

function shouldInclude(directives: FieldNode['directives'], ctx: ExecCtx): boolean {
  for (const d of directives) {
    const ifArg = d.args.get('if');
    const val = ifArg ? valueOf(ifArg, ctx.variables) : undefined;
    if (d.name === 'skip' && val === true) return false;
    if (d.name === 'include' && val === false) return false;
  }
  return true;
}

function typeMatches(objType: string, condition: string | undefined): boolean {
  if (!condition) return true;
  if (objType === condition) return true;
  return (TYPE_INTERFACES[objType] ?? []).includes(condition);
}

function execSelection(obj: GObj, typeName: string, selections: SelectionNode[], ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const visit = (sels: SelectionNode[], current: GObj, currentType: string) => {
    for (const sel of sels) {
      if (sel.kind === 'spread') {
        if (!shouldInclude(sel.directives, ctx)) continue;
        const frag = ctx.doc.fragments.get(sel.name);
        if (frag && typeMatches(currentType, frag.typeCondition)) visit(frag.selection, current, frag.typeCondition);
        continue;
      }
      if (sel.kind === 'inline') {
        if (!shouldInclude(sel.directives, ctx)) continue;
        if (typeMatches(currentType, sel.typeCondition)) visit(sel.selection, current, sel.typeCondition ?? currentType);
        continue;
      }
      if (!shouldInclude(sel.directives, ctx)) continue;
      const key = sel.alias ?? sel.name;
      if (currentType === 'SearchResultItemConnection') {
        const holder = current as unknown as { connObj: Conn; issueCount: number; repositoryCount: number; userCount: number };
        if (sel.name === 'issueCount') { out[key] = holder.issueCount; continue; }
        if (sel.name === 'repositoryCount') { out[key] = holder.repositoryCount; continue; }
        if (sel.name === 'userCount') { out[key] = holder.userCount; continue; }
        if (sel.name === 'edges' || sel.name === 'nodes' || sel.name === 'pageInfo') {
          const connResult = execConnection(holder.connObj, sel, ctx);
          out[key] = connResult[sel.name];
          continue;
        }
        if (sel.name === '__typename') { out[key] = 'SearchResultItemConnection'; continue; }
      }
      out[key] = execField(current, currentType, sel, ctx);
    }
  };
  visit(selections, obj, typeName);
  return out;
}

function execField(obj: GObj, typeName: string, field: FieldNode, ctx: ExecCtx): unknown {
  const name = field.name;
  if (name === '__typename') return typeName;
  const args = argsOf(field, ctx.variables);
  let value: unknown;
  try {
    value = resolveField(obj, typeName, name, args, ctx);
  } catch (err) {
    ctx.errors.push({ message: err instanceof Error ? err.message : 'field error', path: [field.alias ?? name] });
    return null;
  }
  if (value === undefined) {
    // Distinguish "known field, no value" from "unknown field": the type
    // registry decides. Unknown fields are the protocol error case.
    const def = TYPE_DEFS[typeName];
    const known = def?.fields?.some((f) => f.name === name) || obj.__type === 'Connection' || typeName === '__Type' || typeName === '__Field' || typeName === '__Schema' || typeName === '__InputValue' || typeName === '__EnumValue';
    if (!known && !name.startsWith('__')) {
      ctx.errors.push({
        message: `Field '${name}' doesn't exist on type '${typeName}'`,
        locations: [{ line: 1, column: 1 }],
        extensions: { code: 'undefinedField', typeName, fieldName: name },
      });
    }
    return null;
  }
  return completeValue(value, field, ctx);
}

function completeValue(value: unknown, field: FieldNode, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => completeValue(v, field, ctx));
  if (typeof value === 'object') {
    const obj = value as GObj;
    if (!field.selection) return obj.__type ? null : value;
    if (obj.__type === 'Connection') return execConnection(obj as unknown as Conn, field, ctx);
    return execSelection(obj, obj.__type, field.selection, ctx);
  }
  return value;
}

function execConnection(c: Conn, field: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const visit = (sels: SelectionNode[]) => {
    for (const sel of sels) {
      if (sel.kind !== 'field') continue;
      const key = sel.alias ?? sel.name;
      if (sel.name === 'totalCount') out[key] = c.total;
      else if (sel.name === 'nodes') out[key] = c.slice.map((n) => (sel.selection ? execSelection(n, n.__type, sel.selection, ctx) : null));
      else if (sel.name === 'edges') {
        out[key] = c.slice.map((n, i) => {
          const edge = wrap(`${c.itemType}Edge`, { node: n, cursor: cursorOf(c.startIndex + i) });
          return sel.selection ? execSelection(edge, edge.__type, sel.selection, ctx) : null;
        });
      } else if (sel.name === 'pageInfo') {
        const pageInfo = wrap('PageInfo', {
          hasNextPage: c.hasNext, hasPreviousPage: c.hasPrev,
          startCursor: c.slice.length ? cursorOf(c.startIndex) : null,
          endCursor: c.slice.length ? cursorOf(c.startIndex + c.slice.length - 1) : null,
        });
        out[key] = sel.selection ? execSelection(pageInfo, 'PageInfo', sel.selection, ctx) : null;
      } else if (sel.name === '__typename') out[key] = `${c.itemType}Connection`;
      else out[key] = null;
    }
  };
  visit(field.selection ?? []);
  return out;
}

// ---------- resolvers ----------
function resolveField(obj: GObj, typeName: string, name: string, args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const forge = ctx.forge;
  // introspection
  if (name === '__type' && typeName === 'Query') {
    const def = TYPE_DEFS[String(args.name)];
    if (!def) return null;
    return wrap('__Type', { defName: String(args.name), def });
  }
  if (name === '__schema' && typeName === 'Query') return wrap('__Schema', {});
  if (typeName === '__Type') return resolveTypeField(obj, name, args);
  if (typeName === '__Field') {
    if (name === 'name') return obj.fieldName;
    if (name === 'description') return null;
    if (name === 'type') return obj.typeRef;
    if (name === 'args') return [];
    if (name === 'isDeprecated') return false;
    if (name === 'deprecationReason') return null;
    return undefined;
  }
  if (typeName === '__Schema') {
    if (name === 'queryType') return wrap('__Type', { defName: 'Query', def: TYPE_DEFS.Query });
    if (name === 'mutationType') return wrap('__Type', { defName: 'Mutation', def: TYPE_DEFS.Mutation });
    if (name === 'subscriptionType') return null;
    if (name === 'types') return Object.keys(TYPE_DEFS).map((n) => wrap('__Type', { defName: n, def: TYPE_DEFS[n] }));
    if (name === 'directives') return [];
    return undefined;
  }
  if (typeName === '__EnumValue') {
    if (name === 'name') return obj.valueName;
    if (name === 'description') return null;
    if (name === 'isDeprecated') return false;
    if (name === 'deprecationReason') return null;
    return undefined;
  }
  if (typeName === 'PageInfo') return obj[name];
  if (typeName.endsWith('Edge')) {
    if (name === 'node') return obj.node;
    if (name === 'cursor') return obj.cursor;
    return undefined;
  }
  if (typeName === 'GitActor') {
    return obj[name];
  }
  if (typeName === 'PullRequestChangedFile') {
    return obj[name];
  }

  switch (typeName) {
    case 'Query': return resolveQuery(obj, name, args, ctx);
    case 'Mutation': return resolveMutation(obj, name, args, ctx);
    case 'User': case 'Organization': return resolveUser(obj, name, args, ctx);
    case 'Repository': return resolveRepository(obj, name, args, ctx);
    case 'Issue': case 'PullRequest': return resolveIssue(obj, name, args, ctx);
    case 'IssueComment': {
      const { repo, issue, comment } = obj as unknown as { repo: Repo; issue: Issue; comment: Comment };
      switch (name) {
        case 'id': return globalId('IssueComment', `${repo.id}:${issue.id}:${comment.id}`);
        case 'body': return comment.body;
        case 'author': return userObj(comment.user);
        case 'createdAt': return comment.created_at;
        case 'updatedAt': return comment.updated_at;
        case 'url': return `https://github.com/${repo.owner.login}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`;
        case 'issue': return issueObj(repo, issue);
        case 'repository': return repoObj(repo);
        case 'authorAssociation': return 'OWNER';
      }
      return undefined;
    }
    case 'Label': {
      const { repo, label } = obj as unknown as { repo: Repo; label: Issue['labels'][number] };
      switch (name) {
        case 'id': return globalId('Label', `${repo.id}:${label.id}`);
        case 'name': return label.name;
        case 'color': return label.color;
        case 'description': return label.description;
        case 'isDefault': return label.default;
        case 'url': return `https://github.com/${repo.owner.login}/${repo.name}/labels/${encodeURIComponent(label.name)}`;
        case 'createdAt': case 'updatedAt': return repo.created_at;
      }
      return undefined;
    }
    case 'Commit': return resolveCommit(obj, name, args, ctx);
    case 'Blob': {
      const blobObj = obj as unknown as { repo: Repo; sha: string };
      const data = blobObj.repo.store.read(blobObj.sha)?.data;
      switch (name) {
        case 'id': return globalId('Blob', blobObj.sha);
        case 'oid': return blobObj.sha;
        case 'text': return data ? data.toString('utf8') : null;
        case 'byteSize': return data?.length ?? 0;
        case 'isTruncated': return false;
        case 'isBinary': return data ? data.includes(0) : false;
      }
      return undefined;
    }
    case 'Tree': {
      const treeObj = obj as unknown as { repo: Repo; sha: string; prefix: string };
      if (name === 'id') return globalId('Tree', treeObj.sha);
      if (name === 'oid') return treeObj.sha;
      if (name === 'entries') {
        const flat = flattenTree(treeObj.repo.store, treeObj.sha);
        const direct: GObj[] = [];
        const seen = new Set<string>();
        for (const [p] of flat) {
          const first = p.split('/')[0];
          if (seen.has(first)) continue;
          seen.add(first);
          const fullPath = treeObj.prefix ? `${treeObj.prefix}/${first}` : first;
          const entry = entryAtPath(treeObj.repo.store, treeObj.sha, first);
          direct.push(wrap('TreeEntry', { repo: treeObj.repo, treeSha: treeObj.sha, prefix: treeObj.prefix, name: first, path: fullPath, entrySha: entry?.sha, entryMode: entry?.mode }));
        }
        return direct;
      }
      return undefined;
    }
    case 'TreeEntry': {
      const e = obj as unknown as { repo: Repo; name: string; path: string; entrySha: string; entryMode: string };
      switch (name) {
        case 'name': return e.name;
        case 'path': return e.path;
        case 'type': return e.entryMode === '40000' ? 'tree' : 'blob';
        case 'mode': return parseInt(e.entryMode, 10);
        case 'extension': { const dot = e.name.lastIndexOf('.'); return dot === -1 ? '' : e.name.slice(dot); }
        case 'object': {
          if (!e.entrySha) return null;
          return e.entryMode === '40000' ? wrap('Tree', { repo: e.repo, sha: e.entrySha, prefix: e.path }) : wrap('Blob', { repo: e.repo, sha: e.entrySha });
        }
      }
      return undefined;
    }
    case 'Ref': {
      const r = obj as unknown as { repo: Repo; refName: string };
      const sha = r.repo.refs.get(`refs/heads/${r.refName}`) ?? r.repo.refs.get(r.refName);
      switch (name) {
        case 'id': return globalId('Ref', `${r.repo.id}:${r.refName}`);
        case 'name': return r.refName;
        case 'prefix': return 'refs/heads/';
        case 'repository': return repoObj(r.repo);
        case 'target': return sha ? commitObj(r.repo, peelToCommit(r.repo.store, sha) as string) : null;
        case 'associatedPullRequests': return conn([], 'PullRequest', args);
      }
      return undefined;
    }
    case 'RateLimit': {
      if (name === 'limit') return 5000;
      if (name === 'cost') return 1;
      if (name === 'remaining') return 4999;
      if (name === 'used') return 1;
      if (name === 'nodeCount') return 0;
      if (name === 'resetAt') return new Date(Date.now() + 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      return undefined;
    }
  }
  // payload types
  if (typeName.endsWith('Payload')) {
    if (name === 'clientMutationId') return obj.clientMutationId ?? null;
    return obj[name.toLowerCase()] ?? obj[name] ?? undefined;
  }
  return undefined;
}

function resolveTypeField(obj: GObj, name: string, args: Record<string, unknown>): unknown {
  const def = obj.def as TypeDef;
  switch (name) {
    case 'kind': return def.kind;
    case 'name': return obj.defName;
    case 'description': return null;
    case 'fields': {
      if (!def.fields) return null;
      return def.fields.map((f) => wrap('__Field', { fieldName: f.name, typeRef: f.type }));
    }
    case 'enumValues': {
      if (!def.values) return null;
      return def.values.map((v) => wrap('__EnumValue', { valueName: v }));
    }
    case 'inputFields': return def.kind === 'INPUT_OBJECT' ? [] : null;
    case 'interfaces': return [];
    case 'possibleTypes': return null;
    case 'specifiedByURL': return null;
  }
  if ((obj as GObj).__type === '__Type' && name === 'ofType') return null;
  return undefined;
}

function resolveQuery(_obj: GObj, name: string, args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const forge = ctx.forge;
  switch (name) {
    case 'viewer': return userObj(forge.owner);
    case 'user': case 'organization': {
      const login = String(args.login ?? '');
      return forge.users.has(login.toLowerCase()) ? userObj(forge.user(login)) : null;
    }
    case 'repository': {
      const repo = forge.repo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? repoObj(repo) : null;
    }
    case 'node': {
      const parsed = parseGlobalId(String(args.id ?? ''));
      if (!parsed) return null;
      return nodeByGlobalId(forge, parsed.type, parsed.dbId);
    }
    case 'search': {
      const q = String(args.query ?? '').toLowerCase();
      const type = String(args.type ?? 'REPOSITORY');
      let items: GObj[] = [];
      if (type === 'REPOSITORY') {
        items = [...forge.repos.values()].filter((r) => `${r.owner.login}/${r.name}`.toLowerCase().includes(q.replace(/^user:\S+\s*/, ''))).map(repoObj);
      } else if (type === 'ISSUE') {
        for (const repo of forge.repos.values()) {
          for (const issue of repo.issues) if (!issue.pull && issue.title.toLowerCase().includes(q)) items.push(issueObj(repo, issue));
        }
      } else if (type === 'USER') {
        items = [...forge.users.values()].filter((u) => u.login.toLowerCase().includes(q)).map(userObj);
      }
      const c = conn(items, type === 'ISSUE' ? 'Issue' : type === 'USER' ? 'User' : 'Repository', args);
      return wrap('SearchResultItemConnection', {
        connObj: c,
        issueCount: type === 'ISSUE' ? items.length : 0,
        repositoryCount: type === 'REPOSITORY' ? items.length : 0,
        userCount: type === 'USER' ? items.length : 0,
      });
    }
    case 'rateLimit': return wrap('RateLimit', {});
  }
  return undefined;
}

function nodeByGlobalId(forge: Forge, type: string, dbId: string): GObj | null {
  if (type === 'Repository') {
    const repo = [...forge.repos.values()].find((r) => r.id === Number(dbId));
    return repo ? repoObj(repo) : null;
  }
  if (type === 'User' || type === 'Organization') {
    const user = [...forge.users.values()].find((u) => u.id === Number(dbId));
    return user ? userObj(user) : null;
  }
  if (type === 'Issue' || type === 'PullRequest') {
    const [repoId, issueId] = dbId.split(':').map(Number);
    const repo = [...forge.repos.values()].find((r) => r.id === repoId);
    const issue = repo?.issues.find((i) => i.id === issueId);
    return repo && issue ? issueObj(repo, issue) : null;
  }
  if (type === 'Label') {
    const [repoId, labelId] = dbId.split(':').map(Number);
    const repo = [...forge.repos.values()].find((r) => r.id === repoId);
    const label = repo?.labels.find((l) => l.id === labelId);
    return repo && label ? labelObj(repo, label) : null;
  }
  if (type === 'IssueComment') {
    const [repoId, issueId, commentId] = dbId.split(':').map(Number);
    const repo = [...forge.repos.values()].find((r) => r.id === repoId);
    const issue = repo?.issues.find((i) => i.id === issueId);
    const comment = issue?.comments.find((c) => c.id === commentId);
    return repo && issue && comment ? commentObj(repo, issue, comment) : null;
  }
  return null;
}

function resolveUser(obj: GObj, name: string, args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const user = (obj as unknown as { user: User }).user;
  const forge = ctx.forge;
  switch (name) {
    case 'id': return globalId(user.type === 'Organization' ? 'Organization' : 'User', user.id);
    case 'login': return user.login;
    case 'name': return user.name;
    case 'email': return user.email;
    case 'url': return `https://github.com/${user.login}`;
    case 'avatarUrl': return `https://avatars.githubusercontent.com/u/${user.id}?v=4`;
    case 'isViewer': return user.login === forge.owner.login;
    case 'bio': case 'company': case 'location': return null;
    case 'createdAt': case 'updatedAt': return '2020-01-01T00:00:00Z';
    case 'repositories': return conn(forge.reposOf(user.login).map(repoObj), 'Repository', args);
    case 'repository': {
      const repo = forge.repo(user.login, String(args.name ?? ''));
      return repo ? repoObj(repo) : null;
    }
    case 'followers': case 'following': return conn([], 'User', args);
  }
  return undefined;
}

function sortIssues(list: Issue[], args: Record<string, unknown>): Issue[] {
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const field = orderBy.field ?? 'CREATED_AT';
  const dir = orderBy.direction ?? 'DESC';
  return [...list].sort((a, b) => {
    const ka = field === 'UPDATED_AT' ? a.updated_at : a.created_at;
    const kb = field === 'UPDATED_AT' ? b.updated_at : b.created_at;
    const cmp = ka === kb ? a.number - b.number : ka < kb ? -1 : 1;
    return dir === 'ASC' ? cmp : -cmp;
  });
}

function resolveRepository(obj: GObj, name: string, args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const repo = (obj as unknown as { repo: Repo }).repo;
  switch (name) {
    case 'id': return globalId('Repository', repo.id);
    case 'databaseId': return repo.id;
    case 'hasIssuesEnabled': case 'hasProjectsEnabled': case 'hasWikiEnabled': case 'hasDownloadsEnabled': return true;
    case 'isEmpty': return repo.refs.size === 0;
    case 'isTemplate': case 'isInOrganization': case 'isUserConfigurationRepository': case 'isSecurityAdvisoryEnabled': return false;
    case 'visibility': return repo.private ? 'PRIVATE' : 'PUBLIC';
    case 'viewerCanAdminister': return true;
    case 'mergeCommitAllowed': case 'squashMergeAllowed': case 'rebaseMergeAllowed': return true;
    case 'deleteBranchOnMerge': return false;
    case 'licenseInfo': return null;
    case 'sshUrl': return `git@github.com:${repo.owner.login}/${repo.name}.git`;
    case 'resourcePath': case 'shortDescriptionHTML': return `/${repo.owner.login}/${repo.name}`;
    case 'name': return repo.name;
    case 'nameWithOwner': return `${repo.owner.login}/${repo.name}`;
    case 'owner': return userObj(repo.owner);
    case 'description': return repo.description;
    case 'isPrivate': return repo.private;
    case 'isFork': return false;
    case 'isArchived': case 'isDisabled': return false;
    case 'url': return `https://github.com/${repo.owner.login}/${repo.name}`;
    case 'homepageUrl': return null;
    case 'createdAt': return repo.created_at;
    case 'updatedAt': return repo.updated_at;
    case 'pushedAt': return repo.pushed_at;
    case 'stargazerCount': case 'forkCount': return 0;
    case 'viewerPermission': return 'ADMIN';
    case 'primaryLanguage': return null;
    case 'defaultBranchRef': {
      const sha = repo.refs.get(`refs/heads/${repo.default_branch}`);
      return sha ? wrap('Ref', { repo, refName: repo.default_branch }) : null;
    }
    case 'ref': {
      const qn = String(args.qualifiedName ?? '');
      const branch = qn.replace(/^refs\/heads\//, '');
      return repo.refs.has(`refs/heads/${branch}`) ? wrap('Ref', { repo, refName: branch }) : null;
    }
    case 'refs': {
      const prefix = String(args.refPrefix ?? 'refs/heads/');
      const items = [...repo.refs.keys()].filter((r) => r.startsWith(prefix)).sort()
        .map((r) => wrap('Ref', { repo, refName: r.slice(prefix.length) }));
      return conn(items, 'Ref', args);
    }
    case 'issues': {
      const states = (args.states as string[] | undefined) ?? ['OPEN'];
      let list = repo.issues.filter((i) => !i.pull && states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
      list = sortIssues(list, args);
      return conn(list.map((i) => issueObj(repo, i)), 'Issue', args);
    }
    case 'issue': {
      const issue = repo.issues.find((i) => i.number === Number(args.number) && !i.pull);
      return issue ? issueObj(repo, issue) : null;
    }
    case 'issueOrPullRequest': {
      const issue = repo.issues.find((i) => i.number === Number(args.number));
      return issue ? issueObj(repo, issue) : null;
    }
    case 'pullRequests': {
      const states = (args.states as string[] | undefined) ?? ['OPEN'];
      let list = repo.issues.filter((i) => {
        if (!i.pull) return false;
        const st = i.pull.merged ? 'MERGED' : i.state === 'open' ? 'OPEN' : 'CLOSED';
        return states.includes(st);
      });
      list = sortIssues(list, args);
      return conn(list.map((i) => issueObj(repo, i)), 'PullRequest', args);
    }
    case 'pullRequest': {
      const issue = repo.issues.find((i) => i.number === Number(args.number) && i.pull);
      return issue ? issueObj(repo, issue) : null;
    }
    case 'labels': {
      const items = [...repo.labels].sort((a, b) => a.name.localeCompare(b.name)).map((l) => labelObj(repo, l));
      return conn(items, 'Label', args);
    }
    case 'label': {
      const label = repo.labels.find((l) => l.name.toLowerCase() === String(args.name ?? '').toLowerCase());
      return label ? labelObj(repo, label) : null;
    }
    case 'object': {
      const expr = String(args.expression ?? '');
      const colon = expr.indexOf(':');
      const rev = colon === -1 ? repo.default_branch : expr.slice(0, colon);
      const path = colon === -1 ? '' : expr.slice(colon + 1);
      const tip = resolveRefShim(repo, rev);
      const commitSha = tip ? peelToCommit(repo.store, tip) : undefined;
      if (!commitSha) return null;
      const tree = (rawCommitOf(repo.store, commitSha) as { tree: string }).tree;
      const entry = entryAtPath(repo.store, tree, path);
      if (!entry) return null;
      if (entry.type === 'tree') return wrap('Tree', { repo, sha: entry.sha, prefix: path });
      return wrap('Blob', { repo, sha: entry.sha });
    }
    case 'repositoryTopics': return conn([], 'RepositoryTopic', args);
  }
  return undefined;
}

function resolveIssue(obj: GObj, name: string, args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const { repo, issue } = obj as unknown as { repo: Repo; issue: Issue };
  const pull = issue.pull;
  switch (name) {
    case 'id': return globalId(pull ? 'PullRequest' : 'Issue', `${repo.id}:${issue.id}`);
    case 'number': return issue.number;
    case 'title': return issue.title;
    case 'body': case 'bodyText': return issue.body ?? '';
    case 'state': return pull?.merged ? 'MERGED' : issue.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'url': case 'permalink': return `https://github.com/${repo.owner.login}/${repo.name}/${pull ? 'pull' : 'issues'}/${issue.number}`;
    case 'author': case 'editor': return userObj(issue.user);
    case 'repository': return repoObj(repo);
    case 'createdAt': return issue.created_at;
    case 'updatedAt': return issue.updated_at;
    case 'closedAt': return issue.closed_at;
    case 'labels': return conn(issue.labels.map((l) => labelObj(repo, l)), 'Label', args);
    case 'comments': return conn(issue.comments.map((c) => commentObj(repo, issue, c)), 'IssueComment', args);
    case 'assignees': case 'participants': return conn([], 'User', args);
    case 'reactions': return conn([], 'Reaction', args);
    case 'milestone': return null;
    case 'locked': return false;
    case 'activeLockReason': return null;
    case 'viewerDidAuthor': return true;
    case 'authorAssociation': return 'OWNER';
    case 'timelineItems': return conn([], 'IssueTimelineItems', args);
  }
  if (pull) {
    // Read against the head branch's current tip, as GitHub does.
    const liveHead = resolveRefShim(repo, `refs/heads/${pull.headRef}`);
    const headSha = liveHead ? (peelToCommit(repo.store, liveHead) ?? pull.headSha) : pull.headSha;
    switch (name) {
      case 'merged': return pull.merged;
      case 'mergedAt': return pull.merged_at;
      case 'mergedBy': return pull.merged ? userObj(ctx.forge.owner) : null;
      case 'isDraft': return pull.draft;
      case 'headRefName': return pull.headRef;
      case 'baseRefName': return pull.baseRef;
      case 'headRefOid': return headSha;
      case 'baseRefOid': return pull.baseSha;
      case 'headRepository': case 'baseRepository': return repoObj(repo);
      case 'headRef': return wrap('Ref', { repo, refName: pull.headRef });
      case 'baseRef': return wrap('Ref', { repo, refName: pull.baseRef });
      case 'mergeCommit': return pull.merge_commit_sha ? commitObj(repo, pull.merge_commit_sha) : null;
      case 'mergeable': {
        if (pull.merged) return 'MERGEABLE';
        const baseTip = peelToCommit(repo.store, resolveRefShim(repo, pull.baseRef) ?? pull.baseSha);
        if (!baseTip) return 'UNKNOWN';
        const mb = mergeBase(repo.store, baseTip, headSha);
        if (!mb) return 'UNKNOWN';
        const baseFiles = filesOf(repo.store, (rawCommitOf(repo.store, mb) as { tree: string }).tree);
        const oursFiles = filesOf(repo.store, (rawCommitOf(repo.store, baseTip) as { tree: string }).tree);
        const theirsFiles = filesOf(repo.store, (rawCommitOf(repo.store, headSha) as { tree: string }).tree);
        let conflict = false;
        for (const p of new Set([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()])) {
          const b = baseFiles.get(p), o = oursFiles.get(p), t = theirsFiles.get(p);
          if (o !== t && b !== o && b !== t) { conflict = true; break; }
        }
        return conflict ? 'CONFLICTING' : 'MERGEABLE';
      }
      case 'files': {
        const baseTip = peelToCommit(repo.store, resolveRefShim(repo, pull.baseRef) ?? pull.baseSha) as string;
        const mb = mergeBase(repo.store, baseTip, headSha);
        const changes = mb ? diffCommits(repo.store, mb, headSha) : [];
        const items = changes.map((c) => wrap('PullRequestChangedFile', {
          path: c.path, additions: c.additions, deletions: c.deletions,
          changeType: c.status === 'added' ? 'ADDED' : c.status === 'removed' ? 'DELETED' : 'MODIFIED',
        }));
        return conn(items, 'PullRequestChangedFile', args);
      }
      case 'additions': case 'deletions': case 'changedFiles': {
        const baseTip = peelToCommit(repo.store, resolveRefShim(repo, pull.baseRef) ?? pull.baseSha) as string;
        const mb = mergeBase(repo.store, baseTip, headSha);
        const changes = mb ? diffCommits(repo.store, mb, headSha) : [];
        if (name === 'additions') return changes.reduce((s, c) => s + c.additions, 0);
        if (name === 'deletions') return changes.reduce((s, c) => s + c.deletions, 0);
        return changes.length;
      }
      case 'commits': {
        const log = commitLog(repo.store, headSha, 250);
        return conn(log.map((e) => wrap('PullRequestCommit', { repo, sha: e.sha })), 'PullRequestCommit', args);
      }
      case 'reviewDecision': return null;
      case 'latestReviews': return conn([], 'PullRequestReview', args);
    }
  }
  return undefined;
}

function resolveCommit(obj: GObj, name: string, args: Record<string, unknown>, _ctx: ExecCtx): unknown {
  // PullRequestCommit wraps a commit too
  const { repo, sha } = obj as unknown as { repo: Repo; sha: string };
  if ((obj as GObj).__type === 'PullRequestCommit') {
    if (name === 'commit') return commitObj(repo, sha);
    if (name === 'id') return globalId('PullRequestCommit', sha);
    if (name === 'url') return `https://github.com/${repo.owner.login}/${repo.name}/commit/${sha}`;
  }
  const commit = rawCommitOf(repo.store, sha);
  if (!commit) return null;
  switch (name) {
    case 'id': return globalId('Commit', sha);
    case 'oid': return sha;
    case 'message': return commit.message;
    case 'messageHeadline': return commit.message.split('\n')[0];
    case 'messageBody': return commit.message.split('\n').slice(2).join('\n');
    case 'committedDate': return parseIdentDate(commit.committer);
    case 'authoredDate': return parseIdentDate(commit.author);
    case 'author': case 'committer': {
      const parts = parseIdentParts(name === 'author' ? commit.author : commit.committer);
      return wrap('GitActor', { ...parts, avatarUrl: '', user: null });
    }
    case 'tree': return wrap('Tree', { repo, sha: commit.tree, prefix: '' });
    case 'treeResourcePath': return `/${repo.owner.login}/${repo.name}/tree/${sha}`;
    case 'url': return `https://github.com/${repo.owner.login}/${repo.name}/commit/${sha}`;
    case 'parents': return conn(commit.parents.map((p) => commitObj(repo, p)), 'Commit', args);
    case 'history': return conn(commitLog(repo.store, sha, 1000).map((e) => commitObj(repo, e.sha)), 'Commit', args);
    case 'associatedPullRequests': return conn([], 'PullRequest', args);
  }
  return undefined;
}

function findRepoIssueByGlobalId(forge: Forge, id: string): { repo: Repo; issue: Issue } | null {
  const parsed = parseGlobalId(id);
  if (!parsed) return null;
  const [repoId, issueId] = parsed.dbId.split(':').map(Number);
  const repo = [...forge.repos.values()].find((r) => r.id === repoId);
  const issue = repo?.issues.find((i) => i.id === issueId);
  return repo && issue ? { repo, issue } : null;
}

function resolveMutation(_obj: GObj, name: string, args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const forge = ctx.forge;
  const input = (args.input ?? {}) as Record<string, unknown>;
  const clientMutationId = (input.clientMutationId as string | undefined) ?? null;
  const owner = forge.owner;
  switch (name) {
    case 'createRepository': {
      const repoName = String(input.name ?? '');
      if (!repoName || forge.repo(owner.login, repoName)) throw new Error('repository already exists or name missing');
      const repo = forge.createRepo(owner.login, repoName, {
        description: (input.description as string) ?? null,
        private: String(input.visibility ?? 'PUBLIC') === 'PRIVATE',
      });
      return wrap('CreateRepositoryPayload', { clientMutationId, repository: repoObj(repo) });
    }
    case 'createIssue': {
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed ? [...forge.repos.values()].find((r) => r.id === Number(parsed.dbId)) : undefined;
      if (!repo) throw new Error('repository not found');
      const now = isoNow();
      const labels: Issue['labels'] = [];
      for (const lid of (input.labelIds as string[] | undefined) ?? []) {
        const lp = parseGlobalId(lid);
        const labelId = lp ? Number(lp.dbId.split(':').pop()) : NaN;
        const label = repo.labels.find((l) => l.id === labelId);
        if (label) labels.push(label);
      }
      const issue: Issue = {
        id: repo.nextIssueId++,
        number: repo.issues.length ? Math.max(...repo.issues.map((i) => i.number)) + 1 : 1,
        title: String(input.title ?? ''),
        body: (input.body as string) ?? null,
        state: 'open', user: owner, labels, comments: [],
        created_at: now, updated_at: now, closed_at: null,
      };
      repo.issues.push(issue);
      return wrap('CreateIssuePayload', { clientMutationId, issue: issueObj(repo, issue) });
    }
    case 'addComment': {
      const found = findRepoIssueByGlobalId(forge, String(input.subjectId ?? ''));
      if (!found) throw new Error('subject not found');
      const now = isoNow();
      const comment: Comment = { id: found.repo.nextCommentId++, user: owner, body: String(input.body ?? ''), created_at: now, updated_at: now };
      found.issue.comments.push(comment);
      const commentG = commentObj(found.repo, found.issue, comment);
      return wrap('AddCommentPayload', {
        clientMutationId,
        commentEdge: wrap('IssueCommentEdge', { node: commentG, cursor: cursorOf(found.issue.comments.length - 1) }),
        subject: issueObj(found.repo, found.issue),
      });
    }
    case 'closeIssue': case 'reopenIssue': case 'updateIssue': {
      const found = findRepoIssueByGlobalId(forge, String(input.issueId ?? input.id ?? ''));
      if (!found) throw new Error('issue not found');
      if (name === 'closeIssue') { found.issue.state = 'closed'; found.issue.closed_at = isoNow(); }
      if (name === 'reopenIssue') { found.issue.state = 'open'; found.issue.closed_at = null; }
      if (name === 'updateIssue') {
        if (typeof input.title === 'string') found.issue.title = input.title;
        if (typeof input.body === 'string') found.issue.body = input.body;
        if (input.state === 'OPEN' || input.state === 'CLOSED') {
          found.issue.state = input.state === 'OPEN' ? 'open' : 'closed';
          found.issue.closed_at = found.issue.state === 'closed' ? isoNow() : null;
        }
      }
      found.issue.updated_at = isoNow();
      const payloadType = name === 'closeIssue' ? 'CloseIssuePayload' : name === 'reopenIssue' ? 'ReopenIssuePayload' : 'UpdateIssuePayload';
      return wrap(payloadType, { clientMutationId, issue: issueObj(found.repo, found.issue) });
    }
    case 'createPullRequest': {
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed ? [...forge.repos.values()].find((r) => r.id === Number(parsed.dbId)) : undefined;
      if (!repo) throw new Error('repository not found');
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = resolveRefShim(repo, `refs/heads/${headRef}`);
      const baseSha = resolveRefShim(repo, `refs/heads/${baseRef}`);
      if (!headSha || !baseSha) throw new Error('head or base ref not found');
      const now = isoNow();
      const issue: Issue = {
        id: repo.nextIssueId++,
        number: repo.issues.length ? Math.max(...repo.issues.map((i) => i.number)) + 1 : 1,
        title: String(input.title ?? ''),
        body: (input.body as string) ?? null,
        state: 'open', user: owner, labels: [], comments: [],
        created_at: now, updated_at: now, closed_at: null,
        pull: {
          headRef, headSha: peelToCommit(repo.store, headSha) as string,
          baseRef, baseSha: peelToCommit(repo.store, baseSha) as string,
          merged: false, merged_at: null, merge_commit_sha: null, mergeable: null,
          draft: input.draft === true,
        },
      };
      repo.issues.push(issue);
      return wrap('CreatePullRequestPayload', { clientMutationId, pullRequest: issueObj(repo, issue) });
    }
    case 'mergePullRequest': {
      const found = findRepoIssueByGlobalId(forge, String(input.pullRequestId ?? ''));
      if (!found || !found.issue.pull) throw new Error('pull request not found');
      const { repo, issue } = found;
      const pull = issue.pull;
      const methodRaw = String(input.mergeMethod ?? 'MERGE');
      const method = methodRaw === 'SQUASH' ? 'squash' : methodRaw === 'REBASE' ? 'rebase' : 'merge';
      const baseTip = peelToCommit(repo.store, resolveRefShim(repo, pull.baseRef) as string) as string;
      const headTip = peelToCommit(repo.store, resolveRefShim(repo, `refs/heads/${pull.headRef}`) ?? pull.headSha) as string;
      const headline = (input.commitHeadline as string) ?? (method === 'squash' ? `${issue.title} (#${issue.number})` : `Merge pull request #${issue.number} from ${repo.owner.login}:${pull.headRef}`);
      const outcome = mergeInto(repo, baseTip, headTip, method, headline, owner.name, owner.email);
      if (!outcome.ok) throw new Error('Pull Request is not mergeable');
      repo.refs.set(`refs/heads/${pull.baseRef}`, outcome.sha as string);
      pull.merged = true;
      pull.merged_at = isoNow();
      pull.merge_commit_sha = outcome.sha as string;
      issue.state = 'closed';
      issue.closed_at = pull.merged_at;
      issue.updated_at = pull.merged_at;
      return wrap('MergePullRequestPayload', { clientMutationId, pullRequest: issueObj(repo, issue) });
    }
  }
  return undefined;
}
