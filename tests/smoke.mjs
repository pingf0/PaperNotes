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
  // 实验流程是"先做这个、再做那个"：必须是一条链，不能全从原理射出去
  const chain = built.edges.map((edge) => `${edge.from}>${edge.to}`);
  check(
    '实验类：步骤/现象/结论串成一条链',
    ['b-principle>b-step-1', 'b-step-1>b-step-2', 'b-step-2>b-phenomenon-1', 'b-phenomenon-1>b-conclusion'].every((edge) => chain.includes(edge)),
    chain.join(' '),
  );
  const indegree = new Map(built.blocks.map((block) => [block.id, 0]));
  for (const edge of built.edges) indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  const branched = [...indegree.entries()].filter(([, count]) => count > 1);
  check('实验类：链上每个节点最多一条入边（不是刺猬）', branched.length === 0, JSON.stringify(branched));
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

// 正文裁剪必须保留头尾：只截头部会把实验/结果/结论整段丢掉，模型就只回动机+原理+公式
{
  const { trimDigest } = await import('../src/host/import.js');
  const long = 'HEAD'.repeat(10000) + 'TAIL'.repeat(10000);
  const trimmed = trimDigest(long, 10000);
  check('正文裁剪保留头尾（结果段不会丢）', trimmed.length <= 10100 && trimmed.startsWith('HEAD') && trimmed.endsWith('TAIL'), `${trimmed.length}`);
  check('短正文不裁剪', trimDigest('abc', 100) === 'abc');
}

// 问题链模式也要把核心公式建出来（之前被 return 跳过，用户反馈"最新的思路流没有公式"）
{
  const { buildBlocks } = await import('../src/host/import.js');
  const flow = buildBlocks(
    {
      title: 'flow with formulas',
      motivation: '为什么要做',
      principle: { summary: '总原理', figureIndex: -1 },
      formulas: [
        { name: '目标函数', latex: 'L = -\\sum \\log \\sigma(x)', section: '3.2 Method', explain: '训练目标' },
        { name: '打分', latex: 's = u^T v', section: '', explain: '内积打分' },
      ],
      questions: [{ question: '问题一', principle: '方法一', experiments: [{ name: '实验一', text: '结果一' }], conclusion: '结论一' }],
    },
    [],
    't',
  );
  const formulaBlocks = flow.blocks.filter((block) => block.type === 'formula');
  const principle = flow.blocks.find((block) => block.type === 'principle');
  check('流程图：公式节点没有被问题链吞掉', formulaBlocks.length === 2, formulaBlocks.map((b) => b.title).join(','));
  check(
    '流程图：公式排在原理正下方（同一列、y 更大）',
    formulaBlocks.every((block) => block.x === principle.x && block.y > principle.y),
    `principle ${principle.x},${principle.y} → ` + formulaBlocks.map((b) => `${b.x},${b.y}`).join(' '),
  );
  check('流程图：公式挂在原理节点上', flow.edges.some((edge) => edge.from === principle.id && edge.to === formulaBlocks[0].id));
  const withResults = buildBlocks(
    {
      title: 'formulas + results',
      motivation: 'm',
      principle: { summary: 'p', figureIndex: -1 },
      formulas: [{ name: '目标函数', latex: 'L=\\sum x', explain: '训练目标' }],
      results: [
        { title: '效果更好', text: 'r1', figureIndex: -1 },
        { title: '消融有效', text: 'r2', figureIndex: -1 },
      ],
      conclusion: 'c',
    },
    [],
    't',
  );
  const typesWithResults = withResults.blocks.map((block) => block.type);
  check(
    '公式 + 结果同时存在时，问题链与公式都在（板块不会变少）',
    typesWithResults.filter((type) => type === 'question').length === 2
      && typesWithResults.includes('formula')
      && typesWithResults.includes('method')
      && typesWithResults.includes('phenomenon'),
    typesWithResults.join(','),
  );
  check('流程图：公式带上所在章节', formulaBlocks[0].section === '3.2 Method', JSON.stringify(formulaBlocks.map((b) => b.section)));
  const withWhere = buildBlocks(
    {
      title: 'formula where',
      motivation: 'm',
      principle: { summary: 'p', figureIndex: -1 },
      formulas: [{ name: '打分', latex: 's=u^Tv', where: '右侧的融合模块', explain: '打分' }],
      results: [{ title: '结果', text: 'r', figureIndex: -1 }],
    },
    [],
    't',
  );
  const applied = withWhere.blocks.find((block) => block.type === 'formula');
  check('公式：记录"作用于原理图的哪一部分"', applied.where === '右侧的融合模块', JSON.stringify(applied.where));
  check('流程图：原理右侧的问题列不被公式压到', formulaBlocks.every((block) => block.x + block.w <= 760), formulaBlocks.map((b) => b.x + b.w).join(','));
}

