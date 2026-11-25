/**
 * dsh-plugin-session-delete — Host 面。
 *
 * 在 `webServer` 上注册 exact 路由，供本插件自己的 Client 面调用，完成
 * “彻底删除一个会话”：
 *   1) 写租约探测（`sessionPersistence.open(id,'write')` 后立刻关闭）——
 *      同进程/跨进程仍持有写句柄的会话一律拒绝，绝不在别人写的时候动文件；
 *   2) 删除会话日志目录；
 *   3) 清理工作区登记（成员 / 固定 / 归档）；
 *   4) best-effort 删除投影缓存记录；
 *   5) 定时任务引用只告警，不修改用户数据；
 *   6) 追加审计日志。
 *
 * 会话仍在内存里（`sessions.get(id)` 非空）时删不掉：DSH 把打开过的对话常驻在
 * Host 进程里，没有空闲回收，归档也只是隐藏、不卸载。这种情况下把会话写进待删
 * 队列（`storages/session-delete/pending.json`），**下次启动、任何对话被激活之前**
 * 由 {@link drainPending} 真正删除 —— 那时 `sessions.get()` 还是空的。
 *
 * 为什么用 HTTP 路由：DSH 的持久化 seam、会话存储、工作区注册表都没有删除 API，
 * 第三方插件能拿到的 Host→Client 通道只有 webServer 路由（dshmarket 同款）。
 * 这条 exact 路由先于内置 `/api` 前缀围栏命中，所以安全校验全部在本地实现。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HttpError, isJsonContentType, isSameOrigin, readJsonBody, sendJson } from './lib/http.js'
import {
  ROUTE_PATH,
  ROUTE_PENDING_PATH,
  ROUTE_QUEUE_PATH,
  ROUTE_UNQUEUE_PATH,
  appendAudit,
  isValidSessionId,
  removeProjcacheRecords,
  removeSessionDir,
  scheduleReferences,
  sessionDirFor,
} from './lib/delete.js'
import {
  MAX_PENDING,
  bumpPending,
  enqueuePending,
  pendingEntry,
  pendingFilePath,
  readPending,
  removePending,
  sanitizeTitle,
  writePending,
} from './lib/pending.js'

const NAME = 'session-delete'
const MAX_BODY = 4096

function resolveHome(config) {
  return path.resolve(config?.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))
}

function resolveStoragesRoot(config, home) {
  return path.resolve(config?.storagesRoot || path.join(home, 'storages'))
}

function makeLogger(dir) {
  const file = path.join(dir, NAME + '.log')
  const write = (level, message) => {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(file, `[${new Date().toISOString()}] ${level} ${message}\n`)
    } catch { /* 日志失败不影响删除 */ }
  }
  return {
    file,
    info: (message) => write('INFO', message),
    warn: (message) => write('WARN', message),
    error: (message) => write('ERROR', message),
  }
}

function describeError(error) {
  if (error === null || error === undefined) return '未知错误'
  return String(error.message ?? error)
}

/** 按 `error.name` 判断持久化错误，避免 import 内置包（插件目录解析不到它们）。 */
function classifyOwnershipError(error) {
  const name = String(error?.name ?? '')
  const message = String(error?.message ?? '')
  if (name === 'SessionAlreadyOwnedError' || /already owned/i.test(message)) return 'owned'
  if (name === 'SessionPersistenceNotFoundError' || /not found/i.test(message)) return 'missing'
  if (name === 'SessionFormatUnsupportedError' || /format/i.test(name)) return 'unsupported'
  return 'unknown'
}

/** 写租约探测：能拿到写句柄说明没有别的活写者，拿到后立刻释放。 */
async function probeWriteLease(persistence, sessionId) {
  let handle
  try {
    handle = await persistence.open(sessionId, 'write')
  } catch (error) {
    return classifyOwnershipError(error)
  } finally {
    // eslint-disable-next-line no-unsafe-finally
    if (handle) {
      try {
        await handle.close()
      } catch { /* close 失败不影响结论 */ }
    }
  }
  return 'free'
}

/** 插件用到的全部路径，`apply` 时算一次。 */
function pathsFor(config) {
  const home = resolveHome(config)
  const storagesRoot = resolveStoragesRoot(config, home)
  const dir = path.join(storagesRoot, NAME)
  return {
    home,
    storagesRoot,
    dir,
    logFile: path.join(dir, NAME + '.log'),
    auditFile: path.join(dir, 'audit.log'),
    pendingFile: pendingFilePath(storagesRoot),
  }
}

