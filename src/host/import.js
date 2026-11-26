/**
 * 导入流水线的"理解"环节：把 PDF 抽出来的干文本 + 图注，整理成论文台的节点。
 *
 * 分工：
 *   - 浏览器负责"看"（pdf.js 抽文字、按图注裁图），因为只有浏览器有 canvas；
 *   - 宿主负责"懂"（一次 LLM 调用，产出动机 / 原理 / 公式 / 结果四类内容）；
 *   - LLM 不可用或返回不合法时，退回启发式分段（按章节标题切），保证导入永远不空手而归。
 */
import { complete, parseJsonReply } from './llm.js';

/**
 * 送进模型的正文上限。
 * 之前只给头部 26k + 尾部 4k，中间整段被丢掉——实测过一篇 13 页论文，λ 的具体取值
 * 正好落在被丢掉的那一段里，模型于是"编"了一个数字。多数论文全文都在 80k 以内，
 * 直接整篇给它；只有超长时才退回头尾切片。
 */
const HEAD_CHARS = 80000;
const TAIL_CHARS = 8000;

/** 存进 paper.json 的正文上限：再长就只留头尾，避免单篇文件过大。 */
const STORE_CHARS = 200000;

/**
 * 节点默认尺寸与列坐标。
 * 三列合计约 1030px，正好落在"右侧 372px 抽屉打开后仍可见"的画布宽度内，
 * 导入后不用先拖一遍才能看全。
 */
const TEXT_W = 300;
const FIGURE_W = 340;
const FORMULA_W = 380;
const COL_TEXT = 40;
/** 线性流程里相邻步骤的横向间距。 */
const COL_STEP = 380;
const COL_FORMULA = 450;
const COL_RESULT = 860;

/**
 * 拼出送进模型的正文：开头到底部 + 末尾结论段，中间省略。
 * @param pages [{ page, text }]
 */
function digestText(pages) {
  const joined = pages
    .map((entry) => `\n--- page ${entry.page} ---\n${String(entry.text ?? '').trim()}`)
    .join('\n')
    .trim();
  if (joined.length <= HEAD_CHARS + TAIL_CHARS) return joined;
  return `${joined.slice(0, HEAD_CHARS)}\n\n[... 中间省略 ...]\n\n${joined.slice(-TAIL_CHARS)}`;
}

/** 图注清单（给模型做编号映射用）。 */
function captionList(figures) {
  if (figures.length === 0) return '（没有识别到图注）';
  return figures
    .map((figure, index) => {
      const section = String(figure.section ?? '').trim();
      const where = section ? `（§${section}）` : '';
      return `[${index}] ${where}${String(figure.caption ?? '').trim()}`;
    })
    .join('\n');
}

