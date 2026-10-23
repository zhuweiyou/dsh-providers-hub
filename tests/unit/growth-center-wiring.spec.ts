import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 「**打开面板不得向上游读取任务清单**」的接线守卫（2026-10-23 用户报障）。
 *
 * > 「这个要弄个按钮点了才读取，而不是打开插件面板就读取，这样每次都要向上游发
 * >  API 请求太多了」
 *
 * 为什么必须用源码级断言：客户端组件在单测里**不渲染**（仓库没有 react），
 * 行为测不到；而这条正是「一打开面板就发 N×6 个上游请求」的事故面。判据刻意
 * **锚定片段**（挂载 effect 的闭包）而不是全文，避免「别处调了一次」也算违规 ——
 * 按钮的 `onClick` 本来就该调它。
 *
 * ⚠️ 弱点如实登记：源码文本断言挡不住 `if (false)` 短路。为压制这一点，这里
 * 同时断言「挂载 effect 里必须出现廉价的 `loadGrowthLive()`」——把自动读取改成
 * 死分支会让这条也变红（因为廉价那条是**用户要的**行为）。
 */
const here = resolve(__dirname)
const client = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')

/**
 * 取「buddy 面板的挂载 effect」闭包文本。
 *
 * ⚠️ **不能锚 `mounted.current = true;`**：文件里别的组件（模型选择弹窗）也有
 * 同款语句，`indexOf` 会命中那里，切片直接跨到 9 万字符之后（本用例第一版就是
 * 这么假红的 —— 判据打在了别的组件上）。改为锚「同一段里出现 `loadGrowthLive()`
 * 的那次 `void loadAccounts();`」。
 */
function mountEffect(): string {
  const anchor = 'void loadAccounts();'
  let from = client.indexOf(anchor)
  while (from >= 0) {
    const end = client.indexOf('}, [provider]);', from)
    if (end > 0) {
      const slice = client.slice(from, end)
      if (slice.includes('loadGrowthLive')) return slice
    }
    from = client.indexOf(anchor, from + anchor.length)
  }
  throw new Error('未找到 buddy 面板的挂载 effect')
}

describe('成长任务：打开面板不读上游', () => {
  it('挂载 effect **不得**调用 loadGrowthCenter（贵：每账号约 6 个上游请求）', () => {
    const block = mountEffect()
    expect(block).not.toMatch(/loadGrowthCenter\s*\(/)
    expect(block).not.toMatch(/buddy\.growthOverview/)
  })

  it('挂载 effect **必须**调用廉价那条（进度 + 本地执行记录）', () => {
    const block = mountEffect()
    expect(block).toMatch(/loadGrowthLive\s*\(/)
  })

  it('总览 RPC 只有一个调用点（按钮的 onClick）', () => {
    // ⚠️ 计数断言：两个调用点意味着某个自动路径又长出来了。
    const calls = client.match(/rpcCall\(\s*'buddy\.growthOverview'/g) ?? []
    expect(calls).toHaveLength(1)
  })

  it('进度与上次执行各自只打一条**零上游** RPC', () => {
    expect(client.match(/rpcCall\(\s*'buddy\.growthProgress'/g) ?? []).toHaveLength(1)
    expect(client.match(/rpcCall\(\s*'buddy\.growthLastRuns'/g) ?? []).toHaveLength(1)
  })

  it('进度轮询必须能被卸载清掉（否则切走后仍在打 RPC）', () => {
    // 轮询 effect 的收尾里必须有 clearInterval。
    const start = client.indexOf("setInterval(() => { void loadGrowthLive(); }")
    expect(start).toBeGreaterThan(-1)
    const tail = client.slice(start, start + 400)
    expect(tail).toMatch(/clearInterval\(timer\)/)
  })

  it('「一键领取」按钮的禁用判据包含**宿主**进度（切回面板后不能重复起一轮）', () => {
    const start = client.indexOf("'一键领取 + 成长任务'")
    expect(start).toBeGreaterThan(-1)
    const head = client.slice(Math.max(0, start - 700), start)
    expect(head).toMatch(/growthRunning/)
  })
})
