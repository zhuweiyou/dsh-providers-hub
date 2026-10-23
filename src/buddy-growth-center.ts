/**
 * CodeBuddy 成长中心**扩展收益**客户端：连登兑换 / 抽奖 / 猫猫旅行 / 新手礼包 /
 * 补签 / 领养。
 *
 * ## 为什么单开一个文件
 *
 * `src/buddy-growth.ts` 已经 2900+ 行、只管两件事（任务清单 / 任务判据上报）。
 * 本节这批端点与「任务」是**两条独立收益链**：判据由行为事件点亮，而它们由
 * **纯 RPC** 发放（兑换档位、抽奖、旅行到站、礼包、补签）。混进去会让那个文件
 * 的「任务」语义被稀释，也没法按收益单独开关。
 *
 * ## 端点与主机（逐条有实测依据，别凭直觉改）
 *
 * | 动作 | 方法 | 路径 | 主机 |
 * |---|---|---|---|
 * | 连登状态 | GET | `/activity/growth/streak` | `product.endpoint`（copilot） |
 * | 档位兑换 | POST | `/activity/growth/redeem` | 同上 |
 * | 抽奖次数 | GET | `/activity/growth/lottery/summary` | 同上 |
 * | 抽奖一次 | POST | `/activity/growth/lottery/draw` | 同上 |
 * | 旅行状态 | GET | `/activity/growth/buddy/travel/status` | 同上 |
 * | 派出旅行 | POST | `/activity/growth/buddy/travel/depart` | 同上 |
 * | 旅行领奖 | POST | `/activity/growth/buddy/travel/claim` | 同上 |
 * | 猫档案 | GET | `/activity/growth/buddy/info` | 同上 |
 * | 采纳协议 | POST | `/activity/growth/buddy/agreement` | 同上 |
 * | 领养 | POST | `/activity/growth/buddy/first` | 同上 |
 * | 签到热力 | GET | `/activity/growth/heatmap` | 同上 |
 * | 补签卡使用 | POST | `/activity/growth/makeup-cards/use` | 同上 |
 * | 新手礼包 | POST | `/billing/meter/claim-gift` | `product.webBase`（workbuddy.cn） |
 *
 * 端点与主机口径来自参考实现 `linguo2625469/workbuddy2api-panel`
 * （`internal/upstream/streak.go` / `travel.go` / `blackcat.go` /
 * `internal/scheduler/streak.go` / `travel.go`），并与本仓库既有的
 * `buddy-compensation.ts`（billing 域实测 200 的 host 是三选一）互相印证。
 *
 * ⚠️ **billing 域刻意走 `webBase`** 而不是参考实现里的 `BillingBaseCN`
 * （`https://www.codebuddy.cn`）：本仓库 `buddy-compensation.ts` 的模块头已实测
 * 「三 host 全可达且报文一致」，而 `webBase` 是与用户看到的按钮**逐字同源**的那个
 * 站；另立一个常量会让同一类请求出现两个基址（本仓库反复踩过的「一文件两套同义
 * 判据」）。
 *
 * ## 安全边界（哪些能进「一键领积分」）
 *
 * 下面这些**都是幂等、无代价**的（重复调用由服务端终态兜住，不会重复计分）：
 * 兑换（未解锁 403 / 已兑换 `claimed`）、抽奖（按 `chances` 上限抽）、旅行（每日
 * 1 次，`daily_limit_reached` 兜住）、补签（无卡或昨日已签则静默跳过）、礼包
 * （已领返回业务错误）。
 *
 * ⇒ 它们**可以**挂在 `credits.claimAll` 的成长侧（每日一次）。
 *
 * ⚠️ **领养（`buddy/first`）是一次性写操作**，且**有前置门槛**：服务端要求
 * `first_buddy` 任务已完成（即当日已有活跃上报），否则回 HTTP 400
 * `first_buddy task not completed yet`。该错误**不是失败**，是「今天还没点亮，
 * 明天再试」，故归 `optional` 且不计 failed（见 {@link isBuddyAdoptNotReady}）。
 *
 * ⚠️ **盲盒（`/v2/activity/growth/buddy/open`）刻意不进本模块**：它会消耗能量且
 * 奖励是限定款 Buddy，属「有代价 / 一次性解锁」，与本仓库既有铁律一致
 * （`buddy-growth.ts` 的 `runExotic` 默认关闭）。
 *
 * @module src/buddy-growth-center.ts
 */

import { randomUUID } from 'node:crypto'
import type { BuddyCredential } from './buddy.js'
import type { BuddyProduct } from './product.js'
import {
  baseOf,
  claimBaseOf,
  classifyGrowthWrite,
  getGrowthJson,
  GROWTH_FIRST_BUDDY_PATH,
  GROWTH_TASK_COMPLETION,
  GROWTH_TASKS_PATHS,
  GROWTH_TRAVEL_CLAIM_PATH,
  GROWTH_TRAVEL_STATUS_PATH,
  postGrowthJson,
  readNumber,
  readString,
  webBaseOf,
} from './buddy-growth.js'
import type { GrowthCallResult } from './buddy-growth.js'
import type {
  RpcBuddyGrowthExtras,
  RpcBuddyGrowthOverviewTask,
  RpcBuddyGrowthStep,
} from './types.js'

/** 连登状态路径：**两个候选**，命中即用（见 {@link fetchStreakDetail}）。 */
export const STREAK_PATHS = ['/activity/growth/streak', '/v2/activity/growth/streak'] as const

/** 连登档位兑换（`tier` 取 `7d`/`14d`/`28d`，`client_token` 幂等令牌）。 */
export const STREAK_REDEEM_PATH = '/activity/growth/redeem'

/** 抽奖次数查询。 */
export const LOTTERY_SUMMARY_PATH = '/activity/growth/lottery/summary'

