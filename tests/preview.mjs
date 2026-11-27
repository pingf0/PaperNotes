/**
 * 可视化预览台：不打开 DSH，也能把论文台的界面和流程跑一遍。
 *
 * 做三件事：
 *   1) 用真正的 src/host/server.js 提供插件路由（临时 DSH_HOME）；
 *   2) 种两篇示例论文（节点、图、笔记、会话、core 都有内容）；
 *   3) 用 Playwright 打开预览页 → 走一遍论文库 / 画布 / 会话 / 笔记 / core / 对比，逐步截图。
 *
 * 用法：node tests/preview.mjs
 */
import { createServer as createHttpServer } from 'node:http';
import { copyFile, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromiumPath, hasPlaywright, playwrightEntry, samplePdf, skip, themeDir } from './env.mjs';

if (!hasPlaywright()) skip('没装 playwright（pnpm add -D playwright && npx playwright install chromium）');
const { chromium } = await import(playwrightEntry());

const root = join(import.meta.dirname, '..');
/** 被测包根目录：默认工作区，可用 PD_PACKAGE 指向已安装的代（验证装进去的那份）。 */
const pkgRoot = process.env.PD_PACKAGE ? resolve(process.env.PD_PACKAGE) : root;
const home = join(root, '.tmptest/home');
const outDir = join(root, '.tmptest/preview');
const shotDir = join(outDir, 'shots');
await rm(home, { recursive: true, force: true });
await mkdir(join(outDir, 'shots'), { recursive: true });
process.env.DSH_HOME = home;

const PREFIX = '/dsh-paper-desk-4821';
/**
 * DSH 源码里的主题样式：预览台直接引真实变量，明暗两套都要验。
 * 没配 `PN_THEME_DIR` 时用一份等价的最小变量表（颜色可能和真机略有差异，但结构一致）。
 */
const THEME_DIR = themeDir();
const { createServer } = await import(pathToFileURL(join(pkgRoot, 'src/host/server.js')).href);
const store = await import(pathToFileURL(join(pkgRoot, 'src/host/store.js')).href);

/* ---------- 1. 种数据 ---------- */
const dir = join(home, 'paper-desk/data');
await mkdir(join(dir, 'papers'), { recursive: true });

/**
 * 取一张图当素材：优先用仓库里带的 `tests/fixtures`（自包含，谁 clone 都能跑），
 * 没有再退回本地 PDF 抽取产物 `.tmptest/out`。
 */
async function figure(paperId, index, sourceName) {
  const file = `fig-${index}.png`;
  const fixture = join(root, 'tests/fixtures', sourceName);
  const fallback = join(root, '.tmptest/out', sourceName);
  const source = await readFile(fixture).catch(() => readFile(fallback));
  await store.writeFigure(dir, paperId, file, source.toString('base64'));
  return file;
}

const catA = { id: 'c-continual', name: 'continual-learning', createdAt: Date.now() - 86_400_000 * 40 };
const catB = { id: 'c-cross', name: 'cross-domain-learning', createdAt: Date.now() - 86_400_000 * 39 };

const paper1 = {
  id: 'p-ewc',
  title: 'Overcoming catastrophic forgetting in neural networks',
  abstract: '用 Fisher 信息给重要权重加二次惩罚，在不存旧数据的前提下抑制灾难性遗忘。',
  categoryId: catA.id,
  createdAt: Date.now() - 86_400_000 * 30,
  lastOpenedAt: Date.now() - 86_400_000 * 21,
  blocks: [
    { id: 'b-motivation', type: 'motivation', title: '解决的问题与动机', text: '该式将跨域融合序列、混合域序列和用户或混合域表示加权组合。α、β、γ为可学习权重。\\mathbf{z}_u^{final}随后用于计算目标item的偏好得分。神经网络顺序学习多个任务时会灾难性遗忘：新任务一训练，旧任务的性能就塌掉。但很多场景（隐私、存储、算力）不允许保留旧数据做联合训练，所以需要一种“不回放旧数据”的持续学习办法。', x: 40, y: 32, w: 300 },
    { id: 'b-principle', type: 'principle', title: '核心原理：重要权重别乱动', text: '该式将跨域融合序列、混合域序列和用户或混合域表示加权组合。α、β、γ为可学习权重。\\mathbf{z}_u^{final}随后用于计算目标item的偏好得分。\n\n把“参数有多重要”量化为 Fisher 信息矩阵的对角元：对旧任务输出影响大的参数，惩罚系数就大。训练新任务时在损失里加一项 Σ F_i (θ_i - θ*_i)²，让重要参数留在旧值附近，不重要的参数自由迁移。多个任务依次到来时，各项惩罚累加，等价于在高斯近似下做贝叶斯后验更新。', figureId: 'f-1', x: 40, y: 330, w: 340 },
    { id: 'b-formula-1', type: 'formula', title: 'EWC 损失', latex: 'L(θ) = L_B(θ) + Σ_i (λ/2) F_i (θ_i - θ*_{A,i})²', section: '3.2 Method', where: '训练损失那一支（惩罚项）', figureRef: 'f-1', text: '第一项是新任务的损失，第二项是约束项；λ 控制“记住旧任务”和“学好新任务”的权衡。', x: 450, y: 32, w: 300 },
    { id: 'b-formula-2', type: 'formula', title: 'Fisher 信息', latex: 'F_i = E[(∂/∂θ_i log p(y|x,θ))²]', text: 'Fisher 信息衡量第 i 个参数对似然的敏感度，这里用训练集上的经验值近似，只取对角（省算力）。', x: 450, y: 312, w: 300 },
    { id: 'b-result-1', type: 'result', title: '在 permuted MNIST 上几乎不遗忘', text: '三个随机置换任务依次训练后，EWC 在每个任务上的准确率都保持在 90% 以上，而普通 SGD 会掉到随机水平。', figureId: 'f-2', x: 860, y: 330, w: 300 },
  ],
  edges: [
    { from: 'b-motivation', to: 'b-principle' },
    { from: 'b-principle', to: 'b-formula-1' },
    { from: 'b-principle', to: 'b-formula-2' },
    { from: 'b-formula-1', to: 'b-result-1' },
    { from: 'b-principle', to: 'b-result-1' },
  ],
  figures: [
    { id: 'f-1', file: await figure('p-ewc', 1, 'fig-1.png'), caption: 'Figure 1: elastic weight consolidation (EWC) ensures task A is remembered whilst training on task B', page: 3, section: '3.2 Method' },
    { id: 'f-2', file: await figure('p-ewc', 2, 'fig-2.png'), caption: 'Figure 2: Results on the permuted MNIST task.', page: 4, section: '4.5 Results' },
  ],
  notes: [
    { id: 'n-1', kind: 'user', blockId: null, text: 'FWT / BWT 这两个持续学习指标我一直没分清：FWT 看的是「学新任务对旧任务的影响」，BWT 看的是「学了新任务之后回头测旧任务的变化」。这篇论文只报了 ACC，没报 BWT。', createdAt: Date.now() - 86_400_000 * 20 },
    { id: 'n-2', kind: 'ai', blockId: 'b-principle', text: '- Fisher 对角近似 = 把参数相关性丢掉，只保留每个参数自己的重要性。\n- 惩罚项是「二次势阱」：离旧值越远代价越大，λ 决定井壁陡不陡。\n- 多任务情形下惩罚累加，等价于高斯后验的乘积。', createdAt: Date.now() - 86_400_000 * 19 },
  ],
  chats: [
    {
      blockId: null,
      messages: [
        { role: 'user', content: '这篇的核心贡献是什么？', ts: Date.now() - 86_400_000 * 20 },
        { role: 'assistant', content: '一句话：**用 Fisher 信息给参数标重要度**，训练新任务时只允许不重要的参数大改，从而在不存旧数据的前提下抑制遗忘。', ts: Date.now() - 86_400_000 * 20 },
      ],
    },
    {
      blockId: 'b-principle',
      messages: [
        { role: 'user', content: '为什么用 Fisher 信息而不是直接用梯度大小？', ts: Date.now() - 86_400_000 * 20 },
        { role: 'assistant', content: '梯度是**一阶**量，反映的是「当前这一点往哪走能降低损失」，会随训练点漂移、正负抵消；Fisher 信息是损失曲率的一阶近似（对数似然的二阶量），衡量「参数动了之后似然掉多少」，正好对应「这个参数对旧任务有多重要」。所以它是**离旧最优点的稳定度**，不是优化方向。', ts: Date.now() - 86_400_000 * 20 },
      ],
    },
  ],
  core: {
    text: '## 一句话总结\n用 Fisher 信息给每个参数标一个「重要度」，训练新任务时只允许不重要的参数大改，从而不存旧数据也能记住旧任务。\n\n## 它解决什么问题\n顺序多任务训练中的灾难性遗忘，且约束是「不能保留旧数据」。\n\n## 核心思路\n二次惩罚把重要参数拴在旧最优点附近；多任务时惩罚累加 ≈ 高斯后验连乘。\n\n## 关键公式\n`L(θ) = L_B(θ) + Σ (λ/2) F_i (θ_i - θ*_i)²`\n\n## 主要结果\npermuted MNIST 上三个任务后仍保持 90%+，SGD 掉到随机水平。\n\n## 我没想通的地方\nFisher 只取对角，参数间相关性被丢掉——这种近似在什么规模下会失效？论文没给边界。\n\n## 下次复习先看这三件事\n1. Fisher 与 Hessian 的关系；2. λ 的敏感性实验；3. 和 SI / MAS 的差异。',
    updatedAt: Date.now() - 86_400_000 * 18,
  },
  layout: { panX: 0, panY: 0 },
};

