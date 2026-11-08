import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { comparisonFixture } from './comparison-lab.mjs';
export async function startFixture(port = 4174) {
  const [home, next, address, trust, downloads, shopping, assist, cleanup, amazon] = await Promise.all(
    [
      'fixture.html',
      'next.html',
      'address.html',
      'trust-lab.html',
      'download-lab.html',
      'shopping-lab.html',
      'assist-lab.html',
      'cleanup-lab.html',
      'amazon-us.html',
    ].map((f) => readFile(new URL(f, import.meta.url))),
  );
  const comparison = comparisonFixture();
  const winscp = await readFile(new URL('winscp-lab.html',import.meta.url));
  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://localhost');
    const path = requestUrl.pathname;
    if (await comparison(req, res, path)) return;
    const practice = /^\/shopping-lab\/(listing|seller|product|amazon-us)$/.test(path);
    const navigation = /^\/(assist-lab|settings-lab)(?:\/[a-z0-9_-]+)?\/?$/.test(path);
    if (
      !practice &&
      !navigation &&
      path !== '/cleanup-lab' &&
      !['/', '/next', '/help', '/addresses', '/trust-lab', '/download-lab'].includes(path)
    ) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(
      navigation
        ? assist
        : path === '/cleanup-lab'
          ? cleanup
          : practice
            ? (path==='/shopping-lab/amazon-us'?amazon:shopping)
            : path === '/'
              ? home
              : path === '/addresses'
                ? address
                : path === '/trust-lab'
                  ? trust
                  : path === '/download-lab'
                    ? (requestUrl.search === '?product=winscp' ? winscp : downloads)
                    : next,
    );
  });
  await new Promise((ok, no) => {
    server.once('error', no);
    server.listen(port, '127.0.0.1', ok);
  });
  return { server, origin: 'http://localhost:' + server.address().port };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flag = process.argv.slice(2).find((a) => a.startsWith('--port='));
  const port = flag ? Number(flag.slice(7)) : 4174;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw Error('Choose a valid loopback port.');
  const f = await startFixture(port);
  console.log('Practice page: ' + f.origin);
  console.log(
    'Website lab: ' +
      f.origin +
      '/trust-lab\nDownload lab: ' +
      f.origin +
      '/download-lab\nShopping lab: ' +
      f.origin +
      '/shopping-lab/listing',
  );
  console.log(
    'Username practice: ' +
      f.origin +
      '/settings-lab\nCleanup practice: ' +
      f.origin +
      '/cleanup-lab',
  );
  console.log('Comparison practice: ' + f.origin + '/comparison-lab/');
}