/**
 * 抽奖一次。
 *
 * ⚠️ 路径**不带 `/v2`**（参考实现实测口径）。`buddy-growth.ts` 里另有一枚
 * `GROWTH_LOTTERY_PATH = '/v2/activity/growth/lottery/draw'` —— 那是早期按
 * 「成长族都带 /v2」推断出来的，**零生产调用方**（只被死代码 `claimAllGrowth`
 * 的 `runExotic` 引用）。本常量是权威口径，新增代码一律用它。
 */
export const LOTTERY_DRAW_PATH = '/activity/growth/lottery/draw'

/** 签到热力图（补签前置：先确认昨日漏签）。 */
export const HEATMAP_PATH = '/activity/growth/heatmap'

/** 使用补签卡（body `{target_date}`）。 */
export const MAKEUP_USE_PATH = '/activity/growth/makeup-cards/use'

/** 猫档案（`data.buddy` 为 `null` ⇒ 还没领养）。 */
export const BUDDY_INFO_PATH = '/activity/growth/buddy/info'

/** 采纳协议（幂等，重复调用无副作用；领养前**必须**先签）。 */
export const BUDDY_AGREEMENT_PATH = '/activity/growth/buddy/agreement'

/** 派出旅行（地点 1~4 收益/时长区间相同，固定 4 即可）。 */
export const TRAVEL_DEPART_PATH = '/activity/growth/buddy/travel/depart'

/** 新手礼包（每号一次，已领返回业务错误）。 */
export const CLAIM_GIFT_PATH = '/billing/meter/claim-gift'

/** 旅行地点：4 个地点收益/时长区间完全相同，无最优解（参考实现同为 4）。 */
const TRAVEL_LOCATION_ID = 4

/** 单次抽奖上限：防上游下发异常大的 `chances` 时打穿时间预算。 */
export const MAX_LOTTERY_DRAWS = 10

/** 请求超时（与成长侧其它请求同口径）。 */
const REQUEST_TIMEOUT_MS = 30_000

/** 步骤结果（统一形状，便于 UI 逐项展示）。 */
export interface StepOutcome {
  /** `true` = 本次真的到账/推进了；`false` 见 `message`。 */
  ok: boolean
  /** 给用户看的一句话（保留上游原文，那是排障唯一线索）。 */
  message: string
  /**
   * `true` = 该步骤**结构上不适用**（无猫、无补签卡、无抽奖次数…），
   * 属正常终态，UI 不该染红。
   */
  skipped?: boolean
}

/** 连登档位。字段名逐字对齐上游（`tier`/`days`/`credit`/`energy`/`cards`/`chances`）。 */
export interface StreakTier {
  tier: string
  days: number
  credit: number
  energy: number
  cards: number
  chances: number
  /** 上游状态：`locked`（未解锁）/ `available`（可兑换）/ `claimed`（已兑换）。 */
  status: string
}

/** 连登详情。 */
export interface StreakDetail {
  ok: boolean
  /** 连续登录天数。 */
  days: number
  /** 本月累计天数。 */
  monthTotalDays: number
  /** 距下一档还差几天（上游 `next_tier_remaining`）。 */
  nextTierRemaining: number
  /** 补签卡余额 / 上限。 */
  makeupCards: number
  makeupCardsMax: number
  tiers: StreakTier[]
  /** 查询失败原因（`ok:false` 时有值）。 */
  message?: string
}

/** 抽奖状态。 */
export interface LotteryState {
  ok: boolean
  /** 可用抽奖次数。 */
  chances: number
  /** 活动是否开启（上游 `module.enabled`；缺字段按**开启**处理 —— 见函数注释）。 */
  enabled: boolean
  message?: string
}

/** 旅行状态。 */
export interface TravelState {
  ok: boolean
  /** `idle` / `traveling` / `arrived`（其它值原样透出）。 */
  state: string
  /** 今日已派出过（自然日 00:00 CST 重置）。 */
  dailyLimitReached: boolean
  /** 在途/到站记录 id（`claim` 必带）。 */
  recordId: number
  /** 到站可领积分（上游 `reward_credit`）。 */
  rewardCredit: number
  message?: string
}

/** 把信封的 `data` 取成对象（缺 `data` 返回 `{}`）。 */
function dataOf(result: GrowthCallResult): Record<string, unknown> {
  if (!result.ok) return {}
  const data = result.body.data
  if (typeof data !== 'object' || data === null) return {}
  return data as Record<string, unknown>
}

/** 读信封里的可读原因（失败时用；保留上游 msg）。 */
function messageOf(result: GrowthCallResult): string {
  if (!result.ok) return result.message
  const msg = readString(result.body, 'msg')
  const code = typeof result.body.code === 'number' ? result.body.code : -1
  if (msg.length > 0) return code === 0 ? msg : `上游拒绝（业务码 ${code}）：${msg}`
  return code === 0 ? '成功' : `上游拒绝（业务码 ${code}）`
}

/**
 * 生成 `client_token`（前端 `crypto.randomUUID()` 同款语义的幂等令牌）。
 *
 * ⚠️ 每次写请求**都要新的**：它是幂等键，复用同一个值会让上游把第二次兑换/抽奖
 * 当成「重复提交」直接丢弃，表现为「点了没反应」。
 */
function clientToken(): string {
  return randomUUID()
}

/** 取 UTC+8 的 `YYYY-MM-DD`（补签目标日期用；日界归服务端）。 */
export function utc8Date(offsetDays = 0, nowMs = Date.now()): string {
  return new Date(nowMs + offsetDays * 86_400_000 + 8 * 3_600_000).toISOString().slice(0, 10)
}

