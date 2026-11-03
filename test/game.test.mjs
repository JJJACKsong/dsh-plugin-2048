/**
 * 2048 规则内核单测。
 *
 * 直接从 lib/client.js 里抽出 `#region game-core` 段（纯函数，不依赖 React/DOM），
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
const begin = source.indexOf('// #region game-core')
const end = source.indexOf('// #endregion game-core')
assert.ok(begin !== -1 && end > begin, 'game-core 标记存在')

const region = source.slice(begin, end)
const api = new Function(region + `
  return { SIZE, createBoard, moveBoard, canMove, emptyGrid, addRandom, resetSeq, bumpSeq, nextTileId, lineIndices }
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

/** mulberry32：确定性随机，用来复现同一局。 */
function seeded(seed) {
  let a = seed >>> 0
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), a | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 固定 rng：先按 seed 序列，再兜底第一颗新棋子落在第一个空格、值为 2。 */
function fixedRandom() { return 0 }

/** 用数字矩阵造棋盘（0 = 空）。 */
function boardFrom(rows) {
  api.resetSeq()
  const grid = api.emptyGrid()
  rows.forEach((row, r) => row.forEach((value, c) => {
    if (value) grid[r * api.SIZE + c] = { id: api.nextTileId(), value }
  }))
  return { grid, score: 0, won: false, over: false, steps: 0, spawnIds: [], mergedIds: [] }
}

/** 棋盘 → 数字矩阵。 */
function toRows(board) {
  const rows = []
  for (let r = 0; r < api.SIZE; r += 1) {
    const row = []
    for (let c = 0; c < api.SIZE; c += 1) {
      const tile = board.grid[r * api.SIZE + c]
      row.push(tile ? tile.value : 0)
    }
    rows.push(row)
  }
  return rows
}

function values(board) {
  return board.grid.filter(Boolean).map((tile) => tile.value).sort((a, b) => a - b)
}

const EMPTY_ROW = [0, 0, 0, 0]
const BLANK = [EMPTY_ROW, EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]

// ── 开局 ───────────────────────────────────────────────────────────────────
test('开局恰好两颗棋子，值为 2 或 4', () => {
  api.resetSeq()
  for (let i = 0; i < 50; i += 1) {
    const board = api.createBoard(seeded(i + 1))
    const tiles = board.grid.filter(Boolean)
    assert.equal(tiles.length, 2, '应有 2 颗棋子')
    for (const tile of tiles) assert.ok(tile.value === 2 || tile.value === 4)
    assert.equal(board.score, 0)
    assert.equal(board.steps, 0)
    assert.equal(board.over, false)
    assert.ok(api.canMove(board.grid))
  }
})

test('棋子 id 在棋盘内唯一', () => {
  const board = api.createBoard(fixedRandom)
  const ids = board.grid.filter(Boolean).map((tile) => tile.id)
  assert.equal(new Set(ids).size, ids.length)
})

// ── 合并 ───────────────────────────────────────────────────────────────────
test('左移：一对 2 合成 4，得分 +4', () => {
  const board = boardFrom([[2, 2, 0, 0], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW])
  const result = api.moveBoard(board, 'left', fixedRandom)
  assert.equal(result.moved, true)
  assert.equal(result.board.score, 4)
  assert.equal(result.board.steps, 1)
  assert.equal(toRows(result.board)[0][0], 4)
  // 合并产生一颗 + 随机新棋子一颗
  assert.deepEqual(values(result.board), [2, 4])
  assert.equal(result.board.mergedIds.length, 1)
  assert.equal(result.board.spawnIds.length, 1)
})

test('左移：四个 2 合成两个 4，得分 +8', () => {
  const board = boardFrom([[2, 2, 2, 2], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW])
  const result = api.moveBoard(board, 'left', fixedRandom)
  assert.equal(result.board.score, 8)
  assert.deepEqual(toRows(result.board)[0].slice(0, 2), [4, 4])
})

test('左移：4 4 8 只合前一对，结果是 8 8', () => {
  const board = boardFrom([[4, 4, 8, 0], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW])
  const result = api.moveBoard(board, 'left', fixedRandom)
  assert.equal(result.board.score, 8)
  assert.deepEqual(toRows(result.board)[0].slice(0, 2), [8, 8])
})

test('左移：一颗棋子也只靠边（不算合并）', () => {
  const board = boardFrom([[0, 0, 0, 2], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW])
  const result = api.moveBoard(board, 'left', fixedRandom)
  assert.equal(result.moved, true)
  assert.equal(result.board.score, 0)
  assert.equal(toRows(result.board)[0][0], 2)
})

test('右移：靠右合并', () => {
  const board = boardFrom([[0, 0, 2, 2], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW])
  const result = api.moveBoard(board, 'right', fixedRandom)
  assert.equal(result.board.score, 4)
  assert.equal(toRows(result.board)[0][3], 4)
})