const paper2 = {
  id: 'p-pnn',
  title: 'Progressive Neural Networks',
  abstract: '为每个新任务新开一列网络，用侧向连接复用旧列特征，从结构上杜绝遗忘。',
  categoryId: catB.id,
  createdAt: Date.now() - 86_400_000 * 12,
  lastOpenedAt: Date.now() - 86_400_000 * 2,
  blocks: [
    { id: 'b-motivation', type: 'motivation', title: '解决的问题与动机', text: '该式将跨域融合序列、混合域序列和用户或混合域表示加权组合。α、β、γ为可学习权重。\\mathbf{z}_u^{final}随后用于计算目标item的偏好得分。参数共享式的持续学习要么遗忘、要么容量受限。能不能让「旧任务完全不改」，只在新任务上加结构？', x: 40, y: 32, w: 300 },
    { id: 'b-principle', type: 'principle', title: '核心原理：列式增长 + 侧向连接', text: '每个任务一列独立参数，永不改动；新列通过侧向连接读取旧列各层的激活，用可学习权重做特征复用。于是旧任务的前向路径完全冻结，遗忘在结构上不可能发生；代价是参数量随任务数线性增长。', figureId: 'f-1', x: 40, y: 330, w: 340 },
    { id: 'b-formula-1', type: 'formula', title: '第 k 列的激活', latex: 'h_i^{(k)} = f(W_i^{(k)} h_{i-1}^{(k)} + Σ_{j<k} U_i^{(k,j)} h_{i-1}^{(j)})', section: '3.2 Method', where: '每一列的输入端（侧向连接）', figureRef: 'f-1', text: 'W 是本列自己的权重，U 是来自旧列的侧向连接；求和项让新任务能借用旧特征。', x: 450, y: 32, w: 300 },
    { id: 'b-result-1', type: 'result', title: '完全不遗忘，但参数线性增长', text: '在 Atari 与迷宫任务上，学完新任务后旧任务性能完全不变（因为参数冻结）；参数量与任务数成正比。', x: 860, y: 330, w: 300 },
  ],
  edges: [
    { from: 'b-motivation', to: 'b-principle' },
    { from: 'b-principle', to: 'b-formula-1' },
    { from: 'b-principle', to: 'b-result-1' },
  ],
  figures: [{ id: 'f-1', file: await figure('p-pnn', 1, 'fig-3.png'), caption: 'Figure 3: Results on Atari task.', page: 6, section: '4.2 Atari' }],
  notes: [{ id: 'n-3', kind: 'user', blockId: null, text: '和 EWC 的根本差别：EWC 改的是损失，PNN 改的是结构。', createdAt: Date.now() - 86_400_000 * 2 }],
  chats: [
    {
      blockId: null,
      messages: [
        { role: 'user', content: '为什么不直接微调？', ts: Date.now() - 86_400_000 * 2 },
        { role: 'assistant', content: '因为会遗忘：新列学完，旧列若被一起更新，旧任务性能就掉了。PNN 的做法是**旧列完全冻结**，只用侧向连接复用特征。', ts: Date.now() - 86_400_000 * 2 },
      ],
    },
  ],
  core: { text: '', updatedAt: 0 },
  layout: { panX: 0, panY: 0 },
};

const index = {
  version: 1,
  categories: [catA, catB],
  papers: [paper1, paper2].map((paper) => ({
    id: paper.id,
    title: paper.title,
    abstract: paper.abstract,
    categoryId: paper.categoryId,
    createdAt: paper.createdAt,
    lastOpenedAt: paper.lastOpenedAt,
    blockCount: paper.blocks.length,
    noteCount: paper.notes.length,
    questionCount: paper.chats.reduce((sum, chat) => sum + chat.messages.filter((m) => m.role === 'user').length, 0),
    hasCore: Boolean(paper.core.text),
    thumb: paper.figures[0]?.file ?? null,
    warning: null,
  })),
};
await store.writeIndex(dir, index);
// 给示例论文塞一份真实 PDF，用来验原文查看器与「重新裁图」
const samplePdfPath = samplePdf();
for (const id of ['p-ewc', 'p-pnn']) {
  if (samplePdfPath) await copyFile(samplePdfPath, join(dir, 'papers', id, 'source.pdf')).catch(() => undefined);
}
for (const paper of [paper1, paper2]) await store.writePaper(dir, paper.id, paper);

/* ---------- 2. 给预览页准备 react ESM ---------- */
await build({
  stdin: {
    contents: `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nexport { React, createRoot };\nexport const Fragment = React.Fragment;\n`,
    resolveDir: '/Users/pingfan/Documents/Github/dsh-pet/dsh-pet',
    loader: 'js',
  },
  outfile: join(outDir, 'react.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'error',
});

/* ---------- 3. 起服务 ---------- */
const handler = createServer({ get: () => undefined, logger: { info() {}, warn: console.warn } }, PREFIX);
/** 置 true 时 /health 按旧一代的字段返回（没有 assets），用来验"旧代码横幅"。 */
let legacyHealth = false;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };

const server = createHttpServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (legacyHealth && url.pathname === `${PREFIX}/health`) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, dir: join(home, 'paper-desk/data'), llmReady: true, assets: { pdfjs: false, worker: false } }));
    return;
  }
  if (url.pathname === `${PREFIX}/compare/chat/stream` && req.method === 'POST') {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
    const frame = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    await (async () => {
      frame({ type: 'reasoning', text: '先看两篇的损失函数差异…' });
      await wait(80);
      const body = ['**结论**：', '假回答：', '两篇的假设不同。'];
      for (const piece of body) {
        await wait(60);
        frame({ type: 'text', text: piece });
      }
      frame({ type: 'done', text: body.join('') });
      res.end();
    })();
    return;
  }
  if (url.pathname === `${PREFIX}/paper/chat/stream` && req.method === 'POST') {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
    const frame = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    await (async () => {
      frame({ type: 'reasoning', text: '先看摘录里有没有定义好的记号…' });
      await wait(120);
      frame({ type: 'reasoning', text: '再说结论，最后给依据。' });
      const body = ['**结论**：', '这是预览环境的假回答，', '用来验证流式渲染。', '', '依据：摘录里没有提到具体超参。'];
      for (const piece of body) {
        await wait(80);
        frame({ type: 'text', text: piece });
      }
      await wait(120);
      frame({
        type: 'done',
        messages: [
          { role: 'user', content: '预览提问', ts: Date.now() },
          { role: 'assistant', content: body.join(''), ts: Date.now() },
        ],
      });
      res.end();
    })();
    return;
  }
  if (url.pathname.startsWith(PREFIX)) return handler(req, res);
  const map = {
    '/dev/react.mjs': join(outDir, 'react.mjs'),
    '/client.js': join(pkgRoot, 'client.js'),
    '/client/api.js': join(pkgRoot, 'src/client/api.js'),
    '/client/pdf.js': join(pkgRoot, 'src/client/pdf.js'),
    '/dist/pdfjs.mjs': join(pkgRoot, 'dist/pdfjs.mjs'),
    '/dist/pdf.worker.mjs': join(pkgRoot, 'dist/pdf.worker.mjs'),
    '/preview.html': join(root, 'tests/preview.html'),
    ...(THEME_DIR
      ? { '/theme.css': join(THEME_DIR, 'design-platform.css'), '/base.css': join(THEME_DIR, 'base.css') }
      : {}),
  };
  const file = map[url.pathname];
  if (!file) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(await readFile(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

/* ---------- 4. 跑一遍并截图 ---------- */
const executablePath = process.env.PW_CHROMIUM ?? chromiumPath();
const browser = await chromium.launch(executablePath ? { executablePath } : {});
let page = await browser.newPage({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
const errors = [];
page.on('pageerror', (error) => {
  errors.push('pageerror: ' + String(error));
  console.log('PAGEERROR:', String(error).slice(0, 300), (error?.stack ?? '').split('\n').slice(1, 4).join(' | '));
});
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  const text = message.text();
  // 浏览器自己的"资源加载失败"会把预期内的 502/404 也当错误（例如没有模型时的重新分析），
  // 真正的 JS 异常由 pageerror 兜住，这里只忽略这类网络提示。
  if (/Failed to load resource/.test(text)) return;
  errors.push('console: ' + text);
});

let themeTag = 'light';
const shot = async (name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(shotDir, `${themeTag}-${name}.png`) });
  console.log('shot', themeTag, name);
};

