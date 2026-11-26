/**
 * 公式渲染：KaTeX。
 *
 * 为什么要它：模型给的是 LaTeX 源码，之前直接当等宽文本显示，用户看到的是
 * `\mathbf{z}_u^{final} = \alpha ...` 这种原始串 —— 论文里的公式读不了。
 *
 * 字体怎么办：KaTeX 的 HTML 输出要配套字体。CSS 里的 url(fonts/...) 会以页面为基准解析，
 * 所以构建时把 woff2 直接内联成 data URL（见 scripts/build.mjs），不依赖任何静态路由。
 */
import katex from 'katex';
// 构建时生成：KaTeX 样式，字体已内联成 data URL（见 scripts/build.mjs）
import katexCss from '../../dist/katex.css';

/** 组装好的 KaTeX 样式（由 index.jsx 追加到插件的 <style> 里）。 */
export const KATEX_CSS = String(katexCss);

/** 渲染结果缓存：同一个公式节点每次重渲染不必重算。 */
const cache = new Map();

/**
 * 把一个 LaTeX 源码渲染成 KaTeX 的 HTML 片段。
 * @param {string} tex LaTeX 源码
 * @param {boolean} display 是否行间公式（true 居中、大号）
 * @returns {string} HTML；无法渲染时返回空串（调用方回落到纯文本）
 */
export function katexHtml(tex, display = true) {
  const source = String(tex ?? '').trim();
  if (source.length === 0) return '';
  const key = `${display ? 'D' : 'I'}:${source}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let html = '';
  try {
    html = katex.renderToString(source, {
      displayMode: display,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
      output: 'html',
    });
  } catch {
    html = '';
  }
  if (cache.size > 300) cache.clear();
  cache.set(key, html);
  return html;
}

/**
 * 去掉公式外层的 $ / $$ 包裹（模型有时会把定界符一起塞进来）。
 * @param {string} tex
 * @returns {string}
 */
export function stripDelimiters(tex) {
  const value = String(tex ?? '').trim();
  const matched = /^\$\$([\s\S]*)\$\$$/.exec(value) ?? /^\$([\s\S]*)\$$/.exec(value);
  return matched ? matched[1].trim() : value;
}
