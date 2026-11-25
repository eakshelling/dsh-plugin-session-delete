/**
 * 待删队列的纯逻辑测试：不碰 Host、不碰网络，只验证读写与增删的边界。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  MAX_PENDING,
  MAX_TITLE,
  bumpPending,
  emptyPending,
  enqueuePending,
  normalizePending,
  pendingEntry,
  pendingFilePath,
  readPending,
  removePending,
  sanitizeTitle,
  writePending,
} from '../lib/pending.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'session-delete-pending-'))
}

test('pendingFilePath 固定落在 <storages>/session-delete/pending.json', () => {
  const file = pendingFilePath('C:/Users/x/.dsh/storages')
  assert.equal(path.basename(file), 'pending.json')
  assert.equal(path.basename(path.dirname(file)), 'session-delete')
})

test('sanitizeTitle 去控制字符、压缩空白并截断', () => {
  assert.equal(sanitizeTitle('  a\u0000b\n\nc  '), 'a b c')
  assert.equal(sanitizeTitle(undefined), '')
  const long = 'x'.repeat(MAX_TITLE + 40)
  assert.equal(sanitizeTitle(long).length, MAX_TITLE)
})

test('normalizePending 丢弃坏条目、去重、按上限保留最近的', () => {
  assert.deepEqual(normalizePending(null), emptyPending())
  assert.deepEqual(normalizePending({ version: 99, items: [] }), emptyPending())
  assert.deepEqual(normalizePending({ version: 1, items: 'nope' }), emptyPending())

  const state = normalizePending({
    version: 1,
    items: [
      { sessionId: 'session-a', title: 'A' },
      { sessionId: 'session-a', title: 'A again' },
      { sessionId: '', title: 'empty' },
      { title: 'no id' },
      null,
      { sessionId: 'session-b' },
    ],
  })
  assert.deepEqual(state.items.map((item) => item.sessionId), ['session-a', 'session-b'])
  assert.equal(state.items[0].title, 'A')
  // 没给标题时退化成 sessionId，永远不是空串
  assert.equal(state.items[1].title, 'session-b')

  const many = normalizePending({
    version: 1,
    items: Array.from({ length: MAX_PENDING + 5 }, (_, index) => ({ sessionId: 'session-' + index })),
  })
  assert.equal(many.items.length, MAX_PENDING)
  assert.equal(many.items[0].sessionId, 'session-5')
})

test('enqueuePending 同一会话只留一条，removePending 可删除', () => {
  let state = emptyPending()
  const first = enqueuePending(state, { sessionId: 'session-a', title: 'A' })
  assert.equal(first.added, true)
  state = first.state

  const again = enqueuePending(state, { sessionId: 'session-a', title: 'A2' })
  assert.equal(again.added, false)
  assert.equal(again.state.items.length, 1)
  assert.equal(again.state.items[0].title, 'A')

  const second = enqueuePending(again.state, { sessionId: 'session-b' })
  assert.equal(second.state.items.length, 2)

  const removal = removePending(second.state, 'session-a')
  assert.equal(removal.removed, true)
  assert.deepEqual(removal.state.items.map((item) => item.sessionId), ['session-b'])

  assert.equal(removePending(removal.state, 'session-missing').removed, false)
})

test('bumpPending 只改目标条目，记录失败信息', () => {
  const state = enqueuePending(emptyPending(), { sessionId: 'session-a', title: 'A' }).state
  const bumped = bumpPending(state, 'session-a', { attempts: 2, lastCode: 'session-live', lastError: 'busy' })
  assert.equal(bumped.found, true)
  const entry = pendingEntry(bumped.state, 'session-a')
  assert.equal(entry.attempts, 2)
  assert.equal(entry.lastCode, 'session-live')
  assert.equal(entry.lastError, 'busy')

  const missing = bumpPending(bumped.state, 'session-zzz', { attempts: 9 })
  assert.equal(missing.found, false)
  assert.deepEqual(missing.state, bumped.state)
})

test('readPending 对缺失文件返回空队列，对损坏文件改名留档', () => {
  const dir = tempDir()
  const file = path.join(dir, 'pending.json')

  assert.deepEqual(readPending(file), emptyPending())

  fs.writeFileSync(file, '{ not json')
  assert.deepEqual(readPending(file), emptyPending())
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'))
  assert.equal(leftovers.length, 1)
  assert.equal(fs.existsSync(file), false)
})

test('writePending 原子落盘，读回一致且不残留临时文件', () => {
  const dir = tempDir()
  const file = path.join(dir, 'nested', 'pending.json')
  const state = enqueuePending(emptyPending(), { sessionId: 'session-a', title: '标题' }).state

  assert.equal(writePending(file, state), true)
  assert.deepEqual(readPending(file).items.map((item) => item.sessionId), ['session-a'])
  const names = fs.readdirSync(path.dirname(file))
  assert.deepEqual(names, ['pending.json'])
})