const runFlow = async () => {
  await page.goto(`http://127.0.0.1:${port}/preview.html${themeTag === 'dark' ? '?dark=1' : ''}`);
await page.waitForSelector('.pd-paper');
await shot('02-library');

// 右键菜单：移动到分类 / 复制到分类
const openMenu = async () => {
  await page.locator('.pd-paper').first().click({ button: 'right' });
  await page.waitForSelector('.pd-menu');
};
const categoryOfFirst = async () => {
  const state = await page.evaluate(async () => (await fetch('/dsh-paper-desk-4821/state')).json());
  const first = await page.locator('.pd-paper').first().locator('.pd-paper-title').innerText();
  const hit = state.papers.find((paper) => paper.title === first);
  return { paper: hit, state };
};

await openMenu();
await shot('02b-context-menu');
// 菜单顺序：移动到(0..n-1) → 复制到(n..2n-1) → 打开 → 删除；这里 n=3
await page.locator('.pd-menu-item').nth(0).click();
await page.waitForTimeout(400);
const moved = await categoryOfFirst();
if (moved.paper && moved.paper.categoryId !== null) errors.push(`移动到「未分类」没生效：${moved.paper.categoryId}`);

await openMenu();
await page.locator('.pd-menu-item').nth(1).click();
await page.waitForTimeout(400);
const movedBack = await categoryOfFirst();
if (movedBack.paper && movedBack.paper.categoryId === null) errors.push('移动回分类没生效');

await openMenu();
await page.locator('.pd-menu-item').nth(4).click();
await page.waitForFunction(() => document.querySelectorAll('.pd-paper').length === 3, undefined, { timeout: 5000 }).catch(() => errors.push('复制到分类后没有出现副本'));
const titles = await page.locator('.pd-paper-title').allInnerTexts();
if (titles.every((title) => !title.includes('（副本）'))) errors.push('副本标题没有标记：' + titles.join(' / '));
await shot('02c-paper-copied');

// 清掉副本，保持后续步骤的数据一致
await page.evaluate(async () => {
  const state = await (await fetch('/dsh-paper-desk-4821/state')).json();
  const copy = state.papers.find((paper) => paper.title.includes('（副本）'));
  if (copy) await fetch('/dsh-paper-desk-4821/paper?id=' + encodeURIComponent(copy.id), { method: 'DELETE' });
});
await page.reload();
await page.waitForSelector('.pd-paper');

// 收起侧边栏时宿主会在 frame 上发布 --dsh-frame-leading-clearance，
// 工具栏必须自己让开这段，否则标题会压在红绿灯/伸缩按钮下面。
const paddingBefore = await page.locator('.pd-top').evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
await page.locator('#frame').evaluate((el) => el.style.setProperty('--dsh-frame-leading-clearance', '160px'));
await page.waitForTimeout(80);
const paddingAfter = await page.locator('.pd-top').evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
if (!(paddingAfter - paddingBefore >= 155)) errors.push(`收起侧边栏后工具栏没有让开：${paddingBefore} → ${paddingAfter}`);
await page.locator('#frame').evaluate((el) => el.style.removeProperty('--dsh-frame-leading-clearance'));

await page.click('.pd-paper');
await page.waitForSelector('.pd-node');
// 右侧栏可能是上次收起的状态：先展开，后面的会话断言都依赖它
if ((await page.locator('.pd-drawer-reopen').count()) > 0) await page.click('.pd-drawer-reopen');
await page.waitForTimeout(150);
// 公式必须真的被 KaTeX 渲染出来，而不是显示 LaTeX 源码
await page.waitForTimeout(400);
const bodyTex = await page.locator('.pd-node-text').first().innerText().catch(() => '');
if (bodyTex.includes('\\mathbf')) errors.push('节点正文仍显示裸 LaTeX：' + bodyTex.slice(0, 60));
const bodyKatex = await page.locator('.pd-node-text .katex').count();
if (bodyKatex === 0) {
  const dbg = await page.locator('.pd-node-text').first().innerHTML();
  errors.push('节点正文里的行内公式没有渲染成 KaTeX；正文 HTML=' + String(dbg).slice(0, 160));
}
const katexCount = await page.locator('.pd-node .katex').count();
if (katexCount === 0) errors.push('节点里的公式没有被 KaTeX 渲染');
const rawLatexLeaked = await page.locator('.pd-node .pd-node-latex').first().innerText().catch(() => '');
if (/\\mathbf|\\alpha/.test(rawLatexLeaked)) errors.push('公式节点仍在显示 LaTeX 源码：' + rawLatexLeaked.slice(0, 60));
const fontLoaded = await page.evaluate(() => document.fonts.check('16px KaTeX_Main'));
if (!fontLoaded) errors.push('KaTeX 字体没加载（公式会用系统衬线兜底，间距会乱）');
// 图必须标出"它在论文哪一节"，公式节点同理
const figCapTexts = await page.locator('.pd-fig-cap').allInnerTexts();
if (!figCapTexts.some((text) => text.includes('§'))) errors.push('节点上的图没有标板块：' + figCapTexts.join(' | ').slice(0, 80));
if (!figCapTexts.some((text) => /Figure\s*\d/.test(text))) errors.push('图注标签里没有 Figure/Table 编号：' + figCapTexts.join(' | ').slice(0, 80));
// 板块里的解释文字要分段（用户反馈"一大段太长"）
const textParagraphs = await page.locator('.pd-node-text p').count();
if (textParagraphs < 2) errors.push(`节点正文没有分段：只有 ${textParagraphs} 段`);
const metaTexts = await page.locator('.pd-node-meta').allInnerTexts();
if (!metaTexts.some((text) => text.includes('§3.2 Method'))) errors.push('公式节点没有标所在章节：' + metaTexts.join(' | ').slice(0, 80));
// 公式要说明"作用在原理图的哪一部分"，并能一键看图
const whereTexts = await page.locator('.pd-node-where').allInnerTexts();
if (!whereTexts.some((text) => text.includes('作用于') && /Figure\s*\d/.test(text))) {
  errors.push('公式没有说明作用在原理图的哪一部分：' + whereTexts.join(' | ').slice(0, 80));
}
const whereLink = page.locator('.pd-where-link').first();
if ((await whereLink.count()) === 0) errors.push('公式卡片缺少「看原理图」入口');
else {
  await whereLink.click();
  await page.waitForSelector('.pd-lightbox', { timeout: 3000 }).catch(() => errors.push('点「看原理图」没有打开大图'));
  const lightboxCap = await page.locator('.pd-lightbox-cap').innerText().catch(() => '');
  if (!/Figure\s*\d/.test(lightboxCap)) errors.push('大图没有带上原理图的图注：' + lightboxCap.slice(0, 60));
  await page.mouse.click(20, 20);
  await page.waitForTimeout(200);
}
await shot('03-canvas');

// 工具栏不再有「原始 PDF」「整篇问答」「重新裁图」三个按钮
if ((await page.getByRole('button', { name: '原始 PDF' }).count()) !== 0) errors.push('「原始 PDF」按钮应该已经删除');
if ((await page.getByRole('button', { name: '整篇问答' }).count()) !== 0) errors.push('「整篇问答」按钮应该已经删除');
if ((await page.getByRole('button', { name: /重新裁图/ }).count()) !== 0) errors.push('「重新裁图」按钮应该已经删除');

// 拖拽：先验标题栏（稳定路径），再验"按正文也能拖"（软断言）
const nodeBox = await page.locator('.pd-node').first().boundingBox();
const readNodePos = async () => {
  const style = await page.locator('.pd-node').first().getAttribute('style');
  const left = /left: (-?[0-9.]+)px/.exec(style ?? '');
  const top = /top: (-?[0-9.]+)px/.exec(style ?? '');
  return { x: left ? Number(left[1]) : null, y: top ? Number(top[1]) : null };
};
const posBefore = await readNodePos();
const headerBox = await page.locator('.pd-node .pd-node-head').first().boundingBox();
await page.mouse.move(headerBox.x + 40, headerBox.y + headerBox.height / 2);
await page.mouse.down();
await page.mouse.move(headerBox.x + 140, headerBox.y + headerBox.height / 2 + 60, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(250);
const posAfter = await readNodePos();
if (!(Math.abs(posAfter.x - posBefore.x) > 50)) errors.push(`拖标题栏没能移动节点：${posBefore.x} → ${posAfter.x}`);
await shot('04-drag-from-body');

// 节点尺寸：拖右下角把手改宽高，双击恢复
// 说明：整理布局后卡片可能挨得很近，别的节点的把手会盖在这一格的角上；
// 所以先挑一个"把手真的点得到"的节点（elementFromPoint 命中自己），再拖它。
const nodeAt = (index) => page.locator('.pd-node').nth(index);
const sizeOfIndex = async (index) => {
  const style = await nodeAt(index).getAttribute('style');
  return {
    w: Number((/width: ([0-9.]+)px/.exec(style ?? '') ?? [])[1] ?? 0),
    h: (/height: ([0-9.]+)px/.exec(style ?? '') ?? [])[1] ?? null,
  };
};
const posOfIndex = async (index) => {
  const style = await nodeAt(index).getAttribute('style');
  const left = /left: (-?[0-9.]+)px/.exec(style ?? '');
  const top = /top: (-?[0-9.]+)px/.exec(style ?? '');
  return { x: left ? Number(left[1]) : null, y: top ? Number(top[1]) : null };
};
await page.getByRole('button', { name: '适应' }).click();
await page.waitForTimeout(250);
const resizeProbe = await page.evaluate(() => {
  const nodes = [...document.querySelectorAll('.pd-node')];
  for (let index = 0; index < nodes.length; index += 1) {
    const handle = nodes[index].querySelector('.pd-rs-se');
    if (!handle) continue;
    const rect = handle.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    if (x < 4 || y < 4 || x > window.innerWidth - 4 || y > window.innerHeight - 4) continue;
    if (document.elementFromPoint(x, y) !== handle) continue;
    return { index, x, y };
  }
  return null;
});
let resizeTarget = null;
if (!resizeProbe) {
  errors.push('所有节点的右下角把手都被别的节点盖住了，没法拖尺寸');
} else {
  resizeTarget = resizeProbe.index;
  const sizeBefore = await sizeOfIndex(resizeTarget);
  await page.mouse.move(resizeProbe.x, resizeProbe.y);
  await page.mouse.down();
  await page.mouse.move(resizeProbe.x + 120, resizeProbe.y + 80, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const sizeAfter = await sizeOfIndex(resizeTarget);
  if (!(sizeAfter.w > sizeBefore.w + 40)) errors.push(`拖右下角没有变宽：${sizeBefore.w} → ${sizeAfter.w}`);
  if (!(sizeAfter.h && Number(sizeAfter.h) > 0)) errors.push('拖右下角没有设置高度');
  // 左上角：向左上拖，宽高增大且节点位置跟着左上移动
  const nwBox = await nodeAt(resizeTarget).locator('.pd-rs-nw').boundingBox();
  const posBeforeNw = await posOfIndex(resizeTarget);
  const sizeBeforeNw = await sizeOfIndex(resizeTarget);
  await page.mouse.move(nwBox.x + nwBox.width / 2, nwBox.y + nwBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(nwBox.x - 60, nwBox.y - 40, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const posAfterNw = await posOfIndex(resizeTarget);
  const sizeAfterNw = await sizeOfIndex(resizeTarget);
  if (!(sizeAfterNw.w > sizeBeforeNw.w + 30)) errors.push(`拖左上角没有变宽：${sizeBeforeNw.w} → ${sizeAfterNw.w}`);
  if (!(posAfterNw.x < posBeforeNw.x - 20)) errors.push(`拖左上角时位置没跟着动：${posBeforeNw.x} → ${posAfterNw.x}`);
}
// 整理布局：按连线重排后，节点不再像刺猬一样围着一个点
const beforeTidy = await page.evaluate(() =>
  [...document.querySelectorAll('.pd-node')].map((node) => {
    const style = node.getAttribute('style') ?? '';
    return [Number(/left: (-?[0-9.]+)/.exec(style)?.[1] ?? 0), Number(/top: (-?[0-9.]+)/.exec(style)?.[1] ?? 0)];
  }),
);
await page.getByRole('button', { name: '整理布局' }).click();
await page.waitForTimeout(300);
const afterTidy = await page.evaluate(() =>
  [...document.querySelectorAll('.pd-node')].map((node) => {
    const style = node.getAttribute('style') ?? '';
    return [Number(/left: (-?[0-9.]+)/.exec(style)?.[1] ?? 0), Number(/top: (-?[0-9.]+)/.exec(style)?.[1] ?? 0)];
  }),
);
if (JSON.stringify(beforeTidy) === JSON.stringify(afterTidy)) errors.push('整理布局没有改变节点位置');
const xs = afterTidy.map(([x]) => x);
if (Math.max(...xs) - Math.min(...xs) < 300) errors.push('整理布局后节点没有横向铺开');
if ((await page.locator('.pd-notice').count()) === 0) errors.push('整理布局后没有出现撤销提示');
// 自动/手动整理之后，节点之间不能有重叠（宽节点、图片加载后变高都容易顶到一起）
const overlaps = await page.evaluate(() => {
  const rects = [...document.querySelectorAll('.pd-node')].map((el) => el.getBoundingClientRect());
  const hits = [];
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i];
      const b = rects[j];
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 2 && h > 2) hits.push({ i, j, w: Math.round(w), h: Math.round(h) });
    }
  }
  return hits;
});
if (overlaps.length > 0) errors.push('整理布局后节点重叠：' + JSON.stringify(overlaps).slice(0, 140));
// 重新分析：没有模型时应给出可见失败提示（不是静默）
page.on('dialog', (dialog) => dialog.accept());
await page.getByRole('button', { name: '重新分析' }).click();
await page.waitForTimeout(400);
const notices = await page.locator('.pd-notice').allInnerTexts().catch(() => []);
const reanalyzeNotice = notices.join(' | ');
if (!/失败|无法|没有保存|模型/.test(reanalyzeNotice)) errors.push('重新分析失败时没有提示：' + reanalyzeNotice.slice(0, 60));
await shot('04g-reanalyze');
await shot('04f-tidy');
const undoButton = page.locator('.pd-notice button', { hasText: '撤销' });
if ((await undoButton.count()) === 0) {
  const texts = await page.locator('.pd-notice').allInnerTexts().catch(() => []);
  errors.push('整理布局后没有撤销入口：' + texts.join(' | ').slice(0, 60));
} else {
  await undoButton.first().click();
}
await page.waitForTimeout(250);
const undone = await page.evaluate(() =>
  [...document.querySelectorAll('.pd-node')].map((node) => {
    const style = node.getAttribute('style') ?? '';
    return [Number(/left: (-?[0-9.]+)/.exec(style)?.[1] ?? 0), Number(/top: (-?[0-9.]+)/.exec(style)?.[1] ?? 0)];
  }),
);
if (JSON.stringify(undone) !== JSON.stringify(beforeTidy)) errors.push('撤销没有恢复原布局');
await shot('04e-node-resized');
// 双击右下角恢复默认尺寸，避免后续步骤被放大的节点挡住
if (resizeTarget !== null) {
  await page.getByRole('button', { name: '适应' }).click();
  await page.waitForTimeout(250);
  const corner2 = await nodeAt(resizeTarget).locator('.pd-rs-se').boundingBox();
  await page.mouse.dblclick(corner2.x + corner2.width / 2, corner2.y + corner2.height / 2);
  await page.waitForTimeout(250);
  const reset = await sizeOfIndex(resizeTarget);
  if (reset.h !== null) errors.push('双击右下角没有恢复自适应高度');
}
// 拖完之后再点一下，仍然能正常选中（说明被拖拽吞掉的 click 没有把后续点击也吃掉）
const movedBox = await page.locator('.pd-node').first().boundingBox();
await page.mouse.click(movedBox.x + 60, movedBox.y + 40);
await page.waitForTimeout(250);
const scopeText = await page.locator('.pd-scope').first().innerText();
if (!scopeText.includes('当前板块')) errors.push('拖拽后点击节点没能选中：' + scopeText);

// 这两个工具栏按钮已经按用户要求删掉：「重新裁图」「整篇问答」
if ((await page.getByRole('button', { name: '整篇问答' }).count()) !== 0) errors.push('「整篇问答」按钮还在');
if ((await page.getByRole('button', { name: /重新裁图/ }).count()) !== 0) errors.push('「重新裁图」按钮还在');
await page.click('.pd-node .pd-node-head');
const scopeAfterSelect = await page.locator('.pd-scope').first().innerText();
if (!scopeAfterSelect.includes('当前板块')) errors.push('选中节点后右侧栏范围没切到板块：' + scopeAfterSelect);
await shot('04-node-chat');

// 「原始 PDF」在页面内用 pdf.js 渲染（之前 window.open 在桌面版里是空操作）
if ((await page.locator('.pd-compose .pd-model').count()) === 0) errors.push('输入框底部缺少模型选择器');
if ((await page.getByRole('button', { name: '清空' }).count()) === 0) errors.push('输入框底部缺少清空按钮');
if ((await page.getByRole('button', { name: '发送' }).count()) === 0) errors.push('输入框缺少发送按钮');
const composeHeight = await page.locator('.pd-compose').evaluate((el) => el.getBoundingClientRect().height);
if (!(composeHeight > 80)) errors.push(`输入框太矮：${composeHeight}px`);
if (!samplePdfPath) console.log('SKIP 原文/框选（未提供 PN_SAMPLE_PDF）');
await page.click('.pd-tab:nth-child(4)');
await page.waitForSelector('.pd-pdf-scroll', { timeout: 15000 }).catch(() => errors.push('「原文」页签没有打开 PDF'));
await page.waitForTimeout(1800);
const firstPage = await page
  .locator('.pd-pdf-canvas')
  .first()
  .evaluate((el) => ({ w: el.width, h: el.height }))
  .catch(() => ({ w: 0, h: 0 }));
if (!(firstPage.w > 200 && firstPage.h > 200)) errors.push(`原文第一页没有渲染出来：${firstPage.w}x${firstPage.h}`);
const renderedBefore = await page.locator('.pd-pdf-canvas').evaluateAll((list) => list.filter((el) => el.width > 0).length);
await page.locator('.pd-pdf-scroll').evaluate((el) => {
  el.scrollTop = el.scrollHeight * 0.35;
});
await page.waitForTimeout(1500);
const renderedAfter = await page.locator('.pd-pdf-canvas').evaluateAll((list) => list.filter((el) => el.width > 0).length);
if (!(renderedAfter > 0)) errors.push('往下滚动后没有渲染新的页');

// 清晰度：位图宽度必须是显示宽度的 2 倍左右（否则就是"糊"）
const dpi = await page.evaluate(() => {
  // 取第一张"已经渲染过"的页：滚出视口的页会被主动释放（canvas 归零）
  const holder = [...document.querySelectorAll('.pd-pdf-page')].find((el) => el.querySelector('canvas')?.width > 0);
  if (!holder) return { canvasW: 0, cssW: 0 };
  return { canvasW: holder.querySelector('canvas').width, cssW: holder.getBoundingClientRect().width };
});
if (!(dpi.canvasW >= dpi.cssW * 1.8)) errors.push(`原文渲染倍率不够（会糊）：canvas ${dpi.canvasW}px / 显示 ${Math.round(dpi.cssW)}px`);

// 缩放：面板内放大后，页面显示宽度应该变大
const beforeZoom = dpi.cssW;
await page.locator('.pd-pdf-tools button[title="放大"]').click();
await page.waitForTimeout(700);
const afterZoom = await page.locator('.pd-pdf-page').first().evaluate((el) => el.getBoundingClientRect().width);
if (!(afterZoom > beforeZoom * 1.1)) errors.push(`面板内放大没生效：${Math.round(beforeZoom)} → ${Math.round(afterZoom)}`);
await shot('04a-pdf-zoom');

// 文本层：页面里应该铺出可选择的透明文字
const textLayerDisplay = await page
  .locator('.pd-text-layer')
  .first()
  .evaluate((el) => getComputedStyle(el).display)
  .catch(() => 'missing');
if (textLayerDisplay === 'none') errors.push('文本层被 display:none 藏掉了（选不了字）');
const textSpans = await page.locator('.pd-text-layer span').count();
if (textSpans < 20) errors.push(`PDF 文本层没有铺出来：${textSpans} 段`);

// 拖选：文本层是我们自己按文字块命中实现的（不依赖浏览器 user-select）
{
  // 先把可能还开着的工具条关掉，否则它盖住页面
  const closeBtn = page.locator('.pd-selection-pop button', { hasText: '关闭' });
  if ((await closeBtn.count()) > 0) {
    await closeBtn.first().click();
    await page.waitForTimeout(150);
  }
  const rects = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('.pd-text-layer span')];
    const scroll = document.querySelector('.pd-pdf-scroll')?.getBoundingClientRect();
    const inView = (span) => {
      if (!scroll) return false;
      const box = span.getBoundingClientRect();
      return (
        box.top > scroll.top + 12 &&
        box.bottom < scroll.bottom - 12 &&
        box.left > scroll.left + 12 &&
        box.right < scroll.right - 12
      );
    };
    const first = spans.find((span) => span.textContent.trim().length > 8 && inView(span));
    if (!first) return null;
    const firstBox = first.getBoundingClientRect();
    const sameColumn = (box) => box.left < firstBox.right + 60;
    const line = spans.filter((span) => {
      if (!inView(span)) return false;
      const box = span.getBoundingClientRect();
      return Math.abs(box.top - firstBox.top) < 2 && sameColumn(box);
    });
    if (line.length === 0) return null;
    const a = line[0].getBoundingClientRect();
    const b = line[line.length - 1].getBoundingClientRect();
    return {
      x1: a.left + 2,
      y1: a.top + a.height / 2,
      x2: b.right - 2,
      y2: b.top + b.height / 2,
      expected: line.map((span) => span.textContent).join(''),
    };
  });
  if (!rects) {
    errors.push('页面上没有找到可视的文字行，无法验证拖选');
  } else {
    await page.mouse.move(rects.x1, rects.y1);
    await page.mouse.down();
    await page.mouse.move(rects.x2, rects.y2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const highlighted = await page.locator('.pd-pick-box').count();
    if (highlighted === 0) errors.push('拖选没有产生任何高亮（命中失败）');
    const preview = (await page.locator('.pd-selection-preview').innerText().catch(() => '')).trim();
    if (preview.length === 0) errors.push('划词工具条没有展示选中文本');
    const firstToken = rects.expected.slice(0, 3);
    if (preview.length > 0 && !preview.includes(firstToken)) {
      errors.push(`工具条文本与选中的行对不上：「${preview.slice(0, 24)}」 vs 「${rects.expected.slice(0, 24)}」`);
    }
    await shot('04a1-text-selection');
    if (preview.length > 0) {
      await page.evaluate(() => {
        window.__copied = null;
        const original = navigator.clipboard?.writeText?.bind(navigator.clipboard);
        if (navigator.clipboard) {
          navigator.clipboard.writeText = async (value) => {
            window.__copied = value;
            if (original) return original(value);
            return undefined;
          };
        }
      });
      const copyBtn = page.locator('.pd-selection-pop button', { hasText: '复制' }).first();
      if ((await copyBtn.count()) > 0) {
        await copyBtn.click();
        await page.waitForTimeout(250);
        const copied = await page.evaluate(() => window.__copied);
        if (!copied || String(copied).trim().length === 0) errors.push('点复制没有把文本写进剪贴板');
        else if (!String(copied).includes(firstToken)) errors.push(`复制的内容不对：「${String(copied).slice(0, 24)}」`);
      } else {
        errors.push('划词工具条上没有「复制」按钮');
      }
    }
  }
}

