/**
 * PDF 抽取（浏览器端）：pdf.js 负责解析，canvas 负责把图裁出来。
 *
 * 为什么放在浏览器：图必须真的"画"出来才能裁——DSH 宿主里没有 canvas，
 * 装 native canvas 又会把插件变成要编译的包。浏览器本来就有 Chromium。
 *
 * 图的识别是启发式的：找 "Figure N / Fig. N / Table N" 开头的图注行，
 * 把它**上方**的那一块（到上一条图注或正文顶部为止）裁下来。这是论文排版里最常见的
 * "图在上、注在下"约定；判错的代价只是裁得偏大或偏小，用户还能自己缩放看。
 */
import { workerUrl, pdfjsUrl } from './api.js';

/**
 * pdf.js 本体不打进主 bundle：它有好几 MB，而大多数会话根本不导入论文。
 * 宿主把打包好的 pdfjs.mjs 当静态资源伺服，第一次导入论文时才动态 import。
 */
let pdfjsPromise;

/**
 * 加载 pdf.js 本体（首次调用才真正下载）。
 * @returns {Promise<object>} pdf.js 模块命名空间
 */
export async function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import(/* @vite-ignore */ pdfjsUrl());
  return pdfjsPromise;
}

/** 页面渲染缩放：2x 足够看清公式与坐标轴，再高只是浪费内存。 */
const RENDER_SCALE = 2;

/** 最多读取的页数（论文附录常常几十页，读全没有收益）。 */
const MAX_PAGES = 36;

/** 最多裁几张图。 */
const MAX_FIGURES = 12;

/** 单张图导出后的最大宽度（像素）。 */
const MAX_FIGURE_WIDTH = 1400;

/** 图注行正则。 */
const CAPTION_RE = /^(figure|fig\.?|table|图|表)\s*([0-9]{1,2}|[IVX]{1,4})(?:[.:|)\-—、]|\s|$)\s*/i;

/**
 * 章节标题正则：`4.5 Results` / `3 Method` / `2.1. Problem Setup`。
 * 只认"编号 + 大写开头的短标题"，避免把正文里的 `3.2 Our method is …` 当成标题。
 */
const SECTION_NUMBERED_RE = /^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+([A-Z][A-Za-z0-9&,\-/ ]{2,60})$/;
/** 没有编号的常见章节名（Abstract 这类通常是单独一行）。 */
const SECTION_NAMED_RE = /^(abstract|introduction|related work|background|preliminaries|method|methods|approach|proposed method|model|experiment|experiments|evaluation|results|discussion|conclusions?|limitations|future work|references|appendix[a-z0-9]*)$/i;

/**
 * 从一页的文本行里认出章节标题。
 * 标题通常比正文大一号，所以无编号的标题再要求 fontHeight 明显高于本页中位数。
 *
 * @param {Array<{text: string, height: number}>} lines 本页文本行
 * @param {number} bodyHeight 本页字号中位数
 * @returns {string[]} 本页的章节标题（按出现顺序）
 */
function sectionLabels(lines, bodyHeight) {
  const labels = [];
  for (const line of lines) {
    const text = String(line.text ?? '').replace(/\s+/g, ' ').trim();
    if (text.length < 3 || text.length > 72) continue;
    if (CAPTION_RE.test(text)) continue;
    const numbered = text.match(SECTION_NUMBERED_RE);
    if (numbered) {
      const title = numbered[2].trim();
      if (title.split(/\s+/).length <= 9 && !/[.;:,]$/.test(title)) labels.push(`${numbered[1]} ${title}`);
      continue;
    }
    const named = text.match(SECTION_NAMED_RE);
    if (named && line.height >= bodyHeight * 1.02) labels.push(text.replace(/^\d+\.?\s*/, ''));
  }
  return labels;
}

/**
 * 给每张图找到它所在的板块：取"页码不晚于这张图"的最后一个章节标题。
 * 图注所在页基本就在它所属章节里，按页近似足够准。
 *
 * @param {Array<{page: number, label: string}>} headings 全文章节标题（按页序）
 * @param {number} page 图的页码
 * @returns {string} 形如 `4.5 Results`，找不到时为空字符串
 */
