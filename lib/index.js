/**
 * dsh-plugin-2048 — Host 半（空壳）。
 *
 * 这个插件全部活在浏览器里：棋盘状态只写 localStorage，不碰会话日志、不碰工作区文件、
 * 不发布 Service、不注册 Tool。Host 侧只需要一行 apply()，让 bundle 有一个可激活的宿主行。
 */
export function apply() {}