// 插件设置：模型列表、打码、默认模型、目录浏览
{
  const before = await json('/settings');
  check('设置：默认没有自定义模型', Array.isArray(before.payload.models) && before.payload.models.length === 0, JSON.stringify(before.payload.models));
  const saved = await json('/settings', {
    method: 'POST',
    body: {
      models: [
        { id: 'm-kimi', name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', apiKey: 'sk-abcdefgh12345678', model: 'moonshot-v1-32k' },
      ],
      activeModelId: 'm-kimi',
      temperature: 5,
      persona: '你是严谨的导师',
      prompts: { chat: '先给结论' },
    },
  });
  const kimi = (saved.payload.models ?? [])[0];
  check('设置：模型 Key 打码返回', /•/.test(kimi.apiKey) && !kimi.apiKey.includes('12345678'), kimi.apiKey);
  check('设置：温度被钳制到 1.5', saved.payload.temperature === 1.5, String(saved.payload.temperature));
  const again = await json('/settings', { method: 'POST', body: { models: [{ ...kimi }] } });
  check('设置：被打码的 Key 不会被覆盖', again.payload.models[0].hasKey === true && /[•]/.test(again.payload.models[0].apiKey));
  const models = await json('/models');
  const custom = (models.payload.providers ?? []).find((provider) => provider.id === 'custom');
  check('模型列表：自定义模型出现在会话可选项里', Boolean(custom && custom.models.some((item) => item.id === 'm-kimi')), JSON.stringify(custom));
  const dirs = await json('/fs/list');
  check('目录浏览：返回子目录与父目录', Array.isArray(dirs.payload.dirs) && typeof dirs.payload.path === 'string', dirs.payload.path);
  const pick = await json('/fs/pick-directory', { method: 'POST' });
  check('系统目录对话框：无 Electron 时优雅回 501', pick.status === 501 || pick.status === 200, String(pick.status));
  const bad = await json('/settings/test', { method: 'POST', body: { baseUrl: '', model: '' } });
  check('设置：测试连接缺参数时报错', bad.status === 400, JSON.stringify(bad.payload));
}

// 系统文件夹选择：宿主提供了 native 能力就直接用（macOS 访达面板 / Windows 资源管理器对话框），
// 拿不到才退回 Electron、再退回内置目录浏览器
{
  const serveWith = async (pickerCtx) => {
    const scopedHandler = createServer(pickerCtx, PREFIX);
    const scoped = createHttpServer((req, res) => scopedHandler(req, res));
    await new Promise((resolve) => scoped.listen(0, '127.0.0.1', resolve));
    return {
      base: `http://127.0.0.1:${scoped.address().port}${PREFIX}`,
      close: () => new Promise((resolve) => scoped.close(resolve)),
    };
  };
  const pickVia = async (picker) => {
    const instance = await serveWith({
      get: (name) => (name === 'directoryPicker' ? picker : undefined),
      logger: { info() {}, warn: console.warn },
    });
    try {
      const response = await fetch(`${instance.base}/fs/pick-directory`, { method: 'POST' });
      return { status: response.status, payload: await response.json() };
    } finally {
      await instance.close();
    }
  };
  const native = await pickVia({ capability: () => ({ kind: 'native', pick: async () => '/tmp/pd-picked' }) });
  check('系统文件夹选择：优先走宿主的 native 选择器', native.status === 200 && native.payload.path === '/tmp/pd-picked', JSON.stringify(native.payload));
  const canceled = await pickVia({ capability: () => ({ kind: 'native', pick: async () => null }) });
  check('系统文件夹选择：用户取消时回 canceled', canceled.status === 200 && canceled.payload.canceled === true, JSON.stringify(canceled.payload));
  const browse = await pickVia({ capability: () => ({ kind: 'browse', list: async () => ({ path: '/' }) }) });
  check('系统文件夹选择：browse 后端不冒充原生对话框', browse.status === 501, String(browse.status));
}

// 重新分析：模型不可用时要回 502（前端会显示原因），而不是 500 或挂死
{
  const res = await json('/paper/reanalyze', { method: 'POST', body: { id: doc.id } });
  check('重新分析：没有模型时回 502 并说明原因', res.status === 502 && String(res.payload.error ?? '').length > 0, String(res.payload.error ?? '').slice(0, 60));
}

// 笔记/会话迁移：按标题优先、再按同类型序号，迁不动就降级成整篇
{
  const { migrateAnnotations } = await import('../src/host/import.js');
  const migrated = migrateAnnotations(
    [
      { id: 'old-p', title: '核心原理', type: 'principle' },
      { id: 'old-r', title: '结果 1', type: 'result' },
      { id: 'old-x', title: '手写节点', type: 'custom' },
    ],
    [
      { id: 'new-p', title: '核心原理', type: 'principle' },
      { id: 'new-q', title: '研究问题 1', type: 'question' },
    ],
    [
      { id: 'n1', blockId: 'old-p', text: '标题能对上' },
      { id: 'n2', blockId: 'old-x', text: '对不上就降级' },
    ],
    [{ blockId: 'old-r', messages: [] }],
  );
  check('迁移：标题能对上的笔记留在原节点', migrated.notes[0].blockId === 'new-p', JSON.stringify(migrated.notes[0]));
  check('迁移：对不上的笔记降级为整篇', migrated.notes[1].blockId === undefined, JSON.stringify(migrated.notes[1]));
  check('迁移：找不到对应节点的会话降级为整篇', migrated.chats[0].blockId === null, JSON.stringify(migrated.chats[0]));
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
