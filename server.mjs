// Zero-dependency static file server, sólo para probar la app localmente.
// Uso:  node server.mjs [puerto]      (por defecto 8080)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.argv[2]) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(req.url.split('?')[0]);
    if (path === '/') path = '/index.html';
    const full = normalize(join(root, path));
    if (!full.startsWith(root)) throw { code: 'FORBIDDEN' };
    const s = await stat(full);
    if (s.isDirectory()) throw { code: 'ENOENT' };
    const body = await readFile(full);
    res.writeHead(200, { 'Content-Type': TYPES[extname(full)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404');
  }
}).listen(port, () => {
  console.log(`Servidor local en http://localhost:${port}`);
  console.log('Para probar desde el celular Android por USB:');
  console.log(`  adb reverse tcp:${port} tcp:${port}`);
  console.log(`  luego abrí http://localhost:${port} en Chrome del celular`);
});
