import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
export async function startFixture(port = 4174) {
  const [home, next, address] = await Promise.all(
    ['fixture.html', 'next.html', 'address.html'].map((f) => readFile(new URL(f, import.meta.url))),
  );
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (!['/', '/next', '/help', '/addresses'].includes(path)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(path === '/' ? home : path === '/addresses' ? address : next);
  });
  await new Promise((ok, no) => {
    server.once('error', no);
    server.listen(port, '127.0.0.1', ok);
  });
  return { server, origin: 'http://localhost:' + server.address().port };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const f = await startFixture();
  console.log('Practice page: ' + f.origin);
}
