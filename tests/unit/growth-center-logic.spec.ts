import { describe, expect, it } from 'vitest'
import {
  accountSummary,
  extrasFailures,
  extrasLines,
  growthHeadline,
  growthHint,
  growthTone,
  lastRunText,
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