/** 结构化提示词。 */
function buildPrompt(payload, digest, captions) {
  const system =
    '你是论文阅读助教。你只输出一个 JSON 对象，不输出任何解释、前言或 markdown 围栏。'
    + '所有中文文本用简体中文，术语保留英文原词。';
  const user = [
    '下面是一篇论文的正文与图注。先判断它属于哪一类：',
    '- "cs"：计算机/算法类，核心是问题、方法原理、公式；',
    '- "science"：实验科学类（化学、生物、材料、医学、地学等），核心是实验原理、操作步骤、现象、结论，通常没有公式。',
    '判断后按对应模板填写，并严格按这个 JSON 结构输出（用不到的数组给空数组）：',
    '{',
    '  "title": "论文标题（英文原题，没有就用文件名）",',
    '  "abstract": "摘要级的一句话概括（中文，60 字以内）",',
    '  "motivation": "它要解决的问题、为什么这个问题重要、之前方法卡在哪（中文，3-6 句）",',
    '  "principle": { "summary": "核心原理/方法怎么做，拆成可读的步骤说明（中文，5-10 句）", "figureIndex": 核心原理图在下面图注清单里的编号，没有就 -1 },',
    '  "formulas": [ { "name": "公式名", "latex": "LaTeX 源码", "section": "这条公式在论文哪一节，如 3.2 Method；拿不准写空字符串", "where": "这条公式作用在原理图的哪一部分：用正文/图注里出现过的模块名，如“右侧的跨域融合模块”“门控单元”；看不出就空字符串", "explain": "这个公式在算什么、各符号含义（中文，2-4 句）" } ],',
    '  "results": [ { "title": "结果/结论的短标题", "text": "这个结果说明了什么（中文，2-4 句）", "figureIndex": 对应结果图编号，没有就 -1 } ],',
    '  "steps": [ { "title": "步骤名（如 样品制备/前处理/表征）", "text": "这一步具体怎么做：试剂、比例、温度、时间、仪器参数（中文，2-6 句）" } ],',
    '  "phenomena": [ { "title": "现象/观测的短标题", "text": "观察到了什么、说明了什么（中文，2-4 句）", "figureIndex": 对应图/表编号，没有就 -1 } ],',
    '  "conclusion": "最后的结论与意义（中文，3-6 句；没有明确结论就给空字符串）"',
    '}',
    '要求：',
    '- cs 类：填 formulas（最多 4 条，挑关键目标函数/核心计算，latex 要能直接渲染），steps/phenomena 留空；',
    '- science 类：重点填 steps（最多 5 条，按实验顺序）、phenomena（最多 4 条）与 conclusion；formulas 通常留空，除非正文确实有计算公式；',
    '- step/现象里的数值、试剂、温度、时间要尽量保留原文数值，不要概括成"适当条件"；',
    '- figureIndex 只能取图注清单里出现过的编号，拿不准就写 -1，不要编造；',
    '- formulas 的 where 只写正文/图注里真的出现过的模块名，不要自己编模块名；看不出来就留空。',
    '- 每个文字字段内部分段：超过 3 句就用空行分成 2-3 段，不要写成一大段（卡片上会按空行分段落）。',
    '- 正文里提到符号或公式时，一律用 $...$ 包成行内公式（例如 $\\mathbf{z}_u^{final}$），',
    '  不要裸写 LaTeX 命令；变量名就写成 $x$、$\\theta$ 这种。',
    '',
    '=== 图注清单 ===',
    captions,
    '',
    '=== 正文 ===',
    digest,
    payload.title ? `\n（文件名提示：${payload.title}）` : '',
  ].join('\n');
  return { system, user };
}

/**
 * 问模型要结构化 JSON。
 *
 * 有些模型（尤其带推理的）会把输出预算全花在 reasoning 上，正文一个字没有，
 * 最终 finish=max-tokens —— 表现就是"导入出来的全是英文"（退回启发式分段，正文原样切）。
 * 所以这里做一次降级重试：缩短正文 + 显式关推理（模型支持时才会真的传）。
 *
 * @param ctx 宿主上下文
 * @param {{ system: string, user: string, digest: string }} prompt
 * @returns {Promise<{ok: boolean, text?: string, error?: string}>}
 */
async function askStructure(ctx, { system, user, digest }) {
  const attempt = (content, reasoningOff) =>
    complete(ctx, {
      system,
      messages: [{ role: 'user', content }],
      temperature: 0.2,
      timeoutMs: 180_000,
      maxTokens: 4096,
      ...(reasoningOff ? { reasoningOff: true } : {}),
    });
  const first = await attempt(user, false);
  if (first.ok || !/没有返回正文/.test(first.error ?? '')) return first;
  // 只出推理 / 被长度截断：把正文砍到 24k，并请求关推理再问一次
  const shorter = digest.length > 24_000 ? user.replace(digest, digest.slice(0, 24_000)) : user;
  return attempt(shorter, true);
}

/** 章节切分用的标题正则。 */
const SECTION_RE = /^(?:\d+(?:\.\d+)*\.?\s+)?(abstract|introduction|related work|background|method|methods|approach|proposed|model|experiment|experiments|evaluation|results|discussion|conclusion|limitation)s?\b/i;

/**
 * 启发式分段（LLM 不可用时的兜底）。
 * @param pages [{ page, text }]
 * @param figures 图注数组
 */
