/**
 * 2048 规则内核 + 成就判定单测。
 *
 * 直接从 lib/client.js 里抽出 `#region game-core` 段和成就表（纯函数，不依赖 React/DOM），
 * 用 new Function 装成模块跑——测的是真正上线的那段代码，不是复制品。
 *
 * 跑法：node test/game.test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
const begin = source.indexOf('// ── #region game-core')
const end = source.indexOf('// #endregion game-core')
assert.ok(begin !== -1 && end > begin, 'game-core 标记存在')
const region = source.slice(begin, end)

const achvBegin = source.indexOf('    const ACHIEVEMENTS = [')
const achvEnd = source.indexOf('    ]\n', source.indexOf('{ id: \'daily-win\''))
assert.ok(achvBegin !== -1 && achvEnd > achvBegin, '成就表存在')
const achvBlock = source.slice(achvBegin, achvEnd + 6)

const api = new Function(region + '\n' + achvBlock + `
  return {
    SIZES, WIN_TILE, nextRandom, seedFrom, emptyGrid, normalizeSize, lineIndices, pickSpawn,
    resetSeq, bumpSeq, nextTileId, createBoard, canMove, moveBoard, maxTileOf, snapshotOf,
    parkBoard, resumeBoard, elapsedOf, dailySeedFor, ACHIEVEMENTS,
  }
`)()

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  ok  ' + name)
  } catch (error) {
    console.error('  FAIL  ' + name)
    console.error(error && error.stack ? error.stack : error)
    process.exitCode = 1
  }
}

/** 确定性随机流：用内核自己的 nextRandom 驱动，保证可复现。 */
function stream(seed) {
  let state = seed >>> 0
  return () => {
    const step = api.nextRandom(state)
    state = step.state
    return step.value
  }
}

const DIRS = ['left', 'right', 'up', 'down']

/** 用数字矩阵造棋盘（0 = 空）。 */
function boardFrom(rows, rngState) {
  api.resetSeq()
  const size = rows.length
  const grid = api.emptyGrid(size)
  rows.forEach((row, r) => row.forEach((value, c) => {
    if (value) grid[r * size + c] = { id: api.nextTileId(), value }
  }))
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
    rngState: Number.isFinite(rngState) ? rngState : 0x12345678,
    startedAt: 1000,
    endedAt: 0,
    daily: null,
    spawnIds: [],
    mergedIds: [],
  }
}

/** 棋盘 → 数字矩阵。 */
function toRows(board) {
  const size = board.size
  const rows = []
  for (let r = 0; r < size; r += 1) {
    const row = []
    for (let c = 0; c < size; c += 1) {
      const tile = board.grid[r * size + c]
      row.push(tile ? tile.value : 0)
    }
    rows.push(row)
  }
  return rows
}

function values(board) {
  return board.grid.filter(Boolean).map((tile) => tile.value).sort((a, b) => a - b)
}

function isPowerOfTwo(value) { return value >= 2 && (value & (value - 1)) === 0 }

const EMPTY4 = [0, 0, 0, 0]
const BLANK4 = [EMPTY4, EMPTY4, EMPTY4, EMPTY4]
const EMPTY5 = [0, 0, 0, 0, 0]
const BLANK5 = [EMPTY5, EMPTY5, EMPTY5, EMPTY5, EMPTY5]

// ── 随机数内核 ─────────────────────────────────────────────────────────────
test('nextRandom 是纯函数：同状态同结果，输出在 [0,1)', () => {
  const first = api.nextRandom(12345)
  const second = api.nextRandom(12345)
  assert.deepEqual(first, second)
  assert.ok(first.value >= 0 && first.value < 1)
  assert.notEqual(first.state, 12345, '状态应当推进')
  const third = api.nextRandom(first.state)
  assert.notEqual(third.value, first.value)
})

