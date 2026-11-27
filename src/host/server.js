/**
 * 论文台的 HTTP 面：一个 prefix handler 分发所有子路由。
 *
 * 约定：
 *   - 所有路由都在 ROUTE_PREFIX 下，前端用相对路径 fetch（同源，桌面与浏览器都一样）；
 *   - 写接口一律 POST/PATCH + JSON，读接口用 GET+query（好 curl、好排查）；
 *   - 失败一律 { error } + 合适的 status，前端展示原文，不吞错。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  askAboutBlock,
  askAboutBlockStream,
  buildCore,
  compareChat,
  compareChatStream,
  condenseNote,
} from './chat.js';
import { reanalyzePaper, migrateAnnotations, structurePaper } from './import.js';
import { maskSettings, readSettings, writeSettings } from './settings.js';
import { testConnection } from './openai.js';
import { fetchZoteroFile, listZoteroItems, pushZoteroNote, zoteroAuth, zoteroStatus } from './zotero.js';
import { llmReady } from './llm.js';
import {
  dataDir,
  emptyIndex,
  newId,
  paperDir,
  readIndex,
  readPaper,
  resolveInPaperDir,
  setDataDir,
  writeFigure,
  writeIndex,
  writePaper,
  writeSourcePdf,
} from './store.js';

/** 包根目录（lib/ 的上一级在构建产物里是包根；源码运行时 src/host 的上两级）。 */
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 上传体积上限：带图带 PDF 的导入可能几十 MB。 */
const MAX_BODY = 160 * 1024 * 1024;

/** 允许客户端 PATCH 的字段：其余字段（id/createdAt）由宿主自己管。 */
const PATCHABLE = new Set(['title', 'abstract', 'categoryId', 'blocks', 'edges', 'notes', 'chats', 'core', 'layout']);

/** MIME 映射。 */
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

/**
 * 依次等完多个 promise（写盘顺序对用户可见，不并发），并把下标传给回调。
 * @param items 数组
 * @param fn (item, index) => Promise
 */
async function sequential(items, fn) {
  const out = [];
  for (const [index, item] of items.entries()) out.push(await fn(item, index));
  return out;
}

/**
 * 读请求体（带大小上限）。
 * @param req IncomingMessage
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 发 JSON。 */
function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

/** 发纯文本。 */
function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

/** 发文件（图片 / PDF / worker 脚本）。 */
async function sendFile(res, file, contentType) {
  try {
    const bytes = await readFile(file);
    res.writeHead(200, {
      'content-type': contentType ?? 'application/octet-stream',
      'content-length': String(bytes.length),
      'cache-control': 'no-cache',
    });
    res.end(bytes);
  } catch {
    sendText(res, 404, 'not found');
  }
}

/** 从 URL 里取路径与查询参数。 */
function splitUrl(url) {
  const at = url.indexOf('?');
  const path = at < 0 ? url : url.slice(0, at);
  const query = new URLSearchParams(at < 0 ? '' : url.slice(at + 1));
  return { path, query };
}

/** 论文摘要（列表页用；不含 blocks）。 */
function summarize(paper) {
  const principle = (paper.figures ?? []).find((figure) => figure.id === paper.blocks?.find((b) => b.type === 'principle')?.figureId);
  return {
    id: paper.id,
    title: paper.title,
    abstract: paper.abstract ?? '',
    categoryId: paper.categoryId ?? null,
    createdAt: paper.createdAt ?? 0,
    lastOpenedAt: paper.lastOpenedAt ?? 0,
    blockCount: Array.isArray(paper.blocks) ? paper.blocks.length : 0,
    noteCount: Array.isArray(paper.notes) ? paper.notes.length : 0,
    questionCount: (paper.chats ?? []).reduce((sum, chat) => sum + (chat.messages ?? []).filter((m) => m.role === 'user').length, 0),
    hasCore: Boolean(paper.core?.text),
    thumb: principle?.file ?? (paper.figures ?? [])[0]?.file ?? null,
    warning: paper.warning ?? null,
  };
}

