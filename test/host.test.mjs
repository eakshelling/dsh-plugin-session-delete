/**
 * Host 面的集成测试：用假 host（只实现插件真正调用的那几个方法）验证
 *   - live 会话被拒绝且磁盘不变；
 *   - 非 live 会话被真正删除（目录、投影缓存、工作区登记、审计）；
 *   - 写租约被他人持有时按 session-owned 拒绝；
 *   - 启动清理删除成功项、保留失败项并记录 attempts。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply, attemptDelete, drainPending } from '../index.js'
import { emptyPending, enqueuePending, pendingFilePath, readPending, writePending } from '../lib/pending.js'
import { ROUTE_PATH, ROUTE_PENDING_PATH, ROUTE_QUEUE_PATH, ROUTE_UNQUEUE_PATH } from '../lib/delete.js'

/** 安静日志，同时把内容留在内存里供断言。 */
function fakeLog() {
  const lines = []
  return {
    lines,
    info: (message) => lines.push('INFO ' + message),
    warn: (message) => lines.push('WARN ' + message),
    error: (message) => lines.push('ERROR ' + message),
  }
}

function setup({ live = new Set(), openError = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-delete-host-'))
  const storagesRoot = path.join(root, 'storages')
  const sessionsRoot = path.join(root, 'sessions')
  const calls = { detach: [], unpin: [], unarchive: [] }

  const paths = {
    home: root,
    storagesRoot,
    dir: path.join(storagesRoot, 'session-delete'),
    logFile: path.join(storagesRoot, 'session-delete', 'session-delete.log'),
    auditFile: path.join(storagesRoot, 'session-delete', 'audit.log'),
    pendingFile: pendingFilePath(storagesRoot),
  }

  function materialize(sessionId) {
    const dir = path.join(sessionsRoot, sessionId)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'session.jsonl')
    fs.writeFileSync(file, '{"type":"user"}\n')
    const projcache = path.join(storagesRoot, 'session_projcache', 'sessions')
    fs.mkdirSync(projcache, { recursive: true })
    fs.writeFileSync(path.join(projcache, sessionId + '.json'), '{}')
    return { dir, file }
  }

  const located = new Map()

  const host = {
    get(name) {
      if (name === 'sessionPersistence') {
        return {
          stat: async (sessionId) => {
            const entry = located.get(sessionId)
            return entry ? { location: { path: entry.file } } : { location: {} }
          },
          open: async () => {
            if (openError) throw openError
            return { close: async () => undefined }
          },
        }
      }
      if (name === 'workspaceRegistry') {
        return {
          list: () => [{
            id: 'ws-1',
            sessionIds: [...located.keys()],
            detachSession: async (sessionId) => { calls.detach.push(sessionId) },
          }],
          unpinSession: async (sessionId) => { calls.unpin.push(sessionId) },
          unarchiveSession: async (sessionId) => { calls.unarchive.push(sessionId) },
        }
      }
      if (name === 'sessions') {
        return { get: (sessionId) => (live.has(sessionId) ? { id: sessionId } : undefined) }
      }
      return undefined
    },
  }

  return { root, paths, host, calls, live, materialize, located }
}

test('live 会话直接拒绝，磁盘与审计都不动', async () => {
  const env = setup()
  const sessionId = 'session-live-1'
  const { dir } = env.materialize(sessionId)
  env.located.set(sessionId, { file: path.join(dir, 'session.jsonl') })
  env.live.add(sessionId)

  const outcome = await attemptDelete(env.host, sessionId, env.paths, fakeLog())

  assert.equal(outcome.ok, false)
  assert.equal(outcome.status, 409)
  assert.equal(outcome.code, 'session-live')
  assert.equal(fs.existsSync(dir), true)
  assert.equal(fs.existsSync(env.paths.auditFile), false)
})

