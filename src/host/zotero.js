/**
 * Zotero 集成。
 *
 * 读：用 Zotero 7 的本地 HTTP 接口（`http://127.0.0.1:23119/api`），不需要 API key，
 *     但要在 Zotero 里打开「允许其他应用与本机 Zotero 通信」。
 * 写：本地接口是只读的，回写笔记必须走官方 Web API（需要用户填 userID + API key）。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readSettings } from './settings.js';

const LOCAL_BASE = 'http://127.0.0.1:23119/api/users/0';
const WEB_BASE = 'https://api.zotero.org';
const TIMEOUT_MS = 6000;

/** 带超时的 fetch（Zotero 没启动时不要卡住界面）。 */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: options.signal ?? controller.signal,
      headers: { 'Zotero-API-Version': '3', ...(options.headers ?? {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Zotero 是否在运行、本地接口是否可用。
 * @returns {Promise<{ok:boolean, version?:string, error?:string}>}
 */
export async function zoteroStatus() {
  try {
    const response = await fetchWithTimeout(`${LOCAL_BASE}/items?limit=1`);
    if (!response.ok) return { ok: false, error: `本地接口返回 ${response.status}` };
    return { ok: true, version: response.headers.get('Zotero-Version') ?? '7' };
  } catch (error) {
    return {
      ok: false,
      error: error?.name === 'AbortError' ? 'Zotero 没有响应（是否已启动？）' : '连不上 Zotero 本地接口',
    };
  }
}

/** 从 Zotero 的 item 里挑出标题 / 作者 / 年份。 */
function summarizeItem(item) {
  const data = item?.data ?? {};
  const creators = Array.isArray(data.creators) ? data.creators : [];
  const first = creators[0];
  return {
    key: data.key ?? item.key,
    title: String(data.title ?? '(无标题)').slice(0, 200),
    authors: creators.slice(0, 3).map((person) => person.lastName ?? person.name ?? '').filter(Boolean).join(', '),
    year: String(data.date ?? '').slice(0, 4),
    itemType: data.itemType ?? '',
  };
}

/**
 * 列出有 PDF 附件的文献。
 * @param {{ q?: string, limit?: number }} options
 * @returns {Promise<Array<{key:string,title:string,authors:string,year:string,attachmentKey:string}>>}
 */
export async function listZoteroItems(options = {}) {
  const limit = Math.min(40, Math.max(1, Number(options.limit) || 20));
  const q = String(options.q ?? '').trim();
  const query = new URLSearchParams({ limit: String(limit), itemType: '-attachment' });
  if (q.length > 0) query.set('q', q);
  const response = await fetchWithTimeout(`${LOCAL_BASE}/items?${query.toString()}`);
  if (!response.ok) throw new Error(`Zotero 本地接口返回 ${response.status}`);
  const items = await response.json();
  const result = [];
  // 逐个取子项找 PDF：并发 4，避免把 Zotero 打满
  const queue = [...(Array.isArray(items) ? items : [])];
  const workers = Array.from({ length: 4 }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const summary = summarizeItem(item);
      if (!summary.key) continue;
      try {
        const children = await fetchWithTimeout(`${LOCAL_BASE}/items/${summary.key}/children`);
        if (!children.ok) continue;
        const list = await children.json();
        const pdf = (Array.isArray(list) ? list : []).find(
          (child) => child?.data?.contentType === 'application/pdf',
        );
        if (pdf?.key) result.push({ ...summary, attachmentKey: pdf.key });
      } catch {
        /* 单个条目失败不影响其它 */
      }
    }
  });
  await Promise.all(workers);
  return result;
}

/**
 * 取附件的字节（给浏览器走同一套 pdf.js 抽取管线）。
 * @param {string} attachmentKey Zotero 附件 key
 * @returns {Promise<Uint8Array>}
 */
export async function fetchZoteroFile(attachmentKey) {
  const key = String(attachmentKey ?? '').trim();
  if (!/^[A-Z0-9]{4,16}$/i.test(key)) throw new Error('附件 key 不合法');
  // Zotero 对 /file 返回 302 到 file://（本地磁盘）或 http://，Node 的 fetch 不会跟 file://
  const response = await fetchWithTimeout(`${LOCAL_BASE}/items/${key}/file`, { redirect: 'manual' });
  if (response.status === 301 || response.status === 302 || response.status === 307) {
    const location = response.headers.get('location') ?? '';
    if (location.startsWith('file://')) {
      const bytes = await readFile(fileURLToPath(location));
      return new Uint8Array(bytes);
    }
    if (location.length > 0) {
      const followed = await fetchWithTimeout(location, { redirect: 'follow' });
      if (!followed.ok) throw new Error(`取附件失败：HTTP ${followed.status}`);
      return new Uint8Array(await followed.arrayBuffer());
    }
  }
  if (!response.ok) throw new Error(`取附件失败：HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * 把一段笔记回写到 Zotero 条目下（官方 Web API，需要 userID + API key）。
 * @param {{ userId: string, apiKey: string }} auth
 * @param {string} itemKey 父条目 key
 * @param {{ title: string, html: string }} note
 */
export async function pushZoteroNote(auth, itemKey, note) {
  if (!auth?.userId || !auth?.apiKey) throw new Error('还没有配置 Zotero Web API（userID + API key）');
  const response = await fetch(`${WEB_BASE}/users/${encodeURIComponent(auth.userId)}/items/${encodeURIComponent(itemKey)}/children`, {
    method: 'POST',
    headers: {
      'Zotero-API-Version': '3',
      'content-type': 'application/json',
      authorization: `Bearer ${auth.apiKey}`,
    },
    body: JSON.stringify([
      {
        itemType: 'note',
        note: `<h1>${escapeHtml(note.title)}</h1>${note.html}`,
      },
    ]),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`写回 Zotero 失败：HTTP ${response.status} ${text.slice(0, 120)}`);
  }
  return true;
}

/** 极简 HTML 转义（写回 Zotero 的 note 是 HTML）。 */
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 从设置里取 Zotero 的写权限。 */
export async function zoteroAuth() {
  const settings = await readSettings();
  return { userId: settings?.zotero?.userId ?? '', apiKey: settings?.zotero?.apiKey ?? '' };
}
