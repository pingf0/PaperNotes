/**
 * 单篇论文的画布：节点拖拽、节点间连线、画布平移，右侧挂会话/笔记/core 抽屉。
 *
 * 坐标系：节点坐标存在 block.x / block.y（画布内绝对坐标），画布整体用 translate 平移，
 * 所以拖节点只需改 x/y，平移只改 layout.panX/panY——两者互不干扰，也方便直接存盘。
 */
import { React } from './runtime.js';
import { api, assetUrl } from './api.js';
import { figureLabel } from './figure-meta.js';
import { Drawer } from './drawer.jsx';
import { Formula, Icon, Lightbox, Markdown, Modal, Spinner } from './ui.jsx';

/** 画布缩放范围与步进。 */
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 1.15;
/** 适应窗口时四周留白（像素）。 */
const FIT_PADDING = 40;

/**
 * 判断这次 wheel 是不是触控板双指滑动。
 * 触控板是像素模式、单次增量很小、常带横向分量；鼠标滚轮一档通常 ≥40。
 * 捏合会带 ctrlKey，先被上层截走，不会走到这里。
 * @param {WheelEvent} event
 * @returns {boolean}
 */
function isTrackpadScroll(event) {
  // 触控板的小增量常常带小数（3.5、12.25），鼠标滚轮基本都是整数 40/100/120。
  // 一次快速甩动可能超过 25，所以"非整数"也判成触控板，避免甩到一半突然变成缩放。
  const fractional = !Number.isInteger(event.deltaY) || !Number.isInteger(event.deltaX);
  return event.deltaMode === 0 && (fractional || Math.abs(event.deltaY) < 25) && Math.abs(event.deltaX) < 25;
}

/**
 * 把缩放钳在允许范围内。
 * @param {number} value 目标缩放
 * @returns {number} 钳制后的缩放
 */
function clampZoom(value) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

/** 节点类型 → 左边条颜色与中文名。 */
const TYPE_STYLE = {
  motivation: { color: '#d97706', label: '动机' },
  principle: { color: '#2f6fd0', label: '原理' },
  formula: { color: '#7c3aed', label: '公式' },
  result: { color: '#0f9d70', label: '结果' },
  question: { color: '#7c3aed', label: '问题' },
  background: { color: '#64748b', label: '背景' },
  method: { color: '#b45309', label: '步骤' },
  phenomenon: { color: '#0e7490', label: '现象' },
  conclusion: { color: '#15803d', label: '结论' },
  note: { color: '#64748b', label: '笔记' },
  custom: { color: '#64748b', label: '节点' },
};

/**
 * 算一条连线的路径。
 * 目标在右侧 → 从右边缘中点拉一条横向 S 曲线；否则（在下方或左侧）→ 从底边中点拉竖向 S，
 * 避免横向 S 在反向时绕出一个大回环。
 * @param {object} from 源节点
 * @param {object} to 目标节点
 * @param {object} metrics 节点实测尺寸
 */
/**
 * 按连线把节点排成"从左到右"的流程图：同一深度的节点放一列，列内纵向堆叠。
 *
 * 自动生成的图经常从原理节点像刺猬一样向外发散；按 BFS 深度分列之后，
 * "动机 → 背景 → 原理 → 问题 → 方法 → 实验 → 结论" 这条主线就一目了然了。
 *
 * @param {Array} blocks 节点
 * @param {Array} edges 连线
 * @param {Record<string, {w:number,h:number}>} metrics 实测尺寸（没有就用默认值）
 * @returns {Array} 新节点数组（坐标已改写）
 */
function flowLayout(blocks, edges, metrics) {
  const ids = new Set(blocks.map((block) => block.id));
  const children = new Map();
  const indegree = new Map(blocks.map((block) => [block.id, 0]));
  for (const edge of edges ?? []) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
    children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to]);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const depth = new Map();
  const queue = blocks.filter((block) => (indegree.get(block.id) ?? 0) === 0).map((block) => block.id);
  for (const id of queue) depth.set(id, 0);
  while (queue.length > 0) {
    const id = queue.shift();
    for (const next of children.get(id) ?? []) {
      if (depth.has(next)) continue;
      depth.set(next, (depth.get(id) ?? 0) + 1);
      queue.push(next);
    }
  }
  const maxDepth = Math.max(0, ...[...depth.values()]);
  for (const block of blocks) {
    if (depth.has(block.id)) continue;
    depth.set(block.id, Math.max(0, Math.min(maxDepth, Math.round((block.x ?? 0) / 360))));
  }

  const columns = new Map();
  for (const block of blocks) {
    const column = depth.get(block.id) ?? 0;
    columns.set(column, [...(columns.get(column) ?? []), block]);
  }
  const COL_W = 380;
  const ROW_GAP = 36;
  const placed = [];
  for (const [column, list] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    let y = 32;
    const sorted = list.slice().sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));
    for (const block of sorted) {
      const size = metrics[block.id] ?? { w: block.w ?? 300, h: block.figureId ? 360 : 220 };
      placed.push({ ...block, x: 40 + column * COL_W, y });
      y += size.h + ROW_GAP;
    }
  }
  return placed;
}