test('seedFrom 稳定且区分日期/尺寸', () => {
  assert.equal(api.seedFrom('abc'), api.seedFrom('abc'))
  assert.notEqual(api.seedFrom('abc'), api.seedFrom('abd'))
  assert.equal(api.dailySeedFor('2026-11-07', 4), api.dailySeedFor('2026-11-07', 4))
  assert.notEqual(api.dailySeedFor('2026-11-07', 4), api.dailySeedFor('2026-11-08', 4))
  assert.notEqual(api.dailySeedFor('2026-11-07', 4), api.dailySeedFor('2026-11-07', 5))
})

test('每日种子稳定：同一天同一尺寸开局一致', () => {
  const now = 1762531200000
  api.resetSeq()
  const first = api.createBoard({ size: 4, now, seed: api.dailySeedFor('2026-11-07', 4), daily: '2026-11-07' })
  api.resetSeq()
  const second = api.createBoard({ size: 4, now, seed: api.dailySeedFor('2026-11-07', 4), daily: '2026-11-07' })
  assert.deepEqual(toRows(first), toRows(second))
})

// ── 开局 ───────────────────────────────────────────────────────────────────
test('开局：4×4 / 5×5 各两颗棋子，值为 2 或 4', () => {
  for (const size of api.SIZES) {
    api.resetSeq()
    const board = api.createBoard({ size, seed: 42, now: 1 })
    const tiles = board.grid.filter(Boolean)
    assert.equal(board.size, size)
    assert.equal(board.grid.length, size * size)
    assert.equal(tiles.length, 2)
    for (const tile of tiles) assert.ok(tile.value === 2 || tile.value === 4)
    assert.equal(board.score, 0)
    assert.equal(board.steps, 0)
    assert.equal(board.over, false)
    assert.equal(board.maxCombo, 0)
    assert.ok(Number.isFinite(board.rngState))
    assert.ok(api.canMove(board.grid, size))
  }
})

test('开局确定性：同 seed + 同尺寸 → 同棋盘', () => {
  api.resetSeq()
  const first = api.createBoard({ size: 4, seed: 777, now: 1 })
  api.resetSeq()
  const second = api.createBoard({ size: 4, seed: 777, now: 1 })
  assert.deepEqual(toRows(first), toRows(second))
})

test('棋子 id 在棋盘内唯一', () => {
  const board = api.createBoard({ size: 5, seed: 9, now: 1 })
  const ids = board.grid.filter(Boolean).map((tile) => tile.id)
  assert.equal(new Set(ids).size, ids.length)
})

// ── 合并规则 ───────────────────────────────────────────────────────────────
test('左移：一对 2 合成 4，得分 +4', () => {
  const result = api.moveBoard(boardFrom([[2, 2, 0, 0], EMPTY4, EMPTY4, EMPTY4]), 'left')
  assert.equal(result.moved, true)
  assert.equal(result.board.score, 4)
  assert.equal(result.board.steps, 1)
  assert.equal(toRows(result.board)[0][0], 4)
  const after = values(result.board)
  assert.equal(after.length, 2, '合并一颗 + 新发一颗')
  assert.equal(after[0], 4)
  assert.ok(after[1] === 2 || after[1] === 4)
  assert.equal(result.board.mergedIds.length, 1)
  assert.equal(result.board.spawnIds.length, 1)
  assert.equal(result.board.combo, 1)
})

test('左移：四个 2 合成两个 4，得分 +8，连击 ×2 另加 2 分', () => {
  const result = api.moveBoard(boardFrom([[2, 2, 2, 2], EMPTY4, EMPTY4, EMPTY4]), 'left')
  assert.deepEqual(toRows(result.board)[0].slice(0, 2), [4, 4])
  assert.equal(result.board.combo, 2)
  assert.equal(result.board.lastBonus, 2, '合并得分 8 × 25% ×（2-1）')
  assert.equal(result.board.score, 10)
  assert.equal(result.board.maxCombo, 2)
})

test('左移：4 4 8 只合前一对，结果是 8 8', () => {
  const result = api.moveBoard(boardFrom([[4, 4, 8, 0], EMPTY4, EMPTY4, EMPTY4]), 'left')
  assert.deepEqual(toRows(result.board)[0].slice(0, 2), [8, 8])
  assert.equal(result.board.score, 8)
})

