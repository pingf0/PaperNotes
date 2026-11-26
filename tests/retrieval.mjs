/**
 * 检索自检：证明"问到 λ 取值"时，含 λ=400 的那段正文会被挑出来。
 *
 * 背景：之前逐块提问不喂正文，模型只好凭印象补数字（实测把 permuted MNIST 的 λ=400
 * 说成了 0.4）。这里用真实论文正文验证检索能命中。
 *
 * 用法：node tests/retrieval.mjs [extract.json]
 */
import { readFileSync } from 'node:fs';
import { retrieveExcerpts } from '../src/host/chat.js';

const file = process.argv[2] ?? new URL('../.tmptest/out/extract.json', import.meta.url);
const extract = JSON.parse(readFileSync(file, 'utf8'));
const text = extract.allPages.map((page) => page.text).join('\n');
const paper = { title: 'Overcoming catastrophic forgetting in neural networks', text, blocks: [] };

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

// 与真实调用一致：节点标题 + 用户问题一起作为检索 query
const excerpt = retrieveExcerpts(paper, 'EWC 损失 第一个公式里的 lambda 在实验里取多少？', 8000);
check('检索返回了内容', excerpt.length > 500, `${excerpt.length} 字符`);
check('命中 λ 的具体取值', /\b400\b/.test(excerpt), excerpt.includes('400') ? '含 400' : '不含 400');
check('摘录里带 lambda 上下文', /lambda|λ/i.test(excerpt));
check('摘录长度受预算约束', excerpt.length <= 8100, `${excerpt.length}`);

// 中文提问 + 英文正文：应当仍能命中（靠英文术语或数字兜底）
const chinese = retrieveExcerpts(paper, 'permuted MNIST 上的结果如何？', 8000);
check('中文提问也能检索到正文', chinese.length > 300, `${chinese.length} 字符`);

// 没有正文时不崩、返回空串
check('无正文时返回空串', retrieveExcerpts({ title: 'x' }, '随便问') === '');

const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