// 缩放后切走再回来：缩放与页码要记住
const zoomedWidth = await page.locator('.pd-pdf-page').first().evaluate((el) => el.getBoundingClientRect().width);
await page.waitForTimeout(500);
await page.click('.pd-tab:nth-child(1)');
await page.waitForTimeout(250);
await page.click('.pd-tab:nth-child(4)');
await page.waitForSelector('.pd-pdf-page', { timeout: 10000 }).catch(() => errors.push('切回原文后页面没重新出现'));
await page.waitForTimeout(900);
const restoredWidth = await page.locator('.pd-pdf-page').first().evaluate((el) => el.getBoundingClientRect().width);
if (!(restoredWidth > zoomedWidth * 0.92)) {
  errors.push(`切回原文后缩放松回了：${Math.round(zoomedWidth)} → ${Math.round(restoredWidth)}`);
}
const savedPdf = await page.evaluate(async () => {
  const state = await (await fetch('/dsh-paper-desk-4821/state')).json();
  const id = state.papers[0]?.id;
  const doc = (await (await fetch('/dsh-paper-desk-4821/paper?id=' + id)).json()).paper;
  return doc.layout?.pdf ?? null;
});
if (!savedPdf || typeof savedPdf.zoom !== 'number') errors.push('PDF 视图状态没有落盘：' + JSON.stringify(savedPdf));
await shot('04a-pdf-panel');
// 框选配图：先选一个节点（框选结果要挂到它上面），再回原文页签框
await page.click('.pd-node .pd-node-head');
await page.click('.pd-tab:nth-child(4)');
await page.waitForSelector('.pd-pdf-page');
await page.locator('.pd-pdf-page').first().scrollIntoViewIfNeeded();
const pageBox = await page.locator('.pd-pdf-page').first().boundingBox();
await page.getByRole('button', { name: /框选配图|框选中/ }).click();
await page.waitForTimeout(200);
if ((await page.getByRole('button', { name: /框选中/ }).count()) === 0) errors.push('点「框选配图」后没有进入框选模式');
// 在页面范围内拖（页面本身只有 ~260px 高，别拖出边界）
await page.mouse.move(pageBox.x + 20, pageBox.y + 20);
await page.mouse.down();
await page.mouse.move(pageBox.x + pageBox.width * 0.8, pageBox.y + pageBox.height * 0.7, { steps: 12 });
await page.waitForTimeout(120);
// 拖动中的选框必须真的可见：PDF 页面是白底，边框跟白底对比度 ≥ 3:1 才算"看得出来"
if ((await page.locator('.pd-pdf-box').count()) !== 1) errors.push('拖动时没有出现选框');
const boxPaint = await page
  .locator('.pd-pdf-box')
  .first()
  .evaluate((el) => {
    const style = getComputedStyle(el);
    return { border: style.borderTopColor, fill: style.backgroundColor };
  })
  .catch(() => ({ border: '', fill: '' }));
