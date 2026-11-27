/**
 * 四类生成：逐节点会话、笔记浓缩、core 核、多论文对比讨论。
 *
 * 每类都只做三件事：拼上下文 → 调 complete → 返回结构化结果。
 * 失败时把原因原样带回前端（"模型不可用""超时"），不伪造内容。
 */
import { complete, streamText } from './llm.js';
import { getCachedSettings, readSettings } from './settings.js';

/** 排版要求：用户反馈"一大段太长"，统一要求短段落 / 列表。 */
const FORMAT_RULE =
  '排版要求：用短段落，每段 1-3 句、段与段之间空一行；有三点以上就用有序列表（1. 2. 3.）；不要把整段答案写成一大坨。';

/**
 * 拼出最终 system prompt：内置规则 + 用户在插件设置里写的角色设定与补充要求。
 * 内置规则不能被覆盖 —— 里面含"只用摘录、不要编数字、JSON 结构"这些硬约束。
 *
 * @param {string} base 内置规则
 * @param {'chat'|'core'|'compare'} surface 场景
 */
async function composeSystem(base, surface) {
  const settings = await readSettings().catch(() => getCachedSettings());
  const parts = [base];
  const persona = String(settings?.persona ?? '').trim();
  if (persona.length > 0) parts.push(`角色设定（用户指定，不违反上面的规则）：${persona}`);
  const extra = String(settings?.prompts?.[surface] ?? '').trim();
  if (extra.length > 0) parts.push(`这个场景的补充要求：${extra}`);
  return parts.join('\n\n');
}


/**
 * 把论文正文折成检索块。
 * 抽出来的文本是按行存的，先按累计长度折成 ~700 字的块，检索粒度接近"段落"。
 * @param {string} text 全文
 * @param {number} size 目标块大小
 * @returns {string[]}
 */
function chunkText(text, size = 700) {
  const lines = String(text ?? '').split('\n');
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if (current.length > 0 && current.length + line.length > size) {
      chunks.push(current.trim());
      current = '';
    }
    current += line + '\n';
  }
  if (current.trim().length > 0) chunks.push(current.trim());
  return chunks.filter((chunk) => chunk.length > 60);
}

/**
 * 希腊字母归一化成英文名：正文里写的是 λ，用户问的是 lambda（或反过来），不归一对不上。
 * @param {string} value 原文
 * @returns {string} 归一化后的文本
 */
function normalizeSymbols(value) {
  return String(value ?? '')
    .replace(/λ/g, 'lambda')
    .replace(/α/g, 'alpha')
    .replace(/β/g, 'beta')
    .replace(/γ/g, 'gamma')
    .replace(/δ/g, 'delta')
    .replace(/ε/g, 'epsilon')
    .replace(/η/g, 'eta')
    .replace(/θ/g, 'theta')
    .replace(/μ/g, 'mu')
    .replace(/σ/g, 'sigma')
    .replace(/τ/g, 'tau');
}

/**
 * 查询词：英文按单词、中文按二元组，避免中文提问检索不到中文正文。
 * @param {string} query
 * @returns {string[]}
 */
function queryTerms(query) {
  const lower = normalizeSymbols(String(query ?? '')).toLowerCase();
  const latin = lower.match(/[a-z][a-z0-9.\-]{2,}/g) ?? [];
  const cjk = lower.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  const grams = [];
  for (const sequence of cjk) {
    for (let index = 0; index + 1 < sequence.length; index += 1) grams.push(sequence.slice(index, index + 2));
  }
  return [...new Set([...latin, ...grams])];
}

/**
 * 在论文全文里挑与问题最相关的几段，作为回答依据。
 *
 * 为什么要它：之前逐块提问只把"标题 + 摘要 + 动机 + 该节点"喂给模型，正文根本没进上下文，
 * 于是问到具体超参数时模型会凭印象编一个数字。检索出相关段落后，答案才有出处。
 * @param {object} paper 论文记录（需要 text 字段）
 * @param {string} query 问题（可拼上节点标题）
 * @param {number} budget 返回字符上限
 * @returns {string} 按原文顺序拼接的摘录；检索不到时给开头几段兜底
 */
