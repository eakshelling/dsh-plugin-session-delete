/**
 * Client 面冒烟测试：不启动浏览器，用最小上下文调用 client.js 的 factory。
 *
 * 目的：捕获「菜单注册错了 target / order / icon key」「inject 名字写错」
 * 「overlay 槽 id 不一致」这类只有真机点击才会暴露的问题。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(dir, '..', 'client.js'), 'utf8')

/** 极简 React：组件在测试里不渲染，只保证 factory 不炸。 */
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useEffect: () => undefined,
  useSyncExternalStore: () => {
    throw new Error('测试不渲染组件')
  },
}

function loadClient() {
  let entry
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (next) => {
          entry = next
        },
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
    navigator: { language: 'zh-CN' },
    console,
    URL,
    setTimeout,
    clearTimeout,
    fetch: () => Promise.reject(new Error('测试不发真实请求')),
    document: undefined,
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  return entry
}

function fakeCtx() {
  const calls = { menus: [], effects: 0, icons: [], overlays: [], injected: [] }
  const ctx = {
    effect: (callback, label) => {
      calls.effects += 1
      calls.effectLabel = label
      return callback()
    },
    contextMenus: {
      register: (contribution) => {
        calls.menus.push(contribution)
        return () => undefined
      },
    },
    slots: {
      inject: (name, callback) => {
        calls.injected.push(name)
        return callback()
      },
      register: (definition, component) => {
        if (definition.key !== undefined) calls.icons.push({ definition, component })
        else calls.overlays.push({ definition, component })
        return () => undefined
      },
    },
    sessions: { refresh: async () => undefined },
  }
  return { ctx, calls }
}

test('client factory 注册会话右键菜单项、图标与确认框槽位', () => {
  const entry = loadClient()
  assert.equal(entry.id, 'dsh-plugin-session-delete')

  const module = entry.factory((id) => {
    assert.equal(id, 'react')
    return ReactStub
  })
  // vm 里创建的数组有独立原型，先搬回本 realm 再比较。
  assert.deepEqual(Array.from(module.inject), ['slots', 'contextMenus', 'sessions'])

  const { ctx, calls } = fakeCtx()
  module.apply(ctx)

  assert.equal(calls.effects, 1)
  assert.equal(calls.menus.length, 1)
  const contribution = calls.menus[0]
  assert.equal(contribution.id, 'session.delete')
  assert.equal(contribution.target, 'session')
  assert.equal(contribution.order, 650)
  assert.equal(typeof contribution.resolve, 'function')

  const actions = contribution.resolve({ sessionId: 'session-abc', displayTitle: '标题' })
  assert.equal(actions.length, 1)
  const action = actions[0]
  assert.equal(action.id, 'delete')
  assert.equal(action.danger, true)
  assert.equal(action.separatorBefore, true)
  assert.equal(action.icon.key, 'session-delete.trash')
  assert.equal(typeof action.run, 'function')
  action.run()

  assert.deepEqual(calls.injected, ['contextMenu.icon', 'shell.overlay'])
  assert.equal(calls.icons.length, 1)
  assert.equal(calls.icons[0].definition.name, 'contextMenu.icon')
  assert.equal(calls.icons[0].definition.key, 'session-delete.trash')
  assert.equal(calls.overlays.length, 1)
  assert.equal(calls.overlays[0].definition.name, 'shell.overlay')
  assert.equal(calls.overlays[0].definition.id, 'session-delete.dialog')
})
