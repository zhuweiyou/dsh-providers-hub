/**
 * 成长任务**实时进度**（宿主侧单例，供面板轮询）。
 *
 * ## 为什么需要它（用户报障原文）
 *
 * > 「看不到任务执行进度，至少也要给到一个状态行，告知当前哪个号正在做什么任务」
 * > 「还有面板切走了，任务在后台还会做吗？还是会停止？这个要在画面说明出来」
 *
 * 一键领取是**一次 RPC、跑几分钟**（成长任务单账号 90~270s，mp 对话任务更慢）。
 * 在这之前：按钮变成「执行中…」，然后什么都没有 —— 用户既不知道跑到第几个号、
 * 也不知道切走会不会中断。而事实是：**这一轮跑在宿主进程里**，面板切走只丢掉了
 * 「结果怎么显示」，不会停；但客户端把 `mounted` 置 false 后连结果都不写了，
 * 用户回来只能靠余额有没有涨来猜。
 *
 * ⇒ 本模块记一份**宿主内存里的**当前轮状态，面板通过 `buddy.growthProgress`
 * 每 2s 轮询它。因为状态在宿主侧，**切走再回来仍能看到「正在执行 / 刚刚完成」**。
 *
 * ## 边界（刻意如此）
 *
 * - **只在内存里**：进程重启即丢。它是「当前/最近一轮的进度」，不是历史 ——
 *   历史结果由 `growth-run-log.ts` 落盘负责。
 * - **绝不抛错**：调用点在领取主链路上（`collectClaimResults` 的循环里），
 *   进度写失败不该让领取失败。
 * - **按 provider 分槽**：目前只有 `buddy` 会写，但按 provider 分槽可以让面板
 *   在切换到别的渠道时不显示别人的进度。
 *
 * @module src/growth-progress.ts
 */

/** 当前正在执行的**一步**（人类可读）。 */
export interface GrowthProgressStep {
  /** 目标账号。 */
  accountId: string
  nickname: string
  /** 人类可读的步骤文案（如 `任务 chat_5：发一条对话`）。 */
  text: string
  /** 该步骤开始时刻（毫秒）。 */
  at: number
}

/** 一轮执行的进度快照。 */
export interface GrowthProgressState {
  provider: string
  /** 本轮唯一 id（同一轮内不变，便于前端判断「是不是新的一轮」）。 */
  runId: string
  startedAt: number
  /** 是否仍在执行。 */
  running: boolean
  /** 计划执行多少个账号。 */
  totalAccounts: number
  /** 已跑完多少个账号。 */
  doneAccounts: number
  /** 当前正在执行的步骤（`running:false` 时保留最后一次，便于「刚刚做了什么」）。 */
  current?: GrowthProgressStep
  finishedAt?: number
  /** 结束时的摘要（成功/失败/超时等）。 */
  summary?: string
  /** 整轮异常（护栏兜底，正常路径不用）。 */
  error?: string
}

/** provider → 当前轮状态。 */
const runs = new Map<string, GrowthProgressState>()

/** 生成本轮 id（时间戳 + 序号，够唯一且可读）。 */
let sequence = 0
function nextRunId(now: number): string {
  sequence += 1
  return `${now.toString(36)}-${sequence.toString(36)}`
}

/**
 * 开始一轮（覆盖同 provider 的旧状态）。
 *
 * 返回 `runId`；调用方在 `finish` 时可用它做「是不是同一轮」的防御
 * （并发/重入时避免旧轮的收尾把新轮标成结束）。
 */
export function beginGrowthRun(provider: string, totalAccounts: number): string {
  const now = Date.now()
  const runId = nextRunId(now)
  runs.set(provider, {
    provider,
    runId,
    startedAt: now,
    running: true,
    totalAccounts: Math.max(0, totalAccounts),
    doneAccounts: 0,
  })
  return runId
}

/** 该 provider 是否有一轮正在执行（供**防重入**判据）。 */
export function growthRunActive(provider: string): boolean {
  return runs.get(provider)?.running === true
}

/**
 * 更新「当前正在做什么」。
 *
 * ⚠️ 只在 `running` 的轮上生效：已结束的轮不该被迟到的进度回调改回「进行中」
 * （真实场景：某个账号的请求比整轮收尾还慢，回调晚到）。
 */
export function reportGrowthStep(
  provider: string,
  accountId: string,
  nickname: string,
  text: string,
): void {
  const state = runs.get(provider)
  if (state === undefined || state.running !== true) return
  state.current = { accountId, nickname, text, at: Date.now() }
}

/** 一个账号跑完（进度分母推进）。 */
export function completeGrowthAccount(provider: string): void {
  const state = runs.get(provider)
  if (state === undefined || state.running !== true) return
  state.doneAccounts = Math.min(state.totalAccounts, state.doneAccounts + 1)
}

/** 收尾（幂等；`runId` 不匹配时不动，避免旧轮把新轮标成结束）。 */
export function finishGrowthRun(
  provider: string,
  runId: string | undefined,
  summary?: string,
  error?: string,
): void {
  const state = runs.get(provider)
  if (state === undefined) return
  if (runId !== undefined && state.runId !== runId) return
  state.running = false
  state.finishedAt = Date.now()
  if (summary !== undefined && summary.length > 0) state.summary = summary
  if (error !== undefined && error.length > 0) state.error = error
}

/** 读快照（无状态返回 `undefined`）。 */
export function readGrowthProgress(provider: string): GrowthProgressState | undefined {
  return runs.get(provider)
}

/** 仅供单测：清空进程级状态。 */
export function resetGrowthProgressForTests(): void {
  runs.clear()
  sequence = 0
}

/**
 * 把进度压成**一行**给 UI 的状态文案（纯函数，客户端与单测共用同一口径）。
 *
 * ⚠️ 刻意放在宿主侧导出：客户端也能自己拼，但两处各拼一份必然漂移
 * （本仓库为此立过「一文件两套同义判据」的规矩）。客户端只做「拿字符串显示」。
 */
export function describeGrowthProgress(state: GrowthProgressState | undefined): string {
  if (state === undefined) return ''
  const who = state.current === undefined
    ? ''
    : `${state.current.nickname || state.current.accountId}`
  const slot = state.totalAccounts > 0
    ? `账号 ${Math.min(state.doneAccounts + 1, state.totalAccounts)}/${state.totalAccounts}`
    : ''
  if (state.running === true) {
    const step = state.current?.text ?? '准备中'
    return [who.length > 0 ? `正在跑 ${who}` : '正在跑', step, slot]
      .filter((part) => part.length > 0)
      .join(' · ')
  }
  const parts: string[] = []
  if (state.summary !== undefined && state.summary.length > 0) parts.push(state.summary)
  else if (state.error !== undefined && state.error.length > 0) parts.push(`执行失败：${state.error}`)
  else parts.push('上一轮已结束')
  return parts.join(' · ')
}
