import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「侧栏入口」客户端状态（`plugin-src/client/sidebar-entry-store.js`）回归。
 *
 * ## 为什么单独测这一个模块
 *
 * 页头开关与侧栏行**共用同一份状态**，而真正的坑全在「宿主说不清 / 说不到」
 * 时该往哪边兜底：
 *
 * - 读取失败时**必须按显示兜底** —— 一次 RPC 卡住不该把入口藏掉，否则用户会
 *   以为插件坏了；但失败标记要留下，开关好显示降级文案；
 * - 写回失败时**必须把错误抛出去** —— 静默改本地状态会造成「开关看着开了、
 *   重启后又变回来」，这类缺陷只有跨进程重启才暴露；
 * - 回包形状不对（没有 `enabled`）按失败处理，**不猜**宿主的意图。
 *
 * ## 状态是模块级的
 *
 * 每个用例都用 `vi.resetModules()` + 动态 import 换一份新模块实例，否则上一
 * 用例留下的 `enabled` 会把失败路径掩盖成「本来就该这么显示」。
 */

/** 造一个按端点回话的 `rpcCall` 替身，并记录收到的参数。 */
function makeRpc(handlers: {
  get?: () => Promise<unknown>
  set?: (payload: unknown) => Promise<unknown>
}) {
  const calls: Array<{ endpoint: string; payload: unknown }> = []
  const rpc = async (endpoint: string, payload: unknown) => {
    calls.push({ endpoint, payload })
    if (endpoint === 'sidebarEntry.getEnabled') {
      return handlers.get ? handlers.get() : { enabled: true }
    }
    if (endpoint === 'sidebarEntry.setEnabled') {
      return handlers.set ? handlers.set(payload) : payload
    }
    throw new Error(`未预期的端点 ${endpoint}`)
  }
  return { rpc, calls }
}

type StoreModule = typeof import('../../plugin-src/client/sidebar-entry-store.js')

async function freshModule(): Promise<StoreModule> {
  vi.resetModules()
  return import('../../plugin-src/client/sidebar-entry-store.js')
}

describe('侧栏入口客户端状态', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('还没读到宿主偏好时按显示处理（默认开启，= 升级前行为）', async () => {
    const store = await freshModule()
    expect(store.sidebarEntryVisible()).toBe(true)
    expect(store.sidebarEntryReadFailed()).toBe(false)
  })

  it('宿主明确关闭后不可见，并通知一次订阅者', async () => {
    const store = await freshModule()
    const seen: boolean[] = []
    store.subscribeSidebarEntry(() => seen.push(store.sidebarEntryVisible()))

    const { rpc } = makeRpc({ get: async () => ({ enabled: false }) })
    await store.loadSidebarEntry(rpc)

    expect(store.sidebarEntryVisible()).toBe(false)
    expect(seen).toEqual([false])
  })

  it('⚠️ 读取失败不得把入口藏掉，但要留下失败标记', async () => {
    const store = await freshModule()
    const { rpc } = makeRpc({
      get: async () => {
        throw new Error('宿主没响应')
      },
    })

    await store.loadSidebarEntry(rpc)

    // 方向不能反：失败兜底成「隐藏」会让用户以为插件没装，而他什么都没关。
    expect(store.sidebarEntryVisible()).toBe(true)
    expect(store.sidebarEntryReadFailed()).toBe(true)
  })

  it('回包形状不对（没有 enabled）按读取失败处理，不猜宿主的意图', async () => {
    const store = await freshModule()
    const { rpc } = makeRpc({ get: async () => ({ value: 'off' }) })

    await store.loadSidebarEntry(rpc)

    expect(store.sidebarEntryVisible()).toBe(true)
    expect(store.sidebarEntryReadFailed()).toBe(true)
  })

  it('失败之后一次成功读取会清掉失败标记', async () => {
    const store = await freshModule()
    const failing = makeRpc({
      get: async () => {
        throw new Error('宿主没响应')
      },
    })
    await store.loadSidebarEntry(failing.rpc)
    expect(store.sidebarEntryReadFailed()).toBe(true)

    const ok = makeRpc({ get: async () => ({ enabled: true }) })
    await store.loadSidebarEntry(ok.rpc)
    expect(store.sidebarEntryReadFailed()).toBe(false)
  })

  it('关闭时把 { enabled: false } 发给宿主，并以宿主返回值更新状态', async () => {
    const store = await freshModule()
    const { rpc, calls } = makeRpc({ set: async () => ({ enabled: false }) })

    const confirmed = await store.setSidebarEntry(rpc, false)

    expect(calls.at(-1)).toEqual({ endpoint: 'sidebarEntry.setEnabled', payload: { enabled: false } })
    expect(confirmed).toBe(false)
    expect(store.sidebarEntryVisible()).toBe(false)
  })

  it('⚠️ 写回失败必须抛错且不改本地状态（否则「关掉后重启又变回开」）', async () => {
    const store = await freshModule()
    const { rpc } = makeRpc({
      set: async () => {
        throw new Error('宿主拒绝')
      },
    })

    await expect(store.setSidebarEntry(rpc, false)).rejects.toThrow('宿主拒绝')
    expect(store.sidebarEntryVisible()).toBe(true)
  })

  it('⚠️ 宿主回包缺 enabled 时同样抛错，不把「没回答」当成「照办」', async () => {
    const store = await freshModule()
    const { rpc } = makeRpc({ set: async () => ({}) })

    await expect(store.setSidebarEntry(rpc, false)).rejects.toThrow('enabled')
    expect(store.sidebarEntryVisible()).toBe(true)
  })

  it('退订之后不再收到通知（侧栏行撤销后不得再被旧监听器碰）', async () => {
    const store = await freshModule()
    const seen: boolean[] = []
    const unsubscribe = store.subscribeSidebarEntry(() => seen.push(store.sidebarEntryVisible()))
    const { rpc } = makeRpc({ get: async () => ({ enabled: false }) })

    await store.loadSidebarEntry(rpc)
    unsubscribe()
    await store.loadSidebarEntry(makeRpc({ get: async () => ({ enabled: true }) }).rpc)

    expect(seen).toEqual([false])
  })
})
