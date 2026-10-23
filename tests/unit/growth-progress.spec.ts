import { describe, expect, it } from 'vitest'
import {
  beginGrowthRun,
  completeGrowthAccount,
  describeGrowthProgress,
  finishGrowthRun,
  growthRunActive,
  readGrowthProgress,
  reportGrowthStep,
  resetGrowthProgressForTests,
} from '../../src/growth-progress.js'

/**
 * 成长任务**实时进度**的判据。
 *
 * 用户报障原文：
 * > 「看不到任务执行进度，至少也要给到一个状态行，告知当前哪个号正在做什么任务」
 * > 「面板切走了，任务在后台还会做吗？还是会停止？这个要在画面说明出来」
 *
 * 本文件锁「宿主侧进度表」的生命周期：它必须**能回答**「谁在跑、跑到哪、还在不在跑」，
 * 且**不得**在异常路径上卡在 running（否则面板会永远显示「执行中」并禁用按钮）。
 */

describe('一轮的完整生命周期', () => {
  it('begin → 报步骤 → 推进分母 → finish', () => {
    resetGrowthProgressForTests()
    const runId = beginGrowthRun('buddy', 3)
    expect(growthRunActive('buddy')).toBe(true)
    reportGrowthStep('buddy', 'a1', '账号一', '签到')
    let state = readGrowthProgress('buddy')
    expect(state?.running).toBe(true)
    expect(state?.current).toMatchObject({ accountId: 'a1', nickname: '账号一', text: '签到' })
    expect(state?.totalAccounts).toBe(3)
    expect(state?.doneAccounts).toBe(0)

    completeGrowthAccount('buddy')
    reportGrowthStep('buddy', 'a2', '账号二', '任务 chat_5：发一条对话')
    state = readGrowthProgress('buddy')
    expect(state?.doneAccounts).toBe(1)
    expect(describeGrowthProgress(state)).toContain('账号二')
    expect(describeGrowthProgress(state)).toContain('任务 chat_5')
    // 状态行必须能看出「第几个 / 共几个」
    expect(describeGrowthProgress(state)).toContain('2/3')

    finishGrowthRun('buddy', runId, '本轮结束：3 个账号')
    state = readGrowthProgress('buddy')
    expect(state?.running).toBe(false)
    expect(state?.finishedAt).toBeTypeOf('number')
    expect(describeGrowthProgress(state)).toContain('本轮结束')
    expect(growthRunActive('buddy')).toBe(false)
  })

  it('doneAccounts 不会超过 totalAccounts（多调一次 complete 也不越界）', () => {
    resetGrowthProgressForTests()
    beginGrowthRun('buddy', 1)
    completeGrowthAccount('buddy')
    completeGrowthAccount('buddy')
    expect(readGrowthProgress('buddy')?.doneAccounts).toBe(1)
  })

  it('「账号 N/M」在最后一个账号时不会显示成 M+1/M', () => {
    resetGrowthProgressForTests()
    beginGrowthRun('buddy', 2)
    completeGrowthAccount('buddy')
    completeGrowthAccount('buddy')
    reportGrowthStep('buddy', 'b', '末号', '抽奖')
    expect(describeGrowthProgress(readGrowthProgress('buddy'))).toContain('账号 2/2')
  })
})

describe('防重入与迟到回调', () => {
  it('已结束的轮**不接受**迟到进度（不能被改回「进行中」）', () => {
    resetGrowthProgressForTests()
    const runId = beginGrowthRun('buddy', 1)
    finishGrowthRun('buddy', runId, 'done')
    reportGrowthStep('buddy', 'late', '迟到', '补领 x')
    completeGrowthAccount('buddy')
    const state = readGrowthProgress('buddy')
    expect(state?.running).toBe(false)
    expect(state?.current).toBeUndefined()
    expect(state?.doneAccounts).toBe(0)
  })

  it('旧轮的 finish 不得把新轮标成结束（runId 不匹配即忽略）', () => {
    resetGrowthProgressForTests()
    const first = beginGrowthRun('buddy', 1)
    const second = beginGrowthRun('buddy', 2)
    expect(first).not.toBe(second)
    finishGrowthRun('buddy', first, '旧轮收尾')
    expect(growthRunActive('buddy')).toBe(true)
    expect(readGrowthProgress('buddy')?.runId).toBe(second)
  })

  it('没有 runId 时照常收尾（兼容「异常兜底」那种不知道 id 的路径）', () => {
    resetGrowthProgressForTests()
    beginGrowthRun('buddy', 1)
    finishGrowthRun('buddy', undefined, undefined, 'boom')
    const state = readGrowthProgress('buddy')
    expect(state?.running).toBe(false)
    expect(describeGrowthProgress(state)).toContain('boom')
  })
})

describe('provider 分槽', () => {
  it('不同 provider 互不干扰（切渠道时不显示别人的进度）', () => {
    resetGrowthProgressForTests()
    beginGrowthRun('buddy', 2)
    expect(growthRunActive('workbuddy')).toBe(false)
    expect(readGrowthProgress('workbuddy')).toBeUndefined()
    reportGrowthStep('workbuddy', 'x', 'x', 'step')
    expect(readGrowthProgress('workbuddy')).toBeUndefined()
  })
})

describe('describeGrowthProgress 的文案', () => {
  it('没有状态时返回空串（UI 据此回落到「上次执行」）', () => {
    expect(describeGrowthProgress(undefined)).toBe('')
  })

  it('没有 current 时显示「准备中」而不是空白', () => {
    resetGrowthProgressForTests()
    beginGrowthRun('buddy', 1)
    expect(describeGrowthProgress(readGrowthProgress('buddy'))).toContain('准备中')
  })
})
