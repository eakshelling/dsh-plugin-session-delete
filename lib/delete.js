/**
 * dsh-plugin-session-delete — 纯逻辑与文件清理。
 *
 * 这里只放可独立测试的部分：会话 id 校验、会话目录守卫、投影缓存清理、定时任务
 * 引用探测。真正的编排（租约探测、工作区登记、审计）在 index.js，因为它依赖
 * DSH 的服务对象。
 */
import fs from 'node:fs'
import path from 'node:path'

/** Host 路由路径。客户端按 document.baseURI 解析后 POST 到这里。 */
export const ROUTE_PATH = '/dsh-session-delete/delete'

/** 把「正在使用中、本次删不掉」的会话加入待删队列。 */
export const ROUTE_QUEUE_PATH = '/dsh-session-delete/queue'

/** 取消排队。 */
export const ROUTE_UNQUEUE_PATH = '/dsh-session-delete/unqueue'

/** 查询队列（带 sessionId 时只返回该条）。 */
export const ROUTE_PENDING_PATH = '/dsh-session-delete/pending'

/** DSH 的会话 id 形如 `session-<uuid>`；编码段只含 `[A-Za-z0-9._-]`。 */
export const SESSION_ID_PATTERN = /^session-[A-Za-z0-9._-]{1,190}$/

export function isValidSessionId(value) {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
}

function escapeForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 由持久化 artifact 路径推出会话目录，并校验“目录名就是会话 id”。
 * 任何不符合预期的形状都返回 null——调用方必须据此拒绝删除。
 * @param {string} locationPath `sessionPersistence.stat(id)` 给出的绝对路径
 * @param {string} sessionId 会话 id
 * @returns {string | null} 可删除的会话目录
 */
export function sessionDirFor(locationPath, sessionId) {
  if (typeof locationPath !== 'string' || locationPath.length === 0) return null
  if (!path.isAbsolute(locationPath)) return null
  if (!isValidSessionId(sessionId)) return null
  const dir = path.dirname(locationPath)
  if (path.basename(dir) !== sessionId) return null
  if (path.dirname(dir) === dir) return null
  return dir
}

/** 投影缓存的 per-record 目录：`<storages>/session_projcache/sessions`。 */
export function projcacheDir(storagesRoot) {
  return path.join(path.resolve(storagesRoot), 'session_projcache', 'sessions')
}

/**
 * 删除某个会话的投影缓存记录（`<id>.json` 以及备份 `<id>.json.bak.*`）。
 * 投影缓存是派生数据，失败不影响主流程，因此这里逐个 best-effort。
 * @returns {Promise<string[]>} 实际删除的文件
 */
export async function removeProjcacheRecords(storagesRoot, sessionId) {
  if (!isValidSessionId(sessionId)) return []
  const dir = projcacheDir(storagesRoot)
  let names
  try {
    names = await fs.promises.readdir(dir)
  } catch {
    return []
  }
  const pattern = new RegExp('^' + escapeForRegExp(sessionId) + '\\.json(\\..*)?$')
  const removed = []
  for (const name of names) {
    if (!pattern.test(name)) continue
    const file = path.join(dir, name)
    try {
      await fs.promises.rm(file, { force: true })
      removed.push(file)
    } catch { /* 派生数据，删不掉就留着 */ }
  }
  return removed
}

/**
 * 定时任务里是否还引用该会话。`schedule.json` 的 `involvedSessionIds` 只是历史
 * 元数据，插件只告警、不修改用户的定时任务。
 */
export function scheduleReferences(schedulePath, sessionId) {
  try {
    return fs.readFileSync(schedulePath, 'utf8').includes(sessionId)
  } catch {
    return false
  }
}

/** 删除会话自己的日志目录（一个会话目录只归一个会话所有）。 */
export async function removeSessionDir(dir) {
  await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

/** 以原子追加方式写一条审计记录；失败静默（审计不能拖垮删除本身）。 */
export function appendAudit(auditFile, record) {
  try {
    fs.mkdirSync(path.dirname(auditFile), { recursive: true })
    fs.appendFileSync(auditFile, JSON.stringify(record) + '\n')
    return true
  } catch {
    return false
  }
}