function heuristicDraft(pages, figures) {
  const lines = pages.flatMap((entry) => String(entry.text ?? '').split('\n'));
  const sections = [];
  let current = { title: 'body', lines: [] };
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const match = line.match(SECTION_RE);
    if (match && line.length < 64) {
      if (current.lines.length > 0) sections.push(current);
      current = { title: match[1].toLowerCase(), lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.length > 0) sections.push(current);
  const textOf = (name) => sections.filter((s) => s.title === name).map((s) => s.lines.join(' ')).join(' ');
  const motivation = (textOf('abstract') || sections[0]?.lines.slice(0, 12).join(' ') || '').slice(0, 1200);
  const principle = (textOf('method') || textOf('approach') || textOf('proposed') || textOf('model') || '').slice(0, 2400);
  const resultText = (textOf('results') || textOf('experiment') || textOf('evaluation') || textOf('conclusion') || '').slice(0, 1600);
  const formulaLines = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 8 && line.length < 260 && /[=≈≤≥]/.test(line) && (line.match(/[A-Za-z]/g) ?? []).length > 3)
    .slice(0, 4);
  return {
    title: '',
    abstract: motivation.slice(0, 120),
    motivation,
    principle: { summary: principle, figureIndex: figures.length > 0 ? 0 : -1 },
    formulas: formulaLines.map((line, index) => ({
      name: `关键公式 ${index + 1}`,
      latex: line.replace(/[，。；]$/, ''),
      explain: '（自动摘录，建议核对符号含义后补一句说明）',
    })),
    results: resultText.length > 0 ? [{ title: '主要结果', text: resultText, figureIndex: figures.length > 1 ? 1 : -1 }] : [],
    steps: [],
    phenomena: [],
    conclusion: '',
  };
}

/**
 * 全文（存起来给逐块提问做检索用）。
 * @param pages [{ page, text }]
 */
function fullText(pages) {
  const joined = pages
    .map((entry) => String(entry.text ?? '').trim())
    .filter((text) => text.length > 0)
    .join('\n');
  if (joined.length <= STORE_CHARS) return joined;
  return `${joined.slice(0, STORE_CHARS)}\n\n[... 超出保存上限，后文未保存 ...]`;
}

/**
 * 把草稿（模型给的或启发式的）落成节点骨架。
 * @param draft 结构化草稿
 * @param figures 图文件 id 列表（与图注同序）
 * @param fallbackTitle 标题兜底
 */
