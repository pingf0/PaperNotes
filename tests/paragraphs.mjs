/**
 * 段落化工具的自检：纯函数，不依赖宿主。
 * 用法：node tests/paragraphs.mjs
 */
import { paragraphize } from '../src/client/paragraphs.js';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

const long =
  '该式将跨域融合序列、混合域序列和用户或混合域表示加权组合。α、β、γ为可学习权重。'
  + '神经网络顺序学习多个任务时会灾难性遗忘：新任务一训练，旧任务的性能就塌掉。'
  + '但很多场景（隐私、存储、算力）不允许保留旧数据做联合训练。'
  + '所以需要一种不回放旧数据的持续学习办法；这也是本文的出发点。';
const split = paragraphize(long);
check('一大段会按句子折成多段', split.split(/\n\s*\n/).length >= 2, `${split.split(/\n\s*\n/).length} 段`);
check('分段后内容不丢字', split.replace(/\s+/g, '') === long.replace(/\s+/g, ''));

const already = '第一段，已经分好了。\n\n第二段，也是现成的。\n\n第三段。';
check('已经分过段的不动', paragraphize(already) === already);

const list = '- 要点一\n- 要点二\n- 要点三';
check('列表不动', paragraphize(list) === list);

const short = '一句话，很短。';
check('太短的不动', paragraphize(short) === short);

const code = '```js\nconst a = 1;\n```';
check('代码块不动', paragraphize(code) === code);

const empty = paragraphize(undefined);
check('空值不炸', empty === '');

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) process.exit(1);