test('非 live 会话被真正删除并清理工作区登记', async () => {
  const env = setup()
  const sessionId = 'session-dead-1'
  const { dir } = env.materialize(sessionId)
  env.located.set(sessionId, { file: path.join(dir, 'session.jsonl') })

  const log = fakeLog()
  const outcome = await attemptDelete(env.host, sessionId, env.paths, log)

  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  assert.deepEqual(outcome.value.removed, { log: true, dir, projcache: 1 })
  assert.equal(fs.existsSync(dir), false)
  assert.deepEqual(env.calls.detach, [sessionId])
  assert.deepEqual(env.calls.unpin, [sessionId])
  assert.deepEqual(env.calls.unarchive, [sessionId])

  const audit = fs.readFileSync(env.paths.auditFile, 'utf8').trim().split('\n')
  assert.equal(audit.length, 1)
  assert.equal(JSON.parse(audit[0]).sessionId, sessionId)
})

test('写句柄被另一个进程持有时按 session-owned 拒绝', async () => {
  const env = setup({ openError: Object.assign(new Error('already owned'), { name: 'SessionAlreadyOwnedError' }) })
  const sessionId = 'session-owned-1'
  const { dir } = env.materialize(sessionId)
  env.located.set(sessionId, { file: path.join(dir, 'session.jsonl') })

  const outcome = await attemptDelete(env.host, sessionId, env.paths, fakeLog())

  assert.equal(outcome.ok, false)
  assert.equal(outcome.status, 409)
  assert.equal(outcome.code, 'session-owned')
  assert.equal(fs.existsSync(dir), true)
})

test('启动清理删除可删项、保留 live 项并记录 attempts', async () => {
  const env = setup()
  const dead = 'session-dead-2'
  const live = 'session-live-2'
  for (const sessionId of [dead, live]) {
    const { dir } = env.materialize(sessionId)
    env.located.set(sessionId, { file: path.join(dir, 'session.jsonl') })
  }
  env.live.add(live)

  let state = emptyPending()
  state = enqueuePending(state, { sessionId: dead, title: 'dead' }).state
  state = enqueuePending(state, { sessionId: live, title: 'live' }).state
  assert.equal(writePending(env.paths.pendingFile, state), true)

  const log = fakeLog()
  const result = await drainPending(env.host, env.paths, log)

  assert.deepEqual(result, { attempted: 2, deleted: 1, kept: 1 })
  assert.equal(fs.existsSync(path.join(env.root, 'sessions', dead)), false)
  assert.equal(fs.existsSync(path.join(env.root, 'sessions', live)), true)

  const remaining = readPending(env.paths.pendingFile)
  assert.deepEqual(remaining.items.map((item) => item.sessionId), [live])
  assert.equal(remaining.items[0].attempts, 1)
  assert.equal(remaining.items[0].lastCode, 'session-live')
})

test('apply 注册 4 条 exact 路由，并在启动时先消费队列', async () => {
  const env = setup()
  const sessionId = 'session-dead-3'
  const { dir } = env.materialize(sessionId)
  env.located.set(sessionId, { file: path.join(dir, 'session.jsonl') })
  const queued = enqueuePending(emptyPending(), { sessionId, title: 'queued' }).state
  assert.equal(writePending(pendingFilePath(env.paths.storagesRoot), queued), true)

  const routes = []
  let injectedDeps = null
  const ctx = {
    get: (name) => env.host.get(name),
    inject: (deps, callback) => {
      injectedDeps = Array.from(deps)
      callback(ctx)
    },
    effect: (callback, label) => {
      callback()
      return () => undefined
    },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => undefined
      },
    },
  }

  apply(ctx, { home: env.root })

  assert.deepEqual(injectedDeps, ['webServer', 'sessionPersistence', 'workspaceRegistry', 'sessions'])
  assert.deepEqual(routes.map((route) => route.path), [
    ROUTE_PATH,
    ROUTE_QUEUE_PATH,
    ROUTE_UNQUEUE_PATH,
    ROUTE_PENDING_PATH,
  ])
  assert.ok(routes.every((route) => route.kind === 'exact' && typeof route.handler === 'function'))

  // 启动清理是 fire-and-forget 的，等它把队列消费掉。
  for (let attempt = 0; attempt < 100 && fs.existsSync(dir); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(fs.existsSync(dir), false)
  assert.deepEqual(readPending(env.paths.pendingFile).items, [])
})
