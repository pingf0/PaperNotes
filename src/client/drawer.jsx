/**
 * 右侧抽屉：会话 / 笔记 / core 三个页签，作用域跟着当前选中的节点走。
 *
 * 数据都直接改 paper（由上层 onUpdate 落盘），所以关掉页面再进来还是这些内容。
 */
import { React } from './runtime.js';
import { api } from './api.js';
import { Icon, Markdown, Spinner, useEnterGuard } from './ui.jsx';
import { paragraphize } from './paragraphs.js';
import { PdfPanel } from './pdf-viewer.jsx';

/**
 * @param {object} props
 * @param {object} props.paper 当前论文
 * @param {string|null} props.selectedBlockId 选中的节点
 * @param {string} props.tab 当前页签
 * @param {(tab: string) => void} props.setTab 切页签
 * @param {(patch: object, immediate?: boolean) => void} props.onUpdate 落盘
 * @param {(id: string|null) => void} props.onSelectBlock 切换选中节点
 * @param {number} props.width 抽屉宽度（像素）
 * @param {(event: object) => void} props.onResizeStart 开始拖拽改宽
 * @param {(dataUrl: string) => Promise<object|undefined>} [props.onCaptureFigure] 框选后挂图
 * @param {() => void} props.onCollapse 收起抽屉
 */