/**
 * 查询连登详情（只读）。
 *
 * ⚠️ **两个候选路径都试**（`/activity/growth/streak` 优先）：参考实现用的是
 * **不带 `/v2`** 的那条，而本仓库既有的 `fetchStreakStatus` 推断成了
 * `/v2/activity/growth/streak` —— 两条都没有实测证据能排除对方，故按「先权威、
 * 后兼容」的顺序探测，命中即用。第一响应非 `code 0` 时继续试下一条。
 *
 * ⚠️ **字段形状两种都认**：`data.streak.days`（参考实现口径，真实响应里
 * `streak` / `makeup_cards` / `redemption_status` 是同级的三个对象）与顶层的
 * `data.days`（本仓库旧 `fetchStreakStatus` 的假设）。只在一种形状上取值会让
 * 「连登天数」恒为 0 而没人报错 —— 那正是本仓库记过的「同义两套判据」形态。
 */
export async function fetchStreakDetail(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch = fetch,
): Promise<StreakDetail> {
  let lastMessage = ''
  for (const path of STREAK_PATHS) {
    const result = await getGrowthJson(path, credential, product, fetcher)
    if (!result.ok || result.body.code !== 0) {
      lastMessage = messageOf(result)
      continue
    }
    const data = dataOf(result)
    const streak = typeof data['streak'] === 'object' && data['streak'] !== null
      ? (data['streak'] as Record<string, unknown>)
      : data
    const cards = typeof data['makeup_cards'] === 'object' && data['makeup_cards'] !== null
      ? (data['makeup_cards'] as Record<string, unknown>)
      : {}
    const redemption = typeof data['redemption_status'] === 'object' && data['redemption_status'] !== null
      ? (data['redemption_status'] as Record<string, unknown>)
      : {}
    const rawTiers = Array.isArray(redemption['tiers']) ? redemption['tiers'] : []
    const tiers: StreakTier[] = []
    for (const raw of rawTiers) {
      if (typeof raw !== 'object' || raw === null) continue
      const item = raw as Record<string, unknown>
      const tier = readString(item, 'tier')
      if (tier.length === 0) continue
      // 状态字段名带档位后缀：`tier_7d_status` / `tier_14d_status` / `tier_28d_status`。
      const statusField = `tier_${tier.replace(/-/g, '')}_status`
      tiers.push({
        tier,
        days: readNumber(item, 'days'),
        credit: readNumber(item, 'credit'),
        energy: readNumber(item, 'energy'),
        cards: readNumber(item, 'cards'),
        chances: readNumber(item, 'chances'),
        status: readString(redemption, statusField) || readString(item, 'status'),
      })
    }
    return {
      ok: true,
      days: readNumber(streak, 'days'),
      monthTotalDays: readNumber(streak, 'month_total_days'),
      nextTierRemaining: readNumber(streak, 'next_tier_remaining'),
      makeupCards: readNumber(cards, 'balance'),
      makeupCardsMax: readNumber(cards, 'max'),
      tiers,
    }
  }
  return {
    ok: false,
    days: 0,
    monthTotalDays: 0,
    nextTierRemaining: 0,
    makeupCards: 0,
    makeupCardsMax: 0,
    tiers: [],
    message: lastMessage.length > 0 ? lastMessage : '连登状态查询失败',
  }
}

/**
 * 兑换所有**已解锁未兑换**的连登档位（写操作，幂等）。
 *
 * 判据只看 `status`：`locked`（未解锁，服务端也会 403）与 `claimed`（已兑换）
 * 直接跳过。⚠️ **不要**用「天数 ≥ 档位天数」自己算 —— 上游有补签卡与月度重置，
 * 本地推算会在边缘日给出错的结论；服务端 403 才是权威（按 `skipped` 处理，不报错）。
 */
export async function redeemUnlockedTiers(
  credential: BuddyCredential,
  product: BuddyProduct,
  detail: StreakDetail,
  fetcher: typeof fetch = fetch,
): Promise<{ redeemed: StreakTier[]; failed: string[] }> {
  const redeemed: StreakTier[] = []
  const failed: string[] = []
  for (const tier of detail.tiers) {
    if (tier.status === 'locked' || tier.status === 'claimed') continue
    const result = await postGrowthJson(
      STREAK_REDEEM_PATH,
      credential,
      product,
      { tier: tier.tier, client_token: clientToken() },
      fetcher,
    )
    const classified = classifyGrowthWrite(result)
    if (classified.state === 'success') {
      redeemed.push(tier)
      continue
    }
    // 403「连续登录天数不足」是正常终态（档位显示可点但服务端没解锁），静默跳过。
    const msg = classified.message
    if (/连续登录天数不足|not enough|locked/i.test(msg) || /HTTP 403/.test(msg)) continue
    failed.push(`${tier.tier}：${msg}`)
  }
  return { redeemed, failed }
}

/**
 * 查询抽奖次数（只读）。
 *
 * ⚠️ `module.enabled` **缺字段按开启**处理：上游对该字段的语义是「活动开关」，
 * 缺字段只说明响应形态变了，把它当关闭会让抽奖永久静默失效（`chances > 0` 却
 * 一次都不抽）。只有**显式 `false`** 才算关闭。
 */
export async function fetchLotteryState(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch = fetch,
): Promise<LotteryState> {
  const result = await getGrowthJson(LOTTERY_SUMMARY_PATH, credential, product, fetcher)
  if (!result.ok || result.body.code !== 0) {
    return { ok: false, chances: 0, enabled: false, message: messageOf(result) }
  }
  const data = dataOf(result)
  const module = typeof data['module'] === 'object' && data['module'] !== null
    ? (data['module'] as Record<string, unknown>)
    : undefined
  return {
    ok: true,
    chances: readNumber(data, 'chances'),
    enabled: module?.['enabled'] !== false,
  }
}

/**
 * 把当前抽奖次数抽完（写操作，有上限）。
 *
 * ⚠️ 每次抽奖都换新的 `client_token`（复用会让第 2..N 次被当成重复提交）。
 * ⚠️ 上限 {@link MAX_LOTTERY_DRAWS}：上游若下发异常大的次数（活动期攒了很多），
 * 无上限会打穿宿主的 RPC 时间预算。
 */
