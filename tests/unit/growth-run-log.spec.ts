import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GROWTH_RUN_FILE,
  configureGrowthRunLog,
  growthRunOf,
  readGrowthRunLog,
  recordGrowthRun,
  resetGrowthRunLogForTests,
  sanitizeGrowthRunLog,
} from '../../src/growth-run-log.js'

/**
 * 「成长中心上次执行结果」持久化的判据。
 *
 * 背景（用户诉求原文）：「点了做任务 本仓好像没反应，是默默做的，没地方查询和展示
 * 对吗」—— 结果本来就存在，只是随 toast 一起消失。本文件锁的是「**落盘 + 回读**」
 * 这条承重腿：脏数据不许让面板崩，写失败不许影响领取结果。
 */

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-growth-run-'))
  process.env.DSH_JET_HUB_STATE_DIR = home
  resetGrowthRunLogForTests()
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  delete process.env.DSH_JET_HUB_STATE_DIR
  resetGrowthRunLogForTests()
})

describe('sanitizeGrowthRunLog', () => {
  it('非法输入一律回落空表（不抛错）', () => {
    expect(sanitizeGrowthRunLog(undefined)).toEqual({ runs: {} })
    expect(sanitizeGrowthRunLog([])).toEqual({ runs: {} })
    expect(sanitizeGrowthRunLog({ runs: 'nope' })).toEqual({ runs: {} })
  })

  it('缺 at 的条目被丢弃（无法排序的历史等于噪声）', () => {
    const doc = sanitizeGrowthRunLog({
      runs: {
        'a': { summary: '无时间戳' },
        'b': { at: 1000, summary: 'ok' },
      },
    })
    expect(Object.keys(doc.runs)).toEqual(['b'])
  })

  it('摘要截断到 400 字符（脏数据不该撑大文档）', () => {
    const doc = sanitizeGrowthRunLog({ runs: { a: { at: 1, summary: 'x'.repeat(900) } } })
    expect(doc.runs['a']?.summary).toHaveLength(400)
  })
})

describe('recordGrowthRun / growthRunOf', () => {
  it('落盘后可回读，且文件就在 jet-hub 目录下', () => {
    recordGrowthRun('buddy-1', {
      at: 1791082455785,
      summary: '完成 5 项，领取 3 项（+300 积分）；连登兑换 7d',
      completed: 5,
      failed: 0,
      claimedCount: 3,
      claimedCredit: 300,
      extras: { streak: { ok: true, message: '连登 8 天', days: 8, redeemed: ['7d'] } },
    })
    const entry = growthRunOf('buddy-1')
    expect(entry?.claimedCredit).toBe(300)
    expect(entry?.extras?.streak?.redeemed).toEqual(['7d'])
    // 真的落盘了（不是只在内存里）
    const raw = JSON.parse(readFileSync(join(home, 'jet-hub', GROWTH_RUN_FILE), 'utf-8')) as {
      runs: Record<string, { summary: string }>
    }
    expect(raw.runs['buddy-1']?.summary).toContain('连登兑换 7d')
  })

  it('后一次记录覆盖同账号的前一次（只留「最近一次」）', () => {
    recordGrowthRun('buddy-1', { at: 1, summary: '第一次', completed: 0, failed: 0, claimedCount: 0, claimedCredit: 0 })
    recordGrowthRun('buddy-1', { at: 2, summary: '第二次', completed: 0, failed: 0, claimedCount: 0, claimedCredit: 0 })
    expect(growthRunOf('buddy-1')?.summary).toBe('第二次')
    expect(Object.keys(readGrowthRunLog().runs)).toEqual(['buddy-1'])
  })

  it('空 accountId 直接忽略（不写脏键）', () => {
    recordGrowthRun('', { at: 1, summary: 'x', completed: 0, failed: 0, claimedCount: 0, claimedCredit: 0 })
    expect(Object.keys(readGrowthRunLog().runs)).toEqual([])
  })

  it('configureGrowthRunLog 后仍能回读（注入 ctx 不清镜像）', () => {
    recordGrowthRun('buddy-2', { at: 3, summary: '注入前', completed: 0, failed: 0, claimedCount: 0, claimedCredit: 0 })
    configureGrowthRunLog({ logger: { warn: () => {} } } as never)
    expect(growthRunOf('buddy-2')?.summary).toBe('注入前')
  })
})
