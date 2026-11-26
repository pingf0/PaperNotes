/**
 * 论文台的数据层：数据目录解析 + 原子读写。
 *
 * 存储布局（用户可选数据目录，默认 $DSH_HOME/paper-desk/data）：
 *   index.json                    分类与论文摘要（列表页只读它）
 *   papers/<paperId>/paper.json   单篇论文全文（节点、连线、笔记、会话、core）
 *   papers/<paperId>/fig-<n>.png  论文里裁出来的图
 *   papers/<paperId>/source.pdf   原始 PDF（有就存，用于"打开原文"）
 *
 * 数据目录本身记在**固定引导文件** $DSH_HOME/paper-desk/config.json 里：
 * 数据目录不能存在数据目录里，所以指针必须落在固定位置。用户改目录只改这一个文件，
 * 不影响插件配置（cordis.patch.yml 是用户的文件，插件不碰）。
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, normalize, resolve, sep } from 'node:path';

/** DSH 主目录：与 dsh-pet 同源（$DSH_HOME，缺省 ~/.dsh）。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  return fromEnv && fromEnv.length > 0 ? resolve(fromEnv) : join(homedir(), '.dsh');
}

/** 引导配置目录（固定，不随用户数据目录变化）。 */
export function bootstrapDir() {
  return join(dshHome(), 'paper-desk');
}

/** 引导配置文件。 */
export function bootstrapFile() {
  return join(bootstrapDir(), 'config.json');
}

/** 默认数据目录。 */
export function defaultDataDir() {
  return join(bootstrapDir(), 'data');
}

/** 每个文件的写串行化：同一文件并发写会让 tmp 文件互相覆盖。 */
const writeChains = new Map();

/**
 * 原子写：同目录临时文件 + rename。写失败不留半截文件。
 * @param file 目标路径
 * @param content 文本内容
 */
async function atomicWrite(file, content) {
  const prev = writeChains.get(file) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, content, 'utf8');
      await rename(tmp, file);
    });
  writeChains.set(file, next);
  try {
    await next;
  } finally {
    if (writeChains.get(file) === next) writeChains.delete(file);
  }
}

/**
 * 读 JSON；文件不存在或损坏时返回 fallback（损坏不静默吞掉：备份一份再重建）。
 * @param file 路径
 * @param fallback 缺省值
 */
async function readJson(file, fallback) {
  try {
    const text = await readFile(file, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    if (existsSync(file)) {
      try {
        await atomicWrite(`${file}.broken-${Date.now()}`, String(error && error.message));
      } catch {
        /* 备份失败不阻塞重建：主流程仍要能打开 */
      }
    }
    return fallback;
  }
}

/** 写 JSON（2 空格缩进，便于用户直接看/改）。 */
async function writeJson(file, value) {
  await atomicWrite(file, JSON.stringify(value, null, 2));
}

/** 引导配置：只存 dataDir。 */
export async function readBootstrap() {
  const raw = await readJson(bootstrapFile(), {});
  return { dataDir: typeof raw.dataDir === 'string' && raw.dataDir.length > 0 ? raw.dataDir : defaultDataDir() };
}

/** 当前数据目录（绝对路径）。 */
export async function dataDir() {
  const { dataDir: dir } = await readBootstrap();
  return resolve(dir);
}

/**
 * 设置数据目录：校验可写、建目录、写入引导文件。
 * @param next 用户给的路径（可以是 ~ 开头）
 * @returns 规范化后的绝对路径
 */
export async function setDataDir(next) {
  const raw = String(next ?? '').trim();
  if (raw.length === 0) throw new Error('数据目录不能为空');
  const expanded = raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw;
  const dir = resolve(expanded);
  await mkdir(join(dir, 'papers'), { recursive: true });
  await writeFile(join(dir, '.paper-desk-probe'), 'ok', 'utf8').catch(() => {
    throw new Error('目录不可写：' + dir);
  });
  await writeJson(bootstrapFile(), { dataDir: dir });
  return dir;
}

/** 索引文件路径。 */
function indexPath(dir) {
  return join(dir, 'index.json');
}

/** 空索引。 */
export function emptyIndex() {
  return { version: 1, categories: [], papers: [] };
}

/** 读索引（并补齐字段）。 */
export async function readIndex(dir) {
  const raw = await readJson(indexPath(dir), emptyIndex());
  const index = {
    version: 1,
    categories: Array.isArray(raw.categories) ? raw.categories : [],
    papers: Array.isArray(raw.papers) ? raw.papers : [],
  };
  return index;
}

/** 写索引。 */
export async function writeIndex(dir, index) {
  await writeJson(indexPath(dir), index);
}

/** 单篇论文目录。 */
export function paperDir(dir, id) {
  return join(dir, 'papers', id);
}

/** 单篇论文 JSON 路径。 */
function paperFile(dir, id) {
  return join(paperDir(dir, id), 'paper.json');
}

/** 读单篇论文。 */
export async function readPaper(dir, id) {
  return readJson(paperFile(dir, id), null);
}

/** 写单篇论文。 */
export async function writePaper(dir, id, doc) {
  await writeJson(paperFile(dir, id), doc);
}

/** 把相对文件名限制在论文目录内（防路径穿越）。 */
export function resolveInPaperDir(dir, id, file) {
  const root = paperDir(dir, id);
  const candidate = normalize(join(root, file));
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (candidate !== root && !candidate.startsWith(prefix)) return undefined;
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * 生成短 id。
 * @param prefix 前缀
 */
export function newId(prefix) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

/** 写 PNG（base64）。 */
export async function writeFigure(dir, id, fileName, base64) {
  await mkdir(paperDir(dir, id), { recursive: true });
  const bytes = Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ''), 'base64');
  await writeFile(join(paperDir(dir, id), fileName), bytes);
}

/** 写原始 PDF（base64）。 */
export async function writeSourcePdf(dir, id, base64) {
  await mkdir(paperDir(dir, id), { recursive: true });
  const bytes = Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ''), 'base64');
  await writeFile(join(paperDir(dir, id), 'source.pdf'), bytes);
}
