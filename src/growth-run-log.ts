/**
 * 「成长中心上次执行结果」的持久化日志。
 *
 * ## 为什么需要它（用户诉求原文）
 *
 * > 「点了做任务 本仓好像没反应，是默默做的，没地方查询和展示对吗？我希望能有地方看到」
 *
 * 事实是：执行结果**一直存在**（`credits.claimAll` 的返回值里有逐项 `tasks` 与
 * 新增的 `extras`），但只作为**一次性 toast** 呈现 —— 面板刷新、切 tab、重启之后
 * 就再也看不到「上次到底做了什么、领到多少」。成长任务一轮又是分钟级的，
 * 用户很容易在 toast 消失后陷入「刚才点了有没有生效」的不确定。
 *
 * ⇒ 本模块把**每次执行的一句话摘要 + 逐项扩展收益结果**落到
 * `$DSH_HOME/jet-hub/growth-runs.json`，由面板的「成长任务中心」按账号回读。
 *
 * ## 契约（与 `dead-model-store.ts` 同款纪律）
 *
 * - **绝不抛错**：调用点在领取关键路径上（`provider-credits.ts` 的 `afterClaim`），
 *   写日志失败不该让领取结果变成失败。
 * - 损坏 / 缺字段 ⇒ 按**空表**处理（宁可少显示一条历史，也不要让面板崩）。
 * - 原子写（tmp + rename），与同目录其它文档一致。
 *
 * @module src/growth-run-log.ts
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveJetHubHome } from './jet-hub-store.js'
import type { RpcBuddyGrowthExtras } from './types.js'

/** 文档文件名（与 `state.json` 等同目录）。 */
export const GROWTH_RUN_FILE = 'growth-runs.json'

/** 单账号的一条执行记录。 */
export interface GrowthRunEntry {
  /** 执行时间（毫秒时间戳）。 */
  at: number
  /** 一句话摘要（`summarizeGrowthExtras` 的产物 + 任务计数）。 */
  summary: string
  /** 任务侧：完成 / 失败 / 自动领取的项数与积分。 */
  completed: number
  failed: number
  claimedCount: number
  claimedCredit: number
  /** 扩展收益逐项结果（连登兑换 / 抽奖 / 旅行 / 礼包 / 补签 / 领养）。 */
  extras?: RpcBuddyGrowthExtras
}

/** 整份文档：`accountId → 最近一次记录`。 */
export interface GrowthRunLogDoc {
  runs: Record<string, GrowthRunEntry>
}

/** 最多保留的账号条数（账号池上限级别的余量，脏数据不该撑大文档）。 */
const MAX_ENTRIES = 200

/** 把任意输入归一化成合法文档（非法项丢弃，**不抛错**）。 */
export function sanitizeGrowthRunLog(raw: unknown): GrowthRunLogDoc {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { runs: {} }
  const source = (raw as Record<string, unknown>)['runs']
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return { runs: {} }
  const runs: Record<string, GrowthRunEntry> = {}
  let count = 0
  for (const [accountId, value] of Object.entries(source as Record<string, unknown>)) {
    if (count >= MAX_ENTRIES) break
    if (accountId.length === 0) continue
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const record = value as Record<string, unknown>
    const at = typeof record['at'] === 'number' && Number.isFinite(record['at']) && record['at'] > 0
      ? record['at']
      : 0
    if (at === 0) continue
    const num = (key: string): number => {
      const value = record[key]
      return typeof value === 'number' && Number.isFinite(value) ? value : 0
    }
    const extras = record['extras']
    runs[accountId] = {
      at,
      summary: typeof record['summary'] === 'string' ? record['summary'].slice(0, 400) : '',
      completed: num('completed'),
      failed: num('failed'),
      claimedCount: num('claimedCount'),
      claimedCredit: num('claimedCredit'),
      ...typeof extras === 'object' && extras !== null && !Array.isArray(extras)
        ? { extras: extras as RpcBuddyGrowthExtras }
        : {},
    }
    count += 1
  }
  return { runs }
}

/** 文档后端：文件（正常）或内存（定位不到 dsh home 时的显式降级）。 */
interface GrowthRunLogStore {
  load(): GrowthRunLogDoc
  save(doc: GrowthRunLogDoc): void
}

class MemoryGrowthRunLogStore implements GrowthRunLogStore {
  private doc: GrowthRunLogDoc = { runs: {} }