test('每格每步最多合并一次：2 2 4 左移 → 4 4（不是 8）', () => {
  const result = api.moveBoard(boardFrom([[2, 2, 4, 0], EMPTY4, EMPTY4, EMPTY4]), 'left')
  assert.deepEqual(toRows(result.board)[0].slice(0, 2), [4, 4])
})

test('单颗棋子只是靠边，不算合并也不给分', () => {
  const result = api.moveBoard(boardFrom([[0, 0, 0, 2], EMPTY4, EMPTY4, EMPTY4]), 'left')
  assert.equal(result.moved, true)
  assert.equal(result.board.score, 0)
  assert.equal(result.board.combo, 0)
  assert.equal(toRows(result.board)[0][0], 2)
})

test('四个方向都能合：右 / 上 / 下', () => {
  const right = api.moveBoard(boardFrom([[0, 0, 2, 2], EMPTY4, EMPTY4, EMPTY4]), 'right')
  assert.equal(toRows(right.board)[0][3], 4)
  const up = api.moveBoard(boardFrom([[2, 0, 0, 0], [2, 0, 0, 0], EMPTY4, EMPTY4]), 'up')
  assert.equal(toRows(up.board)[0][0], 4)
  const down = api.moveBoard(boardFrom([[2, 0, 0, 0], [2, 0, 0, 0], EMPTY4, EMPTY4]), 'down')
  assert.equal(toRows(down.board)[3][0], 4)
})

test('跨行三对合并：连击 ×3，maxCombo=3', () => {
  const board = boardFrom([[2, 2, 0, 0], [2, 2, 0, 0], [4, 4, 0, 0], EMPTY4])
  const result = api.moveBoard(board, 'left')
  assert.equal(result.board.combo, 3)
  assert.equal(result.board.maxCombo, 3)
  // 合并得分 = 4 + 4 + 8 = 16；多两对 → 奖励 16 × 25% × 2 = 8
  assert.equal(result.board.lastBonus, 8)
  assert.equal(result.board.score, 24)
})

// ── 无效移动 / 终局 ────────────────────────────────────────────────────────
test('满盘无相邻同值：任一方向都 moved=false 且原样返回', () => {
  const board = boardFrom([
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, 2],
  ])
  assert.equal(api.canMove(board.grid, 4), false)
  for (const dir of DIRS) {
    const result = api.moveBoard(board, dir)
    assert.equal(result.moved, false, dir + ' 不该动')
    assert.equal(result.board, board, dir + ' 应原样返回同一对象')
  }
})

test('贴边无合并也是无效移动', () => {
  const result = api.moveBoard(boardFrom([[2, 4, 8, 16], EMPTY4, EMPTY4, EMPTY4]), 'left')
  assert.equal(result.moved, false)
  assert.equal(result.board.steps, 0)
})

test('canMove：满盘但有竖向同值时为 true', () => {
  const grid = boardFrom([
    [2, 4, 2, 4],
    [2, 8, 4, 8],
    [4, 8, 16, 32],
    [64, 16, 32, 64],
  ]).grid
  assert.equal(api.canMove(grid, 4), true)
})

test('走不动时 over=true', () => {
  const board = boardFrom([
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, 0],
  ])
  // 左移让右下角空位消失后，棋盘可能再无路可走；只校验 over 与 canMove 同步
  for (const dir of DIRS) {
    const result = api.moveBoard(board, dir)
    if (!result.moved) continue
    assert.equal(result.board.over, !api.canMove(result.board.grid, 4))
  }
})

// ── 通关 / 最大块 ─────────────────────────────────────────────────────────
test('合出 2048 时 won=true，且 maxTileOf 认得', () => {
  const result = api.moveBoard(boardFrom([[1024, 1024, 0, 0], EMPTY4, EMPTY4, EMPTY4]), 'left')
  assert.equal(result.board.won, true)
  assert.equal(api.maxTileOf(result.board), 2048)
})

