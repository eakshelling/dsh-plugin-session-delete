# 删除对话（dsh-plugin-session-delete）

右键侧栏里的任意对话（或对话标题栏的面包屑），菜单里会多出一条红色的 **删除对话**。
确认后，该对话会被**彻底删除**：会话日志文件、投影缓存、工作区中的会话登记（成员 / 固定 / 归档）一并清掉。

如果这条对话**本次运行里打开过**（DSH 把它常驻在内存里），本次删不了 —— 插件会把它记进待删队列，
下次**完全重启** DSH、在任何对话被打开之前自动删掉。

## 为什么需要它

DSH 自带的会话菜单只有「固定 / 重命名 / 分叉 / 复制 ID / 归档」。
会话持久化（`sessionPersistence`）、会话存储（`sessions`）、工作区注册表（`workspaceRegistry`）都没有删除 API，
归档也只是把会话藏起来，日志仍留在磁盘上。本插件补上这块能力。

## 删除时发生了什么

Host 面（`index.js`）在 `webServer` 上注册 4 条 **exact** 路由，Client 面（`client.js`）按下述流程调用：

| 路由 | 用途 |
| --- | --- |
| `POST /dsh-session-delete/delete` | 立刻删除 |
| `POST /dsh-session-delete/queue` | 加入待删队列 |
| `POST /dsh-session-delete/unqueue` | 取消排队 |
| `POST /dsh-session-delete/pending` | 查询队列（带 `sessionId` 时只返回该条） |

`delete` 按顺序做：

1. **定位**：`sessionPersistence.stat(id)` 取出日志工件路径。
2. **存活检查**：会话仍在内存里（`sessions.get(id)`）→ `409 session-live`（客户端随即改为排队，见下节）。
3. **路径守卫**：只删「会话 id 目录」本身，且要求 `basename(dirname(log)) === sessionId`、绝对路径、非根目录，否则 `500 unsafe-path`。
4. **写租约探测**：`open(id,'write')` 后立刻 `close()`。同进程或跨进程仍有写者时得到 `409 session-owned`，**绝不在别人写的时候动文件**。
5. **删日志**：`fs.rm(dir, { recursive: true, force: true, maxRetries: 3 })`；被占用 → `409 file-locked`。
6. **清工作区登记**：对包含该会话的工作区 `detachSession`，再 `unpinSession`、`unarchiveSession`。
   工作区 feed 会把 `removed` 帧推给客户端，侧栏随之更新。
7. **清投影缓存**：删 `<storages>/session_projcache/sessions/<id>.json` 及 `<id>.json.bak.*`（best-effort）。
8. **定时任务引用只告警**：`<storages>/schedule.json` 里若还有 `involvedSessionIds` 引用，写进 `warnings`，**不改用户数据**。
9. **审计**：追加一行 JSON 到 `<storages>/session-delete/audit.log`，运行日志在同目录 `session-delete.log`。

附件库 `~/.dsh/attachments` 是内容寻址的共享对象，不按会话归属，**不会删**。
`dsh-context` 的上下文缓存是第三方派生缓存，残留无害，也不动。

## 对话正在使用时（待删队列）

打开过的对话在 DSH 里是**常驻内存**的：UI 打开对话时发的 `session.follow({ activate: true })`
会把会话 `sessions.enter()` 进 Host 的 store，而 Host 没有空闲回收 —— 归档（`archiveSession`）
只是打标记、停掉正在跑的轮次，**不会卸载会话**，所以 `sessions.get(id)` 一直是活的，
重试多少次都删不掉。

因此遇到 `409 session-live` 时插件不再重试、也不归档，而是：

1. `POST /dsh-session-delete/queue` 把 `{ sessionId, title, at }` 写进
   `<storages>/session-delete/pending.json`（临时文件 + rename 原子写，损坏文件改名 `.corrupt-<ts>` 留档）；
2. 对话框切成「已排队，重启后删除」，可以当场**取消排队**；
3. 下次 Host 启动时，`apply()` 在 `ctx.inject(...)` 回调里、注册路由之前就发起 `drainPending()` ——
   此刻 `sessions.get()` 还是空的，队列里的会话能被真正删除；