export async function drawAllLottery(
  credential: BuddyCredential,
  product: BuddyProduct,
  options: { maxDraws?: number; fetcher?: typeof fetch } = {},
): Promise<{ ok: boolean; chances: number; drawn: number; message: string }> {
  const fetcher = options.fetcher ?? fetch
  const cap = Math.max(0, Math.min(options.maxDraws ?? MAX_LOTTERY_DRAWS, MAX_LOTTERY_DRAWS))
  const state = await fetchLotteryState(credential, product, fetcher)
  if (!state.ok) return { ok: false, chances: 0, drawn: 0, message: state.message ?? '抽奖次数查询失败' }
  if (!state.enabled) return { ok: true, chances: state.chances, drawn: 0, message: '抽奖活动未开启' }
  if (state.chances <= 0) return { ok: true, chances: 0, drawn: 0, message: '无抽奖次数' }
  const target = Math.min(state.chances, cap)
  let drawn = 0
  const failures: string[] = []
  for (let index = 0; index < target; index += 1) {
    const result = await postGrowthJson(
      LOTTERY_DRAW_PATH,
      credential,
      product,
      { client_token: clientToken() },
      fetcher,
    )
    const classified = classifyGrowthWrite(result)
    if (classified.state === 'success') {
      drawn += 1
      continue
    }
    failures.push(classified.message)
    break
  }
  const truncated = state.chances > cap ? `（本轮上限 ${cap} 次，剩余下次继续）` : ''
  return {
    ok: failures.length === 0,
    chances: state.chances,
    drawn,
    message: failures.length > 0
      ? `抽奖在第 ${drawn + 1} 次失败：${failures.join('；')}`
      : `已抽奖 ${drawn} 次${truncated}`,
  }
}

/** 查询猫猫旅行状态（只读）。 */
export async function fetchTravelState(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch = fetch,
): Promise<TravelState> {
  const result = await getGrowthJson(GROWTH_TRAVEL_STATUS_PATH, credential, product, fetcher)
  if (!result.ok || result.body.code !== 0) {
    return {
      ok: false,
      state: '',
      dailyLimitReached: false,
      recordId: 0,
      rewardCredit: 0,
      message: messageOf(result),
    }
  }
  const data = dataOf(result)
  return {
    ok: true,
    state: readString(data, 'state'),
    dailyLimitReached: data['daily_limit_reached'] === true,
    recordId: readNumber(data, 'record_id'),
    rewardCredit: readNumber(data, 'reward_credit'),
  }
}

/** 旅行推进的结果动作（UI 据此显示「已派出 / 已领奖 / 在途跳过」）。 */
export type TravelAction = 'depart' | 'claim' | 'skip' | 'none'

/**
 * 推进猫猫旅行**一段**（写操作，每日最多一次派出）。
 *
 * 状态机（参考实现 `internal/scheduler/travel.go`）：
 * - `arrived` ⇒ 领奖（**必须**带 `record_id`；为 0 说明上游形态变了，跳过不瞎打）；
 * - `idle` 且未达当日上限 ⇒ 派出；
 * - `traveling` ⇒ 在途，跳过（今天已经派过了）；
 * - 其它 ⇒ 跳过。
 *
 * ⚠️ **本函数是「一次点击推一段」，不是循环**：派出后要等旅行时长才到站，
 * 所以「派出 → 领奖」天然落在两天。调用方每天调一次即可闭环。
 * ⚠️ 旧实现（`buddy-growth.ts` 的 `claimAllGrowth`）只发 claim 且**不带
 * `record_id`**（body 是 `{}`），而状态查询常量 `GROWTH_TRAVEL_STATUS_PATH`
 * 定义了却零引用 —— 于是旅行永远停在 `idle`，每天 0 收益。本函数是它的正解。
 */
export async function advanceTravel(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch = fetch,
): Promise<{ action: TravelAction; credit: number; state: TravelState; message: string }> {
  const state = await fetchTravelState(credential, product, fetcher)
  if (!state.ok) {
    return { action: 'none', credit: 0, state, message: `旅行状态查询失败：${state.message ?? '未知原因'}` }
  }
  if (state.state === 'arrived') {
    if (state.recordId <= 0) {
      return { action: 'skip', credit: 0, state, message: '已到站但上游未给 record_id，本轮不领取' }
    }
    const result = await postGrowthJson(
      GROWTH_TRAVEL_CLAIM_PATH,
      credential,
      product,
      { record_id: state.recordId },
      fetcher,
    )
    const classified = classifyGrowthWrite(result)
    if (classified.state === 'success') {
      const credit = readNumber(classified.data, 'reward_credit')
      return {
        action: 'claim',
        credit: credit > 0 ? credit : state.rewardCredit,
        state,
        message: credit > 0 ? `旅行到站，领取 +${credit} 积分` : '旅行到站，已领取奖励',
      }
    }
    return { action: 'none', credit: 0, state, message: `旅行领奖失败：${classified.message}` }
  }
  if (state.state === 'idle') {
    if (state.dailyLimitReached) {
      return { action: 'skip', credit: 0, state, message: '今日已派出过（00:00 CST 重置）' }
    }
    const result = await postGrowthJson(
      TRAVEL_DEPART_PATH,
      credential,
      product,
      { location_id: TRAVEL_LOCATION_ID },
      fetcher,
    )
    const classified = classifyGrowthWrite(result)
    if (classified.state === 'success') {
      return { action: 'depart', credit: 0, state, message: '已派出猫猫旅行（明天到站可领奖）' }
    }
    return { action: 'none', credit: 0, state, message: `派出失败：${classified.message}` }
  }
  if (state.state === 'traveling') {
    return { action: 'skip', credit: 0, state, message: '旅行在途，明天再来' }
  }
  return {
    action: 'skip',
    credit: 0,
    state,
    message: state.state.length > 0 ? `未知旅行状态 ${state.state}，本轮跳过` : '旅行状态为空，本轮跳过',
  }
}

