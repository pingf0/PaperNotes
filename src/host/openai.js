/**
 * OpenAI 兼容接口的最小客户端（OpenAI / Kimi / DeepSeek / Ollama / 任何兼容网关）。
 *
 * 只做两件事：流式 chat completions、非流式 chat completions。
 * 不引第三方 SDK —— 插件里多一个依赖就多一份安装风险，用内置 fetch 足够。
 */

/** 把 messages 转成接口要的形状（只保留 role / content）。 */
function toApiMessages(system, messages) {
  const list = [];
  if (typeof system === 'string' && system.trim().length > 0) {
    list.push({ role: 'system', content: system });
  }
  for (const message of messages ?? []) {
    const role = message?.role === 'assistant' ? 'assistant' : 'user';
    const content = String(message?.content ?? '');
    if (content.length === 0) continue;
    list.push({ role, content });
  }
  return list;
}

/** 拼 endpoint：允许用户在 baseUrl 里带不带 /v1 都可以。 */
function endpoint(baseUrl, path) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  return `${base}${path}`;
}

/** 统一错误文本：把服务端返回的 message 摘出来。 */
function describeError(status, body) {
  let detail = body;
  try {
    const parsed = JSON.parse(body);
    detail = parsed?.error?.message ?? parsed?.message ?? body;
  } catch {
    /* 原样 */
  }
  return `HTTP ${status}：${String(detail).slice(0, 300)}`;
}

/**
 * 流式补全。
 * @param {{ baseUrl: string, apiKey: string, model: string }} config
 * @param {{ system?: string, messages: Array, temperature?: number, maxTokens?: number, signal?: AbortSignal }} options
 * @param {(event: {type: 'text'|'reasoning', text: string}) => void} onEvent
 * @returns {Promise<{ok: boolean, text?: string, error?: string}>}
 */
export async function streamChat(config, options, onEvent = () => {}) {
  const body = {
    model: config.model,
    stream: true,
    messages: toApiMessages(options.system, options.messages),
    temperature: typeof options.temperature === 'number' ? options.temperature : 0.5,
  };
  if (options.maxTokens) body.max_tokens = options.maxTokens;

  let response;
  try {
    response = await fetch(endpoint(config.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') return { ok: false, error: '已停止' };
    return { ok: false, error: `连不上 ${config.baseUrl}：${error instanceof Error ? error.message : String(error)}` };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return { ok: false, error: describeError(response.status, text) };
  }
  if (!response.body) return { ok: false, error: '接口没有返回流' };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const chunk = JSON.parse(payload);
        const delta = chunk?.choices?.[0]?.delta ?? {};
        const piece = delta.content;
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === 'string' && reasoning.length > 0) onEvent({ type: 'reasoning', text: reasoning });
        if (typeof piece === 'string' && piece.length > 0) {
          text += piece;
          onEvent({ type: 'text', text: piece });
        }
      } catch {
        /* 忽略坏帧 */
      }
    }
  }
  if (text.trim().length === 0) return { ok: false, error: '模型没有返回文本' };
  return { ok: true, text };
}

/**
 * 非流式补全（内部复用流式，省一套解析）。
 * @param {{ baseUrl: string, apiKey: string, model: string }} config
 * @param {{ system?: string, messages: Array, temperature?: number, maxTokens?: number, signal?: AbortSignal }} options
 */
export async function completeChat(config, options) {
  return streamChat(config, options);
}

/**
 * 连通性测试：发一句最短的话，看能不能通。
 * @param {{ baseUrl: string, apiKey: string, model: string }} config
 * @returns {Promise<{ok: boolean, ms?: number, text?: string, error?: string}>}
 */
export async function testConnection(config) {
  const started = Date.now();
  const result = await completeChat(config, {
    messages: [{ role: 'user', content: '只回复两个字：可用' }],
    temperature: 0,
    maxTokens: 16,
  });
  return result.ok
    ? { ok: true, ms: Date.now() - started, text: String(result.text).slice(0, 40) }
    : { ok: false, ms: Date.now() - started, error: result.error };
}