function edgePath(from, to, metrics) {
  const fromMetric = metrics[from.id] ?? { w: from.w ?? 300, h: 120 };
  const toMetric = metrics[to.id] ?? { w: to.w ?? 300, h: 120 };
  const fromX = from.x ?? 0;
  const fromY = from.y ?? 0;
  const toX = to.x ?? 0;
  const toY = to.y ?? 0;
  if (toX >= fromX + fromMetric.w - 12) {
    const x1 = fromX + fromMetric.w;
    const y1 = fromY + 26;
    const x2 = toX;
    const y2 = toY + 26;
    const bend = Math.max(36, Math.abs(x2 - x1) / 2);
    return `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
  }
  const x1 = fromX + fromMetric.w / 2;
  const y1 = fromY + fromMetric.h;
  const x2 = toX + toMetric.w / 2;
  const y2 = toY - 8;
  const bend = Math.max(30, Math.abs(y2 - y1) / 2);
  return `M${x1},${y1} C${x1},${y1 + bend} ${x2},${y2 - bend} ${x2},${y2}`;
}

/**
 * 单篇论文工作台。
 * @param {{ paperId: string, onClose: () => void, onChanged: () => void }} props
 */
export function PaperView({ paperId, onClose, onChanged }) {
  const { useCallback, useEffect, useMemo, useRef, useState } = React;
  const [paper, setPaper] = useState(null);
  const [error, setError] = useState('');
  const [selectedBlock, setSelectedBlock] = useState(null);
  const [tab, setTab] = useState('chat');
  const [editing, setEditing] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  /** 打开原文：展开右侧栏并切到「原文」页签（不另开窗口）。 */
  const openPdf = () => {
    drawerOpenRef.current = true;
    setDrawerOpen(true);
    setTab('pdf');
    persistView();
  };
  const [metrics, setMetrics] = useState({});
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  /** 滚轮/两指行为：auto（按事件特征判断）/ zoom（总是缩放）/ pan（总是平移）。 */
  const [wheelMode, setWheelMode] = useState('auto');
  /** 右侧栏宽度与是否展开（都按论文存进 layout）。 */
  const [drawerW, setDrawerW] = useState(372);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [resizing, setResizing] = useState(null);
  const drawerWRef = useRef(372);
  /** 本次按下是否已经拖动过（用于区分"点一下"和"拖一下"）。 */
  const dragMoved = useRef(false);
  /** 上次拖拽结束的时间：拖完紧跟的那一次 click 要忽略，但之后正常的点击必须照常生效。 */
  const dragEndedAt = useRef(0);
  const drawerOpenRef = useRef(true);
  const [dragging, setDragging] = useState(null);
  /** 正在拖某个节点的尺寸把手：{ id, dir, startX, startY, startW, startH } */
  const [nodeResize, setNodeResize] = useState(null);
  const [pendingEdge, setPendingEdge] = useState(null);
  const [panning, setPanning] = useState(null);
  const canvasRef = useRef(null);
  const paperRef = useRef(null);
  const saveTimer = useRef(null);
  const panRef = useRef({ x: 0, y: 0 });

  /** 读论文。 */
  useEffect(() => {
    let alive = true;
    api
      .getPaper(paperId)
      .then((result) => {
        if (!alive) return;
        setPaper(result.paper);
        paperRef.current = result.paper;
        const layout = result.paper.layout ?? {};
        setPan({ x: layout.panX ?? 0, y: layout.panY ?? 0 });
        panRef.current = { x: layout.panX ?? 0, y: layout.panY ?? 0 };
        setZoom(typeof layout.zoom === 'number' ? layout.zoom : 1);
        zoomRef.current = typeof layout.zoom === 'number' ? layout.zoom : 1;
        setWheelMode(layout.wheel === 'zoom' || layout.wheel === 'pan' ? layout.wheel : 'auto');
        const width = typeof layout.drawerW === 'number' ? Math.min(760, Math.max(300, layout.drawerW)) : 372;
        setDrawerW(width);
        drawerWRef.current = width;
        setDrawerOpen(layout.drawerOpen !== false);
        drawerOpenRef.current = layout.drawerOpen !== false;
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [paperId]);

  /** 本地状态 + 落盘（防抖 400ms）。 */
  const update = useCallback(
    (patch, immediate = false) => {
      const next = { ...paperRef.current, ...patch };
      paperRef.current = next;
      setPaper(next);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const flush = () => {
        api.patchPaper(paperId, patch).catch((e) => setError(e instanceof Error ? e.message : String(e)));
        if (onChanged) onChanged();
      };
      if (immediate) flush();
      else saveTimer.current = setTimeout(flush, 400);
    },
    [paperId, onChanged],
  );

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, []);

  /** 按连线把节点重排成流程图；保留一次撤销。 */
  const tidyLayout = () => {
    const previous = paperRef.current.blocks ?? [];
    const next = flowLayout(previous, paperRef.current.edges ?? [], metrics);
    update({ blocks: next }, true);
    setLayoutUndo(previous);
    window.setTimeout(() => setLayoutUndo((current) => (current === previous ? null : current)), 10_000);
  };

  /** 把当前视图（平移 + 缩放）落盘。 */
  /** 重新分析：用已存的全文重跑结构化，换节点但把笔记与会话迁过去。 */
  const [reanalyzing, setReanalyzing] = useState(false);
  const reanalyze = async () => {
    if (reanalyzing) return;
    if (
      !window.confirm(
        '用已存的全文重新拆一遍节点？\n笔记和会话会按标题迁到新节点上；手动加的节点和它们的连线会被清掉。',
      )
    ) {
      return;
    }
    setReanalyzing(true);
    setNotice(null);
    try {
      const result = await api.reanalyze(paperId);
      const fresh = await api.getPaper(paperId);
      paperRef.current = fresh.paper;
      setPaper(fresh.paper);
      setSelectedBlock(null);
      setNotice({
        ok: true,
        text: `已重新分析：${result.blocks} 个节点，迁移 ${result.movedNotes ?? 0} 条笔记、${result.movedChats ?? 0} 段会话`,
      });
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setReanalyzing(false);
    }
  };

  /** 换图/重分析后 +1，让 <img> 的 URL 变化（否则浏览器会复用旧的位图）。 */
  const [assetVersion, setAssetVersion] = useState(0);
  /** 工具栏下方的一次性提示（重新分析成功/失败都走它）。 */
  const [notice, setNotice] = useState(null);
  /** 重排布局后给一次撤销机会。 */
  const [layoutUndo, setLayoutUndo] = useState(null);

  const persistView = useCallback(() => {
    update({
      layout: {
        ...(paperRef.current.layout ?? {}),
        panX: panRef.current.x,
        panY: panRef.current.y,
        zoom: zoomRef.current,
        wheel: wheelMode,
        drawerW: drawerWRef.current,
        drawerOpen: drawerOpenRef.current,
      },
    });
  }, [update, wheelMode]);

  /**
   * 缩放到目标值，并让画布上的某个点保持不动（默认画布中心），像地图那样以光标为锚。
   * @param {number} nextZoom 目标缩放
   * @param {{x:number,y:number}} [anchor] 画布内的锚点（像素）
   */
  const applyZoom = useCallback(
    (nextZoom, anchor) => {
      const clamped = clampZoom(nextZoom);
      if (Math.abs(clamped - zoomRef.current) < 0.0001) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      const anchorX = anchor?.x ?? (rect ? rect.width / 2 : 0);
      const anchorY = anchor?.y ?? (rect ? rect.height / 2 : 0);
      const worldX = (anchorX - panRef.current.x) / zoomRef.current;
      const worldY = (anchorY - panRef.current.y) / zoomRef.current;
      const nextPan = { x: anchorX - worldX * clamped, y: anchorY - worldY * clamped };
      zoomRef.current = clamped;
      panRef.current = nextPan;
      setZoom(clamped);
      setPan(nextPan);
      persistView();
    },
    [persistView],
  );

  /**
   * 一组节点的包围盒（画布坐标）。
   * @param {Array} list 节点
   * @returns {{minX:number,minY:number,maxX:number,maxY:number}|null}
   */
  const boundsOf = useCallback(
    (list) => {
      if (list.length === 0) return null;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const block of list) {
        const size = metrics[block.id] ?? { w: block.w ?? 300, h: 170 };
        minX = Math.min(minX, block.x ?? 0);
        minY = Math.min(minY, block.y ?? 0);
        maxX = Math.max(maxX, (block.x ?? 0) + size.w);
        maxY = Math.max(maxY, (block.y ?? 0) + size.h);
      }
      return { minX, minY, maxX, maxY };
    },
    [metrics],
  );

  /**
   * 把一块区域放进视口（居中 + 铺满）。
   * @param {object|null} bounds 包围盒
   * @param {{maxZoom?: number}} [options] maxZoom 限制放大倍数（聚焦单块时别撑爆）
   */
  const fitBounds = useCallback(
    (bounds, options = {}) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!bounds || !rect || rect.width === 0) return;
      const width = Math.max(80, bounds.maxX - bounds.minX);
      const height = Math.max(80, bounds.maxY - bounds.minY);
      const fitZoom = Math.min(
        (rect.width - FIT_PADDING * 2) / width,
        (rect.height - FIT_PADDING * 2) / height,
      );
      const nextZoom = clampZoom(Math.min(fitZoom, options.maxZoom ?? ZOOM_MAX));
      const nextPan = {
        x: (rect.width - width * nextZoom) / 2 - bounds.minX * nextZoom,
        y: (rect.height - height * nextZoom) / 2 - bounds.minY * nextZoom,
      };
      zoomRef.current = nextZoom;
      panRef.current = nextPan;
      setZoom(nextZoom);
      setPan(nextPan);
      persistView();
    },
    [persistView],
  );

  /**
   * 滚轮 / 触控板手势：
   *   - 捏合（带 ctrl/meta）→ 以光标为锚缩放；
   *   - 两指滑动（像素模式、增量很小）→ 平移，macOS 的惯性滚动也走这条；
   *   - 鼠标滚轮一档（增量大）→ 缩放；
   *   - Shift + 滚轮 → 水平平移。
   * 判断依据是事件本身的特征，工具栏上还有一个「滚轮」按钮可以强制成单一行为。
   *
   * 依赖里带 paper：画布元素是在论文读出来之后才挂上的，只在挂载时绑定会绑到 null，
   * 那样滚轮永远没反应（0.4.0 就是这么失效的）。
   */
  /** 手势判定要"粘住"：一次滑动/甩动期间沿用同一判定，不在中途翻脸。 */
  const wheelGesture = useRef({ kind: 'mouse', at: 0 });
  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return undefined;
    const classify = (event) => {
      const now = Date.now();
      if (now - wheelGesture.current.at < 250) return wheelGesture.current.kind;
      const kind = isTrackpadScroll(event) ? 'trackpad' : 'mouse';
      wheelGesture.current = { kind, at: now };
      return kind;
    };
    const onWheel = (event) => {
      const rect = element.getBoundingClientRect();
      const pinch = event.ctrlKey || event.metaKey;
      const panBy = (dx, dy) => {
        const next = { x: panRef.current.x - dx, y: panRef.current.y - dy };
        panRef.current = next;
        setPan(next);
        persistView();
      };
      event.preventDefault();
      if (pinch) {
        const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
        applyZoom(zoomRef.current * Math.exp(-delta * 0.0025), {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
        return;
      }
      if (event.shiftKey && wheelMode !== 'zoom') {
        panBy(event.deltaX || event.deltaY, 0);
        return;
      }
      const gesture = classify(event);
      wheelGesture.current = { kind: gesture, at: Date.now() };
      const wantsPan = wheelMode === 'pan' || (wheelMode === 'auto' && gesture === 'trackpad');
      if (wantsPan) {
        panBy(event.deltaX, event.deltaY);
        return;
      }
      // 鼠标滚轮一档约 100，触控板一次只有几像素：指数映射让两者手感接近。
      const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
      applyZoom(zoomRef.current * Math.exp(-delta * 0.0025), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [applyZoom, persistView, paper, wheelMode]);

  const blocks = paper?.blocks ?? [];
  const edges = paper?.edges ?? [];
  const figures = paper?.figures ?? [];

  /** 第一次打开（还没有存过缩放）时，自动把整张图放进视口。 */
  const autoFitted = useRef(false);
  useEffect(() => {
    if (autoFitted.current || !paper || blocks.length === 0) return;
    if (typeof paper.layout?.zoom === 'number') {
      autoFitted.current = true;
      return;
    }
    if (Object.keys(metrics).length < Math.min(blocks.length, 2)) return;
    fitBounds(boundsOf(blocks), { maxZoom: 1 });
    autoFitted.current = true;
  }, [paper, blocks, metrics, boundsOf, fitBounds]);


  /** 节点尺寸上报（连线要用真实高度）。 */
  const reportMetric = useCallback((id, width, height) => {
    setMetrics((prev) => {
      const current = prev[id];
      if (current && current.w === width && current.h === height) return prev;
      return { ...prev, [id]: { w: width, h: height } };
    });
  }, []);

  /**
   * 拖节点：按在卡片的任意位置就能拖，不用先点标题栏选中。
   * 按钮、公式里的链接、图片、连线端口仍然各自响应自己的点击，不触发拖动。
   */
  const onNodeDragStart = (event, block) => {
    if (event.button !== 0) return;
    // 图片也算拖动起点：节点里塞满一张图时，从图上也能拖
    if (event.target.closest?.('button, textarea, input, a, .pd-port, .pd-figure-picker')) return;
    event.stopPropagation();
    dragMoved.current = false;
    setDragging({ id: block.id, startX: event.clientX, startY: event.clientY, originX: block.x ?? 0, originY: block.y ?? 0 });
    setSelectedBlock(block.id);
  };

  /** 全局 mousemove / mouseup：拖节点、拖线、平移都在这里收口。 */
  useEffect(() => {
    const onMove = (event) => {
      if (dragging) {
        const rawX = event.clientX - dragging.startX;
        const rawY = event.clientY - dragging.startY;
        // 超过 3px 才算拖动：这样单纯点一下仍然只是选中/看内容
        if (!dragMoved.current && Math.hypot(rawX, rawY) > 3) {
          dragMoved.current = true;
          document.body.style.userSelect = 'none';
        }
        const dx = rawX / zoomRef.current;
        const dy = rawY / zoomRef.current;
        const next = paperRef.current.blocks.map((block) =>
          block.id === dragging.id ? { ...block, x: Math.round(dragging.originX + dx), y: Math.round(dragging.originY + dy) } : block,
        );
        paperRef.current = { ...paperRef.current, blocks: next };
        setPaper(paperRef.current);
      } else if (pendingEdge) {
        const rect = canvasRef.current?.getBoundingClientRect();
        setPendingEdge({
          ...pendingEdge,
          x: (event.clientX - (rect?.left ?? 0) - panRef.current.x) / zoomRef.current,
          y: (event.clientY - (rect?.top ?? 0) - panRef.current.y) / zoomRef.current,
        });
      } else if (panning) {
        const next = { x: panning.originX + event.clientX - panning.startX, y: panning.originY + event.clientY - panning.startY };
        panRef.current = next;
        setPan(next);
      } else if (nodeResize) {
        const dx = (event.clientX - nodeResize.startX) / zoomRef.current;
        const dy = (event.clientY - nodeResize.startY) / zoomRef.current;
        const { dir, startW, startH, nodeX, nodeY } = nodeResize;
        const MIN_W = 220;
        const MIN_H = 80;
        let width = startW;
        let height = startH;
        let x = nodeX;
        let y = nodeY;
        // 从左边/上边拉时，对边要钉住 → 位置跟着动
        if (dir.includes('e')) width = startW + dx;
        if (dir.includes('s')) height = startH + dy;
        if (dir.includes('w')) {
          width = startW - dx;
          x = nodeX + dx;
          if (width < MIN_W) {
            x = nodeX + (startW - MIN_W);
            width = MIN_W;
          }
        }
        if (dir.includes('n')) {
          height = startH - dy;
          y = nodeY + dy;
          if (height < MIN_H) {
            y = nodeY + (startH - MIN_H);
            height = MIN_H;
          }
        }
        width = Math.round(Math.min(900, width));
        height = Math.round(Math.min(900, height));
        const next = paperRef.current.blocks.map((block) =>
          block.id === nodeResize.id ? { ...block, w: width, h: height, x: Math.round(x), y: Math.round(y) } : block,
        );
        paperRef.current = { ...paperRef.current, blocks: next };
        setPaper(paperRef.current);
      } else if (resizing) {
        // 往左拖变宽：用起始宽度减去水平位移
        const width = Math.min(760, Math.max(300, resizing.startW + (resizing.startX - event.clientX)));
        drawerWRef.current = width;
        setDrawerW(width);
      }
    };
    const onUp = (event) => {
      if (dragging) {
        document.body.style.userSelect = '';
        if (dragMoved.current) {
          dragEndedAt.current = Date.now();
          update({ blocks: paperRef.current.blocks }, true);
        }
        setDragging(null);
      } else if (pendingEdge) {
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-node-id]');
        const targetId = target?.getAttribute('data-node-id');
        if (targetId && targetId !== pendingEdge.from) {
          const exists = edges.some((edge) => edge.from === pendingEdge.from && edge.to === targetId);
          if (!exists) update({ edges: [...edges, { from: pendingEdge.from, to: targetId }] }, true);
        }
        setPendingEdge(null);
      } else if (panning) {
        persistView();
        setPanning(null);
      } else if (nodeResize) {
        update({ blocks: paperRef.current.blocks }, true);
        setNodeResize(null);
      } else if (resizing) {
        persistView();
        setResizing(null);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, pendingEdge, panning, resizing, nodeResize, edges, update, persistView]);

  /** 添加一个自由节点（放在视口中央）。 */
  const addNode = () => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const x = Math.round(((rect?.width ?? 900) / 2 - pan.x) / zoom) - 160;
    const y = Math.round(((rect?.height ?? 600) / 2 - pan.y) / zoom) - 80;
    const block = { id: `b-custom-${Date.now().toString(36)}`, type: 'custom', title: '新节点', text: '', x, y, w: 320 };
    update({ blocks: [...blocks, block] }, true);
    setSelectedBlock(block.id);
    setEditing(block);
  };

  /** 删除节点及其连线。 */
  const removeBlock = (id) => {
    if (!window.confirm('删除这个节点？连到它的线也会一起删掉。')) return;
    update({ blocks: blocks.filter((block) => block.id !== id), edges: edges.filter((edge) => edge.from !== id && edge.to !== id) }, true);
    if (selectedBlock === id) setSelectedBlock(null);
  };

  /** 保存编辑后的节点。 */
  const saveBlock = (block) => {
    update({ blocks: blocks.map((item) => (item.id === block.id ? { ...item, ...block } : item)) }, true);
    setEditing(null);
  };

  const figureOf = (block) => {
    if (!block.figureId) return null;
    return figures.find((figure) => figure.id === block.figureId) ?? null;
  };

  const connected = useMemo(() => {
    const map = {};
    for (const edge of edges) {
      map[edge.from] = [...(map[edge.from] ?? []), edge.to];
    }
    return map;
  }, [edges]);

  if (error && !paper) {
    return React.createElement('div', { className: 'pd-main' }, React.createElement('div', { className: 'pd-empty' }, error));
  }
  if (!paper) {
    return React.createElement('div', { className: 'pd-main' }, React.createElement('div', { className: 'pd-empty' }, React.createElement(Spinner), ' 正在打开论文…'));
  }

  const toolbar = React.createElement(
    'div',
    { className: 'pd-toolbar' },
    React.createElement('div', { style: { minWidth: 0, flex: 1 } },
      React.createElement('div', { className: 'pd-title', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, paper.title),
      paper.abstract ? React.createElement('div', { className: 'pd-sub', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, paper.abstract) : null,
    ),
    // 缩放控制：全局缩放 / 适应整张图 / 聚焦选中块
    React.createElement(
      'div',
      { className: 'pd-zoom' },
      React.createElement('button', {
        className: 'pd-btn pd-btn-sm pd-btn-ghost',
        onClick: () => applyZoom(zoom / ZOOM_STEP),
        title: '缩小（滚轮 / 触控板双指 / 捏合都可以）',
      }, '−'),
      React.createElement('button', {
        className: 'pd-btn pd-btn-sm pd-btn-ghost pd-zoom-value',
        onClick: () => applyZoom(1),
        title: '回到 100%',
      }, `${Math.round(zoom * 100)}%`),
      React.createElement('button', {
        className: 'pd-btn pd-btn-sm pd-btn-ghost',
        onClick: () => applyZoom(zoom * ZOOM_STEP),
        title: '放大',
      }, '+'),
      React.createElement('button', {
        className: 'pd-btn pd-btn-sm pd-btn-ghost',
        onClick: () => {
          const next = wheelMode === 'auto' ? 'zoom' : wheelMode === 'zoom' ? 'pan' : 'auto';
          setWheelMode(next);
          update({ layout: { ...(paperRef.current.layout ?? {}), wheel: next } }, true);
        },
        title: '滚轮/触控板：自动（两指平移、鼠标滚轮缩放、捏合缩放）→ 总是缩放 → 总是平移',
      }, `滚轮：${wheelMode === 'auto' ? '自动' : wheelMode === 'zoom' ? '缩放' : '平移'}`),
      React.createElement('button', {
        className: 'pd-btn pd-btn-sm pd-btn-ghost',
        onClick: () => fitBounds(boundsOf(blocks), { maxZoom: 1.1 }),
        title: '让整张图铺满视口',
      }, '适应'),
      React.createElement('button', {
        className: 'pd-btn pd-btn-sm pd-btn-ghost',
        disabled: !selectedBlock,
        onClick: () => {
          const target = blocks.find((block) => block.id === selectedBlock);
          if (target) fitBounds(boundsOf([target]), { maxZoom: 1.5 });
        },
        title: '放大到选中的这一块（选个节点，或双击它的标题）',
      }, '聚焦所选'),
    ),
    React.createElement('button', { className: 'pd-btn pd-btn-ghost', onClick: addNode, title: '在画布上加一个自由节点' }, React.createElement(Icon, { name: 'plus' }), '节点'),
    React.createElement(
      'button',
      {
        className: 'pd-btn pd-btn-ghost',
        onClick: reanalyze,
        disabled: reanalyzing,
        title: '用已存的全文重新拆一遍节点（笔记与会话会迁移过去）',
      },
      React.createElement(Icon, { name: 'spark', size: 12 }),
      reanalyzing ? '分析中…' : '重新分析',
    ),
    React.createElement(
      'button',
      {
        className: 'pd-btn pd-btn-ghost',
        onClick: tidyLayout,
        title: '按连线把节点重排成从左到右的流程图',
      },
      React.createElement(Icon, { name: 'layers', size: 12 }),
      '整理布局',
    ),
  );

  const edgeElements = [];
  for (const edge of edges) {
    const from = blocks.find((block) => block.id === edge.from);
    const to = blocks.find((block) => block.id === edge.to);
    if (!from || !to) continue;
    const path = edgePath(from, to, metrics);
    edgeElements.push(
      React.createElement(
        'g',
        { key: `${edge.from}->${edge.to}` },
        React.createElement('path', { d: path, fill: 'none', stroke: 'var(--dsw-alias-border-l4, #b9c6d6)', strokeWidth: 1.6 }),
        React.createElement('path', {
          d: path,
          fill: 'none',
          stroke: 'transparent',
          strokeWidth: 14,
          className: 'pd-edge-hit',
          onClick: () => {
            if (window.confirm('删掉这条连线？')) update({ edges: edges.filter((item) => item !== edge) }, true);
          },
        }),
      ),
    );
  }
  if (pendingEdge) {
    const from = blocks.find((block) => block.id === pendingEdge.from);
    if (from) {
      const fromMetric = metrics[from.id] ?? { w: from.w ?? 320, h: 120 };
      const x1 = (from.x ?? 0) + fromMetric.w;
      const y1 = (from.y ?? 0) + 26;
      edgeElements.push(
        React.createElement('path', {
          key: 'pending',
          d: `M${x1},${y1} C${x1 + 60},${y1} ${pendingEdge.x - 60},${pendingEdge.y} ${pendingEdge.x},${pendingEdge.y}`,
          fill: 'none',
          stroke: 'var(--dsw-alias-brand-primary, #2f6fd0)',
          strokeWidth: 1.6,
          strokeDasharray: '5 4',
        }),
      );
    }
  }

  const layoutBanner = layoutUndo
    ? React.createElement(
        'div',
        { className: 'pd-notice' },
        React.createElement('div', { className: 'pd-notice-text' }, '已按连线重排成流程图'),
        React.createElement(
          'button',
          {
            className: 'pd-btn pd-btn-sm pd-btn-ghost',
            onClick: () => {
              update({ blocks: layoutUndo }, true);
              setLayoutUndo(null);
            },
          },
          '撤销',
        ),
      )
    : null;

  const recropBanner = notice
    ? React.createElement(
        'div',
        { className: `pd-notice${notice.ok ? '' : ' pd-notice-error'}` },
        React.createElement('div', { className: 'pd-notice-text' }, notice.text),
        React.createElement('button', { className: 'pd-btn pd-btn-sm pd-btn-ghost', onClick: () => setNotice(null) }, '知道了'),
      )
    : null;

  const canvas = React.createElement(
    'div',
    {
      ref: canvasRef,
      className: `pd-canvas${panning ? ' is-panning' : ''}`,
      onMouseDown: (event) => {
        if (event.target !== event.currentTarget && event.target.dataset?.canvasInner === undefined) return;
        setPanning({ startX: event.clientX, startY: event.clientY, originX: pan.x, originY: pan.y });
        setSelectedBlock(null);
      },
    },
    React.createElement(
      'div',
      { className: 'pd-canvas-inner', 'data-canvas-inner': '1', style: { transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` } },
      React.createElement('svg', { className: 'pd-edges', width: 6000, height: 4000 }, edgeElements),
      ...blocks.map((block) => {
        const style = TYPE_STYLE[block.type] ?? TYPE_STYLE.custom;
        const figure = figureOf(block);
        return React.createElement(
          'div',
          {
            key: block.id,
            'data-node-id': block.id,
            className: `pd-node${selectedBlock === block.id ? ' is-active' : ''}`,
            style: {
              left: block.x ?? 0,
              top: block.y ?? 0,
              width: block.w ?? 320,
              ...(block.h ? { height: block.h } : {}),
              borderTop: `3px solid ${style.color}`,
            },
            onMouseDown: (event) => onNodeDragStart(event, block),
            onClick: () => {
              // 拖拽结束紧跟的那次 click 忽略（否则每拖一次都会弹回会话页签），
              // 但 250ms 之后的正常点击必须照常选中。
              if (Date.now() - dragEndedAt.current < 250) return;
              setSelectedBlock(block.id);
              setTab('chat');
            },
          },
          React.createElement(NodeSizer, { id: block.id, onMeasure: reportMetric }),
          React.createElement(
            'div',
            {
              className: 'pd-node-head',
              onDoubleClick: () => fitBounds(boundsOf([block]), { maxZoom: 1.5 }),
            },
            React.createElement('span', { className: 'pd-chip', style: { background: `${style.color}18`, color: style.color, borderColor: `${style.color}33` } }, style.label),
            React.createElement('span', { className: 'pd-node-title', title: block.title }, block.title),
            React.createElement(
              'button',
              {
                className: 'pd-btn pd-btn-sm pd-btn-ghost',
                title: '编辑节点',
                onMouseDown: (event) => event.stopPropagation(),
                onClick: (event) => {
                  event.stopPropagation();
                  setEditing(block);
                },
              },
              React.createElement(Icon, { name: 'pencil', size: 11 }),
            ),
            React.createElement(
              'button',
              {
                className: 'pd-btn pd-btn-sm pd-btn-ghost pd-danger',
                title: '删除节点',
                onMouseDown: (event) => event.stopPropagation(),
                onClick: (event) => {
                  event.stopPropagation();
                  removeBlock(block.id);
                },
              },
              React.createElement(Icon, { name: 'trash', size: 11 }),
            ),
          ),
          React.createElement(
            'div',
            { className: 'pd-node-body' },
            block.section ? React.createElement('div', { className: 'pd-node-meta' }, `§${block.section}`) : null,
            block.latex ? React.createElement(Formula, { tex: block.latex, className: 'pd-node-latex' }) : null,
            block.text
              ? React.createElement(
                  'div',
                  { className: 'pd-node-text pd-md-host' },
                  React.createElement(Markdown, { text: block.text }),
                )
              : null,
            figure
              ? React.createElement(
                  'div',
                  { className: 'pd-node-figure-box', style: { marginTop: block.text ? 8 : 0 } },
                  React.createElement('img', {
                    className: 'pd-node-figure',
                    src: assetUrl(paper.id, figure.file, assetVersion),
                    alt: figure.caption,
                    onClick: (event) => {
                      event.stopPropagation();
                      // 刚拖过就别弹大图，避免"想拖却弹图"
                      if (Date.now() - dragEndedAt.current < 250) return;
                      setLightbox({
                        src: assetUrl(paper.id, figure.file, assetVersion),
                        caption: figureLabel(figure) || figure.caption || '',
                      });
                    },
                  }),
                  figureLabel(figure)
                    ? React.createElement('div', { className: 'pd-fig-cap', title: figure.caption ?? '' }, figureLabel(figure))
                    : null,
                )
              : null,
            connected[block.id]?.length ? React.createElement('div', { className: 'pd-sub', style: { marginTop: 6 } }, `→ 连到 ${connected[block.id].length} 个节点`) : null,
          ),
          React.createElement('span', {
            className: 'pd-port pd-port-in',
            title: '连线入口',
          }),
          // 八向命中区：只有光标变化，不画边框、不画方块（居中区域留给拖动）
          ...['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((dir) =>
            React.createElement('span', {
              key: `resize-${dir}`,
              className: `pd-rs pd-rs-${dir}`,
              onMouseDown: (event) => {
                event.stopPropagation();
                event.preventDefault();
                const metric = metrics[block.id] ?? { w: block.w ?? 300, h: 200 };
                setNodeResize({
                  id: block.id,
                  dir,
                  startX: event.clientX,
                  startY: event.clientY,
                  startW: block.w ?? metric.w,
                  startH: block.h ?? metric.h,
                  nodeX: block.x ?? 0,
                  nodeY: block.y ?? 0,
                });
              },
              onDoubleClick: (event) => {
                event.stopPropagation();
                update({
                  blocks: paperRef.current.blocks.map((item) =>
                    item.id === block.id ? { ...item, w: 300, h: undefined } : item,
                  ),
                }, true);
              },
            }),
          ),
          React.createElement('span', {
            className: 'pd-port pd-port-out',
            title: '从这里拖到另一个节点连线',
            onMouseDown: (event) => {
              event.stopPropagation();
              const rect = canvasRef.current?.getBoundingClientRect();
              setPendingEdge({ from: block.id, x: event.clientX - (rect?.left ?? 0) - pan.x, y: event.clientY - (rect?.top ?? 0) - pan.y });
            },
          }),
        );
      }),
    ),
  );

  return React.createElement(
    'div',
    { className: 'pd-body' },
    React.createElement('div', { className: 'pd-main' }, toolbar, recropBanner, layoutBanner, canvas),
    drawerOpen
      ? React.createElement(Drawer, {
          paper,
          selectedBlockId: selectedBlock,
          tab,
          setTab,
          onUpdate: update,
          onSelectBlock: setSelectedBlock,
          width: drawerW,
          onResizeStart: (event) => {
            if (event?.reset) {
              drawerWRef.current = 372;
              setDrawerW(372);
              persistView();
              return;
            }
            event.stopPropagation();
            event.preventDefault();
            setResizing({ startX: event.clientX, startW: drawerW });
          },
          onCollapse: () => {
            drawerOpenRef.current = false;
            setDrawerOpen(false);
            persistView();
          },
          onCaptureFigure: async (dataUrl, blockId) => {
            try {
              const result = await api.uploadFigure(paper.id, dataUrl, '框选截取');
              const figure = result.figure;
              paperRef.current = {
                ...paperRef.current,
                figures: [...(paperRef.current.figures ?? []), figure],
                blocks: (paperRef.current.blocks ?? []).map((item) =>
                  item.id === blockId ? { ...item, figureId: figure.id } : item,
                ),
              };
              setPaper(paperRef.current);
              setAssetVersion((version) => version + 1);
              update({ figures: paperRef.current.figures, blocks: paperRef.current.blocks }, true);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          },
        })
      : React.createElement(
          'button',
          {
            className: 'pd-drawer-reopen',
            title: '展开右侧栏',
            onClick: () => {
              drawerOpenRef.current = true;
              setDrawerOpen(true);
              persistView();
            },
          },
          React.createElement(Icon, { name: 'panel', size: 14 }),
          '会话',
        ),
    editing
      ? React.createElement(NodeEditModal, {
          block: editing,
          figures,
          paperId: paper.id,
          onClose: () => setEditing(null),
          onSave: saveBlock,
          onUploaded: (figure) => {
            update({ figures: [...figures, figure] }, true);
            setAssetVersion((version) => version + 1);
          },
        })
      : null,
    lightbox
      ? React.createElement(Lightbox, {
          src: lightbox.src,
          caption: lightbox.caption,
          onClose: () => setLightbox(null),
        })
      : null,
  );
}

