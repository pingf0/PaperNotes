/**
 * 构建脚本：把浏览器半侧打成 client.js，把 pdf.js 与它的 worker 打成静态资源。
 *
 * 为什么要自建产物：DSH 的插件 client 必须是"加载即调用 window.__ModuleLoader__.load"的
 * 普通脚本，而 pdf.js 是几 MB 的 ESM 库。所以主 bundle 只装我们自己的代码（react 由宿主
 * 的模块表通过 factory 的 require 提供），pdf.js 单独成文件、由宿主当静态资源伺服、
 * 用户第一次导入论文时才动态 import——不导入论文的会话完全不为它付代价。
 */
import { build } from 'esbuild';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

/** 打主 bundle（client 半侧）。 */

/**
 * KaTeX 样式：把 woff2 字体直接内联成 data URL，生成 dist/katex.css。
 * 内联的理由：字体只认 woff2（Chromium/Safari 都支持），这样公式渲染不再依赖任何静态路由，
 * 插件换代码只需热更 client.js 一处，不会出现"公式能渲染但字体 404、间距全乱"的半成品状态。
 */
const katexDist = join(root, 'node_modules/katex/dist');
const rawCss = await readFile(join(katexDist, 'katex.min.css'), 'utf8');
const fontFiles = new Set();
const withDataUrls = [];
for (const match of rawCss.matchAll(/url\(fonts\/([\w-]+)\.woff2\)/g)) fontFiles.add(match[1]);
for (const name of fontFiles) {
  const base64 = (await readFile(join(katexDist, 'fonts', `${name}.woff2`))).toString('base64');
  withDataUrls.push([name, base64]);
}
const dataUrlByName = new Map(withDataUrls.map(([name, base64]) => [name, `data:font/woff2;base64,${base64}`]));
const inlinedCss = rawCss
  .replace(/url\(fonts\/([\w-]+)\.woff2\)/g, (_m, name) => `url(${dataUrlByName.get(name)})`)
  .replace(/,url\(fonts\/[^)]+\)/g, '');
await rm(join(root, 'dist/katex-fonts'), { recursive: true, force: true });
await writeFile(join(root, 'dist/katex.css'), inlinedCss, 'utf8');
console.log(`inlined ${dataUrlByName.size} katex fonts into dist/katex.css (${Math.round(inlinedCss.length / 1024)}KB)`);

await build({
  entryPoints: [join(root, 'src/client/index.jsx')],
  outfile: join(root, 'client.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110', 'safari16'],
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
  loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
});

/** 打 pdf.js 本体（ESM，供浏览器动态 import）。 */
await build({
  entryPoints: [join(root, 'node_modules/pdfjs-dist/build/pdf.mjs')],
  outfile: join(root, 'dist/pdfjs.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome110', 'safari16'],
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
});

/** 打 pdf.js 的 worker（ESM，由宿主按 workerSrc 加载）。 */
await build({
  entryPoints: [join(root, 'node_modules/pdfjs-dist/build/pdf.worker.mjs')],
  outfile: join(root, 'dist/pdf.worker.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome110', 'safari16'],
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
});

await rm(join(root, 'dist/pdfjs.mjs.map'), { force: true });
await rm(join(root, 'dist/pdf.worker.mjs.map'), { force: true });
console.log('built client.js + dist/pdfjs.mjs + dist/pdf.worker.mjs');
