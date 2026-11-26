/**
 * 通用小件：图标、弹窗、markdown 渲染、图片放大。
 * 自绘而不复用宿主组件（插件不允许运行时 import 其它 Client 包），样式跟着主题变量走。
 */
import { React, renderMarkdown } from './runtime.js';
import { katexHtml, stripDelimiters } from './tex.js';

/** 图标路径表（16x16 视框、1.6 描边）。 */
const PATHS = {
  plus: 'M8 3.5v9M3.5 8h9',
  close: 'M4 4l8 8M12 4l-8 8',
  back: 'M9.5 3.5 5 8l4.5 4.5',
  trash: 'M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 8h5l.5-8',
  pencil: 'M3.5 12.5l.5-2.5 6-6 2 2-6 6-2.5.5z',
  // 设置：两条滑轨 + 滑块（比"太阳"更像设置，不会看成亮度调节）
  gear: 'M2.4 5.2h11.2M2.4 10.8h11.2M6.2 5.2a1.5 1.5 0 1 0 0 .001M10.2 10.8a1.5 1.5 0 1 0 0 .001',
  compare: 'M2.5 3.5h4v9h-4zM9.5 3.5h4v9h-4z',
  layers: 'M8 2.5 2.5 5.5 8 8.5l5.5-3zM2.5 9 8 12l5.5-3',
  note: 'M3.5 2.5h9v11h-9zM5.5 6h5M5.5 9h5',
  spark: 'M8 2.5 9.3 6.4l3.9 1.3-3.9 1.3L8 13l-1.3-4-3.9-1.3 3.9-1.3z',
  chat: 'M3 3.5h10v7H8l-3 2.5V10.5H3z',
  open: 'M6 3.5H3.5v9h9V10M9 3.5h3.5V7M12.5 3.5 7.5 8.5',
  send: 'M8 12.5V3.5M3.8 7.7 8 3.5l4.2 4.2',
  copy: 'M6 3.5h6.5V10M3.5 6h6.5v6.5H3.5z',
  check: 'M3.5 8.5 6.5 11.5 12.5 4.5',
  // 面板伸缩：圆角方块 + 中间竖线
  panel: 'M3 4.2c0-.66.54-1.2 1.2-1.2h7.6c.66 0 1.2.54 1.2 1.2v7.6c0 .66-.54 1.2-1.2 1.2H4.2c-.66 0-1.2-.54-1.2-1.2zM8 3.2v9.6',
};

/**
 * 小图标。
 * @param {{ name: string, size?: number }} props
 */
export function Icon({ name, size = 14 }) {
  return React.createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      style: { flex: 'none' },
    },
    React.createElement('path', { d: PATHS[name] ?? PATHS.layers }),
  );
}

/** 生成转圈。 */
export function Spinner() {
  return React.createElement('span', { className: 'pd-spinner', 'aria-label': '加载中' });
}

/**
 * 通用弹窗：点遮罩或 Esc 关闭。
 * @param {{ title: string, onClose: () => void, children: any, footer?: any, width?: number }} props
 */
export function Modal({ title, onClose, children, footer }) {
  const { useEffect } = React;
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return React.createElement(
    'div',
    {
      className: 'pd-modal-mask',
      onMouseDown: (event) => {
        if (event.target === event.currentTarget) onClose();
      },
    },
    React.createElement(
      'div',
      { className: 'pd-modal', role: 'dialog', 'aria-label': title },
      React.createElement('div', { className: 'pd-modal-head' }, title),
      React.createElement('div', { className: 'pd-modal-body' }, children),
      footer ? React.createElement('div', { className: 'pd-modal-foot' }, footer) : null,
    ),
  );
}

/**
 * 下拉选择：自绘菜单（原生 <select> 的弹层和插件风格不搭）。
 *
 * @param {{
 *   value: string,
 *   groups: Array<{ label?: string, items: Array<{ value: string, label: string }> }>,
 *   onChange: (value: string) => void,
 *   title?: string,
 *   className?: string,
 * }} props
 */
