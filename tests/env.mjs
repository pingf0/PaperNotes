/**
 * 测试用的环境解析：把本机绝对路径集中到一处，别人 clone 之后也能跑（缺东西就跳过）。
 *
 * 可用环境变量覆盖：
 *   PN_PLAYWRIGHT    playwright 包入口（默认从 cwd 的 node_modules 里 resolve）
 *   PN_CHROMIUM      Chromium 可执行文件（默认交给 playwright 自己找）
 *   PN_THEME_DIR     ui-theme 的样式目录（预览台用它模拟宿主样式，缺了就用内置兜底）
 *   PN_SAMPLE_PDF    一份真实 PDF（预览台用它验"重新裁图"）
 *   PN_REACT_DIR     含 react 的目录（bundle 自检用）
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

/** 解析 playwright 的入口；没有就返回 undefined。 */
export function playwrightEntry() {
  if (process.env.PN_PLAYWRIGHT) return process.env.PN_PLAYWRIGHT;
  try {
    return require.resolve('playwright');
  } catch {
    try {
      return require.resolve('playwright-core');
    } catch {
      return undefined;
    }
  }
}

/** 是否具备跑浏览器测试的条件。 */
export function hasPlaywright() {
  return Boolean(playwrightEntry());
}

/** Chromium 可执行文件；没设就返回 undefined，让 playwright 用自带的。 */
export function chromiumPath() {
  const fromEnv = process.env.PN_CHROMIUM;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return undefined;
}

/** 宿主主题样式目录（可选）。 */
export function themeDir() {
  const fromEnv = process.env.PN_THEME_DIR;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return undefined;
}

/** 一份真实 PDF（可选）。 */
export function samplePdf() {
  const fromEnv = process.env.PN_SAMPLE_PDF;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return undefined;
}

/** 含 react 的目录（bundle 自检用）；没有就返回 undefined。 */
export function reactDir() {
  const fromEnv = process.env.PN_REACT_DIR;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    return join(require.resolve('react/package.json'), '..');
  } catch {
    return undefined;
  }
}

/** 打一行 SKIP 并退出，用于"本机缺依赖"的情况。 */
export function skip(reason) {
  console.log(`SKIP ${reason}`);
  process.exit(0);
}