const luminance = (color) => {
  const rgb = String(color).match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [255, 255, 255];
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
};
const boxContrast = 1.05 / (luminance(boxPaint.border) + 0.05);
if (!(boxContrast >= 3)) errors.push(`框选框和白页面对比度太低：${boxPaint.border}（${boxContrast.toFixed(2)}:1）`);
await shot('04a2-lasso-box');
await page.mouse.up();
await page.waitForTimeout(1200);
// 框选出来的图必须是高清的（按 PDF 坐标重渲染，而不是从屏幕画布上裁）
const picked = await page.evaluate(async () => {
  const state = await (await fetch('/dsh-paper-desk-4821/state')).json();
  let paper = null;
  let last = null;
  for (const candidate of state.papers ?? []) {
    const doc = (await (await fetch('/dsh-paper-desk-4821/paper?id=' + encodeURIComponent(candidate.id))).json()).paper;
    const hit = (doc.figures ?? []).filter((figure) => figure.caption === '框选截取').pop();
    if (hit) {
      paper = candidate;
      last = hit;
      break;
    }
  }
  if (!paper || !last) return { ok: false, reason: '没有框选出来的图' };
  const url = `/dsh-paper-desk-4821/asset?paper=${encodeURIComponent(paper.id)}&file=${encodeURIComponent(last.file)}`;
  const size = await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 0, h: 0 });
    img.src = url;
  });
  return { ok: size.w >= 600, ...size, caption: last.caption };
});
console.log('lasso crop:', picked.w + 'x' + picked.h);
if (!picked.ok) {
  const diag = await page.evaluate(() => ({
    error: document.querySelector('.pd-error')?.innerText ?? '',
    boxes: document.querySelectorAll('.pd-pdf-box').length,
    pages: document.querySelectorAll('.pd-pdf-page').length,
    picking: Boolean(document.querySelector('.pd-pdf-page.is-picking')),
  }));
  errors.push(`框选出来的图太小（会糊）：${picked.w}x${picked.h}，${picked.reason ?? ''}；现场 ${JSON.stringify(diag)}`);
}
await shot('04a3-picked-figure');
// 回到会话页签，后续步骤继续用会话来验
await page.click('.pd-tab:nth-child(1)');

// 回到整篇：点画布空白处（「整篇问答」按钮已删，这是现在唯一的入口之一）
await page.locator('.pd-canvas').evaluate((el) => {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 4, clientY: 4 }));
});
await page.waitForTimeout(200);
const scopeAfterWhole = await page.locator('.pd-scope').first().innerText();
if (!scopeAfterWhole.includes('整篇论文')) errors.push('点画布空白处后范围没切回整篇：' + scopeAfterWhole);

