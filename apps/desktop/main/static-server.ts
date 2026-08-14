import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';

/**
 * A minimal static file server for projects that have no build step.
 *
 * When the user picks "plain HTML/CSS/JS", Claude writes an index.html and no
 * package.json, so there is no dev server to run — but there is absolutely
 * something to preview. Opening the file over `file://` would break relative
 * fetches and give the page a null origin, so we serve it over http instead.
 *
 * Bound to loopback only, and it will not serve anything outside the project
 * directory.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export interface StaticServer {
  url: string;
  close(): void;
}

export async function startStaticServer(root: string): Promise<StaticServer> {
  const rootPath = path.resolve(root);

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const requested = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
        const relative = requested.replace(/^\/+/, '');
        let target = path.resolve(rootPath, relative);

        // Path traversal guard: everything served must live under the project.
        if (target !== rootPath && !target.startsWith(rootPath + path.sep)) {
          res.writeHead(403).end('Forbidden');
          return;
        }

        let info = await stat(target).catch(() => null);
        if (info?.isDirectory()) {
          target = path.join(target, 'index.html');
          info = await stat(target).catch(() => null);
        }

        if (!info?.isFile()) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(`Not found: ${requested}`);
          return;
        }

        res.writeHead(200, {
          'content-type': CONTENT_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
          // The preview should always reflect the file Claude just wrote.
          'cache-control': 'no-store',
        });
        createReadStream(target).pipe(res);
      } catch {
        res.writeHead(500).end('Server error');
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Port 0 lets the OS pick a free one, so we never collide with the user's
    // own servers.
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://localhost:${port}`,
    close: () => server.close(),
  };
}