function ok(value) {
  return { ok: true, value }
}

/** 结构化失败：HTTP 路由与启动清理共用同一套结果，不靠异常控制流程。 */
function fail(status, code, message) {
  return { ok: false, status, code, message }
}

/**
 * 尝试真正删除一个会话，返回结构化结果而不抛异常。
 *
 * 返回 `{ ok: true, value }`（value 与原 HTTP 响应体一致）或
 * `{ ok: false, status, code, message }`。`status` 只供 HTTP 路由映射状态码，
 * 启动清理只看 `code`。
 *
 * @param {{ get: (name: string) => any }} host 已注入服务的上下文
 * @param {string} sessionId 会话 id
 * @param {ReturnType<typeof pathsFor>} paths 插件路径
 * @param {{ info: Function, warn: Function, error: Function }} log 运行日志
 * @returns {Promise<{ ok: boolean, value?: object, status?: number, code?: string, message?: string }>}
 */
export async function attemptDelete(host, sessionId, paths, log) {
  const persistence = host.get('sessionPersistence')
  const registry = host.get('workspaceRegistry')
  const sessions = host.get('sessions')
  const warnings = []
  const workspaceIds = []

  let snapshot
  try {
    snapshot = await persistence.stat(sessionId)
  } catch (error) {
    if (classifyOwnershipError(error) === 'missing') snapshot = undefined
    else return fail(500, 'stat-failed', '读取会话信息失败：' + describeError(error))
  }

  // 常驻内存的会话删不掉：它的 Agent 还活着，删了文件也会被重新写回。
  // 这种情况不重试，交给待删队列，等下次启动再删。
  if (sessions?.get?.(sessionId) !== undefined) {
    return fail(409, 'session-live', '该对话正在使用中（已排队，重启 DeepSeek Harness 后删除）')
  }

  let logRemoved = false
  let sessionDir = null
  const location = snapshot?.location?.path
  if (typeof location === 'string' && location.length > 0) {
    sessionDir = sessionDirFor(location, sessionId)
    if (sessionDir === null) {
      return fail(500, 'unsafe-path', '拒绝删除：会话路径不符合预期（' + location + '）')
    }
    const lease = await probeWriteLease(persistence, sessionId)
    if (lease === 'owned') {
      return fail(409, 'session-owned', '该对话正被另一个 DeepSeek Harness 进程使用，请先关闭它')
    }
    try {
      await removeSessionDir(sessionDir)
      logRemoved = true
    } catch (error) {
      return fail(409, 'file-locked', '会话文件被占用，无法删除：' + describeError(error))
    }
  } else {
    warnings.push('no-materialized-log')
  }

  // 工作区登记：即使日志本来就缺失也照常清理，避免残留幽灵成员/固定/归档标记。
  if (registry) {
    try {
      for (const workspace of registry.list()) {
        if (!Array.isArray(workspace.sessionIds) || !workspace.sessionIds.includes(sessionId)) continue
        try {
          await workspace.detachSession(sessionId)
          workspaceIds.push(workspace.id)
        } catch (error) {
          warnings.push('detach-failed:' + workspace.id + ':' + describeError(error))
        }
      }
      try {
        await registry.unpinSession(sessionId)
      } catch (error) {
        warnings.push('unpin-failed:' + describeError(error))
      }
      try {
        await registry.unarchiveSession(sessionId)
      } catch (error) {
        warnings.push('unarchive-failed:' + describeError(error))
      }
    } catch (error) {
      warnings.push('workspace-cleanup-failed:' + describeError(error))
    }
  } else {
    warnings.push('workspace-registry-unavailable')
  }

  let projcacheRemoved = []
  try {
    projcacheRemoved = await removeProjcacheRecords(paths.storagesRoot, sessionId)
  } catch (error) {
    warnings.push('projcache-failed:' + describeError(error))
  }

  try {
    if (scheduleReferences(path.join(paths.storagesRoot, 'schedule.json'), sessionId)) {
      warnings.push('schedule-reference')
    }
  } catch { /* 读不到 schedule.json 就当没有引用 */ }

  const record = {
    at: new Date().toISOString(),
    sessionId,
    removed: { log: logRemoved, dir: sessionDir, projcache: projcacheRemoved },
    workspaces: workspaceIds,
    warnings,
  }
  if (!appendAudit(paths.auditFile, record)) warnings.push('audit-failed')
  log.info(`deleted ${sessionId} log=${logRemoved} projcache=${projcacheRemoved.length} warnings=${warnings.length}`)

  return ok({
    ok: true,
    sessionId,
    removed: {
      log: logRemoved,
      dir: sessionDir,
      projcache: projcacheRemoved.length,
    },
    warnings,
  })
}

