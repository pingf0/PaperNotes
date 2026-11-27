/**
 * 右侧栏里的原文阅读器：连续上下滚动 + 缩放。
 *
 * 为什么不用系统自带的 PDF 查看器：桌面壳的渲染进程拿不到 file://（沙箱），
 * Chromium 内置 PDF 插件在 Electron 里也不保证可用。所以仍用 pdf.js 画，
 * 但把**渲染倍率**抬到显示尺寸的 2 倍，放大后依然清晰；另外给一个「用系统预览打开」的出口。
 */
import { React } from './runtime.js';
import { api, pdfUrl } from './api.js';
import { loadPdfjs, ensureWorker } from './pdf.js';
import { Icon, Spinner } from './ui.jsx';

/** 渲染倍率：显示尺寸的 2 倍，Retina 上不糊；上限防止超大页吃掉内存。 */
const RENDER_RATIO = 2;
/** 放大上限 / 下限（1 = 适应宽度）。 */
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.25;
/** 视口前后多远开始渲染（像素）。 */
const PRELOAD_MARGIN = '800px';

/**
 * 把缩放钳在允许范围内。
 * @param {number} value
 * @returns {number}
 */
function clampZoom(value) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

/**
 * 按"视觉顺序"把选区里的文字拼回来。
 *
 * 浏览器给的是 DOM 顺序，双栏/上下标混排时会跳来跳去（复制的文本和看到的不一致）。
 * 这里改成：取选区矩形 → 找出与它相交的文本块 → 按先上后下、同一行内从左到右排序 →
 * 相邻两块有明显间隙时补一个空格。
 *
 * @param {Element} wrap .pd-pdf-wrap
 * @param {Range} range 当前选区
 * @returns {string}
 */
function collectSelectionText(wrap, range) {
  // 关键：用 range 的**每一行矩形**，而不是它的大外框。
  // 大外框会把下一行末尾那一点点也框进来（用户看到只选了两行，复制却多出一截）。
  const lineRects = [...range.getClientRects()].filter((rect) => rect.width > 1 && rect.height > 1);
  if (lineRects.length === 0) return '';
  const spans = [...wrap.querySelectorAll('.pd-text-layer span')];
  const hits = [];
  for (const span of spans) {
    const box = span.getBoundingClientRect();
    // 与任意一行矩形有实际重叠才算选中（纵向 2px 容差，横向 1px）
    const overlapped = lineRects.some(
      (rect) =>
        box.bottom > rect.top + 1 &&
        box.top < rect.bottom - 1 &&
        box.right > rect.left - 1 &&
        box.left < rect.right + 1,
    );
    if (!overlapped) continue;
    const text = String(span.textContent ?? '');
    if (text.trim().length === 0) continue;
    hits.push({ box, text, size: box.height });
  }
  if (hits.length === 0) return '';
  // 按视觉顺序：先上后下，同一行内从左到右
  hits.sort((a, b) => (Math.abs(a.box.top - b.box.top) > 4 ? a.box.top - b.box.top : a.box.left - b.box.left));
  let out = '';
  let prev = null;
  for (const hit of hits) {
    if (prev) {
      const sameLine = Math.abs(prev.box.top - hit.box.top) <= 4;
      const gap = hit.box.left - prev.box.right;
      if (!sameLine) out += ' ';
      else if (gap > hit.size * 0.22) out += ' ';
    }
    out += hit.text;
    prev = hit;
  }
  return out.replace(/[\u200b-\u200d\ufeff]/g, '').replace(/[ \t]+/g, ' ').trim();
}


/**
 * 写剪贴板：优先 async clipboard，失败退回隐藏 textarea + execCommand。
 * Electron 里 clipboard API 常被权限挡住，没有兜底就会"看起来复制了但其实没写"。
 * @param {string} text 要复制的文本
 * @returns {Promise<boolean>} 是否成功
 */
