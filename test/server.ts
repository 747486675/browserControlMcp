import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** 本地测试服务器：静态 fixtures + 下载/慢请求等特殊路由 */
export function startServer(port = 0): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    if (u.pathname === '/file.txt') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="report.txt"' });
      res.end('hello from browser-mcp\n');
      return;
    }
    if (u.pathname === '/slow.bin') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="slow.bin"' });
      res.write(Buffer.alloc(64 * 1024, 1));
      setTimeout(() => res.end(Buffer.alloc(64 * 1024, 2)), 1500);
      return;
    }
    if (u.pathname === '/api/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, at: Date.now() }));
      }, Number(u.searchParams.get('ms') || 800));
      return;
    }
    const file = join(FIXTURES, u.pathname === '/' ? 'index.html' : u.pathname);
    if (!file.startsWith(FIXTURES) || !existsSync(file)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
    });
  });
}

// 直接运行时作为手动测试服务器
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer(8765).then((s) => process.stderr.write(`fixtures at ${s.url}\n`));
}