// 节点编辑：从图库里挂一张图，保存后节点上应该真的出现图片
await page.click('.pd-node .pd-node-head button[title="编辑节点"]');
await page.waitForSelector('.pd-figure-picker').catch(async () => {
  await page.screenshot({ path: join(shotDir, `${themeTag}-debug-no-editor.png`) });
  const info = await page.evaluate(() => ({
    modals: document.querySelectorAll('.pd-modal').length,
    nodes: document.querySelectorAll('.pd-node').length,
    editButtons: document.querySelectorAll('.pd-node-head button[title="编辑节点"]').length,
    notice: document.querySelector('.pd-notice')?.innerText ?? '',
  }));
  errors.push('编辑弹窗没打开：' + JSON.stringify(info));
});
// 有配图的板块：默认只列出它自己那张；没配图的板块才直接列全部
const pickerBefore = await page.locator('.pd-figure-option').count();
const pickerHasFigure = (await page.getByRole('button', { name: /换一张（从/ }).count()) > 0;
if (pickerHasFigure) {
  if (pickerBefore > 2) errors.push(`编辑有配图的板块时不该列出全部图：${pickerBefore} 个`);
  await page.getByRole('button', { name: /换一张（从/ }).click();
  await page.waitForTimeout(150);
  const pickerAfter = await page.locator('.pd-figure-option').count();
  if (!(pickerAfter > pickerBefore)) errors.push('点「换一张」后没有展开全部图');
  await page.getByRole('button', { name: '只看这一块的图' }).click();
  await page.waitForTimeout(150);
} else if (pickerBefore < 2) {
  errors.push('没配图的板块应该直接列出全部图');
}
await shot('04b-node-editor');
const optionCount = await page.locator('.pd-figure-option').count();
if (optionCount < 2) {
  errors.push(`图库里没有可选的图（只有 ${optionCount} 个选项）`);
} else {
  await page.locator('.pd-figure-option').nth(1).click();
}
await page.click('.pd-modal-foot .pd-btn-primary');
await page.waitForTimeout(400);
const figureShown = await page.$('.pd-node img.pd-node-figure');
if (!figureShown) errors.push('挂图后节点没有显示图片');
await shot('04c-node-with-figure');

// 缩放：全局放大 → 适应 → 聚焦所选
const scaleOf = async () => {
  const style = await page.getAttribute('.pd-canvas-inner', 'style');
  const match = /scale\(([0-9.]+)\)/.exec(style ?? '');
  return match ? Number(match[1]) : null;
};
const before = await scaleOf();
await page.getByRole('button', { name: '+', exact: true }).click();
await page.waitForTimeout(200);
const zoomedIn = await scaleOf();
if (!(zoomedIn > before)) errors.push(`放大按钮没生效：${before} → ${zoomedIn}`);
await page.getByRole('button', { name: '适应' }).click();
await page.waitForTimeout(200);
const fitted = await scaleOf();
if (!(fitted > 0.2 && fitted <= 1.1)) errors.push(`适应没把图放进视口：${fitted}`);
await page.click('.pd-node .pd-node-head');
await page.waitForTimeout(150);
await page.getByRole('button', { name: '聚焦所选' }).click();
await page.waitForTimeout(250);
const focused = await scaleOf();
if (!(focused > fitted)) errors.push(`聚焦所选没有放大：${fitted} → ${focused}`);
await shot('05-zoom-focus');

// 消息上的「复制」：点一下要变成「已复制」（剪贴板写入需要权限，这里验状态机）
await page.locator('.pd-canvas').evaluate((el) => {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 4, clientY: 4 }));
});
await page.waitForTimeout(200);
await page.click('.pd-tab:nth-child(1)');
const copyBtn = page.locator('.pd-msg-copy').first();
if ((await copyBtn.count()) === 0) errors.push('消息上没有复制按钮');
else {
  await copyBtn.click({ force: true });
  await page.waitForTimeout(200);
  const copiedClass = await copyBtn.getAttribute('class');
  if (!copiedClass?.includes('is-copied')) errors.push(`复制按钮点击后没有反馈：${copiedClass}`);
}
await page.click('.pd-tab:nth-child(1)');

// 滚轮缩放：普通滚轮（鼠标）、触控板双指、Cmd/Ctrl+滚轮（捏合）三条路都要生效
await page.getByRole('button', { name: '适应' }).click();
await page.waitForTimeout(200);
const beforeWheel = await scaleOf();
const box = await page.locator('.pd-canvas').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.wheel(0, -120);
await page.waitForTimeout(200);
const afterPlain = await scaleOf();
if (!(afterPlain > beforeWheel)) errors.push(`普通滚轮没缩放：${beforeWheel} → ${afterPlain}`);
await page.keyboard.down('Meta');
await page.mouse.wheel(0, 120);
await page.keyboard.up('Meta');
await page.waitForTimeout(200);
const afterMeta = await scaleOf();
if (!(afterMeta < afterPlain)) errors.push(`Cmd+滚轮没缩放：${afterPlain} → ${afterMeta}`);
await shot('05b-wheel-zoom');

// 触控板两指：小增量应该平移而不是缩放
await page.getByRole('button', { name: '适应' }).click();
await page.waitForTimeout(200);
const panOf = async () => {
  const style = await page.getAttribute('.pd-canvas-inner', 'style');
  const match = /translate\(([-0-9.]+)px, ([-0-9.]+)px\)/.exec(style ?? '');
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
};
const panBefore = await panOf();
const scaleBefore = await scaleOf();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.wheel(0, 12);
await page.waitForTimeout(200);
const panAfter = await panOf();
const scaleAfter = await scaleOf();
if (!(Math.abs(panAfter.y - panBefore.y) > 5)) errors.push(`两指滑动没平移：${panBefore.y} → ${panAfter.y}`);
if (Math.abs(scaleAfter - scaleBefore) > 1e-6) errors.push(`两指滑动不该缩放：${scaleBefore} → ${scaleAfter}`);
await shot('05c-trackpad-pan');

// 工具栏的滚轮模式切换
await page.getByRole('button', { name: /滚轮：自动/ }).click();
await page.waitForTimeout(150);
const modeZoom = await page.getByRole('button', { name: /滚轮：缩放/ }).count();
if (modeZoom === 0) errors.push('滚轮模式没有切到「缩放」');
await page.getByRole('button', { name: /滚轮：缩放/ }).click();
await page.waitForTimeout(150);
await page.getByRole('button', { name: /滚轮：平移/ }).click();
await page.waitForTimeout(150);
if ((await page.getByRole('button', { name: /滚轮：自动/ }).count()) === 0) errors.push('滚轮模式没有循环回「自动」');

// 右侧栏：拖左边缘变宽 → 收起 → 展开（宽度要记住）
const drawerWidth = async () => {
  const box = await page.locator('.pd-drawer').boundingBox().catch(() => null);
  return box ? box.width : 0;
};
const w0 = await drawerWidth();
const handle = await page.locator('.pd-drawer-resizer').boundingBox();
await page.mouse.move(handle.x + handle.width / 2, handle.y + 200);
await page.mouse.down();
await page.mouse.move(handle.x - 80, handle.y + 200, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(250);
const w1 = await drawerWidth();
if (!(w1 > w0 + 40)) errors.push(`拖拽没把右侧栏拉宽：${w0} → ${w1}`);
await page.click('.pd-collapse-btn');
await page.waitForTimeout(200);
if ((await page.locator('.pd-drawer').count()) !== 0) errors.push('收起后右侧栏仍然渲染');
if ((await page.locator('.pd-drawer-reopen').count()) === 0) errors.push('收起后没有展开按钮');
await shot('05d-drawer-collapsed');
await page.click('.pd-drawer-reopen');
await page.waitForTimeout(200);
const w2 = await drawerWidth();
if (!(Math.abs(w2 - w1) < 8)) errors.push(`展开后宽度没恢复：${w1} → ${w2}`);

// 输入法：组合中按 Enter 不能发送（中文输入 GNN 确认候选词那一幕）
await page.fill('.pd-compose-input', '输入中的GNN');
await page.locator('.pd-compose-input').evaluate((el) => {
  el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true }));
});
await page.waitForTimeout(250);
const draftAfterIme = await page.inputValue('.pd-compose-input');
if (draftAfterIme !== '输入中的GNN') errors.push(`组合中按 Enter 把输入发出去了：草稿变成「${draftAfterIme}」`);
if ((await page.locator('.pd-thinking').count()) !== 0) errors.push('组合中按 Enter 触发了生成');
await page.locator('.pd-compose-input').evaluate((el) => {
  el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'GNN' }));
});
await page.waitForTimeout(200);

