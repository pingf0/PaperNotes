/**
 * 把 PDF 的指定页渲染成 PNG，用于人工核对裁图是否切在了正确的位置。
 * 用法：node tests/render-pages.mjs <pdf> <pages,逗号分隔> <输出目录>
 */
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from '/Users/pingfan/Documents/Github/dsh-pet/dsh-pet/node_modules/playwright/index.mjs';

const root = join(import.meta.dirname, '..');
const pdf = process.argv[2];
const pages = process.argv[3] ?? '1';
const outDir = process.argv[4] ?? join(root, '.tmptest/out/pages');
await mkdir(outDir, { recursive: true });

const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.pdf': 'application/pdf', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const file =
    url.pathname === '/test.html' ? join(root, 'tests/render-pages.html')
    : url.pathname === '/sample.pdf' ? pdf
    : url.pathname === '/dsh-paper-desk-4821/pdfjs.mjs' ? join(root, 'dist/pdfjs.mjs')
    : url.pathname === '/dsh-paper-desk-4821/worker' ? join(root, 'dist/pdf.worker.mjs')
    : undefined;
  if (!file) return res.writeHead(404).end('not found');
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(await readFile(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM
    ?? '/Users/pingfan/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell',
});
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/test.html?pages=${encodeURIComponent(pages)}`);
await page.waitForFunction(() => window.__done === true, undefined, { timeout: 120_000 });
const result = await page.evaluate(() => window.__out);
if (result.error) throw new Error(result.error);
for (const entry of result) {
  const name = join(outDir, `page-${entry.page}.png`);
  await writeFile(name, Buffer.from((entry.url.split(',')[1] ?? ''), 'base64'));
  console.log('saved', name);
}
await browser.close();
server.close();
