import { type IncomingMessage, type ServerResponse } from 'node:http';

export async function bodyJson(req: IncomingMessage, maxBytes = 32_768): Promise<Record<string, unknown>> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const piece of req) {
    const b = Buffer.from(piece);
    size += b.length;
    if (size > maxBytes) throw new Error('request body too large');
    parts.push(b);
  }
  if (!parts.length) return {};
  const data = JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
  if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('JSON object required');
  return data as Record<string, unknown>;
}

export function send(res: ServerResponse, status: number, data: unknown): void {
  const json = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'content-length': Buffer.byteLength(json) });
  res.end(json);
}
export function checkedString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value.length > 150 || !/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}