export function Drawer({ paper, selectedBlockId, tab, setTab, onUpdate, onSelectBlock, width, onResizeStart, onCollapse, onCaptureFigure }) {
  const { useEffect, useMemo, useRef, useState } = React;
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** 流式输出状态：reasoning=思考过程，text=正文，都在边到边增长。 */
  const [streaming, setStreaming] = useState(null);
  /** 原文页签的「框选配图」是否开启。 */
  const [picking, setPicking] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(true);
  /** 刚复制过哪条消息（用于显示"已复制"）。 */
  const [copiedKey, setCopiedKey] = useState(null);
  const [noteDraft, setNoteDraft] = useState('');
  const listRef = useRef(null);
  const enterGuard = useEnterGuard();
  /** 可选模型（宿主 /models），以及当前选择（存 layout.chatModel）。 */
  const [modelCatalog, setModelCatalog] = useState({ providers: [], current: null });
  const modelRef = useRef(null);
  const requestRef = useRef(null);
  const composerRef = useRef(null);

  /**
   * 输入框随内容长高（最多 160px），像侧边栏那种多行输入。
   * @param {HTMLTextAreaElement} element
   */
  const autoGrow = (element) => {
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(160, Math.max(54, element.scrollHeight))}px`;
  };

  const modelKey = (() => {
    const chosen = paper.layout?.chatModel;
    if (chosen && chosen.provider && chosen.model) return `${chosen.provider}|${chosen.model}`;
    if (modelCatalog.current) return `${modelCatalog.current.provider}|${modelCatalog.current.model}`;
    return '';
  })();
  modelRef.current = modelKey;

  useEffect(() => {
    let alive = true;
    api
      .models()
      .then((result) => alive && setModelCatalog({ providers: result.providers ?? [], current: result.current ?? null }))
      .catch(() => alive && setModelCatalog({ providers: [], current: null }));
    return () => {
      alive = false;
    };
  }, []);

  const block = (paper.blocks ?? []).find((item) => item.id === selectedBlockId) ?? null;
  const scopeKey = selectedBlockId ?? null;

  /** 当前作用域的会话。 */
  const chat = useMemo(
    () => (paper.chats ?? []).find((item) => (item.blockId ?? null) === scopeKey) ?? { messages: [] },
    [paper.chats, scopeKey],
  );

  /** 笔记：选中节点时只看该节点的；否则看整篇（含节点上的）。 */
  const notes = useMemo(() => {
    const all = paper.notes ?? [];
    return scopeKey ? all.filter((note) => note.blockId === scopeKey) : all;
  }, [paper.notes, scopeKey]);

  useEffect(() => {
    setError('');
  }, [scopeKey]);

  useEffect(() => {
    const element = listRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [chat.messages.length, busy]);

  /** 发一个问题。 */
  const send = async () => {
    const message = draft.trim();
    if (message.length === 0 || busy) return;
    setDraft('');
    setBusy(true);
    setError('');
    const requestId = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    requestRef.current = requestId;
    const [provider, model] = String(modelRef.current).split('|');
    const optimistic = { blockId: scopeKey, messages: [...chat.messages, { role: 'user', content: message, ts: Date.now() }] };
    const chats = [...(paper.chats ?? []).filter((item) => (item.blockId ?? null) !== scopeKey), optimistic];
    onUpdate({ chats });
    setStreaming({ reasoning: '', text: '' });
    setThinkingOpen(true);
    try {
      let finalMessages = null;
      await api.chatStream(paper.id, scopeKey, message, {
        model: provider && model ? { provider, model } : undefined,
        requestId,
        onEvent: (event) => {
          if (event.type === 'reasoning' && typeof event.text === 'string') {
            setStreaming((current) => ({ reasoning: (current?.reasoning ?? '') + event.text, text: current?.text ?? '' }));
          } else if (event.type === 'text' && typeof event.text === 'string') {
            setStreaming((current) => ({ reasoning: current?.reasoning ?? '', text: (current?.text ?? '') + event.text }));
          } else if (event.type === 'done' && Array.isArray(event.messages)) {
            finalMessages = event.messages;
          } else if (event.type === 'error') {
            setError(String(event.message ?? '生成失败'));
          }
        },
      });
      if (finalMessages) {
        onUpdate({ chats: [...(paper.chats ?? []).filter((item) => (item.blockId ?? null) !== scopeKey), { blockId: scopeKey, messages: finalMessages }] }, true);
      }
    } catch (e) {
      const message2 = e instanceof Error ? e.message : String(e);
      setError(message2.includes('abort') || message2.includes('已停止') ? '已停止生成' : message2);
      onUpdate({ chats: [...(paper.chats ?? []).filter((item) => (item.blockId ?? null) !== scopeKey), optimistic] }, true);
    } finally {
      requestRef.current = null;
      setStreaming(null);
      setBusy(false);
    }
  };

  /** 停止生成：让宿主中断这次模型调用。 */
  const stop = async () => {
    const requestId = requestRef.current;
    if (!requestId) return;
    try {
      await api.cancelChat(requestId);
    } catch {
      /* 已经结束也无所谓 */
    }
  };

  /** 清空当前作用域的会话（只删记录，不影响笔记）。 */
  const clearChat = () => {
    if (!window.confirm('清空这块的会话记录？笔记不受影响。')) return;
    onUpdate({ chats: (paper.chats ?? []).filter((item) => (item.blockId ?? null) !== scopeKey) }, true);
  };

  /** 切换模型：写进这篇论文的 layout，下次进来还是它。 */
  const pickModel = (value) => {
    const [provider, model] = String(value).split('|');
    if (!provider || !model) return;
    modelRef.current = value;
    onUpdate({ layout: { ...(paper.layout ?? {}), chatModel: { provider, model } } }, true);
  };

  /**
   * 复制一条消息的纯文本。
   * @param {number} key 消息下标（用于显示"已复制"）
   * @param {string} text 原文
   */
  const copyMessage = async (key, text) => {
    const value = String(text ?? '');
    let ok = false;
    try {
      await navigator.clipboard.writeText(value);
      ok = true;
    } catch {
      // 剪贴板 API 在部分环境（含桌面壳）会被拒：退回 textarea + execCommand
      try {
        const area = document.createElement('textarea');
        area.value = value;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        ok = document.execCommand('copy');
        area.remove();
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      setError('复制失败：当前环境不允许写剪贴板');
      return;
    }
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 1200);
  };

  /** 让 AI 浓缩当前作用域的提问与笔记。 */
  const condense = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.condense(paper.id, scopeKey);
      onUpdate({ notes: [...(paper.notes ?? []), result.note] }, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** 加一条自己的笔记。 */
  const addNote = () => {
    const text = noteDraft.trim();
    if (text.length === 0) return;
    const note = { id: `n-${Date.now().toString(36)}`, kind: 'user', blockId: scopeKey, text, createdAt: Date.now() };
    onUpdate({ notes: [...(paper.notes ?? []), note] }, true);
    setNoteDraft('');
  };

  /** 生成 core 核。 */
  const buildCore = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.core(paper.id);
      onUpdate({ core: result.core }, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const scopeLabel = block ? `当前板块：${block.title}` : '当前范围：整篇论文';

  const tabs = React.createElement(
    'div',
    { className: 'pd-tabs' },
    ...[
      { key: 'chat', label: '会话' },
      { key: 'notes', label: `笔记 ${notes.length > 0 ? notes.length : ''}`.trim() },
      { key: 'core', label: 'core 核' },
      { key: 'pdf', label: '原文' },
    ].map((entry) =>
      React.createElement('div', { key: entry.key, className: `pd-tab${tab === entry.key ? ' is-active' : ''}`, onClick: () => setTab(entry.key) }, entry.label),
    ),
    React.createElement(
      'button',
      { className: 'pd-collapse-btn', onClick: onCollapse, title: '收起右侧栏（拖左边缘可改宽度）' },
      React.createElement(Icon, { name: 'panel', size: 14 }),
    ),
  );

  const chatPane = React.createElement(
    'div',
    { className: 'pd-drawer-body' },
    React.createElement('div', { className: 'pd-scope' }, scopeLabel),
    React.createElement(
      'div',
      { className: 'pd-msgs', ref: listRef },
      chat.messages.length === 0
        ? React.createElement('div', { className: 'pd-hint' }, block ? '就这一块提问：它的结论、公式怎么推的、跟别的论文怎么比，问都行。' : '整篇论文的提问放在这里；点节点可以切到那个板块单独问。')
        : chat.messages.map((message, index) =>
            React.createElement(
              'div',
              { key: index, className: `pd-msg ${message.role === 'user' ? 'pd-msg-user' : 'pd-msg-ai'}` },
              message.role === 'user'
                ? message.content
                : React.createElement(Markdown, { text: paragraphize(message.content) }),
              React.createElement(
                'button',
                {
                  className: `pd-msg-copy${copiedKey === index ? ' is-copied' : ''}`,
                  onClick: (event) => {
                    event.stopPropagation();
                    copyMessage(index, message.content);
                  },
                  title: '复制这条消息',
                  'aria-label': copiedKey === index ? '已复制' : '复制',
                },
                copiedKey === index
                  ? React.createElement(Icon, { name: 'check', size: 12 })
                  : React.createElement(Icon, { name: 'copy', size: 12 }),
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
    ),
    React.createElement(
      'div',
      { className: 'pd-compose' },
      React.createElement('textarea', {
        ref: composerRef,
        className: 'pd-compose-input',
        rows: 3,
        placeholder: block ? '对这块提问，Enter 发送，Shift+Enter 换行' : '对整篇提问，Enter 发送，Shift+Enter 换行',
        value: draft,
        onChange: (event) => {
          setDraft(event.target.value);
          autoGrow(event.target);
        },
        onCompositionStart: enterGuard.onCompositionStart,
        onCompositionEnd: enterGuard.onCompositionEnd,
        onKeyDown: (event) => {
          if (event.key !== 'Enter' || event.shiftKey) return;
          // 中文/日文输入法里 Enter 是"确认候选词"，不能当成发送
          if (enterGuard.isImeEnter(event)) return;
          event.preventDefault();
          send();
        },
      }),
      React.createElement(
        'div',
        { className: 'pd-compose-bar' },
        React.createElement(
          'select',
          {
            className: 'pd-model',
            value: modelKey,
            onChange: (event) => pickModel(event.target.value),
            title: '这一栏用哪个模型回答（按论文记住）',
          },
          modelKey === '' ? React.createElement('option', { value: '' }, '默认模型') : null,
          ...modelCatalog.providers.map((provider) =>
            React.createElement(
              'optgroup',
              { key: provider.id, label: provider.name },
              ...provider.models.map((model) =>
                React.createElement('option', { key: `${provider.id}|${model.id}`, value: `${provider.id}|${model.id}` }, model.name),
              ),
            ),
          ),
        ),
        React.createElement('span', { className: 'pd-grow' }),
        busy ? React.createElement('button', { className: 'pd-btn pd-btn-sm', onClick: stop, title: '停止这次生成' }, '停止') : null,
        React.createElement(
          'button',
          { className: 'pd-btn pd-btn-sm pd-btn-ghost', onClick: clearChat, disabled: chat.messages.length === 0, title: '清空这块的会话记录' },
          '清空',
        ),
        React.createElement(
          'button',
          {
            className: 'pd-send',
            disabled: busy || draft.trim().length === 0,
            onClick: send,
            title: busy ? '生成中…' : '发送（Enter）',
            'aria-label': '发送',
          },
          React.createElement(Icon, { name: 'send', size: 13 }),
        ),
      ),
    ),
  );

  const notesPane = React.createElement(
    'div',
    { className: 'pd-drawer-body' },
    React.createElement('div', { className: 'pd-scope' }, `${scopeLabel} · 已理解和不理解都可以记`),
    React.createElement(
      'div',
      { className: 'pd-msgs' },
      React.createElement(
        'div',
        { style: { display: 'flex', gap: 6 } },
        React.createElement('textarea', {
          className: 'pd-textarea',
          rows: 3,
          placeholder: '比如：评价指标 FWT 没看懂 / 它的前提是任务边界已知，这点我记住了',
          value: noteDraft,
          onChange: (event) => setNoteDraft(event.target.value),
        }),
      ),
      React.createElement(
        'div',
        { style: { display: 'flex', gap: 6 } },
        React.createElement('button', { className: 'pd-btn pd-btn-primary', disabled: noteDraft.trim().length === 0, onClick: addNote }, '记下来'),
        React.createElement('button', { className: 'pd-btn', disabled: busy, onClick: condense, title: '把这部分的提问和已有笔记压成一条' }, React.createElement(Icon, { name: 'spark', size: 12 }), 'AI 浓缩'),
      ),
      error ? React.createElement('div', { className: 'pd-error' }, error) : null,
      notes.length === 0
        ? React.createElement('div', { className: 'pd-hint', style: { marginTop: 8 } }, '还没有笔记。')
        : notes.map((note) =>
            React.createElement(
              'div',
              { key: note.id, className: 'pd-note' },
              React.createElement(
                'div',
                { className: 'pd-note-head' },
                React.createElement('span', { className: `pd-note-kind${note.kind === 'ai' ? ' pd-note-ai' : ''}` }, note.kind === 'ai' ? 'AI 浓缩' : '我的笔记'),
                React.createElement('span', { className: 'pd-grow' }),
                React.createElement(
                  'button',
                  {
                    className: 'pd-btn pd-btn-sm pd-btn-ghost pd-danger',
                    onClick: () => onUpdate({ notes: (paper.notes ?? []).filter((item) => item.id !== note.id) }, true),
                    title: '删除这条笔记',
                  },
                  React.createElement(Icon, { name: 'trash', size: 11 }),
                ),
              ),
              // 笔记统一走 markdown：用户自己写的 $...$ 公式也要能渲染出来
              React.createElement(Markdown, { text: note.text }),
            ),
          ),
    ),
  );

  const corePane = React.createElement(
    'div',
    { className: 'pd-drawer-body' },
    React.createElement('div', { className: 'pd-scope' }, 'core 核：把整篇的提问与笔记收束成读后整理'),
    React.createElement(
      'div',
      { className: 'pd-msgs' },
      error ? React.createElement('div', { className: 'pd-error' }, error) : null,
      paper.core?.text
        ? React.createElement(Markdown, { text: paper.core.text })
        : React.createElement('div', { className: 'pd-hint' }, '还没有 core。先点几个板块提问、记几条笔记，再点下面的按钮生成——素材越具体，整理越有用。'),
    ),
    React.createElement(
      'div',
      { className: 'pd-composer' },
      React.createElement('button', { className: 'pd-btn pd-btn-primary', disabled: busy, onClick: buildCore }, busy ? '生成中…' : paper.core?.text ? '重新生成 core' : '生成 core 核'),
      paper.core?.updatedAt ? React.createElement('span', { className: 'pd-sub' }, `更新于 ${new Date(paper.core.updatedAt).toLocaleString()}`) : null,
    ),
  );

  return React.createElement(
    'div',
    { className: 'pd-drawer', style: { width } },
    // 左边缘 6px 是拖拽改宽的把手：双击回到默认宽度
    React.createElement('div', {
      className: 'pd-drawer-resizer',
      onMouseDown: onResizeStart,
      onDoubleClick: () => onResizeStart({ reset: true }),
      title: '拖动改宽度（双击回到默认）',
    }),
    tabs,
    tab === 'chat'
      ? chatPane
      : tab === 'notes'
        ? notesPane
        : tab === 'pdf'
          ? React.createElement(PdfPanel, {
              paperId: paper.id,
              view: paper.layout?.pdf,
              onViewChange: (next) =>
                onUpdate({ layout: { ...(paper.layout ?? {}), pdf: next } }),
              picking: picking && Boolean(selectedBlockId),
              onTogglePicking: () => {
                if (!selectedBlockId) {
                  setError('先在画布上选一个节点，再框选配图');
                  setTab('chat');
                  return;
                }
                setPicking((open) => !open);
              },
              onAskSelection: (text) => {
                // 划词提问：切回会话页签并预填（让用户还能改）
                setTab('chat');
                setDraft(`关于原文这段：\n\n${text}\n\n`);
                window.setTimeout(() => composerRef.current?.focus(), 60);
              },
              onPickBox: async (dataUrl, failure) => {
                setPicking(false);
                if (!dataUrl) {
                  setError(failure ?? '框选失败');
                  return;
                }
                if (!onCaptureFigure) return;
                await onCaptureFigure(dataUrl, selectedBlockId);
              },
            })
          : corePane,
  );
}