export function buildBlocks(draft, figures, fallbackTitle) {
  const blocks = [];
  const edges = [];
  const push = (block) => {
    blocks.push(block);
    return block;
  };
  const figureFor = (index) => {
    if (typeof index !== 'number' || index < 0 || index >= figures.length) return undefined;
    return figures[index];
  };

  const motivationId = 'b-motivation';
  push({
    id: motivationId,
    type: 'motivation',
    title: '解决的问题与动机',
    text: String(draft.motivation ?? '').trim() || '（模型没有给出动机段落，可以在这里自己补写）',
    x: COL_TEXT,
    y: 32,
    w: TEXT_W,
  });

  const backgroundText = String(draft.background ?? '').trim();
  const backgroundId = 'b-background';
  if (backgroundText.length > 0) {
    push({
      id: backgroundId,
      type: 'background',
      title: '背景与已有工作',
      text: backgroundText,
      x: COL_TEXT + 380,
      y: 32,
      w: TEXT_W,
    });
    edges.push({ from: motivationId, to: backgroundId });
  }

  const principleFigure = figureFor(draft.principle?.figureIndex);
  const principleId = 'b-principle';
  push({
    id: principleId,
    type: 'principle',
    title: '核心原理',
    text: String(draft.principle?.summary ?? '').trim() || '（模型没有给出原理说明，可以在这里自己补写）',
    figureId: principleFigure?.id,
    x: COL_TEXT + 380,
    y: 330,
    w: principleFigure ? FIGURE_W : TEXT_W,
  });
  edges.push({ from: backgroundText.length > 0 ? backgroundId : motivationId, to: principleId });

  const questions = Array.isArray(draft.questions) ? draft.questions.slice(0, 4) : [];
  // 模型偷懒不写 questions 时，用结果/现象倒推成"问题链"：至少保证图是从左到右的因果链，
  // 而不是一堆从原理节点射出去的线（用户反馈的"刺猬图"）。
  const hasSteps = Array.isArray(draft.steps) && draft.steps.length > 0;
  if (questions.length === 0 && !hasSteps) {
    const deriveFrom = [
      ...(Array.isArray(draft.results) ? draft.results : []).map((item) => ({ title: item?.title, text: item?.text, figureIndex: item?.figureIndex })),
      ...(Array.isArray(draft.phenomena) ? draft.phenomena : []).map((item) => ({ title: item?.title, text: item?.text, figureIndex: item?.figureIndex })),
    ].filter((item) => String(item.text ?? '').trim().length > 0);
    for (const item of deriveFrom.slice(0, 3)) {
      questions.push({
        question: String(item.title ?? '').trim() || `研究点 ${questions.length + 1}`,
        principle: String(draft.principle?.summary ?? '').slice(0, 600),
        experiments: [{ name: String(item.title ?? '').trim() || '实验/观测', text: item.text, figureIndex: item.figureIndex }],
        conclusion: String(draft.conclusion ?? '').trim() || String(item.text ?? '').slice(0, 200),
      });
    }
  }
  if (questions.length > 0) {
    // 一个子问题一行：问题 → 方法 → 实验 → 结论，横向排开，像流程图一样读
    const COL_Q = COL_TEXT + 720;
    const COL_METHOD = COL_Q + 360;
    const COL_EXP = COL_METHOD + 380;
    const COL_CONCL = COL_EXP + 380;
    let rowY = 32;
    questions.forEach((question, index) => {
      const qId = `b-question-${index + 1}`;
      const qFigure = figureFor(question?.figureIndex);
      push({
        id: qId,
        type: 'question',
        title: `研究问题 ${index + 1}`,
        text: String(question?.question ?? '').trim() || '（这个子问题）',
        figureId: qFigure?.id,
        x: COL_Q,
        y: rowY,
        w: qFigure ? FIGURE_W : TEXT_W,
      });
      edges.push({ from: principleId, to: qId });

      const methodId = `b-method-${index + 1}`;
      const experiment = Array.isArray(question?.experiments) ? question.experiments[0] : undefined;
      const expFigure = figureFor(experiment?.figureIndex);
      push({
        id: methodId,
        type: 'method',
        title: `方法 · ${String(question?.question ?? `问题 ${index + 1}`).trim().slice(0, 24)}`,
        text: String(question?.principle ?? '').trim() || '（这一步的方法）',
        x: COL_METHOD,
        y: rowY,
        w: TEXT_W,
      });
      edges.push({ from: qId, to: methodId });

      const experimentId = `b-experiment-${index + 1}`;
      push({
        id: experimentId,
        type: 'phenomenon',
        title: String(experiment?.name ?? `实验 ${index + 1}`).trim() || `实验 ${index + 1}`,
        text: String(experiment?.text ?? '').trim() || '（这一步的实验与观察）',
        figureId: expFigure?.id,
        x: COL_EXP,
        y: rowY,
        w: expFigure ? FIGURE_W : TEXT_W,
      });
      edges.push({ from: methodId, to: experimentId });

      const conclusionText = String(question?.conclusion ?? '').trim();
      if (conclusionText.length > 0) {
        const conclusionId = `b-conclusion-${index + 1}`;
        push({
          id: conclusionId,
          type: 'conclusion',
          title: `结论 · 问题 ${index + 1}`,
          text: conclusionText,
          x: COL_CONCL,
          y: rowY,
          w: TEXT_W,
        });
        edges.push({ from: experimentId, to: conclusionId });
      }

      // 行高：按这一行最高的那个节点往下排
      rowY += expFigure || qFigure ? 420 : 300;
    });

    // 核心公式：0.13.x 之前这段被问题链的 return 跳过，导致"最新的思路流没有公式"。
    // 排法：跟「核心原理」同一列、接在它下面往下叠 —— 纵向连线（edgePath 的竖排分支），
    // 横向给右侧的问题链留出干净的一列，不会出现斜线穿过卡片。
    const questionFormulas = (Array.isArray(draft.formulas) ? draft.formulas : []).slice(0, 4);
    const principleHeight = principleFigure ? 420 : 300;
    const formulaTop = 330 + principleHeight + 26;
    questionFormulas.forEach((formula, index) => {
      const latex = String(formula?.latex ?? '').trim();
      if (latex.length === 0) return;
      const id = `b-formula-${index + 1}`;
      push({
        id,
        type: 'formula',
        title: String(formula?.name ?? `关键公式 ${index + 1}`).trim() || `关键公式 ${index + 1}`,
        latex,
        section: String(formula?.section ?? '').trim(),
        where: String(formula?.where ?? '').trim(),
        figureRef: principleFigure?.id,
        text: String(formula?.explain ?? '').trim(),
        x: COL_TEXT + 380,
        y: formulaTop + index * 250,
        w: 320,
      });
      edges.push({ from: principleId, to: id });
    });

    return {
      title: String(draft.title ?? '').trim() || fallbackTitle,
      abstract: String(draft.abstract ?? '').trim(),
      blocks,
      edges,
    };
  }

  const formulaBlocks = (Array.isArray(draft.formulas) ? draft.formulas : []).slice(0, 6);
  formulaBlocks.forEach((formula, index) => {
    const id = `b-formula-${index + 1}`;
    push({
      id,
      type: 'formula',
      title: String(formula?.name ?? `关键公式 ${index + 1}`).trim() || `关键公式 ${index + 1}`,
      latex: String(formula?.latex ?? '').trim(),
      section: String(formula?.section ?? '').trim(),
      where: String(formula?.where ?? '').trim(),
      figureRef: principleFigure?.id,
      text: String(formula?.explain ?? '').trim(),
      x: COL_FORMULA,
      y: 32 + index * 280,
      // 公式比正文宽：长公式（多项目加权那种）在 300px 里会被横向截断
      w: FORMULA_W,
    });
    edges.push({ from: principleId, to: id });
  });

  // 实验类论文：步骤 → 现象 → 结果 → 结论 是"先做这个、再做那个"的过程，
  // 必须串成一条链。之前每个节点都从「核心原理」射出去，排完版就是一列竖着的刺猬
  // （用户反馈："步骤应该是线性连通的呀，为什么不连在一起"）。
  const stepBlocks = (Array.isArray(draft.steps) ? draft.steps : []).slice(0, 5);
  const phenomenonBlocks = (Array.isArray(draft.phenomena) ? draft.phenomena : []).slice(0, 4);
  const resultBlocks = (Array.isArray(draft.results) ? draft.results : []).slice(0, 4);
  const conclusionText = String(draft.conclusion ?? '').trim();
  /** 线性链上的节点 id，按"步骤 → 现象 → 结果 → 结论"排好。 */
  const chain = [];

  stepBlocks.forEach((step, index) => {
    const id = `b-step-${index + 1}`;
    push({
      id,
      type: 'method',
      title: String(step?.title ?? `步骤 ${index + 1}`).trim() || `步骤 ${index + 1}`,
      text: String(step?.text ?? '').trim(),
      x: COL_FORMULA,
      y: 330,
      w: FORMULA_W,
    });
    chain.push(id);
  });

  phenomenonBlocks.forEach((item, index) => {
    const id = `b-phenomenon-${index + 1}`;
    const figure = figureFor(item?.figureIndex);
    push({
      id,
      type: 'phenomenon',
      title: String(item?.title ?? `现象 ${index + 1}`).trim() || `现象 ${index + 1}`,
      text: String(item?.text ?? '').trim(),
      figureId: figure?.id,
      x: COL_RESULT,
      y: 330,
      w: TEXT_W,
    });
    chain.push(id);
  });

  resultBlocks.forEach((result, index) => {
    const id = `b-result-${index + 1}`;
    const figure = figureFor(result?.figureIndex);
    push({
      id,
      type: 'result',
      title: String(result?.title ?? `结果 ${index + 1}`).trim() || `结果 ${index + 1}`,
      text: String(result?.text ?? '').trim(),
      figureId: figure?.id,
      x: COL_RESULT,
      y: 330,
      w: TEXT_W,
    });
    chain.push(id);
  });

  if (conclusionText.length > 0) {
    push({
      id: 'b-conclusion',
      type: 'conclusion',
      title: '结论与意义',
      text: conclusionText,
      x: COL_RESULT,
      y: 330,
      w: TEXT_W,
    });
    chain.push('b-conclusion');
  }

  if (chain.length > 0) {
    // 串成一条线：原理 → 步骤1 → 步骤2 → … → 现象 → 结果 → 结论
    let previous = principleId;
    for (const id of chain) {
      edges.push({ from: previous, to: id });
      previous = id;
    }
    // 初始坐标先摆成一行（导入后会立刻自动整理成蛇形）；没有步骤/现象的纯公式论文保持原布局
    const linear = stepBlocks.length + phenomenonBlocks.length > 0;
    chain.forEach((id, index) => {
      const block = blocks.find((item) => item.id === id);
      if (!block) return;
      block.x = linear ? COL_FORMULA + index * COL_STEP : COL_RESULT;
      block.y = linear ? 330 : 330 + index * 260;
    });
  }

  return {
    title: String(draft.title ?? '').trim() || fallbackTitle,
    abstract: String(draft.abstract ?? '').trim(),
    blocks,
    edges,
  };
}

