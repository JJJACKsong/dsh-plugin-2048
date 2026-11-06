/**
 * 插件外壳自检（不需要浏览器）：
 *   1. lib/client.js 在最简 window / React 桩下能被模块加载器收下并 apply 出两个槽位；
 *   2. 中英文案键一致，且源码里用到的每个 t('x') / fmt('x') 都有翻译（不会出现裸 key）；
 *   3. package.json 的 dsh 清单字段齐全（bundle.patch / client.platform / exports）。
 *
 * 跑法：node test/plugin.test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

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

// ── 1. 模块加载 + apply ────────────────────────────────────────────────────
// 最简 React 桩：factory 阶段只会解构 hooks，不会真的调用
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: undefined }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}

function loadModule() {
  let definition = null
  const fakeWindow = { __ModuleLoader__: { load: (def) => { definition = def } } }
  // eslint-disable-next-line no-new-func
  const runModule = new Function('window', source)
  runModule(fakeWindow)
  assert.ok(definition, '模块把定义交给了 __ModuleLoader__.load')
  assert.equal(definition.id, 'dsh-plugin-2048', 'factory id 等于包名')
  const mod = definition.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error('unexpected require: ' + name)
  })
  assert.ok(mod && typeof mod.apply === 'function', 'factory 返回 { inject, apply }')
  assert.ok(Array.isArray(mod.inject) && mod.inject.includes('slots'), 'inject 声明了 slots')
  return mod
}

test('client.js 能在模块加载器桩下加载并返回 apply', () => {
  loadModule()
})

test('apply 注册了侧栏图标与主面板两个槽位', () => {
  const mod = loadModule()
  const registrations = []
  const localeRegistrations = []
  const cleanups = []
  const fakeCtx = {
    effect(fn, label) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
    get() { return undefined },
    locale: {
      register: (ns, locale) => { localeRegistrations.push([ns, locale]); return () => {} },
      bind: () => (key) => key,
      subscribe: () => () => {},
    },
    slots: {
      inject(key, callback) { return callback() },
      register(options, component) {
        registrations.push({ slot: options.name, options, component })
        return () => {}
      },
    },
  }
  mod.apply(fakeCtx)

  const sidebar = registrations.find((row) => row.slot === 'sidebar.panellist')
  const main = registrations.find((row) => row.slot === 'main')
  assert.ok(sidebar, '注册了 sidebar.panellist')
  assert.ok(main, '注册了 main')
  assert.equal(sidebar.options.id, 'dsh-2048')
  assert.equal(main.options.key, 'dsh-2048', '侧栏 id 与主面板 key 必须一致，否则点不开')
  assert.equal(typeof sidebar.component, 'function')
  assert.equal(typeof main.component, 'function')
  assert.ok(localeRegistrations.length >= 2, '注册了中英文字典')

  // 释放路径不能抛
  for (const cleanup of cleanups.reverse()) cleanup()
})

// ── 2. 文案完整性 ──────────────────────────────────────────────────────────
function readDict(name) {
  const start = source.indexOf('const ' + name + ' = {')
  assert.ok(start !== -1, '找到 ' + name)
  const end = source.indexOf('\n    }\n', start)
  assert.ok(end > start, '找到 ' + name + ' 结尾')
  const text = source.slice(source.indexOf('{', start), end + 6)
  // 字典是纯字面量，直接求值
  // eslint-disable-next-line no-new-func
  return new Function('return ' + text)()
}

test('中英文案键集合一致', () => {
  const zh = readDict('ZH')
  const en = readDict('EN')
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert.deepEqual(zhKeys, enKeys, 'ZH 与 EN 的键必须一一对应')
  assert.ok(zhKeys.length > 50, '文案量正常：' + zhKeys.length)
})

test('源码里用到的每个 t()/fmt() 键都有翻译', () => {
  const zh = readDict('ZH')
  const used = new Set()
  const pattern = /\b(?:t|fmt)\('([a-zA-Z0-9_.-]+)'/g
  let match = pattern.exec(source)
  while (match) {
    used.add(match[1])
    match = pattern.exec(source)
  }
  // 动态拼接的成就文案单独检查（形如 t('achv.' + id) 会被上面的正则抓成 'achv.'）
  for (const key of [...used]) {
    if (key.endsWith('.')) used.delete(key)
  }
  const dynamic = ['tile-128', 'tile-512', 'tile-1024', 'tile-2048', 'combo-3', 'no-undo-2048', 'score-10000', 'score-50000', 'size-5-2048', 'daily-win']
  for (const id of dynamic) used.add('achv.' + id)
  used.delete('x') // 注释里的示例
  const missing = [...used].filter((key) => !(key in zh))
  assert.deepEqual(missing, [], '缺少翻译：' + missing.join(', '))
})

// ── 3. 清单字段 ────────────────────────────────────────────────────────────
test('package.json 的 dsh 清单位齐', () => {
  assert.equal(pkg.name, 'dsh-plugin-2048')
  assert.ok(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch, '声明了 dsh.bundle.patch')
  assert.equal(pkg.dsh.client.platform, 'web', '客户端平台是 web')
  assert.equal(pkg.dsh.client.immediately, true)
  assert.ok(pkg.exports['./client'], '导出 ./client')
  assert.ok(pkg.exports['./icon'], '导出 ./icon')
  assert.ok(pkg.exports['./locale/*.json'], '导出 locale')
  for (const file of ['lib/client.js', 'lib/index.js', 'cordis.patch.yml', 'icon.svg', 'locale/zh.json', 'locale/en.json']) {
    assert.ok((pkg.files || []).some((entry) => file === entry || file.startsWith(entry.replace('/*', '/'))), 'files 覆盖 ' + file)
  }
})

test('locale/*.json 的标题与描述都不为空', () => {
  for (const locale of ['zh', 'en']) {
    const meta = JSON.parse(readFileSync(join(root, 'locale', locale + '.json'), 'utf8'))
    assert.ok(meta.meta && meta.meta.title && meta.meta.description, locale + ' meta 完整')
  }
})

if (process.exitCode) {
  console.error('\n有失败用例')
} else {
  console.log('\n' + passed + ' 项全部通过')
}
