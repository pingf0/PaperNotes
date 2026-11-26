/**
 * 把"一大段"解释文字折成适合阅读的短段落。
 *
 * 模型（和旧的启发式兜底）经常把 5-10 句塞进同一个段落，卡片上就是一坨文字。
 * Markdown 只认空行分段，所以这里在渲染前补上分段：
 *   - 已经分过段 / 已经是列表或代码块的，原样返回；
 *   - 太短的（< 90 字）不动；
 *   - 否则按句末标点切成句子，每 2 句、且累计 ≥ 60 字断一段，段间用空行。
 *
 * 用句号/问号/叹号/分号断开 —— 中文长句里分号常是并列要点，断在这里读起来最自然。
 *
 * @param {string} text 原始文字
 * @returns {string} 可能要分段的文字
 */
export function paragraphize(text) {
  const raw = String(text ?? '');
  const trimmed = raw.trim();
  if (trimmed.length < 90) return raw;
  if (/\n\s*\n/.test(raw)) return raw;
  if (/^\s*(?:[-*•]|\d+[.、)])\s/m.test(raw)) return raw;
  if (/^\s*#{1,6}\s/m.test(raw)) return raw;
  if (/```/.test(raw)) return raw;

  const sentences = trimmed.split(/(?<=[。！？；!?;])/).map((part) => part.trim()).filter(Boolean);
  if (sentences.length < 4) return raw;

  const paragraphs = [];
  let buffer = '';
  for (const sentence of sentences) {
    buffer += sentence;
    if (buffer.length >= 60) {
      paragraphs.push(buffer);
      buffer = '';
    }
  }
  if (buffer.length > 0) paragraphs.push(buffer);
  return paragraphs.length > 1 ? paragraphs.join('\n\n') : raw;
}
