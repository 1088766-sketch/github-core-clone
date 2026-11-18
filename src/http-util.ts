// Shared HTTP plumbing for the forge's handlers: JSON responses with the
// headers GitHub sends, body reading, JSON parsing with the 400 the
// protocol checks expect, and Link-header pagination.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';

export const JSON_TYPE = 'application/json; charset=utf-8';

export function requestId(): string {
  return randomBytes(8).toString('hex').toUpperCase();
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '4999',
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
    'x-ratelimit-used': '1',
    'x-ratelimit-resource': 'core',
    ...headers,
  });
  res.end(text);
}

export function sendRaw(res: ServerResponse, status: number, body: Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-length': body.length, 'x-github-request-id': requestId(), ...headers });
  res.end(body);
}

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Parse a JSON body; returns {value} or {error:true} for malformed input. */
export function parseJsonBody(raw: Buffer): { value: Record<string, unknown> } | { error: true } {
  if (raw.length === 0) return { value: {} };
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { value: {} };
    return { value: value as Record<string, unknown> };
  } catch {
    return { error: true };
  }
}

export function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
}

export function badCredentials(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' });
}

export function validationFailed(res: ServerResponse, resource: string, field: string, code = 'custom'): void {
  sendJson(res, 422, {
    message: 'Validation Failed',
    errors: [{ resource, field, code }],
    documentation_url: 'https://docs.github.com/rest',
  });
}

export interface Page { perPage: number; page: number }

export function pageOf(query: URLSearchParams): Page {
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? 30) || 30));
  const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
  return { perPage, page };
}

/** Slice a list for the page and build the GitHub Link header value. */
export function paginate<T>(items: T[], page: Page, baseUrl: string): { slice: T[]; link?: string } {
  const total = items.length;
  const start = (page.page - 1) * page.perPage;
  const slice = items.slice(start, start + page.perPage);
  const lastPage = Math.max(1, Math.ceil(total / page.perPage));
  const parts: string[] = [];
  const url = (p: number) => `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}page=${p}&per_page=${page.perPage}`;
  if (page.page < lastPage) {
    parts.push(`<${url(page.page + 1)}>; rel="next"`);
    parts.push(`<${url(lastPage)}>; rel="last"`);
  }
  if (page.page > 1) {
    parts.push(`<${url(1)}>; rel="first"`);
    parts.push(`<${url(page.page - 1)}>; rel="prev"`);
  }
  return { slice, link: parts.length ? parts.join(', ') : undefined };
}

export function baseUrlOf(req: IncomingMessage, path: string): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}${path}`;
}
