/**
 * 成长任务中心（CodeBuddy「成长计划」）的**纯展示逻辑**。
 *
 * ## 为什么单独成文件
 *
 * `jet-hub.js` 是无法被单测覆盖的（仓库里没有 react，组件不渲染）。本仓库为此
 * 立过规矩：**判据与文案一律抽成纯函数**，组件里只做 `createElement` 拼装 ——
 * `compensation-panel-logic.js` 就是这么来的（初版把文案内联在 JSX 三元里，
 * 于是漏掉了一个 P0 而全绿）。
 *
 * ## 数据来源
 *
 * 全部来自宿主 RPC `buddy.growthOverview`（**只读**，见 `src/jet-hub-rpc.ts`）：
 * `accounts[].{ streak, lottery, travel, hasBuddy, tasks, lastRun }`。
 *
 * ⚠️ **客户端契约**：`rpcCall` 成功时返回**解包后的 `value`**（没有 `ok` 字段），
 * 失败时**抛错**（见 `plugin-src/management-rpc.mjs` 的 `unwrapRpcResult`）⇒
 * 消费方判 `res.ok` 恒假，必须走字段判据 + try/catch。
 *
 * @module plugin-src/client/growth-center-logic.js
 */

/** 任务状态的中文标签（上游 `accept_status` / `status` 的取值）。 */
const STATUS_LABELS = {
  not_accepted: '未接取',
  accepted: '已接取',
  in_progress: '进行中',
  completed: '待领取',
  claimed: '已领取',
  available: '可做',
  locked: '未解锁',
}

/** 把上游状态码翻成中文；不认识的取值**原样返回**（不吞线索）。 */
export function taskStatusText(status) {
  const raw = typeof status === 'string' ? status.trim() : ''
  if (raw.length === 0) return '未知'
  return STATUS_LABELS[raw] || raw
}

/** 任务「能不能自动推进」的中文标签。 */
export function taskReachText(reach) {
  if (reach === 'api') return '可自动'
  if (reach === 'client') return '需客户端'
  return '未接线'
}

/**
 * 汇总一个账号的任务清单。
 *
 * 返回的四类计数是面板与 toast 共用的口径：
 * - `api`：本仓库有完成动作、且尚未领取；
 * - `client`：判据只在客户端里记录（推不动，不该染红）；
 * - `claimable`：已达标未领取（下一轮扫尾会自动领）；
 * - `claimed`：已领取。
 */
export function summarizeTasks(tasks) {
  const list = Array.isArray(tasks) ? tasks : []
  let api = 0
  let client = 0
  let claimable = 0
  let claimed = 0
  for (const task of list) {
    if (!task || typeof task !== 'object') continue
    if (task.status === 'claimed') {
      claimed += 1
      continue
    }
    if (task.claimable === true) claimable += 1
    if (task.reach === 'client') client += 1
    else if (task.reach === 'api') api += 1
  }
  return { total: list.length, api, client, claimable, claimed }
}

/** 连登档位的一行文字（`7d：已兑换 / 可兑换 / 未解锁`）。 */
export function tierText(tier) {
  if (!tier || typeof tier !== 'object') return ''
  const name = typeof tier.tier === 'string' ? tier.tier : ''
  if (name.length === 0) return ''
  // ⚠️ 档位的 `available` 语义是「**可兑换**」（7d/14d/28d 档位礼包），不是任务清单
  // 里的「可做」—— 共用 `taskStatusText` 会给出让人看不懂的文案，故这里单独翻。
  const status = tier.status === 'available'
    ? '可兑换'
    : tier.status === 'claimed' ? '已兑换' : taskStatusText(tier.status)
  const chances = typeof tier.chances === 'number' && tier.chances > 0 ? `，${tier.chances} 次抽奖` : ''
  return `${name}：${status}${chances}`
}

/**
 * 一个账号的**一行**状态摘要（卡片正文）。
 *
 * 口径：连登 / 抽奖 / 旅行 / 猫 四块各自缺省时**不占位**（不写「连登：—」），
 * 否则每行都拖着一串破折号，真正有信息的那块看不出来。
 */
export function accountSummary(account) {
  if (!account || typeof account !== 'object') return ''
  const parts = []
  if (account.streak && typeof account.streak.days === 'number') {
    const cards = typeof account.streak.makeupCards === 'number' && account.streak.makeupCards > 0
      ? `，补签卡 ${account.streak.makeupCards}`
      : ''
    parts.push(`连登 ${account.streak.days} 天${cards}`)
  }
  if (account.lottery && account.lottery.enabled === true && typeof account.lottery.chances === 'number') {
    parts.push(`抽奖次数 ${account.lottery.chances}`)
  }
  if (account.travel && typeof account.travel.state === 'string' && account.travel.state.length > 0) {
    const stateText = account.travel.state === 'idle'
      ? '空闲'
      : account.travel.state === 'traveling' ? '在途' : account.travel.state === 'arrived' ? '已到站' : account.travel.state
    parts.push(`旅行 ${stateText}`)
  }
  if (account.hasBuddy === false) parts.push('未领养 Buddy（可 +300）')
  const tasks = summarizeTasks(account.tasks)
  if (tasks.total > 0) {
    parts.push(`任务 ${tasks.claimed}/${tasks.total} 已领`)
  }
  return parts.join(' · ')
}

