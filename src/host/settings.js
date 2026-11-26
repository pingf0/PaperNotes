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
    /** host = 用 DSH 自己的模型；custom = 用下面这套 OpenAI 兼容接口 */
    provider: 'host',
    baseUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.5,
    /** 全局角色设定：追加在每段内置 system prompt 后面，用来定"它是谁、怎么说话" */
    persona: '',
    /** 分场景补充要求（留空则只用内置规则） */
    prompts: { chat: '', core: '', compare: '' },
  };
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
  };
  if (typeof patch.apiKey === 'string' && /[•]/.test(patch.apiKey)) next.apiKey = current.apiKey;
  if (typeof next.temperature !== 'number' || Number.isNaN(next.temperature)) next.temperature = 0.5;
  // 和界面滑杆一致：0–1.5
  next.temperature = Math.min(1.5, Math.max(0, next.temperature));
  await mkdir(bootstrapDir(), { recursive: true });
  await writeFile(settingsFile(), JSON.stringify(next, null, 2), 'utf8');
  cachedSettings = next;
  return next;
}

/** 给界面看的版本：key 打码。 */
export function maskSettings(settings) {
  const key = String(settings.apiKey ?? '');
  const masked = key.length <= 8 ? (key.length > 0 ? '••••' : '') : `${key.slice(0, 4)}••••${key.slice(-4)}`;
  return {
    ...settings,
    apiKey: masked,
    hasKey: key.length > 0,
    presets: PRESETS,
  };
}

/** 当前是否该走自定义接口。 */
export function useCustomProvider(settings) {
  return (
    settings?.provider === 'custom' &&
    typeof settings.baseUrl === 'string' &&
    settings.baseUrl.trim().length > 0 &&
    typeof settings.model === 'string' &&
    settings.model.trim().length > 0
  );
}