test('won 一旦达成保持为真', () => {
  const first = api.moveBoard(boardFrom([[1024, 1024, 0, 0], EMPTY4, EMPTY4, EMPTY4]), 'left').board
  const second = api.moveBoard({ ...first }, 'right').board
  assert.equal(second.won, true)
})

// ── 尺寸 ───────────────────────────────────────────────────────────────────
test('lineIndices：4×4 / 5×5 都是每方向 N 条线、覆盖全部格子', () => {
  for (const size of api.SIZES) {
    for (const dir of DIRS) {
      const lines = api.lineIndices(dir, size)
      assert.equal(lines.length, size)
      const flat = lines.flat()
      assert.equal(flat.length, size * size)
      assert.equal(new Set(flat).size, size * size)
    }
  }
  assert.deepEqual(api.lineIndices('left', 4)[0], [0, 1, 2, 3])
  assert.deepEqual(api.lineIndices('right', 5)[0], [4, 3, 2, 1, 0])
  assert.deepEqual(api.lineIndices('up', 4)[0], [0, 4, 8, 12])
  assert.deepEqual(api.lineIndices('nope', 4), [])
})

test('5×5 能正常移动与合并', () => {
  const board = boardFrom([EMPTY5, [0, 2, 2, 0, 0], EMPTY5, EMPTY5, EMPTY5])
  const result = api.moveBoard(board, 'left')
  assert.equal(result.moved, true)
  assert.equal(result.board.size, 5)
  assert.equal(toRows(result.board)[1][0], 4)
  assert.equal(result.board.score, 4)
})

test('尺寸归一化：非法尺寸按 4', () => {
  assert.equal(api.normalizeSize(9), 4)
  assert.equal(api.normalizeSize(undefined), 4)
  assert.equal(api.normalizeSize(5), 5)
})

// ── 发牌 ───────────────────────────────────────────────────────────────────
test('pickSpawn：空棋盘落在范围内，值是 2 或 4', () => {
  for (let i = 0; i < 40; i += 1) {
    const grid = api.emptyGrid(4)
    const spawn = api.pickSpawn(grid, i * 7919 + 13)
    assert.ok(spawn.index >= 0 && spawn.index < 16)
    assert.ok(spawn.value === 2 || spawn.value === 4)
    assert.ok(Number.isFinite(spawn.state))
  }
})

test('pickSpawn：满盘返回 -1', () => {
  const grid = api.emptyGrid(5).map((_, index) => ({ id: index + 1, value: 2 }))
  assert.equal(api.pickSpawn(grid, 5).index, -1)
})

test('pickSpawn 是纯函数：不改入参', () => {
  const grid = api.emptyGrid(4)
  api.pickSpawn(grid, 77)
  assert.deepEqual(grid.filter(Boolean), [])
})

// ── 存档可续：随机状态随棋盘持久化 ────────────────────────────────────────
test('JSON 往返后继续下棋，结果与不存档一致', () => {
  const start = api.createBoard({ size: 4, seed: 2026, now: 1 })
  const roundTripped = JSON.parse(JSON.stringify(start))
  let live = start
  let restored = roundTripped
  const dirs = ['left', 'up', 'right', 'down', 'left', 'up', 'right', 'left']
  for (const dir of dirs) {
    const a = api.moveBoard(live, dir)
    const b = api.moveBoard(restored, dir)
    assert.equal(a.moved, b.moved, dir + ' 可动性一致')
    if (!a.moved) continue
    live = a.board
    restored = b.board
    assert.deepEqual(toRows(restored), toRows(live), dir + ' 后棋盘一致')
    assert.equal(restored.score, live.score)
    assert.equal(restored.rngState, live.rngState, '随机状态也要一致')
  }
})

