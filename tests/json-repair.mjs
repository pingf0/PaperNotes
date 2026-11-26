/**
 * JSON 解析与"截断修复"的自检（不依赖模型）：
 * 模型输出经常带围栏、带前言、带尾逗号，甚至半截就被截断 —— 这些都要能救回来。
 */
import { parseJsonReply } from '../src/host/llm.js';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

const cases = [
  ['纯 JSON', '{"a":1}', (v) => v.a === 1],
  ['带围栏', '```json\n{"a":1}\n```', (v) => v.a === 1],
  ['前后有解释', '好的：{"a":1} 以上', (v) => v.a === 1],
  ['尾逗号', '{"a":[1,2,],}', (v) => v.a.length === 2],
  ['全角引号', '｛“a”:1｝'.replace(/｛/g, '{').replace(/｝/g, '}'), (v) => v.a === 1],
  ['截断的数组', '{"title":"x","questions":[{"question":"q"},{"question":"q2', (v) => v?.title === 'x' && Array.isArray(v?.questions)],
  ['截断的字符串', '{"title":"x","abstract":"说到一半', (v) => v?.title === 'x'],
  ['截断的嵌套', '{"questions":[{"experiments":[{"name":"e","text":"t"}],  "conclusion":"c"', (v) => v?.questions?.length === 1],
  ['彻底不是 JSON', '抱歉，我无法完成', (v) => v === undefined],
];
for (const [name, input, expect] of cases) {
  let parsed;
  try {
    parsed = parseJsonReply(input);
  } catch {
    parsed = undefined;
  }
  check(name, Boolean(expect(parsed)), JSON.stringify(parsed)?.slice(0, 60));
}

const failed = results.filter((item) => !item.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