// 设置：三个页签都要能打开（模型 API / 提示词是本轮新增）
{
  await page.click('.pd-top button[title="设置数据目录"]');
  await page.waitForSelector('.pd-settings-body');
  // 尺寸：比 0.13.4 的 900×556 小一圈，但仍然按黄金比例（宽 800 → 高约 494）
  const modalBox = await page.locator('.pd-modal').first().boundingBox();
  const modalRatio = modalBox.width / modalBox.height;
  if (modalBox.width > 820) errors.push(`设置弹窗太宽：${Math.round(modalBox.width)}px`);
  if (Math.abs(modalRatio - 1.618) > 0.05)
    errors.push(`设置弹窗不是黄金比例：${modalRatio.toFixed(3)}（${Math.round(modalBox.width)}×${Math.round(modalBox.height)}）`);
  const dirPaneBox = modalBox;
  // 关闭 / 保存 统一钉在窗口右下角：底边与右边都要贴着弹窗内边（容许 24px 内边距）
  const closeBox = await page.locator('.pd-modal-foot button', { hasText: '关闭' }).first().boundingBox();
  const saveBox = await page.locator('.pd-modal-foot button', { hasText: '保存' }).first().boundingBox();
  if (Math.abs(saveBox.x + saveBox.width - (dirPaneBox.x + dirPaneBox.width)) > 24)
    errors.push('「保存」没有贴在弹窗右边');
  if (Math.abs(saveBox.y + saveBox.height - (dirPaneBox.y + dirPaneBox.height)) > 24)
    errors.push('「保存」没有贴在弹窗底边');
  if (closeBox.x + closeBox.width > saveBox.x) errors.push('「关闭」应该排在「保存」左边');
  if (Math.abs(closeBox.y - saveBox.y) > 1) errors.push('「关闭」「保存」不在同一行');
  await shot('02d0-settings-dir');
  const tabs = await page.locator('.pd-tabs-inset .pd-tab').allInnerTexts();
  if (tabs.length < 3) errors.push('设置里页签不足三个：' + tabs.join(','));
  await page.locator('.pd-tabs-inset .pd-tab', { hasText: '模型' }).first().click();
  await page.waitForTimeout(150);
  const apiPaneText = await page.locator('.pd-settings-body').innerText();
  if (!apiPaneText.includes('添加模型')) errors.push('模型页签没有渲染：' + apiPaneText.slice(0, 40));
  await page.getByRole('button', { name: '＋ 添加模型' }).click();
  await page.waitForTimeout(150);
  await page.locator('input[placeholder="Kimi / 我的中转站"]').fill('Kimi 测试');
  await page.locator('input[placeholder="https://api.moonshot.cn/v1"]').fill('https://api.moonshot.cn/v1');
  await page.locator('input[placeholder="sk-…"]').fill('sk-test-1234');
  await page.locator('input[placeholder="moonshot-v1-32k"]').fill('moonshot-v1-32k');
  await shot('02e1-model-draft');
  await page.getByRole('button', { name: '保存模型' }).click();
  await page.waitForTimeout(200);
  if ((await page.locator('.pd-model-row').count()) === 0) errors.push('添加模型后列表里没有出现');
  await shot('02e-settings-models');
  await page.locator('.pd-tabs-inset .pd-tab', { hasText: '数据目录' }).click();
  // 预览环境没有 Electron：应该优雅退回内置目录浏览器
  await page.getByRole('button', { name: '选择…' }).click();
  await page.waitForSelector('.pd-dir-list', { timeout: 8000 }).catch(() => errors.push('「选择…」没有打开目录选择器'));
  // 目录选择器的「取消 / 选用这个目录」也要在右下角的统一 footer 里，而不是跟着列表滚动
  const pickerModals = page.locator('.pd-modal');
  const pickerCount = await pickerModals.count();
  if (pickerCount < 2) errors.push('目录选择器没有作为独立弹窗叠加');
  const pickerFoot = await pickerModals.last().locator('.pd-modal-foot').count();
  if (pickerFoot !== 1) errors.push('目录选择器的按钮没有放进统一 footer');
  if ((await pickerModals.last().locator('.pd-dir-foot').count()) !== 0) errors.push('目录选择器还留着旧的正文按钮行');
  const listedPath = await page.locator('.pd-dir-path').innerText();
  if (!/[\\/]/.test(listedPath)) errors.push('目录选择器没有显示绝对路径：' + listedPath);
  // 先在当前目录看看，再上跳一级（home 下必然有子目录）
  await page.locator('.pd-dir-item.is-parent').click().catch(() => undefined);
  await page.waitForTimeout(250);
  await shot('02d1-dir-picker');
  const dirCount = await page.locator('.pd-dir-item').count();
  if (dirCount < 1) errors.push(`目录选择器没有列出任何目录（${await page.locator('.pd-dir-path').innerText()}）`);
  await page.getByRole('button', { name: '取消' }).last().click();
  await page.waitForTimeout(150);
  await page.locator('.pd-tabs-inset .pd-tab', { hasText: '提示词' }).click();
  await page.waitForTimeout(150);
  const promptText = await page.locator('.pd-settings-body').innerText();
  if (!promptText.includes('角色设定')) errors.push('提示词页签没有渲染：' + promptText.slice(0, 40));
  await page.locator('.pd-tabs-inset .pd-tab', { hasText: 'Zotero' }).click();
  await page.waitForTimeout(150);
  const zoteroPaneText = await page.locator('.pd-settings-body').innerText();
  if (!zoteroPaneText.includes('userID')) errors.push('Zotero 页签没有渲染：' + zoteroPaneText.slice(0, 40));
  await shot('02d-settings');
  await page.locator('.pd-modal-foot button', { hasText: '关闭' }).click();
  await page.waitForTimeout(150);
}

// 流式输出：thinking 先出来，正文随 token 增长，结束后替换成正式消息
await page.fill('.pd-compose-input', '这块怎么理解？');
await page.waitForTimeout(200);
// 正常 Enter 仍然要能发送（刚才是组合中，这次不是）
await page.press('.pd-compose-input', 'Enter');
await page.waitForSelector('.pd-thinking', { timeout: 5000 }).catch(() => errors.push('没有出现 thinking 状态'));
const thinkingText = await page.locator('.pd-thinking').first().innerText().catch(() => '');
if (!thinkingText.includes('thinking')) errors.push('thinking 文案不对：' + thinkingText.slice(0, 40));
await page.waitForSelector('.pd-stream-text', { timeout: 5000 }).catch(() => errors.push('没有出现流式正文'));
await shot('04d-streaming');
await page.waitForFunction(() => document.querySelectorAll('.pd-stream-text').length === 0, undefined, { timeout: 8000 })
  .catch(() => errors.push('流式输出没有收尾（正文一直在流）'));
const lastAi = await page.locator('.pd-msg-ai').last().innerText().catch(() => '');
if (!lastAi.includes('假回答')) errors.push('流式结束后没有落到正式消息：' + lastAi.slice(0, 40));

await page.click('.pd-tab:nth-child(2)');
await shot('05-notes');

// 行内公式：用户笔记里 $...$ 必须真的被渲染
const noteBox = await page.locator('.pd-notes textarea, textarea[placeholder^="比如"]').first();
await noteBox.fill('ELLA 对每个任务 $t$ 只训练 $A_t,B_t$，得到 $\\Delta W_t=A_tB_t$，用 $W_{\\mathrm{past}}$ 做约束，$\\lambda$ 平衡。');
await page.getByRole('button', { name: /记下来|保存/ }).first().click();
await page.waitForTimeout(400);
const katexInNotes = await page.locator('.pd-note .katex').count();
if (katexInNotes < 4) errors.push(`笔记里的行内公式没渲染：只有 ${katexInNotes} 个 katex`);
const noteText = await page.locator('.pd-note').last().innerText();
if (noteText.includes('$')) errors.push('笔记里还残留 $ 定界符：' + noteText.slice(0, 60));
await shot('05b-note-math');

await page.click('.pd-tab:nth-child(3)');
await shot('06-core');

// 回到论文库 → 选两篇 → 对比
await page.click('.pd-tab:nth-child(1)');
await page.getByText('论文库', { exact: true }).click();
await page.waitForSelector('.pd-paper');
const compareButtons = await page.$$('.pd-paper button[title="加入对比"]');
for (const button of compareButtons.slice(0, 2)) await button.click();
await page.getByText(/对比 2 篇/).click();
await page.waitForSelector('.pd-card');
await shot('07-compare');

// 展开一张卡的核心思想
await page.click('.pd-card .pd-card-actions button');
// 展开详情后卡片必须完整落在舞台里（不能被边缘截掉）
const insideStage = await page.evaluate(() => {
  const stage = document.querySelector('.pd-compare-stage');
  const card = document.querySelector('.pd-card-detail')?.closest('.pd-card');
  if (!stage || !card) return null;
  const a = stage.getBoundingClientRect();
  const b = card.getBoundingClientRect();
  return {
    ok: b.left >= a.left - 1 && b.right <= a.right + 1 && b.top >= a.top - 1 && b.bottom <= a.bottom + 1,
    card: [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)],
    stage: [Math.round(a.left), Math.round(a.top), Math.round(a.right), Math.round(a.bottom)],
  };
});
if (insideStage && !insideStage.ok) {
  errors.push(`展开的卡片被舞台截断：card=${insideStage.card} stage=${insideStage.stage}`);
}
await shot('08-compare-detail');

// 收起讨论区 → 出现浮动入口 → 点卡上的「问答」把讨论区叫回来并预填
// 收起会话：图标常驻顶栏（位置不变，只是含义切换）
if ((await page.locator('.pd-drawer').count()) > 0) {
  await page.click('.pd-top .pd-collapse-btn');
  await page.waitForTimeout(150);
}
if ((await page.locator('.pd-drawer').count()) !== 0) errors.push('点顶栏伸缩按钮没有收起会话');
// 会话栏的「论文列表」页签：列出全部论文，点一行聚焦并回到会话
{
  // 先把会话打开（上一段可能刚收起）
  if ((await page.locator('.pd-drawer').count()) === 0) {
    await page.click('.pd-top .pd-collapse-btn');
    await page.waitForSelector('.pd-drawer');
  }
  const beforeView = await page.locator('.pd-compare-plane').first().evaluate((el) => el.style.transform);
  await page.getByRole('tab', { name: '论文列表' }).click().catch(async () => {
    await page.locator('.pd-tab', { hasText: '论文列表' }).click();
  });
  await page.waitForSelector('.pd-paper-row');
  const rows = await page.locator('.pd-paper-row').count();
  if (rows < 2) errors.push(`论文列表只有 ${rows} 行`);
  await page.locator('.pd-paper-row').nth(1).click();
  await page.waitForTimeout(400);
  const afterView = await page.locator('.pd-compare-plane').first().evaluate((el) => el.style.transform);
  if (beforeView === afterView) errors.push('点论文列表没有聚焦（视图没动）');
  // 点列表只聚焦，不跳页签
  if ((await page.locator('.pd-paper-row').count()) === 0) errors.push('点列表后不该离开论文列表页签');
  // 「问这篇」= 切范围到该论文并回到会话
  await page.locator('.pd-paper-row').nth(1).getByRole('button', { name: '问这篇' }).click();
  await page.waitForTimeout(250);
  const scopeLabel = await page.locator('.pd-scope-row .pd-dropdown-label').innerText();
  if (/^全部/.test(scopeLabel)) errors.push(`「问这篇」没有切到单篇范围：${scopeLabel}`);
  // 自绘下拉：点开 → 选"全部 N 篇"
  await page.locator('.pd-scope-row .pd-dropdown-trigger').click();
  await page.waitForSelector('.pd-dropdown-menu');
  await page.locator('.pd-dropdown-item', { hasText: '全部' }).first().click();
  await page.waitForTimeout(250);
  const scopeBack = await page.locator('.pd-scope-row .pd-dropdown-label').innerText();
  if (!/^全部/.test(scopeBack)) errors.push(`切回全部失败：${scopeBack}`);
  if ((await page.locator('.pd-msgs').count()) === 0) errors.push('切回全部后没有会话面板');
}
await shot('09-compare-collapsed');
// 收起 → 点卡上的「问答」应把会话叫回来并预填
if ((await page.locator('.pd-drawer').count()) > 0) {
  await page.click('.pd-top .pd-collapse-btn');
  await page.waitForTimeout(180);
}
if ((await page.locator('.pd-drawer').count()) !== 0) errors.push('会话没收起');
await page.click('.pd-card .pd-card-actions button:nth-child(2)');
await page.waitForSelector('.pd-drawer textarea');
await page.waitForTimeout(120);
const prefill = await page.inputValue('.pd-drawer textarea');
if (!prefill.startsWith('关于《')) errors.push('问答按钮没有预填：' + prefill);
await shot('10-compare-ask');

