'use strict';
/**
 * 화면(renderer)을 127.0.0.1 의 임의 포트로 서빙한다.
 *
 * file:// 로 띄우면 출처가 null 이라 유튜브 미리보기 iframe 이 막힌다.
 * 평범한 http 출처를 주기 위한 최소한의 정적 서버이고,
 * 루프백에만 바인딩한 뒤 임의 토큰 경로 아래에서만 파일을 내준다.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function start(rootDir) {
  return new Promise((resolve, reject) => {
    const token = crypto.randomBytes(16).toString('hex');
    const prefix = '/' + token + '/';

    const server = http.createServer((req, res) => {
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      } catch {
        res.writeHead(400).end();
        return;
      }

      if (!pathname.startsWith(prefix)) {
        res.writeHead(404).end();
        return;
      }

      let rel = pathname.slice(prefix.length);
      if (rel === '' || rel.endsWith('/')) rel += 'index.html';

      const file = path.join(rootDir, rel);
      const inside = path.relative(rootDir, file);
      if (inside.startsWith('..') || path.isAbsolute(inside)) {
        res.writeHead(403).end();
        return;
      }

      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('없는 파일');
          return;
        }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(data);
      });
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        token,
        url: 'http://127.0.0.1:' + port + prefix + 'index.html',
        origin: 'http://127.0.0.1:' + port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { start };
