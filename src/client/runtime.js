/**
 * React 绑定层。
 *
 * DSH 的 __ModuleLoader__ 把一个同步 require 交给插件 factory，react 只能在那时取到。
 * 但模块级 `import React from 'react'` 会在 factory 执行之前求值，拿不到东西。
 * 所以这里导出一个**惰性 Proxy**：任何 React.xxx 的读取都推迟到真正渲染时，
 * 那时 factory 已经把真 React 塞进 globalThis 了。JSX 编译成 React.createElement 也走这条路。
 */

import { katexHtml, stripDelimiters } from './tex.js';

/** 全局键名（只在本插件内使用）。 */
const KEY = '__DSH_PAPER_DESK_REACT__';

/**
 * 绑定真正的 React 实例（在 factory 里调用一次）。
 * @param {object} react require('react') 的结果
 */
export function bindReact(react) {
  globalThis[KEY] = react;
}

/** 取真 React；没绑定时给出可诊断的错误。 */
function real() {
  const react = globalThis[KEY];
  if (!react) throw new Error('论文台：React 尚未绑定');
  return react;
}

/**
 * 惰性 React 代理：属性读取每次转发到真实例。
 * 组件里写成 React.useState / React.useEffect 即可，不需要解构。
 */
export const React = new Proxy(
  {},
  {
    get(_target, property) {
      return real()[property];
    },
    has(_target, property) {
      return property in real();
    },
  },
);

/**
 * 生成简易唯一 id（前端节点/临时用）。
 * @param {string} prefix
 */
export function uid(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 相对时间文案（"3 天前"）。
 * @param {number} ts 毫秒时间戳，0 表示从未打开
 */
export function relativeTime(ts) {
  if (!ts) return '还没打开过';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}

/**
 * 正文里没加 `$` 的裸 LaTeX（模型经常这么写：`\mathbf{z}_u^{final} 随后用于...`）
 * 自动补上定界符，交给后面的行内公式分支渲染。
 *
 * 只认"反斜杠命令 + 紧跟的上下标"这种明确形态，避免把普通文本误判成公式；
 * 已经在 `$...$` / `$$...$$` 里的内容原样跳过。
 * @param {string} text 原文
 * @returns {string} 补好 `$` 的文本
 */
export function wrapBareTex(text) {
  const parts = String(text ?? '').split(/(\$\$[\s\S]*?\$\$|\$[^$\n]*\$)/g);
  return parts
    .map((part, index) => (index % 2 === 1 ? part : part.replace(BARE_TEX, (match, command, group, scripts) => {
      // 只把"像公式"的片段包起来：已知命令、后面紧跟 {…}、或带上下标。
      // 这样 C:\Users\name 这种路径不会被误包成公式。
      const known = KNOWN_TEX_COMMANDS.has(command);
      if (!known && !group && !scripts) return match;
      return `$${match}$`;
    })))
    .join('');
}

/** 一行里可能出现的裸 LaTeX 片段：命令 + 可选 {…} + 可选上下标。 */
const BARE_TEX = /\\([A-Za-z]+)(\{[^{}]*\})*((?:_|\^)(\{[^{}]*\}|[A-Za-z0-9]))*/g;

/** 常见数学命令：即便后面没有 {} 或上下标，也认为是公式（\alpha、\lambda 这种）。 */
const KNOWN_TEX_COMMANDS = new Set([
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'iota',
  'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi', 'varphi',
  'chi', 'psi', 'omega', 'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Phi', 'Psi', 'Omega',
  'mathbf', 'mathrm', 'mathit', 'mathcal', 'mathbb', 'mathsf', 'boldsymbol', 'text', 'operatorname',
  'frac', 'dfrac', 'tfrac', 'sqrt', 'sum', 'prod', 'int', 'iint', 'oint', 'lim', 'log', 'ln', 'exp',
  'sin', 'cos', 'tan', 'softmax', 'argmax', 'argmin', 'min', 'max', 'top', 'partial', 'nabla',
  'cdot', 'times', 'div', 'pm', 'leq', 'geq', 'neq', 'approx', 'equiv', 'sim', 'propto', 'in', 'notin',
  'subset', 'subseteq', 'cup', 'cap', 'forall', 'exists', 'infty', 'rightarrow', 'leftarrow',
  'Rightarrow', 'leftrightarrow', 'to', 'mid', 'langle', 'rangle', 'hat', 'bar', 'tilde', 'vec',
  'quad', 'qquad', 'dots', 'cdots', 'ldots', 'left', 'right', 'big', 'Big', 'bigl', 'bigr',
]);

/**
 * 极简 markdown → React 节点：支持标题、列表、粗体、行内代码、段落。
 * 够用来渲染模型返回的读后整理，不引第三方库。
 * @param {string} text
 * @returns {Array} React 节点数组
 */
export function renderMarkdown(text) {
  const R = real();
  const lines = wrapBareTex(text).split('\n');
  const out = [];
  let list = null;
  const inline = (value) => {
    const parts = [];
    const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\$[^$]+\$)/g;
    let last = 0;
    let match;
    while ((match = pattern.exec(value)) !== null) {
      if (match.index > last) parts.push(value.slice(last, match.index));
      const token = match[0];
      if (token.startsWith('**')) parts.push(R.createElement('strong', { key: `${match.index}-b` }, token.slice(2, -2)));
      else if (token.startsWith('`')) parts.push(R.createElement('code', { key: `${match.index}-c`, className: 'pd-code' }, token.slice(1, -1)));
      else {
        // 行内公式：交给 KaTeX 渲染成 HTML；渲染失败就退回原文
        const html = katexHtml(stripDelimiters(token), false);
        parts.push(
          html.length > 0
            ? R.createElement('span', { key: `${match.index}-m`, className: 'pd-math', dangerouslySetInnerHTML: { __html: html } })
            : R.createElement('span', { key: `${match.index}-m`, className: 'pd-math' }, token),
        );
      }
      last = match.index + token.length;
    }
    if (last < value.length) parts.push(value.slice(last));
    return parts;
  };
  const flushList = () => {
    if (list && list.length > 0) {
      out.push(R.createElement('ul', { key: `ul-${out.length}`, className: 'pd-md-ul' }, list));
      list = null;
    }
  };
  lines.forEach((raw, index) => {
    const line = raw.trimEnd();
    if (line.trim().length === 0) {
      flushList();
      return;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushList();
      const level = heading[1].length;
      out.push(
        R.createElement(
          `h${Math.min(4, level + 2)}`,
          { key: `h-${index}`, className: 'pd-md-h' },
          inline(heading[2]),
        ),
      );
      return;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      list = list ?? [];
      list.push(R.createElement('li', { key: `li-${index}` }, inline(bullet[1])));
      return;
    }
    flushList();
    out.push(R.createElement('p', { key: `p-${index}`, className: 'pd-md-p' }, inline(line)));
  });
  flushList();
  return out;
}
