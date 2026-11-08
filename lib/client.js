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
    const LS_GAMES = 'dsh2048.games.v3'
    const LS_BEST = 'dsh2048.best.v2'
    const LS_BEST_LEGACY = 'dsh2048.best.v1'
    const LS_HISTORY = 'dsh2048.history.v1'
    const LS_ACHV = 'dsh2048.achv.v1'
    const LS_SOUND = 'dsh2048.sound.v1'
    const LS_DAILY = 'dsh2048.daily.v1'
    const HISTORY_LIMIT = 10

    // ── #region game-core（纯函数，与 React / DOM 无关；单测直接抽这一段） ──
    /** 支持的棋盘尺寸与通关块：放在内核里，单测抽出来也能跑。 */
    const SIZES = [4, 5, 6, 7, 8, 9]
    const WIN_TILE = 2048

    /** 棋盘内间距：格子越多缝隙越窄，9×9 也能放下。 */
    function gapForSize(size) {
      const side = normalizeSize(size)
      if (side <= 5) return 10
      if (side === 6) return 9
      if (side === 7) return 8
      if (side === 8) return 7
      return 6
    }

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
        elapsedMs: 0,
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

    /** 四方向固定顺序（AI 决策也用它，保证同局面同选择）。 */
    const DIRECTIONS = ['left', 'right', 'up', 'down']

    /**
     * 只做「推移 + 合并」的纯模拟，不发新棋子；给 AI 搜索用（simulate=true 时不消耗棋子 id）。
     * 返回 { grid, gained, pairs, moved, mergedIds }。
     */
    function shiftGrid(board, dir, simulate) {
      const side = normalizeSize(board.size)
      const lines = lineIndices(dir, side)
      if (!lines.length) return { grid: board.grid, gained: 0, pairs: 0, moved: false, mergedIds: [] }
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
            gained += current.tile.value * 2
            pairs += 1
            if (simulate) {
              out.push({ id: 0, value: current.tile.value * 2, merged: true })
            } else {
              const id = nextTileId()
              out.push({ id, value: current.tile.value * 2, merged: true })
              mergedIds.push(id)
            }
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
      if (!moved) return { grid: board.grid, gained: 0, pairs: 0, moved: false, mergedIds: [] }
      return { grid: next, gained: gained, pairs: pairs, moved: moved, mergedIds: mergedIds }
    }

    /** 一次移动：返回 { board, moved }；没动就原样返回同一对象（React 直接不重渲染）。 */
    function moveBoard(board, dir) {
      const side = normalizeSize(board.size)
      const shift = shiftGrid(board, dir, false)
      if (!shift.moved) return { board, moved: false }
      // 连击奖励：一手合并 ≥2 对时，每多一对给本次合并得分的 25%
      const bonus = shift.pairs > 1 ? Math.floor(shift.gained * 0.25 * (shift.pairs - 1)) : 0
      const spawn = pickSpawn(shift.grid, board.rngState)
      if (spawn.index >= 0) shift.grid[spawn.index] = { id: nextTileId(), value: spawn.value }
      const won = board.won || shift.grid.some((tile) => tile && tile.value >= WIN_TILE)
      return {
        board: {
          size: side,
          grid: shift.grid,
          score: board.score + shift.gained + bonus,
          won,
          over: !canMove(shift.grid, side),
          steps: board.steps + 1,
          combo: shift.pairs,
          maxCombo: Math.max(board.maxCombo || 0, shift.pairs),
          lastBonus: bonus,
          undos: board.undos || 0,
          rngState: spawn.state,
          startedAt: board.startedAt || 0,
          endedAt: board.endedAt || 0,
          elapsedMs: board.elapsedMs || 0,
          daily: board.daily || null,
          spawnIds: spawn.index >= 0 ? [shift.grid[spawn.index].id] : [],
          mergedIds: shift.mergedIds,
        },
        moved: true,
      }
    }

    // ── AI：expectimax 搜索 + 启发式评分（AUTO 托管用） ──────────────────────
    /** 局面评分（越大越好）：空位、单调性、平滑度、可合并对、大块靠角。 */
    function evaluateGrid(grid, size) {
      const side = normalizeSize(size)
      const logs = new Array(side * side).fill(0)
      let empty = 0
      let maxValue = 0
      let maxIndex = -1
      for (let i = 0; i < grid.length; i += 1) {
        const tile = grid[i]
        if (!tile) { empty += 1; continue }
        logs[i] = Math.log2(tile.value)
        if (tile.value > maxValue) { maxValue = tile.value; maxIndex = i }
      }
      let merges = 0
      let smoothness = 0
      for (let r = 0; r < side; r += 1) {
        for (let c = 0; c < side; c += 1) {
          const i = r * side + c
          if (logs[i] === 0) continue
          if (c + 1 < side && logs[i + 1] !== 0) {
            smoothness -= Math.abs(logs[i] - logs[i + 1])
            if (logs[i + 1] === logs[i]) merges += 1
          }
          if (r + 1 < side && logs[i + side] !== 0) {
            smoothness -= Math.abs(logs[i] - logs[i + side])
            if (logs[i + side] === logs[i]) merges += 1
          }
        }
      }
      // 单调性：每行/列取「顺向下降」与「逆向下降」中较大的一段，总是负数
      let monotonicity = 0
      for (let r = 0; r < side; r += 1) {
        let inc = 0
        let dec = 0
        for (let c = 0; c + 1 < side; c += 1) {
          const a = logs[r * side + c]
          const b = logs[r * side + c + 1]
          if (a > b) dec += b - a
          else inc += a - b
        }
        monotonicity += Math.max(dec, inc)
      }
      for (let c = 0; c < side; c += 1) {
        let inc = 0
        let dec = 0
        for (let r = 0; r + 1 < side; r += 1) {
          const a = logs[r * side + c]
          const b = logs[(r + 1) * side + c]
          if (a > b) dec += b - a
          else inc += a - b
        }
        monotonicity += Math.max(dec, inc)
      }
      // 最大块待在角上更稳
      let corner = 0
      if (maxIndex >= 0) {
        const r = Math.floor(maxIndex / side)
        const c = maxIndex % side
        if ((r === 0 || r === side - 1) && (c === 0 || c === side - 1)) {
          corner = Math.log2(Math.max(2, maxValue))
        }
      }
      return empty * 2.8 + monotonicity + smoothness * 0.1 + merges * 0.7 + corner * 1.2
    }

    /** 发牌节点：对所有空格 × {2: 0.9, 4: 0.1} 取期望。 */
    function expectSpawn(grid, size, depth, guard) {
      const side = normalizeSize(size)
      const empties = []
      for (let i = 0; i < grid.length; i += 1) if (!grid[i]) empties.push(i)
      if (!empties.length) return searchGrid(grid, side, depth, guard)
      let total = 0
      for (const index of empties) {
        for (const pair of [[2, 0.9], [4, 0.1]]) {
          const next = grid.slice()
          next[index] = { id: 0, value: pair[0] }
          total += pair[1] * searchGrid(next, side, depth, guard)
        }
      }
      return total / empties.length
    }

    /** 玩家节点：取四个方向里最好的。节点预算用完就退回静态评分，保证每步耗时有界。 */
    function searchGrid(grid, size, depth, guard) {
      guard.nodes += 1
      if (depth <= 0 || guard.nodes > guard.budget) return evaluateGrid(grid, size)
      let best = -Infinity
      for (const dir of DIRECTIONS) {
        const shift = shiftGrid({ size, grid }, dir, true)
        if (!shift.moved) continue
        const value = expectSpawn(shift.grid, size, depth - 1, guard)
        if (value > best) best = value
      }
      if (best === -Infinity) return evaluateGrid(grid, size)
      return best
    }

    /**
     * 选一个方向：options = { depth, nodeBudget }。
     * 4×4 默认深 4 层，更大的盘面降层并收紧预算，避免卡住界面。
     */
    function bestMove(board, options) {
      const side = normalizeSize(board.size)
      const opts = options || {}
      const depth = opts.depth != null ? opts.depth : (side <= 4 ? 4 : side <= 5 ? 3 : 2)
      const guard = {
        nodes: 0,
        budget: opts.nodeBudget != null ? opts.nodeBudget : (side <= 4 ? 20000 : 8000),
      }
      let bestDir = null
      let bestValue = -Infinity
      for (const dir of DIRECTIONS) {
        const shift = shiftGrid(board, dir, true)
        if (!shift.moved) continue
        const value = expectSpawn(shift.grid, side, depth - 1, guard)
        if (value > bestValue) { bestValue = value; bestDir = dir }
      }
      return { dir: bestDir, value: bestValue, nodes: guard.nodes }
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
        elapsedMs: board.elapsedMs || 0,
        daily: board.daily || null,
      }
    }

    /**
     * 暂停 / 继续一局：切换棋盘尺寸时把当前局「停表」存起来，切回来接着计。
     * 结束的局不动（时间已经冻结在 endedAt）。
     */
    function parkBoard(board, now) {
      if (board.over || !board.startedAt) return board
      return {
        ...board,
        elapsedMs: (board.elapsedMs || 0) + Math.max(0, now - board.startedAt),
        startedAt: 0,
      }
    }

    function resumeBoard(board, now) {
      if (board.over || board.startedAt) return board
      return { ...board, startedAt: now }
    }

    /** 本局已用时间：之前的累计 + 当前这一段（或结束时刻 - 开始时刻）。 */
    function elapsedOf(board, now) {
      const base = board.elapsedMs || 0
      if (board.over) return base + Math.max(0, (board.endedAt || 0) - (board.startedAt || 0))
      if (!board.startedAt) return base
      return base + Math.max(0, (Number.isFinite(now) ? now : Date.now()) - board.startedAt)
    }

    /**
     * 这一手每颗棋子的位移：只统计「移动过的旧棋子」，合并产物和新发棋子的 id 是新的，
     * 天然不在表里。返回 from/to 格下标与格数，给滑动动画算起点、时长与模糊强度。
     */
    function travelOf(prevBoard, nextBoard, dir) {
      const size = normalizeSize(nextBoard.size)
      const before = {}
      for (let i = 0; i < prevBoard.grid.length; i += 1) {
        const tile = prevBoard.grid[i]
        if (tile) before[tile.id] = i
      }
      const byId = {}
      let maxCells = 0
      for (let i = 0; i < nextBoard.grid.length; i += 1) {
        const tile = nextBoard.grid[i]
        if (!tile) continue
        const from = before[tile.id]
        if (from === undefined || from === i) continue
        const cells = Math.abs(Math.floor(from / size) - Math.floor(i / size))
          + Math.abs((from % size) - (i % size))
        if (cells <= 0) continue
        byId[tile.id] = { from: from, to: i, cells: cells }
        if (cells > maxCells) maxCells = cells
      }
      return { dir: dir, byId: byId, maxCells: maxCells }
    }

    /** 每日挑战：同一天 + 同尺寸 = 同一副牌。 */
    function dailySeedFor(dateKey, size) { return seedFrom('dsh2048:' + dateKey + ':' + size) }
    // #endregion game-core

    /** 常驻尺寸按钮 4×4 / 5×5，更大的收在「更多」里。 */
    const PRIMARY_SIZES = SIZES.filter((size) => size <= 5)
    const MORE_SIZES = SIZES.filter((size) => size > 5)

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
      '.g2048-tile[data-v="16384"],.g2048-tile[data-v="32768"],.g2048-tile[data-v="65536"]{background:linear-gradient(150deg,#3a1f08,#170c02);color:#ffd89a;box-shadow:0 0 0 1px rgba(247,196,106,.28),0 6px 20px rgba(0,0,0,.45)}',
    ].join('\n')

    const CSS = [
      // 页面与骨架
      '.g2048-page{height:100%;min-height:0;overflow:auto;display:flex;padding:20px 24px 28px;box-sizing:border-box;background:transparent;--g-accent:#e8912a}',
      '.g2048-shell{margin:auto;width:min(100%,540px,62vh);display:flex;flex-direction:column;gap:12px}',
      // 会话提示条
      '.g2048-notice{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:11px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));animation:g2048-card-in 180ms cubic-bezier(.2,.75,.3,1)}',
      '.g2048-notice-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:var(--g-accent,#e8912a);box-shadow:0 0 0 3px color-mix(in srgb,var(--g-accent,#e8912a) 18%,transparent)}',
      '.g2048-notice.is-blocked .g2048-notice-dot{background:var(--dsw-alias-state-warn-primary,#d6a23a);box-shadow:0 0 0 3px rgba(214,162,58,.2)}',
      '.g2048-notice-text{flex:1 1 auto;min-width:0;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.g2048-notice-text b{font-weight:700;color:var(--g-accent,#e8912a)}',
      '.g2048-notice-btn{flex:0 0 auto;appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#9a9a9a);font:inherit;font-size:12px;padding:3px 6px;border-radius:6px;cursor:pointer}',
      '.g2048-notice-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,inherit)}',
      '.g2048-notice-btn.is-primary{color:var(--g-accent,#e8912a);font-weight:700}',
      // 顶栏
      '.g2048-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap}',
      '.g2048-brand{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.g2048-wordmark{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.g2048-logo{display:flex;color:var(--g-accent,#e8912a)}',
      '.g2048-title{font-size:31px;font-weight:800;line-height:1;letter-spacing:.06em;background:linear-gradient(135deg,#f8cd74,#e07a1f);-webkit-background-clip:text;background-clip:text;color:transparent}',
      '.g2048-badge{font-size:10.5px;font-weight:700;letter-spacing:.04em;padding:3px 7px;border-radius:99px;color:#2a1a05;background:linear-gradient(135deg,#f2b455,#e0811f)}',
      '.g2048-badge.is-ghost{color:var(--dsw-alias-label-secondary,#9a9a9a);background:transparent;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));font-weight:600}',
      '.g2048-sub{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#9a9a9a)}',
      '.g2048-stats{display:flex;gap:7px;flex-wrap:wrap}',
      '.g2048-stat{min-width:64px;padding:6px 9px;border-radius:10px;box-sizing:border-box;text-align:center;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2))}',
      '.g2048-stat-k{font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#9a9a9a)}',
      '.g2048-stat-v{font-size:16px;font-weight:700;line-height:1.3;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,inherit)}',
      '.g2048-stat.is-best .g2048-stat-v{color:var(--g-accent,#e8912a)}',
      // 棋盘
      '.g2048-board{position:relative;width:100%;aspect-ratio:1/1;border-radius:16px;box-sizing:border-box;background:#2e261c;border:1px solid rgba(255,236,204,.10);box-shadow:0 16px 36px rgba(60,36,10,.18),inset 0 1px 0 rgba(255,240,214,.05);touch-action:none;user-select:none;-webkit-user-select:none;overflow:hidden}',
      '.g2048-cells{position:absolute;inset:var(--gap,10px);display:grid;gap:var(--gap,10px)}',
      '.g2048-cell{border-radius:10px;background:#1d170f;box-shadow:inset 0 1px 2px rgba(0,0,0,.22)}',
      '.g2048-tiles{position:absolute;inset:var(--gap,10px)}',
      '.g2048-slot{position:absolute;left:0;top:0;will-change:transform;backface-visibility:hidden}',
      // 滑动：显式关键帧从旧位置飞到新位置（不依赖 transition 插值），速度越快模糊越强，落点小幅回弹
      '.g2048-slot.is-travel{animation:g2048-travel var(--dur,150ms) cubic-bezier(.16,.72,.26,1) both}',
      '@keyframes g2048-travel{0%{transform:translate3d(var(--fx),var(--fy),0);filter:blur(0)}20%{filter:blur(var(--blur,1.2px))}56%{filter:blur(calc(var(--blur,1.2px) * .5))}76%{transform:translate3d(var(--tx),var(--ty),0);filter:blur(0)}86%{transform:translate3d(calc(var(--tx) + var(--ox)),calc(var(--ty) + var(--oy)),0)}100%{transform:translate3d(var(--tx),var(--ty),0);filter:blur(0)}}',
      '.g2048-tile{display:flex;align-items:center;justify-content:center;width:100%;height:100%;border-radius:10px;font-size:1em;font-weight:800;line-height:1;letter-spacing:-.02em;font-variant-numeric:tabular-nums;box-shadow:0 1px 2px rgba(40,26,8,.18);transform-origin:50% 50%;will-change:transform;backface-visibility:hidden;background:#5c3a12;color:#ffeccb}',
      '.g2048-tile[data-len="3"]{font-size:.78em}',
      '.g2048-tile[data-len="4"]{font-size:.64em}',
      '.g2048-tile[data-len="5"]{font-size:.54em}',
      '.g2048-tile[data-len="6"]{font-size:.46em}',
      '.g2048-tile.is-new{animation:g2048-appear 190ms cubic-bezier(.2,.9,.3,1.1)}',
      '.g2048-tile.is-merged{animation:g2048-pop 230ms cubic-bezier(.2,.85,.3,1)}',
      // 滑动形变：横向 / 纵向各一套，幅度由行内 --s 决定（滑得越远 --s 越大）
      '.g2048-tile.is-move-x{animation:g2048-slide-x 270ms cubic-bezier(.18,.82,.26,1)}',
      '.g2048-tile.is-move-y{animation:g2048-slide-y 270ms cubic-bezier(.18,.82,.26,1)}',
      '.g2048-board.is-shaking{animation:g2048-shake 230ms ease-in-out}',
      // 形变 → 回弹 → 静止：先沿运动方向拉伸、侧向压扁，落地反向挤压，小幅回弹
      '@keyframes g2048-slide-x{0%{transform:scale3d(1,1,1)}14%{transform:scale3d(calc(1 + var(--s)),calc(1 - var(--s)*.62),1)}44%{transform:scale3d(calc(1 - var(--s)*.36),calc(1 + var(--s)*.26),1)}68%{transform:scale3d(calc(1 + var(--s)*.13),calc(1 - var(--s)*.09),1)}86%{transform:scale3d(calc(1 - var(--s)*.05),calc(1 + var(--s)*.04),1)}100%{transform:scale3d(1,1,1)}}',
      '@keyframes g2048-slide-y{0%{transform:scale3d(1,1,1)}14%{transform:scale3d(calc(1 - var(--s)*.62),calc(1 + var(--s)),1)}44%{transform:scale3d(calc(1 + var(--s)*.26),calc(1 - var(--s)*.36),1)}68%{transform:scale3d(calc(1 - var(--s)*.09),calc(1 + var(--s)*.13),1)}86%{transform:scale3d(calc(1 + var(--s)*.04),calc(1 - var(--s)*.05),1)}100%{transform:scale3d(1,1,1)}}',
      '@keyframes g2048-appear{0%{transform:scale3d(.34,.34,1);opacity:0}62%{transform:scale3d(1.07,1.07,1);opacity:1}100%{transform:scale3d(1,1,1)}}',
      '@keyframes g2048-pop{0%{transform:scale3d(1,1,1)}32%{transform:scale3d(1.2,.9,1)}58%{transform:scale3d(.97,1.03,1)}78%{transform:scale3d(1.03,1,1)}100%{transform:scale3d(1,1,1)}}',
      '@keyframes g2048-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-5px)}40%{transform:translateX(5px)}60%{transform:translateX(-3px)}80%{transform:translateX(3px)}}',
      // 连击闪字
      '.g2048-combo{position:absolute;left:0;right:0;top:14%;display:flex;justify-content:center;pointer-events:none;animation:g2048-combo 620ms ease-out forwards}',
      '.g2048-combo span{font-size:clamp(20px,5.6vmin,30px);font-weight:900;letter-spacing:.04em;color:#ffe6b8;text-shadow:0 2px 12px rgba(224,129,31,.55)}',
      '@keyframes g2048-combo{0%{opacity:0;transform:translateY(6px) scale(.8)}18%{opacity:1;transform:translateY(0) scale(1)}72%{opacity:1}100%{opacity:0;transform:translateY(-8px) scale(1.04)}}',
      // 结算小菜单
      '.g2048-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(18,12,6,.66);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);animation:g2048-fade 160ms ease-out}',
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
      '.g2048-btn.is-on{border-color:color-mix(in srgb,var(--g-accent,#e8912a) 55%,transparent);color:var(--g-accent,#e8912a)}',
      '.g2048-btn.is-auto{border-color:color-mix(in srgb,var(--g-accent,#e8912a) 60%,transparent);color:var(--g-accent,#e8912a);background:color-mix(in srgb,var(--g-accent,#e8912a) 12%,transparent);animation:g2048-auto-pulse 1.6s ease-in-out infinite}',
      '@keyframes g2048-auto-pulse{0%,100%{box-shadow:0 0 0 0 rgba(232,145,42,.28)}50%{box-shadow:0 0 0 4px rgba(232,145,42,0)}}',
      '.g2048-btn.is-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary,#9a9a9a);padding:6px 8px;font-weight:500}',
      '.g2048-btn.is-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,inherit)}',
      '.g2048-btn:focus-visible,.g2048-board:focus-visible,.g2048-drawer button:focus-visible{outline:2px solid var(--g-accent,#e8912a);outline-offset:2px}',
      '.g2048-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding-top:2px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14))}',
      '.g2048-seg{display:flex;gap:2px;padding:2px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}',
      '.g2048-seg button{display:inline-flex;align-items:center;appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#9a9a9a);font:inherit;font-size:11.5px;font-weight:600;padding:4px 9px;border-radius:7px;cursor:pointer}',
      '.g2048-seg-dot{width:5px;height:5px;margin-left:5px;border-radius:50%;background:var(--g-accent,#e8912a);flex:0 0 auto}',
      '.g2048-seg button.is-on{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.2));color:var(--dsw-alias-label-primary,inherit)}',
      '.g2048-sizebox{position:relative;display:flex;align-items:center}',
      '.g2048-menu{position:absolute;bottom:calc(100% + 6px);left:0;z-index:6;display:flex;gap:2px;padding:4px;border-radius:10px;background:var(--dsw-alias-bg-overlay,#211d19);border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));box-shadow:0 10px 26px rgba(0,0,0,.28);animation:g2048-card-in 140ms ease-out}',
      '.g2048-menu button{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#9a9a9a);font:inherit;font-size:11.5px;font-weight:600;padding:4px 9px;border-radius:7px;cursor:pointer;white-space:nowrap}',
      '.g2048-menu button:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,inherit)}',
      '.g2048-menu button.is-on{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.2));color:var(--dsw-alias-label-primary,inherit)}',
      '.g2048-drawer{display:flex;flex-direction:column;gap:6px;padding:11px 12px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));animation:g2048-card-in 160ms ease-out}',
      '.g2048-drawer-title{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#9a9a9a)}',
      '.g2048-rec{display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:baseline;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary,inherit);font-variant-numeric:tabular-nums}',
      '.g2048-rec-dim{color:var(--dsw-alias-label-secondary,#9a9a9a);font-size:11px}',
      '.g2048-achv{display:flex;flex-wrap:wrap;gap:6px}',
      '.g2048-achv-chip{display:flex;align-items:center;gap:5px;font-size:11.5px;padding:4px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));color:var(--dsw-alias-label-secondary,#9a9a9a);opacity:.55}',
      '.g2048-achv-chip.is-on{opacity:1;color:var(--g-accent,#e8912a);border-color:color-mix(in srgb,var(--g-accent,#e8912a) 45%,transparent);background:color-mix(in srgb,var(--g-accent,#e8912a) 8%,transparent)}',
      '.g2048-achv-icon{font-weight:800;font-size:10.5px;font-variant-numeric:tabular-nums}',
      // 成就 toast
      '.g2048-toast{position:absolute;right:14px;bottom:14px;display:flex;align-items:center;gap:9px;padding:9px 13px;border-radius:12px;background:var(--dsw-alias-bg-overlay,#211d19);border:1px solid rgba(232,145,42,.4);box-shadow:0 10px 30px rgba(0,0,0,.28);animation:g2048-card-in 200ms cubic-bezier(.2,.75,.3,1)}',
      '.g2048-toast-badge{font-weight:800;font-size:11px;color:#2a1a05;background:linear-gradient(135deg,#f2b455,#e0811f);padding:3px 7px;border-radius:7px}',
      '.g2048-toast-text{font-size:12px;color:var(--dsw-alias-label-primary,inherit)}',
      // 窄屏
      '@media (max-width:540px){.g2048-title{font-size:26px}.g2048-page{padding:12px 12px 18px}.g2048-stat{min-width:56px;padding:5px 7px}.g2048-stat-v{font-size:14px}}',
      // 尊重减少动效
      '@media (prefers-reduced-motion:reduce){.g2048-slot.is-travel{animation:none}.g2048-tile.is-new,.g2048-tile.is-merged,.g2048-tile.is-move-x,.g2048-tile.is-move-y,.g2048-overlay,.g2048-card,.g2048-notice,.g2048-drawer,.g2048-toast,.g2048-combo,.g2048-board.is-shaking,.g2048-btn.is-auto{animation:none}}',
      // 亮色宿主：--dsw-alias-bg-layer-1/2/3 全是纯白、--dsw-alias-border-l1 只有 4% 黑，
      // 卡片/按钮会没有边界，棋盘格更是直接和棋板同色消失。这里补一组固定暖色：
      // 亮色下加深琥珀强调色、给卡片/按钮加浅暖底与描边，保证层级看得清。
      'html:not([data-ds-dark-theme]):not([data-theme="dark"]) body:not([data-ds-dark-theme]):not([data-theme="dark"]) .g2048-page{--g-accent:#b4610c}',
      'html:not([data-ds-dark-theme]):not([data-theme="dark"]) body:not([data-ds-dark-theme]):not([data-theme="dark"]) .g2048-title{background:linear-gradient(135deg,#e2951f,#a14f05);-webkit-background-clip:text;background-clip:text;color:transparent}',
      'html:not([data-ds-dark-theme]):not([data-theme="dark"]) body:not([data-ds-dark-theme]):not([data-theme="dark"]) .g2048-big.is-win{background:linear-gradient(135deg,#e2951f,#a14f05);-webkit-background-clip:text;background-clip:text;color:transparent}',
      'html:not([data-ds-dark-theme]):not([data-theme="dark"]) body:not([data-ds-dark-theme]):not([data-theme="dark"]) :is(.g2048-stat,.g2048-notice,.g2048-seg,.g2048-drawer,.g2048-btn:not(.is-primary):not(.is-ghost)){background:rgba(232,165,70,.12);border-color:rgba(140,88,22,.3)}',
      'html:not([data-ds-dark-theme]):not([data-theme="dark"]) body:not([data-ds-dark-theme]):not([data-theme="dark"]) .g2048-btn:not(.is-primary):not(.is-ghost):hover:not(:disabled){background:rgba(232,165,70,.22);border-color:rgba(140,88,22,.44)}',
      'html:not([data-ds-dark-theme]):not([data-theme="dark"]) body:not([data-ds-dark-theme]):not([data-theme="dark"]) .g2048-btn.is-ghost:hover:not(:disabled){background:rgba(232,165,70,.16);color:var(--dsw-alias-label-primary,#0f1115)}',
      'html:not([data-ds-dark-theme]):not([data-theme="dark"]) body:not([data-ds-dark-theme]):not([data-theme="dark"]) .g2048-notice-btn:hover{background:rgba(232,165,70,.2)}',
      'html:not([data-ds-dark-theme]):not([data-theme="dark"]) body:not([data-ds-dark-theme]):not([data-theme="dark"]) .g2048-seg button.is-on{background:rgba(232,165,70,.26)}',
      'html:not([data-ds-dark-theme]):not([data-theme="dark"]) body:not([data-ds-dark-theme]):not([data-theme="dark"]) .g2048-menu{border-color:rgba(140,88,22,.3);box-shadow:0 12px 26px rgba(60,36,10,.16)}',
      'html:not([data-ds-dark-theme]):not([data-theme="dark"]) body:not([data-ds-dark-theme]):not([data-theme="dark"]) .g2048-menu button:hover{background:rgba(232,165,70,.18)}',
      'html:not([data-ds-dark-theme]):not([data-theme="dark"]) body:not([data-ds-dark-theme]):not([data-theme="dark"]) .g2048-menu button.is-on{background:rgba(232,165,70,.26)}',
      'html:not([data-ds-dark-theme]):not([data-theme="dark"]) body:not([data-ds-dark-theme]):not([data-theme="dark"]) .g2048-card{border-color:rgba(140,88,22,.28)}',
      'html:not([data-ds-dark-theme]):not([data-theme="dark"]) body:not([data-ds-dark-theme]):not([data-theme="dark"]) .g2048-toolbar{border-top-color:rgba(140,88,22,.18)}',
      'html:not([data-ds-dark-theme]):not([data-theme="dark"]) body:not([data-ds-dark-theme]):not([data-theme="dark"]) .g2048-achv-chip{border-color:rgba(140,88,22,.22)}',
      'html:not([data-ds-dark-theme]):not([data-theme="dark"]) body:not([data-ds-dark-theme]):not([data-theme="dark"]) .g2048-badge.is-ghost{border-color:rgba(140,88,22,.28)}',
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
      'action.auto': 'AUTO',
      'action.autoOn': 'AUTO 中',
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
      'action.moreSizes': '更多',
      'action.dailyExit': '退出每日',
      'action.copy': '复制战报',
      'action.copied': '战报已复制',
      'hint.move': '↑ ↓ ← → / WASD 移动 · 触屏滑动 · 合到 2048 通关',
      'hint.steps': '步数 {steps} · 撤销 {undos}',
      'board.label': '2048 棋盘',
      'combo.label': '连击 ×{n} · +{bonus}',
      'badge.daily': '每日 {date}',
      'badge.dailyDone': '今日已完成',
      'badge.auto': 'AUTO 托管中',
      'badge.inProgress': '这个尺寸还有一局没下完',
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
      'action.auto': 'AUTO',
      'action.autoOn': 'AUTO on',
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
      'action.moreSizes': 'More',
      'action.dailyExit': 'Leave daily',
      'action.copy': 'Copy result',
      'action.copied': 'Result copied',
      'hint.move': 'Arrows / WASD to move · swipe on touch · reach 2048 to win',
      'hint.steps': 'Moves {steps} · Undo {undos}',
      'board.label': '2048 board',
      'combo.label': 'Combo ×{n} · +{bonus}',
      'badge.daily': 'Daily {date}',
      'badge.dailyDone': 'Done today',
      'badge.auto': 'AUTO pilot',
      'badge.inProgress': 'This board has an unfinished game',
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

    /** 把一条存档还原成棋盘；不合法返回 null。 */
    function hydrateBoard(raw, fallbackSize) {
      if (!raw || typeof raw !== 'object') return null
      const size = normalizeSize(raw.size || fallbackSize)
      const grid = sanitizeTiles(raw.grid, size)
      if (!grid || !grid.filter(Boolean).length) return null
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
        startedAt: Number.isFinite(raw.startedAt) && raw.startedAt > 0 ? raw.startedAt : 0,
        endedAt: Number.isFinite(raw.endedAt) ? raw.endedAt : 0,
        elapsedMs: Number(raw.elapsedMs) || 0,
        daily: typeof raw.daily === 'string' ? raw.daily : null,
        spawnIds: [],
        mergedIds: [],
      }
      if (!board.over && !canMove(grid, size)) board.over = true
      if (board.over && !board.endedAt) board.endedAt = Date.now()
      return board
    }

    /**
     * 每个尺寸一局：{ active, parked: { 4: board, 5: board, …, 9: board } }。
     * 切尺寸只是把当前局停表存进自己的槽、把目标槽的表重新走起来。
     */
    function loadGamesState() {
      const saved = readJSON(LS_GAMES)
      const parked = {}
      for (const size of SIZES) parked[size] = null
      let active = 4
      if (saved && typeof saved === 'object') {
        active = normalizeSize(Number(saved.active))
        const rows = saved.boards && typeof saved.boards === 'object' ? saved.boards : {}
        for (const size of SIZES) {
          const board = hydrateBoard(rows[size], size)
          if (board) parked[size] = board
        }
      }
      if (!SIZES.some((size) => parked[size])) {
        // 迁移 0.3.0 之前的单棋盘存档（v2，更早是 v1）
        const legacy = hydrateBoard(readJSON(LS_BOARD), 4) || hydrateBoard(readJSON(LS_BOARD_LEGACY), 4)
        if (legacy) {
          parked[legacy.size] = legacy
          active = legacy.size
        }
      }
      const now = Date.now()
      for (const size of SIZES) {
        if (parked[size]) parked[size] = resumeBoard(parked[size], now)
      }
      if (!parked[active]) parked[active] = createBoard({ size: active, now })
      return { active, parked, board: parked[active] }
    }

    function saveGames(state) {
      writeJSON(LS_GAMES, { active: state.active, boards: state.parked })
    }

    function loadBest() {
      const raw = readJSON(LS_BEST)
      const legacy = Number(readLS(LS_BEST_LEGACY))
      const best = {}
      for (const size of SIZES) best[size] = 0
      if (raw && typeof raw === 'object') {
        for (const size of SIZES) best[size] = Math.max(0, Number(raw[size]) || 0)
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

      // 首帧只读一次存档：每个尺寸一局，active 指向当前显示的那一局
      const bootRef = useRef(null)
      if (!bootRef.current) bootRef.current = loadGamesState()
      const [board, setBoard] = useState(bootRef.current.board)
      const [best, setBest] = useState(loadBest)
      const [history, setHistory] = useState([])
      const [keepGoing, setKeepGoing] = useState(false)
      const [shaking, setShaking] = useState(false)
      const [cellPx, setCellPx] = useState(96)
      const [soundOn, setSoundOn] = useState(loadSoundOn)
      const [view, setView] = useState(null)
      const [sizeMenu, setSizeMenu] = useState(false)
      const [auto, setAuto] = useState(false)
      const [achv, setAchv] = useState(loadAchv)
      const [records, setRecords] = useState(loadHistory)
      const [dailyDone, setDailyDone] = useState(loadDaily)
      const [toast, setToast] = useState(null)
      const [dismissed, setDismissed] = useState({})
      const [nowTick, setNowTick] = useState(() => Date.now())

      const boardRef = useRef(board)
      const parkedRef = useRef(bootRef.current.parked)
      const historiesRef = useRef({}) // 撤销历史按尺寸分开（懒建）
      const boardElRef = useRef(null)
      const swipeRef = useRef(null)
      const bestRef = useRef(best)
      const soundRef = useRef(soundOn)
      const recordedRef = useRef('')
      const autoUsedRef = useRef(false)
      const achvRef = useRef(achv)
      const toastTimerRef = useRef(null)
      /** 最近一手的位移表：{ stamp, steps, dir, byId }，只在这一手渲染时给棋子加形变。 */
      const motionRef = useRef(null)
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
          const gap = gapForSize(side)
          const inner = el.clientWidth - 2 * gap
          const cell = Math.max(14, (inner - (side - 1) * gap) / side)
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
          durationMs: elapsedOf(next, Date.now()),
          undos: next.undos || 0,
          daily: next.daily || null,
          won: Boolean(next.won),
          auto: Boolean(autoUsedRef.current),
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

      // 每次棋盘变化：落盘（两个尺寸槽一起）+ 追最高分 + 巡检成就 + 终局落库
      useEffect(() => {
        boardRef.current = board
        parkedRef.current = { ...parkedRef.current, [board.size]: board }
        saveGames({ active: board.size, parked: parkedRef.current })
        const side = normalizeSize(board.size)
        if (!autoUsedRef.current) {
          const bestShown = Math.max(bestRef.current[side] || 0, board.score)
          if (bestShown !== bestRef.current[side]) {
            const nextBest = { ...bestRef.current, [side]: bestShown }
            bestRef.current = nextBest
            setBest(nextBest)
            saveBest(nextBest)
          }
          grantAchievements(board)
        }
        if (board.over) finishRecord(board)
      }, [board, grantAchievements, finishRecord])

      // 撤销回「还没达成 2048」时，允许再次弹出通关小菜单
      useEffect(() => {
        if (!board.won) setKeepGoing(false)
      }, [board.won])

      // 音效：只在本局「刚结束 / 刚通关」的那一下响，切槽或加载旧局不补放
      const soundEventRef = useRef({ stamp: '', over: false, won: false })
      useEffect(() => {
        const stamp = String(board.startedAt || 0) + ':' + String(board.size) + ':' + String(board.daily || '')
        const prev = soundEventRef.current
        if (prev.stamp !== stamp) {
          soundEventRef.current = { stamp, over: board.over, won: board.won }
          return
        }
        const next = { stamp, over: board.over, won: board.won }
        if (!soundRef.current) {
          soundEventRef.current = next
          return
        }
        if (board.over && !prev.over) playSfx('over')
        else if (board.won && !prev.won && !board.over) playSfx('win')
        soundEventRef.current = next
      }, [board.over, board.won, board.startedAt, board.size, board.daily])

      const commit = useCallback((next) => {
        boardRef.current = next
        setBoard(next)
      }, [])

      /** 撤销历史按尺寸分开存，切尺寸时各用各的。 */
      const pushHistory = useCallback((size, snapshot) => {
        const side = normalizeSize(size)
        const list = [snapshot].concat(historiesRef.current[side] || []).slice(0, 30)
        historiesRef.current[side] = list
        setHistory(list)
      }, [])

      const applyMove = useCallback((dir, viaAuto) => {
        setSizeMenu(false)
        if (!viaAuto) setAuto(false)
        const prev = boardRef.current
        if (prev.over) return
        const result = moveBoard(prev, dir)
        if (!result.moved) {
          setShaking(true)
          return
        }
        if (viaAuto) autoUsedRef.current = true
        // 形变强度来自这一手每颗棋子滑了几格
        const travel = travelOf(prev, result.board, dir)
        motionRef.current = {
          stamp: result.board.startedAt || 0,
          steps: result.board.steps,
          dir: travel.dir,
          byId: travel.byId,
        }
        pushHistory(prev.size, snapshotOf(prev))
        const next = result.board
        commit(next)
        if (soundRef.current) {
          playSfx('move')
          if (next.combo >= 2) playSfx('combo')
          else if (next.mergedIds.length) playSfx('merge', maxTileOf(next))
        }
      }, [commit, pushHistory])

      const undo = useCallback(() => {
        const side = normalizeSize(boardRef.current.size)
        const list = historiesRef.current[side] || []
        const snapshot = list[0]
        if (!snapshot) return
        historiesRef.current[side] = list.slice(1)
        setHistory(historiesRef.current[side])
        recordedRef.current = '' // 退回去重打，终局可以再记一次
        motionRef.current = null
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
        historiesRef.current[size] = []
        setHistory([])
        setKeepGoing(false)
        setShaking(false)
        setView(null)
        recordedRef.current = ''
        autoUsedRef.current = false
        motionRef.current = null
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
      /** 切换尺寸 = 切槽：当前局停表存起来，目标槽的表重新走起来（不丢局、不丢撤销历史）。 */
      const switchSize = useCallback((size) => {
        const next = normalizeSize(size)
        const prev = boardRef.current
        if (next === normalizeSize(prev.size)) return
        const now = Date.now()
        const parked = { ...parkedRef.current }
        parked[prev.size] = parkBoard(prev, now)
        let target = parked[next]
        if (!target) target = createBoard({ size: next, now })
        else target = resumeBoard(target, now)
        parked[next] = target
        parkedRef.current = parked
        boardRef.current = target
        motionRef.current = null
        setBoard(target)
        setHistory(historiesRef.current[next] || [])
        setKeepGoing(false)
        setShaking(false)
        setView(null)
      }, [])

      /** AUTO 开关：终局时点一下直接开新局，交给 AI 玩。 */
      const toggleAuto = () => {
        if (auto) { setAuto(false); return }
        if (boardRef.current.over) startGame({ size: boardRef.current.size })
        setAuto(true)
      }

      // AUTO 托管：每隔一小段自动搜索一步；弹窗时暂停（通关弹窗自动继续）
      useEffect(() => {
        if (!auto) return undefined
        if (board.over) { setAuto(false); return undefined }
        if (board.won && !keepGoing) { setKeepGoing(true); return undefined }
        const delay = normalizeSize(board.size) <= 4 ? 140 : 90
        const timer = setTimeout(() => {
          const now = boardRef.current
          if (now.over) { setAuto(false); return }
          const pick = bestMove(now)
          if (!pick.dir) { setAuto(false); return }
          applyMove(pick.dir, true)
        }, delay)
        return () => clearTimeout(timer)
      }, [auto, board, keepGoing, applyMove])

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

      const onPointerDown = (event) => {
        setSizeMenu(false)
        swipeRef.current = { x: event.clientX, y: event.clientY }
      }
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

      // 这一手的形变表：只有「刚动完这一步」的渲染才生效（防止计时器等重渲染重放动画）
      const motionInfo = motionRef.current
      const motionMap = motionInfo
        && motionInfo.stamp === (board.startedAt || 0)
        && motionInfo.steps === board.steps
        ? motionInfo.byId
        : null

      const side = normalizeSize(board.size)
      const gap = gapForSize(side)
      const liveBest = Math.max(best[side] || 0, board.score)
      const maxTile = maxTileOf(board)
      const nowMs = board.over ? (board.endedAt || nowTick) : nowTick
      const durationText = formatDuration(elapsedOf(board, nowMs))
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

      /** 尺寸按钮：带「该尺寸有未完成对局」的小圆点。 */
      const sizeButton = (size) => {
        const slot = parkedRef.current[size]
        const live = Boolean(slot && !slot.over && slot.steps > 0 && size !== side)
        return h('button', {
          key: size,
          type: 'button',
          className: size === side ? 'is-on' : '',
          title: live ? t('badge.inProgress') : undefined,
          onClick: () => { setSizeMenu(false); switchSize(size) },
        }, size + '×' + size, live ? h('span', { key: 'dot', className: 'g2048-seg-dot', 'aria-hidden': true }) : null)
      }

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
          style: { fontSize: tileFont, '--gap': gap + 'px' },
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
            const motion = motionMap ? motionMap[tile.id] : null
            const horizontal = motionInfo ? (motionInfo.dir === 'left' || motionInfo.dir === 'right') : false
            const moveClass = motion ? (horizontal ? ' is-move-x' : ' is-move-y') : ''
            // 滑得越远：形变更大（单格 ~8%，三格 ~13%）、飞得更久、动态模糊更重
            const cells = motion ? Math.min(3, motion.cells) : 0
            const stretch = motion ? Math.min(0.13, 0.052 + cells * 0.028) : 0
            const toX = tile.col * (cellPx + gap)
            const toY = tile.row * (cellPx + gap)
            const slotStyle = {
              width: cellPx,
              height: cellPx,
              // 动画被关掉（减动效偏好）时也停在终点
              transform: 'translate3d(' + toX + 'px,' + toY + 'px,0)',
            }
            if (motion) {
              const fromRow = Math.floor(motion.from / side)
              const fromCol = motion.from % side
              const fromX = fromCol * (cellPx + gap)
              const fromY = fromRow * (cellPx + gap)
              const overshoot = Math.min(5, cells * 1.8)
              slotStyle['--fx'] = fromX + 'px'
              slotStyle['--fy'] = fromY + 'px'
              slotStyle['--tx'] = toX + 'px'
              slotStyle['--ty'] = toY + 'px'
              slotStyle['--ox'] = (Math.sign(toX - fromX) * overshoot) + 'px'
              slotStyle['--oy'] = (Math.sign(toY - fromY) * overshoot) + 'px'
              // 一格 140ms、三格 200ms：滑得远飞得久，落地更「重」
              slotStyle['--dur'] = (110 + cells * 30) + 'ms'
              slotStyle['--blur'] = (0.9 + cells * 0.45).toFixed(2) + 'px'
            }
            return h(
              'div',
              {
                // 每一步换 key：同一颗棋子连续滑两次也会重新播放关键帧动画
                key: tile.id + ':' + board.steps,
                className: 'g2048-slot' + (motion ? ' is-travel' : ''),
                style: slotStyle,
              },
              h(
                'div',
                {
                  className: 'g2048-tile' + (isNew ? ' is-new' : '') + (isMerged ? ' is-merged' : '') + moveClass,
                  style: motion ? { '--s': String(Math.round(stretch * 1000) / 1000) } : undefined,
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
                  h('span', { className: 'g2048-rec-dim' }, (row.daily ? '★' : '') + (row.auto ? ' AUTO' : '')),
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
                auto ? h('span', { className: 'g2048-badge' }, t('badge.auto')) : null,
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
                className: 'g2048-btn' + (auto ? ' is-auto' : ''),
                onClick: toggleAuto,
                'aria-pressed': auto ? 'true' : 'false',
                title: t('action.auto'),
              }, auto ? t('action.autoOn') : t('action.auto')),
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
            h('div', { className: 'g2048-sizebox' },
              h('div', { className: 'g2048-seg' },
                PRIMARY_SIZES.map((size) => sizeButton(size)),
                h('button', {
                  key: 'more',
                  type: 'button',
                  className: (side > 5 || sizeMenu) ? 'is-on' : '',
                  title: t('action.moreSizes'),
                  'aria-expanded': sizeMenu ? 'true' : 'false',
                  onClick: () => setSizeMenu((open) => !open),
                },
                (side > 5 ? (side + '×' + side) : t('action.moreSizes')) + ' ▾',
                MORE_SIZES.some((size) => {
                  const slot = parkedRef.current[size]
                  return Boolean(slot && !slot.over && slot.steps > 0)
                }) ? h('span', { key: 'dot', className: 'g2048-seg-dot', 'aria-hidden': true }) : null),
              ),
              sizeMenu
                ? h('div', { className: 'g2048-menu' }, MORE_SIZES.map((size) => sizeButton(size)))
                : null,
            ),
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

        // 入口：装了游戏厅就向游戏厅登记（不再自己占侧栏图标）；没装就回退到独立图标 + 主面板。
        // 兼容加载顺序：先按独立模式注册，轮询到游戏厅出现后再撤掉自己的槽位、改成登记。
        ctx.effect(() => {
          const disposeSlots = []
          let disposeArcade = null
          let poll = null
          let settle = null
          const detachSlots = () => {
            while (disposeSlots.length) {
              try { disposeSlots.pop()() } catch (error) { /* 已释放 */ }
            }
          }
          const attachArcade = (arcade) => {
            if (disposeArcade) return
            disposeArcade = arcade.register({
              id: PANEL_ID,
              order: 40,
              title: () => t('nav.label'),
              icon: Icon2048,
              Panel: Panel2048,
            })
            detachSlots()
          }
          const arcade = typeof window !== 'undefined' ? window.__dshArcade : null
          if (arcade && typeof arcade.register === 'function') {
            attachArcade(arcade)
            return () => {
              if (disposeArcade) { try { disposeArcade() } catch (error) { /* 已释放 */ } }
            }
          }
          // 槽位由父 entry 的 children 表声明；冷启动时声明可能晚于本 entry 激活，
          // 所以用 slots.inject 等声明出现后再注册（声明收起时注册自动释放）。
          disposeSlots.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => t('nav.label') },
            Icon2048,
          )))
          disposeSlots.push(ctx.slots.inject('main', () => ctx.slots.register(
            { name: 'main', key: PANEL_ID },
            Panel2048,
          )))
          const tryAttachArcade = () => {
            const found = typeof window !== 'undefined' ? window.__dshArcade : null
            if (!found || typeof found.register !== 'function') return
            if (poll) { clearInterval(poll); poll = null }
            attachArcade(found)
          }
          let arcadeReadyListener = null
          if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            arcadeReadyListener = tryAttachArcade
            window.addEventListener('dsh-arcade-ready', arcadeReadyListener)
          }
          poll = setInterval(tryAttachArcade, 120)
          // 5 秒还没等到游戏厅就认定是独立模式，停止轮询
          settle = setTimeout(() => {
            if (poll) { clearInterval(poll); poll = null }
          }, 5000)
          return () => {
            if (poll) clearInterval(poll)
            if (settle) clearTimeout(settle)
            if (arcadeReadyListener) {
              try { window.removeEventListener('dsh-arcade-ready', arcadeReadyListener) } catch (error) { /* 已释放 */ }
            }
            if (disposeArcade) { try { disposeArcade() } catch (error) { /* 已释放 */ } }
            detachSlots()
          }
        }, 'dsh-2048: panel entry')
      },
    }
  },
})
