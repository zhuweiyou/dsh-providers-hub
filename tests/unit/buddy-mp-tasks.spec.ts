import { describe, expect, it } from 'vitest'
import type { BuddyCredential } from '../../src/buddy.js'
import type { BuddyProduct } from '../../src/product.js'
import {
  MP_CHAT_EVENT_GAP_MS,
  MP_TASK_CODES,
  claimGrowthTaskReward,
  fetchGrowthTaskCodes,
  runGrowthTaskCompletions,
} from '../../src/buddy-growth.js'

/**
 * 小程序口径（`X-Client-Platform: miniprogram`）任务的判据回归。
 *
 * 这组用例锁三件事，全部来自 2026-10-23 的**本机真实账号只读探针**
 * （`scripts/probe-buddy-growth.mjs`）与参考实现 `linguo2625469/workbuddy2api-panel`：
 *
 * 1. mp 列表**不是** web 列表的超集（实测 mp 只有 9 条、漏了 9 项常规任务）⇒ 必须取并集；
 * 2. accept 必须**分两批**提交（头不同，混批会让 mp 任务回 `task not found`）；
 * 3. mp 码领奖必须走 chat 域的 mp 端点，400 时降级 web 域。
 */

const CRED = {
  access_token: 'token-abc',
  refresh_token: 'refresh-abc',
  user_id: 'uid-1',
  domain: 'codebuddy.cn',
} as unknown as BuddyCredential

const PRODUCT = {
  id: 'buddy',
  endpoint: 'https://copilot.tencent.com',
  claimBase: 'https://www.workbuddy.cn',
  webBase: 'https://www.workbuddy.cn',
  apiDomain: 'codebuddy.cn',
  productCode: 'codebuddy',
  userAgent: 'CodeBuddyIDE/1.106.1',
} as unknown as BuddyProduct

interface Call {
  url: string
  method: string
  platform: string
  body: unknown
}