export function retrieveExcerpts(paper, query, budget = 7000) {
  const text = String(paper?.text ?? '');
  if (text.length === 0) return '';
  const chunks = chunkText(text);
  if (chunks.length === 0) return '';
  const terms = queryTerms(query);
  const scored = chunks.map((chunk, index) => {
    const lower = normalizeSymbols(chunk).toLowerCase();
    let hits = 0;
    for (const term of terms) {
      const parts = lower.split(term).length - 1;
      hits += parts;
    }
    return { index, chunk, score: hits / Math.sqrt(chunk.length / 400 + 1) };
  });
  const best = scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, 8);
  const picked = best.length > 0 ? best : scored.slice(0, 3).map((entry) => ({ ...entry, index: entry.index }));
  picked.sort((a, b) => a.index - b.index);
  const out = [];
  let used = 0;
  for (const entry of picked) {
    if (used + entry.chunk.length > budget) continue;
    out.push(entry.chunk);
    used += entry.chunk.length;
  }
  return out.join('\n\n---\n\n');
}

/** 把节点压成一段上下文。 */
function blockContext(block) {
  const parts = [`节点：${block.title ?? ''}（类型 ${block.type ?? 'unknown'}）`];
  if (block.text) parts.push(`内容：${block.text}`);
  if (block.latex) parts.push(`LaTeX：${block.latex}`);
  return parts.join('\n');
}

/** 论文的公共背景（每个会话都带，保证回答不跑题）。 */
function paperContext(paper) {
  const lines = [`论文：${paper.title ?? '未命名论文'}`];
  if (paper.abstract) lines.push(`一句话概括：${paper.abstract}`);
  const motivation = (paper.blocks ?? []).find((block) => block.type === 'motivation');
  if (motivation?.text) lines.push(`动机：${String(motivation.text).slice(0, 600)}`);
  return lines.join('\n');
}

/** 历史对话 → 模型消息（最多保留最近若干轮，避免上下文无限膨胀）。 */
function historyMessages(history, limit = 8) {
  return (Array.isArray(history) ? history : [])
    .slice(-limit)
    .map((message) => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: String(message.content ?? '') }));
}

/**
 * 针对某个节点提问。
 * @param ctx 宿主上下文
 * @param paper 论文记录
 * @param blockId 节点 id
 * @param history 该节点已有的对话
 * @param message 用户新问题
 */
export async function askAboutBlock(ctx, paper, blockId, history, message, options = {}) {
  const block = (paper.blocks ?? []).find((item) => item.id === blockId);
  if (!block) return { ok: false, error: '找不到这个节点' };
  const system = await composeSystem([
    '你是论文阅读助教，只回答与当前节点有关的问题。',
    '回答要求：简体中文；先给结论再给依据；涉及公式时用 LaTeX 行内写法 $...$；不超过 400 字；',
    '回答必须以"论文原文摘录"为依据：摘录里没有的具体数值、超参数、指标数字或结论，',
    '直接说"给出的摘录里没有这个数字/这一点"，然后说明需要打开原文核对；绝对不要凭印象补一个数字。',
    '论文没写的内容要明确说"论文没提"。',
    '提到符号或公式时用 $...$ 包成行内公式（例如 $\\mathbf{z}_u^{final}$），不要裸写 LaTeX 命令。',
    FORMAT_RULE,
  ].join('\n'), 'chat');
  /** 按摘录预算拼一次提问。 */
  const buildPrompt = (budget) => {
    const excerpts = retrieveExcerpts(paper, `${block.title ?? ''} ${String(message ?? '')}`, budget);
    return [
      paperContext(paper),
      '',
      blockContext(block),
      '',
      '=== 论文原文摘录（只依据这些回答） ===',
      excerpts.length > 0 ? excerpts : '（这篇论文没有保存正文摘录）',
      '',
      `用户的问题：${String(message ?? '').trim()}`,
    ].join('\n');
  };
  const ask = (budget, reasoningOff = false) =>
    complete(ctx, {
      system,
      messages: [...historyMessages(history), { role: 'user', content: buildPrompt(budget) }],
      temperature: 0.5,
      timeoutMs: 90_000,
      model: options.model,
      signal: options.signal,
      reasoningOff,
    });
  // 三段式：先按原样问；空正文就把上下文砍短；还空才尝试关推理
  let result = await ask(7000);
  if (!result.ok && /没有返回正文/.test(result.error)) result = await ask(2000);
  if (!result.ok && /没有返回正文/.test(result.error)) result = await ask(2000, true);
  return result.ok ? { ok: true, text: result.text } : { ok: false, error: result.error };
}