export function Dropdown({ value, groups, onChange, title, className }) {
  const { useEffect, useRef, useState } = React;
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const flat = groups.flatMap((group) => group.items);
  const current = flat.find((item) => item.value === value);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return React.createElement(
    'div',
    { className: `pd-dropdown${className ? ` ${className}` : ''}`, ref: rootRef },
    React.createElement(
      'button',
      {
        className: 'pd-dropdown-trigger',
        title,
        onClick: () => setOpen((value2) => !value2),
        'aria-haspopup': 'listbox',
        'aria-expanded': open,
      },
      React.createElement('span', { className: 'pd-dropdown-label' }, current?.label ?? '选择'),
      React.createElement(
        'svg',
        { width: 10, height: 10, viewBox: '0 0 16 16', className: `pd-dropdown-caret${open ? ' is-open' : ''}` },
        React.createElement('path', { d: 'M4 6.5 8 10.5 12 6.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
      ),
    ),
    open
      ? React.createElement(
          'div',
          { className: 'pd-dropdown-menu', role: 'listbox' },
          ...groups.map((group, index) =>
            React.createElement(
              'div',
              { key: `g-${index}`, className: 'pd-dropdown-group' },
              group.label ? React.createElement('div', { className: 'pd-dropdown-group-label' }, group.label) : null,
              ...group.items.map((item) =>
                React.createElement(
                  'button',
                  {
                    key: item.value,
                    className: `pd-dropdown-item${item.value === value ? ' is-active' : ''}`,
                    role: 'option',
                    onClick: () => {
                      onChange(item.value);
                      setOpen(false);
                    },
                  },
                  React.createElement('span', { className: 'pd-dropdown-item-label' }, item.label),
                  item.value === value
                    ? React.createElement(Icon, { name: 'check', size: 11 })
                    : null,
                ),
              ),
            ),
          ),
        )
      : null,
  );
}

/**
 * 输入法（IME）保护：中文等输入法里按 Enter 是"确认候选词"，不该当成"发送"。
 *
 * 三个判据缺一不可：正在组合（composition 事件）、键盘事件自带 isComposing、
 * keyCode 229（部分浏览器/输入法在组合期间只给 229）。另外 Safari 会出现
 * "compositionend 紧跟着 keydown Enter" 的顺序，所以组合结束后的 120ms 内也忽略 Enter。
 * @returns {{ onCompositionStart: Function, onCompositionEnd: Function, isImeEnter: (event: object) => boolean }}
 */
export function useEnterGuard() {
  const { useRef } = React;
  const composing = useRef(false);
  const endedAt = useRef(0);
  return {
    onCompositionStart: () => {
      composing.current = true;
    },
    onCompositionEnd: () => {
      composing.current = false;
      endedAt.current = Date.now();
    },
    isImeEnter: (event) =>
      composing.current === true ||
      event?.nativeEvent?.isComposing === true ||
      event?.isComposing === true ||
      event?.keyCode === 229 ||
      Date.now() - endedAt.current < 120,
  };
}

/**
 * 公式：KaTeX 渲染；渲染不出来时退回等宽原文（至少不丢内容）。
 * @param {{ tex: string, display?: boolean, className?: string }} props
 */
export function Formula({ tex, display = true, className }) {
  const html = katexHtml(stripDelimiters(tex), display);
  const classes = [ 'pd-formula', className ].filter(Boolean).join(' ');
  if (html.length === 0) {
    return React.createElement('div', { className: `${classes} pd-node-latex` }, String(tex ?? ''));
  }
  return React.createElement('div', {
    className: classes,
    dangerouslySetInnerHTML: { __html: html },
  });
}

/**
 * markdown 文本渲染。
 * @param {{ text: string }} props
 */
export function Markdown({ text }) {
  return React.createElement('div', { className: 'pd-md' }, renderMarkdown(text));
}

/**
 * 图片放大层。
 * @param {{ src: string, onClose: () => void }} props
 */
export function Lightbox({ src, onClose }) {
  const { useEffect } = React;
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return React.createElement(
    'div',
    { className: 'pd-lightbox', onClick: onClose },
    React.createElement('img', { src, alt: '放大查看' }),
  );
}