  load(): GrowthRunLogDoc {
    return this.doc
  }

  save(doc: GrowthRunLogDoc): void {
    this.doc = doc
  }
}

/** 文件后端：原子写（tmp + rename）。 */
class FileGrowthRunLogStore implements GrowthRunLogStore {
  constructor(
    private readonly path: string,
    private readonly logger: { warn(message: string): void } | undefined,
  ) {}

  load(): GrowthRunLogDoc {
    try {
      if (!existsSync(this.path)) return { runs: {} }
      return sanitizeGrowthRunLog(JSON.parse(readFileSync(this.path, 'utf-8')) as unknown)
    } catch (error) {
      this.logger?.warn(`[jet-hub] 读取 ${this.path} 失败，按无历史处理: ${String(error)}`)
      return { runs: {} }
    }
  }

  save(doc: GrowthRunLogDoc): void {
    mkdirSync(join(this.path, '..'), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify({ schema: 1, runs: doc.runs }, null, 2), 'utf-8')
    renameSync(tmp, this.path)
  }
}

let store: GrowthRunLogStore | undefined
let logger: { warn(message: string): void } | undefined
let injectedCtx: Context | undefined
/** 内存镜像（避免每开一次面板都读盘）。 */
let cache: GrowthRunLogDoc | undefined

function ensureStore(): GrowthRunLogStore {
  if (store !== undefined) return store
  const home = resolveJetHubHome(injectedCtx ?? ({} as Context))
  if (home === undefined) {
    logger?.warn('[jet-hub] 无法定位 DSH home，成长执行记录仅存在于内存中')
    store = new MemoryGrowthRunLogStore()
  } else {
    store = new FileGrowthRunLogStore(join(home, 'jet-hub', GROWTH_RUN_FILE), logger)
  }
  return store
}

/**
 * 注入 ctx（`index.ts` 的 apply 里调一次）。
 *
 * 不调用也能工作（退化到环境变量解析 + 不记日志），单测靠
 * `DSH_JET_HUB_STATE_DIR` 隔离。
 */
export function configureGrowthRunLog(ctx: Context): void {
  logger = ctx.logger
  injectedCtx = ctx
  // ⚠️ 重新注入时**保留**内存镜像（HMR / fiber 重启会再调一次；清掉会让尚未
  // 落盘的记录永久丢失 —— 与 `dead-model-store.ts` 的教训同型）。
  cache = cache ?? undefined
}

/** 读整份文档（带内存镜像）。 */
export function readGrowthRunLog(): GrowthRunLogDoc {
  if (cache !== undefined) return cache
  cache = ensureStore().load()
  return cache
}

/** 读某账号的最近一次记录（无记录返回 `undefined`）。 */
export function growthRunOf(accountId: string): GrowthRunEntry | undefined {
  return readGrowthRunLog().runs[accountId]
}

/**
 * 记一条执行结果（**永不抛错**，调用点在领取关键路径上）。
 *
 * 同步写盘：文档很小（≤200 条），且失败只 warn —— 不值得为它在关键路径上引入
 * 异步竞态（本仓库 `buddy-compensation` 的写入用 await，是因为它要读响应体；
 * 这里没有 IO 依赖）。
 */
export function recordGrowthRun(accountId: string, entry: GrowthRunEntry): void {
  if (typeof accountId !== 'string' || accountId.length === 0) return
  try {
    const doc = readGrowthRunLog()
    const runs: Record<string, GrowthRunEntry> = { ...doc.runs, [accountId]: entry }
    // 超出上限时按时间淘汰最旧的（保持文档有界）。
    const ids = Object.keys(runs)
    if (ids.length > MAX_ENTRIES) {
      const ordered = ids
        .map((id) => ({ id, at: runs[id]?.at ?? 0 }))
        .sort((left, right) => right.at - left.at)
        .slice(0, MAX_ENTRIES)
      for (const id of ids) {
        if (!ordered.some((item) => item.id === id)) delete runs[id]
      }
    }
    const next: GrowthRunLogDoc = { runs }
    cache = next
    ensureStore().save(next)
  } catch (error) {
    logger?.warn(`[jet-hub] 写成长执行记录失败: ${String(error)}`)
  }
}

/** 仅供单测：清掉进程级状态（后端 + 镜像）。 */
export function resetGrowthRunLogForTests(): void {
  store = undefined
  cache = undefined
  logger = undefined
  injectedCtx = undefined
}
