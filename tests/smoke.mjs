/**
 * 宿主半侧的自检（不依赖 DSH、不依赖模型）：起一个临时 http 服务，把路由跑一遍。
 * 用法：node tests/smoke.mjs（默认用 .tmptest/home-smoke 当 DSH_HOME，避免碰真实数据）
 */
import { createServer as createHttpServer } from 'node:http';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const PREFIX = '/dsh-paper-desk-4821';
// 必须在 import server.js 之前设好：store.js 在模块加载时就会解析 DSH_HOME。
// 注意：不能用继承来的 DSH_HOME（那可能是真实数据目录），一律用自己的临时目录。
const home = join(import.meta.dirname, '..', '.tmptest', 'home-smoke');
if (!home.includes('.tmptest')) {
  console.error('拒绝在非测试目录上跑：' + home);
  process.exit(1);
}
process.env.DSH_HOME = home;
const { createServer } = await import('../src/host/server.js');
// 自检要可重复：先清掉上一轮留下的库，否则"空库"这类断言会误报
await rm(home, { recursive: true, force: true });

/** 假 ctx：没有 llm / agentDefaultModel。 */
const ctx = { get: () => undefined, logger: { info() {}, warn: console.warn } };
const handler = createServer(ctx, PREFIX);
const server = createHttpServer((req, res) => handler(req, res));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

