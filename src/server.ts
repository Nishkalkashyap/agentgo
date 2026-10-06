import { createServer, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createMcpHandler, isLegacyRequest, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { AgentService } from './service.js';
import { createAgentMcpServer } from './mcp.js';
import { AgentError } from './errors.js';

export const MAX_REQUEST_BYTES = 512 * 1024;
export function secretMatches(actual: string | undefined, expected: string) {
  return !!actual && timingSafeEqual(createHash('sha256').update(actual).digest(), createHash('sha256').update(expected).digest());
}
export function createAgentHttpServer(options: { service: AgentService; token: string | (() => Promise<string>); publicURL?: string }) {
  if (typeof options.token === 'string' && options.token.length < 32) throw new AgentError('WEAK_TOKEN', 'Use a token of at least 32 characters.');
  let publicURL = options.publicURL;
  const factory = () => createAgentMcpServer(options.service);
  const modern = createMcpHandler(factory, { legacy: 'reject', responseMode: 'json', maxSubscriptions: 0, maxRequestBodySize: MAX_REQUEST_BYTES });
  const handle = toNodeHandler({ fetch: async (request, requestOptions) => {
    if (!await isLegacyRequest(request, requestOptions?.parsedBody, { maxRequestBodySize: MAX_REQUEST_BYTES })) return modern.fetch(request, requestOptions);
    const mcp = factory();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: MAX_REQUEST_BYTES });
    await mcp.connect(transport);
    try { return await transport.handleRequest(request, requestOptions); }
    finally { await mcp.close(); }
  } }, { maxRequestBodySize: MAX_REQUEST_BYTES });
  function json(response: ServerResponse, status: number, data: unknown) {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data));
  }
  let inFlight = 0;
  let count = 0;
  let window = Date.now();
  const server = createServer((request, response) => {
    void (async () => {
      const hosts = ['127.0.0.1', 'localhost', ...(publicURL ? [new URL(publicURL).hostname] : [])];
      if (!hostHeaderValidation(hosts)(request, response) || !originValidation(hosts)(request, response)) return;
      if (Date.now() - window >= 60_000) { window = Date.now(); count = 0; }
      if (++count > 600 || inFlight >= 16) { response.setHeader('Retry-After', '5'); return json(response, 429, { error: 'Too many requests' }); }
      inFlight++;
      try {
        const token = typeof options.token === 'string' ? options.token : await options.token();
        if (!secretMatches(request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1], token)) {
          response.setHeader('WWW-Authenticate', 'Bearer realm="agentgo"');
          return json(response, 401, { error: 'Unauthorized' });
        }
        if (request.url === '/health' && request.method === 'GET') return json(response, 200, { status: 'ok' });
        if (request.url !== '/mcp') return json(response, 404, { error: 'Not found' });
        if (request.method !== 'POST') return json(response, 405, { error: 'Use MCP HTTP POST. SSE is disabled.' });
        if (!request.headers['content-type']?.startsWith('application/json')) return json(response, 415, { error: 'Use application/json' });
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > MAX_REQUEST_BYTES) { json(response, 413, { error: 'Request exceeds 512 KiB.' }); return; }
          chunks.push(Buffer.from(chunk));
        }
        let body: unknown;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return json(response, 400, { error: 'Invalid JSON' }); }
        await handle(request, response, body);
      } finally { inFlight--; }
    })().catch(() => { if (!response.headersSent) json(response, 500, { error: 'Request failed' }); else response.destroy(); });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  return {
    server,
    setPublicURL(url?: string) { publicURL = url; },
    async listen(port = 0) {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('HTTP listener unavailable');
      return `http://127.0.0.1:${address.port}`;
    },
    async close() {
      await modern.close();
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    },
  };
}
