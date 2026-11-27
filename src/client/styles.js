/**
 * 论文台的样式表（一段 CSS 文本，由 <style> 元素挂到 document.head，卸载时移除）。
 *
 * 只用 --dsw-alias-* 主题变量，跟随 DSH 的明暗与品牌色；字面色只出现在图的边框、
 * 节点左侧的类别色条这类"内容标记"上。类名统一 pd- 前缀，避免和宿主撞车。
 * 变量都带兜底值：某个 token 在新版本被改名时，只会掉一档观感，不会让布局崩掉。
 */
export const CSS = `
/* 主面板页：占满 main 区域，自己管滚动；不覆盖宿主任何自有控件。 */
.pd-page {
  /* macOS 用系统字体，Windows 退到 Segoe UI / 微软雅黑 */
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
    "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  position: relative;
  display: flex; flex-direction: column;
  width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden;
  background: var(--dsw-alias-bg-base, #ffffff);
  color: var(--dsw-alias-label-primary, #1a1a1a);
  font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
.pd-page * { box-sizing: border-box; }
.pd-top {
  display: flex; align-items: center; gap: 10px;
  /* 左侧留白要避开窗口左上角的红绿灯与侧边栏开关：
     macOS 收起侧边栏时，宿主会在 frame 上发布 --dsh-frame-leading-clearance
     （160px，全屏时 84px），主面板内容需要自己让开这一段。 */
  padding: 12px 16px 12px calc(16px + var(--dsh-frame-leading-clearance, 0px));
  border-bottom: 1px solid var(--dsw-alias-border-l1, #e6e6e6);
  background: var(--dsw-alias-bg-base, #ffffff); flex: none;
}
/* 让开的距离已经由 padding-left 承担，标题本身不要再额外缩进 */
.pd-top > .pd-title { min-width: 0; }
.pd-title { font-size: 14px; font-weight: 600; letter-spacing: .01em; }
.pd-sub { color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 12px; }
.pd-grow { flex: 1; min-width: 0; }
.pd-body { flex: 1; display: flex; min-height: 0; }

.pd-btn {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px;
  border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2, #dcdcdc);
  background: var(--dsw-alias-bg-layer-2, #ffffff); color: inherit;
  font-size: 12px; cursor: pointer; white-space: nowrap;
}
.pd-btn:hover { background: var(--dsw-alias-interactive-bg-hover, #f0f0f0); }
.pd-btn:disabled { opacity: .5; cursor: not-allowed; }
/* 实心主按钮固定用中蓝 + 白字：深色模式下 brand-primary 常是浅蓝，
   白字压上去就糊成一片（用户反馈"导入论文"看不清）。 */
.pd-btn-primary {
  background: #2f6fd0; border-color: transparent; color: #fff;
}
.pd-btn-primary:hover { background: #3b7ddd; }
.pd-btn-primary:disabled { background: #2f6fd0; color: #fff; }
.pd-btn-ghost { border-color: transparent; background: transparent; }
.pd-btn-ghost:hover { background: var(--dsw-alias-interactive-bg-hover, #f0f0f0); }
.pd-btn-sm { height: 24px; padding: 0 8px; font-size: 11px; border-radius: 6px; }
.pd-danger { color: var(--dsw-alias-state-error-primary, #c0392b); }

.pd-side {
  width: 216px; flex: none; border-right: 1px solid var(--dsw-alias-border-l1, #e6e6e6);
  display: flex; flex-direction: column; background: var(--dsw-alias-bg-layer-1, #fafafa);
  min-height: 0;
}
.pd-side-head { padding: 10px 12px 6px; display: flex; align-items: center; gap: 6px; }
.pd-side-label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--dsw-alias-label-tertiary, #8a8a8a); flex: 1; }
.pd-cats { overflow-y: auto; padding: 4px 8px 12px; flex: 1; }
.pd-cat {
  display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 7px;
  cursor: pointer; color: var(--dsw-alias-label-secondary, #555);
}
.pd-cat:hover { background: var(--dsw-alias-interactive-bg-hover, #eeeeee); }
.pd-cat.is-active { background: var(--dsw-alias-interactive-bg-active, #e8eef8); color: var(--dsw-alias-brand-primary, #2f6fd0); font-weight: 600; }
.pd-cat-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pd-cat-count { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8a8a); }
.pd-cat-edit { opacity: 0; }
.pd-cat:hover .pd-cat-edit { opacity: 1; }

.pd-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.pd-toolbar {
  display: flex; align-items: center; gap: 8px; padding: 8px 12px; flex: none;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #ececec);
}
.pd-scroll { overflow-y: auto; flex: 1; padding: 14px 16px 40px; }

.pd-paper {
  display: grid; grid-template-columns: 84px minmax(0, 1fr) 128px; gap: 12px;
  padding: 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1, #ececec);
  background: var(--dsw-alias-bg-layer-2, #fff); margin-bottom: 10px; cursor: pointer;
}
.pd-paper:hover { border-color: var(--dsw-alias-border-l3, #c9d6e6); box-shadow: 0 1px 6px rgba(20,40,70,.06); }
.pd-paper.is-selected { border-color: var(--dsw-alias-brand-primary, #2f6fd0); box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary, #2f6fd0) inset; }
.pd-thumb {
  width: 84px; height: 64px; border-radius: 7px; overflow: hidden; background: var(--dsw-alias-bg-layer-1, #f4f4f4);
  display: flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-tertiary, #aaa); font-size: 11px;
}
.pd-thumb img { width: 100%; height: 100%; object-fit: cover; object-position: top center; }
.pd-paper-title { font-weight: 600; font-size: 13px; line-height: 1.45; margin-bottom: 3px; }
.pd-paper-desc { color: var(--dsw-alias-label-secondary, #666); font-size: 12px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.pd-paper-meta { display: flex; gap: 8px; margin-top: 6px; color: var(--dsw-alias-label-tertiary, #999); font-size: 11px; flex-wrap: wrap; }
.pd-paper-right { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; justify-content: space-between; }
.pd-time { font-size: 11px; color: var(--dsw-alias-label-tertiary, #999); white-space: nowrap; }
.pd-time.is-stale { color: var(--dsw-alias-state-warn-primary, #b7791f); font-weight: 600; }
.pd-chip {
  display: inline-flex; align-items: center; gap: 4px; height: 19px; padding: 0 7px; border-radius: 999px;
  font-size: 11px; background: var(--dsw-alias-bg-layer-1, #f2f2f2); color: var(--dsw-alias-label-secondary, #666);
  border: 1px solid var(--dsw-alias-border-l1, #e8e8e8);
}
.pd-menu {
  position: fixed; z-index: 95; box-sizing: border-box; padding: 6px;
  display: flex; flex-direction: column; gap: 1px; max-height: 80vh; overflow-y: auto;
  background: var(--dsw-alias-bg-layer-2, #ffffff); border: 1px solid var(--dsw-alias-border-l2, #dcdcdc);
  border-radius: 10px; box-shadow: 0 10px 30px rgba(10, 20, 40, .18);
}
.pd-menu-title {
  padding: 4px 8px 6px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #999);
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pd-menu-label { padding: 4px 8px 2px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #999); }
.pd-menu-item {
  text-align: left; border: 0; background: transparent; color: inherit; font: inherit; font-size: 12.5px;
  padding: 6px 8px; border-radius: 6px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pd-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover, #f0f0f0); }
.pd-menu-item.is-current { color: var(--dsw-alias-brand-primary, #2f6fd0); font-weight: 600; }
.pd-menu-sep { height: 1px; margin: 4px 2px; background: var(--dsw-alias-border-l1, #ececec); }

.pd-notice {
  display: flex; align-items: center; gap: 10px; padding: 9px 12px; margin-bottom: 10px; border-radius: 9px;
  background: var(--dsw-alias-state-warn-tertiary, #fff7e6);
  border: 1px solid var(--dsw-alias-state-warn-secondary, #f0d9a8);
  color: var(--dsw-alias-state-warn-label, #8a5a00); font-size: 12px;
}
.pd-notice-text { flex: 1; line-height: 1.6; }
.pd-notice-error {
  /* 真实主题里 state-error-secondary 是饱和红（不是淡底），直接当背景会红底红字；
     这里退成 12% 红色蒙层，明暗两套都靠 -primary 当前景色。 */
  background: rgba(239, 68, 68, .12);
  border-color: rgba(239, 68, 68, .45);
  color: var(--dsw-alias-state-error-primary, #a12a20);
}
.pd-empty { padding: 46px 20px; text-align: center; color: var(--dsw-alias-label-tertiary, #999); font-size: 13px; }

.pd-canvas {
  position: relative; flex: 1; overflow: hidden; min-height: 0; cursor: grab;
  background:
    radial-gradient(circle at 1px 1px, var(--dsw-alias-border-l1, #e5e5e5) 1px, transparent 0) 0 0 / 22px 22px,
    var(--dsw-alias-bg-base, #fff);
}
.pd-canvas.is-panning { cursor: grabbing; }
.pd-zoom {
  display: flex; align-items: center; gap: 2px; padding: 2px;
  border: 1px solid var(--dsw-alias-border-l1, #e6e6e6); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, #fafafa);
}
.pd-zoom .pd-btn { min-width: 24px; justify-content: center; }
.pd-zoom-value { min-width: 44px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, #555); }
.pd-canvas-inner { position: absolute; inset: 0; transform-origin: 0 0; }
.pd-edges { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.pd-edge-hit { pointer-events: stroke; cursor: pointer; }
.pd-node {
  position: absolute; border-radius: 10px; background: var(--dsw-alias-bg-layer-2, #fff);
  border: 1px solid var(--dsw-alias-border-l2, #dcdcdc);
  box-shadow: 0 1px 3px rgba(16,32,56,.06); display: flex; flex-direction: column;
}
.pd-node.is-active { border-color: var(--dsw-alias-brand-primary, #2f6fd0); box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary, #2f6fd0); }
.pd-node-head {
  display: flex; align-items: center; gap: 6px; padding: 7px 9px; cursor: grab;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #efefef); user-select: none;
  border-radius: 10px 10px 0 0; background: var(--dsw-alias-bg-layer-1, #fafafa);
}
.pd-node-head:active { cursor: grabbing; }
.pd-node-title { font-weight: 600; font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pd-node-body { padding: 9px; font-size: 12px; color: var(--dsw-alias-label-secondary, #444); overflow: hidden; min-height: 0; }
/* 手动拉过高度后，正文在节点内滚动，不再被裁掉 */
.pd-node[style*="height"] .pd-node-body { overflow: auto; }
.pd-node-text { white-space: pre-wrap; word-break: break-word; }
/* 节点正文走 markdown 渲染：段落自带换行，不能再叠加 pre-wrap 的空行 */
.pd-md-host { white-space: normal; }
.pd-md-host .pd-md-p { margin: 0 0 5px; }
.pd-md-host .pd-md-p:last-child { margin-bottom: 0; }
.pd-md-host .pd-md-h { font-size: 12.5px; margin: 6px 0 3px; }
.pd-md-host .pd-md-ul { margin: 0 0 5px; padding-left: 16px; }
.pd-node-figure { width: 100%; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1, #eee); display: block; cursor: zoom-in; }
/* 图下面那行"这张图在论文哪一节"：Figure 2 · §4.5 Results */
.pd-node-figure-box { display: flex; flex-direction: column; min-width: 0; }
.pd-fig-cap {
  margin-top: 5px; font-size: 10.5px; line-height: 1.5; letter-spacing: .01em;
  color: var(--dsw-alias-label-tertiary, #9a9a9a);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pd-node-meta { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #9a9a9a); margin-bottom: 4px; }
/* 公式节点：作用在原理图的哪一部分 */
.pd-node-where {
  display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
  margin-top: 4px; font-size: 11px; line-height: 1.55;
  color: var(--dsw-alias-label-secondary, #5f5f5f);
}
.pd-where-link {
  border: 0; padding: 0; background: transparent; cursor: pointer;
  font: inherit; font-size: 11px; line-height: 1.55;
  color: var(--dsw-alias-brand-primary, #1f5fd0);
  text-decoration: underline dotted;
}
.pd-where-link:hover { text-decoration: underline solid; }
/* 图库：缩略图网格（之前没有样式，图片会按原始尺寸把弹窗撑爆） */
.pd-figure-picker { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 8px; }
.pd-figure-option {
  display: flex; flex-direction: column; gap: 4px; padding: 6px; min-width: 0;
  border: 1px solid var(--dsw-alias-border-l2, #dcdcdc); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-secondary, #666);
  font: inherit; font-size: 11px; cursor: pointer; text-align: center;
}
.pd-figure-option img { width: 100%; height: 62px; object-fit: contain; border-radius: 4px; background: #fff; display: block; }
.pd-figure-option.is-picked { border-color: #2f6fd0; box-shadow: 0 0 0 2px rgba(47, 111, 208, .22); }
.pd-fig-option-cap { font-size: 10px; color: var(--dsw-alias-label-tertiary, #9a9a9a); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pd-formula { margin-bottom: 6px; overflow-x: auto; overflow-y: hidden; }
.pd-formula .katex { font-size: 1.08em; }
.pd-formula .katex-display { margin: .2em 0; }
.pd-node-latex {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
  background: var(--dsw-alias-markdown-code-block, #f5f6f8); border-radius: 6px; padding: 7px 8px;
  margin-bottom: 6px; word-break: break-all; white-space: pre-wrap;
}
/* 节点尺寸：八向透明命中区。只有光标变化，没有任何视觉装饰（边框/方块都不画）。 */
.pd-rs { position: absolute; z-index: 4; }
.pd-rs-n { top: -4px; left: 12px; right: 12px; height: 8px; cursor: ns-resize; }
.pd-rs-s { bottom: -4px; left: 12px; right: 12px; height: 8px; cursor: ns-resize; }
.pd-rs-e { top: 40px; bottom: 12px; right: -4px; width: 8px; cursor: ew-resize; }
.pd-rs-w { top: 40px; bottom: 12px; left: -4px; width: 8px; cursor: ew-resize; }
.pd-rs-ne { top: -4px; right: -4px; width: 12px; height: 12px; cursor: nesw-resize; }
.pd-rs-nw { top: -4px; left: -4px; width: 12px; height: 12px; cursor: nwse-resize; }
.pd-rs-se { bottom: -4px; right: -4px; width: 12px; height: 12px; cursor: nwse-resize; }
.pd-rs-sw { bottom: -4px; left: -4px; width: 12px; height: 12px; cursor: nesw-resize; }

.pd-port {
  position: absolute; width: 11px; height: 11px; border-radius: 50%;
  background: var(--dsw-alias-bg-layer-2, #fff); border: 2px solid var(--dsw-alias-brand-primary, #2f6fd0);
  cursor: crosshair; z-index: 3;
}
.pd-port-in { left: -6px; top: 22px; }
.pd-port-out { right: -6px; top: 22px; }

.pd-drawer {
  position: relative; flex: none;
  border-left: 1px solid var(--dsw-alias-border-l4, #c2ccd9);
  box-shadow: -8px 0 14px -10px rgba(10, 20, 40, .28);
  display: flex; flex-direction: column; min-height: 0; background: var(--dsw-alias-bg-layer-1, #fcfcfc);
}
/* 左边缘的拖拽把手：6px 命中区，中间一条 1px 的高亮提示可拖 */
.pd-drawer-resizer { position: absolute; left: -3px; top: 0; bottom: 0; width: 7px; cursor: col-resize; z-index: 4; }
.pd-collapse-btn {
  flex: none; display: inline-flex; align-items: center; gap: 5px;
  border: 0; background: transparent; color: var(--dsw-alias-label-tertiary, #999);
  padding: 8px 10px; cursor: pointer; font: inherit; font-size: 12px;
}
.pd-collapse-btn:hover { color: var(--dsw-alias-label-primary, #222); background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.pd-dropdown { position: relative; min-width: 0; }
.pd-dropdown-trigger {
  display: flex; align-items: center; gap: 6px; width: 100%; max-width: 100%;
  border: 1px solid var(--dsw-alias-border-l2, #dcdcdc); background: var(--dsw-alias-bg-layer-2, #fff);
  border-radius: 7px; padding: 4px 8px; cursor: pointer; font: inherit; font-size: 11.5px;
  color: var(--dsw-alias-label-secondary, #555); text-align: left;
  transition: border-color .15s ease, background .15s ease;
}
.pd-dropdown-trigger:hover { border-color: var(--dsw-alias-border-l4, #c2ccd9); }
.pd-dropdown-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pd-dropdown-caret { flex: none; opacity: .6; transition: transform .18s ease; }
.pd-dropdown-caret.is-open { transform: rotate(180deg); }
@keyframes pd-pop { from { opacity: 0; transform: translateY(-4px) scale(.98); } to { opacity: 1; transform: none; } }
.pd-dropdown-menu {
  position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 20;
  background: var(--dsw-alias-bg-layer-2, #fff); border: 1px solid var(--dsw-alias-border-l2, #dcdcdc);
  border-radius: 9px; box-shadow: 0 10px 26px rgba(16,32,56,.16);
  max-height: 260px; overflow-y: auto; padding: 4px;
  animation: pd-pop .16s ease-out; transform-origin: top center;
}
.pd-dropdown-group + .pd-dropdown-group { margin-top: 2px; border-top: 1px solid var(--dsw-alias-border-l1, #eee); padding-top: 2px; }
.pd-dropdown-group-label {
  padding: 5px 8px 3px; font-size: 10.5px; letter-spacing: .02em;
  color: var(--dsw-alias-label-tertiary, #9a9a9a);
}
.pd-dropdown-item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  border: 0; background: transparent; border-radius: 6px; padding: 6px 8px;
  font: inherit; font-size: 11.5px; text-align: left; cursor: pointer; color: var(--dsw-alias-label-primary, #222);
}
.pd-dropdown-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.pd-dropdown-item.is-active { color: var(--dsw-alias-brand-primary, #2f6fd0); font-weight: 600; }
.pd-dropdown-item-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pd-scope-row {
  display: flex; align-items: center; gap: 8px; padding: 7px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #eee);
}
.pd-scope-label { font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #8a8a8a); flex: none; }
.pd-scope-row .pd-dropdown { flex: 1; }
.pd-scope-dropdown .pd-dropdown-menu { min-width: 260px; right: auto; width: max-content; max-width: 420px; }
.pd-model-dropdown { flex: none; width: auto; max-width: 200px; }
.pd-model-dropdown .pd-dropdown-trigger { background: transparent; border-color: transparent; }
.pd-model-dropdown .pd-dropdown-trigger:hover { border-color: var(--dsw-alias-border-l2, #dcdcdc); }
.pd-model-dropdown .pd-dropdown-menu { left: 0; right: auto; width: 260px; }
.pd-paper-row-actions { display: flex; gap: 6px; margin-top: 6px; }
.pd-paper-list { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; min-height: 0; }
.pd-paper-row {
  text-align: left; border: 1px solid var(--dsw-alias-border-l2, #dcdcdc); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, #fff); padding: 8px 10px; cursor: pointer; font: inherit;
  transition: border-color .15s ease, background .15s ease;
}
.pd-paper-row:hover { border-color: var(--dsw-alias-brand-primary, #2f6fd0); background: color-mix(in srgb, var(--dsw-alias-brand-primary, #2f6fd0) 6%, transparent); }
.pd-paper-row-title { font-size: 12px; font-weight: 600; line-height: 1.45; color: var(--dsw-alias-label-primary, #222); }
.pd-paper-row-sub {
  margin-top: 3px; font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-tertiary, #8a8a8a);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.pd-collapse-btn.is-on { color: var(--dsw-alias-brand-primary, #2f6fd0); }
.pd-collapse-count {
  font-size: 10px; line-height: 1; padding: 2px 4px; border-radius: 6px;
  background: var(--dsw-alias-brand-primary, #2f6fd0); color: #fff;
}
.pd-msgs { scroll-behavior: smooth; overscroll-behavior: contain; }
/* 新消息淡入上浮，滚到底也是滑过去的 —— 会话有"在长出来"的感觉 */
@keyframes pd-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.pd-msg { animation: pd-rise .22s ease-out; }
.pd-drawer-reopen {
  flex: none; width: 28px; border: 0; border-left: 1px solid var(--dsw-alias-border-l1, #e6e6e6);
  background: var(--dsw-alias-bg-layer-1, #fcfcfc); color: var(--dsw-alias-label-secondary, #555);
  cursor: pointer; writing-mode: vertical-rl; letter-spacing: .08em; font-size: 12px; padding: 10px 0;
}
.pd-drawer-reopen:hover { background: var(--dsw-alias-interactive-bg-hover, #f0f0f0); color: var(--dsw-alias-label-primary, #222); }
.pd-tabs { display: flex; border-bottom: 1px solid var(--dsw-alias-border-l1, #e6e6e6); flex: none; }
.pd-tab {
  flex: 1; padding: 9px 6px; text-align: center; font-size: 12px; cursor: pointer;
  color: var(--dsw-alias-label-secondary, #666); border-bottom: 2px solid transparent;
}
.pd-tab.is-active { color: var(--dsw-alias-brand-primary, #2f6fd0); border-bottom-color: var(--dsw-alias-brand-primary, #2f6fd0); font-weight: 600; }
.pd-drawer-body { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.pd-scope { padding: 7px 12px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #999); border-bottom: 1px dashed var(--dsw-alias-border-l1, #eee); flex: none; }
.pd-msgs { flex: 1; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.pd-msg { position: relative; border-radius: 9px; padding: 7px 9px; font-size: 12px; max-width: 100%; word-break: break-word; }
.pd-msg-copy {
  position: absolute; right: 2px; bottom: -9px; width: 20px; height: 20px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1, #e6e6e6); background: var(--dsw-alias-bg-layer-2, #fff);
  color: var(--dsw-alias-label-tertiary, #888); cursor: pointer;
  opacity: 0; transition: opacity .12s;
}
.pd-msg:hover .pd-msg-copy, .pd-msg-copy.is-copied { opacity: 1; }
.pd-msg-copy:hover { color: var(--dsw-alias-label-primary, #222); background: var(--dsw-alias-interactive-bg-hover, #f0f0f0); }
.pd-msg-copy.is-copied { color: var(--dsw-alias-brand-primary, #2f6fd0); border-color: currentColor; }
.pd-msg-user { background: var(--dsw-alias-interactive-bg-active, #e8eef8); align-self: flex-end; }
.pd-msg-ai { background: var(--dsw-alias-bg-layer-2, #fff); border: 1px solid var(--dsw-alias-border-l1, #eee); align-self: flex-start; }
/* 统一输入框：多行输入 + 底部一行（模型 / 清空 / 停止 / 发送），像一个缩小版的对话栏 */
.pd-compose {
  margin: 8px 10px 10px; padding: 8px 8px 6px; flex: none;
  display: flex; flex-direction: column; gap: 4px;
  border: 1px solid var(--dsw-alias-border-l2, #dcdcdc); border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2, #ffffff);
}
.pd-compose:focus-within { border-color: var(--dsw-alias-brand-primary, #2f6fd0); box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary, #2f6fd0); }
.pd-compose-input {
  border: 0; outline: none; background: transparent; resize: none; color: inherit; font: inherit;
  min-height: 54px; max-height: 160px; padding: 2px 4px; line-height: 1.6;
}
.pd-compose-bar { display: flex; align-items: center; gap: 6px; min-height: 26px; }
.pd-model {
  height: 24px; max-width: 170px; padding: 0 4px; border: 0; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-secondary, #555); font: inherit; font-size: 11.5px; cursor: pointer;
}
.pd-model:hover { background: var(--dsw-alias-interactive-bg-hover, #f0f0f0); }
.pd-send {
  width: 26px; height: 26px; flex: none; border: 0; border-radius: 50%; padding: 0;
  display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
  background: #2f6fd0; color: #fff;
}
.pd-send:hover:not(:disabled) { filter: brightness(1.08); }
.pd-send:disabled { opacity: .4; cursor: not-allowed; }
.pd-thinking { display: flex; flex-direction: column; gap: 4px; color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 11.5px; }
.pd-thinking-head {
  display: flex; align-items: center; gap: 6px; border: 0; background: transparent; color: inherit;
  font: inherit; font-size: 11.5px; padding: 0; cursor: pointer;
}
.pd-thinking-head:hover { color: var(--dsw-alias-label-secondary, #555); }
.pd-thinking-toggle { margin-left: auto; color: var(--dsw-alias-brand-primary, #2f6fd0); }
.pd-thinking-body {
  border-left: 2px solid var(--dsw-alias-border-l2, #dcdcdc); padding: 2px 0 2px 8px;
  white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow-y: auto; line-height: 1.65;
}
.pd-stream-text { margin-top: 6px; }
.pd-caret {
  display: inline-block; width: 6px; height: 12px; margin-left: 2px; vertical-align: text-bottom;
  background: var(--dsw-alias-brand-primary, #2f6fd0); animation: pd-blink 1s steps(1) infinite;
}
@keyframes pd-blink { 50% { opacity: 0; } }
.pd-composer { flex: none; border-top: 1px solid var(--dsw-alias-border-l1, #e6e6e6); padding: 8px 10px; display: flex; gap: 6px; }
.pd-input, .pd-textarea {
  width: 100%; border: 1px solid var(--dsw-alias-border-l2, #dcdcdc); border-radius: 7px;
  padding: 6px 8px; font: inherit; color: inherit; background: var(--dsw-alias-bg-layer-2, #fff); resize: none;
}
.pd-input:focus, .pd-textarea:focus { outline: 2px solid var(--dsw-alias-brand-primary, #2f6fd0); outline-offset: -1px; }
.pd-note { border: 1px solid var(--dsw-alias-border-l1, #e8e8e8); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; background: var(--dsw-alias-bg-layer-2, #fff); }
.pd-note-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.pd-note-kind { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-1, #f0f0f0); color: var(--dsw-alias-label-tertiary, #888); }
.pd-note-ai { background: var(--dsw-alias-brand-primary, #2f6fd0); color: #fff; }
.pd-md-h { font-size: 13px; font-weight: 700; margin: 10px 0 4px; }
.pd-md-p { margin: 4px 0; }
.pd-md-ul { margin: 4px 0; padding-left: 18px; }
.pd-code { font-family: ui-monospace, Menlo, monospace; background: var(--dsw-alias-markdown-code-block, #f3f4f6); padding: 0 4px; border-radius: 4px; font-size: 11.5px; }
.pd-math { font-family: ui-monospace, Menlo, monospace; color: var(--dsw-alias-brand-primary, #2f6fd0); }

.pd-compare { position: absolute; inset: 0; z-index: 30; background: var(--dsw-alias-bg-base, #fff); display: flex; flex-direction: column; }
.pd-compare-plane { position: absolute; inset: 0; transform-origin: 0 0; will-change: transform; }
.pd-compare-stage { position: relative; flex: 1; overflow: hidden; background:
  radial-gradient(circle at 1px 1px, var(--dsw-alias-border-l1, #e5e5e5) 1px, transparent 0) 0 0 / 24px 24px,
  var(--dsw-alias-bg-layer-1, #fafafa); }
.pd-card {
  position: absolute; width: 320px; min-width: 220px; border-radius: 12px; background: var(--dsw-alias-bg-layer-2, #fff);
  border: 1px solid var(--dsw-alias-border-l2, #d8d8d8); box-shadow: 0 6px 20px rgba(16,32,56,.10);
  display: flex; flex-direction: column; overflow: hidden;
}
.pd-card-head { padding: 8px 10px; cursor: grab; border-bottom: 1px solid var(--dsw-alias-border-l1, #eee); background: var(--dsw-alias-bg-layer-1, #fafafa); }
.pd-card-title { font-size: 12px; font-weight: 600; line-height: 1.4; max-height: 3.2em; overflow: hidden; }
.pd-card-body { padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; min-height: 0; flex: 1 1 auto; overflow: auto; }
.pd-card-fig { width: 100%; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1, #eee); cursor: pointer; display: block; }
.pd-card-actions { display: flex; gap: 6px; }
.pd-card-detail {
  border-top: 1px dashed var(--dsw-alias-border-l2, #ddd);
  margin-top: 2px; padding-top: 10px; font-size: 12.5px; line-height: 1.85;
  overflow: auto; max-height: 46vh;
}
.pd-card-detail .pd-md { line-height: 1.85; }
.pd-card-detail .pd-md p { margin: 0 0 9px; }
.pd-card-detail .pd-md p:last-child { margin-bottom: 0; }
.pd-card-detail .pd-md-ul { margin: 6px 0 9px; padding-left: 18px; }
.pd-card-detail .pd-md-ul li { margin: 3px 0; }
.pd-card-detail .pd-formula { margin: 8px 0; padding: 8px 10px; }
.pd-card-detail .pd-field-label { margin: 10px 0 4px; }

.pd-tabs-inset { padding: 0 16px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eee); }
/* 高度跟着内容走，超出上限时正文自己滚动（按钮始终在右下角） */
.pd-settings-body {
  padding: 14px 16px; display: flex; flex-direction: column; gap: 12px;
  overflow-y: auto; min-height: 0; flex: 1 1 auto;
}
.pd-row { display: flex; align-items: center; gap: 8px; }
.pd-row-end { justify-content: flex-end; }
.pd-model-row {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px; margin-bottom: 6px;
  border: 1px solid var(--dsw-alias-border-l2, #dcdcdc); border-radius: 9px;
  background: var(--dsw-alias-bg-layer-2, #fff);
}
.pd-model-main { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; cursor: pointer; }
.pd-model-name { font-size: 12px; font-weight: 600; }
.pd-model-sub {
  font-size: 11px; color: var(--dsw-alias-label-tertiary, #9a9a9a); margin-top: 2px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pd-model-actions { display: flex; gap: 4px; flex: none; }
.pd-model-draft {
  border: 1px dashed var(--dsw-alias-border-l4, #c2ccd9); border-radius: 10px; padding: 10px 12px; margin: 6px 0;
}
.pd-model-draft-foot {
  display: flex; justify-content: flex-end; align-items: center; gap: 8px;
  margin-top: 10px; padding-top: 8px;
  border-top: 1px solid var(--dsw-alias-border-l1, #eee);
}
.pd-dir-path {
  font-size: 11.5px; padding: 6px 8px; border-radius: 6px; background: var(--dsw-alias-bg-layer-1, #f6f7f9);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pd-dir-list { max-height: 320px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.pd-dir-item {
  text-align: left; border: 0; background: transparent; border-radius: 6px; padding: 6px 8px;
  font: inherit; font-size: 12px; cursor: pointer; color: var(--dsw-alias-label-primary, #222);
}
.pd-dir-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.pd-dir-item.is-parent { color: var(--dsw-alias-label-secondary, #666); }
.pd-zotero-list { max-height: 380px; overflow-y: auto; margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.pd-zotero-row {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2, #dcdcdc); border-radius: 9px;
  background: var(--dsw-alias-bg-layer-2, #fff);
}
.pd-zotero-main { flex: 1; min-width: 0; }
.pd-zotero-title { font-size: 12px; font-weight: 600; line-height: 1.5; }
.pd-zotero-sub {
  font-size: 11px; color: var(--dsw-alias-label-tertiary, #9a9a9a); margin-top: 2px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pd-settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px; }
.pd-settings-grid .pd-field:first-child { grid-column: 1 / -1; }
.pd-range { width: 100%; accent-color: var(--dsw-alias-brand-primary, #2f6fd0); }
.pd-test-result {
  margin-top: 2px; padding: 8px 10px; border-radius: 8px; font-size: 11.5px; line-height: 1.6;
  background: rgba(239, 68, 68, .12); color: var(--dsw-alias-state-error-primary, #a12a20);
}
.pd-test-result.is-ok {
  background: rgba(34, 197, 94, .14); color: var(--dsw-alias-state-success-primary, #166534);
}
.pd-modal-mask { position: fixed; inset: 0; z-index: 90; padding: 24px; box-sizing: border-box; background: rgba(10,18,30,.38); display: flex; align-items: center; justify-content: center; }
/* 弹窗自己限高：窗口矮的时候让正文滚动，按钮永远留在可视范围内 */
.pd-modal {
  width: 520px; max-width: 100%; max-height: 100%;
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--dsw-alias-bg-base, #fff); border-radius: 12px; box-shadow: 0 20px 60px rgba(10,20,40,.3);
}
.pd-modal-head { padding: 12px 16px; font-weight: 600; border-bottom: 1px solid var(--dsw-alias-border-l1, #eee); flex: none; }
/* 固定高度的弹窗里正文吃掉剩余空间，footer 才会真的贴在窗口右下角 */
.pd-modal-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; min-height: 0; flex: 1 1 auto; }
.pd-modal-foot { padding: 10px 16px; display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid var(--dsw-alias-border-l1, #eee); flex: none; }
.pd-field { display: flex; flex-direction: column; gap: 4px; }
.pd-field-label { font-size: 11px; color: var(--dsw-alias-label-tertiary, #999); }
.pd-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary, #999); line-height: 1.6; }
.pd-error { color: var(--dsw-alias-state-error-primary, #c0392b); font-size: 12px; }
.pd-spinner {
  width: 13px; height: 13px; border-radius: 50%; border: 2px solid var(--dsw-alias-border-l2, #ccc);
  border-top-color: var(--dsw-alias-brand-primary, #2f6fd0); animation: pd-spin .8s linear infinite; display: inline-block;
}
@keyframes pd-spin { to { transform: rotate(360deg); } }

/* 右侧栏里的连续 PDF 阅读器 */
.pd-pdf-wrap {
  position: relative; display: flex; flex-direction: column; flex: 1; min-height: 0; }
.pd-pdf-tools {
  display: flex; align-items: center; gap: 4px; padding: 6px 10px; flex: none;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #e6e6e6);
}
.pd-pdf-note { padding: 4px 10px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #888); flex: none; }
.pd-pdf-pages { display: flex; flex-direction: column; align-items: center; gap: 14px; }
.pd-pdf-scroll {
  flex: 1; min-height: 0; overflow: auto;
  padding: 10px 12px 24px; background: var(--dsw-alias-bg-layer-1, #f2f3f5);
  display: flex; flex-direction: column; gap: 10px;
}
.pd-pdf-page {
  position: relative;
  background: #fff; border-radius: 4px; overflow: hidden; flex: none;
  box-shadow: 0 2px 10px rgba(10, 20, 40, .12); margin: 0 auto;
}
.pd-pdf-canvas { display: block; width: 100%; height: 100%; object-fit: contain; }
/* 文本层：透明文字盖在画布上，负责选择与划词；框选模式下不拦事件 */
.pd-text-layer {
  position: absolute; inset: 0; overflow: hidden; line-height: 1; z-index: 2;
  user-select: text; -webkit-user-select: text; cursor: text;
}
.pd-text-layer span {
  position: absolute; color: transparent; white-space: pre; overflow: hidden;
  cursor: text; contain: layout style;
}
.pd-text-layer ::selection { background: rgba(47, 111, 208, .28); }
.pd-pdf-page.is-picking .pd-text-layer { display: none; }
/* 划词小工具条：预览一下选中的内容，再决定问/复制 */
.pd-selection-pop {
  position: absolute; z-index: 30; width: 320px; max-width: calc(100% - 16px);
  border-radius: 10px; background: var(--dsw-alias-bg-layer-2, #fff);
  border: 1px solid var(--dsw-alias-border-l2, #dcdcdc);
  box-shadow: 0 10px 26px rgba(16, 32, 56, .18);
  animation: pd-pop .14s ease-out; overflow: hidden;
}
.pd-selection-preview {
  padding: 8px 10px; font-size: 11.5px; line-height: 1.6; max-height: 96px; overflow: hidden;
  color: var(--dsw-alias-label-secondary, #555);
  display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical;
}
.pd-selection-actions {
  display: flex; gap: 6px; padding: 6px 10px 8px; justify-content: flex-end;
  border-top: 1px solid var(--dsw-alias-border-l1, #eee);
}
.pd-pdf-page.is-picking { cursor: crosshair; }
.pd-pdf-page.is-picking .pd-pdf-canvas { pointer-events: none; }
/* 框选框：PDF 页面永远是白底，所以固定用高对比的蓝，不跟主题走
   （深色主题里 --dsw-alias-brand-primary 偏白，虚线在白页上等于看不见）。
   外面再压一圈半透明白晕，落在深色插图上也拎得出来。 */
.pd-pdf-box {
  position: absolute; border: 1.5px dashed #1f5fd0; border-radius: 2px;
  background: rgba(31, 95, 208, .16);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, .9), 0 0 16px rgba(31, 95, 208, .45);
  pointer-events: none; z-index: 2;
}

.pd-lightbox { position: fixed; inset: 0; z-index: 95; background: rgba(8,14,24,.82); display: flex; align-items: center; justify-content: center; cursor: zoom-out; }
.pd-lightbox img { max-width: 92vw; max-height: 86vh; border-radius: 8px; background: #fff; }
.pd-lightbox-inner { display: flex; flex-direction: column; align-items: center; gap: 10px; }
.pd-lightbox-cap { font-size: 12px; color: #dbe4f0; letter-spacing: .02em; }
`;
