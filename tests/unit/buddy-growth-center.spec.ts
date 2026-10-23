import { describe, expect, it } from 'vitest'
import type { BuddyCredential } from '../../src/buddy.js'
import type { BuddyProduct } from '../../src/product.js'
import {
  CLIENT_ONLY_TASK_CODES,
  MAX_LOTTERY_DRAWS,
  STREAK_PATHS,
  advanceTravel,
  claimGift,
  drawAllLottery,
  fetchBuddyInfo,
  fetchGrowthCenterSnapshot,
  fetchLotteryState,
  fetchStreakDetail,
  isBuddyAdoptNotReady,
  listGrowthTasks,
  makeupYesterday,
  redeemUnlockedTiers,
  summarizeGrowthExtras,
  toRpcGrowthExtras,
  utc8Date,
} from '../../src/buddy-growth-center.js'

/**
 * 成长中心**扩展收益**（连登兑换 / 抽奖 / 旅行 / 礼包 / 补签 / 领养）的判据回归。
 *
 * 这组用例锁的是**上游口径**（端点、字段名、`client_token` 语义、状态机分支），
 * 不锁代码自洽性。参考实现：`linguo2625469/workbuddy2api-panel` 的
 * `internal/upstream/streak.go` / `travel.go` / `internal/scheduler/streak.go`。
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
  body: unknown
  headers: Record<string, string>
}

/** 按 URL 谓词分派响应；未命中的请求回 `{code:0,data:{}}`。 */
function routedFetcher(
  routes: Array<{ match: (url: string, method: string) => boolean; status?: number; body: unknown }>,
): { fetcher: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetcher = (async (url: string, init?: RequestInit) => {
    const method = String(init?.method ?? 'GET').toUpperCase()
    const rawBody = typeof init?.body === 'string' ? init.body : ''
    const headers: Record<string, string> = {}
    const source = init?.headers as Record<string, string> | undefined
    if (source !== undefined && source !== null) {
      for (const [key, value] of Object.entries(source)) headers[key.toLowerCase()] = String(value)
    }
    calls.push({
      url: String(url),
      method,
      body: rawBody.length > 0 ? JSON.parse(rawBody) : undefined,
      headers,
    })
    const route = routes.find((item) => item.match(String(url), method))
    const body = route?.body ?? { code: 0, data: {} }
    const status = route?.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

const STREAK_BODY = {
  code: 0,
  data: {
    streak: { days: 8, month_total_days: 9, next_tier: '14d', next_tier_remaining: 6 },
    makeup_cards: { balance: 2, max: 5 },
    redemption_status: {
      tier_7d_status: 'available',
      tier_14d_status: 'locked',
      tier_28d_status: 'claimed',
      tiers: [
        { tier: '7d', days: 7, credit: 100, energy: 5, cards: 1, chances: 1 },
        { tier: '14d', days: 14, credit: 200, energy: 10, cards: 1, chances: 1 },
        { tier: '28d', days: 28, credit: 500, energy: 20, cards: 2, chances: 3 },
      ],
    },
  },
}

describe('fetchStreakDetail', () => {
  it('优先打不带 /v2 的权威路径，并解析 data.streak.days 与档位状态', async () => {
    const { fetcher, calls } = routedFetcher([{ match: () => true, body: STREAK_BODY }])
    const detail = await fetchStreakDetail(CRED, PRODUCT, fetcher)
    expect(detail.ok).toBe(true)
    expect(detail.days).toBe(8)
    expect(detail.makeupCards).toBe(2)
    expect(detail.tiers.map((tier) => tier.tier)).toEqual(['7d', '14d', '28d'])
    // 状态字段是带后缀的 `tier_7d_status`（不是 tiers[] 里的 status）
    expect(detail.tiers.map((tier) => tier.status)).toEqual(['available', 'locked', 'claimed'])
    expect(calls[0]?.url).toBe(`${PRODUCT.endpoint}${STREAK_PATHS[0]}`)
  })

  it('第一条路径非 code 0 时继续试第二条（两种口径都认，不许只认一种）', async () => {
    const { fetcher, calls } = routedFetcher([
      {
        match: (url) => url === `${PRODUCT.endpoint}${STREAK_PATHS[0]}`,
        body: { code: 404, msg: 'not found' },
      },
      { match: () => true, body: STREAK_BODY },
    ])
    const detail = await fetchStreakDetail(CRED, PRODUCT, fetcher)
    expect(detail.ok).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.url).toBe(`${PRODUCT.endpoint}${STREAK_PATHS[1]}`)
  })

  it('顶层 data.days 形状也认（旧 fetchStreakStatus 的假设），不许取成 0', async () => {
    const { fetcher } = routedFetcher([
      { match: () => true, body: { code: 0, data: { days: 5, active_today: true } } },
    ])
    const detail = await fetchStreakDetail(CRED, PRODUCT, fetcher)
    expect(detail.ok).toBe(true)
    expect(detail.days).toBe(5)
  })
})

describe('redeemUnlockedTiers', () => {
  it('只兑换 available 的档位，两次兑换用**不同的** client_token', async () => {
    const { fetcher, calls } = routedFetcher([
      { match: (url) => url.includes('/streak'), body: STREAK_BODY },
      { match: () => true, body: { code: 0, data: {} } },
    ])
    const detail = await fetchStreakDetail(CRED, PRODUCT, fetcher)
    calls.length = 0
    const result = await redeemUnlockedTiers(CRED, PRODUCT, detail, fetcher)
    // 7d=available ⇒ 兑换；14d=locked / 28d=claimed ⇒ 跳过
    expect(result.redeemed.map((tier) => tier.tier)).toEqual(['7d'])
    expect(result.failed).toEqual([])
    expect(calls).toHaveLength(1)
    const first = calls[0]?.body as { tier: string; client_token: string }
    expect(first.tier).toBe('7d')
    // 幂等令牌必须是 UUID 形态（复用一个值会让第二次被当重复提交）
    expect(first.client_token).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('上游 403「连续登录天数不足」按正常终态跳过，不算失败', async () => {
    const { fetcher } = routedFetcher([
      {
        match: (url) => url.includes('/activity/growth/redeem'),
        body: { code: 403, msg: '连续登录天数不足' },
      },
      { match: () => true, body: STREAK_BODY },
    ])
    const detail = await fetchStreakDetail(CRED, PRODUCT, fetcher)
    const result = await redeemUnlockedTiers(CRED, PRODUCT, detail, fetcher)
    expect(result.redeemed).toEqual([])
    expect(result.failed).toEqual([])
  })
})

describe('drawAllLottery', () => {
  it('按 chances 抽完，每次换新的 client_token', async () => {
    const { fetcher, calls } = routedFetcher([
      {
        match: (url) => url.includes('/lottery/summary'),
        body: { code: 0, data: { chances: 3, module: { enabled: true } } },
      },
      { match: () => true, body: { code: 0, data: {} } },
    ])
    const result = await drawAllLottery(CRED, PRODUCT, { fetcher })
    expect(result.drawn).toBe(3)
    expect(result.ok).toBe(true)
    const draws = calls.filter((call) => call.url.includes('/lottery/draw'))
    expect(draws).toHaveLength(3)
    const tokens = draws.map((call) => (call.body as { client_token: string }).client_token)
    expect(new Set(tokens).size).toBe(3)
  })

  it('chances 超过上限时截断（防打穿宿主时间预算）', async () => {
    const { fetcher, calls } = routedFetcher([
      {
        match: (url) => url.includes('/lottery/summary'),
        body: { code: 0, data: { chances: 999, module: { enabled: true } } },
      },
      { match: () => true, body: { code: 0, data: {} } },
    ])
    const result = await drawAllLottery(CRED, PRODUCT, { fetcher })
    expect(result.drawn).toBe(MAX_LOTTERY_DRAWS)
    expect(calls.filter((call) => call.url.includes('/lottery/draw'))).toHaveLength(MAX_LOTTERY_DRAWS)
  })

  it('module.enabled 缺字段按**开启**处理（缺字段≠关闭，否则抽奖永久静默失效）', async () => {
    const { fetcher } = routedFetcher([
      { match: (url) => url.includes('/lottery/summary'), body: { code: 0, data: { chances: 1 } } },
      { match: () => true, body: { code: 0, data: {} } },
    ])
    const state = await fetchLotteryState(CRED, PRODUCT, fetcher)
    expect(state.enabled).toBe(true)
    const result = await drawAllLottery(CRED, PRODUCT, { fetcher })
    expect(result.drawn).toBe(1)
  })
})

describe('advanceTravel 状态机', () => {
  it('idle 且未达上限 ⇒ 派出（location_id=4）', async () => {
    const { fetcher, calls } = routedFetcher([
      {
        match: (url) => url.includes('/travel/status'),
        body: { code: 0, data: { state: 'idle', daily_limit_reached: false } },
      },
      { match: () => true, body: { code: 0, data: {} } },
    ])
    const result = await advanceTravel(CRED, PRODUCT, fetcher)
    expect(result.action).toBe('depart')
    const depart = calls.find((call) => call.url.includes('/travel/depart'))
    expect(depart?.body).toEqual({ location_id: 4 })
  })

  it('arrived ⇒ 领奖且**必须**带 record_id', async () => {
    const { fetcher, calls } = routedFetcher([
      {
        match: (url) => url.includes('/travel/status'),
        body: { code: 0, data: { state: 'arrived', record_id: 7788, reward_credit: 60 } },
      },
      { match: () => true, body: { code: 0, data: { reward_credit: 60 } } },
    ])
    const result = await advanceTravel(CRED, PRODUCT, fetcher)
    expect(result.action).toBe('claim')
    expect(result.credit).toBe(60)
    const claim = calls.find((call) => call.url.includes('/travel/claim'))
    expect(claim?.body).toEqual({ record_id: 7788 })
  })

  it('arrived 但 record_id=0 ⇒ 跳过（不瞎打空 body）', async () => {
    const { fetcher, calls } = routedFetcher([
      {
        match: (url) => url.includes('/travel/status'),
        body: { code: 0, data: { state: 'arrived', record_id: 0 } },
      },
    ])
    const result = await advanceTravel(CRED, PRODUCT, fetcher)
    expect(result.action).toBe('skip')
    expect(calls.some((call) => call.url.includes('/travel/claim'))).toBe(false)
  })

  it('idle 但今日已达上限 ⇒ 不派出', async () => {
    const { fetcher, calls } = routedFetcher([
      {
        match: (url) => url.includes('/travel/status'),
        body: { code: 0, data: { state: 'idle', daily_limit_reached: true } },
      },
    ])
    const result = await advanceTravel(CRED, PRODUCT, fetcher)
    expect(result.action).toBe('skip')
    expect(calls.some((call) => call.url.includes('/travel/depart'))).toBe(false)
  })

  it('traveling ⇒ 跳过（不重复派出）', async () => {
    const { fetcher, calls } = routedFetcher([
      {
        match: (url) => url.includes('/travel/status'),
        body: { code: 0, data: { state: 'traveling', record_id: 1 } },
      },
    ])
    const result = await advanceTravel(CRED, PRODUCT, fetcher)
    expect(result.action).toBe('skip')
    expect(calls).toHaveLength(1)
  })
})

describe('claimGift', () => {
  it('code 0 + credit ⇒ 成功并回读到账积分', async () => {
    const { fetcher, calls } = routedFetcher([
      { match: () => true, body: { code: 0, msg: 'OK', data: { credit: 300 } } },
    ])
    const result = await claimGift(CRED, PRODUCT, fetcher)
    expect(result.ok).toBe(true)
    expect(result.credit).toBe(300)
    // billing 域走 webBase（不是 endpoint）
    expect(calls[0]?.url).toBe(`${PRODUCT.webBase}/billing/meter/claim-gift`)
  })

  it('「已领取」文案 ⇒ skipped 而不是失败（每号一次，重复点不该染红）', async () => {
    const { fetcher } = routedFetcher([
      { match: () => true, body: { code: 14051, msg: '礼包已领取' } },
    ])
    const result = await claimGift(CRED, PRODUCT, fetcher)
    expect(result.skipped).toBe(true)
    expect(result.ok).toBe(true)
  })

  it('401 文案点出「凭据已失效」（排障唯一线索）', async () => {
    const { fetcher } = routedFetcher([{ match: () => true, status: 401, body: {} }])
    const result = await claimGift(CRED, PRODUCT, fetcher)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('凭据已失效')
  })
})

describe('makeupYesterday', () => {
  it('昨日漏签且有卡 ⇒ 用 UTC+8 的昨日日期补签', async () => {
    const now = Date.parse('2026-10-23T02:00:00Z') // UTC+8 = 10-23 10:00
    const yesterday = utc8Date(-1, now)
    const { fetcher, calls } = routedFetcher([
      {
        match: (url) => url.includes('/heatmap'),
        body: {
          code: 0,
          data: { cells: [{ date: yesterday, score: 0 }, { date: '2026-10-23', score: 10 }] },
        },
      },
      { match: (url) => url.includes('/streak'), body: STREAK_BODY },
      { match: () => true, body: { code: 0, data: {} } },
    ])
    const result = await makeupYesterday(CRED, PRODUCT, fetcher, now)
    expect(result.ok).toBe(true)
    const use = calls.find((call) => call.url.includes('/makeup-cards/use'))
    expect(use?.body).toEqual({ target_date: yesterday })
  })

  it('昨日未漏签 ⇒ 不补签（不打写端点）', async () => {
    const { fetcher, calls } = routedFetcher([
      {
        match: (url) => url.includes('/heatmap'),
        body: { code: 0, data: { cells: [{ date: '2026-10-22', score: 12 }] } },
      },
    ])
    const result = await makeupYesterday(CRED, PRODUCT, fetcher, Date.parse('2026-10-23T02:00:00Z'))
    expect(result.skipped).toBe(true)
    expect(calls.some((call) => call.url.includes('/makeup-cards/use'))).toBe(false)
  })

  it('漏签但无补签卡 ⇒ 跳过（不打写端点）', async () => {
    const now = Date.parse('2026-10-23T02:00:00Z')
    const { fetcher, calls } = routedFetcher([
      {
        match: (url) => url.includes('/heatmap'),
        body: { code: 0, data: { cells: [{ date: utc8Date(-1, now), score: 0 }] } },
      },
      {
        match: (url) => url.includes('/streak'),
        body: { code: 0, data: { streak: { days: 3 }, makeup_cards: { balance: 0 } } },
      },
    ])
    const result = await makeupYesterday(CRED, PRODUCT, fetcher, now)
    expect(result.skipped).toBe(true)
    expect(calls.some((call) => call.url.includes('/makeup-cards/use'))).toBe(false)
  })
})

describe('listGrowthTasks（面板任务清单）', () => {
  it('合并两族端点，并同时认 task_code 与 code 两种码字段', async () => {
    const { fetcher } = routedFetcher([
      {
        match: (url) => url.includes('/v2/activity/growth/tasks'),
        body: {
          code: 0,
          data: {
            tasks: [
              {
                task_code: 'chat_5',
                title: '对话 5 次',
                reward_credit: 100,
                reward_energy: 5,
                accept_status: 'in_progress',
                progress: { current: 2, target: 5 },
              },
              { task_code: 'wb_wechat_oa_subscribe_task', title: '订阅服务号', accept_status: 'not_accepted' },
            ],
          },
        },
      },
      {
        match: (url) => url.includes('/activity/growth/tasks') && !url.includes('/v2/'),
        body: {
          code: 0,
          data: {
            tasks: [
              { code: 'first_chat', title: '完成一次对话', current: 0, target: 1, status: 'available' },
            ],
          },
        },
      },
    ])
    const result = await listGrowthTasks(CRED, PRODUCT, fetcher)
    expect(result.ok).toBe(true)
    const codes = result.tasks.map((task) => task.taskCode)
    expect(codes).toEqual(['chat_5', 'wb_wechat_oa_subscribe_task', 'first_chat'])
    const chat5 = result.tasks[0]
    expect(chat5?.progress).toBe('2/5')
    expect(chat5?.reward).toBe('+100 积分 +5 能量')
    expect(chat5?.reach).toBe('api')
    // 需客户端的码优先级高于白名单（否则面板会显示成「可自动」）
    expect(result.tasks[1]?.reach).toBe('client')
    expect(CLIENT_ONLY_TASK_CODES.has('wb_wechat_oa_subscribe_task')).toBe(true)
    // 等级族：码字段是 code、进度是平铺字段
    expect(result.tasks[2]?.progress).toBe('0/1')
  })
})

describe('fetchBuddyInfo / 领养门槛', () => {
  it('data.buddy 为 null ⇒ 还没领养', async () => {
    const { fetcher } = routedFetcher([{ match: () => true, body: { code: 0, data: { buddy: null } } }])
    const info = await fetchBuddyInfo(CRED, PRODUCT, fetcher)
    expect(info.ok).toBe(true)
    expect(info.hasBuddy).toBe(false)
  })

  it('已有猫 ⇒ 带上名字', async () => {
    const { fetcher } = routedFetcher([
      { match: () => true, body: { code: 0, data: { buddy: { id: 1, name: '小橘' } } } },
    ])
    const info = await fetchBuddyInfo(CRED, PRODUCT, fetcher)
    expect(info.hasBuddy).toBe(true)
    expect(info.name).toBe('小橘')
  })

  it('first_buddy 门槛未达必须识别成「明天再试」而不是失败', () => {
    expect(isBuddyAdoptNotReady('first_buddy task not completed yet')).toBe(true)
    expect(isBuddyAdoptNotReady('whatever')).toBe(false)
  })
})

describe('总览快照与摘要', () => {
  it('fetchGrowthCenterSnapshot 逐项容错：连登失败不影响旅行读数', async () => {
    const { fetcher } = routedFetcher([
      { match: (url) => url.includes('/streak'), body: { code: 500, msg: 'boom' } },
      { match: (url) => url.includes('/lottery/summary'), body: { code: 0, data: { chances: 2 } } },
      {
        match: (url) => url.includes('/travel/status'),
        body: { code: 0, data: { state: 'idle' } },
      },
      { match: () => true, body: { code: 0, data: { buddy: null } } },
    ])
    const snapshot = await fetchGrowthCenterSnapshot(CRED, PRODUCT, fetcher)
    expect(snapshot.ok).toBe(true)
    expect(snapshot.streak?.ok).toBe(false)
    expect(snapshot.lottery?.chances).toBe(2)
    expect(snapshot.travel?.state).toBe('idle')
  })

  it('summarizeGrowthExtras 只列有信息量的项（跳过类不进摘要）', () => {
    const extras = toRpcGrowthExtras({
      gift: { ok: true, credit: 0, message: '已领取' },
      makeup: { ok: true, skipped: true, message: '昨日未漏签' },
      streak: { ok: true, days: 8, redeemed: ['7d'], message: '连登 8 天' },
      lottery: { ok: true, chances: 1, drawn: 1, message: '已抽奖 1 次' },
      travel: { ok: true, action: 'depart', credit: 0, message: '已派出' },
      adopt: { ok: false, skipped: true, message: '门槛未达' },
    })
    const text = summarizeGrowthExtras(extras)
    expect(text).toContain('连登兑换 7d')
    expect(text).toContain('抽奖 1 次')
    expect(text).toContain('旅行已派出')
    expect(text).not.toContain('昨日未漏签')
  })

  it('全跳过时给出「无可执行项」而不是空串', () => {
    const extras = toRpcGrowthExtras({
      gift: { ok: true, credit: 0, skipped: true, message: '已领取' },
      makeup: { ok: true, skipped: true, message: '昨日未漏签' },
      streak: { ok: true, days: 1, redeemed: [], message: '' },
      lottery: { ok: true, chances: 0, drawn: 0, skipped: true, message: '无抽奖次数' },
      travel: { ok: false, action: 'skip', credit: 0, message: '在途' },
      adopt: { ok: true, skipped: true, message: '已有 Buddy' },
    })
    expect(summarizeGrowthExtras(extras)).toBe('扩展收益无可执行项')
  })
})