/**
 * 从"提问过的上下文 + 已有笔记"浓缩出一条笔记。
 * @param ctx 宿主上下文
 * @param paper 论文记录
 * @param blockId 节点 id（可空：整篇的全局笔记）
 */
export async function condenseNote(ctx, paper, blockId) {
  const block = blockId ? (paper.blocks ?? []).find((item) => item.id === blockId) : undefined;
  const chat = (paper.chats ?? []).find((item) => (item.blockId ?? null) === (blockId ?? null));
  const rounds = Array.isArray(chat?.messages) ? chat.messages : [];
  const notes = (paper.notes ?? []).filter((note) => (blockId ? note.blockId === blockId : true));
  if (rounds.length === 0 && notes.length === 0) {
    return { ok: false, error: '这个板块还没有提问或笔记，没什么可浓缩的' };
  }
  const dialogue = rounds
    .map((message) => `${message.role === 'assistant' ? '助教' : '我'}：${String(message.content ?? '').slice(0, 800)}`)
    .join('\n');
  const noteText = notes.map((note) => `- ${String(note.text ?? '').slice(0, 600)}`).join('\n');
  const system = [
    '你把用户的提问记录和随手笔记压缩成一条可复习的笔记。',
    '输出 3-6 条 markdown 列表项，每条一句话，保留具体术语、指标名、数值；不要客套话，不要重复用户原话。',
    '如果某条只是用户的疑问而助教已经回答，写成"结论：……"，不要写成"用户不知道……"。',
  ].join('\n');
  const prompt = [
    paperContext(paper),
    block ? `\n${blockContext(block)}` : '',
    '\n=== 提问记录 ===',
    dialogue || '（无）',
    '\n=== 已有笔记 ===',
    noteText || '（无）',
    '\n请输出浓缩笔记。',
  ].join('\n');
  const result = await complete(ctx, { system, messages: [{ role: 'user', content: prompt }], temperature: 0.3, timeoutMs: 90_000 });
  return result.ok ? { ok: true, text: result.text } : { ok: false, error: result.error };
}

/**
 * core 核：把整篇的提问与笔记收束成读后整理。
 * @param ctx 宿主上下文
 * @param paper 论文记录
 */
export async function buildCore(ctx, paper) {
  const blocks = paper.blocks ?? [];
  const chatDump = (paper.chats ?? [])
    .map((item) => {
      const title = blocks.find((block) => block.id === item.blockId)?.title ?? '全局';
      const body = (item.messages ?? [])
        .map((message) => `${message.role === 'assistant' ? '助教' : '我'}：${String(message.content ?? '').slice(0, 500)}`)
        .join('\n');
      return `【${title}】\n${body}`;
    })
    .join('\n\n');
  const notes = (paper.notes ?? [])
    .map((note) => {
      const title = note.blockId ? blocks.find((block) => block.id === note.blockId)?.title ?? '' : '全局';
      return `- ${title ? `[${title}] ` : ''}${String(note.text ?? '').slice(0, 800)}`;
    })
    .join('\n');
  if (chatDump.trim().length === 0 && notes.trim().length === 0) {
    return { ok: false, error: '还没有提问或笔记，core 核暂时没有素材' };
  }
  const nodeDump = blocks
    .map((block) => `- [${block.type}] ${block.title}：${String(block.text ?? '').slice(0, 260)}${block.latex ? `（公式 ${block.latex}）` : ''}`)
    .join('\n');
  const system = [
    '你把一篇论文的节点内容、用户的提问和笔记，整理成一份"读后信息整理"。',
    '用 markdown，严格按这些二级标题输出（没有内容的标题写"暂无"）：',
    '## 一句话总结',
    '## 它解决什么问题',
    '## 核心思路',
    '## 关键公式',
    '## 主要结果',
    '## 我没想通的地方',
    '## 下次复习先看这三件事',
    '要求：简体中文；只写论文与用户记录里有的东西，不要引入外部知识；"我没想通的地方"从提问里推断，措辞用第一人称。',
    FORMAT_RULE,
  ].join('\n');
  const prompt = [
    paperContext(paper),
    '\n=== 节点 ===',
    nodeDump || '（无）',
    '\n=== 我的提问与助教回答 ===',
    chatDump || '（无）',
    '\n=== 我的笔记 ===',
    notes || '（无）',
    '\n请输出读后信息整理。',
  ].join('\n');
  const result = await complete(ctx, { system, messages: [{ role: 'user', content: prompt }], temperature: 0.4, timeoutMs: 120_000 });
  return result.ok ? { ok: true, text: result.text } : { ok: false, error: result.error };
}