function sectionForPage(headings, page) {
  let found = '';
  for (const heading of headings) {
    if (heading.page <= page) found = heading.label;
    else break;
  }
  return found;
}

/** worker 只设一次。 */
let workerConfigured = false;

/**
 * 配好 worker 地址（宿主路由提供 pdf.worker.mjs）。
 * @param {object} pdfjs pdf.js 模块命名空间
 */
export function ensureWorker(pdfjs) {
  if (workerConfigured) return;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl();
  workerConfigured = true;
}

/**
 * ArrayBuffer → base64（分块，避免 apply 参数过多爆栈）。
 * @param {ArrayBuffer} buffer
 */
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = '';
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/**
 * 把一页的文字项折成"行"（按基线聚类）。
 * @param {Array} items getTextContent().items
 * @param {object} viewport 页面 viewport
 * @returns {Array} [{ text, top, bottom, left, right }]
 */
function toLines(items, viewport, pdfjs) {
  const rows = new Map();
  for (const item of items) {
    if (!item.str || item.str.trim().length === 0) continue;
    const tx = pdfjs.Util.transform(viewport.transform, item.transform);
    const left = tx[4];
    const baseline = tx[5];
    const fontHeight = Math.hypot(tx[2], tx[3]) || 10 * RENDER_SCALE;
    const key = Math.round(baseline / 4);
    const row = rows.get(key) ?? { baseline, left: left, right: left, height: fontHeight, pieces: [] };
    row.left = Math.min(row.left, left);
    row.right = Math.max(row.right, left + (item.width ?? 0) * RENDER_SCALE);
    row.height = Math.max(row.height, fontHeight);
    row.pieces.push({ x: left, right: left + (item.width ?? 0) * RENDER_SCALE, text: item.str });
    rows.set(key, row);
  }
  const lines = [...rows.values()].map((row) => {
    // 不能直接 join('')：不少 PDF（尤其双栏 ACM 模板）把每个词甚至每个字形当成一个 text item，
    // 直接拼会得到 "ExploringtheEfectsofSensoryConflicts" 这种没有空格的整段文本，
    // 既毁掉模型输入，也让章节标题/图注的正则全部失效。
    // 这里按"两个 item 之间的水平间隙"补空格：间隙 > 0.18em 视为词间距，字符间的小缝隙不补。
    const pieces = row.pieces.sort((a, b) => a.x - b.x);
    const wordGap = Math.max(1, (row.height || 10) * 0.18);
    let text = '';
    let previousRight = null;
    for (const piece of pieces) {
      if (previousRight !== null && piece.x - previousRight > wordGap && !/\s$/.test(text) && !/^\s/.test(piece.text)) {
        text += ' ';
      }
      text += piece.text;
      previousRight = piece.right ?? piece.x;
    }
    text = text.replace(/\s+/g, ' ').trim();
    return {
      text,
      top: row.baseline - row.height * 0.86,
      bottom: row.baseline + row.height * 0.24,
      left: row.left,
      right: row.right,
    };
  });
  return lines.filter((line) => line.text.length > 0).sort((a, b) => a.top - b.top);
}

/**
 * 从整页 canvas 裁一块出来，缩放到目标宽度。
 * @param {HTMLCanvasElement} pageCanvas
 * @param {{x:number,y:number,w:number,h:number}} box
 * @returns {string} PNG data URL
 */
function crop(pageCanvas, box) {
  const width = Math.max(1, Math.round(box.w));
  const height = Math.max(1, Math.round(box.h));
  const source = document.createElement('canvas');
  source.width = width;
  source.height = height;
  const sourceCtx = source.getContext('2d');
  sourceCtx.fillStyle = '#ffffff';
  sourceCtx.fillRect(0, 0, width, height);
  sourceCtx.drawImage(pageCanvas, Math.round(box.x), Math.round(box.y), width, height, 0, 0, width, height);
  if (width <= MAX_FIGURE_WIDTH) return source.toDataURL('image/png');
  const target = document.createElement('canvas');
  target.width = MAX_FIGURE_WIDTH;
  target.height = Math.round((height * MAX_FIGURE_WIDTH) / width);
  const targetCtx = target.getContext('2d');
  targetCtx.fillStyle = '#ffffff';
  targetCtx.fillRect(0, 0, target.width, target.height);
  targetCtx.drawImage(source, 0, 0, target.width, target.height);
  return target.toDataURL('image/png');
}


