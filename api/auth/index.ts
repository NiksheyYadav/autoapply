import type { IncomingMessage, ServerResponse } from 'node:http';

export default async function handler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/plain');
  res.end('diagnostic ok');
}
