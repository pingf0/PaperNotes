/**
 * 浏览器 bundle 的离屏自检（不需要 DSH、不需要 token）：
 * 在 Node 里假装成 window.__ModuleLoader__，把 client.js 跑起来，
 * 校验 factory / apply / slot 注册 / 首屏渲染这条路是通的。
 *
 * react / react-dom 从本仓库的 node_modules 里取；没有就跳过（或设 PN_REACT_DIR 指定目录）。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { reactDir, skip } from './env.mjs';

const dir = reactDir();
if (!dir) skip('没装 react（pnpm add -D react react-dom，或设 PN_REACT_DIR）');
const requireReact = createRequire(`${dir}/package.json`);
const React = requireReact('react');
const { renderToString } = requireReact('react-dom/server');

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

let loaded;
globalThis.window = {
  __ModuleLoader__: {
    load(info) {
      loaded = info;
    },
  },
};
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, style: {}, remove() {}, textContent: '' }),
  head: { appendChild() {} },
};

new Function('window', 'document', source)(globalThis.window, globalThis.document);
check('bundle 调用了 __ModuleLoader__.load', Boolean(loaded), loaded?.id);
check('模块 id 与包名一致', loaded?.id === 'dsh-paper-desk', loaded?.id);

const mod = loaded.factory((name) => {
  if (name === 'react') return React;
  throw new Error('unexpected require: ' + name);
});
check('factory 返回插件模块', typeof mod?.apply === 'function');
check('模块声明 inject=slots', Array.isArray(mod.inject) && mod.inject.includes('slots'), JSON.stringify(mod.inject));

const registrations = [];
const ctx = {
  effect(fn) {
    return fn();
  },
  slots: {
    inject(name, factory) {
      factory();
      return () => {};
    },
    register(options, Component) {
      registrations.push({ options, Component });
      return { options, Component };
    },
  },
};
mod.apply(ctx);
const page = registrations.find((entry) => entry.options?.name === 'main');
const sidebar = registrations.find((entry) => entry.options?.name === 'sidebar.panellist');
check('注册了 main 主面板', Boolean(page), JSON.stringify(page?.options));
check('main 的 key 与侧边栏 id 一致', page?.options?.key === 'paper-desk' && sidebar?.options?.id === 'paper-desk');
check('侧边栏条目带标题', typeof sidebar?.options?.label === 'function' && sidebar.options.label() === 'PaperNotes');
check('不再占用 shell.overlay', !registrations.some((entry) => entry.options?.name === 'shell.overlay'));

const html = renderToString(React.createElement(page.Component, {}));
check('主面板渲染出论文库骨架', html.includes('pd-page') && html.includes('PaperNotes'), html.slice(0, 120));
const iconHtml = renderToString(React.createElement(sidebar.Component, { size: 16 }));
check('侧边栏图标是 16px 描边 svg', iconHtml.includes('viewBox="0 0 16 16"') && iconHtml.includes('currentColor'));

const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