/** 记录请求（含 `x-client-platform`）的 fetcher，按谓词分派响应。 */
function makeFetcher(
  handler: (url: string, platform: string, body: unknown) => unknown | undefined,
): { fetcher: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetcher = (async (url: string, init?: RequestInit) => {
    const method = String(init?.method ?? 'GET').toUpperCase()
    /**
     * ⚠️ `growthHeaders` 返回的是 **`Headers` 实例**（不是普通对象）：
     * `Object.entries(new Headers([...]))` 恒为 `[]`（Headers 没有自有可枚举属性）。
     * 被测代码里另一处就因此丢过 9 枚头（见 `keepStreakActive` 的注释），
     * 测试替身若按普通对象读，会让「mp 头有没有发出去」这类断言**恒假通过**。
     */
    const platform = ((): string => {
      const source = init?.headers as unknown
      if (source !== undefined && source !== null && typeof (source as Headers).get === 'function') {
        return String((source as Headers).get('x-client-platform') ?? '')
      }
      if (source !== undefined && source !== null && typeof (source as Record<string, string>) === 'object') {
        for (const [key, value] of Object.entries(source as Record<string, string>)) {
          if (key.toLowerCase() === 'x-client-platform') return String(value)
        }
      }
      return ''
    })()
    const rawBody = typeof init?.body === 'string' ? init.body : ''
    const body = rawBody.length > 0 ? JSON.parse(rawBody) : undefined
    calls.push({ url: String(url), method, platform, body })
    const spec = handler(String(url), platform, body) ?? { code: 0, data: {} }
    return {
      ok: true,
      status: 200,
      json: async () => spec,
      text: async () => JSON.stringify(spec),
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

describe('三源并集（web 两族 + 小程序口径）', () => {
  it('mp 专属码与 web 专属码必须**同时**进待办：mp 列表不是超集', async () => {
    const { fetcher } = makeFetcher((url, platform) => {
      const isWebTasks = url.includes('/activity/growth/tasks') && !url.includes('/v2/')
      if (isWebTasks) return { code: 0, data: { tasks: [] } }
      if (!url.includes('/v2/activity/growth/tasks')) return { code: 0, data: {} }
      if (platform === 'miniprogram') {
        // 实测形状：mp 列表**漏掉** create_canvas 等 9 项，只多出 Sequential_Tasks_1
        return {
          code: 0,
          data: {
            tasks: [
              { task_code: 'chat_5', accept_status: 'not_accepted', progress: { current: 0, target: 5 } },
              { task_code: 'Sequential_Tasks_1', accept_status: 'not_accepted', progress: { current: 0, target: 1 } },
            ],
          },
        }
      }
      return {
        code: 0,
        data: {
          tasks: [
            { task_code: 'chat_5', accept_status: 'not_accepted', progress: { current: 0, target: 5 } },
            { task_code: 'create_canvas', accept_status: 'not_accepted', progress: { current: 0, target: 1 } },
          ],
        },
      }
    })
    const result = await fetchGrowthTaskCodes(CRED, PRODUCT, fetcher)
    expect(result.ok).toBe(true)
    expect(result.codes.sort()).toEqual(['Sequential_Tasks_1', 'chat_5', 'create_canvas'])
    // 同名任务只出现一次（并集按 task_code 去重）
    expect(result.codes.filter((code) => code === 'chat_5')).toHaveLength(1)
  })
})

describe('accept 必须分两批提交', () => {
  // 超时放宽到 30s：mp 对话任务上报后有 2×3s 的异步计分回读（判据口径，不缩短）。
  it('web 批不带 mp 头、mp 批带 mp 头，两批都发出', async () => {
    const { fetcher, calls } = makeFetcher((url, platform) => {
      if (url.includes('/activity/growth/tasks/accept')) return { code: 0, data: {} }
      if (!url.includes('/activity/growth/tasks')) return { code: 0, data: {} }
      const isWebTasks = !url.includes('/v2/')
      if (isWebTasks) return { code: 0, data: { tasks: [] } }
      if (platform === 'miniprogram') {
        return {
          code: 0,
          data: {
            tasks: [{ task_code: 'Sequential_Tasks_1', accept_status: 'not_accepted', progress: { current: 0, target: 1 } }],
          },
        }
      }
      return {
        code: 0,
        data: { tasks: [{ task_code: 'chat_5', accept_status: 'not_accepted', progress: { current: 0, target: 1 } }] },
      }
    })
    await runGrowthTaskCompletions(CRED, PRODUCT, fetcher, {
      budgetMs: 30_000,
      mpChatEventGapMs: 0,
    })
    const accepts = calls.filter((call) => call.url.includes('/activity/growth/tasks/accept'))
    expect(accepts).toHaveLength(2)
    const webBatch = accepts.find((call) => call.platform !== 'miniprogram')
    const mpBatch = accepts.find((call) => call.platform === 'miniprogram')
    expect((webBatch?.body as { task_codes: string[] }).task_codes).toEqual(['chat_5'])
    expect((mpBatch?.body as { task_codes: string[] }).task_codes).toEqual(['Sequential_Tasks_1'])
  }, 30_000)
})

describe('mp 码领奖路由', () => {
  it('走 chat 域的 mp 端点（不是 web 域）', async () => {
    const { fetcher, calls } = makeFetcher((url) => {
      if (url.includes('/claim')) return { code: 0, data: { already_claimed: false, credit: 100, energy: 5 } }
      return { code: 0, data: {} }
    })
    const result = await claimGrowthTaskReward(CRED, PRODUCT, fetcher, 'Sequential_Tasks_1')
    expect(result.ok).toBe(true)
    expect(result.claimed).toBe(true)
    expect(result.credit).toBe(100)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${PRODUCT.endpoint}/activity/growth/tasks/Sequential_Tasks_1/claim`)
    expect(calls[0]?.platform).toBe('miniprogram')
  })

  it('chat 域回 code 400 ⇒ 降级 web 域重领（不是失败）', async () => {
    let first = true
    const { fetcher, calls } = makeFetcher((url) => {
      if (!url.includes('/claim')) return { code: 0, data: {} }
      if (url.startsWith(PRODUCT.claimBase) && first === false) {
        return { code: 0, data: { already_claimed: false, credit: 100 } }
      }
      const spec = url.startsWith(PRODUCT.endpoint) ? { code: 400, msg: 'task not completed' } : { code: 0, data: { credit: 100 } }
      first = false
      return spec
    })
    const result = await claimGrowthTaskReward(CRED, PRODUCT, fetcher, 'Sequential_Tasks_1')
    expect(calls).toHaveLength(2)
    expect(calls[0]?.url.startsWith(PRODUCT.endpoint)).toBe(true)
    expect(calls[1]?.url.startsWith(PRODUCT.claimBase)).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.claimed).toBe(true)
  })

  it('web 口径的码仍走 web 域（不被 mp 路由抢走）', async () => {
    const { fetcher, calls } = makeFetcher(() => ({ code: 0, data: { credit: 100 } }))
    await claimGrowthTaskReward(CRED, PRODUCT, fetcher, 'chat_5')
    expect(calls[0]?.url.startsWith(PRODUCT.claimBase)).toBe(true)
  })
})

describe('mp 对话事件的节奏与形状', () => {
  // 超时放宽到 30s：同上（SETTLE_WAIT_MS + 2×3s 回读是真实节奏）。
  it('按 target 补足条数，全部走 codebuddy.cn 的 mp 指纹上报', async () => {
    let mpListCalls = 0
    const { fetcher, calls } = makeFetcher((url, platform) => {
      if (url.includes('/claim')) return { code: 0, data: { credit: 100 } }
      if (url.includes('/v2/report')) return { code: 0, data: {} }
      if (url.includes('/activity/growth/tasks') && !url.includes('/v2/')) {
        return { code: 0, data: { tasks: [] } }
      }
      if (!url.includes('/activity/growth/tasks')) return { code: 0, data: {} }
      if (platform !== 'miniprogram') return { code: 0, data: { tasks: [] } }
      mpListCalls += 1
      // 首轮 accept 前：not_accepted + 0/1；之后回读：1/1（模拟异步计分归账）
      return mpListCalls === 1
        ? {
            code: 0,
            data: { tasks: [{ task_code: 'Sequential_Tasks_1', accept_status: 'not_accepted', progress: { current: 0, target: 1 } }] },
          }
        : {
            code: 0,
            data: { tasks: [{ task_code: 'Sequential_Tasks_1', accept_status: 'completed', progress: { current: 1, target: 1 } }] },
          }
    })
    const report = await runGrowthTaskCompletions(CRED, PRODUCT, fetcher, {
      budgetMs: 60_000,
      mpChatEventGapMs: 0,
    })
    const reports = calls.filter((call) => call.url.includes('/v2/report'))
    expect(reports).toHaveLength(1)
    expect(reports[0]?.url).toBe('https://www.codebuddy.cn/v2/report')
    const events = reports[0]?.body as Array<Record<string, unknown>>
    expect(events[0]?.eventCode).toBe('chat_request_send')
    // mp 指纹：platform=mini_program + agentName=mp + 小程序 ideType
    expect(events[0]?.platform).toBe('mini_program')
    expect(events[0]?.ideType).toBe('WorkBuddy_MP')
    expect(events[0]?.agentName).toBe('mp')
    expect(report.ok).toBe(true)
  }, 30_000)

  it('默认间隔是 45s（判据参数，不是节流）', () => {
    expect(MP_CHAT_EVENT_GAP_MS).toBe(45_000)
  })

  it('码表覆盖 8 项（school_season + Sequential_Tasks_1..7）', () => {
    expect([...MP_TASK_CODES].sort()).toEqual([
      'Sequential_Tasks_1',
      'Sequential_Tasks_2',
      'Sequential_Tasks_3',
      'Sequential_Tasks_4',
      'Sequential_Tasks_5',
      'Sequential_Tasks_6',
      'Sequential_Tasks_7',
      'school_season',
    ])
  })
})
