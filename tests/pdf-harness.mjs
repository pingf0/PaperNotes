/**
 * PDF 流水线的真机验证：起一个静态服务器（把客户端的 pdf.js / worker 按插件同款路径伺服），
 * 用 Playwright 的真 Chromium 打开测试页，跑一次真实 PDF 的抽取，把结果和裁出来的图导出。
 *
 * 用法：node tests/pdf-harness.mjs [sample.pdf]
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from '/Users/pingfan/Documents/Github/dsh-pet/dsh-pet/node_modules/playwright/index.mjs';

const root = join(import.meta.dirname, '..');
const sample = process.argv[2] ?? join(root, '.tmptest/sample.pdf');
const outDir = join(root, '.tmptest/out');
await mkdir(outDir, { recursive: true });

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.pdf': 'application/pdf',
  '.json': 'application/json; charset=utf-8',
};

/** 把 URL 映射到磁盘文件（限定在 root 内）。 */
function resolveFile(pathname) {
  if (pathname === '/test.html') return join(root, 'tests/pdf-harness.html');
  if (pathname === '/sample.pdf') return sample;
  if (pathname === '/dsh-paper-desk-4821/pdfjs.mjs') return join(root, 'dist/pdfjs.mjs');
  if (pathname === '/dsh-paper-desk-4821/worker') return join(root, 'dist/pdf.worker.mjs');
  if (pathname.startsWith('/client/')) return join(root, 'src/client', pathname.slice('/client/'.length));
  return undefined;
}

const server = createServer(async (req, res) => {
  const file = resolveFile((req.url ?? '/').split('?')[0]);
  if (!file) {
    res.writeHead(404).end('not found');
    return;
  }
  try {
    const bytes = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(bytes);
  } catch (error) {
    res.writeHead(404).end(String(error));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

// 用本机已下载的 1223 版 Chromium（playwright 包要求的 1243 没装）
const executablePath = process.env.PW_CHROMIUM
  ?? '/Users/pingfan/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage();
const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
page.on('pageerror', (error) => errors.push(String(error)));

await page.goto(`http://127.0.0.1:${port}/test.html`);
await page.waitForFunction(() => window.__done === true, undefined, { timeout: 180_000 });
const result = await page.evaluate(() => window.__out);

console.log('errors:', errors.length === 0 ? 'none' : errors.join(' | '));
if (result.error) console.log('ERROR:', result.error);
console.log('pages:', result.pages, 'figures:', result.figures.length, 'textChars:', result.textChars, 'pdfBytes:', result.pdfBytes);
for (const figure of result.figures.slice(0, 4)) {
  console.log(`  [p${figure.page}] ${figure.caption.slice(0, 90)}  (${Math.round(figure.url.length / 1024)}KB)`);
}
for (const [index, figure] of result.figures.slice(0, 3).entries()) {
  const base64 = figure.url.split(',')[1] ?? '';
  await writeFile(join(outDir, `fig-${index + 1}.png`), Buffer.from(base64, 'base64'));
}
await page.screenshot({ path: join(outDir, 'page.png') });
await writeFile(join(outDir, 'extract.json'), JSON.stringify(result));
await browser.close();
server.close();
console.log('saved to', outDir);