async function copyText(text) {
  const value = String(text ?? '');
  if (value.length === 0) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = value;
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * 两个 6 元仿射矩阵相乘（等价 pdf.js 的 Util.transform）。
 * @param {number[]} m1 外层变换
 * @param {number[]} m2 内层变换
 * @returns {number[]} 合成矩阵
 */
function multiplyMatrix(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/**
 * 单页：占位 + 进入视口才渲染，离开就释放位图。
 *
 * 传了 onPickBox 时进入"框选"模式：按住拖出矩形，松开就把这一块裁成高清图交出去。
 * @param {{ doc: object, index: number, ratio: number, width: number }} props
 */
function PdfPage({ doc, index, ratio, width, onPickBox, onSelectText }) {
  const { useEffect, useRef, useState } = React;
  const holderRef = useRef(null);
  const canvasRef = useRef(null);
  const [visible, setVisible] = useState(false);
  const [box, setBox] = useState(null);
  /** 文本层的每一段（透明文字，用于选择 / 复制 / 划词提问）。 */
  const [textSpans, setTextSpans] = useState([]);
  /** 自己算出来的选区（页内 CSS 坐标）：{ x1,y1,x2,y2 } */
  const [drag, setDrag] = useState(null);
  /** 被选中的文字块索引（用于画高亮） */
  const [picked, setPicked] = useState([]);
  /** 'pending' | 'ok' | 'empty' | 'failed'：用来提示"这页没有可选文字" */
  const [textState, setTextState] = useState('pending');
  const dragRef = useRef(null);

  /**
   * 把框选区域**重新按高分辨率渲染**出来。
   *
   * 不能直接从屏幕画布上裁：那张画布只有"显示宽度 × 2"，框 160px 宽的区域裁出来只有 320px，
   * 糊得没法看。这里改为按 PDF 原始坐标重新渲染一块，倍率 3x（最大 2600px）。
   * @param {{x:number,y:number,w:number,h:number}} rect 相对页面左上角的 CSS 像素
   */
  const commitBox = async (rect) => {
    const holder = holderRef.current;
    if (!holder || !rect || rect.w < 12 || rect.h < 12) return;
    const displayedWidth = holder.getBoundingClientRect().width;
    try {
      const page = await doc.getPage(index + 1);
      const base = page.getViewport({ scale: 1 });
      // CSS 像素 → PDF 用户单位
      const unit = base.width / displayedWidth;
      const pdfX = rect.x * unit;
      const pdfY = rect.y * unit;
      const pdfW = Math.max(1, rect.w * unit);
      const pdfH = Math.max(1, rect.h * unit);
      const scale = Math.min(3, Math.max(1.5, 2600 / Math.max(pdfW, pdfH)));
      const viewport = page.getViewport({ scale });
      const crop = document.createElement('canvas');
      crop.width = Math.round(pdfW * scale);
      crop.height = Math.round(pdfH * scale);
      const ctx = crop.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, crop.width, crop.height);
      await page.render({
        canvasContext: ctx,
        viewport,
        // 把目标区域平移到画布左上角
        transform: [1, 0, 0, 1, -pdfX * scale, -pdfY * scale],
      }).promise;
      onPickBox?.(crop.toDataURL('image/png'));
    } catch (error) {
      onPickBox?.(null, error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setVisible(entry.isIntersecting);
      },
      { root: holder.closest('.pd-pdf-scroll'), rootMargin: `${PRELOAD_MARGIN} 0px` },
    );
    observer.observe(holder);
    return () => observer.disconnect();
  }, []);


  /** 文本层单独建：和画布渲染互不依赖，画布失败也还能选字。 */
  useEffect(() => {
    const holder = holderRef.current;
    if (!holder || !doc || width === 0 || !visible) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const page = await doc.getPage(index + 1);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        // 用 CSS 尺寸的视口算坐标（渲染画布是 2 倍像素，直接拿它的坐标会整体翻倍）
        const cssViewport = page.getViewport({ scale: width / base.width });
        const textContent = await page.getTextContent();
        if (cancelled) return;
        const spans = [];
        textContent.items.forEach((item, itemIndex) => {
          if (!item.str || item.str.trim().length === 0) return;
          const tr = multiplyMatrix(cssViewport.transform, item.transform);
          const fontSize = Math.max(1, Math.hypot(tr[2], tr[3]) || item.height * cssViewport.scale);
          const left = tr[4];
          const top = tr[5] - fontSize;
          const spanWidth = Math.max(1, item.width * cssViewport.scale);
          spans.push({
            key: itemIndex,
            text: item.str,
            left,
            top,
            width: spanWidth,
            height: fontSize * 1.18,
            style: {
              left: `${left.toFixed(2)}px`,
              top: `${top.toFixed(2)}px`,
              width: `${spanWidth.toFixed(2)}px`,
              height: `${(fontSize * 1.18).toFixed(2)}px`,
              fontSize: `${fontSize.toFixed(2)}px`,
              lineHeight: `${(fontSize * 1.18).toFixed(2)}px`,
            },
          });
        });
        setTextSpans(spans);
        setTextState(spans.length > 0 ? 'ok' : 'empty');
      } catch {
        if (!cancelled) setTextState('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, index, visible, width]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !doc || width === 0) return undefined;
    if (!visible) {
      canvas.width = 0;
      canvas.height = 0;
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const page = await doc.getPage(index + 1);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        // 显示宽度 × 2 倍像素，放大后仍然清晰；超过 2600px 就封顶
        const target = Math.min(2600, width * RENDER_RATIO);
        const viewport = page.getViewport({ scale: target / base.width });
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: context, viewport }).promise;
      } catch {
        /* 单页失败不影响其它页 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, index, visible, width]);

  return React.createElement(
    'div',
    {
      ref: holderRef,
      className: `pd-pdf-page${onPickBox ? ' is-picking' : ''}`,
      'data-text-spans': textSpans.length,
      style: { width, height: Math.max(40, Math.round(width * ratio)) },
      onMouseDown: (event) => {
        if (!onPickBox && event.button === 0 && textSpans.length > 0) {
          // 自己实现选择：不依赖浏览器的 user-select（Electron 缩放/自定义 CSS 下它经常不工作）
          event.preventDefault();
          const holder = holderRef.current;
          const bounds = holder.getBoundingClientRect();
          const scale = bounds.width / Math.max(1, width);
          const local = {
            x: Math.min(Math.max(0, (event.clientX - bounds.left) / scale), width),
            y: Math.min(Math.max(0, (event.clientY - bounds.top) / scale), bounds.height / scale),
          };
          const current = { x1: local.x, y1: local.y, x2: local.x, y2: local.y };
          setDrag(current);
          setPicked([]);
          const onMove = (move) => {
            const x = Math.min(Math.max(0, (move.clientX - bounds.left) / scale), width);
            const y = Math.min(Math.max(0, (move.clientY - bounds.top) / scale), bounds.height / scale);
            current.x2 = x;
            current.y2 = y;
            setDrag({ ...current });
          };
          const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            setDrag(null);
            const rect = {
              left: Math.min(current.x1, current.x2),
              right: Math.max(current.x1, current.x2),
              top: Math.min(current.y1, current.y2),
              bottom: Math.max(current.y1, current.y2),
            };
            // 点一下（没拖动）就选中这一点所在的文字块
            const thin = rect.right - rect.left < 3 && rect.bottom - rect.top < 3;
            const hits = textSpans
              .map((span, position) => ({ span, position }))
              .filter(({ span }) => {
                if (thin) {
                  return (
                    span.left <= current.x1 &&
                    span.left + span.width >= current.x1 &&
                    span.top <= current.y1 &&
                    span.top + span.height >= current.y1
                  );
                }
                return (
                  span.left < rect.right &&
                  span.left + span.width > rect.left &&
                  span.top < rect.bottom &&
                  span.top + span.height > rect.top
                );
              })
              .map(({ span }) => span);
            if (hits.length === 0) {
              setPicked([]);
              onSelectText?.(null);
              return;
            }
            // 按视觉顺序拼文本：先上后下、行内从左到右
            const sorted = hits.slice().sort((a, b) => (Math.abs(a.top - b.top) > 4 ? a.top - b.top : a.left - b.left));
            let text = '';
            let prev = null;
            for (const hit of sorted) {
              if (prev) {
                const sameLine = Math.abs(prev.top - hit.top) <= 4;
                const gap = hit.left - (prev.left + prev.width);
                if (!sameLine) text += ' ';
                else if (gap > hit.height * 0.22) text += ' ';
              }
              text += hit.text;
              prev = hit;
            }
            setPicked(sorted);
            const first = sorted[0];
            onSelectText?.({
              text: text.replace(/[\u200b-\u200d\ufeff]/g, '').replace(/[ \t]+/g, ' ').trim(),
              x: bounds.left + (first.left + first.width / 2) * scale,
              y: bounds.top + first.top * scale - 8,
            });
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp, { once: true });
          return;
        }
        if (!onPickBox || event.button !== 0) return;
        event.preventDefault();
        const holder = holderRef.current;
        const bounds = holder.getBoundingClientRect();
        const clamp = (value, max) => Math.min(Math.max(0, value), max);
        const start = {
          x: clamp(event.clientX - bounds.left, bounds.width),
          y: clamp(event.clientY - bounds.top, bounds.height),
        };
        const current = { x: start.x, y: start.y, w: 0, h: 0 };
        setBox(current);
        // 监听挂在 window 上：拖出页面边界也不会中断（否则选框一出手就没了）
        const onMove = (move) => {
          const x = clamp(move.clientX - bounds.left, bounds.width);
          const y = clamp(move.clientY - bounds.top, bounds.height);
          Object.assign(current, {
            x: Math.min(start.x, x),
            y: Math.min(start.y, y),
            w: Math.abs(x - start.x),
            h: Math.abs(y - start.y),
          });
          setBox({ ...current });
        };
        const onUp = () => {
          window.removeEventListener('mousemove', onMove);
          setBox(null);
          void commitBox({ ...current });
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp, { once: true });
      },
    },
    React.createElement('canvas', { ref: canvasRef, className: 'pd-pdf-canvas' }),
    textState === 'empty' || textState === 'failed'
      ? React.createElement(
          'div',
          { className: 'pd-text-missing' },
          textState === 'failed' ? '这一页的文字层加载失败' : '这一页没有可选文字（可能是扫描件）',
        )
      : null,
    textSpans.length > 0
      ? React.createElement(
          'div',
          { className: 'pd-text-layer', 'aria-hidden': 'true' },
          ...textSpans.map((span) => React.createElement('span', { key: span.key, style: span.style }, span.text)),
        )
      : null,
    picked.length > 0
      ? React.createElement(
          'div',
          { className: 'pd-pick-layer' },
          ...picked.map((span, position) =>
            React.createElement('span', {
              key: `pick-${position}`,
              className: 'pd-pick-box',
              style: {
                left: `${span.left}px`,
                top: `${span.top}px`,
                width: `${span.width}px`,
                height: `${span.height}px`,
              },
            }),
          ),
        )
      : null,
    drag
      ? React.createElement('div', {
          className: 'pd-drag-box',
          style: {
            left: `${Math.min(drag.x1, drag.x2)}px`,
            top: `${Math.min(drag.y1, drag.y2)}px`,
            width: `${Math.abs(drag.x2 - drag.x1)}px`,
            height: `${Math.abs(drag.y2 - drag.y1)}px`,
          },
        })
      : null,
    box
      ? React.createElement('div', {
          className: 'pd-pdf-box',
          style: { left: box.x, top: box.y, width: box.w, height: box.h },
        })
      : null,
  );
}

/**
 * 连续的 PDF 阅读面板（放在右侧栏里）。
 * @param {{ paperId: string }} props
 */
export function PdfPanel({ paperId, view, onViewChange, picking = false, onPickBox, onTogglePicking, onAskSelection }) {
  const { useEffect, useRef, useState } = React;
  const [doc, setDoc] = useState(null);
  const [count, setCount] = useState(0);
  const [ratio, setRatio] = useState(1.294);
  const [baseWidth, setBaseWidth] = useState(0);
  const [zoom, setZoom] = useState(() => (typeof view?.zoom === 'number' ? view.zoom : 1));
  /**
   * 已提交的缩放：页面按它渲染位图。连续缩放时先用 CSS `zoom` 拉伸（几乎零成本），
   * 停手 180ms 后再真正重渲染 —— 这是"卡顿"的主要原因。
   */
  const [committedZoom, setCommittedZoom] = useState(() => (typeof view?.zoom === 'number' ? view.zoom : 1));
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef(null);
  /** 划词结果：{ text, x, y }（相对 .pd-pdf-wrap） */
  const [selection, setSelection] = useState(null);
  const zoomRef = useRef(typeof view?.zoom === 'number' ? view.zoom : 1);
  const frameRef = useRef(0);

  /** 载入 PDF。 */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        ensureWorker(pdfjs);
        const response = await fetch(pdfUrl(paperId));
        if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const loaded = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
        const first = await loaded.getPage(1);
        const viewport = first.getViewport({ scale: 1 });
        if (!alive) return;
        setDoc(loaded);
        setCount(loaded.numPages);
        setRatio(viewport.height / viewport.width);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [paperId]);

  /** 页面上选中文字后：把坐标换成相对 .pd-pdf-wrap 的位置，弹出工具条。 */
  const handleSelectText = (payload) => {
    if (!payload) {
      setSelection(null);
      return;
    }
    const wrap = scrollRef.current?.closest('.pd-pdf-wrap');
    const wrapBox = wrap?.getBoundingClientRect();
    if (!wrapBox) return;
    const half = 92;
    const desired = payload.x - wrapBox.left;
    setSelection({
      text: payload.text,
      x: Math.min(Math.max(half, desired), Math.max(half, wrapBox.width - half)),
      y: Math.max(8, payload.y - wrapBox.top),
    });
  };

  /** 跟踪容器宽度（右侧栏可拖宽）。 */
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return undefined;
    const measure = () => {
      const next = Math.max(120, element.clientWidth - 24);
      setBaseWidth((current) => (Math.abs(current - next) > 2 ? next : current));
    };
    measure();
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(measure);
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frameRef.current);
      observer.disconnect();
    };
  }, []);

  zoomRef.current = zoom;

  /**
   * 以指针位置为锚缩放：缩放前后指针下面的那一点保持不动。
   * @param {number} nextZoom 目标缩放
   * @param {{x:number,y:number}} [anchor] 视口内的锚点
   */
  const zoomAt = (nextZoom, anchor) => {
    const element = scrollRef.current;
    const clamped = clampZoom(nextZoom);
    if (!element || Math.abs(clamped - zoomRef.current) < 0.001) return;
    const rect = element.getBoundingClientRect();
    const anchorX = anchor?.x ?? rect.width / 2;
    const anchorY = anchor?.y ?? rect.height / 2;
    const contentX = element.scrollLeft + anchorX;
    const contentY = element.scrollTop + anchorY;
    const factor = clamped / zoomRef.current;
    zoomRef.current = clamped;
    setZoom(clamped);
    requestAnimationFrame(() => {
      element.scrollLeft = contentX * factor - anchorX;
      element.scrollTop = contentY * factor - anchorY;
    });
  };

  /** Cmd/Ctrl + 滚轮或触控板捏合 → 以指针为锚缩放。 */
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return undefined;
    const onWheel = (event) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      zoomAt(zoomRef.current * Math.exp(-event.deltaY * 0.0025), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  /** 缩放停手后再提交：期间只做 CSS 拉伸。 */
  useEffect(() => {
    if (Math.abs(zoom - committedZoom) < 0.001) return undefined;
    const timer = window.setTimeout(() => setCommittedZoom(zoom), 180);
    return () => window.clearTimeout(timer);
  }, [zoom, committedZoom]);

  /** 缩放变了也存一次（滚动时才存的话，只缩放不滚动会丢）。 */
  useEffect(() => {
    if (!onViewChange) return;
    onViewChange({ zoom: committedZoom, page: 1 });
    // page 由滚动那次覆盖，这里只保证 zoom 落盘
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committedZoom]);

  /** 视图状态（缩放 + 看到第几页）随论文存盘。 */
  const viewSaveTimer = useRef(0);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !onViewChange) return undefined;
    const save = () => {
      const pages = [...element.querySelectorAll('.pd-pdf-page')];
      const top = element.getBoundingClientRect().top + 8;
      let current = 1;
      pages.forEach((page, index) => {
        if (page.getBoundingClientRect().top <= top) current = index + 1;
      });
      onViewChange({ zoom: committedZoom, page: current });
    };
    const onScroll = () => {
      window.clearTimeout(viewSaveTimer.current);
      viewSaveTimer.current = window.setTimeout(save, 500);
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      element.removeEventListener('scroll', onScroll);
      window.clearTimeout(viewSaveTimer.current);
    };
  }, [onViewChange, committedZoom]);

  /** 打开时恢复上次看到的那一页。 */
  const restoredRef = useRef(false);
  useEffect(() => {
    const element = scrollRef.current;
    if (restoredRef.current || !element || !count || !view?.page) return;
    restoredRef.current = true;
    const target = element.querySelectorAll('.pd-pdf-page')[view.page - 1];
    if (target) element.scrollTop = target.offsetTop - 8;
  }, [count, view?.page]);

  /** 交给系统默认阅读器（原生渲染，最清晰）。 */
  const openExternally = async () => {
    setNote('');
    try {
      await api.openPdfExternally(paperId);
      setNote('已交给系统默认阅读器打开');
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };

  const contentWidth = Math.round(baseWidth * committedZoom);
  /** 连续缩放时的临时拉伸倍数（CSS zoom，Chromium 支持，不触发重排上面板级重渲染）。 */
  const liveScale = committedZoom > 0 ? zoom / committedZoom : 1;

  /** 划词后的小工具条：带去会话提问，或复制原文。 */
  const selectionBar = selection
    ? React.createElement(
        'div',
        {
          className: 'pd-selection-pop',
          style: { left: selection.x, top: selection.y, transform: 'translateX(-50%)' },
        },
        React.createElement(
          'div',
          { className: 'pd-selection-preview' },
          selection.text.length > 160 ? `${selection.text.slice(0, 160)}…` : selection.text,
        ),
        React.createElement(
          'div',
          { className: 'pd-selection-actions' },
          React.createElement(
            'button',
            {
              className: 'pd-btn pd-btn-sm pd-btn-primary',
              onClick: () => {
                onAskSelection?.(selection.text);
                setSelection(null);
              },
            },
            '问这段',
          ),
          React.createElement(
            'button',
            {
              className: 'pd-btn pd-btn-sm',
              onClick: async () => {
                try {
                  await navigator.clipboard.writeText(selection.text);
                } catch {
                  /* 忽略 */
                }
                setSelection(null);
              },
            },
            '复制',
          ),
          React.createElement(
            'button',
            { className: 'pd-btn pd-btn-sm pd-btn-ghost', onClick: () => setSelection(null) },
            '关闭',
          ),
        ),
      )
    : null;

  return React.createElement(
    'div',
    { className: 'pd-pdf-wrap' },
    selectionBar,
    React.createElement(
      'div',
      { className: 'pd-pdf-tools' },
      React.createElement('button', { className: 'pd-btn pd-btn-sm pd-btn-ghost', onClick: () => zoomAt(zoomRef.current / ZOOM_STEP), title: '缩小（Cmd/Ctrl + 滚轮也可以）' }, '−'),
      React.createElement('button', { className: 'pd-btn pd-btn-sm pd-btn-ghost pd-zoom-value', onClick: () => zoomAt(1), title: '适应宽度' }, `${Math.round(zoom * 100)}%`),
      React.createElement('button', { className: 'pd-btn pd-btn-sm pd-btn-ghost', onClick: () => zoomAt(zoomRef.current * ZOOM_STEP), title: '放大' }, '+'),
      React.createElement(
        'button',
        {
          className: `pd-btn pd-btn-sm${picking ? ' pd-btn-primary' : ''}`,
          onClick: onTogglePicking,
          title: '在页面上拖一个矩形，把这一块裁下来挂到当前节点',
        },
        picking ? '框选中…' : '框选配图',
      ),
      React.createElement('div', { className: 'pd-grow' }),
      React.createElement('button', { className: 'pd-btn pd-btn-sm pd-btn-ghost', onClick: openExternally, title: '用系统默认阅读器打开（原生渲染，最清晰）' }, React.createElement(Icon, { name: 'open', size: 12 }), '系统预览'),
    ),
    note ? React.createElement('div', { className: 'pd-pdf-note' }, note) : null,
    React.createElement(
      'div',
      { className: 'pd-pdf-scroll', ref: scrollRef },
      loading
        ? React.createElement('div', { className: 'pd-empty' }, React.createElement(Spinner), ' 正在读取原文…')
        : error
          ? React.createElement('div', { className: 'pd-empty' }, error)
          : React.createElement(
              'div',
              {
                className: 'pd-pdf-pages',
                // 连续缩放时先整体 CSS 拉伸（位图不重绘），停手后再按新宽度重渲染
                style: { zoom: liveScale !== 1 ? liveScale : undefined },
              },
              ...Array.from({ length: count }, (_unused, index) =>
                React.createElement(PdfPage, {
                  key: index,
                  doc,
                  index,
                  ratio,
                  width: contentWidth,
                  onPickBox: picking ? onPickBox : undefined,
                  onSelectText: handleSelectText,
                }),
              ),
            ),
    ),
  );
}
