/**
 * 图的"身份标签"：`Figure 2 · §4.5 Results`。
 *
 * 编号从图注里解析（Figure / Fig. / Table / 图 / 表），板块来自导入时按页推断的
 * `figure.section`（pdf.js 抽页时顺手记下章节标题）。两者都没有就退回页码。
 *
 * @param {{ caption?: string, section?: string, page?: number }|undefined} figure
 * @returns {string} 形如 `Figure 2 · §4.5 Results`，拿不到信息时返回空串
 */
export function figureLabel(figure) {
  if (!figure) return '';
  const match = String(figure.caption ?? '').match(/^(figure|fig\.?|table|图|表)\s*([0-9]{1,2}|[IVX]{1,4})/i);
  const head = match ? `${/(table|表)/i.test(match[1]) ? 'Table' : 'Figure'} ${match[2]}` : '';
  const section = String(figure.section ?? '').trim();
  if (head && section) return `${head} · §${section}`;
  if (head) return head;
  if (section) return `§${section}`;
  return figure.page ? `第 ${figure.page} 页` : '';
}

/**
 * 只取编号：`Figure 2` / `Table 1`（不带 §板块）。图表标签用来拼句子时更顺。
 * @param {{ caption?: string }|undefined} figure
 * @returns {string}
 */
export function figureName(figure) {
  const match = String(figure?.caption ?? '').match(/^(figure|fig\.?|table|图|表)\s*([0-9]{1,2}|[IVX]{1,4})/i);
  if (!match) return '';
  return `${/(table|表)/i.test(match[1]) ? 'Table' : 'Figure'} ${match[2]}`;
}