test('上移：同列合并', () => {
  const board = boardFrom([[2, 0, 0, 0], [2, 0, 0, 0], EMPTY_ROW, EMPTY_ROW])
  const result = api.moveBoard(board, 'up', fixedRandom)
  assert.equal(result.board.score, 4)
  assert.equal(toRows(result.board)[0][0], 4)
})

test('下移：同列合并到底部', () => {
  const board = boardFrom([[2, 0, 0, 0], [2, 0, 0, 0], EMPTY_ROW, EMPTY_ROW])
  const result = api.moveBoard(board, 'down', fixedRandom)
  assert.equal(result.board.score, 4)
  assert.equal(toRows(result.board)[3][0], 4)
})

test('每格每步最多合并一次（2 2 4 + 左移 → 4 4，不是 8）', () => {
  const board = boardFrom([[2, 2, 4, 0], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW])
  const result = api.moveBoard(board, 'left', fixedRandom)
  assert.deepEqual(toRows(result.board)[0].slice(0, 2), [4, 4])
})

// ── 无效移动 ───────────────────────────────────────────────────────────────
test('满盘无相邻同值时：任一方向都 moved=false 且原样返回', () => {
  const board = boardFrom([
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, 2],
  ])
  assert.equal(api.canMove(board.grid), false)
  for (const dir of ['left', 'right', 'up', 'down']) {
    const result = api.moveBoard(board, dir, fixedRandom)
    assert.equal(result.moved, false, dir + ' 不该动')
    assert.equal(result.board, board, dir + ' 应原样返回同一对象')
  }
})

test('贴边无合并也是无效移动', () => {
  const board = boardFrom([[2, 4, 8, 16], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW])
  const result = api.moveBoard(board, 'left', fixedRandom)
  assert.equal(result.moved, false)
})

test('canMove：满盘但有竖向同值时为 true', () => {
  const grid = boardFrom([
    [2, 4, 2, 4],
    [2, 8, 4, 8],
    [4, 8, 16, 32],
    [64, 16, 32, 64],
  ]).grid
  assert.equal(api.canMove(grid), true)
})

// ── 方向对称 ───────────────────────────────────────────────────────────────
function mirrorRows(rows) { return rows.map((row) => row.slice().reverse()) }

test('左右对称 / 上下对称', () => {
  const rows = [
    [2, 2, 4, 8],
    [4, 2, 2, 16],
    [8, 4, 4, 2],
    [2, 2, 2, 2],
  ]
  const leftResult = api.moveBoard(boardFrom(rows), 'left', fixedRandom)
  const rightResult = api.moveBoard(boardFrom(mirrorRows(rows)), 'right', fixedRandom)
  assert.deepEqual(toRows(leftResult.board), mirrorRows(toRows(rightResult.board)))

  // up(rows) === T(left(T(rows)))，T 为转置；down 同理配 right
  const transpose = (matrix) => matrix[0].map((_, c) => matrix.map((row) => row[c]))
  const upResult = api.moveBoard(boardFrom(rows), 'up', fixedRandom)
  const leftOnTransposed = api.moveBoard(boardFrom(transpose(rows)), 'left', fixedRandom)
  assert.deepEqual(toRows(upResult.board), transpose(toRows(leftOnTransposed.board)))

  const downResult = api.moveBoard(boardFrom(rows), 'down', fixedRandom)
  const rightOnTransposed = api.moveBoard(boardFrom(transpose(rows)), 'right', fixedRandom)
  assert.deepEqual(toRows(downResult.board), transpose(toRows(rightOnTransposed.board)))
})

// ── 通关与终局标记 ─────────────────────────────────────────────────────────
test('合出 2048 时 won=true', () => {
  const board = boardFrom([[1024, 1024, 0, 0], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW])
  const result = api.moveBoard(board, 'left', fixedRandom)
  assert.equal(result.board.won, true)
  assert.deepEqual(values(result.board).slice(-1), [2048])
})

test('won 一旦达成保持为真（撤销回退除外）', () => {
  const board = boardFrom([[1024, 1024, 0, 0], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW])
  const first = api.moveBoard(board, 'left', fixedRandom).board
  const second = api.moveBoard({ ...first, grid: first.grid }, 'right', fixedRandom).board
  assert.equal(second.won, true)
})

test('最后一步仍可移动 but 之后无路 → over=true', () => {
  const board = boardFrom([
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, 0],
  ])
  // 左下角空位在最后一格：左移会把整行压过去，仍可能留下空位；这里只校验 over 与 canMove 同步
  for (const dir of ['left', 'right', 'up', 'down']) {
    const result = api.moveBoard(board, dir, fixedRandom)
    if (result.moved) assert.equal(result.board.over, !api.canMove(result.board.grid))
  }
})

