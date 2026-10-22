/**
 * 「连不上」的**统一判据**与**可操作提示**（跨 provider 共用一份）。
 *
 * ## 为什么要有这个文件
 *
 * 本仓库有多个 provider 的端点在墙外（Gemini 全部、Qoder 国际版、…）。
 * 它们失败时的**用户可见形态完全同形**：undici 把一切传输层失败压成一句
 * `TypeError: fetch failed`，真因（`UND_ERR_CONNECT_TIMEOUT` / `ENOTFOUND` …）
 * 只挂在 `cause` 链上。若各 provider 各写一份判据，必然出现：
 *
 * - 码表不一致 ⇒ 同一故障在一处报「代理」、在另一处报「凭据失效」；
 * - 文案不一致 ⇒ 用户从 A 渠道学会的处理方式在 B 渠道失效。
 *
 * 本仓库的红线是「**同一语义两套判据**」（见 `astudio-credits.ts` 的注释）——
 * 故判据与码表**只此一份**，文案由调用方按 provider 定制。
 *
 * ## ⚠️ 判据必须读 `cause` 链上的**错误码**，不能读 `message`
 *
 * `message` 恒为 `fetch failed`，用它判会把**所有**传输失败（含 5xx 之后的
 * 读体失败、代理认证失败）都算成「出不去」，于是真·服务端故障被误报成
 * 「你需要配代理」——比不报还糟。
 *
 * ## ⚠️ 这类错误**不要**归 `AUTH` / `QUOTA`
 *
 * 那两类码会连 message 一起吞掉（Issue IKLBSH 的复发形态），恰好把唯一
 * 指路文案吃掉。只能在「展示层」把它当**可读失败原因**返回。
 */

/**
 * 「出不去」的错误码表 —— **全仓唯一一份**。
 *
 * - `UND_ERR_CONNECT_TIMEOUT` / `UND_ERR_SOCKET`：undici 连不上（墙外典型形态，
 *   实测 Qoder 国际版 10.7s 后报这个）。
 * - `ENOTFOUND`：DNS 解析不到。
 * - `ECONNREFUSED` / `EHOSTUNREACH` / `ENETUNREACH`：明确连不上。
 * - `ECONNRESET`：**刻意收进来**。实测 qoder 国际版经 `node:https` 走时是
 *   `ECONNRESET`（19.2s），SNI 阻断的另一种表现；漏掉它会让同一台机器的
 *   同一故障在 fetch / https 两条路上得到相反结论。
 *
 * ⚠️ 与 `refresh.ts` 的 `isUnreachableNetworkError` **刻意不同**：那个是
 * 「是否拉长重试间隔」的判据，收 `ECONNRESET` 会把正常业务的重连也拉长到
 * 30 分钟。两者语义不同，**不合并**（见该函数的注释）。
 */
export const NETWORK_BLOCKED_CODE_RE =
  /UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNRESET/i

/** `cause` 链遍历上限 —— 防病态自引用链（与 `opencode-rpc.ts` 同款处理）。 */
const CAUSE_TRAVERSE_CAP = 8

/**
 * 沿 `cause` 链收集全部错误码（去重、保序）。
 *
 * @returns 形如 `['UND_ERR_CONNECT_TIMEOUT']`；一个都没有时返回空数组
 *   （**不是** `undefined` —— 调用方据此区分「有码但不在表里」与「无码」）。
 */
export function collectCauseCodes(error: unknown): string[] {
  const codes: string[] = []
  let current: unknown = error
  for (let i = 0; i < CAUSE_TRAVERSE_CAP && current !== null && current !== undefined; i += 1) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0 && !codes.includes(code)) codes.push(code)
    current = (current as { cause?: unknown }).cause
  }
  return codes
}

/**
 * 这次失败是否属于「根本出不去」（需要代理 / 换网络）。
 *
 * @param error 原始异常。
 * @param aborted 是否是**自己 arm 的超时**真的触发了。
 *   ⚠️ 调用方必须真的读 `signal.aborted`（或自己 `try/catch` 时已知是自己
 *   abort），不能恒传 `false` —— `AbortSignal.timeout()` 触发的墙外连接超时
 *   **没有** `UND_ERR_*` 错误码（IKLTZ2 审计 P2-2 的实际教训）。
 */
export function isNetworkBlocked(error: unknown, aborted: boolean): boolean {
  if (aborted) return true
  return NETWORK_BLOCKED_CODE_RE.test(collectCauseCodes(error).join(' '))
}

/** {@link networkBlockedHint} 的参数。 */
export interface NetworkBlockedHintParams {
  /** 原始异常。 */
  error: unknown
  /** 是否是自己 arm 的超时真的触发了（见 {@link isNetworkBlocked}）。 */
  aborted: boolean
  /**
   * 面向用户的**主体名**，如 `Google` / `Qoder`。
   * 会拼成「连不上 {subject}{（码）}：…」。
   */
  subject: string
  /**
   * 出路说明 —— **这句话是本函数存在的理由**，必须可操作。
   *
   * ⚠️ 不得写「请联系管理员」这类无出路的废话；也不得许诺本插件没有的能力
   *（例如 Qoder 目前**没有**按账号配代理的按钮，就不能写「点代理按钮」）。
   */
  remedy: string
}

/**
 * 「连不上 {subject}」的用户可读提示（含根因码与出路）。
 *
 * @returns 命中「出不去」时返回提示语；否则返回 `undefined`
 *   （调用方用自己更精确的措辞，**不要**用本函数的文案兜底）。
 */
export function networkBlockedHint(params: NetworkBlockedHintParams): string | undefined {
  if (!isNetworkBlocked(params.error, params.aborted)) return undefined
  const codes = collectCauseCodes(params.error).join(' ').trim()
  const reason = codes.length > 0 ? `（${codes}）` : ''
  return `连不上 ${params.subject}${reason}：${params.remedy}`
}