/**
 * 量节点尺寸并上报（连线按真实高度算基准点）。
 * @param {{ id: string, onMeasure: (id: string, w: number, h: number) => void }} props
 */
function NodeSizer({ id, onMeasure }) {
  const { useEffect, useRef } = React;
  const ref = useRef(null);
  useEffect(() => {
    const element = ref.current?.parentElement;
    if (!element) return undefined;
    const observer = new ResizeObserver(() => onMeasure(id, element.offsetWidth, element.offsetHeight));
    observer.observe(element);
    onMeasure(id, element.offsetWidth, element.offsetHeight);
    return () => observer.disconnect();
  }, [id, onMeasure]);
  return React.createElement('span', { ref, style: { display: 'none' } });
}

/**
 * 节点编辑弹窗：改标题/正文/LaTeX，并从**这篇论文裁出来的全部图**里挑一张挂上。
 *
 * 为什么要图库：导入时模型只会把少数几张图挂到节点上（原理图、关键结果图），
 * 剩下的图虽然已经裁好存在 papers/<id>/ 里，但界面上没有入口——用户就永远看不见它们。
 * 这里把整篇的图都列出来，任何节点都能挂任意一张。
 * @param {{ block: object, figures: Array, paperId: string, onClose: () => void, onSave: (block: object) => void }} props
 */