/** 猫档案（无猫时 `hasBuddy:false`）。 */
export interface BuddyInfo {
  ok: boolean
  hasBuddy: boolean
  name: string
  message?: string
}

/** 查询猫档案（只读）：`data.buddy` 为 `null`/缺字段 ⇒ 还没领养。 */
export async function fetchBuddyInfo(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch = fetch,
): Promise<BuddyInfo> {
  const result = await getGrowthJson(BUDDY_INFO_PATH, credential, product, fetcher)
  if (!result.ok || result.body.code !== 0) {
    return { ok: false, hasBuddy: false, name: '', message: messageOf(result) }
  }
  const data = dataOf(result)
  const buddy = data['buddy']
  if (typeof buddy !== 'object' || buddy === null) {
    return { ok: true, hasBuddy: false, name: '' }
  }
  return { ok: true, hasBuddy: true, name: readString(buddy as Record<string, unknown>, 'name') }
}

/**
 * 「领养门槛未达标」的判据。
 *
 * 上游在「当日还没有活跃上报」时对 `buddy/first` 回 **HTTP 400 +
 * `first_buddy task not completed yet`**。这是**预期行为**（明天点亮了就能领），
 * 绝不能算失败 —— 算失败会让「一键领积分」每天都染红一条，用户以为坏了。
 */
export function isBuddyAdoptNotReady(message: string): boolean {
  return /first_buddy task not completed/i.test(message)
}

/**
 * 领养第一只 Buddy（+300 积分，**一次性**）。
 *
 * 链路（参考实现实测：`report` → `agreement` → `first`）：
 * 1. **前置活跃上报**：点亮 `first_buddy` 任务。不发光发 `first` 恒 400。
 *    这里复用成长侧既有的 web 遥测（`POST {webBase}/v2/report`），与
 *    `Library_read` 同一条腿 —— 不新造第三条上报口径。
 * 2. **采纳协议**：`buddy/agreement`（幂等）。
 * 3. **领养**：`buddy/first`。
 *
 * ⚠️ 已有猫时调用方**不应走到这里**（先 `fetchBuddyInfo`）。这里不重复判，
 * 但重复领养由服务端兜住（已领养时回业务错误，按 `skipped` 处理）。
 */
export async function adoptBuddy(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch = fetch,
  options: { reportActivity?: () => Promise<{ ok: boolean; message: string }> } = {},
): Promise<StepOutcome> {
  // 1) 前置活跃上报（可选注入：单测不接线上报，避免真发请求）
  if (options.reportActivity !== undefined) {
    const reported = await options.reportActivity()
    if (!reported.ok) {
      return { ok: false, message: `领养前置上报失败：${reported.message}` }
    }
    // 给上游事件处理留时间（参考实现实测 1.05s 口径；太快 first 仍 400）。
    await new Promise((resolve) => setTimeout(resolve, 1_050))
  }
  // 2) 协议
  const agreed = await postGrowthJson(
    BUDDY_AGREEMENT_PATH,
    credential,
    product,
    { agree: true },
    fetcher,
  )
  const agreement = classifyGrowthWrite(agreed)
  if (agreement.state === 'failed') {
    return { ok: false, message: `采纳协议失败：${agreement.message}` }
  }
  // 3) 领养
  const first = await postGrowthJson(GROWTH_FIRST_BUDDY_PATH, credential, product, {}, fetcher)
  const classified = classifyGrowthWrite(first)
  if (classified.state === 'success') {
    const credit = readNumber(classified.data, 'reward_credit')
    return { ok: true, message: credit > 0 ? `已领养首只 Buddy（+${credit} 积分）` : '已领养首只 Buddy' }
  }
  if (isBuddyAdoptNotReady(classified.message)) {
    return { ok: false, skipped: true, message: '领养门槛未达（今日活跃还未点亮），明天再试' }
  }
  return { ok: false, message: `领养失败：${classified.message}` }
}

/**
 * 领取新手礼包（每号一次，写操作）。
 *
 * ⚠️ 「已领过」上游回业务错误 ⇒ 归 `skipped`，不是失败。由于**无法**先查状态
 * （没有对应的 status 端点），只能盲领 + 按文案归类 —— 这一点与补偿不同
 * （补偿有 `compensation-status`，故那边能「先查后领」）。
 */