// ── 撤销快照 ───────────────────────────────────────────────────────────────
test('snapshotOf 不被后续移动改写', () => {
  const before = api.createBoard({ size: 4, seed: 31, now: 1000 })
  const snapshot = api.snapshotOf(before)
  let board = before
  for (const dir of ['left', 'up', 'right', 'down']) {
    const result = api.moveBoard(board, dir)
    if (result.moved) board = result.board
  }
  assert.equal(snapshot.grid.filter(Boolean).length, 2, '快照仍是开局两颗')
  assert.equal(snapshot.score, 0)
  assert.equal(snapshot.grid, before.grid, '快照引用原棋盘')
  assert.equal(snapshot.startedAt, 1000)
})

// ── 尺寸切换：停表与续局 ──────────────────────────────────────────────────
test('parkBoard 停表：把当前这一段计入 elapsedMs', () => {
  const board = { ...boardFrom(BLANK4), startedAt: 1000, elapsedMs: 500 }
  const parked = api.parkBoard(board, 4000)
  assert.equal(parked.elapsedMs, 3500)
  assert.equal(parked.startedAt, 0)
  assert.equal(api.elapsedOf(parked, 9999), 3500, '停表后不再走')
})

test('resumeBoard 重新走表，累计时间不丢', () => {
  // 1000→4000 先走 3 秒并停表；10000 再开表，到 12000 共 5 秒
  const parked = api.parkBoard({ ...boardFrom(BLANK4), startedAt: 1000, elapsedMs: 0 }, 4000)
  assert.equal(parked.elapsedMs, 3000)
  const resumed = api.resumeBoard(parked, 10000)
  assert.equal(resumed.startedAt, 10000)
  assert.equal(api.elapsedOf(resumed, 12000), 5000, '3 秒第一段 + 2 秒第二段')
  assert.equal(api.parkBoard(resumed, 12000).elapsedMs, 5000)
})

test('已结束的棋局不重新走表', () => {
  const over = { ...boardFrom(BLANK4), over: true, startedAt: 1000, endedAt: 3500, elapsedMs: 0 }
  assert.equal(api.parkBoard(over, 9000), over, '终局原地不动')
  assert.equal(api.resumeBoard(over, 9000), over)
  assert.equal(api.elapsedOf(over, 99999), 2500)
})

test('两个尺寸槽互不影响（模拟切尺寸）', () => {
  const four = { ...boardFrom(BLANK4), startedAt: 1000 }
  // 存档里的槽都是停表状态（startedAt = 0），切过去才重新走表
  const fiveParked = api.parkBoard(api.createBoard({ size: 5, seed: 5, now: 2000 }), 3000)
  const parked = { 4: api.parkBoard(four, 5000), 5: api.resumeBoard(fiveParked, 5000) }
  assert.equal(parked[4].size, 4)
  assert.equal(parked[5].size, 5)
  assert.equal(parked[4].steps, 0)
  assert.equal(parked[5].startedAt, 5000)
  assert.equal(parked[4].startedAt, 0, '4×4 那槽停表')
  assert.equal(api.elapsedOf(parked[5], 6000), 1000 + 1000, '5×5 只算自己的时间')
})

// ── 长局不变量 ─────────────────────────────────────────────────────────────
test('800 局随机对局（4×4 / 5×5 各半）：不变量始终成立', () => {
  for (let game = 0; game < 800; game += 1) {
    const size = api.SIZES[game % api.SIZES.length]
    const random = stream(game + 1)
    let board = api.createBoard({ size, seed: (game * 2654435761) >>> 0, now: 1 })
    let previousScore = board.score
    let previousSteps = board.steps
    for (let step = 0; step < 3000; step += 1) {
      if (board.over) break
      const dir = DIRS[Math.floor(random() * 4) % 4]
      const result = api.moveBoard(board, dir)
      if (!result.moved) continue
      board = result.board
      const tiles = board.grid.filter(Boolean)
      assert.equal(board.size, size)
      assert.ok(tiles.length >= 1 && tiles.length <= size * size)
      const ids = new Set(tiles.map((tile) => tile.id))
      assert.equal(ids.size, tiles.length, 'id 唯一')
      for (const tile of tiles) {
        assert.ok(isPowerOfTwo(tile.value), '值应为 2 的幂：' + tile.value)
        assert.ok(Number.isInteger(tile.id) && tile.id > 0)
      }
      assert.ok(board.score >= previousScore, '得分不下降')
      assert.equal(board.steps, previousSteps + 1)
      assert.equal(board.over, !api.canMove(board.grid, size), 'over 与 canMove 同步')
      const maxPairs = size * Math.floor(size / 2)
      assert.ok(board.combo >= 0 && board.combo <= maxPairs, 'combo 合理：' + board.combo)
      assert.ok(board.maxCombo >= board.combo, 'maxCombo 不小于本手 combo')
      if (board.lastBonus > 0) {
        assert.ok(board.combo >= 2, '只有多对合并才有奖励')
      }
      if (board.over) {
        for (const nextDir of DIRS) {
          assert.equal(api.moveBoard(board, nextDir).moved, false, '终局后不再可动')
        }
      }
      previousScore = board.score
      previousSteps = board.steps
    }
  }
})