function NodeEditModal({ block, figures, paperId, assetVersion, onClose, onSave, onUploaded }) {
  const { useRef, useState } = React;
  const [title, setTitle] = useState(block.title ?? '');
  const [text, setText] = useState(block.text ?? '');
  const [latex, setLatex] = useState(block.latex ?? '');
  const [figureId, setFigureId] = useState(block.figureId ?? '');
  const [uploading, setUploading] = useState(false);
  /** 只看"这块自己的图"；需要换图时才展开全部。 */
  const [showAll, setShowAll] = useState(!block.figureId);
  const [error, setError] = useState('');
  const fileInput = useRef(null);

  /** 选一张本地图片上传成这篇论文的图，并直接挂到当前节点。 */
  const upload = async (file) => {
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.readAsDataURL(file);
      });
      const result = await api.uploadFigure(paperId, dataUrl, file.name);
      setFigureId(result.figure.id);
      onUploaded?.(result.figure);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };
  return React.createElement(
    Modal,
    {
      title: '编辑节点',
      onClose,
      footer: [
        React.createElement('button', { key: 'c', className: 'pd-btn', onClick: onClose }, '取消'),
        React.createElement(
          'button',
          { key: 's', className: 'pd-btn pd-btn-primary', onClick: () => onSave({ id: block.id, title, text, latex, figureId: figureId || undefined }) },
          '保存',
        ),
      ],
    },
    React.createElement(
      'div',
      { className: 'pd-field' },
      React.createElement('span', { className: 'pd-field-label' }, '标题'),
      React.createElement('input', { className: 'pd-input', value: title, onChange: (event) => setTitle(event.target.value) }),
    ),
    React.createElement(
      'div',
      { className: 'pd-field' },
      React.createElement('span', { className: 'pd-field-label' }, '正文（可以写自己的理解）'),
      React.createElement('textarea', { className: 'pd-textarea', rows: 6, value: text, onChange: (event) => setText(event.target.value) }),
    ),
    React.createElement(
      'div',
      { className: 'pd-field' },
      React.createElement('span', { className: 'pd-field-label' }, 'LaTeX（可空）'),
      React.createElement('textarea', { className: 'pd-textarea', rows: 3, value: latex, onChange: (event) => setLatex(event.target.value) }),
    ),
    figures.length >= 0
      ? React.createElement(
          'div',
          { className: 'pd-field' },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            React.createElement('span', { className: 'pd-field-label', style: { flex: 1 } }, showAll ? `从全部图里选（这篇共 ${figures.length} 张）` : '这一块的配图'),
            React.createElement(
              'button',
              { className: 'pd-btn pd-btn-sm', disabled: uploading, onClick: () => fileInput.current?.click(), title: '裁得不对时，自己上传一张图挂到这个节点' },
              uploading ? '上传中…' : '上传图片',
            ),
          ),
          React.createElement('input', {
            ref: fileInput,
            type: 'file',
            accept: 'image/*',
            style: { display: 'none' },
            onChange: (event) => {
              upload(event.target.files?.[0]);
              event.target.value = '';
            },
          }),
          React.createElement(
            'div',
            { className: 'pd-figure-picker' },
            React.createElement(
              'button',
              {
                className: `pd-figure-option${figureId === '' ? ' is-picked' : ''}`,
                onClick: () => setFigureId(''),
                title: '不挂图',
              },
              '不挂图',
            ),
            ...(showAll ? figures : figures.filter((figure) => figure.id === figureId)).map((figure) =>
              React.createElement(
                'button',
                {
                  key: figure.id,
                  className: `pd-figure-option${figureId === figure.id ? ' is-picked' : ''}`,
                  onClick: () => setFigureId(figure.id),
                  title: figure.caption || `第 ${figure.page} 页`,
                },
                React.createElement('img', { src: assetUrl(paperId, figure.file, assetVersion), alt: figure.caption ?? '' }),
                figureLabel(figure) ? React.createElement('span', { className: 'pd-fig-option-cap' }, figureLabel(figure)) : null,
              ),
            ),
          ),
        )
      : null,
  );
}