export async function claimGift(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch = fetch,
): Promise<StepOutcome & { credit: number }> {
  const base = webBaseOf(product)
  if (base.length === 0) {
    return { ok: false, credit: 0, message: '产品缺少 webBase/claimBase 配置，无法拼接礼包端点' }
  }
  try {
    const response = await fetcher(`${base}${CLAIM_GIFT_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential.access_token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Client-Platform': 'web',
        ...credential.user_id === undefined || credential.user_id.length === 0
          ? {}
          : { 'X-User-Id': credential.user_id },
      },
      body: '{}',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await response.text()
    // ⚠️ **先判 401/403 再解析**：凭据失效时上游可能回 JSON 错误体，也可能回网关
    // HTML 页。只在「非 JSON」分支里判状态码会让 JSON 形态的 401 退化成
    // 「业务码 -1」，用户看到的是一句没有任何指路信息的失败（本仓库 IKLBSH 的
    // 同型教训：文案本身就是出路时不能被兜底吞掉）。
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        credit: 0,
        message: `凭据已失效（HTTP ${response.status}），请重新登录该账号`,
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return {
        ok: false,
        credit: 0,
        message: `礼包响应不是 JSON（HTTP ${response.status}）`,
      }
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, credit: 0, message: '礼包响应无法解析' }
    }
    const env = parsed as Record<string, unknown>
    const code = typeof env['code'] === 'number' ? env['code'] : -1
    const msg = readString(env, 'msg')
    if (code !== 0) {
      // 「已领取」类文案（上游未给出稳定码值时按文案兜）：归 skipped。
      if (/已领取|already|重复|claimed/i.test(msg)) {
        return { ok: true, credit: 0, skipped: true, message: msg.length > 0 ? msg : '礼包已领取过' }
      }
      return { ok: false, credit: 0, message: `礼包领取失败（业务码 ${code}）：${msg}` }
    }
    const data = typeof env['data'] === 'object' && env['data'] !== null
      ? (env['data'] as Record<string, unknown>)
      : {}
    const credit = readNumber(data, 'credit')
    return { ok: true, credit, message: credit > 0 ? `新手礼包 +${credit} 积分` : '新手礼包已领取' }
  } catch (error) {
    return {
      ok: false,
      credit: 0,
      message: `礼包请求失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * 昨日漏签且有补签卡 ⇒ 自动补签（保住连登连续天数）。
 *
 * 为什么值得做：连登一断就要**重攒 7 天**才回到「7d 档位」，而档位兑换发的
 * 抽奖次数是抽奖的唯一来源 —— 断一天的代价远大于一次补签。
 *
 * 判据：`/activity/growth/heatmap` 的昨日 cell `score === 0`（漏签），且
 * `makeup_cards.balance > 0`。两者任一不满足 ⇒ `skipped`（正常终态）。
 * ⚠️ 热力图里**找不到昨日格子**时也按「没漏签」处理（不猜）。
 */
export async function makeupYesterday(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<StepOutcome> {
  const heat = await getGrowthJson(HEATMAP_PATH, credential, product, fetcher)
  if (!heat.ok || heat.body.code !== 0) {
    return { ok: false, message: `签到热力图查询失败：${messageOf(heat)}` }
  }
  const cells = dataOf(heat)['cells']
  if (!Array.isArray(cells)) return { ok: true, skipped: true, message: '热力图未下发 cells，跳过补签' }
  const yesterday = utc8Date(-1, nowMs)
  let missed = false
  for (const cell of cells) {
    if (typeof cell !== 'object' || cell === null) continue
    const item = cell as Record<string, unknown>
    const date = readString(item, 'date')
    if (date.slice(0, 10) !== yesterday) continue
    missed = readNumber(item, 'score') === 0
    break
  }
  if (!missed) return { ok: true, skipped: true, message: '昨日未漏签' }
  const detail = await fetchStreakDetail(credential, product, fetcher)
  if (!detail.ok) return { ok: false, message: `连登状态查询失败：${detail.message ?? '未知原因'}` }
  if (detail.makeupCards <= 0) return { ok: true, skipped: true, message: '昨日漏签但无补签卡' }
  const used = await postGrowthJson(
    MAKEUP_USE_PATH,
    credential,
    product,
    { target_date: yesterday },
    fetcher,
  )
  const classified = classifyGrowthWrite(used)
  if (classified.state === 'success') {
    return { ok: true, message: `已用补签卡补签 ${yesterday}（保连登）` }
  }
  return { ok: false, message: `补签失败：${classified.message}` }
}

/** 成长中心拓展动作的整体结果（逐项可展示）。 */
export interface GrowthCenterOutcome {
  gift: StepOutcome & { credit: number }
  makeup: StepOutcome
  streak: StepOutcome & { days: number; redeemed: string[] }
  lottery: StepOutcome & { chances: number; drawn: number }
  travel: StepOutcome & { action: TravelAction; credit: number }
  adopt: StepOutcome
}

/** {@link runGrowthCenterDaily} 的选项。 */
export interface GrowthCenterRunOptions {
  fetcher?: typeof fetch
  /** 抽奖上限（缺省 {@link MAX_LOTTERY_DRAWS}）。 */
  maxLotteryDraws?: number
  /**
   * 是否允许「领养」写操作。缺省 `true`：
   *
   * - 已有猫（`fetchBuddyInfo` 命中）⇒ 自动跳过，不会重复领养；
   * - 门槛未达 ⇒ `skipped` + 「明天再试」，不算失败。
   *
   * 若要**完全不碰**一次性写操作（例如只想看数据的面板），传 `false`。
   */
  allowAdopt?: boolean
  /**
   * 领养前的活跃上报（可选）。不传则**不领养**（见下方注释）：
   * 领养必须先把 `first_buddy` 点亮，而那条上报口径属于成长任务侧，本模块不自己
   * 造第三条上报腿。
   */
  reportActivity?: () => Promise<{ ok: boolean; message: string }>
  now?: () => number
}

/**
 * 每日「成长中心扩展收益」一趟：礼包 → 补签 → 连登兑换 → 抽奖 → 旅行 → 领养。
 *
 * 顺序理由：
 * 1. **礼包/补签先跑**：礼包是一次性、补签会改变连登天数（进而影响下面档位判据）。
 * 2. **兑换在抽奖之前**：抽奖次数**只能**从档位兑换获得（参考实现实测），
 *    顺序反了会让「刚兑换到的次数」等到明天才用。
 * 3. **旅行独立**：每日一次派出、隔日到站领奖，与其它步骤无依赖。
 * 4. **领养最后**：它是最重的写操作（一次性 +300），前面失败也不该挡住它。
 *
 * ⚠️ **任何一步失败都不中断后续**（逐项 `try/catch` 语义由各步骤函数自身保证：
 * 它们都返回结果对象而不抛）。这很重要：一次账户 401 不该让「抽奖」也一起丢。
 */
export async function runGrowthCenterDaily(
  credential: BuddyCredential,
  product: BuddyProduct,
  options: GrowthCenterRunOptions = {},
): Promise<GrowthCenterOutcome> {
  const fetcher = options.fetcher ?? fetch
  const nowMs = (options.now ?? Date.now)()

  const gift = await claimGift(credential, product, fetcher)
  const makeup = await makeupYesterday(credential, product, fetcher, nowMs)

  const detail = await fetchStreakDetail(credential, product, fetcher)
  let streakRedeemed: string[] = []
  let streak: GrowthCenterOutcome['streak']
  if (!detail.ok) {
    streak = {
      ok: false,
      days: 0,
      redeemed: [],
      message: `连登状态查询失败：${detail.message ?? '未知原因'}`,
    }
  } else {
    const redeemed = await redeemUnlockedTiers(credential, product, detail, fetcher)
    streakRedeemed = redeemed.redeemed.map((tier) => tier.tier)
    const parts: string[] = [`连登 ${detail.days} 天`]
    if (streakRedeemed.length > 0) {
      const gains = redeemed.redeemed
        .map((tier) => `${tier.tier}（+${tier.credit} 积分${tier.chances > 0 ? `，${tier.chances} 次抽奖` : ''}）`)
        .join('、')
      parts.push(`兑换 ${gains}`)
    } else if (detail.tiers.length > 0) {
      const pending = detail.tiers.filter((tier) => tier.status !== 'claimed')
      parts.push(pending.length > 0 ? '档位未解锁或已兑换' : '档位均已兑换')
    }
    if (redeemed.failed.length > 0) parts.push(`兑换失败：${redeemed.failed.join('；')}`)
    streak = {
      ok: redeemed.failed.length === 0,
      days: detail.days,
      redeemed: streakRedeemed,
      message: parts.join('，'),
    }
  }

  const lotteryResult = await drawAllLottery(credential, product, {
    fetcher,
    ...options.maxLotteryDraws === undefined ? {} : { maxDraws: options.maxLotteryDraws },
  })
  const lottery: GrowthCenterOutcome['lottery'] = {
    ok: lotteryResult.ok,
    chances: lotteryResult.chances,
    drawn: lotteryResult.drawn,
    message: lotteryResult.message,
    ...lotteryResult.drawn === 0 && lotteryResult.ok ? { skipped: true } : {},
  }

  const travelResult = await advanceTravel(credential, product, fetcher)
  const travel: GrowthCenterOutcome['travel'] = {
    ok: travelResult.action === 'depart' || travelResult.action === 'claim',
    action: travelResult.action,
    credit: travelResult.credit,
    message: travelResult.message,
    ...travelResult.action === 'depart' || travelResult.action === 'skip' ? { skipped: travelResult.action === 'skip' } : {},
  }

  // 领养：没有活跃上报腿时不碰（否则 100% 拿到 400 门槛错误，只是噪声）。
  let adopt: StepOutcome = { ok: true, skipped: true, message: '未启用领养（缺少活跃上报入口）' }
  if (options.allowAdopt !== false && options.reportActivity !== undefined) {
    const info = await fetchBuddyInfo(credential, product, fetcher)
    if (!info.ok) {
      adopt = { ok: false, message: `猫档案查询失败：${info.message ?? '未知原因'}` }
    } else if (info.hasBuddy) {
      adopt = { ok: true, skipped: true, message: info.name.length > 0 ? `已有 Buddy：${info.name}` : '已有 Buddy' }
    } else {
      adopt = await adoptBuddy(credential, product, fetcher, { reportActivity: options.reportActivity })
    }
  }

  return { gift, makeup, streak, lottery, travel, adopt }
}

/**
 * 只读快照：成长中心面板「有地方看」的数据源（**不发任何写请求**）。
 *
 * 逐项独立容错：某一项查询失败只让那一项报错，不影响整张卡片（与
 * `compensation-panel-logic.js` 的 `scanCompensation` 同款纪律）。
 */
export interface GrowthCenterSnapshot {
  ok: boolean
  streak?: StreakDetail
  lottery?: LotteryState
  travel?: TravelState
  buddy?: BuddyInfo
  message?: string
}

/** 拉一份只读快照（连登 / 抽奖 / 旅行 / 猫档案）。 */
export async function fetchGrowthCenterSnapshot(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch = fetch,
): Promise<GrowthCenterSnapshot> {
  const streak = await fetchStreakDetail(credential, product, fetcher)
  const lottery = await fetchLotteryState(credential, product, fetcher)
  const travel = await fetchTravelState(credential, product, fetcher)
  const buddy = await fetchBuddyInfo(credential, product, fetcher)
  const ok = streak.ok || lottery.ok || travel.ok || buddy.ok
  const messages: string[] = []
  if (!streak.ok) messages.push(`连登：${streak.message ?? '查询失败'}`)
  if (!lottery.ok) messages.push(`抽奖：${lottery.message ?? '查询失败'}`)
  if (!travel.ok) messages.push(`旅行：${travel.message ?? '查询失败'}`)
  if (!buddy.ok) messages.push(`猫档案：${buddy.message ?? '查询失败'}`)
  return {
    ok,
    streak,
    lottery,
    travel,
    buddy,
    ...messages.length > 0 ? { message: messages.join('；') } : {},
  }
}

/**
 * 导出给单测/面板用的「基址可用性」自检。
 *
 * 三个基址任一为空都会让对应动作静默打出 `undefined/...`（本仓库记过的形态），
 * 故面板在渲染按钮前先判它。
 */
export function growthCenterBases(product: BuddyProduct): {
  growth: boolean
  claim: boolean
  web: boolean
} {
  return {
    growth: baseOf(product).length > 0,
    claim: claimBaseOf(product).length > 0,
    web: webBaseOf(product).length > 0,
  }
}

/** 把扩展收益结果映射成 RPC 契约（`types.ts` 的 `RpcBuddyGrowthExtras`）。 */
export function toRpcGrowthExtras(outcome: GrowthCenterOutcome): RpcBuddyGrowthExtras {
  const step = (value: StepOutcome): RpcBuddyGrowthStep => ({
    ok: value.ok,
    message: value.message,
    ...value.skipped === true ? { skipped: true } : {},
  })
  return {
    gift: { ...step(outcome.gift), credit: outcome.gift.credit },
    makeup: step(outcome.makeup),
    streak: {
      ...step(outcome.streak),
      days: outcome.streak.days,
      redeemed: outcome.streak.redeemed,
    },
    lottery: {
      ...step(outcome.lottery),
      chances: outcome.lottery.chances,
      drawn: outcome.lottery.drawn,
    },
    travel: { ...step(outcome.travel), action: outcome.travel.action, credit: outcome.travel.credit },
    adopt: step(outcome.adopt),
  }
}

/**
 * 把扩展收益压成**一句话摘要**（写入运行日志 / 面板「上次结果」）。
 *
 * ⚠️ 只列**有信息量**的步骤：`skipped` 且不是「到账类」的全部略过，否则每次都会
 * 出现「无抽奖次数、昨日未漏签、已有 Buddy」三连废话，真正的收益被埋掉。
 */
export function summarizeGrowthExtras(extras: RpcBuddyGrowthExtras): string {
  const parts: string[] = []
  if (extras.gift?.ok === true && (extras.gift.credit ?? 0) > 0) parts.push(`礼包 +${extras.gift.credit}`)
  if (extras.makeup?.ok === true && extras.makeup.skipped !== true) parts.push(extras.makeup.message)
  if (extras.streak?.redeemed !== undefined && extras.streak.redeemed.length > 0) {
    parts.push(`连登兑换 ${extras.streak.redeemed.join('/')}`)
  }
  if (extras.lottery !== undefined && (extras.lottery.drawn ?? 0) > 0) {
    parts.push(`抽奖 ${extras.lottery.drawn} 次`)
  }
  if ((extras.travel?.credit ?? 0) > 0) parts.push(`旅行 +${extras.travel?.credit}`)
  else if (extras.travel?.action === 'depart') parts.push('旅行已派出')
  if (extras.adopt?.ok === true && extras.adopt.skipped !== true) parts.push(extras.adopt.message)
  return parts.length > 0 ? parts.join('，') : '扩展收益无可执行项'
}

/** 总览里的单个任务行（`types.ts` 的 `RpcBuddyGrowthOverviewTask` 的本地形状）。 */
export type GrowthOverviewTask = RpcBuddyGrowthOverviewTask

/**
 * 拉取任务清单（**只读**，合并成长族 + 等级族两族端点）。
 *
 * ⚠️ 两族的**码字段与进度形状都不同**（成长族 `task_code` + `progress.current/target`，
 * 等级族 `code` + 平铺 `current/target`），本仓库 `buddy-growth.ts` 的
 * `fetchGrowthTaskCodes` / `listAllGrowthTaskCodes` 已经为此踩过两次坑。这里按
 * 同一判据实现，不许只读一种。
 *
 * ⚠️ 返回**全量**任务（不只白名单）：面板要回答「这个号还有哪些任务没做」，
 * 过滤掉「需客户端」的会让用户以为任务已经清空。
 */
export async function listGrowthTasks(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: boolean; tasks: GrowthOverviewTask[]; message?: string }> {
  const seen = new Set<string>()
  const tasks: GrowthOverviewTask[] = []
  let anyOk = false
  let lastMessage = ''
  for (const path of GROWTH_TASKS_PATHS) {
    const result = await getGrowthJson(path, credential, product, fetcher)
    if (!result.ok || result.body.code !== 0) {
      lastMessage = messageOf(result)
      continue
    }
    anyOk = true
    const raw = dataOf(result)['tasks']
    if (!Array.isArray(raw)) continue
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue
      const item = entry as Record<string, unknown>
      const taskCode = readString(item, 'task_code') || readString(item, 'code')
      if (taskCode.length === 0 || seen.has(taskCode)) continue
      seen.add(taskCode)
      // 进度：`progress:{current,target}` 优先，平铺字段兜底（两族形状不同）。
      const progress = typeof item['progress'] === 'object' && item['progress'] !== null
        ? (item['progress'] as Record<string, unknown>)
        : undefined
      const current = progress !== undefined ? readNumber(progress, 'current') : readNumber(item, 'current')
      const target = progress !== undefined ? readNumber(progress, 'target') : readNumber(item, 'target')
      const credit = readNumber(item, 'reward_credit')
      const energy = readNumber(item, 'reward_energy')
      const rewardParts: string[] = []
      if (credit > 0) rewardParts.push(`+${credit} 积分`)
      if (energy > 0) rewardParts.push(`+${energy} 能量`)
      const status = readString(item, 'accept_status') || readString(item, 'status')
      tasks.push({
        taskCode,
        title: readString(item, 'title') || taskCode,
        reward: rewardParts.join(' '),
        progress: target > 0 ? `${current}/${target}` : '',
        status,
        reach: CLIENT_ONLY_TASK_CODES.has(taskCode)
          ? 'client'
          : GROWTH_TASK_COMPLETION[taskCode] !== undefined ? 'api' : 'unknown',
        ...target > 0 && current >= target && status !== 'claimed' ? { claimable: true } : {},
      })
    }
  }
  return anyOk
    ? { ok: true, tasks }
    : { ok: false, tasks, message: lastMessage.length > 0 ? lastMessage : '任务列表查询失败' }
}

/**
 * 「判据只在客户端里记录」的任务码（面板据此说明「为什么这项 API 推不动」）。
 *
 * ⚠️ 这两个码**同时**在 `AUTOMATABLE_TASK_CODES` 里，这是**刻意**的、不是重复登记：
 * - 在白名单里 ⇒ 仍会被 `accept`（接取本身没有副作用，且能进任务清单）；
 * - 在这里 ⇒ 完成动作**推不动**（判据要微信服务号订阅 / 微信绑定回执）。
 *
 * 判据优先级：本集合**先于** `GROWTH_TASK_COMPLETION`（见 `listGrowthTasks`），
 * 故面板不会把「需客户端」误显示成「可自动完成」。
 */
export const CLIENT_ONLY_TASK_CODES = new Set<string>([
  'wb_wechat_oa_subscribe_task',
  'wechat_linked',
])

