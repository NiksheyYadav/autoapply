import type { IncomingMessage, ServerResponse } from 'node:http';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const mod = await import('../../services/auth/src/index.js');
    await mod.default(req, res);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    const body =
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack, cause: String((err as { cause?: unknown }).cause ?? '') }
        : { raw: String(err) };
    res.end(JSON.stringify(body, null, 2));
  }
}
