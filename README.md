# dsh-plugin-2048 · 等 agent 的 2048

**DeepSeek Harness（dsh）的侧边栏小游戏插件：主区整页棋盘，专门用来消磨「等 agent 跑完」的那几分钟。**

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.1.5--rc.2-4f8ef7.svg)](#兼容性)
[![platform](https://img.shields.io/badge/platform-web%20ui-e8912a.svg)](#兼容性)

> **English**: A 2048 game for DeepSeek Harness. It adds one sidebar icon that opens a full-page
> board in the main column: arrow keys / WASD / swipe, up to 30 undos, board and best score persisted
> in `localStorage`. The Host half is an empty `apply()` — no services, no tools, no session writes,
> no workspace files. UI uses the host's `--dsw-alias-*` theme tokens, so it follows light/dark.

---

## 为什么做这个

dsh 里一个 agent 跑长任务，人只能等。切出去开网页游戏又会把上下文和注意力一起带走。

所以做成插件：**入口就在左边栏**，跟「技能流」「插件」「定时任务」并排；点开是主区整页，不弹窗、不抢焦点、不占会话。agent 跑完了消息照常进来，切回会话就继续。

## 长什么样

```
┌──────────────────────────────────────────────┐
│  侧边栏           │        主区（整页）      │
│  …                │   ▦ 2048                  │
│  ▣ 插件           │   agent 还在跑？先来一局  │
│  ◷ 定时任务       │        ┌────┬────┬────┐   │
│  ◫ 技能流         │   得分 │ 最高│ 步数│     │
│  ▦ 2048  ← 新增   │        └────┴────┴────┘   │
│  …                │    ┌───┬───┬───┬───┐      │
│                   │    │ 2 │   │ 4 │   │      │
│                   │    ├───┼───┼───┼───┤      │
│                   │    │   │ 8 │   │ 2 │      │
│                   │    ├───┼───┼───┼───┤      │
│                   │    │16 │   │ 4 │   │      │
│                   │    ├───┼───┼───┼───┤      │
│                   │    │   │ 2 │   │ 8 │      │
│                   │    └───┴───┴───┴───┘      │
│                   │   ↑↓←→/WASD 移动  [撤销][新局]│
└──────────────────────────────────────────────┘
```

## 玩法

- **移动**：方向键、`W A S D`、`Vim HJKL`；触屏直接在棋盘上滑动。
- **撤销**：最多回退 30 步（按钮或终局浮层里都能撤），最高分不回退。
- **存档**：棋盘、分数、步数、最高分都写 `localStorage`，关掉 Harness 再开能接着玩。
- **结算**：合出 2048 弹一个「**注意力惊人！**」小菜单（继续玩、往 4096 堆）；走不动了弹「**注意力涣散！**」宣告这局结束，菜单里能直接撤销或重开。两者都是只盖住棋盘的小卡片，不是全屏弹窗。
- **动画**：棋子滑动、新子弹出、合并 pop、无效方向轻微抖一下；`prefers-reduced-motion` 下全部关掉。

## 安装

**从 npm（推荐）**：

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

卸载 / 暂停：用插件管理器的开关或 `plugin_manager` 的 `set_bundle` / `remove_bundle`。

## 兼容性

- 需要 dsh `>= 0.1.5-rc.2`（`engines.dsh`）。
- 只做 **Web UI**（`dsh.client.platform: "web"`）——桌面版即 Web UI；不提供终端 / TUI 界面。
- 依赖的宿主 Client 包只有 locale（`dsh.client.inject`），其余全是原生 React + 主题变量，不改宿主样式、不读别的插件 DOM。

## 目录

```
package.json          # dsh.bundle.patch + dsh.client（platform: web）
cordis.patch.yml      # 插入 Host 行 dsh-2048 → dsh-plugin-2048
lib/index.js          # Host 半：空壳 apply()，不发布 Service、不注册 Tool
lib/client.js         # 浏览器半：规则内核 + UI（手写 bundle，无构建步骤）
locale/{zh,en}.json   # 插件管理器里显示的标题 / 描述
icon.svg              # 插件图标
test/game.test.mjs    # 规则内核单测
```

## 实现取舍

- **纯浏览器半**：棋盘是本地娱乐数据，没有进会话日志 / 工作区文件的理由。Host 半刻意留空，所以这个插件不会在任何会话、任何工作区里留下痕迹，也不吃 Host 启动时间。
- **不引构建**：客户端就是一份手写 bundle（`window.__ModuleLoader__.load`），改一行刷新即生效；仓库里没有 `src/` 和构建产物两份代码。
- **像素几何，不赌百分比**：格子和棋子的位置由 `ResizeObserver` 实测的格子尺寸算 `translate3d`，缩放侧边栏或窗口时不会出现 1px 错位；CSS 里只留过渡与动画。
- **主题变量优先**：容器、按钮、浮层一律 `--dsw-alias-*`（带兜底值），只有棋子本身用固定的暖色——那是游戏美术，不跟主题走。
- **规则内核与 React 解耦**：`lib/client.js` 里用 `#region game-core` 圈出纯函数（发牌、合并、终局判定），单测直接从源码抽这一段跑，测的就是上线代码，不是复制品。

## 开发

```bash
node test/game.test.mjs   # 24 项：合并规则、四方向对称、终局与通关标记、发牌比例、600 局随机对局不变量

# 或
npm test
```

> 改 `lib/client.js` 后要让浏览器载入新的客户端代码，需要重装该 bundle 并重启 Harness
> （已安装的 bundle 只有在重启后才换成新的 JS 代码；HMR 只对首次安装生效）。

## 已知边界

- 存档按浏览器 origin 存在 `localStorage`，不跨设备、不跨浏览器、清缓存就没了。
- 没有排行榜、没有音效、没有 AI 对手——用途就是打发等待时间。

## 许可

[MIT](LICENSE) © 2026 JJJACKsong
