#!/usr/bin/env node
/**
 * server.js —— 零依赖静态服务器，托管 public/ 下的前端页面
 *
 *   npm start                     # 默认 http://127.0.0.1:3000
 *   PORT=4000 npm start           # 指定端口（Windows PowerShell: $env:PORT=4000; npm start）
 *   HOST=0.0.0.0 npm start        # 允许局域网访问
 *
 * GIF 的合成与导出全部在浏览器里完成，服务端只负责把静态资源发出去；
 * 因为不需要任何接口，所以这里只用 Node 内置模块，不引入 Express 等依赖。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const ROOT = path.join(__dirname, 'public');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function send(res, status, body, headers) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, Object.assign({
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': buf.length
  }, headers || {}));
  res.end(buf);
}

/** 把 URL 路径映射到 public/ 下的真实文件，含目录穿越防护与目录索引 */
function resolveFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (e) {
    return null;
  }
  if (decoded.indexOf('\0') !== -1) return null;
  const relative = path.normalize(decoded).replace(/^[/\\]+/, '');
  const file = path.join(ROOT, relative);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return null;
  if (!fs.existsSync(file)) return file;            // 交给读取阶段报 404
  if (fs.statSync(file).isDirectory()) return path.join(file, 'index.html');
  return file;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    return;
  }
  const pathname = url.parse(req.url).pathname;

  if (pathname === '/health') {
    send(res, 200, JSON.stringify({ ok: true, uptime: process.uptime() }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
    return;
  }

  const file = resolveFile(pathname);
  if (!file) {
    send(res, 400, 'Bad Request');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      send(res, 404, '404 Not Found: ' + pathname);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache'
    });
    if (req.method === 'HEAD') res.end();
    else res.end(data);
  });
});

/** 端口被占用时自动向后找可用的端口 */
function listen(port, retriesLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && retriesLeft > 0) {
      console.log('端口 ' + port + ' 已被占用，尝试 ' + (port + 1) + ' …');
      listen(port + 1, retriesLeft - 1);
      return;
    }
    console.error('服务启动失败：' + err.message);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
    console.log('img-compare-gif 已启动：http://' + shown + ':' + port + '/');
    console.log('静态目录：' + ROOT);
  });
}

listen(PORT, 10);
