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

/* ───────────────────────── 2026-10-23：按需读取 + 实时进度 ───────────────────────── */

/**
 * 「读取任务清单」这个动作的**成本提示**。
 *
 * 背景（用户报障原文）：「这个要弄个按钮点了才读取，而不是打开插件面板就读取，
 * 这样每次都要向上游发 API 请求太多了」。总览每个账号要打 6 个上游 GET
 * （连登 / 抽奖 / 旅行 / 猫档案 / 任务列表 ×2 口径），故必须**把成本写在按钮旁边**，
 * 让用户自己决定 —— 而不是让他在不知情的情况下每次打开面板都打一遍。
 */
export function overviewCostHint(accountCount) {
  const count = typeof accountCount === 'number' && accountCount > 0 ? accountCount : 0
  if (count === 0) return '读取会向每个账号发约 6 个只读请求（当前还没有账号）'
  return `读取会向每个账号发约 6 个只读请求（当前 ${count} 个账号，共约 ${count * 6} 个）`
}

/**
 * 未读取任务清单时的占位说明（**明确区分「还没读」与「读了但失败」**）。
 *
 * ⚠️ 这两种状态在 UI 上必须可辨：前者是用户没点按钮（正常），后者是上游/凭据问题
 * （需要处置）。旧实现打开面板就自动读，于是「读取中…」会长期挂在卡片上
 * （2026-10-23 用户截图），看起来像卡死。
 */
export function overviewIdleHint() {
  return '任务清单需要手动读取（点上方「读取任务清单」）—— 打开面板不会自动请求上游。'
}

/** 已读取时的快照时间提示。 */
export function overviewLoadedHint(loadedAt) {
  const when = formatLocalTime(loadedAt)
  if (when.length === 0) return '任务清单为快照，执行后请重新读取'
  return `任务清单读取于 ${when}（快照）—— 执行后请重新读取`
}

/**
 * 读取**进行中**的提示。
 *
 * ⚠️ 必须给「大概要多久 / 在做什么」，否则一次 6 个账号的串行读取会让卡片长时间
 * 停在「读取中…」，与 2026-10-23 用户截图里那个「卡住」的外观一模一样。
 */
export function overviewLoadingHint(accountCount) {
  const count = typeof accountCount === 'number' && accountCount > 0 ? accountCount : 0
  return count > 0
    ? `正在逐个账号读取（${count} 个账号 × 约 6 个请求，串行，请稍等）`
    : '正在读取账号状态…'
}

/** 执行过后快照变旧：明确提示「现在看到的是执行前的数据」。 */
export function overviewStaleHint() {
  return '这是执行前的快照；点了「读取任务清单」才刷新。'
}

/**
 * **实时进度**的一行文案（宿主侧 `describeGrowthProgress` 的客户端同源口径）。
 *
 * ⚠️ 两处都要有：宿主那份给日志/其它消费者，这份给 UI 做「没拿到进度时的回落」。
 * 判据只读字段，不猜。
 */
export function progressLine(progress) {
  if (!progress || typeof progress !== 'object') return ''
  const total = typeof progress.totalAccounts === 'number' ? progress.totalAccounts : 0
  const done = typeof progress.doneAccounts === 'number' ? progress.doneAccounts : 0
  const slot = total > 0 ? `账号 ${Math.min(done + 1, total)}/${total}` : ''
  if (progress.running === true) {
    const current = progress.current && typeof progress.current === 'object' ? progress.current : null
    const who = current ? String(current.nickname || current.accountId || '') : ''
    const step = current && typeof current.text === 'string' && current.text.length > 0
      ? current.text
      : '准备中'
    return [who.length > 0 ? `正在跑 ${who}` : '正在跑', step, slot]
      .filter((part) => part.length > 0)
      .join(' · ')
  }
  const summary = typeof progress.summary === 'string' ? progress.summary : ''
  if (summary.length > 0) return summary
  const error = typeof progress.error === 'string' ? progress.error : ''
  if (error.length > 0) return `执行异常：${error}`
  return ''
}

/**
 * **后台语义**说明（用户明确要求「这个要在画面说明出来」）。
 *
 * 事实依据（不是营销话术）：一键领取是**一次宿主侧 RPC**，逐账号循环跑在
 * 宿主进程里（`collectClaimResults`）。面板切走只影响「结果怎么显示」——
 * `mounted.current` 置 false 后不再上屏，但宿主那边的请求**不会被打断**，
 * 且进度表（`src/growth-progress.ts`）与结果日志（`growth-runs.json`）都在宿主侧，
 * 所以切回来仍能看到「正在执行 / 刚刚完成」。
 */
export function backgroundHint() {
  return '执行在宿主进程里进行：切换渠道、关掉面板、刷新页面都**不会中断**；'
    + '回来后再点开本面板即可看到进度与「上次执行」结果。进度每 3 秒刷新一次（本地内存，不请求上游）。'
}

/** 「上次执行」摘要：N 个账号有记录 + 最近一次的时间。 */
export function lastRunDigest(runs) {
  const list = Array.isArray(runs) ? runs.filter((run) => run && typeof run.at === 'number' && run.at > 0) : []
  if (list.length === 0) return '本机还没有执行记录'
  const latest = list.reduce((max, run) => (run.at > max ? run.at : max), 0)
  const when = formatLocalTime(latest)
  return `上次执行：${when}（${list.length} 个账号有记录）`
}

/** 某个账号上次执行的一行文字（`14:02 · 完成 5 项…`），无记录返回空串。 */
export function runOf(runs, accountId) {
  const list = Array.isArray(runs) ? runs : []
  for (const run of list) {
    if (!run || run.accountId !== accountId) continue
    const at = typeof run.at === 'number' ? run.at : 0
    const when = formatLocalTime(at)
    const summary = typeof run.summary === 'string' ? run.summary : ''
    if (when.length === 0 && summary.length === 0) return ''
    return when.length > 0 ? `${when} · ${summary}` : summary
  }
  return ''
}

/**
 * 卡片标题（按「是否已读取清单 / 是否正在执行」分流）。
 *
 * ⚠️ 与 `growthHeadline` 的区别：那个只看总览是否读到；**未读清单是常态**
 * （用户要求点了才读），此时标题必须说「N 个账号」而不是「无账号」——
 * 否则看起来像账号丢了。
 */
export function growthCardTitle(state) {
  const overview = state && typeof state === 'object' ? state.overview : null
  const progress = state && typeof state === 'object' ? state.progress : null
  const accountCount = state && typeof state.accountCount === 'number' && state.accountCount > 0
    ? state.accountCount
    : 0
  if (overview && overview.loading === true) return '成长任务中心 · 读取中…'
  if (progress && progress.running === true) {
    const total = typeof progress.totalAccounts === 'number' ? progress.totalAccounts : accountCount
    return `成长任务中心 · 执行中（${total > 0 ? total : accountCount} 个账号）`
  }
  if (overview && Array.isArray(overview.accounts) && overview.accounts.length > 0) {
    const failed = overview.accounts.filter((account) => account && account.ok === false).length
    return failed > 0
      ? `成长任务中心 · ${overview.accounts.length} 个账号（${failed} 个读取失败）`
      : `成长任务中心 · ${overview.accounts.length} 个账号`
  }
  return accountCount > 0 ? `成长任务中心 · ${accountCount} 个账号（清单未读取）` : '成长任务中心 · 无账号'
}
