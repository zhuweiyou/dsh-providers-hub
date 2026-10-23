import { describe, expect, it } from 'vitest'
import {
  accountSummary,
  backgroundHint,
  extrasFailures,
  extrasLines,
  growthCardTitle,
  growthHeadline,
  growthHint,
  growthTone,
  lastRunDigest,
  lastRunText,
  overviewCostHint,
  overviewIdleHint,
  overviewLoadedHint,
  overviewLoadingHint,
  overviewStaleHint,
  progressLine,
  runOf,
  shouldRenderGrowthCard,
  summarizeTasks,
  taskReachText,
  taskStatusText,
  tierText,
} from '../../plugin-src/client/growth-center-logic.js'

/**
 * 成长任务中心面板的**纯展示逻辑**判据。
 *
 * 为什么要有这一层：`jet-hub.js` 无法被单测覆盖（仓库里没有 react，组件不渲染），
 * 本仓库为此立过规矩 —— 文案与判据必须抽成纯函数（见 `compensation-panel-logic.js`
 * 的模块头，那里的初版把文案内联在 JSX 三元里，漏掉一个 P0 而全绿）。
 */

describe('taskStatusText / taskReachText', () => {
  it('已知状态翻中文，未知状态**原样返回**（不吞线索）', () => {
    expect(taskStatusText('not_accepted')).toBe('未接取')
    expect(taskStatusText('claimed')).toBe('已领取')
    expect(taskStatusText('weird_status')).toBe('weird_status')
    expect(taskStatusText('')).toBe('未知')
  })

  it('reach 三档：可自动 / 需客户端 / 未接线', () => {
    expect(taskReachText('api')).toBe('可自动')
    expect(taskReachText('client')).toBe('需客户端')
    expect(taskReachText('unknown')).toBe('未接线')
  })
})

describe('summarizeTasks', () => {
  it('四类计数互不污染：已领取不再计入可自动', () => {
    const counts = summarizeTasks([
      { taskCode: 'a', status: 'in_progress', reach: 'api' },
      { taskCode: 'b', status: 'not_accepted', reach: 'client', claimable: true },
      { taskCode: 'c', status: 'claimed', reach: 'api' },
      { taskCode: 'd', status: 'completed', reach: 'unknown', claimable: true },
    ])
    expect(counts).toEqual({ total: 4, api: 1, client: 1, claimable: 2, claimed: 1 })
  })

  it('缺数据时返回全 0 而不是抛错', () => {
    expect(summarizeTasks(undefined)).toEqual({ total: 0, api: 0, client: 0, claimable: 0, claimed: 0 })
  })
})

describe('accountSummary', () => {
  it('把连登/抽奖/旅行/未领养/任务进度拼成一行', () => {
    const text = accountSummary({
      streak: { days: 9, makeupCards: 2 },
      lottery: { chances: 3, enabled: true },
      travel: { state: 'idle' },
      hasBuddy: false,
      tasks: [
        { taskCode: 'a', status: 'claimed', reach: 'api' },
        { taskCode: 'b', status: 'in_progress', reach: 'api' },
      ],
    })
    expect(text).toBe('连登 9 天，补签卡 2 · 抽奖次数 3 · 旅行 空闲 · 未领养 Buddy（可 +300） · 任务 1/2 已领')
  })

  it('缺块不占位（不写「连登：—」这类破折号噪声）', () => {
    expect(accountSummary({ streak: { days: 1 } })).toBe('连登 1 天')
    expect(accountSummary({})).toBe('')
  })

  it('抽奖活动关闭时不显示次数', () => {
    const text = accountSummary({ lottery: { chances: 5, enabled: false } })
    expect(text).toBe('')
  })
})

describe('tierText', () => {
  it('带上抽奖次数，状态走中文', () => {
    expect(tierText({ tier: '7d', status: 'available', chances: 1 })).toBe('7d：可兑换，1 次抽奖')
    expect(tierText({ tier: '28d', status: 'claimed' })).toBe('28d：已兑换')
    expect(tierText({ tier: '' })).toBe('')
  })
})