// ---------------------------------------------------------------- 待删队列

/** 队列文件的读-改-写串行化：启动清理与 UI 请求可能同时改它。 */
let pendingLock = Promise.resolve()

function withPendingLock(task) {
  const run = pendingLock.then(task, task)
  pendingLock = run.then(() => undefined, () => undefined)
  return run
}

/**
 * 在锁内读最新队列、应用改动、原子写回。
 * @param {ReturnType<typeof pathsFor>} paths 插件路径
 * @param {(state: object) => { state: object } & Record<string, unknown>} mutate 改动函数
 */
function mutatePending(paths, mutate) {
  return withPendingLock(() => {
    const current = readPending(paths.pendingFile)
    const outcome = mutate(current)
    const state = outcome.state ?? current
    const written = writePending(paths.pendingFile, state)
    return { ...outcome, state, written }
  })
}

function queueRecord(paths, record) {
  if (!appendAudit(paths.auditFile, record)) return false
  return true
}

/**
 * 启动清理：删除队列里的会话。
 *
 * 必须在任何对话被打开**之前**跑 —— 那时 `sessions.get()` 为空，删除才能真正生效。
 * 单条失败（仍被别的进程写、文件被占用……）保留在队列里并记录 attempts，下次再试。
 *
 * @param {{ get: (name: string) => any }} host 已注入服务的上下文
 * @param {ReturnType<typeof pathsFor>} paths 插件路径
 * @param {{ info: Function, warn: Function, error: Function }} log 运行日志
 * @returns {Promise<{ attempted: number, deleted: number, kept: number }>}
 */
export async function drainPending(host, paths, log) {
  const initial = readPending(paths.pendingFile)
  if (initial.items.length === 0) return { attempted: 0, deleted: 0, kept: 0 }
  log.info(`startup drain: ${initial.items.length} queued session(s)`)

  let deleted = 0
  let kept = 0
  for (const item of initial.items.slice()) {
    let outcome
    try {
      outcome = await attemptDelete(host, item.sessionId, paths, log)
    } catch (error) {
      outcome = fail(500, 'internal', describeError(error))
    }
    if (outcome.ok) {
      deleted += 1
      const removal = await mutatePending(paths, (state) => removePending(state, item.sessionId))
      if (!removal.written) log.warn(`startup drain: could not rewrite queue after deleting ${item.sessionId}`)
      queueRecord(paths, {
        at: new Date().toISOString(),
        action: 'startup-delete',
        sessionId: item.sessionId,
        title: item.title,
        removed: outcome.value.removed,
        warnings: outcome.value.warnings,
      })
      continue
    }
    kept += 1
    const current = pendingEntry(readPending(paths.pendingFile), item.sessionId)
    const attempts = (current?.attempts ?? item.attempts ?? 0) + 1
    const bump = await mutatePending(paths, (state) => bumpPending(state, item.sessionId, {
      attempts,
      lastCode: outcome.code ?? 'unknown',
      lastError: outcome.message ?? '',
    }))
    if (!bump.written) log.warn(`startup drain: could not record failure for ${item.sessionId}`)
    log.warn(`startup drain: kept ${item.sessionId} (${outcome.code}: ${outcome.message})`)
  }

  log.info(`startup drain finished: deleted=${deleted} kept=${kept}`)
  return { attempted: initial.items.length, deleted, kept }
}

// ---------------------------------------------------------------- HTTP

async function readActionBody(request) {
  if (request.method !== 'POST') {
    throw new HttpError(405, 'method-not-allowed', '只接受 POST')
  }
  if (!isSameOrigin(request.headers)) {
    throw new HttpError(403, 'cross-origin', '拒绝跨站请求')
  }
  if (!isJsonContentType(request.headers)) {
    throw new HttpError(415, 'unsupported-media-type', 'Content-Type 必须是 application/json')
  }
  return readJsonBody(request, MAX_BODY)
}

