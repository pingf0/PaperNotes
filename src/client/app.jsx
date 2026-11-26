/**
 * 论文台的根组件：注册在 `main` 里的一整页（左侧边栏的图标切到它），
 * 以及论文库这一层。
 *
 * 状态都在这里（一个会话一个人用，不需要全局 store）：
 *   - library 层：分类、论文列表、导入、设置、对比选择；
 *   - paper 层：交给 canvas.jsx（画布）与 drawer.jsx（右侧会话/笔记/core）；
 *   - compare 层：交给 compare.jsx。
 */
import { React, relativeTime } from './runtime.js';
import { api, assetUrl } from './api.js';
import { extractPaper } from './pdf.js';
import { Icon, Markdown, Modal, Spinner } from './ui.jsx';
import { PaperView } from './canvas.jsx';
import { CompareView } from './compare.jsx';

/** 超过这个天数没打开的论文在列表里标黄（"该复习了"）。 */
const STALE_DAYS = 14;

/**
 * 论文台根组件。
 * @param {{ registerStyle: () => () => void }} props 由 apply 注入的样式挂载器
 */
export function PaperDesk({ registerStyle }) {
  const { useEffect, useMemo, useRef, useState } = React;
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [assetsReady, setAssetsReady] = useState(true);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const [activeCat, setActiveCat] = useState('all');
  const [sort, setSort] = useState('recent');
  const [selected, setSelected] = useState([]);
  const [paperId, setPaperId] = useState(null);
  const [importing, setImporting] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [compareIds, setCompareIds] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [creating, setCreating] = useState(false);
  /** 右键菜单：{ paper, x, y } */
  const [menu, setMenu] = useState(null);
  const fileInput = useRef(null);

  /** 页面挂载时装一次样式，卸载时移除（同一份样式只留一个 <style>）。 */
  useEffect(() => registerStyle(), [registerStyle]);

  /** 拉一次后端状态（分类 + 论文摘要）。 */
  const refresh = async () => {
    setLoading(true);
    try {
      const next = await api.state();
      setState(next);
      setError('');
      // 宿主自检：只有明确报"缺资源"才提示。拿不到 assets 字段（旧一代宿主）说明"不知道"，
      // 不能当成"坏了"——否则会对着一个能用的旧宿主喊狼来了。
      try {
        const health = await api.health();
        setAssetsReady(health.assets ? Boolean(health.assets.pdfjs && health.assets.worker) : true);
      } catch {
        setAssetsReady(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (state === null) refresh();
  }, [state]);

  const papers = state?.papers ?? [];
  const categories = state?.categories ?? [];

  /** 当前分类下的论文，并按"最近 / 最久没看"排序。 */
  const visible = useMemo(() => {
    const filtered = papers.filter((paper) => {
      if (activeCat === 'all') return true;
      if (activeCat === 'uncat') return !paper.categoryId;
      return paper.categoryId === activeCat;
    });
    return [...filtered].sort((a, b) =>
      sort === 'stale' ? (a.lastOpenedAt ?? 0) - (b.lastOpenedAt ?? 0) : (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0),
    );
  }, [papers, activeCat, sort]);

  /** 分类计数。 */
  const countOf = (key) => {
    if (key === 'all') return papers.length;
    if (key === 'uncat') return papers.filter((paper) => !paper.categoryId).length;
    return papers.filter((paper) => paper.categoryId === key).length;
  };

  /** 导入一批 PDF。 */
  const importFiles = async (files) => {
    const list = [...files].filter((file) => /\.pdf$/i.test(file.name) || file.type === 'application/pdf');
    if (list.length === 0) {
      setError('只能导入 PDF 文件');
      return;
    }
    for (const file of list) {
      setImporting({ name: file.name, phase: 'read', page: 0, total: 0, figures: 0 });
      try {
        const extracted = await extractPaper(file, (progress) => setImporting({ name: file.name, ...progress }));
        setImporting({ name: file.name, phase: 'understand', page: 0, total: extracted.pageCount, figures: extracted.figures.length });
        const result = await api.importPaper({
          title: file.name.replace(/\.pdf$/i, ''),
          categoryId: activeCat === 'all' || activeCat === 'uncat' ? null : activeCat,
          pages: extracted.pages,
          figures: extracted.figures,
          pdfBase64: extracted.pdfBase64,
        });
        await refresh();
        setImporting(null);
        setPaperId(result.id);
        if (result.warning) setError(result.warning);
      } catch (e) {
        setImporting(null);
        setError(`${file.name}：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };

  /** 删除论文。 */
  const removePaper = async (paper) => {
    if (!window.confirm(`删除《${paper.title}》？节点、笔记和会话都会一起删掉。`)) return;
    try {
      await api.deletePaper(paper.id);
      setSelected((prev) => prev.filter((id) => id !== paper.id));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const closeAll = () => {
    setPaperId(null);
    setCompareIds(null);
  };

  const header = React.createElement(
    'div',
    { className: 'pd-top' },
    paperId || compareIds ? React.createElement('button', { className: 'pd-btn pd-btn-ghost', onClick: closeAll }, React.createElement(Icon, { name: 'back' }), '论文库') : null,
    React.createElement('div', { className: 'pd-title' }, paperId ? 'PaperNotes · 阅读' : compareIds ? 'PaperNotes · 对比' : 'PaperNotes'),
    !paperId && !compareIds ? React.createElement('span', { className: 'pd-sub' }, `${papers.length} 篇 · ${categories.length} 个分类`) : null,
    React.createElement('div', { className: 'pd-grow' }),
    !paperId && !compareIds
      ? [
          selected.length >= 2
            ? React.createElement('button', { key: 'cmp', className: 'pd-btn', onClick: () => setCompareIds([...selected]) }, React.createElement(Icon, { name: 'compare' }), `对比 ${selected.length} 篇`)
            : null,
          React.createElement('button', { key: 'sort', className: 'pd-btn pd-btn-ghost', onClick: () => setSort(sort === 'recent' ? 'stale' : 'recent') }, sort === 'recent' ? '排序：最近打开' : '排序：最久没看'),
          React.createElement('button', { key: 'imp', className: 'pd-btn pd-btn-primary', onClick: () => fileInput.current?.click() }, React.createElement(Icon, { name: 'plus' }), '导入论文'),
        ]
      : null,
    React.createElement('button', { className: 'pd-btn pd-btn-ghost', onClick: () => setShowSettings(true), title: '设置数据目录' }, React.createElement(Icon, { name: 'gear' })),
  );

  const sidebar = React.createElement(
    'div',
    { className: 'pd-side' },
    React.createElement(
      'div',
      { className: 'pd-side-head' },
      React.createElement('span', { className: 'pd-side-label' }, '分类'),
      React.createElement('button', { className: 'pd-btn pd-btn-sm pd-btn-ghost', onClick: () => setCreating(true), title: '新建分类' }, React.createElement(Icon, { name: 'plus', size: 12 })),
    ),
    React.createElement(
      'div',
      { className: 'pd-cats' },
      ...[
        { key: 'all', name: '全部论文' },
        { key: 'uncat', name: '未分类' },
        ...categories.map((category) => ({ key: category.id, name: category.name, category })),
      ].map((entry) =>
        React.createElement(
          'div',
          {
            key: entry.key,
            className: `pd-cat${activeCat === entry.key ? ' is-active' : ''}`,
            onClick: () => setActiveCat(entry.key),
          },
          React.createElement('span', { className: 'pd-cat-name', title: entry.name }, entry.name),
          React.createElement('span', { className: 'pd-cat-count' }, String(countOf(entry.key))),
          entry.category
            ? React.createElement(
                'button',
                {
                  className: 'pd-btn pd-btn-sm pd-btn-ghost pd-cat-edit',
                  title: '重命名 / 删除分类',
                  onClick: (event) => {
                    event.stopPropagation();
                    setRenaming(entry.category);
                  },
                },
                React.createElement(Icon, { name: 'pencil', size: 11 }),
              )
            : null,
        ),
      ),
    ),
  );

  const library = React.createElement(
    'div',
    { className: 'pd-main' },
    React.createElement(
      'div',
      { className: 'pd-scroll', onDragOver: (event) => event.preventDefault(), onDrop: (event) => {
        event.preventDefault();
        importFiles(event.dataTransfer.files);
      } },
      error ? React.createElement('div', { className: 'pd-error', style: { marginBottom: 10 } }, error) : null,
      !assetsReady && !noticeDismissed
        ? React.createElement(
            'div',
            { className: 'pd-notice' },
            React.createElement(
              'div',
              { className: 'pd-notice-text' },
              '当前运行的还是插件旧版本（pdf.js 资源未加载），现在导入 PDF 会失败。退出并重开 DSH 桌面应用后即可正常导入。',
            ),
            React.createElement(
              'button',
              { className: 'pd-btn pd-btn-sm pd-btn-ghost', onClick: () => setNoticeDismissed(true) },
              '知道了',
            ),
          )
        : null,
      loading && papers.length === 0
        ? React.createElement('div', { className: 'pd-empty' }, React.createElement(Spinner), ' 正在读取论文库…')
        : visible.length === 0
          ? React.createElement(
              'div',
              { className: 'pd-empty' },
              '这个分类下还没有论文。',
              React.createElement('br'),
              '把 PDF 拖进来，或点右上角「导入论文」。',
            )
          : visible.map((paper) => {
              const stale = paper.lastOpenedAt > 0 && Date.now() - paper.lastOpenedAt > STALE_DAYS * 86_400_000;
              const chosen = selected.includes(paper.id);
              return React.createElement(
                'div',
                {
                  key: paper.id,
                  className: `pd-paper${chosen ? ' is-selected' : ''}`,
                  onClick: () => setPaperId(paper.id),
                  onContextMenu: (event) => {
                    event.preventDefault();
                    setMenu({ paper, x: event.clientX, y: event.clientY });
                  },
                },
                React.createElement(
                  'div',
                  { className: 'pd-thumb' },
                  paper.thumb ? React.createElement('img', { src: assetUrl(paper.id, paper.thumb), alt: '' }) : '无配图',
                ),
                React.createElement(
                  'div',
                  null,
                  React.createElement('div', { className: 'pd-paper-title' }, paper.title),
                  React.createElement('div', { className: 'pd-paper-desc' }, paper.abstract || '（还没有概括）'),
                  React.createElement(
                    'div',
                    { className: 'pd-paper-meta' },
                    React.createElement('span', null, `${paper.blockCount} 个节点`),
                    React.createElement('span', null, `${paper.questionCount} 个提问`),
                    React.createElement('span', null, `${paper.noteCount} 条笔记`),
                    paper.hasCore ? React.createElement('span', { className: 'pd-chip' }, 'core 已生成') : null,
                    paper.warning ? React.createElement('span', { className: 'pd-chip' }, '⚠ 自动分段') : null,
                  ),
                ),
                React.createElement(
                  'div',
                  { className: 'pd-paper-right' },
                  React.createElement('div', { className: `pd-time${stale ? ' is-stale' : ''}`, title: '最近一次打开' }, relativeTime(paper.lastOpenedAt)),
                  React.createElement(
                    'div',
                    { style: { display: 'flex', gap: 4 } },
                    React.createElement(
                      'button',
                      {
                        className: 'pd-btn pd-btn-sm pd-btn-ghost',
                        title: chosen ? '取消对比' : '加入对比',
                        onClick: (event) => {
                          event.stopPropagation();
                          setSelected((prev) => (chosen ? prev.filter((id) => id !== paper.id) : [...prev, paper.id]));
                        },
                      },
                      React.createElement(Icon, { name: chosen ? 'check' : 'compare', size: 12 }),
                    ),
                    React.createElement(
                      'button',
                      {
                        className: 'pd-btn pd-btn-sm pd-btn-ghost pd-danger',
                        title: '删除',
                        onClick: (event) => {
                          event.stopPropagation();
                          removePaper(paper);
                        },
                      },
                      React.createElement(Icon, { name: 'trash', size: 12 }),
                    ),
                  ),
                ),
              );
            }),
    ),
  );

  /** 把论文移动到/复制到某个分类。 */
  const assign = async (paper, categoryId, mode) => {
    setMenu(null);
    try {
      if (mode === 'copy') await api.copyPaper(paper.id, categoryId);
      else await api.patchPaper(paper.id, { categoryId });
      await refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // 旧一代宿主没有 /paper/copy 路由：与其抛 "no route: POST /paper/copy"，不如说清楚怎么办
      setError(
        message.includes('no route') || message.includes('404')
          ? '「复制」需要更新后的宿主：请重启一次 DSH 桌面应用；「移动」不受影响。'
          : message,
      );
    }
  };

  const categoryOptions = React.useMemo(
    () => [{ id: null, name: '未分类' }, ...categories.map((category) => ({ id: category.id, name: category.name }))],
    [categories],
  );

  const contextMenu = menu
    ? React.createElement(PaperContextMenu, {
        menu,
        options: categoryOptions,
        current: menu.paper.categoryId ?? null,
        onClose: () => setMenu(null),
        onMove: (categoryId) => assign(menu.paper, categoryId, 'move'),
        onCopy: (categoryId) => assign(menu.paper, categoryId, 'copy'),
        onOpen: () => setPaperId(menu.paper.id),
        onDelete: () => {
          setMenu(null);
          removePaper(menu.paper);
        },
      })
    : null;

  const importMask = importing
    ? React.createElement(
        'div',
        { className: 'pd-modal-mask' },
        React.createElement(
          'div',
          { className: 'pd-modal', style: { width: 420 } },
          React.createElement('div', { className: 'pd-modal-head' }, '正在导入'),
          React.createElement(
            'div',
            { className: 'pd-modal-body' },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, React.createElement(Spinner), importing.name),
            React.createElement(
              'div',
              { className: 'pd-hint' },
              importing.phase === 'read'
                ? `抽取文字与图：第 ${importing.page ?? 0} / ${importing.total ?? '?'} 页，已找到 ${importing.figures ?? 0} 张图`
                : importing.phase === 'understand'
                  ? `让模型理解并分段（${importing.figures} 张图参与编号）…这一步通常 20-60 秒`
                  : '整理中…',
            ),
          ),
        ),
      )
    : null;

  const settingsMask = showSettings
    ? React.createElement(SettingsModal, {
        dir: state?.dir ?? '',
        llmReady: state?.llmReady,
        onClose: () => setShowSettings(false),
        onSaved: (dir) => {
          setShowSettings(false);
          setState(null);
          setError(`数据目录已切到 ${dir}`);
        },
      })
    : null;

  const renameMask = renaming
    ? React.createElement(RenameModal, {
        category: renaming,
        onClose: () => setRenaming(null),
        onRename: async (name) => {
          await api.renameCategory(renaming.id, name);
          setRenaming(null);
          await refresh();
        },
        onDelete: async () => {
          if (!window.confirm(`删除分类「${renaming.name}」？其中的论文会移到「未分类」。`)) return;
          await api.deleteCategory(renaming.id);
          setRenaming(null);
          if (activeCat === renaming.id) setActiveCat('all');
          await refresh();
        },
      })
    : null;

  const createMask = creating
    ? React.createElement(RenameModal, {
        category: { name: '' },
        title: '新建分类',
        confirmText: '创建',
        onClose: () => setCreating(false),
        onRename: async (name) => {
          await api.createCategory(name);
          setCreating(false);
          await refresh();
        },
      })
    : null;

  const body = paperId
    ? React.createElement(PaperView, {
        paperId,
        onClose: () => setPaperId(null),
        onChanged: refresh,
      })
    : compareIds
      ? React.createElement(CompareView, {
          paperIds: compareIds,
          onClose: () => setCompareIds(null),
          onOpenPaper: (id) => {
            setCompareIds(null);
            setPaperId(id);
          },
        })
      : React.createElement('div', { className: 'pd-body' }, sidebar, library);

  return React.createElement(
    'div',
    { className: 'pd-page' },
    header,
    body,
    React.createElement('input', {
      ref: fileInput,
      type: 'file',
      accept: 'application/pdf,.pdf',
      multiple: true,
      style: { display: 'none' },
      onChange: (event) => {
        importFiles(event.target.files);
        event.target.value = '';
      },
    }),
    contextMenu,
    importMask,
    settingsMask,
    renameMask,
    createMask,
  );
}

/**
 * 数据目录设置。
 * @param {{ dir: string, llmReady?: boolean, onClose: () => void, onSaved: (dir: string) => void }} props
 */
function SettingsModal({ dir, llmReady, onClose, onSaved }) {
  const { useState } = React;
  const [value, setValue] = useState(dir);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [assetsReady, setAssetsReady] = useState(true);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  return React.createElement(
    Modal,
    {
      title: '设置',
      onClose,
      footer: [
        React.createElement('button', { key: 'c', className: 'pd-btn', onClick: onClose }, '取消'),
        React.createElement(
          'button',
          {
            key: 's',
            className: 'pd-btn pd-btn-primary',
            disabled: busy || value.trim().length === 0,
            onClick: async () => {
              setBusy(true);
              try {
                const result = await api.setDataDir(value.trim());
                onSaved(result.dataDir);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            },
          },
          '保存并切换',
        ),
      ],
    },
    React.createElement(
      'div',
      { className: 'pd-field' },
      React.createElement('span', { className: 'pd-field-label' }, '数据目录'),
      React.createElement('input', { className: 'pd-input', value, onChange: (event) => setValue(event.target.value) }),
    ),
    React.createElement(
      'div',
      { className: 'pd-hint' },
      '论文、裁出来的图、笔记和会话都存在这个目录下（index.json + papers/<id>/）。换目录等于换一个论文库：旧目录的内容不会自动搬过去，确认后再切。',
      React.createElement('br'),
      `模型：${llmReady ? '已就绪（用当前对话的模型）' : '不可用——请先在模型选择器里配置一个模型，导入时才能自动分段'}`,
    ),
    error ? React.createElement('div', { className: 'pd-error' }, error) : null,
  );
}

/**
 * 分类的新建 / 重命名 / 删除。
 * @param {{ category: {id?: string, name: string}, title?: string, confirmText?: string, onClose: () => void, onRename: (name: string) => Promise<void>, onDelete?: () => Promise<void> }} props
 */
function RenameModal({ category, title, confirmText, onClose, onRename, onDelete }) {
  const { useState } = React;
  const [name, setName] = useState(category.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [assetsReady, setAssetsReady] = useState(true);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return React.createElement(
    Modal,
    {
      title: title ?? '分类',
      onClose,
      footer: [
        onDelete
          ? React.createElement('button', { key: 'd', className: 'pd-btn pd-danger', disabled: busy, onClick: () => run(onDelete) }, '删除分类')
          : null,
        React.createElement('button', { key: 'c', className: 'pd-btn', onClick: onClose }, '取消'),
        React.createElement(
          'button',
          { key: 's', className: 'pd-btn pd-btn-primary', disabled: busy || name.trim().length === 0, onClick: () => run(() => onRename(name.trim())) },
          confirmText ?? '保存',
        ),
      ].filter(Boolean),
    },
    React.createElement(
      'div',
      { className: 'pd-field' },
      React.createElement('span', { className: 'pd-field-label' }, '分类名'),
      React.createElement('input', { className: 'pd-input', value: name, autoFocus: true, onChange: (event) => setName(event.target.value) }),
    ),
    React.createElement('div', { className: 'pd-hint' }, '比如 continual-learning、cross-domain-learning；分类只影响论文库的归类，不影响内容。'),
    error ? React.createElement('div', { className: 'pd-error' }, error) : null,
  );
}

export { Markdown };


/**
 * 论文行的右键菜单：移动 / 复制到分类，另外给「打开」「删除」留了位置。
 * 固定在鼠标位置，点外面或按 Esc 关闭。
 * @param {{ menu: {paper: object, x: number, y: number}, options: Array, current: string|null, onClose: () => void, onMove: (id: string|null) => void, onCopy: (id: string|null) => void, onOpen: () => void, onDelete: () => void }} props
 */
function PaperContextMenu({ menu, options, current, onClose, onMove, onCopy, onOpen, onDelete }) {
  const { useEffect, useRef } = React;
  const ref = useRef(null);
  useEffect(() => {
    const onDown = (event) => {
      if (!ref.current?.contains(event.target)) onClose();
    };
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // 别让菜单跑出窗口：贴着右/下边缘时往回收
  const width = 210;
  const estimatedHeight = 96 + options.length * 26 * 2;
  const left = Math.min(menu.x, Math.max(8, window.innerWidth - width - 8));
  const top = Math.min(menu.y, Math.max(8, window.innerHeight - estimatedHeight - 8));

  const row = (label, onClick, extraClass) =>
    React.createElement(
      'button',
      { className: `pd-menu-item${extraClass ? ' ' + extraClass : ''}`, onClick },
      label,
    );

  return React.createElement(
    'div',
    { className: 'pd-menu', style: { left, top, width }, ref },
    React.createElement('div', { className: 'pd-menu-title' }, menu.paper.title),
    React.createElement('div', { className: 'pd-menu-label' }, '移动到'),
    ...options.map((option) =>
      row(
        `${option.name}${option.id === current ? ' ✓' : ''}`,
        () => onMove(option.id),
        option.id === current ? 'is-current' : undefined,
      ),
    ),
    React.createElement('div', { className: 'pd-menu-sep' }),
    React.createElement('div', { className: 'pd-menu-label' }, '复制到（留一份在这）'),
    ...options.map((option) => row(option.name, () => onCopy(option.id))),
    React.createElement('div', { className: 'pd-menu-sep' }),
    row('打开', onOpen),
    row('删除', onDelete, 'pd-danger'),
  );
}
