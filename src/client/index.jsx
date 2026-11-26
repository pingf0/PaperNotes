/**
 * 浏览器半侧的入口。
 *
 * 挂载方式与 DSH 自带的管理页一致（插件管理、任务管理都是这么做的）：
 *   - `main`：一个 keyed 主面板页，占据主内容区；
 *   - `sidebar.panellist`：左侧边栏的一枚图标，点它由侧边栏自己调用 selectPanel 切页。
 * 之前挂的是 `shell.overlay`（右下角浮层），在 macOS 上会跟窗口边角、输入区抢位置，
 * 也不符合宿主其它管理功能的习惯。
 */
import { React, bindReact } from './runtime.js';
import { CSS } from './styles.js';
import { KATEX_CSS } from './tex.js';
import { PaperDesk } from './app.jsx';

/** 样式元素去重标记（同一个页面重复加载插件时只留一份）。 */
const STYLE_MARK = 'dsh-paper-desk/app.css';

/** 主面板 id：`main` 的 key 与侧边栏条目的 id 必须是同一个。 */
const PANEL_ID = 'paper-desk';

/** 侧边栏图标尺寸与宿主其它图标一致。 */
const DEFAULT_ICON_SIZE = 16;

/**
 * 挂上样式表，返回卸载函数。
 * @returns {() => void}
 */
function registerStyle() {
  const existing = document.querySelector(`style[data-plugin-css="${STYLE_MARK}"]`);
  if (existing) return () => {};
  const style = document.createElement('style');
  style.dataset.plugin = 'dsh-paper-desk';
  style.dataset.pluginCss = STYLE_MARK;
  style.textContent = CSS + '\n' + KATEX_CSS;
  document.head.appendChild(style);
  return () => style.remove();
}

/**
 * 主面板页组件（稳定引用，避免每次渲染换组件类型）。
 * @returns {object} React 元素
 */
function PaperDeskPage() {
  return React.createElement(PaperDesk, { registerStyle });
}

/**
 * 左侧边栏的入口图标：一页纸 + 一个挂上去的节点。
 * 用 currentColor 描边，选中/悬停的颜色由侧边栏控制。
 * @param {{ size?: number }} props 侧边栏给的尺寸
 * @returns {object} React 元素
 */
function PanelIcon({ size = DEFAULT_ICON_SIZE }) {
  return React.createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      style: { display: 'block' },
    },
    React.createElement('rect', { x: 2.4, y: 2.2, width: 8.2, height: 10.4, rx: 1.7 }),
    React.createElement('path', { d: 'M4.7 5.3h3.6M4.7 7.7h2.3' }),
    React.createElement('circle', { cx: 11.8, cy: 10.6, r: 1.6 }),
    React.createElement('path', { d: 'M9.4 6.6 10.9 9.3' }),
  );
}

window.__ModuleLoader__.load({
  id: 'dsh-paper-desk',
  factory(require) {
    bindReact(require('react'));
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(
          () =>
            ctx.slots.inject('main', () =>
              ctx.slots.register({ name: 'main', key: PANEL_ID, order: 40 }, PaperDeskPage),
            ),
          'dsh-paper-desk: main page',
        );
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register(
                { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => 'PaperNotes' },
                PanelIcon,
              ),
            ),
          'dsh-paper-desk: sidebar entry',
        );
      },
    };
  },
});