describe('lastRunText', () => {
  it('时间 + 摘要', () => {
    const at = Date.parse('2026-10-23T06:05:00Z')
    const text = lastRunText({ at, summary: '完成 5 项' })
    // 本机时区不同只断言含摘要与日期片段，避免时区脆断言
    expect(text).toContain('完成 5 项')
    expect(text).toMatch(/\d{2}:\d{2}/)
  })

  it('没有记录时返回空串（卡片据此不渲染那一行）', () => {
    expect(lastRunText(undefined)).toBe('')
    expect(lastRunText({ at: 0, summary: '' })).toBe('')
  })
})

describe('extrasLines / extrasFailures', () => {
  const extras = {
    gift: { ok: true, credit: 300, message: '新手礼包 +300 积分' },
    makeup: { ok: true, skipped: true, message: '昨日未漏签' },
    streak: { ok: true, redeemed: ['7d', '14d'], message: '' },
    lottery: { ok: true, drawn: 2, message: '' },
    travel: { ok: true, action: 'claim', credit: 60, message: '' },
    adopt: { ok: true, skipped: true, message: '已有 Buddy' },
  }

  it('只列有信息量的项（跳过类不出现）', () => {
    expect(extrasLines(extras)).toEqual(['礼包 +300', '连登兑换 7d/14d', '抽奖 2 次', '旅行 +60'])
  })

  it('失败项与跳过项分开：skipped 不算失败', () => {
    expect(extrasFailures(extras)).toEqual([])
    expect(extrasFailures({
      lottery: { ok: false, drawn: 0, message: '抽奖在第 1 次失败：insufficient energy' },
      travel: { ok: false, action: 'none', message: '领奖失败' },
    })).toEqual(['抽奖在第 1 次失败：insufficient energy', '领奖失败'])
  })

  it('缺 extras 时两条都返回空数组', () => {
    expect(extrasLines(undefined)).toEqual([])
    expect(extrasFailures(undefined)).toEqual([])
  })
})

describe('卡片文案与色调', () => {
  it('headline 带账号数与失败数', () => {
    expect(growthHeadline({ loading: false, accounts: [{ ok: true }, { ok: false }] }))
      .toBe('成长任务中心 · 2 个账号（1 个读取失败）')
    expect(growthHeadline({ accounts: [] })).toBe('成长任务中心 · 无账号')
    expect(growthHeadline({ loading: true })).toContain('读取中')
  })

  it('hint 点明「读取是只读的」与「结果会写在这里」', () => {
    const hint = growthHint({ accounts: [{ lastRun: { at: Date.parse('2026-10-23T02:00:00Z') } }] })
    expect(hint).toContain('上次执行')
    expect(hint).toContain('一键领取积分 + 成长任务')
    expect(growthHint({ accounts: [{ lastRun: { at: 0 } }] })).toContain('还没有执行记录')
  })

  it('tone：读取失败→warn；有可领→ok；其余→idle', () => {
    expect(growthTone({ accounts: [{ ok: false }] })).toBe('warn')
    expect(growthTone({ accounts: [{ ok: true, tasks: [{ status: 'completed', reach: 'api', claimable: true }] }] })).toBe('ok')
    expect(growthTone({ accounts: [{ ok: true, tasks: [] }] })).toBe('idle')
  })

  it('卡片**只对 buddy** 渲染，且不要求先有数据（常驻入口）', () => {
    expect(shouldRenderGrowthCard('buddy')).toBe(true)
    expect(shouldRenderGrowthCard('workbuddy')).toBe(false)
    expect(shouldRenderGrowthCard('codearts')).toBe(false)
  })
})

/**
 * 2026-10-23 用户两条报障的判据：
 *
 * 1. > 「这个要弄个按钮点了才读取，而不是打开插件面板就读取，这样每次都要向上游发
 *    >  API 请求太多了」
 * 2. > 「看不到任务执行进度，至少也要给到一个状态行…还有面板切走了，任务在后台还会做吗？」
 */