function requireSessionId(body) {
  const sessionId = body?.sessionId
  if (!isValidSessionId(sessionId)) {
    throw new HttpError(400, 'invalid-session', '会话 id 不合法')
  }
  return sessionId
}

async function handleDelete(host, paths, log, request, response) {
  const sessionId = requireSessionId(await readActionBody(request))
  const outcome = await attemptDelete(host, sessionId, paths, log)
  if (outcome.ok) {
    sendJson(response, 200, outcome.value)
    return
  }
  sendJson(response, outcome.status, { ok: false, code: outcome.code, message: outcome.message })
}

async function handleQueue(paths, log, request, response) {
  const body = await readActionBody(request)
  const sessionId = requireSessionId(body)
  const title = sanitizeTitle(body?.title) || sessionId
  const { state, added, written } = await mutatePending(paths, (current) => enqueuePending(current, { sessionId, title }))
  if (!written) {
    throw new HttpError(500, 'queue-failed', '无法写入待删队列：' + paths.pendingFile)
  }
  if (state.items.length > MAX_PENDING) log.warn(`pending queue over ${MAX_PENDING}; dropped oldest`)
  log.info(`queued ${sessionId} added=${added} size=${state.items.length}`)
  queueRecord(paths, { at: new Date().toISOString(), action: 'queue', sessionId, title, added })
  sendJson(response, 200, { ok: true, sessionId, added, items: state.items })
}

async function handleUnqueue(paths, log, request, response) {
  const sessionId = requireSessionId(await readActionBody(request))
  const { removed, written } = await mutatePending(paths, (current) => removePending(current, sessionId))
  if (!written) {
    throw new HttpError(500, 'queue-failed', '无法写入待删队列：' + paths.pendingFile)
  }
  if (removed) {
    log.info(`unqueued ${sessionId}`)
    queueRecord(paths, { at: new Date().toISOString(), action: 'unqueue', sessionId })
  }
  sendJson(response, 200, { ok: true, sessionId, removed })
}

async function handlePending(paths, request, response) {
  const body = await readActionBody(request)
  const state = readPending(paths.pendingFile)
  const sessionId = body?.sessionId
  const items = isValidSessionId(sessionId)
    ? state.items.filter((item) => item.sessionId === sessionId)
    : state.items
  sendJson(response, 200, { ok: true, items })
}

/** 把处理器包成「永不抛出」的响应函数：HttpError → 状态码，其余 → 500。 */
function serving(log, label, handler) {
  return (request, response) => {
    void (async () => {
      try {
        await handler(request, response)
      } catch (error) {
        if (error instanceof HttpError) {
          sendJson(response, error.status, { ok: false, code: error.code, message: error.message })
          return
        }
        log.error(label + ' failed: ' + describeError(error))
        sendJson(response, 500, { ok: false, code: 'internal', message: '操作失败：' + describeError(error) })
      }
    })()
  }
}

export function apply(ctx, config = {}) {
  const paths = pathsFor(config)
  const log = makeLogger(paths.dir)
  log.info(`plugin started (home=${paths.home}, storages=${paths.storagesRoot})`)

  const routes = [
    { label: 'delete', path: ROUTE_PATH, handler: (host, request, response) => handleDelete(host, paths, log, request, response) },
    { label: 'queue', path: ROUTE_QUEUE_PATH, handler: (_host, request, response) => handleQueue(paths, log, request, response) },
    { label: 'unqueue', path: ROUTE_UNQUEUE_PATH, handler: (_host, request, response) => handleUnqueue(paths, log, request, response) },
    { label: 'pending', path: ROUTE_PENDING_PATH, handler: (_host, request, response) => handlePending(paths, request, response) },
  ]

  ctx.inject(['webServer', 'sessionPersistence', 'workspaceRegistry', 'sessions'], (host) => {
    // 顺序很重要：清理必须早于 UI 打开任何对话。这里在插件启动时立刻发起，
    // 此时还没有任何 Agent 被激活，`sessions.get()` 为空，队列里的会话能真正删掉。
    void drainPending(host, paths, log).catch((error) => {
      log.error('startup drain failed: ' + describeError(error))
    })

    for (const route of routes) {
      host.effect(() => host.webServer.register({
        kind: 'exact',
        path: route.path,
        handler: serving(log, route.label, (request, response) => route.handler(host, request, response)),
      }), 'session-delete: ' + route.label + ' route')
    }
  })
}

export const inject = []
export const name = NAME