/**
 * 从绘图指令里还原"画上去的位图"占据的矩形。
 *
 * pdf.js 的 operator list 里，每张图都在当时的变换矩阵下绘制；顺着 save / restore / transform
 * 依次维护矩阵栈，就能把单位正方形映射成图片真正占的那块区域。文字和矢量图形不在这条链上，
 * 所以这里拿到的都是真正的位图（照片、截图、matplotlib 导出的图），不会把公式矢量图当成图。
 * @param {object} operatorList page.getOperatorList() 的结果
 * @param {object} viewport 页面 viewport
 * @param {object} pdfjs pdf.js 命名空间（要 OPS 与 Util）
 * @returns {Array<{x:number,y:number,w:number,h:number}>}
 */
function imageRects(operatorList, viewport, pdfjs) {
  const { OPS, Util } = pdfjs;
  const RECT_OPS = new Set(
    [
      OPS.paintImageXObject,
      OPS.paintInlineImageXObject,
      OPS.paintImageMaskXObject,
      OPS.paintImageXObjectRepeat,
      OPS.paintSolidColorImageMask,
    ].filter((op) => typeof op === 'number'),
  );
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const rects = [];
  const { fnArray, argsArray } = operatorList;
  for (let index = 0; index < fnArray.length; index += 1) {
    const fn = fnArray[index];
    if (fn === OPS.save) {
      stack.push(ctm);
    } else if (fn === OPS.restore) {
      ctm = stack.pop() ?? ctm;
    } else if (fn === OPS.transform) {
      const matrix = argsArray[index];
      if (Array.isArray(matrix) && matrix.length === 6) ctm = Util.transform(ctm, matrix);
    } else if (RECT_OPS.has(fn)) {
      const full = Util.transform(viewport.transform, ctm);
      const corners = [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ].map(([u, v]) => [full[0] * u + full[2] * v + full[4], full[1] * u + full[3] * v + full[5]]);
      const xs = corners.map((point) => point[0]);
      const ys = corners.map((point) => point[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      rects.push({ x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y });
    }
  }
  return rects;
}

/**
 * 过滤装饰性位图：小图标、整页背景、细长分割线、以及几乎重合的重复绘制。
 * @param {Array} rects imageRects 的结果
 * @param {number} pageWidth viewport 宽
 * @param {number} pageHeight viewport 高
 * @returns {Array}
 */
function usableRects(rects, pageWidth, pageHeight) {
  const pageArea = pageWidth * pageHeight;
  const kept = [];
  for (const rect of rects) {
    if (!(rect.w > 0 && rect.h > 0)) continue;
    if (rect.w < 110 || rect.h < 110) continue;
    const area = rect.w * rect.h;
    if (area > pageArea * 0.85) continue;
    if (rect.w / rect.h > 8 || rect.h / rect.w > 8) continue;
    // 容差按尺寸比例给：同一张图常被 pdf 拆成两块以几个像素差的位置重画，
    // 固定 8px 会漏掉大图的重复。
    const duplicate = kept.some(
      (other) =>
        Math.abs(other.x - rect.x) <= Math.max(8, other.w * 0.03) &&
        Math.abs(other.y - rect.y) <= Math.max(8, other.h * 0.03) &&
        Math.abs(other.w - rect.w) <= Math.max(8, other.w * 0.06) &&
        Math.abs(other.h - rect.h) <= Math.max(8, other.h * 0.06),
    );
    if (duplicate) continue;
    kept.push(rect);
  }
  return kept.sort((a, b) => a.y - b.y || a.x - b.x);
}


/**
 * 把文本行按横向位置聚类成列（双栏论文的关键）。
 * 靠左边界聚类：相差 12px 内视为同一列，只保留至少 3 行的列。
 * @param {Array} lines 文本行
 * @param {number} pageWidth 页面宽（像素）
 * @returns {Array<{left:number,right:number,top:number}>}
 */
function detectColumns(lines, pageWidth) {
  const groups = [];
  for (const line of [...lines].sort((a, b) => a.left - b.left)) {
    const group = groups.find((item) => Math.abs(item.left - line.left) < 12);
    if (group) {
      group.lines.push(line);
    } else {
      groups.push({ left: line.left, lines: [line] });
    }
  }
  return groups
    .filter((group) => group.lines.length >= 3)
    .map((group) => ({
      left: Math.min(...group.lines.map((line) => line.left)),
      right: Math.max(...group.lines.map((line) => line.right)),
      top: Math.min(...group.lines.map((line) => line.top)),
    }))
    .filter((column) => column.right - column.left > pageWidth * 0.15)
    .sort((a, b) => a.left - b.left);
}

/**
 * 某一行属于哪一列（按行中心落在哪列的横向范围内）。
 * @param {Array} columns detectColumns 的结果
 * @param {object} line 文本行
 * @returns {object|undefined}
 */
function columnOf(columns, line) {
  const center = ((line.left ?? 0) + (line.right ?? 0)) / 2;
  return columns.find((column) => center >= column.left - 8 && center <= column.right + 8);
}


/**
 * 在某个纵向区间内，按墨迹找出这一块的横向范围。
 *
 * 为什么要它：图注常常比图窄，甚至只排在某一栏里，而图本身可能横跨两栏（LLM-RecG 的
 * Figure 1 就是这样）。按"图注的宽度"去裁会把图从中间切掉。
 *
 * 做法：把区间内的墨迹按列聚成若干段（容忍 40px 的小空隙），只取与图注横向有交集的那一段，
 * 再向外合并相邻段（空隙 < 40px）。两栏并排时中间的空隙通常更大，所以不会把邻栏的图卷进来。
 * @param {HTMLCanvasElement} canvas 页面画布
 * @param {number} y0 区间上边
 * @param {number} y1 区间下边
 * @param {number} captionLeft 图注左边界
 * @param {number} captionRight 图注右边界
 * @returns {{left:number,right:number}|null}
 */
function inkXRange(canvas, y0, y1, captionLeft, captionRight) {
  const top = Math.max(0, Math.round(y0));
  const bottom = Math.min(canvas.height, Math.round(y1));
  const height = bottom - top;
  if (height <= 0) return null;
  let data;
  try {
    data = canvas.getContext('2d').getImageData(0, top, canvas.width, height).data;
  } catch {
    return null;
  }
  const width = canvas.width;
  const ink = new Uint8Array(width);
  for (let row = 0; row < height; row += 1) {
    const base = row * width * 4;
    for (let col = 0; col < width; col += 1) {
      const offset = base + col * 4;
      if (data[offset] < 235 || data[offset + 1] < 235 || data[offset + 2] < 235) ink[col] = 1;
    }
  }
  // 聚成墨迹段（容忍 40px 空隙）
  const runs = [];
  let start = -1;
  let lastInk = -1;
  for (let col = 0; col < width; col += 1) {
    if (ink[col]) {
      if (start < 0) start = col;
      else if (col - lastInk > 40) {
        runs.push({ left: start, right: lastInk });
        start = col;
      }
      lastInk = col;
    }
  }
  if (start >= 0) runs.push({ left: start, right: lastInk });
  if (runs.length === 0) return null;
  // 与图注有交集的那一段；没有就用最宽的一段
  const overlapping = runs.filter((run) => run.right > captionLeft - 10 && run.left < captionRight + 10);
  const base = overlapping.length > 0
    ? { left: Math.min(...overlapping.map((run) => run.left)), right: Math.max(...overlapping.map((run) => run.right)) }
    : runs.reduce((wide, run) => (run.right - run.left > wide.right - wide.left ? run : wide), runs[0]);
  // 向两侧合并相邻段（空隙 < 40px），跨栏的整幅图因此能整体保留
  let left = base.left;
  let right = base.right;
  let changed = true;
  while (changed) {
    changed = false;
    for (const run of runs) {
      if (run.right < left && left - run.right <= 40) {
        left = run.left;
        changed = true;
      }
      if (run.left > right && run.left - right <= 40) {
        right = run.right;
        changed = true;
      }
    }
  }
  return { left: Math.max(0, left), right: Math.min(canvas.width, right + 1) };
}

/**
 * 把一块裁剪区域按"实际有墨迹的像素范围"收紧，去掉四周空白和相邻列的残留。
 * @param {HTMLCanvasElement} canvas 要裁剪的画布
 * @param {{x:number,y:number,w:number,h:number}} box 初始区域
 * @param {number} padding 收紧后留的边距
 * @returns {{x:number,y:number,w:number,h:number}} 收紧后的区域
 */
function trimToInk(canvas, box, padding = 6) {
  const x = Math.max(0, Math.round(box.x));
  const y = Math.max(0, Math.round(box.y));
  const w = Math.min(canvas.width - x, Math.round(box.w));
  const h = Math.min(canvas.height - y, Math.round(box.h));
  if (w < 8 || h < 8) return box;
  let data;
  try {
    data = canvas.getContext('2d').getImageData(x, y, w, h).data;
  } catch {
    return box;
  }
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let row = 0; row < h; row += 1) {
    for (let col = 0; col < w; col += 1) {
      const offset = (row * w + col) * 4;
      // 视作"有墨迹"的阈值：明显不是页面底色
      if (data[offset] < 235 || data[offset + 1] < 235 || data[offset + 2] < 235) {
        if (col < minX) minX = col;
        if (col > maxX) maxX = col;
        if (row < minY) minY = row;
        if (row > maxY) maxY = row;
      }
    }
  }
  if (maxX < 0) return box;
  return {
    x: Math.max(0, x + minX - padding),
    y: Math.max(0, y + minY - padding),
    w: Math.min(canvas.width, maxX - minX + 1 + padding * 2),
    h: Math.min(canvas.height, maxY - minY + 1 + padding * 2),
  };
}

/**
 * 抽取整篇论文。
 * @param {File|Blob} file
 * @param {(progress: { phase: string, page?: number, total?: number, figures?: number }) => void} [onProgress]
 * @returns {Promise<{ pages: Array, figures: Array, pdfBase64: string, pageCount: number }>}
 */
export async function extractPaper(file, onProgress = () => {}, options = {}) {
  let pdfjs;
  try {
    pdfjs = await loadPdfjs();
  } catch (error) {
    // 最常见的原因：装了新版本但没重启 DSH，宿主还在伺服旧一代代码，静态资源 404。
    // 直接把"该怎么办"写进错误里，别让用户对着一个 Module script failed to load 发愣。
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`pdf.js 资源加载失败（${reason}）。若刚更新过插件，请退出并重开 DSH 桌面应用一次。`);
  }
  ensureWorker(pdfjs);
  const buffer = await file.arrayBuffer();
  // 先编码再解析：pdf.js 会接管（detach）传给它的 ArrayBuffer，编码必须抢在前面。
  // 重新裁图时不需要整份 PDF 的 base64（几十 MB 的编码很费时间）
  const pdfBase64 = options.includePdf === false ? '' : buffer.byteLength <= 24 * 1024 * 1024 ? toBase64(buffer) : '';
  // 交给 pdf.js 的是一份拷贝，原件留着做 base64 与兜底。
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer.slice(0)), isEvalSupported: false }).promise;
  const totalPages = doc.numPages;
  const pageCount = Math.min(totalPages, MAX_PAGES);
  const pages = [];
  const figures = [];
  /** 全文章节标题（页码 + 标题），用来给每张图定位板块。 */
  const headings = [];
  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      onProgress({ phase: 'read', page: pageNumber, total: pageCount, figures: figures.length });
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const content = await page.getTextContent();
      const lines = toLines(content.items, viewport, pdfjs);
      pages.push({ page: pageNumber, text: lines.map((line) => line.text).join('\n') });
      // 顺手记下这一页的章节标题：图要标"这张图在 4.5 Results"，靠的就是它
      const heights = lines.map((line) => line.height).sort((a, b) => a - b);
      const bodyHeight = heights[Math.floor(heights.length / 2)] ?? 10;
      for (const label of sectionLabels(lines, bodyHeight)) headings.push({ page: pageNumber, label });

      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;

      // 只认"标签后还有正文"的行：正文里的交叉引用常常是单独一行 "Figure 1."，
      // 照单全收会裁出一块纯文字。标签后面至少要有 8 个字符才当图注。
      // 只认"标签后还有正文"的行：正文里的交叉引用常常是单独一行 "Figure 1."，
      // 全收会裁出一块纯文字。标签后面至少要有 8 个字符才当图注。
      const debugRows = [];
      const captions = lines
        .filter((line) => {
          const match = line.text.match(CAPTION_RE);
          if (!match) return false;
          return line.text.slice(match[0].length).trim().length >= 8;
        })
        .sort((a, b) => a.top - b.top);

      // 按"列"处理：双栏论文里左右两栏的图注在纵向是交错的，拿页面上"上一条图注"当
      // 上边界会把另一栏的内容卷进来（WeaveRec 的 Figure 5 就是这么被切坏的）。
      // 列 = 与这条图注横向有重叠的那些行，不需要额外的聚类，图注本身就横跨它所在的栏。
      const overlaps = (a, b) => a.right > b.left - 6 && a.left < b.right + 6;
      const contentTop = Math.min(...lines.map((line) => line.top), viewport.height * 0.06);
      // 页眉（会议名、论文标题那一行）不算图的一部分：按"横跨大半页宽 + 在页面顶部"识别
      const runningHeader = lines
        .filter((line) => line.top < viewport.height * 0.12 && line.right - line.left > viewport.width * 0.7)
        .reduce((bottom, line) => Math.max(bottom, line.bottom), 0);
      const headerBottom = Math.max(viewport.height * 0.05, runningHeader);

      captions.forEach((caption, index) => {
        if (figures.length >= MAX_FIGURES) return;
        const inColumn = lines.filter((line) => overlaps(line, caption));
        // 计算本列顶部时把页眉行排除在外，否则会议名/论文标题会被一起裁进图里
        const bodyLines = inColumn.filter((line) => line.top > headerBottom && line.bottom < viewport.height * 0.96);
        const columnTop = bodyLines.length > 0 ? Math.min(...bodyLines.map((line) => line.top)) : headerBottom;
        const aboveCaption = captions.slice(0, index).filter((other) => overlaps(other, caption)).pop();
        const x = Math.max(0, caption.left - 8);
        const w = Math.min(viewport.width, caption.right + 8) - x;
        if (w < 120) return;

        // 正文段落的一行通常很长，图里的标签/表格单元都很短：用它当"正文与图的分界"
        const isBodyLine = (line) => line.text.length >= 60;

        // 1) 常见排版：图在上、图注在下 —— 取本列里这条图注上方那一块，
        //    但上边界最多到最近的那一行正文，别把上一段话卷进来
        const lastBodyAbove = inColumn
          .filter((line) => line.bottom < caption.top - 2 && isBodyLine(line) && line.top > headerBottom)
          .sort((a, b) => b.bottom - a.bottom)[0];
        let bottom = caption.top - 6;
        let top = lastBodyAbove ? lastBodyAbove.bottom + 6 : aboveCaption ? aboveCaption.bottom + 6 : Math.max(0, columnTop - 6);
        let height = bottom - top;
        const maxHeight = viewport.height * 0.85;
        if (height > maxHeight) {
          top = bottom - maxHeight;
          height = maxHeight;
        }

        // 2) 表格类排版：图注在上、表在下 —— 上方几乎没有内容时，改取图注下方那一块，
        //    下边界是本列下一条图注的顶部，最多到页面底部
        if (height < 70) {
          const belowCaption = captions.slice(index + 1).find((other) => overlaps(other, caption));
          // 图注常常是好几行（"Table 1: ..." 后面还跟着两行说明），先把整个图注块算出来，
          // 免得把图注的续行当成"表格下面的正文"
          const lineHeight = Math.max(8, caption.bottom - caption.top);
          const sortedInColumn = inColumn.slice().sort((a, b) => a.top - b.top);
          // 用本列行距的中位数当"正常行距"：图注续行按正常行距排，表格表头隔得更远，
          // 于是表头不会被当成图注的一部分裁掉（SemaCDR Table 1 之前就是这么丢的表头）。
          const gaps = [];
          for (let i = 1; i < sortedInColumn.length; i += 1) {
            const gap = sortedInColumn[i].top - sortedInColumn[i - 1].bottom;
            if (gap > 0) gaps.push(gap);
          }
          gaps.sort((a, b) => a - b);
          const typicalGap = gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)] : lineHeight * 0.3;
          let captionBlockBottom = caption.bottom;
          for (const line of sortedInColumn) {
            if (line.top < captionBlockBottom - 1) continue;
            // 图注续行是成句的长文本；表格行/表头都是短片段，靠长度就能分开
            if (line.text.length < 55) break;
            if (line.top - captionBlockBottom > typicalGap * 2.5) break;
            captionBlockBottom = Math.max(captionBlockBottom, line.bottom);
          }
          // 表下方紧跟着正文时，下边界收在正文第一行之前
          const firstBodyBelow = inColumn
            .filter((line) => line.top > captionBlockBottom + lineHeight * 1.2 && isBodyLine(line))
            .sort((a, b) => a.top - b.top)[0];
          const limit = Math.min(
            viewport.height - 8,
            belowCaption ? belowCaption.top - 6 : viewport.height - 8,
            firstBodyBelow ? firstBodyBelow.top - 8 : viewport.height - 8,
          );
          top = captionBlockBottom + 6;
          height = limit - top;
          if (height > maxHeight) height = maxHeight;
          if (height < 60) {
            // 精修失败就退回"整列"的大块：宁可裁得略微保守，也不要整张图消失
            top = Math.max(headerBottom, columnTop - 6);
            height = viewport.height * 0.5;
            if (top + height > viewport.height - 8) height = viewport.height - 8 - top;
            if (height < 60) return;
          }
        }

        debugRows.push({
          caption: caption.text.slice(0, 26),
          top: Math.round(top),
          height: Math.round(height),
          lastBodyAbove: lastBodyAbove ? Math.round(lastBodyAbove.bottom) : null,
          columnTop: Math.round(columnTop),
          headerBottom: Math.round(headerBottom),
        });
        if (height < 60) return;
        try {
          // 图的横向范围以墨迹为准（图注可能比图窄，甚至只占一栏），再用墨迹包围盒收紧
          const bandTop = Math.max(0, top);
          const bandBottom = Math.max(bandTop + 1, bandTop + height);
          const range = inkXRange(canvas, bandTop, bandBottom, caption.left, caption.right);
          const inkLeft = range ? range.left : x;
          const inkWidth = range ? range.right - range.left : w;
          const tight = trimToInk(canvas, { x: inkLeft, y: bandTop, w: inkWidth, h: height });
          figures.push({
            caption: caption.text.slice(0, 400),
            page: pageNumber,
            dataUrl: crop(canvas, tight),
          });
        } catch {
          /* 单张图裁剪失败不影响整篇导入 */
        }
      });

      // 兜底：这一页没有任何图注（课件、海报、扫描版讲义常见）时，直接按"位图实际占的区域"裁。
      // 只取最大的几张，避免把图标、装饰条也变成图；标题行能对上就拿来当图注。
      if (captions.length === 0 && figures.length < MAX_FIGURES) {
        try {
          const operatorList = await page.getOperatorList();
          const rects = usableRects(imageRects(operatorList, viewport, pdfjs), viewport.width, viewport.height);
          for (const [index, rect] of rects.slice(0, 3).entries()) {
            if (figures.length >= MAX_FIGURES) break;
            const above = lines
              .filter((line) => line.bottom <= rect.y + 6)
              .sort((a, b) => b.bottom - a.bottom)[0];
            const caption =
              above && rect.y - above.bottom < 80
                ? above.text.slice(0, 400)
                : '';
            figures.push({
              caption,
              page: pageNumber,
              dataUrl: crop(canvas, {
                x: Math.max(0, rect.x - 4),
                y: Math.max(0, rect.y - 4),
                w: Math.min(viewport.width - Math.max(0, rect.x - 4), rect.w + 8),
                h: Math.min(viewport.height - Math.max(0, rect.y - 4), rect.h + 8),
              }),
            });
          }
        } catch {
          /* 拿不到绘图指令就当这页没有图，不影响文字 */
        }
      }
      if (pages.length > 0) pages[pages.length - 1].debug = debugRows;
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  // 给每张图补上"它在论文哪一节"（图注编号在渲染时从 caption 里解析）
  for (const figure of figures) {
    if (!figure.section) figure.section = sectionForPage(headings, figure.page);
  }
  onProgress({ phase: 'encode', total: pageCount, figures: figures.length });
  return { pages, figures, pdfBase64, pageCount: totalPages };
}