describe('按需读取的文案（成本必须写在按钮旁）', () => {
  it('成本提示带账号数与总请求量（让用户自己决定读不读）', () => {
    expect(overviewCostHint(6)).toBe('读取会向每个账号发约 6 个只读请求（当前 6 个账号，共约 36 个）')
    expect(overviewCostHint(1)).toContain('共约 6 个')
    expect(overviewCostHint(0)).toContain('还没有账号')
    // 非法输入不得崩/不得写出 NaN
    expect(overviewCostHint(undefined)).toContain('还没有账号')
  })

  it('「还没读」与「读了但失败」必须可辨', () => {
    expect(overviewIdleHint()).toContain('手动读取')
    expect(overviewIdleHint()).toContain('不会自动请求上游')
    expect(overviewStaleHint()).toContain('执行前的快照')
  })

  it('已读取时显示快照时间', () => {
    const text = overviewLoadedHint(Date.parse('2026-10-23T06:05:00Z'))
    expect(text).toContain('快照')
    expect(text).toMatch(/\d{2}:\d{2}/)
    expect(overviewLoadedHint(0)).toContain('快照')
  })

  it('读取中要说明「要多久 / 在做什么」（否则看起来像卡死）', () => {
    expect(overviewLoadingHint(6)).toContain('6 个账号')
    expect(overviewLoadingHint(6)).toContain('请稍等')
    expect(overviewLoadingHint(0)).toContain('正在读取')
  })
})

describe('状态行（正在跑哪个号 / 在做什么）', () => {
  it('running 时给出「正在跑 X · 步骤 · 账号 2/3」三段', () => {
    const line = progressLine({
      running: true,
      doneAccounts: 1,
      totalAccounts: 3,
      current: { accountId: 'a2', nickname: '1776****', text: '任务 chat_5：发一条对话' },
    })
    expect(line).toContain('正在跑 1776')
    expect(line).toContain('任务 chat_5')
    expect(line).toContain('账号 2/3')
  })

  it('没有 current 时回落「准备中」，不是空白', () => {
    expect(progressLine({ running: true, doneAccounts: 0, totalAccounts: 2 })).toContain('准备中')
  })

  it('结束后显示摘要；有 error 时显示异常', () => {
    expect(progressLine({ running: false, summary: '本轮结束：3 个账号' })).toBe('本轮结束：3 个账号')
    expect(progressLine({ running: false, error: 'boom' })).toBe('执行异常：boom')
    expect(progressLine({ running: false })).toBe('')
    expect(progressLine(null)).toBe('')
  })

  it('背景语义说明必须讲清「切走不会中断」+「进度轮询不吃上游」', () => {
    const text = backgroundHint()
    expect(text).toContain('不会中断')
    expect(text).toContain('宿主进程')
    expect(text).toContain('不请求上游')
  })
})

describe('lastRunDigest / runOf / growthCardTitle', () => {
  const runs = [
    { accountId: 'a1', at: Date.parse('2026-10-23T06:00:00Z'), summary: '完成 3 项' },
    { accountId: 'a2', at: Date.parse('2026-10-23T05:00:00Z'), summary: '完成 1 项' },
  ]

  it('digest 给出最近时间与账号数', () => {
    expect(lastRunDigest(runs)).toContain('2 个账号有记录')
    expect(lastRunDigest([])).toBe('本机还没有执行记录')
    expect(lastRunDigest(undefined)).toBe('本机还没有执行记录')
  })

  it('runOf 只取该账号那条；账号不在记录里返回空串', () => {
    expect(runOf(runs, 'a2')).toContain('完成 1 项')
    expect(runOf(runs, 'zzz')).toBe('')
    expect(runOf(undefined, 'a1')).toBe('')
  })

  it('标题区分「未读清单 / 执行中 / 已读」三种状态', () => {
    // 未读清单时**不能说「无账号」**（用户会以为账号丢了）
    expect(growthCardTitle({ accountCount: 4, overview: null, progress: null }))
      .toBe('成长任务中心 · 4 个账号（清单未读取）')
    expect(growthCardTitle({ accountCount: 0, overview: null })).toBe('成长任务中心 · 无账号')
    expect(growthCardTitle({ accountCount: 4, overview: { loading: true } })).toContain('读取中')
    expect(growthCardTitle({ accountCount: 4, progress: { running: true, totalAccounts: 4 } }))
      .toBe('成长任务中心 · 执行中（4 个账号）')
    expect(growthCardTitle({
      accountCount: 2,
      overview: { accounts: [{ ok: true }, { ok: false }] },
      progress: { running: false },
    })).toBe('成长任务中心 · 2 个账号（1 个读取失败）')
  })
})
