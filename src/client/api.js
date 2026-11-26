/**
 * 前端到宿主的路由封装。同源相对路径，桌面版与浏览器版一致。
 */

/** 路由前缀，必须与 index.js 的 ROUTE_PREFIX 一致。 */
export const PREFIX = '/dsh-paper-desk-4821';

/**
 * 发一个请求并解析 JSON；非 2xx 抛带服务端原文的 Error。
 * @param {string} path 前缀后的路径
 * @param {object} [options]
 */
async function request(path, options = {}) {
  const response = await fetch(PREFIX + path, {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: 'no-store',
  });
  let payload;
  const text = await response.text();
  try {
    payload = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    payload = { error: text };
  }
  if (!response.ok) throw new Error(payload.error ?? `请求失败（${response.status}）`);
  return payload;
}

/**
 * 拼资源地址。
 * @param {string} paperId 论文 id
 * @param {string} file 文件名
 * @param {number} [version] 版本号：换图后加一个变化的查询参数，强制浏览器重新取图
 */
export function assetUrl(paperId, file, version) {
  const base = `${PREFIX}/asset?paper=${encodeURIComponent(paperId)}&file=${encodeURIComponent(file)}`;
  return version ? `${base}&v=${version}` : base;
}

/** 原文 PDF 地址。 */
export function pdfUrl(paperId) {
  return `${PREFIX}/pdf?id=${encodeURIComponent(paperId)}`;
}

/** pdf.js worker 地址。 */
export function workerUrl() {
  return `${PREFIX}/worker`;
}

/** pdf.js 本体地址（由宿主静态伺服，第一次导入论文时才加载）。 */
export function pdfjsUrl() {
  return `${PREFIX}/pdfjs.mjs`;
}

/** 全部后端调用。 */
export const api = {
  health: () => request('/health'),
  state: () => request('/state'),
  createCategory: (name) => request('/category', { method: 'POST', body: { name } }),
  renameCategory: (id, name) => request('/category', { method: 'PATCH', body: { id, name } }),
  deleteCategory: (id) => request(`/category?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
  importPaper: (payload) => request('/paper/import', { method: 'POST', body: payload }),
  getPaper: (id) => request(`/paper?id=${encodeURIComponent(id)}`),
  patchPaper: (id, patch) => request('/paper', { method: 'PATCH', body: { id, patch } }),
  deletePaper: (id) => request(`/paper?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
  copyPaper: (id, categoryId) => request('/paper/copy', { method: 'POST', body: { id, categoryId } }),
  /**
   * 流式提问：读 SSE，把 reasoning / text 片段边到边回调。
   * @param {string} id 论文 id
   * @param {string|null} blockId 节点 id
   * @param {string} message 问题
   * @param {{ model?: object, requestId?: string, signal?: AbortSignal, onEvent: (event: object) => void }} options
   */
  chatStream: async (id, blockId, message, options) => {
    const response = await fetch(PREFIX + '/paper/chat/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, blockId, message, model: options.model, requestId: options.requestId }),
      signal: options.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      let error = text;
      try {
        error = JSON.parse(text).error ?? text;
      } catch {
        /* 原样抛出 */
      }
      // 旧一代宿主没有流式路由：退回一次性接口，至少还能正常对话（只是没有打字效果）
      if (String(error).includes('no route')) {
        const result = await request('/paper/chat', {
          method: 'POST',
          body: { id, blockId, message, model: options.model, requestId: options.requestId },
        });
        const last = (result.messages ?? []).slice(-1)[0];
        if (last && typeof last.content === 'string') options.onEvent({ type: 'text', text: last.content });
        options.onEvent({ type: 'done', messages: result.messages ?? [] });
        return;
      }
      throw new Error(error);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const line = frame.split('\n').find((item) => item.startsWith('data: '));
        if (!line) continue;
        try {
          options.onEvent(JSON.parse(line.slice(6)));
        } catch {
          /* 忽略坏帧 */
        }
      }
    }
  },
  cancelChat: (requestId) => request('/paper/chat/cancel', { method: 'POST', body: { requestId } }),
  models: () => request('/models'),
  condense: (id, blockId) => request('/paper/condense', { method: 'POST', body: { id, blockId } }),
  core: (id) => request('/paper/core', { method: 'POST', body: { id } }),
  compareHistory: (paperIds) => request(`/compare/history?ids=${encodeURIComponent(paperIds.join(','))}`),
  saveCompareHistory: (paperIds, messages) =>
    request('/compare/history', { method: 'POST', body: { paperIds, messages } }),
  /**
   * 对比台的流式讨论（SSE）。旧宿主没有该路由时退回一次性接口。
   */
  compareChatStream: async (paperIds, message, history, options = {}) => {
    const response = await fetch(PREFIX + '/compare/chat/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paperIds, message, history, model: options.model, requestId: options.requestId }),
      signal: options.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      let detail = text;
      try {
        detail = JSON.parse(text).error ?? text;
      } catch {
        /* 原样抛出 */
      }
      if (String(detail).includes('no route')) {
        const result = await request('/compare/chat', { method: 'POST', body: { paperIds, message, history } });
        options.onEvent?.({ type: 'text', text: result.reply ?? '' });
        options.onEvent?.({ type: 'done', text: result.reply ?? '' });
        return;
      }
      throw new Error(detail);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const line = frame.split('\n').find((item) => item.startsWith('data: '));
        if (!line) continue;
        try {
          options.onEvent?.(JSON.parse(line.slice(6)));
        } catch {
          /* 忽略坏帧 */
        }
      }
    }
  },
  replaceFigures: (id, figures) => request('/paper/figures', { method: 'POST', body: { id, figures } }),
  uploadFigure: (id, dataUrl, caption) => request('/paper/figure', { method: 'POST', body: { id, dataUrl, caption } }),
  openPdfExternally: (id) => request('/paper/open-pdf', { method: 'POST', body: { id } }),
  setDataDir: (dir) => request('/setting', { method: 'POST', body: { dataDir: dir } }),
};