/** 上次执行结果的一行文字（`10-23 14:02 · 完成 5 项，领取 3 项…`）。 */
export function lastRunText(lastRun) {
  if (!lastRun || typeof lastRun !== 'object') return ''
  const at = typeof lastRun.at === 'number' && lastRun.at > 0 ? lastRun.at : 0
  const when = at === 0 ? '' : formatLocalTime(at)
  const summary = typeof lastRun.summary === 'string' ? lastRun.summary : ''
  if (when.length === 0 && summary.length === 0) return ''
  return when.length > 0 ? `${when} · ${summary}` : summary
}

/** 把毫秒时间戳格式化成本地 `MM-DD HH:mm`（面板统一口径）。 */
export function formatLocalTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 扩展收益里**值得显示**的步骤（与宿主 `summarizeGrowthExtras` 同口径）。 */
export function extrasLines(extras) {
  if (!extras || typeof extras !== 'object') return []
  const lines = []
  const gift = extras.gift
  if (gift && gift.ok === true && typeof gift.credit === 'number' && gift.credit > 0) {
    lines.push(`礼包 +${gift.credit}`)
  }
  const makeup = extras.makeup
  if (makeup && makeup.ok === true && makeup.skipped !== true && typeof makeup.message === 'string') {
    lines.push(makeup.message)
  }
  const streak = extras.streak
  if (streak && Array.isArray(streak.redeemed) && streak.redeemed.length > 0) {
    lines.push(`连登兑换 ${streak.redeemed.join('/')}`)
  }
  const lottery = extras.lottery
  if (lottery && typeof lottery.drawn === 'number' && lottery.drawn > 0) {
    lines.push(`抽奖 ${lottery.drawn} 次`)
  }
  const travel = extras.travel
  if (travel) {
    if (typeof travel.credit === 'number' && travel.credit > 0) lines.push(`旅行 +${travel.credit}`)
    else if (travel.action === 'depart') lines.push('旅行已派出')
  }
  const adopt = extras.adopt
  if (adopt && adopt.ok === true && adopt.skipped !== true && typeof adopt.message === 'string') {
    lines.push(adopt.message)
  }
  return lines
}

/** 扩展收益里**失败**的步骤（用于把 toast 染黄；跳过类不算失败）。 */
export function extrasFailures(extras) {
  if (!extras || typeof extras !== 'object') return []
  const out = []
  for (const key of ['gift', 'makeup', 'streak', 'lottery', 'travel', 'adopt']) {
    const step = extras[key]
    if (!step || typeof step !== 'object') continue
    if (step.ok === true || step.skipped === true) continue
    const message = typeof step.message === 'string' ? step.message : '失败'
    out.push(message)
  }
  return out
}

/** 卡片标题（`成长任务中心 · 3 个账号`）。 */
export function growthHeadline(state) {
  if (!state || typeof state !== 'object') return '成长任务中心'
  if (state.loading === true) return '成长任务中心 · 读取中…'
  const accounts = Array.isArray(state.accounts) ? state.accounts : []
  if (accounts.length === 0) return '成长任务中心 · 无账号'
  const failed = accounts.filter((account) => account && account.ok === false).length
  return failed > 0
    ? `成长任务中心 · ${accounts.length} 个账号（${failed} 个读取失败）`
    : `成长任务中心 · ${accounts.length} 个账号`
}

/** 卡片提示语（回答「点了做任务有没有生效」）。 */
export function growthHint(state) {
  if (!state || typeof state !== 'object') return ''
  if (state.error) return `${state.error}`
  if (state.loading === true) return '正在读取任务清单与连登/旅行状态（只读，不会改动账号）'
  const accounts = Array.isArray(state.accounts) ? state.accounts : []
  if (accounts.length === 0) return '该渠道还没有账号'
  const lastAt = accounts
    .map((account) => (account && account.lastRun && typeof account.lastRun.at === 'number' ? account.lastRun.at : 0))
    .reduce((max, value) => (value > max ? value : max), 0)
  const when = lastAt > 0 ? `上次执行：${formatLocalTime(lastAt)}` : '本机还没有执行记录'
  return `${when}。点上方「一键领取积分 + 成长任务」会重跑一轮，结果写在这里（持久化，刷新不丢）。`
}

/** 卡片的色调（`ok` / `warn` / `idle`）。 */
export function growthTone(state) {
  if (!state || typeof state !== 'object') return 'idle'
  if (state.error) return 'warn'
  const accounts = Array.isArray(state.accounts) ? state.accounts : []
  if (accounts.some((account) => account && account.ok === false)) return 'warn'
  const anyClaimable = accounts.some((account) => summarizeTasks(account && account.tasks).claimable > 0)
  return anyClaimable ? 'ok' : 'idle'
}

/**
 * 是否值得渲染这张卡：**只要 provider 是 buddy** 就渲染（即便还没读到数据）。
 *
 * ⚠️ 与补偿卡的关键区别：补偿卡「有数据才渲染」（那是一次性活动，没活动时
 * 整张卡是噪声）；成长任务中心是**常驻功能**，用户正是来「找地方看」的 ——
 * 没数据时也要给出入口与说明，否则又变成「没地方看」。
 */
export function shouldRenderGrowthCard(provider) {
  return provider === 'buddy'
}