// ── 成就判定 ───────────────────────────────────────────────────────────────
const ACHV = Object.fromEntries(api.ACHIEVEMENTS.map((item) => [item.id, item.test]))

test('成就：块数里程碑', () => {
  assert.equal(ACHV['tile-128'](boardFrom([[128, 0, 0, 0], EMPTY4, EMPTY4, EMPTY4])), true)
  assert.equal(ACHV['tile-128'](boardFrom([[64, 0, 0, 0], EMPTY4, EMPTY4, EMPTY4])), false)
  assert.equal(ACHV['tile-512'](boardFrom([[512, 0, 0, 0], EMPTY4, EMPTY4, EMPTY4])), true)
  assert.equal(ACHV['tile-1024'](boardFrom([[1024, 0, 0, 0], EMPTY4, EMPTY4, EMPTY4])), true)
  assert.equal(ACHV['tile-2048'](boardFrom([[2048, 0, 0, 0], EMPTY4, EMPTY4, EMPTY4])), true)
  assert.equal(ACHV['tile-2048'](boardFrom([[1024, 0, 0, 0], EMPTY4, EMPTY4, EMPTY4])), false)
})

test('成就：三连击 / 零撤销 2048 / 5×5 2048 / 每日通关 / 分数线', () => {
  assert.equal(ACHV['combo-3']({ ...boardFrom(BLANK4), maxCombo: 3 }), true)
  assert.equal(ACHV['combo-3']({ ...boardFrom(BLANK4), maxCombo: 2 }), false)

  assert.equal(ACHV['no-undo-2048']({ ...boardFrom(BLANK4), won: true, undos: 0 }), true)
  assert.equal(ACHV['no-undo-2048']({ ...boardFrom(BLANK4), won: true, undos: 1 }), false)

  const fiveWith2048 = boardFrom([[2048, 0, 0, 0, 0], EMPTY5, EMPTY5, EMPTY5, EMPTY5])
  assert.equal(ACHV['size-5-2048'](fiveWith2048), true)
  assert.equal(ACHV['size-5-2048'](boardFrom([[2048, 0, 0, 0], EMPTY4, EMPTY4, EMPTY4])), false)

  assert.equal(ACHV['daily-win']({ ...boardFrom(BLANK4), daily: '2026-11-07', won: true }), true)
  assert.equal(ACHV['daily-win']({ ...boardFrom(BLANK4), won: true }), false)

  assert.equal(ACHV['score-10000']({ ...boardFrom(BLANK4), score: 10000 }), true)
  assert.equal(ACHV['score-10000']({ ...boardFrom(BLANK4), score: 9999 }), false)
  assert.equal(ACHV['score-50000']({ ...boardFrom(BLANK4), score: 50000 }), true)
})

test('成就 id 唯一且都有判定函数', () => {
  const ids = api.ACHIEVEMENTS.map((item) => item.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const item of api.ACHIEVEMENTS) assert.equal(typeof item.test, 'function')
})

// ── 收尾 ───────────────────────────────────────────────────────────────────
if (process.exitCode) {
  console.error('\n有失败用例')
} else {
  console.log('\n' + passed + ' 项全部通过')
}