// ── 发牌概率 ───────────────────────────────────────────────────────────────
test('新棋子 90% 是 2、10% 是 4', () => {
  const lowGrid = api.emptyGrid()
  const lowId = api.addRandom(lowGrid, () => 0.5)
  assert.equal(lowGrid.find((tile) => tile && tile.id === lowId).value, 2)
  const highGrid = api.emptyGrid()
  const highId = api.addRandom(highGrid, () => 0.95)
  assert.equal(highGrid.find((tile) => tile && tile.id === highId).value, 4)
})

test('addRandom 返回的 id 能定位到棋子', () => {
  const grid = api.emptyGrid()
  const id = api.addRandom(grid, () => 0.5)
  const tile = grid.find((item) => item && item.id === id)
  assert.ok(tile)
  assert.equal(tile.value, 2)
})

test('addRandom 满盘返回 null', () => {
  const grid = api.emptyGrid().map((_, index) => ({ id: index + 1, value: 2 }))
  assert.equal(api.addRandom(grid, () => 0.5), null)
})

// ── 长局不变量 ─────────────────────────────────────────────────────────────
const DIRECTIONS = ['left', 'right', 'up', 'down']

function isPowerOfTwo(value) { return value >= 2 && (value & (value - 1)) === 0 }

test('600 局随机对局：不变量始终成立，无异常', () => {
  for (let game = 0; game < 600; game += 1) {
    api.resetSeq()
    const random = seeded(game + 1)
    let board = api.createBoard(random)
    let previousScore = board.score
    let previousSteps = board.steps
    for (let step = 0; step < 4000; step += 1) {
      if (board.over) break
      const dir = DIRECTIONS[Math.floor(random() * 4) % 4]
      const result = api.moveBoard(board, dir, random)
      if (!result.moved) continue
      board = result.board
      const tiles = board.grid.filter(Boolean)
      assert.ok(tiles.length >= 1 && tiles.length <= 16)
      const ids = new Set(tiles.map((tile) => tile.id))
      assert.equal(ids.size, tiles.length, 'id 唯一')
      for (const tile of tiles) {
        assert.ok(isPowerOfTwo(tile.value), '值应为 2 的幂：' + tile.value)
        assert.ok(Number.isInteger(tile.id) && tile.id > 0)
      }
      assert.ok(board.score >= previousScore, '得分不下降')
      assert.equal(board.steps, previousSteps + 1)
      assert.equal(board.over, !api.canMove(board.grid), 'over 与 canMove 同步')
      if (board.over) {
        for (const nextDir of DIRECTIONS) {
          assert.equal(api.moveBoard(board, nextDir, random).moved, false, '终局后不再可动')
        }
      }
      previousScore = board.score
      previousSteps = board.steps
    }
  }
})

test('撤销快照不被后续移动改写', () => {
  api.resetSeq()
  const random = seeded(7)
  const before = api.createBoard(random)
  const snapshot = { grid: before.grid, score: before.score, steps: before.steps }
  let board = before
  for (const dir of ['left', 'up', 'right', 'down', 'left', 'up']) {
    const result = api.moveBoard(board, dir, random)
    if (result.moved) board = result.board
  }
  assert.equal(snapshot.grid.filter(Boolean).length, 2, '快照仍是开局两颗')
  assert.equal(snapshot.score, 0)
  assert.equal(snapshot.grid, before.grid, '快照引用原棋盘')
})

test('lineIndices：每方向 4 条线、每条 4 个下标、覆盖全部 16 格', () => {
  for (const dir of DIRECTIONS) {
    const lines = api.lineIndices(dir)
    assert.equal(lines.length, 4)
    const flat = lines.flat()
    assert.equal(flat.length, 16)
    assert.equal(new Set(flat).size, 16)
    for (const line of lines) assert.equal(line.length, 4)
  }
  assert.deepEqual(api.lineIndices('left')[0], [0, 1, 2, 3])
  assert.deepEqual(api.lineIndices('right')[0], [3, 2, 1, 0])
  assert.deepEqual(api.lineIndices('up')[0], [0, 4, 8, 12])
  assert.deepEqual(api.lineIndices('down')[0], [12, 8, 4, 0])
  assert.deepEqual(api.lineIndices('nope'), [])
})

test('空棋盘参数不炸', () => {
  assert.equal(api.canMove(api.emptyGrid()), true)
  assert.deepEqual(toRows(api.createBoard(fixedRandom)).flat().filter(Boolean).length, 2)
  assert.deepEqual(api.lineIndices('left').length, 4)
})

// ── 收尾 ───────────────────────────────────────────────────────────────────
if (process.exitCode) {
  console.error('\n有失败用例')
} else {
  console.log('\n' + passed + ' 项全部通过')
}