4. 单条仍失败（被别的进程写、文件被占用）就留在队列里，记 `attempts` / `lastCode` / `lastError`，下次再试。

`file-locked` 仍保留一次 400ms 重试（杀毒/索引的瞬时占用），`session-live` 绝不重试。

## 安装

插件以工作区 bundle 形式交付（`dsh.bundle.patch` + `cordis.patch.yml`）：

```text
plugins/dsh-plugin-session-delete/
  package.json         # dsh-plugin-session-delete
  cordis.patch.yml     # - insert: [{ id: session-delete, name: 'dsh-plugin-session-delete' }]
  index.js             # Host：HTTP 路由 + 删除流程 + 启动清理
  lib/http.js          # 同源/JSON/体积校验、JSON 响应
  lib/delete.js        # 路径守卫、目录删除、投影缓存/定时任务/审计
  lib/pending.js       # 待删队列的读写与增删（纯逻辑，可单测）
  client.js            # Client：右键菜单项 + 确认框 + 排队提示 + toast
  locale/{zh,en}.json  # 插件管理页标题/描述
  icon.svg
  test/cleanup.test.mjs
  test/pending.test.mjs
  test/host.test.mjs
  test/client.test.mjs
```

用 `plugin_manager install_bundle` 安装（传绝对路径，或 `link:<绝对路径>`），然后**完全重启 DSH**（Host 路由与 bundle 需要重启才生效）。

## 安全模型

这条 exact 路由先于内置 `/api` 前缀围栏命中，所以校验全部在插件内完成：

- 只接受 `POST` + `application/json`；
- 有 `Origin` 时必须与 `Host` 一致，`Sec-Fetch-Site` 只接受 `same-origin` / `none`；
- 请求体上限 4 KiB，只认 `session-[A-Za-z0-9._-]{1,190}` 形状的 id；
- 只删路径守卫确认过的会话目录，不做通配、不递归到工作区。

## 已知边界

- 队列**只在 Host 启动时消费**：排完队不重启，对话就一直留在那里（队列文件可随时手动查看/删除）。
- 服务端没有跨进程「强制停止会话」的能力：别的 DSH 进程正持有写句柄时，只能提示 `session-owned`。
- 投影缓存按文件路径删除（`DomainFacility` 不支持按名字复用已开 domain），若缓存后端不是 JSON 文件，则跳过并只留 warning。
- 定时任务里的历史引用不会自动改，需要用户自行处理。
- 菜单文案用插件自带字典（zh/en），不接入 Harness 的 locale 命名空间。

## 开发

```bash
node test/cleanup.test.mjs   # 路径守卫、投影缓存、HTTP 校验、审计
node test/pending.test.mjs   # 队列读写：去重、上限、损坏文件、原子写
node test/host.test.mjs      # 假 host 集成：live 拒绝、真删、启动清理
node test/client.test.mjs    # 冒烟：菜单项 / 图标槽 / overlay 注册
```

注意：在本机沙箱里 `node --test test/` 会因测试运行器 spawn 子进程触发 `spawn EPERM`，直接用 node 跑测试文件即可。

## 验证

1. 完全重启 DSH（Host 在 Loader 条目启动时读取 `dsh.client.inject`，装完再改 manifest 需要条目重启）；
2. 在侧栏**右键任意对话**（或标题栏面包屑）→ 菜单末尾出现红色「删除对话」；
3. 点它 → 确认框列出将要删除的内容 → 点「删除对话」；
4. 若这条对话本次运行里打开过：对话框显示「已排队，重启后删除」，`~/.dsh/storages/session-delete/pending.json` 里出现该会话；
5. 完全退出（含托盘）再启动 DSH，`session-delete.log` 出现 `startup drain finished: deleted=1 kept=0`，
   对话与 `~/.dsh/sessions/<项目>/session-<id>/` 一起消失，`audit.log` 里是 `"action":"startup-delete"`。
