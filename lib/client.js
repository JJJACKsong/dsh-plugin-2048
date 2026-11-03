/**
 * dsh-plugin-2048 — 浏览器半（手写 bundle，无构建步骤）。
 *
 * 两块界面：
 *   1. 侧边栏图标 `sidebar.panellist`（id: dsh-2048）；
 *   2. 主区整页 `main`（key: dsh-2048），即 2048 棋盘本身。
 *
 * 状态只写 localStorage（`dsh2048.board.v1` / `dsh2048.best.v1`），
 * 不碰会话日志、不碰工作区文件、不发布 Service、不注册 Tool。
 * 颜色只用 --dsw-alias-* 主题变量（带兜底），只有棋子本身按作品用固定的暖色。
 * 文案走 ctx.locale，中英文字典内联在本文件，locale/*.json 只给 Plugin Manager 的 meta。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-2048',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    // ── 身份 ────────────────────────────────────────────────────────────────
    const NS = 'dsh-2048'
    const PANEL_ID = 'dsh-2048'
    const LS_BOARD = 'dsh2048.board.v1'
    const LS_BEST = 'dsh2048.best.v1'
    const GAP = 10 // 棋盘内间距（px），几何全部按像素算，避免百分比缩放偏差

    // ── 规则内核（纯函数，与 React / 主题 / DOM 无关） ───────────────────────
    // #region game-core
    const SIZE = 4

    /** 棋子 id 发号器：只保证当前棋盘内唯一，不跨会话。 */
    let seq = 0
    function resetSeq() { seq = 0 }
    function bumpSeq(min) { if (Number.isFinite(min) && min > seq) seq = min }
    function nextTileId() { seq += 1; return seq }

    /** 16 格棋盘，每格 null 或 { id, value }。 */
    function emptyGrid() { return new Array(SIZE * SIZE).fill(null) }

    /** 每个方向的「目标顺序线」：line[k] 是这条线第 k 个落点格子的下标。 */
    function lineIndices(dir) {
      const spec = {
        left: { horizontal: true, reverse: false },
        right: { horizontal: true, reverse: true },
        up: { horizontal: false, reverse: false },
        down: { horizontal: false, reverse: true },
      }[dir]
      if (!spec) return []
      const lines = []
      for (let a = 0; a < SIZE; a += 1) {
        const line = []
        for (let b = 0; b < SIZE; b += 1) {
          line.push(spec.horizontal ? a * SIZE + b : b * SIZE + a)
        }
        lines.push(spec.reverse ? line.slice().reverse() : line)
      }
      return lines
    }

    /** 在空格里随机放一颗 2 或 4，返回新棋子的 id（没空格时 null）。rng 可注入以便测试。 */
    function addRandom(grid, rng) {
      const random = rng || Math.random
      const empty = []
      for (let i = 0; i < grid.length; i += 1) if (!grid[i]) empty.push(i)
      if (!empty.length) return null
      const index = empty[Math.min(empty.length - 1, Math.floor(random() * empty.length))]
      grid[index] = { id: nextTileId(), value: random() < 0.9 ? 2 : 4 }
      return grid[index].id
    }

    /** 开局：两颗新棋子。 */
    function createBoard(rng) {
      const grid = emptyGrid()
      const spawnIds = []
      const a = addRandom(grid, rng)
      if (a) spawnIds.push(a)
      const b = addRandom(grid, rng)
      if (b) spawnIds.push(b)
      return { grid, score: 0, won: false, over: false, steps: 0, spawnIds, mergedIds: [] }
    }

    /** 还有空格，或相邻有同值。 */
    function canMove(grid) {
      for (let i = 0; i < grid.length; i += 1) if (!grid[i]) return true
      for (let r = 0; r < SIZE; r += 1) {
        for (let c = 0; c < SIZE; c += 1) {
          const value = grid[r * SIZE + c].value
          if (c + 1 < SIZE && grid[r * SIZE + c + 1].value === value) return true
          if (r + 1 < SIZE && grid[(r + 1) * SIZE + c].value === value) return true
        }
      }
      return false
    }

    /**
     * 一次移动。返回 { board, moved }：没动就原样返回同一对象（React 直接不重渲染）。
     * 每格最多合并一次，靠近落点方向的一对先合。
     */
    function moveBoard(board, dir, rng) {
      const lines = lineIndices(dir)
      if (!lines.length) return { board, moved: false }
      const next = emptyGrid()
      const mergedIds = []
      let moved = false
      let gained = 0
      for (const line of lines) {
        const entries = []
        for (const index of line) {
          const tile = board.grid[index]
          if (tile) entries.push({ tile, index })
        }
        const out = []
        for (let i = 0; i < entries.length; i += 1) {
          const current = entries[i]
          const follow = entries[i + 1]
          if (follow && follow.tile.value === current.tile.value) {
            const id = nextTileId()
            gained += current.tile.value * 2
            out.push({ id, value: current.tile.value * 2, merged: true })
            mergedIds.push(id)
            moved = true
            i += 1
          } else {
            out.push({ id: current.tile.id, value: current.tile.value, merged: false, from: current.index })
          }
        }
        for (let k = 0; k < out.length; k += 1) {
          const tile = out[k]
          const target = line[k]
          next[target] = { id: tile.id, value: tile.value }
          if (!tile.merged && tile.from !== target) moved = true
        }
      }
      if (!moved) return { board, moved: false }
      const spawnedId = addRandom(next, rng)
      const won = board.won || next.some((tile) => tile && tile.value >= 2048)
      return {
        board: {
          grid: next,
          score: board.score + gained,
          won,
          over: !canMove(next),
          steps: board.steps + 1,
          spawnIds: spawnedId ? [spawnedId] : [],
          mergedIds,
        },
        moved: true,
      }
    }
    // #endregion game-core

    // ── 棋子配色（作品色，不跟主题；文字色按明度选深/浅） ────────────────────
    // 只在这里和 CSS 的 [data-v] 选择器里出现具体颜色，容器一律用主题变量。
    const TILE_CSS = [
      '.g2048-tile[data-v="2"]{background:#cdb894;color:#2f2415}',
      '.g2048-tile[data-v="4"]{background:#c9a86f;color:#2b1f0f}',
      '.g2048-tile[data-v="8"]{background:#f0a94b;color:#2b1f0f}',
      '.g2048-tile[data-v="16"]{background:#ef8a35;color:#2a1a08}',
      '.g2048-tile[data-v="32"]{background:#e9702a;color:#fff6ea}',
      '.g2048-tile[data-v="64"]{background:#dd5220;color:#fff6ea}',
      '.g2048-tile[data-v="128"]{background:#d9a72f;color:#2a1f07}',
      '.g2048-tile[data-v="256"]{background:#c78d1c;color:#fff8e8}',
      '.g2048-tile[data-v="512"]{background:#b3740f;color:#fff8e8}',
      '.g2048-tile[data-v="1024"]{background:#9c5c08;color:#fff8e8}',
      '.g2048-tile[data-v="2048"]{background:linear-gradient(150deg,#f7c46a,#dd7f16);color:#2a1a05;box-shadow:0 0 0 1px rgba(247,196,106,.55),0 6px 18px rgba(221,127,22,.35)}',
      '.g2048-tile[data-v="4096"],.g2048-tile[data-v="8192"]{background:linear-gradient(150deg,#8a4a06,#4a2703);color:#ffeccb;box-shadow:0 0 0 1px rgba(247,196,106,.35),0 6px 18px rgba(138,74,6,.4)}',
    ].join('\n')

    const CSS = [
      // 页面与骨架
      '.g2048-page{height:100%;min-height:0;overflow:auto;display:flex;padding:22px 24px 30px;box-sizing:border-box;background:transparent}',
      '.g2048-shell{margin:auto;width:min(100%,520px,62vh);display:flex;flex-direction:column;gap:14px}',
      // 顶栏
      '.g2048-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap}',
      '.g2048-brand{display:flex;flex-direction:column;gap:7px;min-width:0}',
      '.g2048-wordmark{display:flex;align-items:center;gap:8px}',
      '.g2048-logo{display:flex;color:#e8912a}',
      '.g2048-title{font-size:32px;font-weight:800;line-height:1;letter-spacing:.06em;background:linear-gradient(135deg,#f8cd74,#e07a1f);-webkit-background-clip:text;background-clip:text;color:transparent}',
      '.g2048-sub{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#9a9a9a)}',
      '.g2048-stats{display:flex;gap:8px;flex-wrap:wrap}',
      '.g2048-stat{min-width:70px;padding:7px 10px;border-radius:10px;box-sizing:border-box;text-align:center;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2))}',
      '.g2048-stat-k{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#9a9a9a)}',
      '.g2048-stat-v{font-size:17px;font-weight:700;line-height:1.3;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,inherit)}',
      '.g2048-stat.is-best .g2048-stat-v{color:#e8912a}',
      // 棋盘
      '.g2048-board{position:relative;width:100%;aspect-ratio:1/1;border-radius:16px;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.13));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));touch-action:none;user-select:none;-webkit-user-select:none;overflow:hidden}',
      '.g2048-cells{position:absolute;inset:' + GAP + 'px;display:grid;grid-template-columns:repeat(4,1fr);grid-template-rows:repeat(4,1fr);gap:' + GAP + 'px}',
      '.g2048-cell{border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.09))}',
      '.g2048-tiles{position:absolute;inset:' + GAP + 'px}',
      '.g2048-slot{position:absolute;left:0;top:0;transition:transform 110ms cubic-bezier(.22,.68,.32,1);will-change:transform}',
      '.g2048-tile{display:flex;align-items:center;justify-content:center;width:100%;height:100%;border-radius:10px;font-size:1em;font-weight:800;line-height:1;letter-spacing:-.02em;font-variant-numeric:tabular-nums;box-shadow:0 1px 2px rgba(40,26,8,.18)}',
      '.g2048-tile[data-len="3"]{font-size:.78em}',
      '.g2048-tile[data-len="4"]{font-size:.64em}',
      '.g2048-tile[data-len="5"]{font-size:.54em}',
      '.g2048-tile.is-new{animation:g2048-appear 150ms ease-out}',
      '.g2048-tile.is-merged{animation:g2048-pop 190ms ease-out}',
      '.g2048-board.is-shaking{animation:g2048-shake 230ms ease-in-out}',
      '@keyframes g2048-appear{from{transform:scale(.3);opacity:0}to{transform:scale(1);opacity:1}}',
      '@keyframes g2048-pop{0%{transform:scale(1)}45%{transform:scale(1.16)}100%{transform:scale(1)}}',
      '@keyframes g2048-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-5px)}40%{transform:translateX(5px)}60%{transform:translateX(-3px)}80%{transform:translateX(3px)}}',
      // 结算浮层
      '.g2048-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center;background:var(--dsw-alias-bg-overlay,rgba(24,20,16,.72));backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);animation:g2048-fade 170ms ease-out}',
      '@keyframes g2048-fade{from{opacity:0}to{opacity:1}}',
      '.g2048-ov-title{font-size:21px;font-weight:800;letter-spacing:.02em;color:var(--dsw-alias-label-primary,inherit)}',
      '.g2048-ov-title.is-win{background:linear-gradient(135deg,#f8cd74,#e07a1f);-webkit-background-clip:text;background-clip:text;color:transparent}',
      '.g2048-ov-body{max-width:260px;font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary,#9a9a9a)}',
      '.g2048-ov-actions{display:flex;gap:8px;margin-top:4px}',
      // 页脚与按钮
      '.g2048-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.g2048-hint{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,#9a9a9a)}',
      '.g2048-actions{display:flex;gap:8px}',
      '.g2048-btn{appearance:none;padding:7px 14px;border-radius:9px;font:inherit;font-size:12.5px;font-weight:600;line-height:1.2;cursor:pointer;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));transition:background 120ms ease,border-color 120ms ease,transform 80ms ease,opacity 120ms ease}',
      '.g2048-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.2));border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.4))}',
      '.g2048-btn:active:not(:disabled){transform:translateY(1px)}',
      '.g2048-btn:disabled{opacity:.42;cursor:default}',
      '.g2048-btn.is-primary{background:linear-gradient(135deg,#f2b455,#e0811f);border-color:transparent;color:#2a1a05;box-shadow:0 2px 8px rgba(224,129,31,.28)}',
      '.g2048-btn.is-primary:hover:not(:disabled){background:linear-gradient(135deg,#f6c06a,#e88a26);border-color:transparent}',
      '.g2048-btn:focus-visible,.g2048-board:focus-visible{outline:2px solid #e8912a;outline-offset:2px}',
      // 窄屏
      '@media (max-width:520px){.g2048-title{font-size:26px}.g2048-page{padding:14px 14px 20px}.g2048-stat{min-width:58px;padding:6px 8px}.g2048-stat-v{font-size:15px}}',
      // 尊重减少动效
      '@media (prefers-reduced-motion:reduce){.g2048-slot{transition:none}.g2048-tile.is-new,.g2048-tile.is-merged,.g2048-overlay,.g2048-board.is-shaking{animation:none}}',
      TILE_CSS,
    ].join('\n')

    // ── 文案 ────────────────────────────────────────────────────────────────
    const ZH = {
      'nav.label': '2048',
      'panel.subtitle': 'agent 还在跑？先来一局，等它。',
      'stat.score': '得分',
      'stat.best': '最高',
      'stat.steps': '步数',
      'action.undo': '撤销',
      'action.new': '新局',
      'hint.move': '↑ ↓ ← → 或 W A S D 移动 · 触屏可滑动 · 合到 2048 通关',
      'board.label': '2048 棋盘',
      'won.title': '2048 达成',
      'won.body': '这一格到了。继续滚雪球，还是收工？',
      'won.continue': '继续玩',
      'won.new': '开新局',
      'over.title': '没路可走了',
      'over.body': '16 格塞满且没有相邻同值。这局就到这。',
      'over.new': '再来一局',
    }
    const EN = {
      'nav.label': '2048',
      'panel.subtitle': 'Agent still running? Take a quick round while it works.',
      'stat.score': 'Score',
      'stat.best': 'Best',
      'stat.steps': 'Moves',
      'action.undo': 'Undo',
      'action.new': 'New game',
      'hint.move': 'Arrows or W A S D to move · swipe on touch · reach 2048 to win',
      'board.label': '2048 board',
      'won.title': '2048 reached',
      'won.body': 'You got there. Keep pushing for a bigger tile, or stop here?',
      'won.continue': 'Keep going',
      'won.new': 'New game',
      'over.title': 'No moves left',
      'over.body': 'All 16 cells are full with no adjacent pair to merge.',
      'over.new': 'Play again',
    }

    let translate = (key) => ZH[key] || key
    const localeListeners = new Set()
    function t(key) { return translate(key) }

    /** 语言切换时让面板重渲染（文案是内联字典，不重新注册）。 */
    function useLocaleVersion() {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => force((n) => n + 1)
        localeListeners.add(listener)
        return () => { localeListeners.delete(listener) }
      }, [])
    }

    // ── 本地存档 ────────────────────────────────────────────────────────────
    function readLS(key) {
      try { return window.localStorage.getItem(key) } catch (error) { return null }
    }
    function writeLS(key, value) {
      try { window.localStorage.setItem(key, value) } catch (error) { /* 隐私模式/配额满：不玩也能玩 */ }
    }

    function loadBoard() {
      let raw = null
      try { raw = JSON.parse(readLS(LS_BOARD) || 'null') } catch (error) { raw = null }
      if (!raw || !Array.isArray(raw.grid) || raw.grid.length !== SIZE * SIZE) return createBoard()
      const grid = raw.grid.map((tile) => (
        tile && typeof tile.value === 'number' && typeof tile.id === 'number'
          ? { id: tile.id, value: tile.value }
          : null
      ))
      const ids = grid.filter(Boolean).map((tile) => tile.id)
      const maxId = ids.length ? Math.max.apply(null, ids) : 0
      bumpSeq(maxId)
      const board = {
        grid,
        score: Number(raw.score) || 0,
        won: Boolean(raw.won),
        over: Boolean(raw.over),
        steps: Number(raw.steps) || 0,
        spawnIds: [],
        mergedIds: [],
      }
      if (!grid.filter(Boolean).length) return createBoard()
      if (!board.over && !canMove(grid)) board.over = true
      return board
    }

    function saveBoard(board) {
      writeLS(LS_BOARD, JSON.stringify({
        grid: board.grid,
        score: board.score,
        won: board.won,
        over: board.over,
        steps: board.steps,
      }))
    }

    function loadBest() {
      const value = Number(readLS(LS_BEST))
      return Number.isFinite(value) && value > 0 ? value : 0
    }
    function saveBest(value) { writeLS(LS_BEST, String(value)) }

    // ── 侧边栏图标：2×2 棋子，右下角在选中时填实 ────────────────────────────
    function Icon2048(props) {
      const size = Number(props && props.size) > 0 ? Number(props.size) : 18
      const active = Boolean(props && props.active)
      const rect = (x, y, filled) => h('rect', {
        key: x + ':' + y,
        x, y, width: 8.2, height: 8.2, rx: 2.1,
        fill: filled ? 'currentColor' : 'none',
        'fill-opacity': filled ? 0.9 : 0,
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinejoin: 'round',
      })
      return h(
        'svg',
        {
          width: size, height: size, viewBox: '0 0 24 24',
          'aria-hidden': true, focusable: 'false',
          style: { display: 'block' },
        },
        rect(2.4, 2.4, active),
        rect(13.4, 2.4, active),
        rect(2.4, 13.4, active),
        rect(13.4, 13.4, true),
      )
    }

    // ── 结算浮层 ────────────────────────────────────────────────────────────
    function Overlay(props) {
      return h(
        'div',
        { className: 'g2048-overlay', role: 'dialog', 'aria-modal': 'false', 'aria-label': props.title },
        h('div', { className: 'g2048-ov-title' + (props.win ? ' is-win' : '') }, props.title),
        props.body ? h('div', { className: 'g2048-ov-body' }, props.body) : null,
        h('div', { className: 'g2048-ov-actions' }, props.children),
      )
    }

    // ── 面板 ────────────────────────────────────────────────────────────────
    function Panel2048() {
      useLocaleVersion()

      const [board, setBoard] = useState(loadBoard)
      const [best, setBest] = useState(loadBest)
      const [history, setHistory] = useState([])
      const [keepGoing, setKeepGoing] = useState(false)
      const [shaking, setShaking] = useState(false)
      const [cellPx, setCellPx] = useState(96)

      const boardRef = useRef(board)
      const historyRef = useRef(history)
      const boardElRef = useRef(null)
      const swipeRef = useRef(null)
      const bestRef = useRef(best)
      bestRef.current = best

      // 棋盘实测宽度 → 单格像素（统一按像素定位，缩放时不会错位）
      useEffect(() => {
        const el = boardElRef.current
        if (!el || typeof ResizeObserver === 'undefined') return undefined
        const measure = () => {
          const inner = el.clientWidth - 2 * GAP // clientWidth 不含 border
          const cell = Math.max(18, (inner - 3 * GAP) / 4)
          setCellPx(Math.round(cell * 100) / 100)
        }
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(el)
        return () => observer.disconnect()
      }, [])

      // 每次棋盘变化：落盘 + 追最高分
      useEffect(() => {
        boardRef.current = board
        saveBoard(board)
        if (board.score > bestRef.current) {
          bestRef.current = board.score
          setBest(board.score)
          saveBest(board.score)
        }
      }, [board])

      const commit = useCallback((next) => {
        boardRef.current = next
        setBoard(next)
      }, [])

      const applyMove = useCallback((dir) => {
        const prev = boardRef.current
        if (prev.over) return
        const result = moveBoard(prev, dir)
        if (!result.moved) {
          setShaking(true)
          return
        }
        historyRef.current = [{
          grid: prev.grid,
          score: prev.score,
          won: prev.won,
          over: prev.over,
          steps: prev.steps,
        }].concat(historyRef.current).slice(0, 30)
        setHistory(historyRef.current)
        commit(result.board)
      }, [commit])

      const undo = useCallback(() => {
        const snapshot = historyRef.current[0]
        if (!snapshot) return
        historyRef.current = historyRef.current.slice(1)
        setHistory(historyRef.current)
        commit({
          grid: snapshot.grid,
          score: snapshot.score,
          won: snapshot.won,
          over: snapshot.over,
          steps: snapshot.steps,
          spawnIds: [],
          mergedIds: [],
        })
      }, [commit])

      const newGame = useCallback(() => {
        historyRef.current = []
        setHistory(historyRef.current)
        setKeepGoing(false)
        setShaking(false)
        commit(createBoard())
      }, [commit])

      // 键盘：只在面板挂载期间生效（切走面板即解绑）
      const moveRef = useRef(applyMove)
      useEffect(() => { moveRef.current = applyMove }, [applyMove])
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
          const target = event.target
          if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
          const key = event.key
          let dir = null
          if (key === 'ArrowLeft' || key === 'a' || key === 'A' || key === 'h' || key === 'H') dir = 'left'
          else if (key === 'ArrowRight' || key === 'd' || key === 'D' || key === 'l' || key === 'L') dir = 'right'
          else if (key === 'ArrowUp' || key === 'w' || key === 'W' || key === 'k' || key === 'K') dir = 'up'
          else if (key === 'ArrowDown' || key === 's' || key === 'S' || key === 'j' || key === 'J') dir = 'down'
          if (!dir) return
          event.preventDefault()
          moveRef.current(dir)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [])

      const onPointerDown = (event) => { swipeRef.current = { x: event.clientX, y: event.clientY } }
      const onPointerUp = (event) => {
        const start = swipeRef.current
        swipeRef.current = null
        if (!start) return
        const dx = event.clientX - start.x
        const dy = event.clientY - start.y
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return
        if (Math.abs(dx) >= Math.abs(dy)) applyMove(dx > 0 ? 'right' : 'left')
        else applyMove(dy > 0 ? 'down' : 'up')
      }
      const onPointerCancel = () => { swipeRef.current = null }

      const tiles = useMemo(() => {
        const out = []
        const grid = board.grid
        for (let i = 0; i < grid.length; i += 1) {
          const tile = grid[i]
          if (tile) {
            out.push({
              id: tile.id,
              value: tile.value,
              row: Math.floor(i / SIZE),
              col: i % SIZE,
            })
          }
        }
        return out
      }, [board.grid])

      const spawnIds = board.spawnIds
      const mergedIds = board.mergedIds
      const tileFont = Math.max(14, Math.round(cellPx * 0.42)) + 'px'

      const stat = (label, value, best0) => h(
        'div',
        { className: 'g2048-stat' + (best0 ? ' is-best' : '') },
        h('div', { className: 'g2048-stat-k' }, label),
        h('div', { className: 'g2048-stat-v' }, value),
      )

      const boardEl = h(
        'div',
        {
          ref: boardElRef,
          className: 'g2048-board' + (shaking ? ' is-shaking' : ''),
          style: { fontSize: tileFont },
          role: 'group',
          'aria-label': t('board.label'),
          onPointerDown,
          onPointerUp,
          onPointerCancel,
          onAnimationEnd: (event) => {
            if (event.target === event.currentTarget) setShaking(false)
          },
        },
        h('div', { className: 'g2048-cells' },
          Array.from({ length: SIZE * SIZE }, (_, index) => h('div', { key: index, className: 'g2048-cell' }))),
        h('div', { className: 'g2048-tiles' },
          tiles.map((tile) => {
            const isNew = spawnIds.indexOf(tile.id) !== -1
            const isMerged = mergedIds.indexOf(tile.id) !== -1
            return h(
              'div',
              {
                key: tile.id,
                className: 'g2048-slot',
                style: {
                  width: cellPx,
                  height: cellPx,
                  transform: 'translate3d(' + (tile.col * (cellPx + GAP)) + 'px,' + (tile.row * (cellPx + GAP)) + 'px,0)',
                },
              },
              h(
                'div',
                {
                  className: 'g2048-tile' + (isNew ? ' is-new' : '') + (isMerged ? ' is-merged' : ''),
                  'data-v': String(tile.value),
                  'data-len': String(tile.value).length,
                },
                tile.value,
              ),
            )
          }),
        ),
        board.over
          ? h(Overlay, { title: t('over.title'), body: t('over.body') },
              h('button', { type: 'button', className: 'g2048-btn is-primary', onClick: newGame }, t('over.new')),
              h('button', { type: 'button', className: 'g2048-btn', onClick: undo, disabled: !history.length }, t('action.undo')))
          : board.won && !keepGoing
            ? h(Overlay, { win: true, title: t('won.title'), body: t('won.body') },
                h('button', { type: 'button', className: 'g2048-btn is-primary', onClick: () => setKeepGoing(true) }, t('won.continue')),
                h('button', { type: 'button', className: 'g2048-btn', onClick: newGame }, t('won.new')))
            : null,
      )

      return h(
        'div',
        { className: 'g2048-page' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'g2048-shell' },
          h(
            'div',
            { className: 'g2048-head' },
            h(
              'div',
              { className: 'g2048-brand' },
              h(
                'div',
                { className: 'g2048-wordmark' },
                h('span', { className: 'g2048-logo' }, h(Icon2048, { size: 26, active: true })),
                h('span', { className: 'g2048-title' }, '2048'),
              ),
              h('div', { className: 'g2048-sub' }, t('panel.subtitle')),
            ),
            h(
              'div',
              { className: 'g2048-stats' },
              stat(t('stat.score'), board.score, false),
              stat(t('stat.best'), Math.max(best, board.score), true),
              stat(t('stat.steps'), board.steps, false),
            ),
          ),
          boardEl,
          h(
            'div',
            { className: 'g2048-foot' },
            h('div', { className: 'g2048-hint' }, t('hint.move')),
            h(
              'div',
              { className: 'g2048-actions' },
              h('button', { type: 'button', className: 'g2048-btn', onClick: undo, disabled: !history.length }, t('action.undo')),
              h('button', { type: 'button', className: 'g2048-btn is-primary', onClick: newGame }, t('action.new')),
            ),
          ),
        ),
      )
    }

    // ── 注册 ────────────────────────────────────────────────────────────────
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const disposers = []
          const pairs = [['zh', ZH], ['zh-CN', ZH], ['en', EN], ['en-US', EN]]
          for (const [locale, dict] of pairs) {
            try {
              disposers.push(ctx.locale.register(NS, locale, dict))
            } catch (error) {
              // 语言标签不被接受时跳过，中文兜底仍在
            }
          }
          try {
            const bound = ctx.locale.bind(NS)
            translate = (key) => bound(key)
          } catch (error) {
            translate = (key) => ZH[key] || key
          }
          const off = ctx.locale.subscribe(() => {
            for (const listener of Array.from(localeListeners)) {
              try { listener() } catch (error) { /* 单个订阅者失败不影响其他渲染 */ }
            }
          })
          return () => {
            try { off() } catch (error) { /* 已释放 */ }
            for (const dispose of disposers) {
              try { dispose() } catch (error) { /* 已释放 */ }
            }
          }
        }, 'dsh-2048: locale dictionaries')

        // 槽位由父 entry 的 children 表声明；冷启动时声明可能晚于本 entry 激活，
        // 所以用 slots.inject 等声明出现后再注册（声明收起时注册自动释放）。
        ctx.effect(
          () => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => t('nav.label') },
            Icon2048,
          )),
          'dsh-2048: sidebar icon',
        )
        ctx.effect(
          () => ctx.slots.inject('main', () => ctx.slots.register(
            { name: 'main', key: PANEL_ID },
            Panel2048,
          )),
          'dsh-2048: main panel',
        )
      },
    }
  },
})