// 对比台：流式（thinking → 逐字）+ 历史落盘
if (await page.locator('.pd-thinking').count() === 0) {
  await page.fill('.pd-compose-input', '它们的任务边界假设差在哪？');
  await page.press('.pd-compose-input', 'Enter');
}
await page.waitForSelector('.pd-thinking', { timeout: 5000 }).catch(() => errors.push('对比台没有 thinking 状态'));
await page.waitForSelector('.pd-stream-text', { timeout: 5000 }).catch(() => errors.push('对比台没有流式正文'));
await shot('10b-compare-streaming');
await page.waitForFunction(() => document.querySelectorAll('.pd-stream-text').length === 0, undefined, { timeout: 8000 })
  .catch(() => errors.push('对比台流式没有收尾'));
const compareAi = await page.locator('.pd-msg-ai').last().innerText().catch(() => '');
if (!compareAi.includes('假回答')) errors.push('对比台流式结束后没有落到正式消息');
const savedHistory = await page.evaluate(async () => {
  const state = await (await fetch('/dsh-paper-desk-4821/state')).json();
  const ids = (state.papers ?? []).slice(0, 2).map((paper) => paper.id);
  const res = await fetch('/dsh-paper-desk-4821/compare/history?ids=' + encodeURIComponent(ids.join(',')));
  return (await res.json()).messages?.length ?? 0;
});
if (savedHistory < 2) errors.push(`对比历史没有落盘：${savedHistory} 条`);

// 卡片拉伸：拖右下角，宽度和高度都要变大
const cardStyle = async () => {
  const style = await page.locator('.pd-card').first().getAttribute('style');
  return {
    w: Number((/width: ([0-9.]+)px/.exec(style ?? '') ?? [])[1] ?? 320),
    h: (/height: ([0-9.]+)px/.exec(style ?? '') ?? [])[1] ?? null,
  };
};
// 先把详情收起：展开状态下卡片高度是自适应的，不该用来验尺寸
if ((await page.getByRole('button', { name: '收起思想与公式' }).count()) > 0) {
  await page.getByRole('button', { name: '收起思想与公式' }).first().click();
  await page.waitForTimeout(150);
}
const cardBefore = await cardStyle();
const cardCorner = await page.locator('.pd-card .pd-rs-se').first().boundingBox();
await page.mouse.move(cardCorner.x + cardCorner.width / 2, cardCorner.y + cardCorner.height / 2);
await page.mouse.down();
await page.mouse.move(cardCorner.x + 150, cardCorner.y + 90, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(250);
const cardAfter = await cardStyle();
if (!(cardAfter.w > cardBefore.w + 60)) errors.push(`对比卡片没有变宽：${cardBefore.w} → ${cardAfter.w}`);
if (!(cardAfter.h && Number(cardAfter.h) > 0)) errors.push('对比卡片没有设置高度');
await shot('10c-compare-resized');

// 右侧讨论栏可拉缩
const drawerBefore = await page.locator('.pd-drawer').first().evaluate((el) => el.getBoundingClientRect().width);
const resizerBox = await page.locator('.pd-drawer-resizer').first().boundingBox();
await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + 200);
await page.mouse.down();
await page.mouse.move(resizerBox.x - 120, resizerBox.y + 200, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);
const drawerAfter = await page.locator('.pd-drawer').first().evaluate((el) => el.getBoundingClientRect().width);
if (!(drawerAfter > drawerBefore + 60)) errors.push(`对比台右侧栏没有变宽：${Math.round(drawerBefore)} → ${Math.round(drawerAfter)}`);

// 展开"核心思想与公式"后：内容不能被裁，拖动卡片也不能收起
await page.getByRole('button', { name: '看核心思想与公式' }).first().click();
await page.waitForTimeout(200);
const detailVisible = await page.locator('.pd-card-detail').first().isVisible();
if (!detailVisible) errors.push('展开后看不到详情');
const detailOverflow = await page.evaluate(() => {
  const detail = document.querySelector('.pd-card-detail');
  const card = detail?.closest('.pd-card');
  if (!detail || !card) return null;
  const cardBox = card.getBoundingClientRect();
  const detailBox = detail.getBoundingClientRect();
  return { clipped: detailBox.bottom > cardBox.bottom + 1, cardH: Math.round(cardBox.height), detailH: Math.round(detailBox.height) };
});
if (detailOverflow && detailOverflow.clipped) {
  errors.push(`展开的公式被卡片裁掉了：卡片 ${detailOverflow.cardH}px，详情 ${detailOverflow.detailH}px`);
}
// 详情里滚轮要能滚（不能被舞台的平移抢走）
const scrolled = await page.evaluate(() => {
  const detail = document.querySelector('.pd-card-detail');
  if (!detail) return null;
  const before = detail.scrollTop;
  detail.dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true }));
  return { before, height: detail.scrollHeight, client: detail.clientHeight, scrollable: detail.scrollHeight > detail.clientHeight + 4 };
});
if (!scrolled) errors.push('详情节点没找到');
// 层级：点哪张卡，哪张到最上面
const zBefore = await page.evaluate(() =>
  [...document.querySelectorAll('.pd-card')].map((card) => Number(getComputedStyle(card).zIndex) || 0),
);
const secondHead = await page.locator('.pd-card .pd-card-head').nth(1).boundingBox();
if (secondHead) {
  await page.mouse.click(secondHead.x + 30, secondHead.y + 12);
  await page.waitForTimeout(150);
  // 点在哪张卡上（可能被上层卡挡住），那张就该是最高的
  const raised = await page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y)?.closest('.pd-card');
    if (!hit) return null;
    const all = [...document.querySelectorAll('.pd-card')];
    const z = Number(getComputedStyle(hit).zIndex) || 0;
    const max = Math.max(...all.map((card) => Number(getComputedStyle(card).zIndex) || 0));
    return { z, max };
  }, { x: secondHead.x + 30, y: secondHead.y + 12 });
  if (!raised || raised.z < raised.max) {
    errors.push(`点击卡片没有置顶：${JSON.stringify(zBefore)} → ${JSON.stringify(raised)}`);
  }
}
await shot('10d-compare-detail');

// 舞台平移：滚轮/触控板
const planeBefore = await page.locator('.pd-compare-plane').first().evaluate((el) => el.style.transform);
// 移到舞台的空白角落再滚，避免落在卡片/详情上（那里滚轮归它们）
const stageBox = await page.locator('.pd-compare-stage').boundingBox();
await page.mouse.move(stageBox.x + stageBox.width - 30, stageBox.y + stageBox.height - 30);
await page.mouse.wheel(120, 90);
await page.waitForTimeout(200);
const planeAfter = await page.locator('.pd-compare-plane').first().evaluate((el) => el.style.transform);
if (planeBefore === planeAfter) errors.push('滚轮没有平移对比舞台');
const headBox = await page.locator('.pd-card-head').first().boundingBox();
await page.mouse.move(headBox.x + 30, headBox.y + 10);
await page.mouse.down();
await page.mouse.move(headBox.x + 90, headBox.y + 70, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);
if (!(await page.locator('.pd-card-detail').first().isVisible())) errors.push('拖动卡片后详情被收起了');

};

// 先验"旧一代宿主"提示：/health 不返回 assets 时，论文库顶部应该出现可执行的横幅
legacyHealth = true;
themeTag = 'light';
await page.goto(`http://127.0.0.1:${port}/preview.html`);
await page.waitForSelector('.pd-notice', { timeout: 5000 }).catch(() => errors.push('旧一代宿主的提示横幅没有出现'));
await shot('00-stale-notice');
legacyHealth = false;

themeTag = 'light';
await runFlow();
// 深色主题再跑一遍：只验首屏与画布（对比台结构相同），确认没有"深底深字"
themeTag = 'dark';
await page.close();
page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (error) => errors.push('pageerror(dark): ' + String(error)));
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  if (/Failed to load resource/.test(message.text())) return;
  errors.push('console(dark): ' + message.text());
});
await runFlow();

console.log('errors:', errors.length === 0 ? 'none' : errors.join('\n  '));
await browser.close();
server.close();
console.log('package under test:', pkgRoot);
console.log('shots in', shotDir);
