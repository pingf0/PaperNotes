/**
 * 对比模式：把几篇论文的原理图摊在同一个台面上，卡片随手拖。
 *
 * 每张卡点开就是这篇的"核心思想 + 公式"；右侧的会话是**这批论文共用**的，
 * 问"它们的差异"时，宿主会把这几篇的概括、原理、公式一起喂给模型。
 */
import { React } from './runtime.js';
import { api, assetUrl } from './api.js';
import { Dropdown, Formula, Icon, Markdown, Spinner, useEnterGuard } from './ui.jsx';

/**
 * @param {{ paperIds: string[], onClose: () => void, onOpenPaper: (id: string) => void }} props
 */
export function CompareView({ paperIds, onClose, onOpenPaper }) {
  const { useEffect, useMemo, useRef, useState } = React;
  const [papers, setPapers] = useState([]);
  const [error, setError] = useState('');
  const [cards, setCards] = useState({});
  const [openDetail, setOpenDetail] = useState({});
  const [dragging, setDragging] = useState(null);
  /** 正在拖某张卡片的尺寸：{ id, dir, startX, startY, startW, startH, nodeX, nodeY } */
  const [cardResize, setCardResize] = useState(null);
  /** 卡片层级：点哪张就把哪张抬到最上面。 */
  const zRef = useRef(1);
  /** 顶部论文条目是否展开（展示全部标题）。 */
  /** 会话栏的两个页签：会话 / 论文列表。 */
  const [tab, setTab] = useState('chat');
  /** 提问范围：'all' = 全部论文一起分析对比；某篇 id = 只问这一篇。 */
  const [scope, setScope] = useState('all');
  /** 聚焦动画期间给平面加过渡，平时拖拽/平移不加（否则会跟手迟钝）。 */
  const [focusing, setFocusing] = useState(false);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState(null);
  const [thinkingOpen, setThinkingOpen] = useState(true);
  const [modelCatalog, setModelCatalog] = useState({ providers: [], current: null });
  const [modelKey, setModelKey] = useState('');
  const [copied, setCopied] = useState(-1);
  const abortRef = useRef(null);
  const [chatOpen, setChatOpen] = useState(true);
  /** 右侧讨论栏宽度（可拖左边缘调整），存到 localStorage。 */
  const [drawerW, setDrawerW] = useState(() => {
    const saved = Number(window.localStorage?.getItem('pd-compare-drawer-w'));
    return Number.isFinite(saved) && saved >= 280 ? saved : 380;
  });
  const [resizingDrawer, setResizingDrawer] = useState(null);
  /** 舞台视图：平移 + 缩放。 */
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [panning, setPanning] = useState(null);
  const stageRef = useRef(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const drawerWRef = useRef(380);
  drawerWRef.current = drawerW;
  const listRef = useRef(null);
  const enterGuard = useEnterGuard();
  const inputRef = useRef(null);

  /** 读全部论文，并按顺序铺开卡片。 */
  useEffect(() => {
    let alive = true;
    Promise.all(paperIds.map((id) => api.getPaper(id).catch(() => null)))
      .then((results) => {
        if (!alive) return;
        const loaded = results.filter(Boolean).map((result) => result.paper);
        setPapers(loaded);
        const initial = {};
        loaded.forEach((paper, index) => {
          initial[paper.id] = {
            x: 40 + (index % 3) * 350,
            y: 30 + Math.floor(index / 3) * 300,
          };
        });
        setCards(initial);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperIds]);

  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    // 平滑滚到底：消息在长高时是"跟手地滑下去"，不是瞬间跳
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
  }, [messages.length, busy, streaming?.text]);

  const activeIds = useMemo(
    () => (scope === 'all' ? paperIds : [scope]),
    [scope, paperIds],
  );

  /** 载入当前范围的历史讨论 + 可选模型。 */
  useEffect(() => {
    let alive = true;
    api.compareHistory(activeIds)
      .then((result) => {
        if (alive && Array.isArray(result.messages)) setMessages(result.messages);
      })
      .catch(() => undefined);
    api
      .models()
      .then((result) => {
        if (!alive) return;
        const providers = result.providers ?? [];
        setModelCatalog({ providers, current: result.current ?? null });
        const current = result.current;
        if (current && current.provider && current.model) setModelKey(`${current.provider}|${current.model}`);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIds.join(',')]);

  /** 卡片拖动。 */
  useEffect(() => {
    if (!dragging) return undefined;
    const onMove = (event) => {
      const dx = event.clientX - dragging.startX;
      const dy = event.clientY - dragging.startY;
      setCards((prev) => ({
        ...prev,
        [dragging.id]: { ...(prev[dragging.id] ?? {}), x: Math.max(0, dragging.originX + dx), y: Math.max(0, dragging.originY + dy) },
      }));
    };
    const onUp = () => setDragging(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  /** 拖卡片四边/四角改尺寸（和论文画布里的节点一致：只有光标变化）。 */
  useEffect(() => {
    if (!cardResize) return undefined;
    const onMove = (event) => {
      const dx = event.clientX - cardResize.startX;
      const dy = event.clientY - cardResize.startY;
      const { dir, startW, startH, nodeX, nodeY } = cardResize;
      let width = startW;
      let height = startH;
      let x = nodeX;
      let y = nodeY;
      if (dir.includes('e')) width = startW + dx;
      if (dir.includes('s')) height = startH + dy;
      if (dir.includes('w')) {
        width = Math.max(220, startW - dx);
        x = nodeX + (startW - width);
      }
      if (dir.includes('n')) {
        height = Math.max(120, startH - dy);
        y = nodeY + (startH - height);
      }
      setCards((prev) => ({
        ...prev,
        [cardResize.id]: { ...(prev[cardResize.id] ?? {}), x, y, w: Math.min(760, width), h: Math.min(900, height) },
      }));
    };
    const onUp = () => setCardResize(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [cardResize]);

  /** 拖右侧栏左边缘改宽。 */
  useEffect(() => {
    if (!resizingDrawer) return undefined;
    const onMove = (event) => {
      const next = Math.min(720, Math.max(280, resizingDrawer.startW + (resizingDrawer.startX - event.clientX)));
      drawerWRef.current = next;
      setDrawerW(next);
    };
    const onUp = () => {
      window.localStorage?.setItem('pd-compare-drawer-w', String(drawerWRef.current));
      setResizingDrawer(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [resizingDrawer]);

  /** 滚轮/触控板：默认平移，⌘/Ctrl 缩放（和论文画布一致的手感）。 */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const onWheel = (event) => {
      // 卡片详情/会话列表自己就能滚，别被舞台的平移抢走滚轮
      if (event.target instanceof Element && event.target.closest('.pd-card-detail, .pd-card-body, .pd-msgs, .pd-compose')) {
        return;
      }
      event.preventDefault();
      const current = viewRef.current;
      if (event.ctrlKey || event.metaKey) {
        const rect = stage.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        const factor = Math.exp(-event.deltaY * 0.0018);
        const scale = Math.min(2.2, Math.max(0.4, current.scale * factor));
        const ratio = scale / current.scale;
        setView({
          scale,
          x: px - (px - current.x) * ratio,
          y: py - (py - current.y) * ratio,
        });
        return;
      }
      setView({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY });
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, []);

  /** 拖空白处平移。 */
  useEffect(() => {
    if (!panning) return undefined;
    const onMove = (event) => {
      setView({
        ...viewRef.current,
        x: panning.startX + (event.clientX - panning.fromX),
        y: panning.startY + (event.clientY - panning.fromY),
      });
    };
    const onUp = () => setPanning(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [panning]);

  /** 点顶部的论文条目：把那张卡移到视野中央并抬到最上层。 */
  /** 切范围：历史按范围分别存取，所以这里只换数据源。 */
  const changeScope = (next) => {
    setScope(next);
    setMessages([]);
  };

  const focusCard = (id) => {
    const stage = stageRef.current;
    if (!stage) return;
    const box = stage.getBoundingClientRect();
    const card = cards[id] ?? { x: 40, y: 30 };
    const width = card.w ?? 320;
    const height = card.h ?? 320;
    const scale = viewRef.current.scale;
    setFocusing(true);
    setView({
      scale,
      x: box.width / 2 - (card.x + width / 2) * scale,
      y: box.height / 2 - (card.y + height / 2) * scale,
    });
    zRef.current += 1;
    const z = zRef.current;
    setCards((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), z } }));
    window.setTimeout(() => setFocusing(false), 320);
  };

  /** 展开详情后卡片会变高：若超出舞台可视范围，平移视图让它完整露出来。 */
  useEffect(() => {
    const stage = stageRef.current;
    const openId = Object.keys(openDetail).find((id) => openDetail[id]);
    if (!stage || !openId) return undefined;
    const timer = window.setTimeout(() => {
      const card = stage.querySelector(`[data-card-id="${openId}"]`);
      if (!card) return;
      const stageBox = stage.getBoundingClientRect();
      const box = card.getBoundingClientRect();
      const pad = 18;
      let dx = 0;
      let dy = 0;
      if (box.right > stageBox.right - pad) dx = box.right - (stageBox.right - pad);
      if (box.left < stageBox.left + pad) dx = box.left - (stageBox.left + pad);
      if (box.bottom > stageBox.bottom - pad) dy = box.bottom - (stageBox.bottom - pad);
      if (box.top < stageBox.top + pad) dy = box.top - (stageBox.top + pad);
      if (dx === 0 && dy === 0) return;
      setFocusing(true);
      setView((current) => ({ ...current, x: current.x - dx, y: current.y - dy }));
      window.setTimeout(() => setFocusing(false), 320);
    }, 40);
    return () => window.clearTimeout(timer);
  }, [openDetail]);

  const principleOf = (paper) => (paper.blocks ?? []).find((block) => block.type === 'principle') ?? null;
  const formulasOf = (paper) => (paper.blocks ?? []).filter((block) => block.type === 'formula');
  const figureOf = (paper, block) => (block?.figureId ? (paper.figures ?? []).find((figure) => figure.id === block.figureId) : undefined);

  const persist = (next) => api.saveCompareHistory(activeIds, next).catch(() => undefined);

  const send = async () => {
    const message = draft.trim();
    if (message.length === 0 || busy) return;
    setDraft('');
    setBusy(true);
    setError('');
    setStreaming({ reasoning: '', text: '' });
    setThinkingOpen(true);
    const history = messages;
    const withUser = [...history, { role: 'user', content: message, ts: Date.now() }];
    setMessages(withUser);
    const controller = new AbortController();
    abortRef.current = controller;
    const [provider, modelId] = modelKey.split('|');
    try {
      let finalText = '';
      await api.compareChatStream(activeIds, message, history, {
        model: provider && modelId ? { provider, model: modelId } : undefined,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'reasoning') {
            setStreaming((current) => ({ reasoning: (current?.reasoning ?? '') + event.text, text: current?.text ?? '' }));
          } else if (event.type === 'text') {
            setStreaming((current) => ({ reasoning: current?.reasoning ?? '', text: (current?.text ?? '') + event.text }));
          } else if (event.type === 'done') {
            finalText = typeof event.text === 'string' ? event.text : finalText;
          } else if (event.type === 'error') {
            setError(String(event.message ?? '生成失败'));
          }
        },
      });
      if (finalText) {
        const next = [...withUser, { role: 'assistant', content: finalText, ts: Date.now() }];
        setMessages(next);
        persist(next);
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      setError(detail.includes('abort') ? '已停止生成' : detail);
      persist(withUser);
    } finally {
      abortRef.current = null;
      setStreaming(null);
      setBusy(false);
    }
  };

  return React.createElement(
    'div',
    { className: 'pd-compare' },
    React.createElement(
      'div',
      { className: 'pd-top' },
      React.createElement('button', { className: 'pd-btn pd-btn-ghost', onClick: onClose }, React.createElement(Icon, { name: 'back' }), '返回论文库'),
      React.createElement('div', { className: 'pd-title' }, '对比台'),
      React.createElement('span', { className: 'pd-sub' }, `${papers.length || paperIds.length} 篇论文对比中`),
      React.createElement('div', { className: 'pd-grow' }),
      // 伸缩图标常驻顶栏同一位置：无论会话开着还是收起，它都不动
      React.createElement(
        'button',
        {
          className: `pd-collapse-btn${chatOpen ? ' is-on' : ''}`,
          title: chatOpen ? '收起会话' : '展开会话',
          onClick: () => setChatOpen((open) => !open),
        },
        React.createElement(Icon, { name: 'panel', size: 14 }),
        !chatOpen && messages.filter((m) => m.role === 'user').length > 0
          ? React.createElement('span', { className: 'pd-collapse-count' }, messages.filter((m) => m.role === 'user').length)
          : null,
      ),
    ),
    React.createElement(
      'div',
      { className: 'pd-body' },
      React.createElement(
        'div',
        {
          className: 'pd-compare-stage',
          ref: stageRef,
          onMouseDown: (event) => {
            if (event.target !== event.currentTarget) return;
            setPanning({ fromX: event.clientX, fromY: event.clientY, startX: view.x, startY: view.y });
          },
        },
        React.createElement(
          'div',
          {
            className: 'pd-compare-plane',
            style: {
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
              transition: focusing ? 'transform .28s cubic-bezier(.2,.7,.3,1)' : 'none',
            },
          },
        papers.length === 0
          ? React.createElement('div', { className: 'pd-empty' }, error || React.createElement(Spinner), ' 正在摆开论文…')
          : papers.map((paper) => {
              const principle = principleOf(paper);
              const figure = figureOf(paper, principle);
              const position = cards[paper.id] ?? { x: 40, y: 30 };
              return React.createElement(
                'div',
                {
                  key: paper.id,
                  className: 'pd-card',
                  'data-card-id': paper.id,
                  onMouseDown: () => {
                    zRef.current += 1;
                    const z = zRef.current;
                    setCards((prev) => ({ ...prev, [paper.id]: { ...(prev[paper.id] ?? {}), z } }));
                  },
                  style: {
                    left: position.x,
                    top: position.y,
                    zIndex: position.z ?? 1,
                    ...(position.w ? { width: position.w } : {}),
                    // 详情展开时不锁死高度，否则"看核心思想与公式"会被裁掉一半
                    ...(position.h && !openDetail[paper.id] ? { height: position.h, overflow: 'hidden' } : {}),
                  },
                },
                ...['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((dir) =>
                  React.createElement('span', {
                    key: `card-resize-${dir}`,
                    className: `pd-rs pd-rs-${dir}`,
                    onMouseDown: (event) => {
                      event.stopPropagation();
                      event.preventDefault();
                      const card = cards[paper.id] ?? { x: 40, y: 30 };
                      setCardResize({
                        id: paper.id,
                        dir,
                        startX: event.clientX,
                        startY: event.clientY,
                        startW: card.w ?? 320,
                        startH: card.h ?? 320,
                        nodeX: card.x,
                        nodeY: card.y,
                      });
                    },
                    onDoubleClick: (event) => {
                      // 只有四角双击才恢复默认：边缘条与标题栏重叠，双击标题会被误判
                      if (!['ne', 'nw', 'se', 'sw'].includes(dir)) return;
                      event.stopPropagation();
                      setCards((prev) => ({ ...prev, [paper.id]: { ...prev[paper.id], w: undefined, h: undefined } }));
                    },
                  }),
                ),
                React.createElement(
                  'div',
                  {
                    className: 'pd-card-head',
                    onMouseDown: (event) => {
                      event.preventDefault();
                      setDragging({ id: paper.id, startX: event.clientX, startY: event.clientY, originX: position.x, originY: position.y });
                    },
                  },
                  React.createElement('div', { className: 'pd-card-title', title: paper.title }, paper.title),
                  React.createElement('div', { className: 'pd-sub' }, paper.abstract || ''),
                ),
                React.createElement(
                  'div',
                  { className: 'pd-card-body' },
                  figure
                    ? React.createElement('img', {
                        className: 'pd-card-fig',
                        src: assetUrl(paper.id, figure.file),
                        alt: principle?.title ?? '原理图',
                        onClick: () => setOpenDetail((prev) => ({ ...prev, [paper.id]: !prev[paper.id] })),
                      })
                    : React.createElement('div', { className: 'pd-thumb', style: { width: '100%', height: 120 } }, '这篇没有裁到原理图'),
                  React.createElement(
                    'div',
                    { className: 'pd-card-actions' },
                    React.createElement(
                      'button',
                      {
                        className: `pd-btn pd-btn-sm${openDetail[paper.id] ? ' pd-btn-primary' : ''}`,
                        onClick: () => setOpenDetail((prev) => ({ ...prev, [paper.id]: !prev[paper.id] })),
                      },
                      openDetail[paper.id] ? '收起思想与公式' : '看核心思想与公式',
                    ),
                    React.createElement(
                      'button',
                      {
                        className: 'pd-btn pd-btn-sm',
                        onClick: () => {
                          setChatOpen(true);
                          setTab('chat');
                          setDraft(`关于《${paper.title}》：`);
                          window.setTimeout(() => inputRef.current?.focus(), 30);
                        },
                      },
                      '问答',
                    ),
                    React.createElement('button', { className: 'pd-btn pd-btn-sm', onClick: () => onOpenPaper(paper.id) }, '单独打开'),
                  ),
                  openDetail[paper.id]
                    ? React.createElement(
                        'div',
                        { className: 'pd-card-detail' },
                        paper.core?.text
                          ? React.createElement(Markdown, { text: paper.core.text })
                          : React.createElement(
                              'div',
                              null,
                              React.createElement('div', { className: 'pd-hint' }, '还没有生成 core，先看节点里的原理：'),
                              React.createElement('div', { style: { marginTop: 4 } }, React.createElement(Markdown, { text: principle?.text ?? '（空）' })),
                            ),
                        formulasOf(paper).length > 0
                          ? React.createElement(
                              'div',
                              { style: { marginTop: 8 } },
                              React.createElement('div', { className: 'pd-field-label' }, '关键公式'),
                              ...formulasOf(paper).map((formula) =>
                                React.createElement(Formula, {
                                  key: formula.id,
                                  tex: formula.latex ?? '',
                                  className: 'pd-node-latex',
                                }),
                              ),
                            )
                          : null,
                      )
                    : null,
                ),
              );
            }),
        ),
      ),
      chatOpen
        ? React.createElement(
        'div',
        { className: 'pd-drawer', style: { width: drawerW } },
        React.createElement('div', {
          className: 'pd-drawer-resizer',
          title: '拖动改宽度',
          onMouseDown: (event) => {
            event.preventDefault();
            setResizingDrawer({ startX: event.clientX, startW: drawerW });
          },
        }),
        React.createElement(
          'div',
          { className: 'pd-tabs' },
          React.createElement(
            'div',
            { className: `pd-tab${tab === 'chat' ? ' is-active' : ''}`, onClick: () => setTab('chat') },
            '会话',
          ),
          React.createElement(
            'div',
            { className: `pd-tab${tab === 'papers' ? ' is-active' : ''}`, onClick: () => setTab('papers') },
            '论文列表',
          ),
        ),
        tab === 'papers'
          ? React.createElement(
              'div',
              { className: 'pd-paper-list' },
              ...papers.map((paper) =>
                React.createElement(
                  'div',
                  {
                    key: paper.id,
                    className: 'pd-paper-row',
                    title: '聚焦这篇',
                    role: 'button',
                    tabIndex: 0,
                    onClick: () => focusCard(paper.id),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' || event.key === ' ') focusCard(paper.id);
                    },
                  },
                  React.createElement('div', { className: 'pd-paper-row-title' }, paper.title),
                  React.createElement('div', { className: 'pd-paper-row-sub' }, paper.abstract || '（没有摘要）'),
                  React.createElement(
                    'div',
                    { className: 'pd-paper-row-actions' },
                    React.createElement(
                      'button',
                      {
                        className: 'pd-btn pd-btn-sm',
                        onClick: (event) => {
                          event.stopPropagation();
                          changeScope(paper.id);
                          setTab('chat');
                        },
                      },
                      '问这篇',
                    ),
                  ),
                ),
              ),
            )
          : React.createElement(
              'div',
              { className: 'pd-scope-row' },
              React.createElement('span', { className: 'pd-scope-label' }, '范围'),
              React.createElement(Dropdown, {
                className: 'pd-scope-dropdown',
                value: scope,
                title: '问全部论文（对比分析）还是只问某一篇',
                onChange: changeScope,
                groups: [
                  { items: [{ value: 'all', label: `全部 ${papers.length} 篇（对比分析）` }] },
                  {
                    label: '只问某一篇',
                    items: papers.map((paper) => ({ value: paper.id, label: paper.title })),
                  },
                ],
              }),
            ),
        tab === 'chat'
          ? React.createElement(
          'div',
          { className: 'pd-msgs', ref: listRef },
          messages.length === 0
            ? React.createElement('div', { className: 'pd-hint' }, '问差异最好带具体维度：「它们的任务边界假设差在哪」「FWT 口径一样吗」「谁的增量开销更小」。')
            : messages.map((message, index) =>
                React.createElement(
                  'div',
                  { key: index, className: `pd-msg ${message.role === 'user' ? 'pd-msg-user' : 'pd-msg-ai'}` },
                  message.role === 'user' ? message.content : React.createElement(Markdown, { text: message.content }),
                  React.createElement(
                    'button',
                    {
                      className: `pd-copy${copied === index ? ' is-copied' : ''}`,
                      title: '复制这条',
                      onClick: async () => {
                        try {
                          await navigator.clipboard.writeText(message.content);
                        } catch {
                          const area = document.createElement('textarea');
                          area.value = message.content;
                          document.body.appendChild(area);
                          area.select();
                          document.execCommand('copy');
                          area.remove();
                        }
                        setCopied(index);
                        window.setTimeout(() => setCopied(-1), 1200);
                      },
                    },
                    React.createElement(Icon, { name: copied === index ? 'check' : 'copy', size: 12 }),
                  ),
                ),
              ),
          streaming
            ? React.createElement(
                'div',
                { className: 'pd-msg pd-msg-ai' },
                streaming.reasoning.length > 0
                  ? React.createElement(
                      'div',
                      { className: 'pd-thinking' },
                      React.createElement(
                        'button',
                        { className: 'pd-thinking-head', onClick: () => setThinkingOpen((open) => !open) },
                        React.createElement(Spinner),
                        React.createElement('span', null, streaming.text.length > 0 ? 'thinking（已完成）' : 'thinking'),
                        React.createElement('span', { className: 'pd-thinking-toggle' }, thinkingOpen ? '收起' : '展开'),
                      ),
                      thinkingOpen
                        ? React.createElement('div', { className: 'pd-thinking-body' }, streaming.reasoning)
                        : null,
                    )
                  : React.createElement('div', { className: 'pd-thinking' }, React.createElement(Spinner), ' thinking…'),
                streaming.text.length > 0
                  ? React.createElement(
                      'div',
                      { className: 'pd-stream-text' },
                      React.createElement(Markdown, { text: streaming.text }),
                      React.createElement('span', { className: 'pd-caret' }),
                    )
                  : null,
              )
            : null,
          error ? React.createElement('div', { className: 'pd-error' }, error) : null,
        )
          : null,
        tab === 'chat' ? React.createElement(
          'div',
          { className: 'pd-compose' },
          React.createElement('textarea', {
            ref: inputRef,
            className: 'pd-compose-input',
            rows: 3,
            placeholder: '集中讨论这几篇的异同，Enter 发送，Shift+Enter 换行',
            value: draft,
            onChange: (event) => setDraft(event.target.value),
            onCompositionStart: enterGuard.onCompositionStart,
            onCompositionEnd: enterGuard.onCompositionEnd,
            onKeyDown: (event) => {
              if (event.key !== 'Enter' || event.shiftKey) return;
              if (enterGuard.isImeEnter(event)) return;
              event.preventDefault();
              send();
            },
          }),
          React.createElement(
            'div',
            { className: 'pd-compose-bar' },
            React.createElement(Dropdown, {
              className: 'pd-model-dropdown',
              value: modelKey,
              title: '这个讨论用哪个模型',
              onChange: setModelKey,
              groups: [
                { items: [{ value: '', label: '默认模型' }] },
                ...modelCatalog.providers.map((provider) => ({
                  label: provider.name,
                  items: provider.models.map((model) => ({
                    value: `${provider.id}|${model.id}`,
                    label: model.name,
                  })),
                })),
              ],
            }),
            busy
              ? React.createElement(
                  'button',
                  { className: 'pd-btn pd-btn-sm', onClick: () => abortRef.current?.abort() },
                  '停止',
                )
              : null,
            React.createElement(
              'button',
              {
                className: 'pd-btn pd-btn-sm',
                disabled: busy,
                onClick: () => {
                  setMessages([]);
                  persist([]);
                },
              },
              '清空',
            ),
            React.createElement(
              'button',
              {
                className: 'pd-send',
                disabled: busy || draft.trim().length === 0,
                onClick: send,
                title: '发送（Enter）',
              },
              React.createElement(Icon, { name: 'send', size: 13 }),
            ),
          ),
        ) : null,
      )
        : null,
    ),
  );
}
