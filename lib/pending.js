/**
 * dsh-plugin-session-delete — 待删队列（tombstone）。
 *
 * 为什么需要：DSH 把打开过的对话常驻在内存里（`sessions.get(id)` 非空），
 * 而且没有任何空闲回收 —— 归档只隐藏、不卸载，`sessions.enter()` 进去的会话
 * 要等整个 Host 进程结束才消失。所以「正在使用中」的对话在本次运行里根本删不掉，
 * 只能记下来，等下次启动、任何对话被打开之前再删。
 *
 * 这里只放可独立测试的部分：读写与增删。真正触发删除的是 index.js 的启动清理。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 队列文件格式版本；不认识的版本按空队列处理。 */
export const PENDING_VERSION = 1

/** 队列上限：超过时保留最近加入的条目，避免文件无限增长。 */
export const MAX_PENDING = 500

/** 标题只用于提示，截断到 120 字符并去掉控制字符。 */
export const MAX_TITLE = 120

/** 队列文件位置：`<storages>/session-delete/pending.json`。 */
export function pendingFilePath(storagesRoot) {
  return path.join(path.resolve(storagesRoot), 'session-delete', 'pending.json')
}

/** 空队列。 */
export function emptyPending() {
  return { version: PENDING_VERSION, items: [] }
}

export function sanitizeTitle(value) {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)
}

function normalizeItem(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const sessionId = raw.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  const item = {
    sessionId,
    title: sanitizeTitle(raw.title) || sessionId,
    at: typeof raw.at === 'string' ? raw.at : new Date().toISOString(),
  }
  if (Number.isFinite(raw.attempts) && raw.attempts > 0) item.attempts = Math.floor(raw.attempts)
  if (typeof raw.lastCode === 'string') item.lastCode = raw.lastCode
  if (typeof raw.lastError === 'string') item.lastError = raw.lastError.slice(0, 300)
  return item
}

/** 把任意读入值收敛成合法队列（去重、丢弃坏条目、按上限截断）。 */
export function normalizePending(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return emptyPending()
  if (raw.version !== PENDING_VERSION || !Array.isArray(raw.items)) return emptyPending()
  const seen = new Set()
  const items = []
  for (const entry of raw.items) {
    const item = normalizeItem(entry)
    if (item === null || seen.has(item.sessionId)) continue
    seen.add(item.sessionId)
    items.push(item)
  }
  return { version: PENDING_VERSION, items: items.slice(-MAX_PENDING) }
}

/**
 * 读取队列。文件缺失返回空队列；文件损坏时把它改名留档（`pending.json.corrupt-<时间>`）
 * 再返回空队列，绝不让一个坏文件卡住插件启动。
 */
export function readPending(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return emptyPending()
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    try { fs.renameSync(file, file + '.corrupt-' + Date.now()) } catch { /* 留档失败也不影响启动 */ }
    return emptyPending()
  }
  return normalizePending(parsed)
}

/** 原子写入（同目录临时文件 + rename），返回是否成功。 */
export function writePending(file, state) {
  const normalized = normalizePending(state)
  const body = JSON.stringify(normalized, null, 2) + '\n'
  const tmp = file + '.tmp-' + process.pid
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, body)
    fs.renameSync(tmp, file)
    return true
  } catch {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 清理失败忽略 */ }
    return false
  }
}

/** 找到某会话的队列条目。 */
export function pendingEntry(state, sessionId) {
  return normalizePending(state).items.find((item) => item.sessionId === sessionId)
}

/**
 * 加入队列（同一会话只保留一条，已有则原样返回）。
 * @returns {{ state: object, added: boolean }}
 */
export function enqueuePending(state, entry) {
  const current = normalizePending(state)
  const existing = current.items.find((item) => item.sessionId === entry.sessionId)
  if (existing !== undefined) return { state: current, added: false }
  const item = normalizeItem({
    sessionId: entry.sessionId,
    title: entry.title,
    at: entry.at ?? new Date().toISOString(),
  })
  if (item === null) return { state: current, added: false }
  return { state: { version: PENDING_VERSION, items: [...current.items, item].slice(-MAX_PENDING) }, added: true }
}

/** 从队列移除某会话。 */
export function removePending(state, sessionId) {
  const current = normalizePending(state)
  const items = current.items.filter((item) => item.sessionId !== sessionId)
  return { state: { version: PENDING_VERSION, items }, removed: items.length !== current.items.length }
}

/** 更新某会话条目的失败信息（attempts / lastCode / lastError），不存在则原样返回。 */
export function bumpPending(state, sessionId, patch) {
  const current = normalizePending(state)
  let found = false
  const items = current.items.map((item) => {
    if (item.sessionId !== sessionId) return item
    found = true
    return normalizeItem({ ...item, ...patch }) ?? item
  })
  return { state: { version: PENDING_VERSION, items }, found }
}
