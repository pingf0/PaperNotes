/**
 * 自定义接口（OpenAI 兼容）的自检：起一个假的 /chat/completions，验证流式拼装、错误处理与鉴权头。
 * 不需要真 key、不联网。
 */
import { createServer } from 'node:http';
import { streamChat, testConnection } from '../src/host/openai.js';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

let lastAuth = '';
let mode = 'ok';
const server = createServer((req, res) => {
  lastAuth = String(req.headers.authorization ?? '');
  if (mode === 'error') {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const frame = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  frame({ choices: [{ delta: { reasoning_content: '想一下…' } }] });
  frame({ choices: [{ delta: { content: '结论' } }] });
  frame({ choices: [{ delta: { content: '：可用' } }] });
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

const events = [];
const ok = await streamChat(
  { baseUrl, apiKey: 'sk-test', model: 'test-model' },
  { system: '系统提示', messages: [{ role: 'user', content: '你好' }], temperature: 0.3 },
  (event) => events.push(event),
);
check('流式：拼出完整文本', ok.ok && ok.text === '结论：可用', JSON.stringify(ok).slice(0, 80));
check('流式：reasoning 也回调', events.some((event) => event.type === 'reasoning' && event.text === '想一下…'));
check('流式：正文分片回调', events.filter((event) => event.type === 'text').length === 2, String(events.length));
check('鉴权头带上了 key', lastAuth === 'Bearer sk-test', lastAuth);

mode = 'error';
const failed = await streamChat({ baseUrl, apiKey: 'bad', model: 'm' }, { messages: [{ role: 'user', content: 'x' }] });
check('错误：401 会带出服务端 message', !failed.ok && /invalid api key/.test(failed.error ?? ''), String(failed.error).slice(0, 60));

mode = 'ok';
const probe = await testConnection({ baseUrl, apiKey: 'sk-test', model: 'test-model' });
check('连通性测试：返回耗时与回复', probe.ok && typeof probe.ms === 'number' && /可用/.test(probe.text ?? ''), JSON.stringify(probe).slice(0, 60));

const offline = await streamChat({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', model: 'm' }, { messages: [{ role: 'user', content: 'x' }] });
check('连不上时给出可读错误', !offline.ok && /连不上/.test(offline.error ?? ''), String(offline.error).slice(0, 60));

server.close();
const failedCount = results.filter((item) => !item.ok).length;
console.log(`\n${results.length - failedCount}/${results.length} 通过`);
process.exit(failedCount === 0 ? 0 : 1);