/** 取某个节点的会话容器（不存在就建）。 */
function chatOf(paper, blockId) {
  const key = blockId ?? null;
  let chat = (paper.chats ?? []).find((item) => (item.blockId ?? null) === key);
  if (!chat) {
    chat = { blockId: key, messages: [] };
    paper.chats = [...(paper.chats ?? []), chat];
  }
  return chat;
}

/**
 * 创建路由处理器。
 * @param ctx Cordis 宿主上下文
 * @param prefix 路由前缀
 */
/** 正在生成的请求：requestId → AbortController。侧边栏的「停止」按这个中止。 */
const inflight = new Map();

export function createServer(ctx, prefix) {
  /**
   * @param req IncomingMessage
   * @param res ServerResponse
   */
  return async function handler(req, res) {
    const rawUrl = req.url ?? '/';
    const { path: fullPath, query } = splitUrl(rawUrl);
    const path = fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) || '/' : fullPath;
    const method = (req.method ?? 'GET').toUpperCase();
    try {
      const dir = await dataDir();

      if (path === '/health' && method === 'GET') {
        // 自检：除了数据目录与模型，还报"这一代代码在哪、静态资源在不在"。
        // 插件换代要重启才生效，这两个字段能一眼看出跑的是新代码还是旧代码。
        return sendJson(res, 200, {
          ok: true,
          dir,
          llmReady: llmReady(ctx),
          packageRoot: PACKAGE_ROOT,
          assets: {
            pdfjs: existsSync(join(PACKAGE_ROOT, 'dist', 'pdfjs.mjs')),
            worker: existsSync(join(PACKAGE_ROOT, 'dist', 'pdf.worker.mjs')),
          },
        });
      }

      if (path === '/state' && method === 'GET') {
        const index = await readIndex(dir);
        const papers = await sequential(index.papers, async (summary) => {
          const paper = await readPaper(dir, summary.id);
          return paper ? summarize(paper) : null;
        });
        return sendJson(res, 200, {
          dir,
          categories: index.categories,
          papers: papers.filter(Boolean).sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0)),
          llmReady: llmReady(ctx),
        });
      }

      if (path === '/models' && method === 'GET') {
        const llm = ctx.get?.('llm');
        const selector = ctx.get?.('agentDefaultModel');
        let current = null;
        try {
          current = selector?.currentSelection?.() ?? null;
        } catch {
          current = null;
        }
        const providers = [];
        for (const provider of llm?.listProviders?.() ?? []) {
          let models = [];
          try {
            models = (await llm.listModels(provider.id)).map((model) => ({ id: model.id, name: model.name ?? model.id }));
          } catch {
            models = [];
          }
          providers.push({ id: provider.id, name: provider.name ?? provider.id, models });
        }
        // 用户自己加的模型：当成一个 provider 列出来，会话里就能选到
        const settings = await readSettings();
        const customModels = settings.models ?? [];
        if (customModels.length > 0) {
          providers.unshift({
            id: 'custom',
            name: '自定义模型',
            models: customModels.map((item) => ({ id: item.id, name: item.name })),
          });
          const active = customModels.find((item) => item.id === settings.activeModelId);
          if (active) current = { provider: 'custom', model: active.id };
        }
        return sendJson(res, 200, { current, providers });
      }

      if (path === '/paper/chat/stream' && method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const doc = await readPaper(dir, body.id);
        if (!doc) return sendJson(res, 404, { error: '论文不存在' });
        const message = String(body.message ?? '').trim();
        if (message.length === 0) return sendJson(res, 400, { error: '问题不能为空' });
        const chat = chatOf(doc, body.blockId ?? null);
        const history = chat.messages;
        chat.messages = [...history, { role: 'user', content: message, ts: Date.now() }];

        // 流式：先回 SSE 头，之后每来一个片段就写一帧
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        const send = (payload) => {
          if (res.destroyed || res.writableEnded) return;
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };

        const requestId = String(body.requestId ?? '');
        const controller = new AbortController();
        if (requestId) inflight.set(requestId, controller);
        // 客户端断开（含点「停止」后前端 abort）就中止模型调用
        res.on('close', () => controller.abort());

        let answered = false;
        try {
          const result = await askAboutBlockStream(ctx, doc, body.blockId, history, message, {
            model: body.model,
            signal: controller.signal,
            onEvent: (event) => send(event),
          });
          if (result.ok) {
            answered = true;
            chat.messages = [...chat.messages, { role: 'assistant', content: result.text, ts: Date.now() }];
            await writePaper(dir, body.id, doc);
            send({ type: 'done', messages: chat.messages });
          } else {
            await writePaper(dir, body.id, doc);
            send({ type: 'error', message: result.error });
          }
        } catch (error) {
          send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        } finally {
          if (requestId) inflight.delete(requestId);
          if (!answered) {
            // 没答出来也要把用户这句话存下，避免刷新后"问题消失"
            await writePaper(dir, body.id, doc).catch(() => undefined);
          }
          if (!res.writableEnded) res.end();
        }
        return undefined;
      }

      if (path === '/paper/chat/cancel' && method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const controller = inflight.get(String(body.requestId ?? ''));
        if (!controller) return sendJson(res, 200, { ok: true, cancelled: false });
        controller.abort();
        inflight.delete(String(body.requestId));
        return sendJson(res, 200, { ok: true, cancelled: true });
      }

      if (path === '/category' && method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const name = String(body.name ?? '').trim();
        if (name.length === 0) return sendJson(res, 400, { error: '分类名不能为空' });
        const index = await readIndex(dir);
        if (index.categories.some((category) => category.name === name)) {
          return sendJson(res, 409, { error: '已经有同名分类了' });
        }
        const category = { id: newId('c'), name, createdAt: Date.now() };
        await writeIndex(dir, { ...index, categories: [...index.categories, category] });
        return sendJson(res, 200, { category });
      }

      if (path === '/category' && method === 'PATCH') {
        const body = JSON.parse(await readBody(req));
        const index = await readIndex(dir);
        const target = index.categories.find((category) => category.id === body.id);
        if (!target) return sendJson(res, 404, { error: '分类不存在' });
        target.name = String(body.name ?? target.name).trim() || target.name;
        await writeIndex(dir, index);
        return sendJson(res, 200, { category: target });
      }

      if (path === '/category' && method === 'DELETE') {
        const id = query.get('id');
        const index = await readIndex(dir);
        const categories = index.categories.filter((category) => category.id !== id);
        const affected = index.papers.filter((paper) => paper.categoryId === id);
        for (const paper of affected) {
          paper.categoryId = null;
          const doc = await readPaper(dir, paper.id);
          if (doc) {
            doc.categoryId = null;
            await writePaper(dir, paper.id, doc);
          }
        }
        await writeIndex(dir, { ...index, categories });
        return sendJson(res, 200, { ok: true });
      }

      if (path === '/paper/import' && method === 'POST') {
        const started = Date.now();
        const body = JSON.parse(await readBody(req));
        const { paper: structured, warning } = await structurePaper(ctx, body);
        const id = newId('p');
        const figures = [];
        await sequential(structured.figures ?? [], async (figure, position) => {
          const file = `fig-${position + 1}.png`;
          if (typeof figure.dataUrl === 'string' && figure.dataUrl.length > 0) {
            await writeFigure(dir, id, file, figure.dataUrl);
            figures.push({ id: figure.id, file, caption: figure.caption ?? '', page: figure.page ?? 0 });
          }
        });
        if (typeof body.pdfBase64 === 'string' && body.pdfBase64.length > 0) {
          await writeSourcePdf(dir, id, body.pdfBase64).catch(() => undefined);
        }
        const now = Date.now();
        const doc = {
          id,
          title: structured.title,
          abstract: structured.abstract ?? '',
          categoryId: body.categoryId ?? null,
          createdAt: now,
          lastOpenedAt: now,
          blocks: structured.blocks,
          edges: structured.edges,
          text: structured.text ?? '',
          figures,
          notes: [],
          chats: [],
          core: { text: '', updatedAt: 0 },
          layout: { zoom: 1, panX: 0, panY: 0 },
          warning: warning ?? null,
        };
        await writePaper(dir, id, doc);
        const index = await readIndex(dir);
        await writeIndex(dir, { ...index, papers: [...index.papers, summarize(doc)] });
        return sendJson(res, 200, { id, warning: warning ?? null, ms: Date.now() - started });
      }

      if (path === '/paper' && method === 'GET') {
        const id = query.get('id');
        const doc = await readPaper(dir, id);
        if (!doc) return sendJson(res, 404, { error: '论文不存在' });
        doc.lastOpenedAt = Date.now();
        await writePaper(dir, id, doc);
        const index = await readIndex(dir);
        const entry = index.papers.find((paper) => paper.id === id);
        if (entry) {
          entry.lastOpenedAt = doc.lastOpenedAt;
          await writeIndex(dir, index);
        }
        // 全文只留在服务端做检索：客户端用不到，回传只会让每次打开论文多传几十~几百 KB。
        const { text, ...publicDoc } = doc;
        return sendJson(res, 200, { paper: publicDoc, textChars: (text ?? '').length });
      }

      if (path === '/paper' && method === 'PATCH') {
        const body = JSON.parse(await readBody(req));
        const doc = await readPaper(dir, body.id);
        if (!doc) return sendJson(res, 404, { error: '论文不存在' });
        const patch = body.patch ?? {};
        for (const [key, value] of Object.entries(patch)) {
          if (PATCHABLE.has(key)) doc[key] = value;
        }
        await writePaper(dir, body.id, doc);
        const index = await readIndex(dir);
        const entry = index.papers.find((paper) => paper.id === body.id);
        if (entry) {
          entry.title = doc.title;
          entry.categoryId = doc.categoryId ?? null;
          entry.noteCount = (doc.notes ?? []).length;
          entry.hasCore = Boolean(doc.core?.text);
          await writeIndex(dir, index);
        }
        return sendJson(res, 200, { ok: true });
      }

      if (path === '/paper' && method === 'DELETE') {
        const id = query.get('id');
        const index = await readIndex(dir);
        const next = await readIndex(dir);
        next.papers = next.papers.filter((paper) => paper.id !== id);
        await writeIndex(dir, next);
        await rm(paperDir(dir, id), { recursive: true, force: true });
        return sendJson(res, 200, { ok: true, removed: index.papers.length - next.papers.length });
      }

      if (path === '/paper/copy' && method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const source = await readPaper(dir, body.id);
        if (!source) return sendJson(res, 404, { error: '论文不存在' });
        const id = newId('p');
        const now = Date.now();
        const doc = {
          ...source,
          id,
          title: `${source.title}（副本）`,
          categoryId: body.categoryId ?? null,
          createdAt: now,
          lastOpenedAt: now,
        };
        // 图和原 PDF 是纯文件，整目录复制一份；paper.json 由 writePaper 重写
        await mkdir(paperDir(dir, id), { recursive: true });
        for (const name of await readdir(paperDir(dir, source.id))) {
          if (name === 'paper.json') continue;
          await copyFile(join(paperDir(dir, source.id), name), join(paperDir(dir, id), name));
        }
        await writePaper(dir, id, doc);
        const index = await readIndex(dir);
        await writeIndex(dir, { ...index, papers: [...index.papers, summarize(doc)] });
        return sendJson(res, 200, { id, categoryId: doc.categoryId, title: doc.title });
      }

      if (path === '/fs/list' && method === 'GET') {
        // 只读的目录浏览：给"选择数据目录"用，不提供任何写操作
        const target = String(query.get('path') ?? '').trim();
        const start = target.length > 0 ? resolve(target) : homedir();
        if (start.length === 0) return sendJson(res, 400, { error: '路径无效' });
        try {
          const entries = await readdir(start, { withFileTypes: true });
          const dirs = entries
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
            .map((entry) => entry.name)
            .sort((a, b) => a.localeCompare(b));
          const parent = dirname(start);
          return sendJson(res, 200, {
            path: start,
            parent: parent === start ? '' : parent,
            dirs,
          });
        } catch (error) {
          return sendJson(res, 400, { error: `读不了这个目录：${error instanceof Error ? error.message : String(error)}` });
        }
      }

      if (path === '/zotero/status' && method === 'GET') {
        return sendJson(res, 200, await zoteroStatus());
      }

      if (path === '/zotero/items' && method === 'GET') {
        try {
          const items = await listZoteroItems({ q: query.get('q') ?? '', limit: query.get('limit') ?? 20 });
          return sendJson(res, 200, { items });
        } catch (error) {
          return sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (path === '/zotero/file' && method === 'GET') {
        try {
          const bytes = await fetchZoteroFile(query.get('key') ?? '');
          res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(bytes.length) });
          return res.end(Buffer.from(bytes));
        } catch (error) {
          return sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (path === '/zotero/note' && method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const doc = await readPaper(dir, body.id);
        if (!doc) return sendJson(res, 404, { error: '论文不存在' });
        const auth = await zoteroAuth();
        try {
          await pushZoteroNote(auth, String(body.itemKey ?? doc.zotero?.itemKey ?? ''), {
            title: String(doc.title ?? 'PaperNotes'),
            html: String(body.html ?? ''),
          });
          return sendJson(res, 200, { ok: true });
        } catch (error) {
          return sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (path === '/fs/pick-directory' && method === 'POST') {
        // 三层兜底，越靠前越"像系统"：
        //   1) 宿主的 ctx.directoryPicker（Desktop 里挂的是 native 后端）--
        //      macOS 弹 AppKit 的 NSOpenPanel（访达风格的"打开文件夹"），
        //      Windows 弹 IFileOpenDialog（资源管理器风格的文件夹选择器），Linux 走 Zenity/KDialog；
        //   2) 旧宿主没有这个服务时，退回 Electron 主进程的 showOpenDialog；
        //   3) 都没有就回 501，前端退回内置的目录浏览器（纯 Web 宿主）。
        const native = ctx?.get?.('directoryPicker');
        const capability = native?.capability?.();
        if (capability?.kind === 'native' && typeof capability.pick === 'function') {
          const controller = new AbortController();
          const abort = () => controller.abort();
          res.on('close', abort);
          try {
            const picked = await capability.pick(controller.signal);
            return sendJson(res, 200, picked ? { path: picked } : { canceled: true });
          } catch (error) {
            return sendJson(res, 500, {
              error: `系统文件夹选择器打不开：${error instanceof Error ? error.message : String(error)}`,
            });
          } finally {
            res.off('close', abort);
          }
        }
        try {
          const require = createRequire(import.meta.url);
          const electron = require('electron');
          const dialog = electron?.dialog;
          if (!dialog || typeof dialog.showOpenDialog !== 'function') {
            return sendJson(res, 501, { error: '当前宿主没有系统目录对话框' });
          }
          const windows = electron.BrowserWindow?.getAllWindows?.() ?? [];
          const win = electron.BrowserWindow?.getFocusedWindow?.() ?? windows[0];
          const result = win
            ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: '选择数据目录' })
            : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: '选择数据目录' });
          if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
            return sendJson(res, 200, { canceled: true });
          }
          return sendJson(res, 200, { path: result.filePaths[0] });
        } catch (error) {
          return sendJson(res, 501, {
            error: `系统对话框不可用：${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      if (path === '/settings' && method === 'GET') {
        return sendJson(res, 200, maskSettings(await readSettings()));
      }

      if (path === '/settings' && method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const next = await writeSettings(body);
        return sendJson(res, 200, maskSettings(next));
      }

      if (path === '/settings/test' && method === 'POST') {
        // 连通性测试：只试用户填的这套配置，不影响当前设置
        const body = JSON.parse(await readBody(req));
        const current = await readSettings();
        const known = (current.models ?? []).find((item) => item.id === body.id);
        const apiKey = /[•]/.test(String(body.apiKey ?? '')) ? known?.apiKey ?? '' : String(body.apiKey ?? '');
        const config = {
          baseUrl: String(body.baseUrl ?? '').trim(),
          apiKey,
          model: String(body.model ?? '').trim(),
        };
        if (config.baseUrl.length === 0 || config.model.length === 0) {
          return sendJson(res, 400, { ok: false, error: '先填 baseUrl 和模型名' });
        }
        const result = await testConnection(config);
        return sendJson(res, 200, result);
      }

      if (path === '/paper/reanalyze' && method === 'POST') {
        // 用已存的全文重跑一次结构化：换节点/连线，笔记与会话按标题/类型迁移过去
        const body = JSON.parse(await readBody(req));
        const doc = await readPaper(dir, body.id);
        if (!doc) return sendJson(res, 404, { error: '论文不存在' });
        const result = await reanalyzePaper(ctx, doc).catch((error) => ({ error }));
        if (result.error) return sendJson(res, 502, { error: result.error.message ?? String(result.error) });
        const migrated = migrateAnnotations(doc.blocks ?? [], result.blocks, doc.notes ?? [], doc.chats ?? []);
        doc.blocks = result.blocks;
        doc.edges = result.edges;
        doc.notes = migrated.notes;
        doc.chats = migrated.chats;
        if (result.title) doc.title = result.title;
        if (result.abstract) doc.abstract = result.abstract;
        // 重分析成功：之前"退回按章节切分"的警告不再成立
        doc.warning = null;
        await writePaper(dir, body.id, doc);
        return sendJson(res, 200, {
          paper: summarize(doc),
          blocks: doc.blocks.length,
          movedNotes: migrated.movedNotes,
          movedChats: migrated.movedChats,
        });
      }

      if (path === '/paper/figures' && method === 'POST') {
        // 「重新裁图」：用同一份 source.pdf 重跑裁图，只替换图片，节点/坐标/笔记/会话都不动。
        // 图 id 尽量复用：先按图注文本匹配，退而按顺序匹配，节点上的 figureId 才不会指空。
        const body = JSON.parse(await readBody(req));
        const doc = await readPaper(dir, body.id);
        if (!doc) return sendJson(res, 404, { error: '论文不存在' });
        const incoming = Array.isArray(body.figures) ? body.figures : [];
        if (incoming.length === 0) return sendJson(res, 400, { error: '没有裁出任何图' });
        const oldFigures = doc.figures ?? [];
        const key = (caption) => String(caption ?? '').trim().slice(0, 120);
        const saved = [];
        const remap = new Map();
        for (const [index, input] of incoming.entries()) {
          const file = `fig-${index + 1}.png`;
          await writeFigure(dir, body.id, file, input.dataUrl);
          const matched =
            oldFigures.find((old) => key(old.caption) === key(input.caption)) ?? oldFigures[index];
          const figure = {
            id: matched ? matched.id : newId('f'),
            file,
            caption: String(input.caption ?? '').slice(0, 400),
            page: Number(input.page) || 0,
          };
          if (matched) remap.set(matched.id, figure.id);
          saved.push(figure);
        }
        doc.figures = saved;
        doc.blocks = (doc.blocks ?? []).map((block) => {
          if (!block.figureId) return block;
          const next = remap.get(block.figureId);
          if (next) return { ...block, figureId: next };
          const stillThere = saved.some((figure) => figure.id === block.figureId);
          return stillThere ? block : { ...block, figureId: undefined };
        });
        await writePaper(dir, body.id, doc);
        // 清掉不再引用的旧图
        for (const old of oldFigures) {
          if (saved.some((figure) => figure.file === old.file)) continue;
          await rm(join(paperDir(dir, body.id), old.file), { force: true });
        }
        return sendJson(res, 200, { figures: saved.length, paper: summarize(doc) });
      }

      if (path === '/paper/figure' && method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const doc = await readPaper(dir, body.id);
        if (!doc) return sendJson(res, 404, { error: '论文不存在' });
        if (typeof body.dataUrl !== 'string' || !body.dataUrl.startsWith('data:image/')) {
          return sendJson(res, 400, { error: '只接受图片' });
        }
        const file = `fig-up-${Date.now().toString(36)}.png`;
        await writeFigure(dir, body.id, file, body.dataUrl);
        const figure = {
          id: newId('f'),
          file,
          caption: String(body.caption ?? '手动上传').slice(0, 200),
          page: 0,
        };
        doc.figures = [...(doc.figures ?? []), figure];
        await writePaper(dir, body.id, doc);
        return sendJson(res, 200, { figure });
      }

      if (path === '/paper/chat' && method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const doc = await readPaper(dir, body.id);
        if (!doc) return sendJson(res, 404, { error: '论文不存在' });
        const chat = chatOf(doc, body.blockId ?? null);
        const message = String(body.message ?? '').trim();
        if (message.length === 0) return sendJson(res, 400, { error: '问题不能为空' });
        const history = chat.messages;
        chat.messages = [...history, { role: 'user', content: message, ts: Date.now() }];
        const requestId = String(body.requestId ?? '');
        const controller = new AbortController();
        if (requestId) inflight.set(requestId, controller);
        let result;
        try {
          result = await askAboutBlock(ctx, doc, body.blockId, history, message, {
            model: body.model,
            signal: controller.signal,
          });
        } finally {
          if (requestId) inflight.delete(requestId);
        }
        if (!result.ok) {
          await writePaper(dir, body.id, doc);
          return sendJson(res, 502, { error: result.error, messages: chat.messages });
        }
        chat.messages = [...chat.messages, { role: 'assistant', content: result.text, ts: Date.now() }];
        await writePaper(dir, body.id, doc);
        return sendJson(res, 200, { messages: chat.messages });
      }

      if (path === '/paper/condense' && method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const doc = await readPaper(dir, body.id);
        if (!doc) return sendJson(res, 404, { error: '论文不存在' });
        const result = await condenseNote(ctx, doc, body.blockId ?? null);
        if (!result.ok) return sendJson(res, 502, { error: result.error });
        const note = { id: newId('n'), kind: 'ai', blockId: body.blockId ?? null, text: result.text, createdAt: Date.now() };
        doc.notes = [...(doc.notes ?? []), note];
        await writePaper(dir, body.id, doc);
        return sendJson(res, 200, { note });
      }

      if (path === '/paper/core' && method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const doc = await readPaper(dir, body.id);
        if (!doc) return sendJson(res, 404, { error: '论文不存在' });
        const result = await buildCore(ctx, doc);
        if (!result.ok) return sendJson(res, 502, { error: result.error });
        doc.core = { text: result.text, updatedAt: Date.now() };
        await writePaper(dir, body.id, doc);
        return sendJson(res, 200, { core: doc.core });
      }

      if (path === '/compare/history' && method === 'GET') {
        const ids = (query.get('ids') ?? '').split(',').filter(Boolean).sort();
        const file = join(dir, 'compare-chats.json');
        const all = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : {};
        return sendJson(res, 200, { key: ids.join('|'), messages: all[ids.join('|')] ?? [] });
      }

      if (path === '/compare/history' && method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const ids = (Array.isArray(body.paperIds) ? body.paperIds : []).map(String).sort();
        if (ids.length === 0) return sendJson(res, 400, { error: '没有选中任何论文' });
        const file = join(dir, 'compare-chats.json');
        const all = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : {};
        all[ids.join('|')] = Array.isArray(body.messages) ? body.messages : [];
        await mkdir(dir, { recursive: true });
        await readFile;
        const { writeFile } = await import('node:fs/promises');
        await writeFile(file, JSON.stringify(all, null, 2), 'utf8');
        return sendJson(res, 200, { ok: true, count: all[ids.join('|')].length });
      }

      if (path === '/compare/chat/stream' && method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const ids = Array.isArray(body.paperIds) ? body.paperIds : [];
        const papers = [];
        for (const id of ids) {
          const doc = await readPaper(dir, id);
          if (doc) papers.push(doc);
        }
        if (papers.length === 0) return sendJson(res, 404, { error: '选中的论文读不出来' });
        const message = String(body.message ?? '').trim();
        if (message.length === 0) return sendJson(res, 400, { error: '问题不能为空' });
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        const send = (payload) => {
          if (res.destroyed || res.writableEnded) return;
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };
        const controller = new AbortController();
        res.on('close', () => controller.abort());
        try {
          const result = await compareChatStream(ctx, papers, body.history ?? [], message, {
            model: body.model,
            signal: controller.signal,
            onEvent: (event) => send(event),
          });
          if (result.ok) send({ type: 'done', text: result.text });
          else send({ type: 'error', message: result.error });
        } catch (error) {
          send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        } finally {
          if (!res.writableEnded) res.end();
        }
        return undefined;
      }

      if (path === '/compare/chat' && method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const ids = Array.isArray(body.paperIds) ? body.paperIds : [];
        const papers = [];
        for (const id of ids) {
          const doc = await readPaper(dir, id);
          if (doc) papers.push(doc);
        }
        if (papers.length === 0) return sendJson(res, 404, { error: '选中的论文读不出来' });
        const result = await compareChat(ctx, papers, body.history ?? [], body.message, { model: body.model });
        if (!result.ok) return sendJson(res, 502, { error: result.error });
        return sendJson(res, 200, { reply: result.text });
      }

      if (path === '/asset' && method === 'GET') {
        const paperId = query.get('paper') ?? '';
        const file = query.get('file') ?? '';
        const resolved = resolveInPaperDir(dir, paperId, file);
        if (!resolved) return sendText(res, 404, 'not found');
        const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
        return sendFile(res, resolved, MIME[ext]);
      }

      if (path === '/paper/open-pdf' && method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const file = resolveInPaperDir(dir, String(body.id ?? ''), 'source.pdf');
        if (!file) return sendJson(res, 404, { error: '这篇没有保存原文 PDF' });
        // 用系统默认阅读器打开：只在宿主本机执行，命令与参数分开传，不拼 shell。
        // Windows 上 explorer 对带空格的路径不友好，走 `cmd /c start "" "<file>"` 更稳；
        // 但为了避免经由 shell 拼接，这里用 start 的独立参数形式。
        const command =
          process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
        const args =
          process.platform === 'win32' ? ['/c', 'start', '', file] : [file];
        const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        return sendJson(res, 200, { ok: true, file });
      }

      if (path === '/pdf' && method === 'GET') {
        const paperId = query.get('id') ?? '';
        const resolved = resolveInPaperDir(dir, paperId, 'source.pdf');
        if (!resolved) return sendText(res, 404, '没有保存原文 PDF');
        return sendFile(res, resolved, MIME['.pdf']);
      }

      if (path === '/setting' && method === 'GET') {
        return sendJson(res, 200, { dataDir: dir });
      }

      if (path === '/setting' && method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const next = await setDataDir(body.dataDir);
        return sendJson(res, 200, { dataDir: next });
      }

      if (path === '/worker' && method === 'GET') {
        return sendFile(res, join(PACKAGE_ROOT, 'dist', 'pdf.worker.mjs'), MIME['.mjs']);
      }

      if (path === '/pdfjs.mjs' && method === 'GET') {
        return sendFile(res, join(PACKAGE_ROOT, 'dist', 'pdfjs.mjs'), MIME['.mjs']);
      }

      return sendJson(res, 404, { error: 'no route: ' + method + ' ' + path });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger?.warn?.('[dsh-paper-desk] ' + method + ' ' + path + ' 失败：' + message);
      return sendJson(res, 500, { error: message });
    }
  };
}

/** 导出给测试/自检用。 */
export { emptyIndex };
