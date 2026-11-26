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
  return figures.map((figure, index) => `[${index}] ${String(figure.caption ?? '').trim()}`).join('\n');
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
    '  "formulas": [ { "name": "公式名", "latex": "LaTeX 源码", "explain": "这个公式在算什么、各符号含义（中文，2-4 句）" } ],',
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

  const principleFigure = figureFor(draft.principle?.figureIndex);
  const principleId = 'b-principle';
  push({
    id: principleId,
    type: 'principle',
    title: '核心原理',
    text: String(draft.principle?.summary ?? '').trim() || '（模型没有给出原理说明，可以在这里自己补写）',
    figureId: principleFigure?.id,
    x: COL_TEXT,
    y: 330,
    w: principleFigure ? FIGURE_W : TEXT_W,
  });
  edges.push({ from: motivationId, to: principleId });

  const formulaBlocks = (Array.isArray(draft.formulas) ? draft.formulas : []).slice(0, 6);
  formulaBlocks.forEach((formula, index) => {
    const id = `b-formula-${index + 1}`;
    push({
      id,
      type: 'formula',
      title: String(formula?.name ?? `关键公式 ${index + 1}`).trim() || `关键公式 ${index + 1}`,
      latex: String(formula?.latex ?? '').trim(),
      text: String(formula?.explain ?? '').trim(),
      x: COL_FORMULA,
      y: 32 + index * 280,
      // 公式比正文宽：长公式（多项目加权那种）在 300px 里会被横向截断
      w: FORMULA_W,
    });
    edges.push({ from: principleId, to: id });
  });

  // 实验类论文：操作步骤排在公式那一列（左侧第二列），现象排在结果那一列
  const stepBlocks = (Array.isArray(draft.steps) ? draft.steps : []).slice(0, 5);
  stepBlocks.forEach((step, index) => {
    const id = `b-step-${index + 1}`;
    push({
      id,
      type: 'method',
      title: String(step?.title ?? `步骤 ${index + 1}`).trim() || `步骤 ${index + 1}`,
      text: String(step?.text ?? '').trim(),
      x: COL_FORMULA,
      y: 32 + index * 250,
      w: FORMULA_W,
    });
    edges.push({ from: principleId, to: id });
  });

  const phenomenonBlocks = (Array.isArray(draft.phenomena) ? draft.phenomena : []).slice(0, 4);
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
      y: 330 + index * (figure ? 340 : 240),
      w: TEXT_W,
    });
    edges.push({ from: principleId, to: id });
  });

  const conclusionText = String(draft.conclusion ?? '').trim();
  if (conclusionText.length > 0) {
    const id = 'b-conclusion';
    const baseY = 330 + phenomenonBlocks.length * 260;
    push({
      id,
      type: 'conclusion',
      title: '结论与意义',
      text: conclusionText,
      x: COL_RESULT,
      y: baseY,
      w: TEXT_W,
    });
    edges.push({ from: principleId, to: id });
  }

  const resultBlocks = (Array.isArray(draft.results) ? draft.results : []).slice(0, 4);
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
      y: 330 + (phenomenonBlocks.length * 260) + index * (figure ? 340 : 250),
      w: TEXT_W,
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

/**
 * 生成一篇论文的记录。
 * @param ctx 宿主上下文
 * @param payload { title?, pages, figures, pdfBase64? }
 * @returns { paper, warning? }
 */
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
    const result = await complete(ctx, { system, messages: [{ role: 'user', content: user }], temperature: 0.2, timeoutMs: 180_000 });
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
