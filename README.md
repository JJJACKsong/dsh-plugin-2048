# dsh-plugin-2048 · 等 agent 的 2048

**DeepSeek Harness（dsh）的侧边栏小游戏插件：主区整页棋盘，专门用来消磨「等 agent 跑完」的那几分钟。**
来活儿了会提醒你——这局不用一直盯着会话面板。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.1.5--rc.2-4f8ef7.svg)](#兼容性)
[![platform](https://img.shields.io/badge/platform-web%20ui-e8912a.svg)](#兼容性)

> **English**: A 2048 game for DeepSeek Harness. One sidebar icon opens a full-page board in the main
> column: **4×4 to 9×9** (boards above 5×5 fold into a "More" menu), arrow keys / WASD / swipe,
> **an AUTO pilot driven by a built-in expectimax AI**, combo bonuses, **squash-and-stretch tile motion
> with speed-based motion blur**, undo, sound, a saved game per board size, best scores, recent-game
> history, achievements, a daily seeded challenge with a copyable result, and an **in-game notice when
> a session finishes or is waiting on you**. The Host half is an empty `apply()` — no services, no
> tools, no session writes, no workspace files. UI uses the host's `--dsw-alias-*` theme tokens, so it
> follows light/dark.

---

## 为什么做这个

dsh 里一个 agent 跑长任务，人只能等。切出去开网页游戏又会把上下文和注意力一起带走。

所以做成插件：**入口就在左边栏**，跟「插件」「定时任务」等面板并排；点开是主区整页，不弹窗、不抢焦点、不占会话。**agent 跑完或有活儿等你时，棋盘上方会出现一条提示**，点「去看看」直接跳回那个会话——不用来回切面板看进度。

## 长什么样

```
┌──────────────────────────────────────────────┐
│  侧边栏           │        主区（整页）      │
│  …                │  ● 「视频脚本」跑完了 去看看 │
│  ▣ 插件           │   ▦ 2048   [每日 11-07]  │
│  ◷ 定时任务       │   得分 最高 最大块 用时   │
│                   │    ┌───┬───┬───┬───┐      │
│  ▦ 2048  ← 新增   │    │ 2 │   │ 4 │   │      │
│  …                │    ├───┼───┼───┼───┤      │
│                   │    │   │ 8 │   │ 2 │      │
│                   │    ├───┼───┼───┼───┤      │
│                   │    │16 │   │ 4 │ ╳3│      │
│                   │    ├───┼───┼───┼───┤      │
│                   │    │   │ 2 │   │ 8 │      │
│                   │    └───┴───┴───┴───┘      │
│                   │  ↑↓←→ 移动  [音效][撤销][新局]│
│                   │ [4×4|5×5|更多▾][每日][战绩][成就]│
└──────────────────────────────────────────────┘
```

## 玩法

- **移动**：方向键、`W A S D`、`Vim HJKL`；触屏直接在棋盘上滑动。
- **连击**：一手合并 ≥2 对时中间闪「连击 ×N」，每多一对另给本次合并得分的 25% 奖励分。
- **AUTO 托管**：工具栏「AUTO」把当前局交给内置 expectimax AI 自动下（4×4 搜索 4 层，盘面越大自动降层），你只负责看；手动按方向键/滑动会立刻接管并退出 AUTO。托管局不计最高分与成就，战绩里标 `AUTO`。
- **尺寸**：4×4 / 5×5 常驻按钮，6×6 ~ 9×9 收在「更多」折叠菜单里 —— **每个尺寸各留一局**，切回来接着下，计时暂停不跑秒，撤销历史也按尺寸分开；最高分同样分尺寸记。工具栏上另一尺寸有未完成对局时会亮一个小点。
- **撤销**：最多回退 30 步，最高分不回退，撤销次数会记进结算。
- **结算**：合出 2048 弹「**注意力惊人！**」（可继续往 4096 堆）；走不动弹「**注意力涣散！**」，两个菜单里都能撤销、重开或复制战报。
- **音效**：WebAudio 现场合成（移动 / 合并 / 连击 / 通关 / 终局），默认开、一键静音、选择记忆。
- **每日挑战**：按本地日期做种子的固定发牌，同一天人人同一副牌；标题旁显示日期徽章，当天通关后标记「今日已完成」。
- **战报**：结算或工具栏「复制战报」输出一段纯文本，可直接贴群里（分数 · 最大块 · 步数 · 用时 · 棋盘尺寸）。
- **战绩**：最近 10 局（分数 / 最大块 / 步数 / 用时 / 是否每日）落在本地，工具栏「战绩」展开。
- **成就**：10 个本地解锁项（首块 128/512/1024/2048、单步三连击、零撤销到 2048、单局 1 万/5 万分、5×5 到 2048、每日通关），解锁时右下角弹一枚 toast，工具栏「成就」查看。
- **手感**：棋子不是「瞬移」到新位置，而是从旧格子真的飞过去 —— 位移用显式关键帧动画（不依赖 CSS transition），按滑了几格给 140~200ms，途中带 1.35~2.25px 的动态模糊、到站立刻清晰，落地越过落点 1.8~5px 再回弹；同时叠加沿运动方向的拉伸 / 侧向挤压形变。新子弹出、合并 pop、无效方向抖动也各有节奏；`prefers-reduced-motion` 下全部关掉。

### 会话联动（为什么它在 dsh 里特别有用）

面板是 root 作用域，拿得到宿主注入的标准 props，因此用 `useSessionStatus` 读会话的 UI 状态：

| 会话状态 | 游戏页提示 |
|---|---|
| `pendingInteraction`：agent 在等你批准 / 回答 | 「「XX」在等你批准 / 回答」，点「去看看」跳到那个会话 |
| `completionUnread`：跑完了但你没在看 | 「「XX」跑完了」，点「去看看」跳过去 |

提示是一条不打断游戏的横条，可以「关闭」；状态不变就不会反复弹。跳转优先用 `uiWorkspace.openSession(sessionId)`，取不到就退回会话面板。这一路只**读**宿主状态，不写会话、不订阅日志、不发事件。

## 安装

> **版本说明**：最新功能以 [Releases](https://github.com/JJJACKsong/dsh-plugin-2048/releases) 为准（当前 `v0.5.0`）。npm 上的包由发布流程更新，可能落后于仓库；想直接装到最新版，用下面的「从本地目录」。

**从 npm**：

```bash
dsh plugin --profile <profile> add dsh-plugin-2048
```

桌面版的 profile 由应用托管：用插件管理器 / 插件页按 npm 包名 `dsh-plugin-2048` 安装，或在 Discover / 市场面板搜 **2048** 直接装。

**从插件市场**：已收录 [Open Plugin Market](https://dshopen.org/zh/)（[索引仓库](https://github.com/polang233/dsh-plugin-index)），市场面板搜 **2048** 即可。

**从本地目录**（离线或改代码时）：

```bash
git clone https://github.com/JJJACKsong/dsh-plugin-2048.git
# 桌面版：插件管理器从本地目录安装，或让 agent 用 plugin_manager install_bundle（target 填绝对路径）
dsh plugin --profile <profile> add /abs/path/to/dsh-plugin-2048
```

装完即激活（HMR），侧边栏最下面多一个 **2048** 图标，点开就能玩。

> 如果同时装了 `dsh-plugin-arcade`（小游戏厅），2048 会收进「小游戏」入口里，不再单独占侧栏图标；没装游戏厅时保持原来的独立图标。

> 已装过旧版本升级时：`remove_bundle` 再 `install_bundle`，然后刷新页面（客户端 JS 只有重装/重启才会换新）。

卸载 / 暂停：用插件管理器的开关或 `plugin_manager` 的 `set_bundle` / `remove_bundle`。

## 兼容性

- 需要 dsh `>= 0.1.5-rc.2`（`engines.dsh`）。
- 只做 **Web UI**（`dsh.client.platform: "web"`）——桌面版即 Web UI；不提供终端 / TUI 界面。
- 依赖的宿主 Client 包：locale（`dsh.client.inject`）；会话联动用宿主注入的 `useSessionStatus`/`useSessions`，宿主没提供时自动静默降级（游戏照常玩，只是没有提示条）。
- 不改宿主样式、不读别的插件 DOM、不引入第三方运行时依赖。

## 目录

```
package.json          # dsh.bundle.patch + dsh.client（platform: web）
cordis.patch.yml      # 插入 Host 行 dsh-2048 → dsh-plugin-2048
lib/index.js          # Host 半：空壳 apply()，不发布 Service、不注册 Tool
lib/client.js         # 浏览器半：规则内核 + 成就表 + UI（手写 bundle，无构建步骤）
locale/{zh,en}.json   # 插件管理器里显示的标题 / 描述
icon.svg              # 插件图标
test/game.test.mjs    # 规则内核 + 成就判定单测
test/plugin.test.mjs  # 外壳自检：模块加载、槽位注册、文案完整性、清单字段
```

## 实现取舍

- **纯浏览器半**：棋盘、战绩、成就都是本地娱乐数据，没有进会话日志 / 工作区文件的理由。Host 半刻意留空，所以这个插件不会在任何会话、任何工作区里留下痕迹，也不吃 Host 启动时间。
- **不引构建**：客户端就是一份手写 bundle（`window.__ModuleLoader__.load`），改一行刷新即生效；仓库里没有 `src/` 和构建产物两份代码。
- **随机量可持久化**：内核用 mulberry32 并把 `rngState` 存进存档，所以「保存 → 关浏览器 → 打开继续」和一口气下完是同一盘棋；每日挑战也靠这个做到同一天同一副牌。
- **像素几何，不赌百分比**：格子和棋子的位置由 `ResizeObserver` 实测的格子尺寸算 `translate3d`，缩放侧边栏或窗口时不会出现 1px 错位。
- **游戏色板固定 + 亮色兜底**：棋盘与棋子是作品色（固定暖色，不跟主题走）；宿主亮色主题下 `--dsw-alias-bg-layer-1/2/3` 全是纯白、`border-l1` 只有 4% 黑，棋盘格和卡片会整片糊掉，所以亮色下额外用一组固定暖色描边/浅底补齐边界。
- **规则内核与 React 解耦**：`lib/client.js` 里用 `#region game-core` 圈出纯函数（随机数、发牌、合并、连击、终局判定、每日种子），单测直接从源码抽这一段跑，测的就是上线代码，不是复制品。

## 本地存档

| key | 内容 |
|---|---|
| `dsh2048.games.v3` | 每个尺寸（4–9）各一槽的当前对局 + 当前显示哪个尺寸（`{ active, boards: { "4": board, …, "9": board } }`） |
| `dsh2048.best.v2` | 各尺寸最高分 `{ "4": n, "5": m }` |
| `dsh2048.history.v1` | 最近 10 局战绩 |
| `dsh2048.achv.v1` | 已解锁成就与时间 |
| `dsh2048.daily.v1` | 每日挑战完成记录（按 日期:尺寸） |
| `dsh2048.sound.v1` | 音效开关 |

旧版的单棋盘存档（`dsh2048.board.v2` / `v1`）会读一次并升级进对应尺寸的槽；更早的 `dsh2048.best.v1` 会并入 4×4 最高分。

## 开发

```bash
node test/game.test.mjs    # 40 项：随机数、合并/连击、四方向对称、4–9 尺寸、终局、存档续局、切尺寸停表续局、成就、每尺寸 120 局随机对局不变量
node test/plugin.test.mjs  # 6 项：模块加载、双槽位注册、中英文案对齐、清单字段、locale 元数据

# 或一次跑两个
npm test
```

> 改 `lib/client.js` 后要让浏览器载入新的客户端代码，需要重装该 bundle 并重启 Harness
> （已安装的 bundle 只有在重启后才换成新的 JS 代码；HMR 只对首次安装生效）。

## 已知边界

- 存档按浏览器 origin 存在 `localStorage`，不跨设备、不跨浏览器、清缓存就没了。
- 每日挑战是本地种子，不做服务端校验、不排行；「同一天同一副牌」只在同版本 + 同尺寸 + 同一天内成立。
- 同一尺寸同一时间只有一局：**进出每日挑战**（或点「新局」）会替换掉该尺寸的槽，被替换的那局先记进战绩；切尺寸不会换局。
- 没有在线排行榜、没有 AI 对手。

## 许可

[MIT](LICENSE) © 2026 JJJACKsong
