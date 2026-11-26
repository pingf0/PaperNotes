/**
 * PaperNotes（dsh-paper-desk）Host 插件入口。
 *
 * 只做三件事：声明插件名、把一个 prefix 路由挂到 DSH WebServer、把路由上下文交给 server.js。
 * 所有业务在 src/host/ 下：store.js 管数据目录与读写，llm.js 包一层 ctx.llm，
 * import.js 把 PDF 抽取结果整理成节点，chat.js 处理逐节点会话 / 笔记浓缩 / core 核 / 对比会话。
 */
import { createServer } from './src/host/server.js';

/** 插件行 id（与 cordis.patch.yml 一致）。 */
export const name = 'dsh-paper-desk';

/**
 * 必需服务只有 WebServer。
 * llm / agentDefaultModel 用 ctx.get 在读时取：模型没配好时插件仍应能打开论文库、看笔记，
 * 只在真正要生成时报告"模型不可用"。
 */
export const inject = ['webServer'];

/** 路由前缀（带随机后缀，避免和其它插件的路径撞车）。 */
export const ROUTE_PREFIX = '/dsh-paper-desk-4821';

/**
 * 挂载插件。
 * @param ctx - Cordis 宿主上下文。
 */
export function apply(ctx) {
  const server = createServer(ctx, ROUTE_PREFIX);
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: server }),
    'dsh-paper-desk: routes',
  );
  ctx.logger?.info?.('[dsh-paper-desk] PaperNotes 已挂载：' + ROUTE_PREFIX);
}
