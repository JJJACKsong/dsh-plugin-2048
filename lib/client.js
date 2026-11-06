/**
 * dsh-plugin-2048 — 浏览器半（手写 bundle，无构建步骤）。
 *
 * 侧边栏图标 `sidebar.panellist` + 主区整页 `main`（id/key 同为 `dsh-2048`）。
 *
 * 玩法层：
 *   - 经典 2048（4×4 / 5×5），连击奖励、撤销、音效、战绩、成就、每日种子局与战报；
 *   - 会话联动：调用 `useSessionStatus`（宿主 ui-session 提供），当有会话「在等你处理」
 *     （审批 / 提问）或「跑完但你没在看」（completionUnread）时，游戏页顶部给一条不打断的提示。
 *
 * 状态只写 localStorage（见 LS_*），不碰会话日志、不碰工作区文件、不发布 Service、不注册 Tool。
 * 颜色只用 --dsw-alias-* 主题变量（带兜底），只有棋子本身按作品用固定暖色。
 * 文案走 ctx.locale，中英文字典内联在 lib/client.js，locale/*.json 只给 Plugin Manager 的 meta。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-2048',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    // ── 身份与存档键 ────────────────────────────────────────────────────────
    const NS = 'dsh-2048'
    const PANEL_ID = 'dsh-2048'
    const LS_BOARD = 'dsh2048.board.v2'
    const LS_BOARD_LEGACY = 'dsh2048.board.v1'
    const LS_BEST = 'dsh2048.best.v2'
    const LS_BEST_LEGACY = 'dsh2048.best.v1'
    const LS_HISTORY = 'dsh2048.history.v1'
    const LS_ACHV = 'dsh2048.achv.v1'
    const LS_SOUND = 'dsh2048.sound.v1'
    const LS_DAILY = 'dsh2048.daily.v1'
    const GAP = 10
    const HISTORY_LIMIT = 10

    // ── #region game-core（纯函数，与 React / DOM 无关；单测直接抽这一段） ──
    /** 支持的棋盘尺寸与通关块：放在内核里，单测抽出来也能跑。 */
    const SIZES = [4, 5]
    const WIN_TILE = 2048

    /** mulberry32 的一步：纯函数，返回 [0,1) 与下一个状态，状态可持久化。 */
    function nextRandom(state) {
      let a = (state + 0x6d2b79f5) >>> 0
      let t = Math.imul(a ^ (a >>> 15), a | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, state: a }
    }

    /** 字符串 → 32 位种子（FNV-1a），给每日挑战定种子。 */
    function seedFrom(text) {
      let hash = 2166136261 >>> 0
      for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i)
        hash = Math.imul(hash, 16777619) >>> 0
      }
      return hash >>> 0
    }

    /** 随机种子（新随机局）。 */
    function randomSeed() {
      return (Math.random() * 0x100000000) >>> 0
    }

    /** 16 / 25 格棋盘，每格 null 或 { id, value }。 */
    function emptyGrid(size) { return new Array(size * size).fill(null) }

    /** 棋盘尺寸：4 或 5，其余一律按 4。 */
    function normalizeSize(size) { return SIZES.indexOf(size) === -1 ? 4 : size }

    /** 每个方向的「目标顺序线」：line[k] 是这条线第 k 个落点格子的下标。 */
    function lineIndices(dir, size) {
      const side = normalizeSize(size)
      const spec = {
        left: { horizontal: true, reverse: false },
        right: { horizontal: true, reverse: true },
        up: { horizontal: false, reverse: false },
        down: { horizontal: false, reverse: true },
      }[dir]
      if (!spec) return []
      const lines = []
      for (let a = 0; a < side; a += 1) {
        const line = []
        for (let b = 0; b < side; b += 1) {
          line.push(spec.horizontal ? a * side + b : b * side + a)
        }
        lines.push(spec.reverse ? line.slice().reverse() : line)
      }
      return lines
    }

    /** 在空格里随机放一颗 2 或 4：不改入参，返回 { index, value, state }。 */
    function pickSpawn(grid, state) {
      const empty = []
      for (let i = 0; i < grid.length; i += 1) if (!grid[i]) empty.push(i)
      if (!empty.length) return { index: -1, value: 0, state }
      const first = nextRandom(state)
      const index = empty[Math.min(empty.length - 1, Math.floor(first.value * empty.length))]
      const second = nextRandom(first.state)
      return { index, value: second.value < 0.9 ? 2 : 4, state: second.state }
    }

    let seq = 0
    function resetSeq() { seq = 0 }
    function bumpSeq(min) { if (Number.isFinite(min) && min > seq) seq = min }
    function nextTileId() { seq += 1; return seq }

    /**
     * 开一局。options: { seed, size, now, daily }
     * board 里 rngState / startedAt / daily 都会被持久化，所以重开浏览器能接着走同一条随机序列。
     */
    function createBoard(options) {
      const opts = options || {}
      const size = normalizeSize(opts.size)
      const seed = Number.isFinite(opts.seed) ? (opts.seed >>> 0) : randomSeed()
      const now = Number.isFinite(opts.now) ? opts.now : 0
      const grid = emptyGrid(size)
      let state = seed
      const spawnIds = []
      for (let i = 0; i < 2; i += 1) {
        const spawn = pickSpawn(grid, state)
        state = spawn.state
        if (spawn.index >= 0) {
          grid[spawn.index] = { id: nextTileId(), value: spawn.value }
          spawnIds.push(grid[spawn.index].id)
        }
      }
      return {
        size,
        grid,
        score: 0,
        won: false,
        over: false,
        steps: 0,
        combo: 0,
        maxCombo: 0,
        lastBonus: 0,
        undos: 0,
        rngState: state,
        startedAt: now,
        endedAt: 0,
        daily: typeof opts.daily === 'string' ? opts.daily : null,
        spawnIds,
        mergedIds: [],
      }
    }

    /** 还有空格，或相邻有同值。 */
    function canMove(grid, size) {
      const side = normalizeSize(size)
      for (let i = 0; i < grid.length; i += 1) if (!grid[i]) return true
      for (let r = 0; r < side; r += 1) {
        for (let c = 0; c < side; c += 1) {
          const value = grid[r * side + c].value
          if (c + 1 < side && grid[r * side + c + 1].value === value) return true
          if (r + 1 < side && grid[(r + 1) * side + c].value === value) return true
        }
      }
      return false
    }

    /** 一次移动：返回 { board, moved }；没动就原样返回同一对象（React 直接不重渲染）。 */
    function moveBoard(board, dir) {
      const side = normalizeSize(board.size)
      const lines = lineIndices(dir, side)
      if (!lines.length) return { board, moved: false }
      const next = emptyGrid(side)
      const mergedIds = []
      let moved = false
      let gained = 0
      let pairs = 0
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
            pairs += 1
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
      // 连击奖励：一手合并 ≥2 对时，每多一对给本次合并得分的 25%
      const bonus = pairs > 1 ? Math.floor(gained * 0.25 * (pairs - 1)) : 0
      const spawn = pickSpawn(next, board.rngState)
      if (spawn.index >= 0) next[spawn.index] = { id: nextTileId(), value: spawn.value }
      const won = board.won || next.some((tile) => tile && tile.value >= WIN_TILE)
      return {
        board: {
          size: side,
          grid: next,
          score: board.score + gained + bonus,
          won,
          over: !canMove(next, side),
          steps: board.steps + 1,
          combo: pairs,
          maxCombo: Math.max(board.maxCombo || 0, pairs),
          lastBonus: bonus,
          undos: board.undos || 0,
          rngState: spawn.state,
          startedAt: board.startedAt || 0,
          endedAt: board.endedAt || 0,
          daily: board.daily || null,
          spawnIds: spawn.index >= 0 ? [next[spawn.index].id] : [],
          mergedIds,
        },
        moved: true,
      }
    }

    /** 棋盘最大块。 */
    function maxTileOf(board) {
      let max = 0
      const grid = board.grid || []
      for (let i = 0; i < grid.length; i += 1) {
        const tile = grid[i]
        if (tile && tile.value > max) max = tile.value
      }
      return max
    }

    /** 撤销用的快照：只留规则状态，不带动画 id。 */
    function snapshotOf(board) {
      return {
        size: normalizeSize(board.size),
        grid: board.grid,
        score: board.score,
        won: board.won,
        over: board.over,
        steps: board.steps,
        combo: 0,
        maxCombo: board.maxCombo || 0,
        lastBonus: 0,
        undos: board.undos || 0,
        rngState: board.rngState,
        startedAt: board.startedAt || 0,
        endedAt: board.endedAt || 0,
        daily: board.daily || null,
      }
    }
    /** 每日挑战：同一天 + 同尺寸 = 同一副牌。 */
    function dailySeedFor(dateKey, size) { return seedFrom('dsh2048:' + dateKey + ':' + size) }
    // #endregion game-core

    // ── 成就 ────────────────────────────────────────────────────────────────
    const ACHIEVEMENTS = [
      { id: 'tile-128', icon: '128', test: (b) => maxTileOf(b) >= 128 },
      { id: 'tile-512', icon: '512', test: (b) => maxTileOf(b) >= 512 },
      { id: 'tile-1024', icon: '1k', test: (b) => maxTileOf(b) >= 1024 },
      { id: 'tile-2048', icon: '2k', test: (b) => maxTileOf(b) >= 2048 },
      { id: 'combo-3', icon: '×3', test: (b) => (b.maxCombo || 0) >= 3 },
      { id: 'no-undo-2048', icon: '✓', test: (b) => (b.won || maxTileOf(b) >= 2048) && (b.undos || 0) === 0 },
      { id: 'score-10000', icon: '10k', test: (b) => b.score >= 10000 },
      { id: 'score-50000', icon: '50k', test: (b) => b.score >= 50000 },
      { id: 'size-5-2048', icon: '5×5', test: (b) => (b.size === 5) && maxTileOf(b) >= 2048 },
      { id: 'daily-win', icon: '日', test: (b) => Boolean(b.daily) && (b.won || maxTileOf(b) >= 2048) },
    ]

    // ── 棋子配色（作品色，不跟主题；文字色按明度选深/浅） ────────────────────
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
      '.g2048-page{height:100%;min-height:0;overflow:auto;display:flex;padding:20px 24px 28px;box-sizing:border-box;background:transparent}',
      '.g2048-shell{margin:auto;width:min(100%,540px,62vh);display:flex;flex-direction:column;gap:12px}',
      // 会话提示条
      '.g2048-notice{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:11px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));animation:g2048-card-in 180ms cubic-bezier(.2,.75,.3,1)}',
      '.g2048-notice-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:#e8912a;box-shadow:0 0 0 3px rgba(232,145,42,.18)}',
      '.g2048-notice.is-blocked .g2048-notice-dot{background:var(--dsw-alias-state-warn-primary,#d6a23a);box-shadow:0 0 0 3px rgba(214,162,58,.2)}',
      '.g2048-notice-text{flex:1 1 auto;min-width:0;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.g2048-notice-text b{font-weight:700;color:#e8912a}',
      '.g2048-notice-btn{flex:0 0 auto;appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#9a9a9a);font:inherit;font-size:12px;padding:3px 6px;border-radius:6px;cursor:pointer}',
      '.g2048-notice-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,inherit)}',
      '.g2048-notice-btn.is-primary{color:#e8912a;font-weight:700}',
      // 顶栏
      '.g2048-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap}',
      '.g2048-brand{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.g2048-wordmark{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.g2048-logo{display:flex;color:#e8912a}',
      '.g2048-title{font-size:31px;font-weight:800;line-height:1;letter-spacing:.06em;background:linear-gradient(135deg,#f8cd74,#e07a1f);-webkit-background-clip:text;background-clip:text;color:transparent}',
      '.g2048-badge{font-size:10.5px;font-weight:700;letter-spacing:.04em;padding:3px 7px;border-radius:99px;color:#2a1a05;background:linear-gradient(135deg,#f2b455,#e0811f)}',
      '.g2048-badge.is-ghost{color:var(--dsw-alias-label-secondary,#9a9a9a);background:transparent;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));font-weight:600}',
      '.g2048-sub{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#9a9a9a)}',
      '.g2048-stats{display:flex;gap:7px;flex-wrap:wrap}',
      '.g2048-stat{min-width:64px;padding:6px 9px;border-radius:10px;box-sizing:border-box;text-align:center;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2))}',
      '.g2048-stat-k{font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#9a9a9a)}',
      '.g2048-stat-v{font-size:16px;font-weight:700;line-height:1.3;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,inherit)}',
      '.g2048-stat.is-best .g2048-stat-v{color:#e8912a}',
      // 棋盘
      '.g2048-board{position:relative;width:100%;aspect-ratio:1/1;border-radius:16px;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.13));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));touch-action:none;user-select:none;-webkit-user-select:none;overflow:hidden}',
      '.g2048-cells{position:absolute;inset:' + GAP + 'px;display:grid;gap:' + GAP + 'px}',
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
      // 连击闪字
      '.g2048-combo{position:absolute;left:0;right:0;top:14%;display:flex;justify-content:center;pointer-events:none;animation:g2048-combo 620ms ease-out forwards}',
      '.g2048-combo span{font-size:clamp(20px,5.6vmin,30px);font-weight:900;letter-spacing:.04em;color:#ffe6b8;text-shadow:0 2px 12px rgba(224,129,31,.55)}',
      '@keyframes g2048-combo{0%{opacity:0;transform:translateY(6px) scale(.8)}18%{opacity:1;transform:translateY(0) scale(1)}72%{opacity:1}100%{opacity:0;transform:translateY(-8px) scale(1.04)}}',
      // 结算小菜单
      '.g2048-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;background:var(--dsw-alias-bg-overlay,rgba(24,20,16,.72));background:color-mix(in srgb,var(--dsw-alias-bg-overlay,#181410) 82%,transparent);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);animation:g2048-fade 160ms ease-out}',
      '@keyframes g2048-fade{from{opacity:0}to{opacity:1}}',
      '.g2048-card{display:flex;flex-direction:column;align-items:center;gap:8px;width:min(100%,330px);padding:20px 18px 14px;box-sizing:border-box;text-align:center;border-radius:16px;background:var(--dsw-alias-bg-layer-1,#211d19);border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));box-shadow:0 18px 46px rgba(0,0,0,.3);animation:g2048-card-in 190ms cubic-bezier(.2,.75,.3,1)}',
      '@keyframes g2048-card-in{from{opacity:0;transform:translateY(8px) scale(.94)}to{opacity:1;transform:translateY(0) scale(1)}}',
      '.g2048-big{font-size:clamp(24px,7.2vmin,36px);font-weight:900;line-height:1.12;letter-spacing:.05em}',
      '.g2048-big.is-win{background:linear-gradient(135deg,#ffe0a0,#f2b455 40%,#e07a1f);-webkit-background-clip:text;background-clip:text;color:transparent}',
      '.g2048-big.is-over{color:var(--dsw-alias-label-secondary,#8f8f8f);letter-spacing:.09em}',
      '.g2048-ov-meta{font-size:12px;line-height:1.6;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#9a9a9a)}',
      '.g2048-ov-note{max-width:250px;font-size:11.5px;line-height:1.65;color:var(--dsw-alias-label-secondary,#858585);opacity:.85}',
      '.g2048-ov-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:7px;margin-top:4px}',
      // 页脚、工具栏、抽屉
      '.g2048-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}',
      '.g2048-hint{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,#9a9a9a);font-variant-numeric:tabular-nums}',
      '.g2048-actions{display:flex;gap:7px;flex-wrap:wrap}',
      '.g2048-btn{appearance:none;padding:6px 13px;border-radius:9px;font:inherit;font-size:12.5px;font-weight:600;line-height:1.2;cursor:pointer;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));transition:background 120ms ease,border-color 120ms ease,transform 80ms ease,opacity 120ms ease}',
      '.g2048-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.2));border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.4))}',
      '.g2048-btn:active:not(:disabled){transform:translateY(1px)}',
      '.g2048-btn:disabled{opacity:.42;cursor:default}',
      '.g2048-btn.is-primary{background:linear-gradient(135deg,#f2b455,#e0811f);border-color:transparent;color:#2a1a05;box-shadow:0 2px 8px rgba(224,129,31,.28)}',
      '.g2048-btn.is-primary:hover:not(:disabled){background:linear-gradient(135deg,#f6c06a,#e88a26);border-color:transparent}',
      '.g2048-btn.is-on{border-color:rgba(232,145,42,.55);color:#e8912a}',
      '.g2048-btn.is-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary,#9a9a9a);padding:6px 8px;font-weight:500}',
      '.g2048-btn.is-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,inherit)}',
      '.g2048-btn:focus-visible,.g2048-board:focus-visible,.g2048-drawer button:focus-visible{outline:2px solid #e8912a;outline-offset:2px}',
      '.g2048-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding-top:2px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14))}',
      '.g2048-seg{display:flex;gap:2px;padding:2px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}',
      '.g2048-seg button{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#9a9a9a);font:inherit;font-size:11.5px;font-weight:600;padding:4px 9px;border-radius:7px;cursor:pointer}',
      '.g2048-seg button.is-on{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.2));color:var(--dsw-alias-label-primary,inherit)}',
      '.g2048-drawer{display:flex;flex-direction:column;gap:6px;padding:11px 12px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));animation:g2048-card-in 160ms ease-out}',
      '.g2048-drawer-title{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#9a9a9a)}',
      '.g2048-rec{display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:baseline;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary,inherit);font-variant-numeric:tabular-nums}',
      '.g2048-rec-dim{color:var(--dsw-alias-label-secondary,#9a9a9a);font-size:11px}',
      '.g2048-achv{display:flex;flex-wrap:wrap;gap:6px}',
      '.g2048-achv-chip{display:flex;align-items:center;gap:5px;font-size:11.5px;padding:4px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));color:var(--dsw-alias-label-secondary,#9a9a9a);opacity:.55}',
      '.g2048-achv-chip.is-on{opacity:1;color:#e8912a;border-color:rgba(232,145,42,.45);background:rgba(232,145,42,.08)}',
      '.g2048-achv-icon{font-weight:800;font-size:10.5px;font-variant-numeric:tabular-nums}',
      // 成就 toast
      '.g2048-toast{position:absolute;right:14px;bottom:14px;display:flex;align-items:center;gap:9px;padding:9px 13px;border-radius:12px;background:var(--dsw-alias-bg-overlay,#211d19);border:1px solid rgba(232,145,42,.4);box-shadow:0 10px 30px rgba(0,0,0,.28);animation:g2048-card-in 200ms cubic-bezier(.2,.75,.3,1)}',
      '.g2048-toast-badge{font-weight:800;font-size:11px;color:#2a1a05;background:linear-gradient(135deg,#f2b455,#e0811f);padding:3px 7px;border-radius:7px}',
      '.g2048-toast-text{font-size:12px;color:var(--dsw-alias-label-primary,inherit)}',
      // 窄屏
      '@media (max-width:540px){.g2048-title{font-size:26px}.g2048-page{padding:12px 12px 18px}.g2048-stat{min-width:56px;padding:5px 7px}.g2048-stat-v{font-size:14px}}',
      // 尊重减少动效
      '@media (prefers-reduced-motion:reduce){.g2048-slot{transition:none}.g2048-tile.is-new,.g2048-tile.is-merged,.g2048-overlay,.g2048-card,.g2048-notice,.g2048-drawer,.g2048-toast,.g2048-combo,.g2048-board.is-shaking{animation:none}}',
      TILE_CSS,
    ].join('\n')

    // ── 文案 ────────────────────────────────────────────────────────────────
    const ZH = {
      'nav.label': '2048',
      'panel.subtitle': 'agent 还在跑？先来一局，等它。',
      'stat.score': '得分',
      'stat.best': '最高',
      'stat.max': '最大块',
      'stat.time': '用时',
      'action.undo': '撤销',
      'action.new': '新局',
      'action.continue': '继续玩',
      'action.newGame': '开新局',
      'action.again': '再来一局',
      'action.close': '关闭',
      'action.go': '去看看',
      'action.history': '战绩',
      'action.achv': '成就',
      'action.soundOn': '音效 开',
      'action.soundOff': '音效 关',
      'action.daily': '每日挑战',
      'action.dailyExit': '退出每日',
      'action.copy': '复制战报',
      'action.copied': '战报已复制',
      'hint.move': '↑ ↓ ← → / WASD 移动 · 触屏滑动 · 合到 2048 通关',
      'hint.steps': '步数 {steps} · 撤销 {undos}',
      'board.label': '2048 棋盘',
      'combo.label': '连击 ×{n} · +{bonus}',
      'badge.daily': '每日 {date}',
      'badge.dailyDone': '今日已完成',
      'won.title': '注意力惊人！',
      'won.note': '合出 2048 —— 还能继续往上堆，冲 4096。',
      'over.title': '注意力涣散！',
      'over.note': '没有可合并的相邻块了，这局就到这。',
      'meta.full': '{score} 分 · {steps} 步 · {time} · 最高连击 ×{combo} · 撤销 {undos} 次',
      'history.title': '最近战绩',
      'history.empty': '还没有打完的局。',
      'history.row': '{score} 分 · 最大 {max} · {size}×{size}',
      'history.meta': '{steps} 步 · {time}',
      'achv.title': '成就 {done}/{total}',
      'achv.tile-128': '第一块 128',
      'achv.tile-512': '第一块 512',
      'achv.tile-1024': '第一块 1024',
      'achv.tile-2048': '第一块 2048',
      'achv.combo-3': '单步三连击',
      'achv.no-undo-2048': '零撤销到 2048',
      'achv.score-10000': '单局一万分',
      'achv.score-50000': '单局五万分',
      'achv.size-5-2048': '5×5 到 2048',
      'achv.daily-win': '每日挑战通关',
      'achv.unlocked': '成就解锁：{name}',
      'notice.done': '「{title}」跑完了 · {count} 个会话有结果',
      'notice.doneOne': '「{title}」跑完了，去看看？',
      'notice.blocked': '「{title}」在等你处理',
      'notice.approval': '「{title}」在等你批准',
      'notice.question': '「{title}」在等你回答',
      'notice.unknownTitle': '有一个会话',
      'share.text': '2048 · {mode} {date}\n{score} 分 · 最大 {max} · {steps} 步 · {time}\n{size}×{size} 棋盘',
      'share.daily': '每日挑战',
      'share.random': '随机局',
    }
    const EN = {
      'nav.label': '2048',
      'panel.subtitle': 'Agent still running? Take a quick round while it works.',
      'stat.score': 'Score',
      'stat.best': 'Best',
      'stat.max': 'Max tile',
      'stat.time': 'Time',
      'action.undo': 'Undo',
      'action.new': 'New',
      'action.continue': 'Keep going',
      'action.newGame': 'New game',
      'action.again': 'Play again',
      'action.close': 'Dismiss',
      'action.go': 'Open it',
      'action.history': 'History',
      'action.achv': 'Achievements',
      'action.soundOn': 'Sound on',
      'action.soundOff': 'Sound off',
      'action.daily': 'Daily',
      'action.dailyExit': 'Leave daily',
      'action.copy': 'Copy result',
      'action.copied': 'Result copied',
      'hint.move': 'Arrows / WASD to move · swipe on touch · reach 2048 to win',
      'hint.steps': 'Moves {steps} · Undo {undos}',
      'board.label': '2048 board',
      'combo.label': 'Combo ×{n} · +{bonus}',
      'badge.daily': 'Daily {date}',
      'badge.dailyDone': 'Done today',
      'won.title': 'Laser focus!',
      'won.note': '2048 reached — keep stacking for 4096.',
      'over.title': 'Focus lost!',
      'over.note': 'No adjacent pair left to merge.',
      'meta.full': 'Score {score} · {steps} moves · {time} · best combo ×{combo} · undo {undos}',
      'history.title': 'Recent games',
      'history.empty': 'No finished games yet.',
      'history.row': '{score} pts · max {max} · {size}×{size}',
      'history.meta': '{steps} moves · {time}',
      'achv.title': 'Achievements {done}/{total}',
      'achv.tile-128': 'First 128',
      'achv.tile-512': 'First 512',
      'achv.tile-1024': 'First 1024',
      'achv.tile-2048': 'First 2048',
      'achv.combo-3': 'Triple merge in one move',
      'achv.no-undo-2048': '2048 with zero undo',
      'achv.score-10000': '10k in one game',
      'achv.score-50000': '50k in one game',
      'achv.size-5-2048': '2048 on 5×5',
      'achv.daily-win': 'Daily cleared',
      'achv.unlocked': 'Achievement: {name}',
      'notice.done': '"{title}" finished · {count} sessions with results',
      'notice.doneOne': '"{title}" finished — take a look?',
      'notice.blocked': '"{title}" is waiting on you',
      'notice.approval': '"{title}" needs your approval',
      'notice.question': '"{title}" asked you something',
      'notice.unknownTitle': 'A session',
      'share.text': '2048 · {mode} {date}\nScore {score} · max {max} · {steps} moves · {time}\n{size}×{size} board',
      'share.daily': 'Daily challenge',
      'share.random': 'Random game',
    }

    let translate = (key) => ZH[key] || key
    const localeListeners = new Set()
    function t(key) { return translate(key) }
    /** 极简占位替换：fmt('meta.full', { score, steps })。 */
    function fmt(key, vars) {
      let text = t(key)
      for (const name of Object.keys(vars)) text = text.split('{' + name + '}').join(String(vars[name]))
      return text
    }

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
      try { window.localStorage.setItem(key, value) } catch (error) { /* 隐私模式 / 配额满：不存也能玩 */ }
    }
    function readJSON(key) {
      try { return JSON.parse(readLS(key) || 'null') } catch (error) { return null }
    }
    function writeJSON(key, value) {
      try { writeLS(key, JSON.stringify(value)) } catch (error) { /* 同上 */ }
    }

    function sanitizeTiles(grid, size) {
      if (!Array.isArray(grid) || grid.length !== size * size) return null
      let maxId = 0
      const next = grid.map((tile) => {
        if (!tile || typeof tile.id !== 'number' || typeof tile.value !== 'number') return null
        if (tile.id > maxId) maxId = tile.id
        return { id: tile.id, value: tile.value }
      })
      bumpSeq(maxId)
      return next
    }

    function loadBoard() {
      let raw = readJSON(LS_BOARD)
      if (!raw || typeof raw !== 'object') raw = readJSON(LS_BOARD_LEGACY) // v1 存档可直接升级
      if (!raw || typeof raw !== 'object') return createBoard({ size: 4, now: Date.now() })
      const size = normalizeSize(raw.size)
      const grid = sanitizeTiles(raw.grid, size)
      if (!grid || !grid.filter(Boolean).length) return createBoard({ size, now: Date.now() })
      const board = {
        size,
        grid,
        score: Number(raw.score) || 0,
        won: Boolean(raw.won),
        over: Boolean(raw.over),
        steps: Number(raw.steps) || 0,
        combo: 0,
        maxCombo: Number(raw.maxCombo) || 0,
        lastBonus: 0,
        undos: Number(raw.undos) || 0,
        rngState: Number.isFinite(raw.rngState) ? (raw.rngState >>> 0) : randomSeed(),
        startedAt: Number.isFinite(raw.startedAt) && raw.startedAt > 0 ? raw.startedAt : Date.now(),
        endedAt: Number.isFinite(raw.endedAt) ? raw.endedAt : 0,
        daily: typeof raw.daily === 'string' ? raw.daily : null,
        spawnIds: [],
        mergedIds: [],
      }
      if (!board.over && !canMove(grid, size)) board.over = true
      if (board.over && !board.endedAt) board.endedAt = Date.now()
      return board
    }

    function saveBoard(board) { writeJSON(LS_BOARD, board) }

    function loadBest() {
      const raw = readJSON(LS_BEST)
      const legacy = Number(readLS(LS_BEST_LEGACY))
      const best = { 4: 0, 5: 0 }
      if (raw && typeof raw === 'object') {
        best[4] = Math.max(0, Number(raw[4]) || 0)
        best[5] = Math.max(0, Number(raw[5]) || 0)
      }
      if (!best[4] && Number.isFinite(legacy) && legacy > 0) best[4] = legacy
      return best
    }
    function saveBest(best) { writeJSON(LS_BEST, best) }

    function loadHistory() {
      const raw = readJSON(LS_HISTORY)
      return Array.isArray(raw) ? raw.filter((row) => row && typeof row.score === 'number').slice(0, HISTORY_LIMIT) : []
    }
    function saveHistory(records) { writeJSON(LS_HISTORY, records.slice(0, HISTORY_LIMIT)) }

    function loadAchv() {
      const raw = readJSON(LS_ACHV)
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    }
    function saveAchv(achv) { writeJSON(LS_ACHV, achv) }

    function loadDaily() {
      const raw = readJSON(LS_DAILY)
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    }
    function saveDaily(daily) { writeJSON(LS_DAILY, daily) }

    function loadSoundOn() { return readLS(LS_SOUND) !== 'off' }
    function saveSoundOn(on) { writeLS(LS_SOUND, on ? 'on' : 'off') }

    // ── 小工具 ──────────────────────────────────────────────────────────────
    /** 本地时区的 YYYY-MM-DD（每日挑战按本地自然日切换）。 */
    function localDateKey(now) {
      const date = new Date(now)
      const pad = (n) => (n < 10 ? '0' + n : String(n))
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    }
    function formatDuration(ms) {
      const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      const pad = (n) => (n < 10 ? '0' + n : String(n))
      return hours > 0 ? hours + ':' + pad(minutes) + ':' + pad(seconds) : pad(minutes) + ':' + pad(seconds)
    }

    // ── 音效：WebAudio 现场合成，不引任何音频文件 ───────────────────────────
    let audioCtx = null
    function withAudio(callback) {
      if (typeof window === 'undefined') return
      try {
        const Ctor = window.AudioContext || window.webkitAudioContext
        if (!Ctor) return
        if (!audioCtx) audioCtx = new Ctor()
        if (audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') audioCtx.resume()
        callback(audioCtx)
      } catch (error) { /* 没有音频能力就当静音 */ }
    }
    function tone(ctx, freq, durationMs, type, peak, delayMs) {
      try {
        const start = ctx.currentTime + (delayMs || 0) / 1000
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        const end = start + durationMs / 1000
        osc.type = type || 'sine'
        osc.frequency.setValueAtTime(freq, start)
        gain.gain.setValueAtTime(0.0001, start)
        gain.gain.exponentialRampToValueAtTime(peak || 0.06, start + 0.012)
        gain.gain.exponentialRampToValueAtTime(0.0001, end)
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.start(start)
        osc.stop(end + 0.02)
      } catch (error) { /* 单次发声失败不影响游戏 */ }
    }
    function playSfx(kind, value) {
      withAudio((ctx) => {
        if (kind === 'move') {
          tone(ctx, 196, 45, 'sine', 0.035, 0)
        } else if (kind === 'merge') {
          const base = Math.min(880, 200 + Math.log2(Math.max(2, value || 2)) * 55)
          tone(ctx, base, 85, 'triangle', 0.055, 0)
          tone(ctx, base * 1.5, 70, 'sine', 0.03, 0.03)
        } else if (kind === 'combo') {
          tone(ctx, 660, 70, 'square', 0.03, 0)
          tone(ctx, 990, 80, 'sine', 0.035, 0.05)
        } else if (kind === 'win') {
          ;[523, 659, 784, 1047].forEach((freq, index) => tone(ctx, freq, 160, 'triangle', 0.06, index * 90))
        } else if (kind === 'over') {
          ;[392, 311, 233].forEach((freq, index) => tone(ctx, freq, 200, 'sine', 0.05, index * 130))
        }
      })
    }

    // ── 侧边栏图标：2×2 棋子，右下角在选中时填实 ────────────────────────────
    function Icon2048(props) {
      const size = Number(props && props.size) > 0 ? Number(props.size) : 18
      const active = Boolean(props && props.active)
      const rect = (x, y, filled, key) => h('rect', {
        key,
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
        rect(2.4, 2.4, active, 'a'),
        rect(13.4, 2.4, active, 'b'),
        rect(2.4, 13.4, active, 'c'),
        rect(13.4, 13.4, true, 'd'),
      )
    }

    // ── 结算小菜单（通关 / 终局） ───────────────────────────────────────────
    function Overlay(props) {
      const win = props.tone === 'win'
      return h(
        'div',
        { className: 'g2048-overlay' },
        h(
          'div',
          { className: 'g2048-card', role: 'dialog', 'aria-modal': 'false', 'aria-label': props.title },
          h('div', { className: 'g2048-big' + (win ? ' is-win' : ' is-over') }, props.title),
          props.meta ? h('div', { className: 'g2048-ov-meta' }, props.meta) : null,
          props.note ? h('div', { className: 'g2048-ov-note' }, props.note) : null,
          h('div', { className: 'g2048-ov-actions' }, props.actions),
        ),
      )
    }

    // ── 会话提示：宿主 ui-session 提供的状态，不猜、不订阅日志 ──────────────
    const EMPTY_STATUS = new Map()
    function pickNotice(statusMap, list) {
      if (!statusMap || typeof statusMap.forEach !== 'function') return null
      let blocked = null
      let done = null
      let blockedCount = 0
      let doneCount = 0
      statusMap.forEach((status, sessionId) => {
        if (status && status.pendingInteraction) {
          blockedCount += 1
          if (!blocked) {
            blocked = {
              sessionId,
              kind: 'blocked',
              code: String(status.pendingInteraction.kind || 'pending'),
            }
          }
        } else if (status && status.completionUnread) {
          doneCount += 1
          if (!done) done = { sessionId, kind: 'done', code: 'done' }
        }
      })
      const hit = blocked || done
      if (!hit) return null
      return {
        sessionId: hit.sessionId,
        kind: hit.kind,
        code: hit.code,
        blockedCount,
        doneCount,
      }
    }
    function sameNotice(left, right) {
      if (left === right) return true
      if (!left || !right) return false
      return left.sessionId === right.sessionId
        && left.kind === right.kind
        && left.code === right.code
        && left.blockedCount === right.blockedCount
        && left.doneCount === right.doneCount
    }
    function noticeKey(notice) { return notice ? notice.sessionId + '|' + notice.kind + '|' + notice.code : '' }

    // ── 面板 ────────────────────────────────────────────────────────────────
    /** 从 apply 传进来的导航能力（可选；取不到就只显示提示、不给跳转按钮）。 */
    let openSessionById = null
    let showConversation = null

    function Panel2048(props) {
      useLocaleVersion()

      const [board, setBoard] = useState(loadBoard)
      const [best, setBest] = useState(loadBest)
      const [history, setHistory] = useState([])
      const [keepGoing, setKeepGoing] = useState(false)
      const [shaking, setShaking] = useState(false)
      const [cellPx, setCellPx] = useState(96)
      const [soundOn, setSoundOn] = useState(loadSoundOn)
      const [view, setView] = useState(null)
      const [achv, setAchv] = useState(loadAchv)
      const [records, setRecords] = useState(loadHistory)
      const [dailyDone, setDailyDone] = useState(loadDaily)
      const [toast, setToast] = useState(null)
      const [dismissed, setDismissed] = useState({})
      const [nowTick, setNowTick] = useState(() => Date.now())

      const boardRef = useRef(board)
      const historyRef = useRef(history)
      const boardElRef = useRef(null)
      const swipeRef = useRef(null)
      const bestRef = useRef(best)
      const soundRef = useRef(soundOn)
      const recordedRef = useRef('')
      const achvRef = useRef(achv)
      const toastTimerRef = useRef(null)
      bestRef.current = best
      soundRef.current = soundOn
      achvRef.current = achv

      // 会话状态（标准 props；宿主没提供时静默降级）
      const api = props || {}
      const statusMap = typeof api.useSessionStatus === 'function'
        ? api.useSessionStatus((value) => value)
        : EMPTY_STATUS
      const sessionsList = typeof api.useSessions === 'function'
        ? api.useSessions((value) => value)
        : null
      const notice = pickNotice(statusMap, sessionsList)
      const noticeTitle = (() => {
        if (!notice || !sessionsList || !sessionsList.byId) return ''
        const row = sessionsList.byId[notice.sessionId]
        return row ? (row.displayTitle || row.title || '') : ''
      })()

      // 棋盘实测宽度 → 单格像素（统一按像素定位，缩放时不会错位）
      useEffect(() => {
        const el = boardElRef.current
        if (!el || typeof ResizeObserver === 'undefined') return undefined
        const measure = () => {
          const side = normalizeSize(boardRef.current.size)
          const inner = el.clientWidth - 2 * GAP
          const cell = Math.max(16, (inner - (side - 1) * GAP) / side)
          setCellPx(Math.round(cell * 100) / 100)
        }
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(el)
        return () => observer.disconnect()
      }, [board.size])

      // 计时：局未结束且面板可见时每秒刷一次
      useEffect(() => {
        if (board.over) return undefined
        setNowTick(Date.now())
        const timer = setInterval(() => setNowTick(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [board.over, board.startedAt])

      // 终局时间戳：只补一次，用来冻结「用时」并落进战绩
      useEffect(() => {
        if (!board.over || board.endedAt) return
        const next = { ...board, endedAt: Date.now() }
        boardRef.current = next
        setBoard(next)
      }, [board])

      // 卸载时清掉 toast 定时器
      useEffect(() => () => {
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
      }, [])

      /** 解锁成就 + 弹 toast（幂等）。 */
      const grantAchievements = useCallback((next) => {
        const unlocked = achvRef.current
        const gained = []
        for (const item of ACHIEVEMENTS) {
          if (unlocked[item.id]) continue
          if (item.test(next)) gained.push(item)
        }
        if (!gained.length) return
        const nextAchv = { ...unlocked }
        const now = Date.now()
        for (const item of gained) nextAchv[item.id] = now
        achvRef.current = nextAchv
        setAchv(nextAchv)
        saveAchv(nextAchv)
        const latest = gained[gained.length - 1]
        setToast({ text: fmt('achv.unlocked', { name: t('achv.' + latest.id) }) })
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
        toastTimerRef.current = setTimeout(() => setToast(null), 2800)
      }, [])

      /** 结算落库：一局只记一次；每日挑战额外记完成。 */
      const finishRecord = useCallback((next) => {
        const stamp = next.startedAt || 0
        if (!stamp) return
        if (recordedRef.current === String(stamp)) return
        // 刷新页面后重新加载一局已结束的棋盘时，别再记第二条
        if (records.some((row) => row.startedAt === stamp)) {
          recordedRef.current = String(stamp)
          return
        }
        recordedRef.current = String(stamp)
        const row = {
          ts: Date.now(),
          startedAt: stamp,
          size: normalizeSize(next.size),
          score: next.score,
          max: maxTileOf(next),
          steps: next.steps,
          durationMs: Math.max(0, Date.now() - (stamp || Date.now())),
          undos: next.undos || 0,
          daily: next.daily || null,
          won: Boolean(next.won),
        }
        setRecords((prev) => {
          const merged = [row].concat(prev).slice(0, HISTORY_LIMIT)
          saveHistory(merged)
          return merged
        })
        if (next.daily) {
          const key = next.daily + ':' + normalizeSize(next.size)
          const done = { ...dailyDone, [key]: { score: row.score, max: row.max, won: row.won, ts: row.ts } }
          setDailyDone(done)
          saveDaily(done)
        }
      }, [dailyDone, records])

      // 每次棋盘变化：落盘 + 追最高分 + 巡检成就 + 终局落库
      useEffect(() => {
        boardRef.current = board
        saveBoard(board)
        const side = normalizeSize(board.size)
        const bestShown = Math.max(bestRef.current[side] || 0, board.score)
        if (bestShown !== bestRef.current[side]) {
          const nextBest = { ...bestRef.current, [side]: bestShown }
          bestRef.current = nextBest
          setBest(nextBest)
          saveBest(nextBest)
        }
        grantAchievements(board)
        if (board.over) finishRecord(board)
      }, [board, grantAchievements, finishRecord])

      // 撤销回「还没达成 2048」时，允许再次弹出通关小菜单
      useEffect(() => {
        if (!board.won) setKeepGoing(false)
      }, [board.won])

      // 音效：通关 / 终局各响一次
      const soundEventRef = useRef('')
      useEffect(() => {
        if (!soundRef.current) return
        const stamp = String(board.startedAt || 0) + ':' + board.steps
        if (board.over && soundEventRef.current !== 'over:' + stamp) {
          soundEventRef.current = 'over:' + stamp
          playSfx('over')
          return
        }
        if (board.won && !board.over && soundEventRef.current !== 'win:' + stamp) {
          soundEventRef.current = 'win:' + stamp
          playSfx('win')
        }
      }, [board.over, board.won, board.steps, board.startedAt])

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
        historyRef.current = [snapshotOf(prev)].concat(historyRef.current).slice(0, 30)
        setHistory(historyRef.current)
        const next = result.board
        commit(next)
        if (soundRef.current) {
          playSfx('move')
          if (next.combo >= 2) playSfx('combo')
          else if (next.mergedIds.length) playSfx('merge', maxTileOf(next))
        }
      }, [commit])

      const undo = useCallback(() => {
        const snapshot = historyRef.current[0]
        if (!snapshot) return
        historyRef.current = historyRef.current.slice(1)
        setHistory(historyRef.current)
        recordedRef.current = '' // 退回去重打，终局可以再记一次
        commit({
          ...snapshot,
          spawnIds: [],
          mergedIds: [],
          undos: (snapshot.undos || 0) + 1,
        })
      }, [commit])

      const startGame = useCallback((options) => {
        const prev = boardRef.current
        const size = normalizeSize(options && options.size ? options.size : prev.size)
        const daily = options && options.daily ? options.daily : null
        const now = Date.now()
        // 换局前先把上一局记进战绩（没走完的也记，省得白玩）
        if (prev.steps > 0) finishRecord(prev)
        historyRef.current = []
        setHistory(historyRef.current)
        setKeepGoing(false)
        setShaking(false)
        setView(null)
        recordedRef.current = ''
        commit(createBoard({
          size,
          now,
          daily,
          seed: daily ? dailySeedFor(daily, size) : randomSeed(),
        }))
      }, [commit, finishRecord])

      const newGame = useCallback(() => { startGame({ size: boardRef.current.size }) }, [startGame])
      const startDaily = useCallback(() => { startGame({ size: boardRef.current.size, daily: localDateKey(Date.now()) }) }, [startGame])
      const leaveDaily = useCallback(() => { startGame({ size: boardRef.current.size }) }, [startGame])
      const switchSize = useCallback((size) => {
        const next = normalizeSize(size)
        if (next === normalizeSize(boardRef.current.size)) return
        startGame({ size: next })
      }, [startGame])

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
        const side = normalizeSize(board.size)
        for (let i = 0; i < grid.length; i += 1) {
          const tile = grid[i]
          if (tile) {
            out.push({
              id: tile.id,
              value: tile.value,
              row: Math.floor(i / side),
              col: i % side,
            })
          }
        }
        return out
      }, [board.grid, board.size])

      const side = normalizeSize(board.size)
      const liveBest = Math.max(best[side] || 0, board.score)
      const maxTile = maxTileOf(board)
      const nowMs = board.over ? (board.endedAt || nowTick) : nowTick
      const durationText = formatDuration(Math.max(0, nowMs - (board.startedAt || nowMs)))
      const today = localDateKey(Date.now())
      const dailyKey = today + ':' + side
      const dailyRecord = dailyDone[dailyKey]
      const isDaily = Boolean(board.daily)
      const tileFont = Math.max(13, Math.round(cellPx * 0.42)) + 'px'

      const toggleSound = () => {
        const next = !soundRef.current
        soundRef.current = next
        setSoundOn(next)
        saveSoundOn(next)
        if (next) playSfx('merge', 16)
      }

      const copyShare = () => {
        const text = fmt('share.text', {
          mode: isDaily ? t('share.daily') : t('share.random'),
          date: board.daily || today,
          score: board.score,
          max: maxTile,
          steps: board.steps,
          time: durationText,
          size: side,
        })
        const done = () => setToast({ text: t('action.copied') })
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, done)
            return
          }
        } catch (error) { /* 落到下面的兜底 */ }
        try {
          const area = document.createElement('textarea')
          area.value = text
          document.body.appendChild(area)
          area.select()
          document.execCommand('copy')
          document.body.removeChild(area)
        } catch (error) { /* 复制失败就算了 */ }
        done()
      }

      const goToSession = () => {
        if (!notice) return
        if (openSessionById) {
          try {
            openSessionById(notice.sessionId)
            return
          } catch (error) { /* 落到会话面板兜底 */ }
        }
        if (showConversation) showConversation()
      }
      const canJump = Boolean(openSessionById || showConversation)
      const noticeDismissed = notice ? Boolean(dismissed[noticeKey(notice)]) : false
      const showNotice = Boolean(notice) && !noticeDismissed

      const stat = (label, value, highlight) => h(
        'div',
        { className: 'g2048-stat' + (highlight ? ' is-best' : '') },
        h('div', { className: 'g2048-stat-k' }, label),
        h('div', { className: 'g2048-stat-v' }, value),
      )

      const button = (key, label, onClick, primary, disabled) => h(
        'button',
        {
          key,
          type: 'button',
          className: 'g2048-btn' + (primary ? ' is-primary' : ''),
          onClick,
          disabled: Boolean(disabled),
        },
        label,
      )

      const metaText = fmt('meta.full', {
        score: board.score,
        steps: board.steps,
        time: durationText,
        combo: board.maxCombo || 1,
        undos: board.undos || 0,
      })
      // 通关优先于终局：同一手既凑到 2048 又走不动时，先报喜
      const overlay = board.won && !keepGoing
        ? h(Overlay, {
            tone: 'win',
            title: t('won.title'),
            meta: metaText,
            note: t('won.note'),
            actions: board.over
              ? [
                  button('again', t('action.again'), newGame, true),
                  button('undo', t('action.undo'), undo, false, !history.length),
                  button('share', t('action.copy'), copyShare, false),
                ]
              : [
                  button('keep', t('action.continue'), () => setKeepGoing(true), true),
                  button('new', t('action.newGame'), newGame, false),
                  button('share', t('action.copy'), copyShare, false),
                ],
          })
        : board.over
          ? h(Overlay, {
              tone: 'over',
              title: t('over.title'),
              meta: metaText,
              note: t('over.note'),
              actions: [
                button('again', t('action.again'), newGame, true),
                button('undo', t('action.undo'), undo, false, !history.length),
                button('share', t('action.copy'), copyShare, false),
              ],
            })
          : null

      const noticeBar = showNotice
        ? h(
            'div',
            { className: 'g2048-notice' + (notice.kind === 'blocked' ? ' is-blocked' : '') },
            h('span', { className: 'g2048-notice-dot', 'aria-hidden': true }),
            h(
              'span',
              { className: 'g2048-notice-text' },
              notice.kind === 'blocked'
                ? fmt(
                    notice.code.indexOf('question') !== -1 || notice.code.indexOf('plan') !== -1
                      ? 'notice.question'
                      : notice.code.indexOf('approval') !== -1 ? 'notice.approval' : 'notice.blocked',
                    { title: noticeTitle || t('notice.unknownTitle') },
                  )
                : fmt(notice.doneCount > 1 ? 'notice.done' : 'notice.doneOne', {
                    title: noticeTitle || t('notice.unknownTitle'),
                    count: notice.doneCount,
                  }),
            ),
            canJump ? h('button', { type: 'button', className: 'g2048-notice-btn is-primary', onClick: goToSession }, t('action.go')) : null,
            h('button', {
              type: 'button',
              className: 'g2048-notice-btn',
              onClick: () => setDismissed((prev) => ({ ...prev, [noticeKey(notice)]: true })),
            }, t('action.close')),
          )
        : null

      const comboFlash = board.combo >= 2
        ? h('div', { key: 'combo-' + board.steps, className: 'g2048-combo' },
            h('span', null, fmt('combo.label', { n: board.combo, bonus: board.lastBonus || 0 })))
        : null

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
        h('div', {
          className: 'g2048-cells',
          style: { gridTemplateColumns: 'repeat(' + side + ',1fr)', gridTemplateRows: 'repeat(' + side + ',1fr)' },
        }, Array.from({ length: side * side }, (_, index) => h('div', { key: index, className: 'g2048-cell' }))),
        h('div', { className: 'g2048-tiles' },
          tiles.map((tile) => {
            const isNew = board.spawnIds.indexOf(tile.id) !== -1
            const isMerged = board.mergedIds.indexOf(tile.id) !== -1
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
        comboFlash,
        overlay,
        toast
          ? h('div', { className: 'g2048-toast' },
              h('span', { className: 'g2048-toast-badge' }, t('action.achv')),
              h('span', { className: 'g2048-toast-text' }, toast.text))
          : null,
      )

      const historyDrawer = view === 'history'
        ? h('div', { className: 'g2048-drawer' },
            h('div', { className: 'g2048-drawer-title' }, t('history.title')),
            records.length
              ? records.map((row) => h('div', { key: String(row.ts), className: 'g2048-rec' },
                  h('span', null, fmt('history.row', { score: row.score, max: row.max, size: row.size })),
                  h('span', { className: 'g2048-rec-dim' }, fmt('history.meta', { steps: row.steps, time: formatDuration(row.durationMs) })),
                  h('span', { className: 'g2048-rec-dim' }, row.daily ? '★' : ''),
                ))
              : h('div', { className: 'g2048-rec-dim' }, t('history.empty')),
          )
        : null

      const unlockedCount = ACHIEVEMENTS.filter((item) => achv[item.id]).length
      const achvDrawer = view === 'achv'
        ? h('div', { className: 'g2048-drawer' },
            h('div', { className: 'g2048-drawer-title' }, fmt('achv.title', { done: unlockedCount, total: ACHIEVEMENTS.length })),
            h('div', { className: 'g2048-achv' }, ACHIEVEMENTS.map((item) => h(
              'span',
              { key: item.id, className: 'g2048-achv-chip' + (achv[item.id] ? ' is-on' : ''), title: t('achv.' + item.id) },
              h('span', { className: 'g2048-achv-icon' }, item.icon),
              t('achv.' + item.id),
            ))),
          )
        : null

      return h(
        'div',
        { className: 'g2048-page' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'g2048-shell' },
          noticeBar,
          h(
            'div',
            { className: 'g2048-head' },
            h(
              'div',
              { className: 'g2048-brand' },
              h(
                'div',
                { className: 'g2048-wordmark' },
                h('span', { className: 'g2048-logo' }, h(Icon2048, { size: 25, active: true })),
                h('span', { className: 'g2048-title' }, '2048'),
                isDaily
                  ? h('span', { className: 'g2048-badge' }, fmt('badge.daily', { date: (board.daily || today).slice(5) }))
                  : null,
                isDaily && dailyRecord
                  ? h('span', { className: 'g2048-badge is-ghost' }, t('badge.dailyDone'))
                  : null,
              ),
              h('div', { className: 'g2048-sub' }, t('panel.subtitle')),
            ),
            h(
              'div',
              { className: 'g2048-stats' },
              stat(t('stat.score'), board.score, false),
              stat(t('stat.best'), liveBest, true),
              stat(t('stat.max'), maxTile || 0, false),
              stat(t('stat.time'), durationText, false),
            ),
          ),
          boardEl,
          h(
            'div',
            { className: 'g2048-foot' },
            h('div', { className: 'g2048-hint' },
              t('hint.move'),
              h('br'),
              fmt('hint.steps', { steps: board.steps, undos: board.undos || 0 })),
            h(
              'div',
              { className: 'g2048-actions' },
              h('button', {
                type: 'button',
                className: 'g2048-btn' + (soundOn ? ' is-on' : ''),
                onClick: toggleSound,
                'aria-pressed': soundOn ? 'true' : 'false',
              }, soundOn ? t('action.soundOn') : t('action.soundOff')),
              button('undo', t('action.undo'), undo, false, !history.length),
              button('new', t('action.new'), newGame, true),
            ),
          ),
          h(
            'div',
            { className: 'g2048-toolbar' },
            h('div', { className: 'g2048-seg' }, SIZES.map((size) => h('button', {
              key: size,
              type: 'button',
              className: size === side ? 'is-on' : '',
              onClick: () => switchSize(size),
            }, size + '×' + size))),
            h(
              'div',
              { className: 'g2048-actions' },
              h('button', {
                type: 'button',
                className: 'g2048-btn is-ghost' + (isDaily ? ' is-on' : ''),
                onClick: isDaily ? leaveDaily : startDaily,
              }, isDaily ? t('action.dailyExit') : t('action.daily')),
              h('button', {
                type: 'button',
                className: 'g2048-btn is-ghost' + (view === 'history' ? ' is-on' : ''),
                onClick: () => setView(view === 'history' ? null : 'history'),
              }, t('action.history')),
              h('button', {
                type: 'button',
                className: 'g2048-btn is-ghost' + (view === 'achv' ? ' is-on' : ''),
                onClick: () => setView(view === 'achv' ? null : 'achv'),
              }, t('action.achv')),
            ),
          ),
          historyDrawer,
          achvDrawer,
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

        // 会话联动：拿宿主的 uiWorkspace / layout 做「去会话」跳转（都是可选服务）
        ctx.effect(() => {
          const uiWorkspace = ctx.get('uiWorkspace')
          if (uiWorkspace && typeof uiWorkspace.openSession === 'function') {
            openSessionById = (sessionId) => uiWorkspace.openSession(sessionId)
          }
          const layout = ctx.get('layout')
          if (layout && typeof layout.selectPanel === 'function') {
            showConversation = () => layout.selectPanel(null)
          }
          return () => {
            openSessionById = null
            showConversation = null
          }
        }, 'dsh-2048: session navigation')

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