const json = async (path, options) => {
  const response = await fetch(base + path, {
    method: options?.method ?? 'GET',
    headers: options?.body ? { 'content-type': 'application/json' } : undefined,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { status: response.status, payload };
};

const health = await json('/health');
check(
  'health',
  health.status === 200 && health.payload.llmReady === false && health.payload.assets.pdfjs === true && health.payload.assets.worker === true,
  JSON.stringify(health.payload),
);

const empty = await json('/state');
check('state 空库', empty.status === 200 && empty.payload.papers.length === 0 && Array.isArray(empty.payload.categories));

const created = await json('/category', { method: 'POST', body: { name: 'continual-learning' } });
check('新建分类', created.status === 200 && created.payload.category.name === 'continual-learning');

const dup = await json('/category', { method: 'POST', body: { name: 'continual-learning' } });
check('同名分类被拒', dup.status === 409);

const pages = [
  { page: 1, text: 'Abstract\nContinual learning without forgetting is the goal. We propose a method.\n1 Introduction\nThe problem is catastrophic forgetting. Prior work fails.\n2 Method\nWe keep a small buffer and replay. Our loss is L = CE + lambda * KD.\n3 Experiments\nWe improve ACC by 3 points on Split-CIFAR. Table 1 shows results.\n4 Conclusion\nOur method works.' },
];
const imported = await json('/paper/import', {
  method: 'POST',
  body: {
    title: 'demo.pdf',
    categoryId: created.payload.category.id,
    pages,
    figures: [],
  },
});
check('导入（无模型 → 启发式兜底）', imported.status === 200 && typeof imported.payload.id === 'string', JSON.stringify(imported.payload).slice(0, 200));

const paper = await json(`/paper?id=${encodeURIComponent(imported.payload.id)}`);
const doc = paper.payload.paper;
check(
  '读论文 + 自动分段',
  paper.status === 200 && doc.blocks.length >= 2 && doc.blocks.some((block) => block.type === 'motivation') && doc.blocks.some((block) => block.type === 'principle'),
  `blocks=${doc.blocks.map((block) => block.type).join(',')}`,
);

const withFigures = await json('/paper/import', {
  method: 'POST',
  body: {
    title: 'figures.pdf',
    pages,
    figures: [
      { caption: 'Figure 1: architecture', page: 1, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
      { caption: 'Figure 2: results', page: 1, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
    ],
  },
});
const figDoc = (await json(`/paper?id=${encodeURIComponent(withFigures.payload.id)}`)).payload.paper;
check(
  '多图分别落盘（fig-1/fig-2，不是 fig-NaN）',
  figDoc.figures.length === 2 && figDoc.figures[0].file === 'fig-1.png' && figDoc.figures[1].file === 'fig-2.png',
  figDoc.figures.map((f) => f.file).join(','),
);
const figAsset = await fetch(`${base}/asset?paper=${encodeURIComponent(withFigures.payload.id)}&file=fig-2.png`);
check('图能按路由取到', figAsset.status === 200 && (await figAsset.arrayBuffer()).byteLength > 0);
await json(`/paper?id=${encodeURIComponent(withFigures.payload.id)}`, { method: 'DELETE' });

check(
  '导入时保存了正文（供逐块提问检索）',
  typeof paper.payload.textChars === 'number' && paper.payload.textChars > 200 && doc.text === undefined,
  `textChars=${paper.payload.textChars}，客户端不回传全文=${doc.text === undefined}`,
);

const summary = await json('/state');
check('列表摘要', summary.payload.papers.length === 1 && summary.payload.papers[0].blockCount === doc.blocks.length);

const moved = doc.blocks.map((block) => ({ ...block, x: (block.x ?? 0) + 10 }));
const patched = await json('/paper', { method: 'PATCH', body: { id: doc.id, patch: { blocks: moved, notes: [{ id: 'n1', kind: 'user', text: 'FWT 没懂', blockId: null, createdAt: 1 }] } } });
check('PATCH 节点位置与笔记', patched.status === 200);
const after = await json(`/paper?id=${encodeURIComponent(doc.id)}`);
check('PATCH 已落盘', after.payload.paper.blocks[0].x === moved[0].x && after.payload.paper.notes.length === 1);

const chat = await json('/paper/chat', { method: 'POST', body: { id: doc.id, blockId: doc.blocks[0].id, message: '这块什么意思' } });
check('无模型时会话报错但不 500', chat.status === 502 && typeof chat.payload.error === 'string', chat.payload.error);

// 流式接口：无模型时要回 SSE 的 error 帧，而不是 500/挂死
const streamRes = await fetch(`${base}/paper/chat/stream`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: doc.id, blockId: doc.blocks[0].id, message: '这块什么意思' }),
});
const streamBody = await streamRes.text();
check(
  '流式提问在没有模型时回 error 帧',
  streamRes.status === 200 && streamBody.includes('"type":"error"') && streamBody.includes('LLM'),
  streamBody.slice(0, 120),
);

const core = await json('/paper/core', { method: 'POST', body: { id: doc.id } });
check('无模型时 core 报错', core.status === 502, core.payload.error);

const upload = await json('/paper/figure', {
  method: 'POST',
  body: { id: doc.id, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', caption: '手测上传' },
});
check('上传图片：返回新图并落盘', upload.status === 200 && typeof upload.payload.figure?.file === 'string', JSON.stringify(upload.payload).slice(0, 80));
const afterUpload = (await json(`/paper?id=${encodeURIComponent(doc.id)}`)).payload.paper;
check('上传的图进了 figures', afterUpload.figures.some((fig) => fig.file === upload.payload.figure.file));

// 实验类论文（化学/生物）：步骤 / 现象 / 结论 要能被建成节点
{
  const { buildBlocks } = await import('../src/host/import.js');
  const built = buildBlocks(
    {
      title: 'A chemistry paper',
      abstract: '一句话概括',
      motivation: '为什么要做这个实验',
      principle: { summary: '实验原理说明', figureIndex: -1 },
      formulas: [],
      results: [],
      steps: [
        { title: '样品制备', text: '取 0.5 g 粉末加入 20 mL 水，60 ℃ 搅拌 30 min' },
        { title: '表征', text: '用 XRD 与 SEM 观察形貌' },
      ],
      phenomena: [{ title: '颜色变化', text: '溶液由无色变为深蓝', figureIndex: -1 }],
      conclusion: '该体系在温和条件下即可完成转化',
    },
    [],
    'fallback',
  );
  const types = built.blocks.map((block) => block.type);
  check('实验类：有步骤节点', types.filter((type) => type === 'method').length === 2, types.join(','));
  check('实验类：有现象节点', types.includes('phenomenon'), types.join(','));
  check('实验类：有结论节点', types.includes('conclusion'), types.join(','));
  check('实验类：没有公式节点', !types.includes('formula'), types.join(','));
}

// 流程图模式：研究问题为主线时，节点按"问题 → 方法 → 实验 → 结论"横向排开
{
  const { buildBlocks } = await import('../src/host/import.js');
  const flow = buildBlocks(
    {
      title: 'flow paper',
      abstract: 'a',
      motivation: '为什么要做',
      background: '别人做过什么',
      principle: { summary: '总原理', figureIndex: -1 },
      questions: [
        { question: '问题一', principle: '方法一', experiments: [{ name: '实验一', text: '结果一' }], conclusion: '结论一' },
        { question: '问题二', principle: '方法二', experiments: [{ name: '实验二', text: '结果二' }], conclusion: '结论二' },
      ],
    },
    [],
    't',
  );
  const byType = (type) => flow.blocks.filter((block) => block.type === type);
  check('流程图：背景/问题/结论节点都在', ['background', 'question', 'conclusion'].every((type) => byType(type).length > 0), flow.blocks.map((b) => b.type).join(','));
  const [q1] = byType('question');
  const [m1] = byType('method');
  const [e1] = byType('phenomenon');
  const [c1] = byType('conclusion');
  check(
    '流程图：一行的横坐标递增',
    q1.x < m1.x && m1.x < e1.x && e1.x < c1.x,
    [q1.x, m1.x, e1.x, c1.x].join(' < '),
  );
  const chain = flow.edges.map((edge) => `${edge.from}>${edge.to}`);
  check(
    '流程图：问题串成链而不是扇形',
    chain.includes('b-question-1>b-method-1') && chain.includes('b-method-1>b-experiment-1') && chain.includes('b-experiment-1>b-conclusion-1'),
    chain.join(' '),
  );
  check('流程图：两个问题的结论各自独立', byType('conclusion').length === 2);
}

// 重新裁图：替换 figures、保持节点 figureId 可解析、清掉不再引用的旧文件
const recrop = await json('/paper/figures', {
  method: 'POST',
  body: {
    id: doc.id,
    figures: [
      { caption: 'Figure 1: architecture', page: 1, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
      { caption: 'Figure 2: results', page: 1, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
    ],
  },
});
check('重新裁图：返回替换数量', recrop.status === 200 && recrop.payload.figures === 2, JSON.stringify(recrop.payload).slice(0, 60));
const recropped = (await json(`/paper?id=${encodeURIComponent(doc.id)}`)).payload.paper;
const dangling = (recropped.blocks ?? []).filter((block) => block.figureId && !recropped.figures.some((figure) => figure.id === block.figureId));
check('重新裁图后没有悬空的 figureId', dangling.length === 0, `${dangling.length} 个悬空`);

const openPdf = await json('/paper/open-pdf', { method: 'POST', body: { id: 'nope' } });
check('系统预览：不存在的论文返回 404', openPdf.status === 404);

const models = await json('/models');
check('模型清单路由（无模型时也要回结构）', models.status === 200 && Array.isArray(models.payload.providers), JSON.stringify(models.payload).slice(0, 120));

const cancel = await json('/paper/chat/cancel', { method: 'POST', body: { requestId: 'nope' } });
check('取消不存在的请求是幂等的', cancel.status === 200 && cancel.payload.cancelled === false);

const setting = await json('/setting');
check('读取数据目录', setting.status === 200 && setting.payload.dataDir.includes('data'), setting.payload.dataDir);

const nextDir = `${home}/moved-data`;
const movedDir = await json('/setting', { method: 'POST', body: { dataDir: nextDir } });
check('切换数据目录', movedDir.status === 200 && movedDir.payload.dataDir === nextDir, movedDir.payload.dataDir);

const stateAfter = await json('/state');
check('切目录后是空库', stateAfter.payload.papers.length === 0 && stateAfter.payload.dir === nextDir);

const bad = await json('/paper?id=nope');
check('不存在论文 404', bad.status === 404);

const asset = await fetch(`${base}/asset?paper=nope&file=../x.png`);
check('资源越权被拒', asset.status === 404);

await rm(nextDir, { recursive: true, force: true });
server.close();
const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
