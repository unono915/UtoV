/**
 * 화면만 브라우저에서 확인하는 개발용 미리보기 서버.
 *
 *   npm run preview
 *
 * 일렉트론 없이 src/renderer 를 그대로 띄우고, preload 대신
 * scripts/preview-mock.js 를 끼워 넣어 window.utov 를 흉내 낸다.
 * 배포본에는 아무 영향이 없다.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const MOCK = path.join(ROOT, 'scripts', 'preview-mock.js');
const PORT = Number(process.env.PORT) || 5177;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

http
  .createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname).replace(/^\/+/, '');
    const name = rel === '' ? 'index.html' : rel;

    if (name === 'preview-mock.js') {
      res.writeHead(200, { 'Content-Type': MIME['.js'] });
      res.end(fs.readFileSync(MOCK));
      return;
    }

    const file = path.join(RENDERER, name);
    if (path.relative(RENDERER, file).startsWith('..')) {
      res.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(file)) {
      res.writeHead(404).end('없는 파일');
      return;
    }

    let body = fs.readFileSync(file);
    if (name === 'index.html') {
      // CSP 의 script-src 'self' 안에서 도는 별도 파일로 목업을 끼워 넣는다
      body = body
        .toString('utf8')
        .replace('<script src="app.js">', '<script src="preview-mock.js"></script>\n<script src="app.js">');
    }

    res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`\n  화면 미리보기: http://127.0.0.1:${PORT}/\n  (가짜 데이터로 화면만 봅니다. 실제 다운로드는 npm start)\n`);
  });
