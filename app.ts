// The forge's HTTP surface: health probe, the API root, REST v3,
// GraphQL v4, the MCP endpoint and git smart HTTP, all behind the shop
// token's bearer auth. main.ts owns the entry <-> env lifecycle; this
// file is the server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './src/store.ts';
import { handleRest } from './src/rest.ts';
import { handleGitHttp } from './src/git-http.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { sendJson, readBody, parseJsonBody, notFound, badCredentials } from './src/http-util.ts';

const API_ROOT: Record<string, string> = {
  current_user_url: '/api/v3/user',
  current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
  repository_url: '/api/v3/repos/{owner}/{repo}',
  issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
  issues_url: '/api/v3/issues',
  labels_search_url: '/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}',
  rate_limit_url: '/api/v3/rate_limit',
  repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
  user_url: '/api/v3/users/{user}',
  user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
};

export function createApp(): Server {
  const forge = new Forge();
  const shopToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const authorized = (req: IncomingMessage): boolean => {
    if (!shopToken) return true; // local dev without a configured token
    const header = req.headers.authorization ?? '';
    return header === `Bearer ${shopToken}`;
  };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (!authorized(req)) {
          badCredentials(res);
          return;
        }

        const seg = path.split('/').filter((s) => s.length > 0);

        // API root
        if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
          sendJson(res, 200, API_ROOT, { 'x-oauth-scopes': 'repo, read:org', 'x-accepted-oauth-scopes': 'repo, read:org' });
          return;
        }

        // meta (GitHub Enterprise style version probe the suite checks)
        if (method === 'GET' && path === '/api/v3/meta') {
          sendJson(res, 200, {
            verifiable_password_authentication: false,
            installed_version: '3.10.0',
            hooks: [],
            git: [],
            pages: [],
            importer: [],
          });
          return;
        }

        // rate limit
        if (method === 'GET' && path === '/api/v3/rate_limit') {
          const reset = Math.floor(Date.now() / 1000) + 3600;
          const bucket = { limit: 5000, remaining: 4999, reset, used: 1 };
          sendJson(res, 200, { resources: { core: bucket, search: { limit: 30, remaining: 30, reset, used: 0 }, graphql: bucket }, rate: bucket });
          return;
        }

        // MCP
        if (path === '/mcp') {
          const rawBody = await readBody(req);
          handleMcp({ forge, req, res, rawBody });
          return;
        }

        // GraphQL
        if (path === '/api/graphql' && method === 'POST') {
          const rawBody = await readBody(req);
          let body: unknown;
          try {
            body = JSON.parse(rawBody.toString('utf8'));
          } catch {
            sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
            return;
          }
          handleGraphql({ forge, req, res, body });
          return;
        }

        // REST v3
        if (seg[0] === 'api' && seg[1] === 'v3') {
          const rawBody = await readBody(req);
          let body: Record<string, unknown> = {};
          if (rawBody.length > 0 && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
            const parsed = parseJsonBody(rawBody);
            if ('error' in parsed) {
              sendJson(res, 400, { message: 'Problems parsing JSON' });
              return;
            }
            body = parsed.value;
          }
          const handled = handleRest({ forge, req, res, seg: seg.slice(2), query: url.searchParams, body });
          if (!handled) notFound(res);
          return;
        }

        // git smart HTTP: /<owner>/<repo>.git/...
        if (seg.length >= 3 && (seg[2] === 'info' || seg[2] === 'git-upload-pack' || seg[2] === 'git-receive-pack')) {
          const rawBody = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
          const handled = handleGitHttp({ forge, req, res, seg, query: url.searchParams, rawBody });
          if (!handled) notFound(res);
          return;
        }

        notFound(res);
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: `Internal error: ${err instanceof Error ? err.message : 'unknown'}` });
        } else {
          res.end();
        }
      }
    })();
  });
}
