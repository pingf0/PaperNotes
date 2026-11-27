/**
 * 插件自己的设置：模型 API（可接 OpenAI / Kimi / DeepSeek / 本地 Ollama）与提示词角色。
 *
 * 存在**引导目录**（$DSH_HOME/paper-desk/settings.json），和数据目录分开：
 * 换论文库不该把 API key 一起换掉。
 *
 * 安全说明：key 以明文存在本机这个文件里（插件没有系统钥匙串可用），
 * 对外返回时一律打码，只在宿主内部使用。
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapDir } from './store.js';

/** 常见服务的预设（只用来给界面填默认值）。 */
export const PRESETS = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'kimi', name: 'Kimi（Moonshot）', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-32k' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'ollama', name: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
  { id: 'custom', name: '自定义（OpenAI 兼容）', baseUrl: '', model: '' },
];

/** 默认设置。 */
export function defaultSettings() {
  return {
    /** 全局角色设定：追加在内置 system prompt 后面，用来定"它是谁、怎么说话" */
    persona: '',
    /** 各场景的补充要求（留空则只用内置规则） */
    prompts: { chat: '', core: '', compare: '' },
    /** 用户自己添加的模型（OpenAI 兼容接口），会话里可直接选 */
    models: [],
    /** 默认用哪个自定义模型（空 = 用 DSH 自带模型） */
    activeModelId: '',
    temperature: 0.5,
    /** Zotero 回写笔记用（本地接口只读，写必须走官方 Web API） */
    zotero: { userId: '', apiKey: '' },
  };
}

/**
 * 一个自定义模型的形状。
 * @param {object} input 表单输入
 */
export function normalizeModel(input) {
  return {
    id: String(input.id ?? '').trim() || `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: String(input.name ?? '').trim() || '未命名模型',
    baseUrl: String(input.baseUrl ?? '').trim().replace(/\/+$/, ''),
    apiKey: String(input.apiKey ?? '').trim(),
    model: String(input.model ?? '').trim(),
  };
}

/** 按 id 找自定义模型。 */
export function findModel(settings, id) {
  if (!id) return undefined;
  return (settings?.models ?? []).find((item) => item.id === id);
}

/** 最近一次读/写到的设置（给同步判断用，例如 llmReady）。 */
let cachedSettings = null;

/** 同步取缓存（可能为 null）。 */
export function getCachedSettings() {
  return cachedSettings;
}

/** 设置文件路径。 */
export function settingsFile() {
  return join(bootstrapDir(), 'settings.json');
}

/** 读设置（缺字段自动补默认值）。 */
export async function readSettings() {
  const file = settingsFile();
  if (!existsSync(file)) return defaultSettings();
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    const base = defaultSettings();
    cachedSettings = {
      ...base,
      ...parsed,
      prompts: { ...base.prompts, ...(parsed.prompts ?? {}) },
      models: Array.isArray(parsed.models) ? parsed.models.map(normalizeModel) : [],
      zotero: { ...base.zotero, ...(parsed.zotero ?? {}) },
    };
    return cachedSettings;
  } catch {
    return defaultSettings();
  }
}

/**
 * 写设置。传进来的 `apiKey` 如果还是打码形态（含 •），说明用户没改，保留原来的。
 * @param {object} patch 局部设置
 */
export async function writeSettings(patch) {
  const current = await readSettings();
  const next = {
    ...current,
    ...patch,
    prompts: { ...current.prompts, ...(patch.prompts ?? {}) },
    zotero: { ...current.zotero, ...(patch.zotero ?? {}) },
  };
  // 模型列表：整表替换，但被打码的 key 视为"没改"，沿用旧值
  if (Array.isArray(patch.models)) {
    next.models = patch.models.map((input) => {
      const normalized = normalizeModel(input);
      if (/[•]/.test(normalized.apiKey)) {
        const old = findModel(current, normalized.id);
        normalized.apiKey = old?.apiKey ?? '';
      }
      return normalized;
    });
  }
  if (typeof next.activeModelId === 'string' && next.activeModelId.length > 0) {
    if (!findModel(next, next.activeModelId)) next.activeModelId = '';
  }
  if (typeof next.temperature !== 'number' || Number.isNaN(next.temperature)) next.temperature = 0.5;
  // 和界面滑杆一致：0–1.5
  next.temperature = Math.min(1.5, Math.max(0, next.temperature));
  await mkdir(bootstrapDir(), { recursive: true });
  await writeFile(settingsFile(), JSON.stringify(next, null, 2), 'utf8');
  cachedSettings = next;
  return next;
}

/** 打码一个 key。 */
function maskKey(key) {
  const value = String(key ?? '');
  if (value.length === 0) return '';
  return value.length <= 8 ? '••••' : `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

/** 给界面看的版本：每个模型的 key 都打码。 */
export function maskSettings(settings) {
  return {
    ...settings,
    models: (settings.models ?? []).map((item) => ({ ...item, apiKey: maskKey(item.apiKey), hasKey: String(item.apiKey ?? '').length > 0 })),
    zotero: {
      userId: settings.zotero?.userId ?? '',
      apiKey: maskKey(settings.zotero?.apiKey),
      hasKey: String(settings.zotero?.apiKey ?? '').length > 0,
    },
    presets: PRESETS,
  };
}

/**
 * 这次调用该用哪套接口？
 * @param settings 设置
 * @param selection 调用方指定的 { provider, model }
 * @returns 自定义模型的配置；返回 undefined 表示走 DSH 自带模型
 */
export function resolveCustomModel(settings, selection) {
  if (!settings) return undefined;
  const models = settings.models ?? [];
  if (selection && selection.provider === 'custom') {
    const picked = models.find((item) => item.id === selection.model);
    if (picked) return picked;
  }
  const active = models.find((item) => item.id === settings.activeModelId);
  return active && active.baseUrl && active.model ? active : undefined;
}
