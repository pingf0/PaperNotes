import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from '/Users/pingfan/Documents/Github/dsh-pet/dsh-pet/node_modules/playwright/index.mjs';

const root = join(import.meta.dirname, '..');
const pdf = process.argv[2];
const pages = process.argv[3] ?? '1';
const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.pdf': 'application/pdf' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const file =
    url.pathname === '/test.html' ? join(root, 'tests/probe-ops.html')
    : url.pathname === '/sample.pdf' ? pdf
    : url.pathname === '/dsh-paper-desk-4821/pdfjs.mjs' ? join(root, 'dist/pdfjs.mjs')
    : url.pathname === '/dsh-paper-desk-4821/worker' ? join(root, 'dist/pdf.worker.mjs')
    : undefined;
  if (!file) return res.writeHead(404).end('x');
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(await readFile(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ executablePath: '/Users/pingfan/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell' });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/test.html?pages=${pages}`);
await page.waitForFunction(() => window.__done === true, undefined, { timeout: 120000 });
console.log(JSON.stringify(await page.evaluate(() => window.__out)));
await browser.close();
server.close();