/**
 * 生成一篇论文的记录。
 * @param ctx 宿主上下文
 * @param payload { title?, pages, figures, pdfBase64? }
 * @returns { paper, warning? }
 */
/**
 * 把已有论文重新分析一遍：用存下来的全文 + 图注再跑一次 LLM，产出新的节点与连线。
 * 只换结构，不动 figures / 笔记 / 会话（迁移由 migrateAnnotations 负责）。
 *
 * @param ctx 宿主上下文
 * @param doc 已有的 paper 记录（需要 doc.text）
 * @returns {Promise<{blocks:Array, edges:Array, title:string, abstract:string, warning?:string}>}
 */
export async function reanalyzePaper(ctx, doc) {
  const text = String(doc.text ?? '');
  if (text.trim().length < 400) throw new Error('这篇没有保存正文，无法重新分析');
  const pages = [{ page: 1, text }];
  const figures = (doc.figures ?? []).map((figure, index) => ({ ...figure, id: figure.id ?? `f-${index + 1}` }));
  const digest = digestText(pages);
  const captions = captionList(figures);
  const { system, user } = buildPrompt({ title: doc.title }, digest, captions);
  const result = await askStructure(ctx, { system, user, digest });
  if (!result.ok) throw new Error(`模型分析失败：${result.error}`);
  let parsed = parseJsonReply(result.text);
  if (!parsed || typeof parsed !== 'object') {
    // 补救一次：把原始输出丢回去，只要求它修成严格 JSON（比让用户重试更可靠）
    const repair = await complete(ctx, {
      system: '你只输出严格 JSON，不要解释，不要 markdown 围栏。',
      messages: [
        {
          role: 'user',
          content: [
            '下面这段本来应该是论文结构 JSON，但格式坏了（可能被截断）。请补全并输出完整、合法的 JSON，',
            '保持原有字段名，字段过长可以压缩，但不要新增解释文字。',
            '',
            String(result.text ?? '').slice(0, 12_000),
          ].join('\n'),
        },
      ],
      temperature: 0,
      timeoutMs: 120_000,
      maxTokens: 4096,
    });
    if (repair.ok) parsed = parseJsonReply(repair.text);
  }
  if (!parsed || typeof parsed !== 'object') {
    // 把开头的原文带出来：不然用户只看到"不是合法 JSON"，我也无从判断是截断还是格式问题
    const preview = String(result.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
    throw new Error(`模型返回的不是合法 JSON（开头：${preview || '空'}）。可以再试一次，或换一个模型。`);
  }
  const built = buildBlocks(parsed, figures, String(doc.title ?? '未命名论文'));
  return { blocks: built.blocks, edges: built.edges, title: built.title, abstract: built.abstract };
}

/** 归一化标题，用于把旧节点和新节点对上。 */
function normalizeTitle(title) {
  return String(title ?? '')
    .replace(/\s+/g, '')
    .replace(/[：:·,，.。()（）[\]【】]/g, '')
    .toLowerCase();
}

/**
 * 重新分析时把旧的笔记 / 会话迁到新节点上。
 *
 * 顺序：先按标题精确匹配 → 再按同类型同序号的节点 → 都不行就挂到"整篇"（blockId = null），
 * 宁可变成整篇笔记，也不要把用户写的东西丢掉。
 *
 * @param {Array} oldBlocks 旧节点
 * @param {Array} newBlocks 新节点
 * @param {Array} notes 旧笔记
 * @param {Array} chats 旧会话
 * @returns {{notes:Array, chats:Array, movedNotes:number, movedChats:number}}
 */
export function migrateAnnotations(oldBlocks, newBlocks, notes, chats) {
  const byTitle = new Map();
  for (const block of newBlocks) byTitle.set(normalizeTitle(block.title), block);
  const byType = new Map();
  for (const block of newBlocks) byType.set(block.type, [...(byType.get(block.type) ?? []), block]);
  const sameTypeIndex = new Map();
  for (const block of oldBlocks) {
    const list = byType.get(block.type) ?? [];
    const index = sameTypeIndex.get(block.type) ?? 0;
    sameTypeIndex.set(block.type, index + 1);
    if (list[index]) sameTypeIndex.set(`map:${block.id}`, list[index].id);
  }
  /** 旧 id → 新 id（可能没有）。 */
  const remap = (oldId) => {
    const old = oldBlocks.find((block) => block.id === oldId);
    if (!old) return null;
    const byName = byTitle.get(normalizeTitle(old.title));
    if (byName) return byName.id;
    return sameTypeIndex.get(`map:${oldId}`) ?? null;
  };

  let movedNotes = 0;
  const nextNotes = (Array.isArray(notes) ? notes : []).map((note) => {
    if (!note.blockId) return note;
    const next = remap(note.blockId);
    movedNotes += 1;
    return { ...note, blockId: next ?? undefined };
  });
  let movedChats = 0;
  const nextChats = (Array.isArray(chats) ? chats : []).map((chat) => {
    if (!chat.blockId) return chat;
    const next = remap(chat.blockId);
    movedChats += 1;
    return next ? { ...chat, blockId: next } : { ...chat, blockId: null };
  });
  return { notes: nextNotes, chats: nextChats, movedNotes, movedChats };
}

export async function structurePaper(ctx, payload) {
  const pages = Array.isArray(payload.pages) ? payload.pages : [];
  const figures = Array.isArray(payload.figures) ? payload.figures.map((f, i) => ({ ...f, id: `f-${i + 1}` })) : [];
  const digest = digestText(pages);
  const fallbackTitle = String(payload.title ?? '').trim() || '未命名论文';

  let draft;
  let warning;
  if (digest.length < 400) {
    warning = 'PDF 里几乎抽不出文字（可能是扫描件），已建立空骨架，请手动补内容';
    draft = heuristicDraft(pages, figures);
  } else {
    const { system, user } = buildPrompt(payload, digest, captionList(figures));
    // 推理模型可能把预算全花在思考上（finish=max-tokens、正文为空），这里带一次降级重试
    const result = await askStructure(ctx, { system, user, digest });
    if (!result.ok) {
      warning = `模型分段失败（${result.error}），已退回按章节自动切分`;
      draft = heuristicDraft(pages, figures);
    } else {
      const parsed = parseJsonReply(result.text);
      if (!parsed || typeof parsed !== 'object') {
        warning = '模型返回的不是合法 JSON，已退回按章节自动切分';
        draft = heuristicDraft(pages, figures);
      } else {
        draft = parsed;
      }
    }
  }

  const built = buildBlocks(draft, figures, fallbackTitle);
  const paper = {
    title: built.title,
    abstract: built.abstract,
    blocks: built.blocks,
    edges: built.edges,
    figures,
    // 全文留在 paper 里：逐块提问时按问题检索相关段落，模型才有出处可依据。
    text: fullText(pages),
  };
  return warning ? { paper, warning } : { paper };
}
