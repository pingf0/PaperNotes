import { randomUUID } from 'node:crypto';

/**
 * ctx.llm 的一层薄包装：把"问一句、拿一段文本"收敛成一个函数。
 *
 * 只用 stream + text-delta 自己拼文本，不依赖 @deepseek-ai/dsh-llm 的 BlockAssembler：
 * 少一个跨包解析依赖，插件在别的 DSH 版本上也更容易活下去。
 */

/** 调用身份：某些服务商要求带 sessionId 才受理（同 dsh-pet 的处理）。 */
const CALL_IDENTITY = 'dsh-paper-desk';

/** 默认单次生成超时（ms）。 */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * 当前模型是否声明支持 reasoning effort（含 "off"）。
 * dsh-llm 对"模型无 reasoning 元数据 + 调用方显式传 effort"会直接判 UNSUPPORTED_REASONING_EFFORT，
 * 请求被折叠成空流，表现出来就是"模型没有返回文本"。所以只有声明支持时才传 off。
 * @param ctx 宿主上下文
 * @param provider 服务商
 * @param model 模型
 * @returns 支持 reasoningEffort: 'off' 时为 true
 */
async function supportsReasoningOff(ctx, provider, model) {
  const llm = ctx.get?.('llm');
  if (!llm || typeof llm.resolveModelInfo !== 'function') return false;
  try {
    const info = await llm.resolveModelInfo(provider, model);
    return info?.reasoning?.efforts?.some((effort) => effort.id === 'off') ?? false;
  } catch {
    return false;
  }
}

/**
 * 取一次当前模型选择。
 * @param ctx 宿主上下文
 * @returns { provider, model }；没配模型时抛错（调用方转成"模型不可用"提示）
 */
function currentModel(ctx) {
  const selector = ctx.get?.('agentDefaultModel');
  const selection = selector?.currentSelection?.();
  if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
    throw new Error('当前会话没有可用的模型，请先在模型选择器里配置一个模型');
  }
  return selection;
}

/**
 * 是否可用（只读判断，不生成）。
 * @param ctx 宿主上下文
 */
export function llmReady(ctx) {
  const llm = ctx.get?.('llm');
  if (!llm || typeof llm.stream !== 'function') return false;
  try {
    currentModel(ctx);
    return true;
  } catch {
    return false;
  }
}

/**
 * 生成一段文本。
 * @param ctx 宿主上下文
 * @param options.system 系统提示词
 * @param options.messages [{ role: 'user' | 'assistant', content: string }]
 * @param options.maxTokens 输出上限（不传交给适配器默认值）
 * @param options.temperature 采样温度
 * @param options.timeoutMs 超时
 * @returns { ok: true, text } 或 { ok: false, error }
 */
export async function complete(ctx, options) {
  return streamText(ctx, options);
}

/**
 * 和 complete 一样，但**边生成边回调**：reasoning / text 片段一到就交给上层，
 * 上层可以直接推给浏览器做流式输出。
 * @param ctx 宿主上下文
 * @param options 同 complete
 * @param {(event: {type: 'reasoning'|'text', text: string}) => void} [onEvent] 片段回调
 * @returns {Promise<{ok:boolean, text?:string, error?:string}>}
 */
export async function streamText(ctx, options, onEvent = () => {}) {
  const llm = ctx.get?.('llm');
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, error: 'LLM 服务不可用' };
  }
  let selection;
  try {
    // 允许调用方指定模型（侧边栏的模型下拉框）；不指定就用当前会话的模型
    selection =
      options.model && options.model.provider && options.model.model
        ? { provider: String(options.model.provider), model: String(options.model.model) }
        : currentModel(ctx);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  // 历史消息必须带 `source` 与 `id`：dsh-llm 的 forAdapter() 会对 assistant 消息读
  // `message.source.replayState`，缺 source 就直接抛
  // "Cannot read properties of undefined (reading 'replayState')"，
  // 表现是"首问能答、追问必空"。
  const messages = (options.messages ?? []).map((message) => {
    const content = [{ type: 'text', text: String(message.content ?? '') }];
    if (message.role === 'assistant') {
      return {
        id: randomUUID(),
        role: 'assistant',
        content,
        source: { kind: 'model', provider: selection.provider, model: selection.model },
      };
    }
    return { id: randomUUID(), role: 'user', content, source: { kind: 'user' } };
  });
  // 默认**不传** reasoningEffort：强行关推理反而可能被适配器拒（或折叠成空流），
  // 所以只在"前两次都拿不到正文"时，调用方才会显式要求关推理。
  const reasoningOff = options.reasoningOff === true
    ? await supportsReasoningOff(ctx, selection.provider, selection.model)
    : false;
  const request = {
    provider: selection.provider,
    model: selection.model,
    sessionId: CALL_IDENTITY,
    messages,
    ...(options.system ? { system: options.system } : {}),
    temperature: options.temperature ?? 0.4,
    ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
    ...(reasoningOff ? { reasoningEffort: 'off' } : {}),
    signal: options.signal
      ? AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS), options.signal])
      : AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  };
  let text = '';
  let reasoning = '';
  /** finish 是对象（{ kind, failure? }），不是字符串 */
  let finish = null;
  const blockTexts = [];
  try {
    for await (const chunk of llm.stream(request)) {
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text;
        onEvent({ type: 'text', text: chunk.text });
      } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
        reasoning += chunk.text;
        onEvent({ type: 'reasoning', text: chunk.text });
      }
      else if (chunk.type === 'finish' && chunk.reason && typeof chunk.reason === 'object') finish = chunk.reason;
      else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
        blockTexts.push(chunk.block.text);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/abort/i.test(message)) return { ok: false, error: '已停止', aborted: true };
    return { ok: false, error: message };
  }
  const finalText = (text.length > 0 ? text : blockTexts.join('')).trim();
  if (finalText.length === 0) {
    // 把真实原因说出来：适配器报错 / 被推理占满 / 被长度截断，处置完全不同
    const kind = finish?.kind ? String(finish.kind) : '';
    const failure = finish?.failure;
    const failureText =
      failure && typeof failure === 'object'
        ? [failure.code, failure.status ? `HTTP ${failure.status}` : '', failure.message].filter(Boolean).join(' ')
        : '';
    const detail = [
      kind ? `finish=${kind}` : '没有 finish 事件',
      failureText,
      reasoning.length > 0 ? `只有推理没有正文（推理 ${reasoning.length} 字符）` : '没有收到任何正文片段',
    ]
      .filter(Boolean)
      .join('，');
    return { ok: false, error: `模型没有返回正文：${detail}` };
  }
  return { ok: true, text: finalText };
}

/**
 * 要求模型只输出 JSON 并解析它：容忍 ```json 围栏、前后多余文字。
 * @param text 模型原文
 * @returns 解析出的对象；失败返回 undefined
 */
export function parseJsonReply(text) {
  if (typeof text !== 'string') return undefined;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
