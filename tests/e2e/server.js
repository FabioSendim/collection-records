const http = require('node:http');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const html = readFileSync(join(__dirname, '..', '..', 'index.html'));
const hostedHTML = readFileSync(join(__dirname, '..', '..', 'dist', 'index.html'));
const port = Number(process.env.PORT || 4173);

http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (request.method !== 'GET' || !['/', '/index.html', '/hosted.html'].includes(pathname)) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/html; charset=utf-8'
  });
  response.end(pathname === '/hosted.html' ? hostedHTML : html);
}).listen(port, '127.0.0.1');
