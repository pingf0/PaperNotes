/**
 * 纯空回复 / 推理占满 / reasoningEffort 三个边界的行为自检。
 * 用假 ctx 与假 llm 流，不需要真模型。
 *
 * 背景：用户遇到"模型没有返回文本"，而原来那句话既没说是超时、被截断还是只有推理，
 * 完全无法判断下一步该换模型还是缩问题。
 */
import { complete } from '../src/host/llm.js';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

/**
 * 造一个假 ctx。
 * @param {Array} chunks 假流要吐的 chunk
 * @param {{ efforts?: string[], capture?: object }} [options]
 */
function makeCtx(chunks, options = {}) {
  const captured = options.capture ?? {};
  return {
    get: (name) => {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
      if (name === 'llm') {
        return {
          stream: async function* stream(request) {
            captured.request = request;
            for (const chunk of chunks) yield chunk;
          },
          resolveModelInfo: async () => (options.efforts ? { reasoning: { efforts: options.efforts.map((id) => ({ id })) } } : {}),
        };
      }
      return undefined;
    },
  };
}

const base = { messages: [{ role: 'user', content: 'hi' }] };

// 1. 正常返回文本
const okRun = await complete(makeCtx([
  { type: 'text-delta', index: 0, text: '先给结论' },
  { type: 'text-delta', index: 0, text: '，再给依据。' },
  { type: 'finish', reason: 'stop' },
]), base);
check('有正文时正常返回', okRun.ok === true && okRun.text.includes('先给结论'));

// 2. 只有推理、且被长度截断：错误里要说清楚（finish.reason 是对象，不是字符串）
const reasoningOnly = await complete(makeCtx([
  { type: 'reasoning-delta', index: 0, text: '让我想想……' },
  { type: 'finish', reason: { kind: 'max-tokens' } },
]), base);
check(
  '只有推理时错误可诊断',
  reasoningOnly.ok === false && reasoningOnly.error.includes('finish=max-tokens') && reasoningOnly.error.includes('只有推理'),
  reasoningOnly.error,
);

// 3. 适配器报错：failure 的原文必须带出来，否则用户没法判断下一步
const failedRun = await complete(makeCtx([
  { type: 'finish', reason: { kind: 'error', failure: { code: 'PROVIDER_ERROR', status: 400, message: 'bad request: effort unsupported' } } },
]), base);
check(
  '适配器失败会带出 code/status/message',
  failedRun.ok === false && failedRun.error.includes('finish=error') && failedRun.error.includes('400') && failedRun.error.includes('bad request'),
  failedRun.error,
);

// 4. 完全空流
const empty = await complete(makeCtx([{ type: 'finish', reason: { kind: 'stop' } }]), base);
check('空流时说明没有收到正文', empty.ok === false && empty.error.includes('没有收到任何正文'), empty.error);

// 5. 显式要求关推理、且模型声明支持 off → 请求里要带
const capture = {};
await complete(makeCtx([{ type: 'text-delta', index: 0, text: 'x' }], { efforts: ['off', 'high'], capture }), { ...base, reasoningOff: true });
check('要求关推理且模型支持时传 off', capture.request?.reasoningEffort === 'off', String(capture.request?.reasoningEffort));

// 6. 默认不传（曾经能用，强行关推理反而会被适配器拒）
const captureDefault = {};
await complete(makeCtx([{ type: 'text-delta', index: 0, text: 'x' }], { efforts: ['off'], capture: captureDefault }), base);
check('默认不传 reasoningEffort', captureDefault.request?.reasoningEffort === undefined);

// 7. 要求关推理但模型不支持 → 也不能传
const capture2 = {};
await complete(makeCtx([{ type: 'text-delta', index: 0, text: 'x' }], { capture: capture2 }), { ...base, reasoningOff: true });
check('模型不支持时省略 reasoningEffort', capture2.request?.reasoningEffort === undefined);

// 8. 历史里的 assistant 消息必须带 source/id —— dsh-llm 的 forAdapter 会读 source.replayState
const capture3 = {};
await complete(
  makeCtx([{ type: 'text-delta', index: 0, text: 'x' }], { capture: capture3 }),
  {
    messages: [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '追问' },
    ],
  },
);
const assistantMessage = capture3.request?.messages?.find((message) => message.role === 'assistant');
check(
  'assistant 历史消息带 source 与 id',
  Boolean(assistantMessage?.source && assistantMessage?.id) && assistantMessage.source.kind === 'model',
  JSON.stringify(assistantMessage?.source),
);

// 9. 复刻 dsh-llm 的 forAdapter：旧形状必须抛，新形状必须不抛
function forAdapterLike(messages) {
  return messages.map((message) => {
    if (message.role !== 'assistant') return message;
    const source = message.source;
    // 这一行就是线上崩溃点：source 为 undefined 时读 replayState 会抛
    if (source.replayState === undefined) return message;
    return message;
  });
}
let oldShapeThrows = false;
try {
  forAdapterLike([{ role: 'assistant', content: [{ type: 'text', text: '旧实现' }] }]);
} catch {
  oldShapeThrows = true;
}
let newShapeThrows = false;
try {
  forAdapterLike(capture3.request.messages);
} catch {
  newShapeThrows = true;
}
check('旧形状（无 source）会复现线上崩溃', oldShapeThrows === true);
check('新形状（带 source）不再抛', newShapeThrows === false);

// 10. 空流不抛异常
const aborted = await complete(makeCtx([], {}), base).catch(() => null);
check('空流不抛异常', aborted !== null);

const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
