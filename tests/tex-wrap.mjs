/**
 * 正文里裸 LaTeX 的自动识别自检。
 *
 * 直接从 runtime.js 里抠出 wrapBareTex 的实现来跑（runtime.js 还依赖 KaTeX 的 CSS 文本，
 * 在纯 Node 里 import 不了），这样测的就是线上真正跑的那段代码。
 */
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/client/runtime.js', import.meta.url), 'utf8');
const start = source.indexOf('export function wrapBareTex');
const end = source.indexOf('/** 一行里可能出现的裸 LaTeX 片段');
const fnSource = source.slice(start, end).replace('export function', 'function');
const rest = source.slice(end);
const constEnd = rest.indexOf('/** 极简 markdown');
const consts = rest.slice(0, constEnd);

// eslint-disable-next-line no-new-func -- 测试里只跑纯函数
const wrapBareTex = new Function(`${consts.replace(/\bexport\s+/g, '')}\n${fnSource}\nreturn wrapBareTex;`)();

const cases = [
  {
    name: '裸公式被包上定界符',
    input: 'α、β、γ为可学习权重。\\mathbf{z}_u^{final}随后用于计算目标item的偏好得分。',
    expect: (out) => out.includes('$\\mathbf{z}_u^{final}$') && out.includes('随后用于计算'),
  },
  {
    name: '已经在 $...$ 里的不动',
    input: '已经是 $\\alpha + \\beta$ 不要重复包裹',
    expect: (out) => out === '已经是 $\\alpha + \\beta$ 不要重复包裹',
  },
  {
    name: 'Windows 路径不被误判',
    input: '路径 C:\\Users\\name 保持原样',
    expect: (out) => out === '路径 C:\\Users\\name 保持原样',
  },
  {
    name: '普通下划线标识符不被误判',
    input: '字段 file_name 与 user_id 保持原样',
    expect: (out) => out === '字段 file_name 与 user_id 保持原样',
  },
  {
    name: '已知命令即使没有上下标也识别',
    input: '系数 \\lambda 控制强度',
    expect: (out) => out.includes('$\\lambda$'),
  },
  {
    name: '带花括号的命令识别',
    input: '得分 \\frac{a}{b} 归一化',
    expect: (out) => out.includes('$\\frac{a}{b}$'),
  },
];

let failed = 0;
for (const item of cases) {
  const out = wrapBareTex(item.input);
  const ok = item.expect(out);
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${item.name}${ok ? '' : ` — ${JSON.stringify(out)}`}`);
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