/**
 * 对比模式：多篇论文放在一起讨论。
 * @param ctx 宿主上下文
 * @param papers 参与对比的论文记录
 * @param history 对比会话历史
 * @param message 用户问题
 */
export async function compareChat(ctx, papers, history, message, options = {}) {
  if (!Array.isArray(papers) || papers.length === 0) return { ok: false, error: '没有选中任何论文' };
  const system = await composeSystem([
    '你在带一个论文对比研讨。用户会把几篇论文放在一起比较。',
    '回答要求：简体中文；先给一句话结论，再分点说差异；差异要落到具体机制、假设、损失函数或指标上，不要泛泛而谈；',
    '需要点名论文时用《标题》的形式；用户没问到的论文不要强行拉扯；不超过 600 字。',
    FORMAT_RULE,
  ].join('\n'), 'compare');
  const dossiers = papers
    .map((paper) => {
      const blocks = paper.blocks ?? [];
      const principle = blocks.find((block) => block.type === 'principle');
      const formulas = blocks.filter((block) => block.type === 'formula').map((block) => block.latex).filter(Boolean);
      const core = paper.core?.text;
      return [
        `《${paper.title}》`,
        `概括：${paper.abstract ?? ''}`,
        principle?.text ? `核心思路：${String(principle.text).slice(0, 700)}` : '',
        formulas.length > 0 ? `关键公式：${formulas.slice(0, 3).join(' ; ')}` : '',
        core ? `已有读后整理：${String(core).slice(0, 900)}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
  const prompt = [
    '=== 参与对比的论文 ===',
    dossiers,
    '',
    `用户的问题：${String(message ?? '').trim()}`,
  ].join('\n');
  const result = await complete(ctx, {
    system,
    messages: [...historyMessages(history), { role: 'user', content: prompt }],
    temperature: 0.5,
    timeoutMs: 120_000,
    model: options.model,
    signal: options.signal,
  });
  return result.ok ? { ok: true, text: result.text } : { ok: false, error: result.error };
}


/**
 * 流式版的逐块提问：和 askAboutBlock 用同一套 prompt 与规则，只是把 token 边到边推给调用方。
 * @param ctx 宿主上下文
 * @param paper 论文记录
 * @param blockId 节点 id
 * @param history 已有对话
 * @param message 用户新问题
 * @param options { model, signal, onEvent }
 * @returns {Promise<{ok:boolean, text?:string, error?:string}>}
 */
export async function askAboutBlockStream(ctx, paper, blockId, history, message, options = {}) {
  const block = (paper.blocks ?? []).find((item) => item.id === blockId);
  if (!block) return { ok: false, error: '找不到这个节点' };
  const system = await composeSystem([
    '你是论文阅读助教，只回答与当前节点有关的问题。',
    '回答要求：简体中文；先给结论再给依据；涉及公式时用 LaTeX 行内写法 $...$；不超过 400 字；',
    '回答必须以"论文原文摘录"为依据：摘录里没有的具体数值、超参数、指标数字或结论，',
    '直接说"给出的摘录里没有这个数字/这一点"，然后说明需要打开原文核对；绝对不要凭印象补一个数字。',
    '论文没写的内容要明确说"论文没提"。',
    '提到符号或公式时用 $...$ 包成行内公式（例如 $\\mathbf{z}_u^{final}$），不要裸写 LaTeX 命令。',
    FORMAT_RULE,
  ].join('\n'), 'chat');
  const excerpts = retrieveExcerpts(paper, `${block.title ?? ''} ${String(message ?? '')}`, 7000);
  const prompt = [
    paperContext(paper),
    '',
    blockContext(block),
    '',
    '=== 论文原文摘录（只依据这些回答） ===',
    excerpts.length > 0 ? excerpts : '（这篇论文没有保存正文摘录）',
    '',
    `用户的问题：${String(message ?? '').trim()}`,
  ].join('\n');
  return streamText(
    ctx,
    {
      system,
      messages: [...historyMessages(history), { role: 'user', content: prompt }],
      temperature: 0.5,
      timeoutMs: 90_000,
      model: options.model,
      signal: options.signal,
    },
    options.onEvent,
  );
}


/**
 * 流式版的多论文对比讨论：prompt 与 compareChat 一致，只是边生成边回调。
 * @param ctx 宿主上下文
 * @param papers 参与对比的论文
 * @param history 历史对话
 * @param message 用户问题
 * @param options { model, signal, onEvent }
 */
export async function compareChatStream(ctx, papers, history, message, options = {}) {
  if (!Array.isArray(papers) || papers.length === 0) return { ok: false, error: '没有选中任何论文' };
  const single = papers.length === 1;
  const system = single
    ? await composeSystem([
        '你在和用户讨论一篇论文，只回答与这篇论文有关的问题。',
        '回答要求：简体中文；先给结论再给依据；落到具体机制、公式或指标上，不要泛泛而谈；',
        '给出的材料里没有的数值或结论，直接说"给出的材料里没有这一点"，不要凭印象补；',
        '提到符号或公式时用 $...$ 包成行内公式，不要裸写 LaTeX 命令；不超过 500 字。',
      ].join('\n'), 'compare')
    : await composeSystem([
        '你在带一个论文对比研讨。用户会把几篇论文放在一起比较。',
        '回答要求：简体中文；先给一句话结论，再分点说差异；差异要落到具体机制、假设、损失函数或指标上，不要泛泛而谈；',
        '需要点名论文时用《标题》的形式；用户没问到的论文不要强行拉扯；不超过 600 字。',
        '提到符号或公式时用 $...$ 包成行内公式，不要裸写 LaTeX 命令。',
      ].join('\n'), 'compare');
  const dossiers = papers
    .map((paper) => {
      const blocks = paper.blocks ?? [];
      const principle = blocks.find((block) => block.type === 'principle');
      const formulas = blocks.filter((block) => block.type === 'formula').map((block) => block.latex).filter(Boolean);
      return [
        `《${paper.title}》`,
        `概括：${paper.abstract ?? ''}`,
        principle?.text ? `核心思路：${String(principle.text).slice(0, 700)}` : '',
        formulas.length > 0 ? `关键公式：${formulas.slice(0, 3).join(' ; ')}` : '',
        paper.core?.text ? `已有读后整理：${String(paper.core.text).slice(0, 900)}` : '',
      ].filter(Boolean).join('\n');
    })
    .join('\n\n');
  const prompt = ['=== 参与对比的论文 ===', dossiers, '', `用户的问题：${String(message ?? '').trim()}`].join('\n');
  return streamText(
    ctx,
    {
      system,
      messages: [...historyMessages(history), { role: 'user', content: prompt }],
      temperature: 0.5,
      timeoutMs: 120_000,
      model: options.model,
      signal: options.signal,
    },
    options.onEvent,
  );
}


/**
 * 划词翻译：把选中的一段英文译成中文，术语保留英文原词。
 * 只做一件事，输出直接是译文（不加解释），这样弹窗里读起来像 Zotero 的翻译插件。
 *
 * @param ctx 宿主上下文
 * @param {string} text 选中的原文
 * @param {{ model?: object }} [options]
 * @returns {Promise<{ok:boolean, text?:string, error?:string}>}
 */
export async function translateSelection(ctx, text, options = {}) {
  const source = String(text ?? '').trim();
  if (source.length === 0) return { ok: false, error: '没有选中内容' };
  if (source.length > 4000) return { ok: false, error: '选中内容太长（超过 4000 字）' };
  const settings = await readSettings().catch(() => undefined);
  const persona = String(settings?.persona ?? '').trim();
  const system = [
    '你是学术论文翻译助手。把用户给的英文片段译成简体中文。',
    '要求：术语保留英文原词（可写成"中文（English）"）；公式、符号、引用编号原样保留；',
    '只输出译文本身，不要解释、不要加"翻译如下"之类的前缀，不要 markdown 围栏。',
    persona.length > 0 ? `用户偏好：${persona}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const result = await complete(ctx, {
    system,
    messages: [{ role: 'user', content: source }],
    temperature: 0.2,
    maxTokens: 1200,
    timeoutMs: 60_000,
    model: options.model,
  });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, text: String(result.text ?? '').trim() };
}
