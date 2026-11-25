/**
 * dsh-plugin-session-delete 的单元测试：只覆盖可独立验证的纯逻辑与 HTTP 工具。
 *
 * 运行：node --test test/
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  ROUTE_PATH,
  appendAudit,
  isValidSessionId,
  projcacheDir,
  removeProjcacheRecords,
  removeSessionDir,
  scheduleReferences,
  sessionDirFor,
} from '../lib/delete.js'
import { HttpError, isJsonContentType, isSameOrigin, readJsonBody, sendJson } from '../lib/http.js'

const ID = 'session-f68af960-294c-4257-a135-e9af2e79e1b5'

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-delete-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function mockRequest(body, headers = {}) {
  const stream = new PassThrough()
  stream.headers = headers
  process.nextTick(() => { stream.end(body) })
  return stream
}

test('ROUTE_PATH 是固定 exact 路径', () => {
  assert.equal(ROUTE_PATH, '/dsh-session-delete/delete')
})

test('isValidSessionId 只接受 session-<安全字符>', () => {
  assert.equal(isValidSessionId(ID), true)
  assert.equal(isValidSessionId('session-a'), true)
  assert.equal(isValidSessionId('session-'), false)
  assert.equal(isValidSessionId(''), false)
  assert.equal(isValidSessionId(undefined), false)
  assert.equal(isValidSessionId('../session-a'), false)
  assert.equal(isValidSessionId('session-a/b'), false)
  assert.equal(isValidSessionId('session-a b'), false)
  assert.equal(isValidSessionId('session-' + 'a'.repeat(191)), false)
})

test('sessionDirFor 只在目录名等于会话 id 时才给出可删目录', () => {
  const location = path.join(os.tmpdir(), 'sessions', '--proj--', ID, 'session.v4.jsonl.zstd')
  assert.equal(sessionDirFor(location, ID), path.join(os.tmpdir(), 'sessions', '--proj--', ID))
  assert.equal(sessionDirFor(location, 'session-other'), null, '目录名与会话 id 不一致必须拒绝')
  assert.equal(sessionDirFor('session.v4.jsonl.zstd', ID), null, '相对路径必须拒绝')
  assert.equal(sessionDirFor(path.join(os.tmpdir(), ID), ID), null, '不是 session 目录形状必须拒绝')
  assert.equal(sessionDirFor('', ID), null)
  assert.equal(sessionDirFor(undefined, ID), null)
})

test('projcacheDir 指向 storages/session_projcache/sessions', () => {
  const root = path.join(os.tmpdir(), 'storages')
  assert.equal(projcacheDir(root), path.join(root, 'session_projcache', 'sessions'))
})

test('removeProjcacheRecords 只删本会话的记录与备份', async (t) => {
  const storages = tempDir(t)
  const dir = projcacheDir(storages)
  fs.mkdirSync(dir, { recursive: true })
  const keep = ['session-other.json', 'notes.txt']
  const dropped = [ID + '.json', ID + '.json.bak-20260101T000000000Z']
  for (const name of [...dropped, ...keep]) fs.writeFileSync(path.join(dir, name), '{}')

  const removed = await removeProjcacheRecords(storages, ID)
  assert.deepEqual(removed.map((file) => path.basename(file)).sort(), dropped.slice().sort())
  assert.deepEqual(fs.readdirSync(dir).sort(), keep.slice().sort())
})

test('removeProjcacheRecords 在目录不存在时安静返回空数组', async (t) => {
  const storages = tempDir(t)
  assert.deepEqual(await removeProjcacheRecords(storages, ID), [])
  assert.deepEqual(await removeProjcacheRecords(storages, '../bad'), [])
})

test('scheduleReferences 只做包含判断，不改文件', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, 'schedule.json')
  fs.writeFileSync(file, JSON.stringify({ involvedSessionIds: [ID] }))
  assert.equal(scheduleReferences(file, ID), true)
  assert.equal(scheduleReferences(file, 'session-other'), false)
  assert.equal(scheduleReferences(path.join(dir, 'missing.json'), ID), false)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).involvedSessionIds[0], ID)
})

test('removeSessionDir 递归删除会话目录', async (t) => {
  const dir = tempDir(t)
  const sessionDir = path.join(dir, ID)
  fs.mkdirSync(path.join(sessionDir, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), 'x')
  fs.writeFileSync(path.join(sessionDir, 'nested', 'old.jsonl'), 'x')

  await removeSessionDir(sessionDir)
  assert.equal(fs.existsSync(sessionDir), false)
})

test('appendAudit 逐行追加 JSON，失败时返回 false', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, 'audit', 'audit.log')
  assert.equal(appendAudit(file, { sessionId: ID, n: 1 }), true)
  assert.equal(appendAudit(file, { sessionId: ID, n: 2 }), true)
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(lines.map((line) => line.n), [1, 2])
  assert.equal(appendAudit(path.join(dir, 'audit', '\u0000bad'), { n: 3 }), false)
})

test('isSameOrigin: Origin 必须匹配 Host，Sec-Fetch-Site 只放行同源', () => {
  const host = '127.0.0.1:63975'
  assert.equal(isSameOrigin({ host, origin: 'http://' + host }), true)
  assert.equal(isSameOrigin({ host, origin: 'https://evil.example' }), false)
  assert.equal(isSameOrigin({ host, origin: 'http://127.0.0.1:1' }), false)
  assert.equal(isSameOrigin({ host }), true, '无 Origin 的本机客户端放行')
  assert.equal(isSameOrigin({ host, origin: 'http://' + host, 'sec-fetch-site': 'cross-site' }), false)
  assert.equal(isSameOrigin({ host, origin: 'http://' + host, 'sec-fetch-site': 'same-origin' }), true)
  assert.equal(isSameOrigin({ origin: 'http://' + host }), false, '没有 Host 无法比对')
  assert.equal(isSameOrigin({ host, origin: 'not a url' }), false)
})

test('isJsonContentType 只接受 application/json', () => {
  assert.equal(isJsonContentType({ 'content-type': 'application/json' }), true)
  assert.equal(isJsonContentType({ 'content-type': 'Application/JSON; charset=utf-8' }), true)
  assert.equal(isJsonContentType({ 'content-type': 'text/plain' }), false)
  assert.equal(isJsonContentType({}), false)
})

test('readJsonBody 解析对象并拒绝非法输入', async () => {
  assert.deepEqual(await readJsonBody(mockRequest('{"sessionId":"' + ID + '"}')), { sessionId: ID })
  assert.deepEqual(await readJsonBody(mockRequest('   ')), {})

  await assert.rejects(readJsonBody(mockRequest('not json')), (error) => {
    assert.ok(error instanceof HttpError)
    assert.equal(error.status, 400)
    assert.equal(error.code, 'invalid-json')
    return true
  })
  await assert.rejects(readJsonBody(mockRequest('[1,2]')), (error) => error.code === 'invalid-json')
  await assert.rejects(readJsonBody(mockRequest('null')), (error) => error.code === 'invalid-json')
})

test('readJsonBody 尊重体积上限（声明值与实际流量）', async () => {
  await assert.rejects(
    readJsonBody(mockRequest('{"a":1}', { 'content-length': '100' }), 16),
    (error) => error.status === 413 && error.code === 'body-too-large',
  )
  await assert.rejects(
    readJsonBody(mockRequest('x'.repeat(64)), 16),
    (error) => error.status === 413 && error.code === 'body-too-large',
  )
})

test('sendJson 写出 no-store JSON 响应', () => {
  const headers = {}
  let body = ''
  const response = {
    statusCode: 0,
    setHeader(name, value) { headers[name] = value },
    end(text) { body = text },
  }
  sendJson(response, 409, { ok: false, code: 'session-live' })
  assert.equal(response.statusCode, 409)
  assert.equal(headers['cache-control'], 'no-store')
  assert.match(headers['content-type'], /^application\/json/)
  assert.deepEqual(JSON.parse(body), { ok: false, code: 'session-live' })
})

test('HttpError 保留状态码与稳定 code', () => {
  const error = new HttpError(409, 'session-owned', 'busy')
  assert.equal(error.name, 'HttpError')
  assert.equal(error.status, 409)
  assert.equal(error.code, 'session-owned')
  assert.equal(error.message, 'busy')
  assert.ok(error instanceof Error)
})
