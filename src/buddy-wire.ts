/**
 * buddy / workbuddy 出站 wire 对齐层。
 *
 * ## 为什么有这个文件
 *
 * 本仓库的 `buddy-adapter.ts` 只发「够用」的最小请求形态（多轮真机验证过：
 * 多数账号上连鉴权头全删都回 200），而参考实现 `workbuddy2api-panel`
 * （Go 反代，长期在真实流量上跑）走的是「**完整对齐官方客户端形态**」的路线：
 * 请求头覆盖到 B3 链路族/设备指纹族，请求体多走 8 条归一化管线，内容侧还多两条
 * 指纹。用户报「本仓库用不了、对端可用」后，本轮统一按**对端**对齐。
 *
 * ## 边界（刻意不做的部分）
 *
 * - **UA / `X-Product` 归属名不互换**：对端是「WorkBuddy 桌面端」形态，本仓库
 *   `buddy` 是 IDE 登录（`CodeBuddyIDE/…`）。形态与登录方式绑定，互换会让后台
 *   「使用端」归因错位。故本文件不碰 UA。
 * - **模板句指纹仍只改 system / assistant 正文**：本仓库有 role 级真机台账
 *   （`buddy-fingerprint-roles.e2e.spec.ts`）证明 user / tool / reasoning /
 *   arguments **不拦**，改它们是净损失（篡改用户原话与工具证据）。
 *   唯一例外见 {@link rewriteBareProbe}`：裸错误码反探测是**整单级**规则，
 *   与 role 无关，故对全角色生效。
 * - **`developer` 角色**：本仓库 `message-shape.ts` 会先丢弃 developer 消息
 *   （它只承载工具增删元数据），故本文件的 `developer→system` 归一只是**兜底**
 *   （消息经别的入口进来时仍能过闸），不改变既有丢弃行为。
 *
 * 每条 pass 的证据强度在各自注释里标注：`[对端实案]` = 对端仓库记录的线上事故，
 * `[本仓实测]` = 本仓库 e2e 台账，`[对齐]` = 无独立实测、仅为与对端形态一致。
 */

/** 消息在 wire 上的最小形状（本模块只用这几个维度）。 */
export type WireMessage = Record<string, unknown>

/** 一次请求的 wire 上下文（决定哪些 pass 生效）。 */
export interface BuddyWireContext {
  /** 模型 id（用于 GPT 系 `max_tokens` 下限与 deepseek 系判定）。 */
  model: string
  /**
   * 是否已开启思考（`thinking.type === 'enabled'`）。
   * deepseek 系回填 `reasoning_content` 的门控之一，见 {@link backfillReasoningContent}。
   */
  thinkingEnabled?: boolean
  /**
   * 裸错误码反探测改写函数（`11-128` → 等价改写）。
   *
   * 由调用方注入而非本模块 import 指纹表，理由：本模块必须保持「纯 JSON 变换」，
   * 便于单测逐 pass 验证；指纹表在 `openai-gateway/tencent-fingerprint.ts`，
   * 那里还有自己的一套作用域规则（只改 system / assistant）。
   * 省略 = 不做该改写。
   */
  rewriteBareProbe?: (text: string) => string
}

/** GPT 系模型上游接受的 `max_tokens` 下限（对端实案：15 拒 / 16 过）。 */
export const GPT_MIN_MAX_TOKENS = 16

// ───────────────────────────────────────────────────────────────────────────
// 请求头族
// ───────────────────────────────────────────────────────────────────────────

/**
 * 按 uid 稳定派生设备/会话标识（36 hex）。
 *
 * 对齐对端 `deriveAccountStableID`：同一账号跨重启恒定、账号间互异、同 uid 幂等。
 * 用途：
 * - `purpose: 'machine'` → `X-Machine-ID`（设备级）
 * - `purpose: 'session'` → `X-Session-ID`（账号固定会话）
 *
 * `[对齐]` 对端用 `"wb2a:"` 盐；此处改用本仓库自己的盐，避免与对端进程生成的
 * 标识完全一致（多客户端撞同一指纹反而不像真实设备）。
 */
export function derivedStableId(
  uid: string,
  purpose: 'machine' | 'session',
  createHash: (input: string) => string,
): string {
  return createHash(`dsh-buddy:${purpose}:${uid}`)
}

/** 一次 chat 出站的会话头族取值（对齐对端 `ChatMeta` + `injectConversationHeaders`）。 */
export interface ConversationHeaderValues {
  'X-Conversation-ID': string
  'X-Conversation-Request-ID': string
  'X-Conversation-Message-ID': string
  'X-Request-ID': string
  'X-Root-Request-ID': string
  'X-Trace-ID': string
  'X-B3-TraceId': string
  'X-B3-SpanId': string
  'X-B3-Sampled': string
}

/** B3 规范只认 16 或 32 位 hex 的 TraceId。 */
export function isB3TraceId(value: string): boolean {
  return /^[0-9a-fA-F]{16}$|^[0-9a-fA-F]{32}$/.test(value)
}

/**
 * 构造会话头族。
 *
 * | 头 | 语义 | 取值 |
 * |---|---|---|
 * | `X-Conversation-ID` | 会话级、多轮稳定 | 入站有则透传，否则补一个 32hex |
 * | `X-Conversation-Request-ID` | **一次 user send 内聚合主键**（重试/换号复用同值） | 调用方生成的 32hex |
 * | `X-Conversation-Message-ID` / `X-Request-ID` | 消息级、逐消息独立 | 每次新 32hex |
 * | `X-Root-Request-ID` | 根请求追踪 | = Request-ID 聚合主键 |
 * | `X-Trace-ID` | 链路 | 入站透传或 = 聚合主键 |
 * | `X-B3-*` | 链路族 | TraceId 非法时回落 32hex 消息级 id |
 *
 * `[对端实案]` 对端 issue #35 / #190：后台按 `X-Conversation-Request-ID` 聚合
 * 「一次发送」，缺 `X-Conversation-ID` 会 400（`conversation id missing`）。
 */
export function buildConversationHeaders(meta: {
  conversationId?: string
  conversationRequestId: string
  messageId: string
  traceId?: string
}): ConversationHeaderValues {
  const conversationId = meta.conversationId && meta.conversationId.length > 0
    ? meta.conversationId
    : meta.conversationRequestId
  const b3Trace = isB3TraceId(meta.conversationRequestId) ? meta.conversationRequestId : meta.messageId
  return {
    'X-Conversation-ID': conversationId,
    'X-Conversation-Request-ID': meta.conversationRequestId,
    'X-Conversation-Message-ID': meta.messageId,
    'X-Request-ID': meta.messageId,
    'X-Root-Request-ID': meta.conversationRequestId,
    'X-Trace-ID': meta.traceId && meta.traceId.length > 0 ? meta.traceId : meta.conversationRequestId,
    'X-B3-TraceId': b3Trace,
    'X-B3-SpanId': meta.messageId.slice(0, 16),
    'X-B3-Sampled': '1',
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 请求体管线
// ───────────────────────────────────────────────────────────────────────────

/**
 * 出站请求体归一化（对齐对端 `PrepareBodyOptWithEffortsAndDefault` 的**结构类** pass）。
 *
 * 档位降级与 `thinking` 注入**不在这里**：它们由 `buddy-adapter.ts` 在构造 body 时
 * 就按「只发模型声明支持的档」实现，语义已等价（对端是服务端降级，本仓库是客户端丢弃）。
 *
 * 执行顺序与对端一致，且**顺序本身有语义**（见各 pass 注释与
 * `mergeAdjacentToolCalls` 前的说明）。
 */
export function prepareBuddyBody(
  body: Record<string, unknown>,
  ctx: BuddyWireContext,
): void {
  body['stream'] = true
  translateMaxCompletionTokens(body)
  clampGptMinMaxTokens(body, ctx.model)
  ensureStreamOptions(body)
  normalizeToolChoice(body)
  unescapeSchemaPatterns(body)
  normalizeDeveloperRole(body)
  normalizeImageUrlParts(body)
  dropReasoningParts(body)
  // ⚠️ 顺序不可换：merge 必须最先跑 —— 它把「背靠背的两条 assistant.tool_calls」
  // 合成一条，之后的 repack 才看得到完整的一批调用（对端 tool_pairing.go 原文）。
  const messages = asMessageArray(body['messages'])
  if (messages !== undefined) {
    mergeAdjacentToolCalls(messages)
    repackToolResultBlocks(messages)
    cleanupOrphanToolCalls(messages)
    backfillReasoningContent(messages, ctx)
    if (ctx.rewriteBareProbe !== undefined) rewriteBareProbeEverywhere(messages, ctx.rewriteBareProbe)
    body['messages'] = messages
  }
}

/**
 * `max_completion_tokens` → `max_tokens` 翻译。
 *
 * `[对端实案]` OpenAI 规范里 `max_tokens` 已 deprecated、`max_completion_tokens`
 * 是新字段，DeepSeek Harness 等新客户端只发别名；上游只认 `max_tokens` ⇒ 别名
 * 被忽略后回落默认上限（实测 32000），长流任务被截。
 *
 * 边界（照抄对端）：显式 `max_tokens` 优先（别名只删）；别名非正数（0/null/负数）
 * 不翻译（0/null 语义是「未设置」，负数是非法值）；非数值别名不翻译（原样透传，
 * 由上游报参数错）。无论翻译与否，别名一律删（减少 body 体积与排障噪音）。
 */
export function translateMaxCompletionTokens(body: Record<string, unknown>): void {
  const alias = body['max_completion_tokens']
  delete body['max_completion_tokens']
  if (alias === undefined) return
  if (body['max_tokens'] !== undefined) return
  if (typeof alias === 'number' && Number.isInteger(alias) && alias > 0) {
    body['max_tokens'] = alias
  }
}

/** GPT 系 `max_tokens` 抬到 {@link GPT_MIN_MAX_TOKENS}（对端实案：15 拒 / 16 过）。 */
export function clampGptMinMaxTokens(body: Record<string, unknown>, model: string): void {
  if (!/gpt-/i.test(model)) return
  const raw = body['max_tokens']
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return
  if (raw < GPT_MIN_MAX_TOKENS) body['max_tokens'] = GPT_MIN_MAX_TOKENS
}

/**
 * 补 `stream_options.include_usage`（缺则补，显式带则不动）。
 *
 * `[对端实案]` 官方 CLI 流式必发该字段，上游据此在末帧返回 `usage`。
 * `[本仓实测]` 本仓库不靠它也能拿到 `usage`（`buddy-cache-probe` 直接 dump 到
 * `cached_tokens=7808`），故这一步是**形态对齐 + 兜底**，不是命中前提。
 */
export function ensureStreamOptions(body: Record<string, unknown>): void {
  if (body['stream_options'] === undefined) {
    body['stream_options'] = { include_usage: true }
  }
}

/**
 * `tool_choice` 归一为上游认的字符串形态。
 *
 * `[对端实案]` 上游该字段是 string，对象形式会 400 `code=11101`；
 * `none` 时还要连带删掉 `tools`/`functions`（上游对「声明了工具却禁用」也会挑）。
 */
export function normalizeToolChoice(body: Record<string, unknown>): void {
  const present = body['tool_choice']
  if (present === undefined) return
  const suppress = (): void => {
    delete body['tools']
    delete body['functions']
  }
  if (typeof present === 'string') {
    if (present.trim().toLowerCase() === 'none') {
      delete body['tool_choice']
      suppress()
    }
    return
  }
  if (typeof present !== 'object' || present === null) {
    delete body['tool_choice']
    return
  }
  const choice = present as Record<string, unknown>
  const type = typeof choice['type'] === 'string' ? choice['type'].trim().toLowerCase() : ''
  if (type === 'none') {
    delete body['tool_choice']
    suppress()
    return
  }
  if (type === 'auto' || type === 'required') {
    body['tool_choice'] = type
    return
  }
  if (type === 'function') {
    const fn = choice['function']
    let name = ''
    if (typeof fn === 'object' && fn !== null) {
      const raw = (fn as Record<string, unknown>)['name']
      if (typeof raw === 'string') name = raw.trim()
    }
    if (name.length === 0 && typeof choice['name'] === 'string') name = choice['name'].trim()
    body['tool_choice'] = name.length > 0 ? name : 'auto'
    return
  }
  delete body['tool_choice']
}

/**
 * 归一 tool schema 里 `pattern` 的非法转义 `\_` → `_`。
 *
 * `[对端实案]` 2026-09-29/30 两次线上 503：上游对 `tools[].function.parameters`
 * 做严格 JSON-Schema/正则文法校验，`pattern` 含 `\_`（转义下划线）会整体拒收
 * （`code=11129 invalid_function_call_parameters`，displayMsg「工具定义不合规」）。
 * 实案来源是第三方插件的 `^agent\_run\_` —— **schema 级拒绝换账号无用**，只能在
 * 发送前修。归一无损：`\_` 与 `_` 在所有正则引擎里匹配语义相同。
 *
 * 只动 `tools` 子树（`pattern` 值 + `patternProperties` 键），消息正文里的 `\_`
 * （如 Windows 路径 `C:\_x`）不碰 —— 与对端「不扩面」的取舍一致。
 */
export function unescapeSchemaPatterns(body: Record<string, unknown>): void {
  const tools = body['tools']
  if (!Array.isArray(tools)) return
  for (const raw of tools) {
    if (typeof raw !== 'object' || raw === null) continue
    const tool = raw as Record<string, unknown>
    const fn = tool['function']
    if (typeof fn === 'object' && fn !== null) {
      unescapePatternTree((fn as Record<string, unknown>)['parameters'])
    }
    unescapePatternTree(tool['parameters'])
  }
}

function unescapePatternTree(node: unknown): void {
  if (typeof node !== 'object' || node === null) return
  if (Array.isArray(node)) {
    for (const item of node) unescapePatternTree(item)
    return
  }
  const obj = node as Record<string, unknown>
  const pattern = obj['pattern']
  if (typeof pattern === 'string' && pattern.includes('\\_')) {
    obj['pattern'] = pattern.split('\\_').join('_')
  }
  const props = obj['patternProperties']
  if (typeof props === 'object' && props !== null && !Array.isArray(props)) {
    const entries = Object.entries(props as Record<string, unknown>)
    if (entries.some(([key]) => key.includes('\\_'))) {
      const rebuilt: Record<string, unknown> = {}
      for (const [key, value] of entries) {
        rebuilt[key.split('\\_').join('_')] = value
        unescapePatternTree(value)
      }
      obj['patternProperties'] = rebuilt
      return
    }
    for (const [, value] of entries) unescapePatternTree(value)
    return
  }
  for (const value of Object.values(obj)) unescapePatternTree(value)
}

/** `developer` 角色 → `system`（上游只认 system/user/assistant/tool）。`[对齐]` */
export function normalizeDeveloperRole(body: Record<string, unknown>): void {
  const messages = asMessageArray(body['messages'])
  if (messages === undefined) return
  for (const message of messages) {
    const role = message['role']
    if (typeof role === 'string' && role.trim().toLowerCase() === 'developer') {
      message['role'] = 'system'
    }
  }
}

/**
 * `image_url` 两种写法归一：字符串 → `{ url }` 对象。
 *
 * `[对端实案]` 上游只认 OpenAI 对象形态，字符串会 400 `code=11101`
 * （`cannot unmarshal string into … ImageContent`）。只做形状转换，不补默认值 ——
 * 空串/缺失/非法 url 一律透传，让上游报真实错误。
 */
export function normalizeImageUrlParts(body: Record<string, unknown>): void {
  const messages = asMessageArray(body['messages'])
  if (messages === undefined) return
  for (const message of messages) {
    const parts = message['content']
    if (!Array.isArray(parts)) continue
    for (const raw of parts) {
      if (typeof raw !== 'object' || raw === null) continue
      const part = raw as Record<string, unknown>
      if (part['type'] !== 'image_url') continue
      const value = part['image_url']
      if (typeof value === 'string') part['image_url'] = { url: value }
    }
  }
}

/**
 * 剔除 `content` 数组里的 `reasoning_text` / `reasoning` part。
 *
 * `[对端实案]` 部分客户端把思维链作为 content part 回放，上游不认这个 part 类型
 * 会整条 400。剔除后如果数组空了：**带 tool_calls 的消息保留空数组**（它需要
 * `content` 键承接 `null` 语义），否则删掉整条消息 —— 一条没有任何内容的
 * assistant 消息会变成「空发言」，把 400 挪到上游。
 */
export function dropReasoningParts(body: Record<string, unknown>): void {
  const messages = asMessageArray(body['messages'])
  if (messages === undefined) return
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    const parts = message['content']
    if (!Array.isArray(parts)) continue
    const kept = parts.filter((raw) => {
      if (typeof raw !== 'object' || raw === null) return true
      const type = (raw as Record<string, unknown>)['type']
      if (typeof type !== 'string') return true
      const normalized = type.trim()
      return normalized !== 'reasoning_text' && normalized !== 'reasoning'
    })
    if (kept.length === parts.length) continue
    if (kept.length === 0) {
      if (message['tool_calls'] === undefined) {
        messages.splice(i, 1)
        continue
      }
    }
    message['content'] = kept
  }
}

/**
 * 合并「背靠背的两条 assistant.tool_calls」。
 *
 * `[对端实案]` 部分 OpenAI 兼容 agent 客户端把并行调用回放成**两条相邻 assistant**：
 * `assistant(空正文, tool_calls=[c1])` + `assistant(空正文, tool_calls=[c2])`。
 * 上游 deepseek 系对这种形态回 400 `code=11148`（`tool calls and tool results
 * do not match, please start a new conversation`），**整条会话报废** ——
 * 客户端每次重试重放同一历史，换号也无效（不是账号问题）。对照实测：
 * 拆两条 + `deepseek-v4.1-flash` → 503/11148；合成一条 → 200；
 * 拆两条 + `glm-5.3-flash` → 200（该模型宽容）。
 *
 * 合并条件从严（不猜语义）：
 * - 两条**相邻**（中间隔任何消息都不合并）；
 * - 后一条 `content` 为空（非空无法无损拼接）；
 * - 前一条本身是带 `tool_calls` 的 assistant。
 *
 * 还支持**反向**形态：`assistant(正文)` 紧跟 `assistant(空正文, tool_calls)`
 * —— 把正文折进取 tool_calls 的那条（部分客户端把正文与调用声明拆两条）。
 *
 * `reasoning_content` / `reasoning` 不丢：后一条有则搬入，两边都有则换行拼接
 * （deepseek 多轮要求 assistant 带思维链回填，丢弃会换一个错误）。
 */
export function mergeAdjacentToolCalls(messages: WireMessage[]): void {
  let index = 1
  while (index < messages.length) {
    const current = messages[index]!
    const previous = messages[index - 1]!
    if (current['role'] !== 'assistant' || previous['role'] !== 'assistant') {
      index++
      continue
    }
    const previousCalls = previous['tool_calls']
    const currentCalls = current['tool_calls']
    // 形态一：后一条带 tool_calls 且无正文 → 并入前一条（前一条也须带 tool_calls）。
    if (Array.isArray(currentCalls) && currentCalls.length > 0 && isEmptyContent(current['content'])
      && Array.isArray(previousCalls) && previousCalls.length > 0) {
      previous['tool_calls'] = [...previousCalls, ...currentCalls]
      mergeReasoningFields(previous, current)
      messages.splice(index, 1)
      continue
    }
    // 形态二：后一条是纯字符串正文且无 tool_calls → 折进前一条（前一条须无正文）。
    if (currentCalls === undefined && typeof current['content'] === 'string' && current['content'].length > 0
      && Array.isArray(previousCalls) && previousCalls.length > 0 && isEmptyContent(previous['content'])) {
      previous['content'] = current['content']
      mergeReasoningFields(previous, current)
      messages.splice(index, 1)
      continue
    }
    index++
  }
}

function isEmptyContent(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim().length === 0
  if (Array.isArray(value)) return value.length === 0
  return false
}

function mergeReasoningFields(target: WireMessage, source: WireMessage): void {
  for (const key of ['reasoning_content', 'reasoning'] as const) {
    const incoming = source[key]
    if (typeof incoming !== 'string' || incoming.length === 0) continue
    const existing = target[key]
    if (typeof existing !== 'string' || existing.length === 0) {
      target[key] = incoming
      continue
    }
    target[key] = `${existing}\n${incoming}`
  }
}

/**
 * 把插在同一批 tool 结果中间的非 tool 消息挪到整组之后。
 *
 * `[对端实案]` Codex 的 `image_resize_notice` 会以 developer/system 消息插在两份
 * tool 结果中间（并行调用时）：
 *
 * ```
 * assistant tool_calls=[c00 c01] | tool c00 | developer <notice> | tool c01
 * ```
 *
 * OpenAI 兼容协议要求 tool 结果紧跟 assistant，中间插任何消息都算配对断裂，
 * 上游判 11148 并顶死整条会话。这里**只调顺序、不改内容**：
 *
 * ```
 * assistant tool_calls=[c00 c01] | tool c00 | tool c01 | X
 * ```
 *
 * 结果顺序保持不变（同批 tool_call 的原相对顺序 = 结果顺序）。
 */
export function repackToolResultBlocks(messages: WireMessage[]): void {
  if (messages.length < 3) return
  const out: WireMessage[] = []
  let index = 0
  while (index < messages.length) {
    const message = messages[index]!
    const calls = message['tool_calls']
    if (message['role'] !== 'assistant' || !Array.isArray(calls) || calls.length === 0) {
      out.push(message)
      index++
      continue
    }
    const wanted = new Set<string>()
    for (const raw of calls) {
      if (typeof raw !== 'object' || raw === null) continue
      const id = (raw as Record<string, unknown>)['id']
      if (typeof id === 'string' && id.length > 0) wanted.add(id)
    }
    out.push(message)
    index++
    const results: WireMessage[] = []
    const between: WireMessage[] = []
    while (index < messages.length) {
      const next = messages[index]!
      const role = next['role']
      if (role === 'tool') {
        const id = next['tool_call_id']
        if (typeof id !== 'string' || !wanted.has(id)) break
        results.push(next)
        index++
        continue
      }
      if (results.length === 0) break // assistant 后没有结果：交给 cleanupOrphanToolCalls
      // 下一组 assistant.tool_calls 是新的组头，绝不能当插入物吞掉。
      if (role === 'assistant') {
        const nextCalls = next['tool_calls']
        if (Array.isArray(nextCalls) && nextCalls.length > 0) break
      }
      between.push(next)
      index++
    }
    out.push(...results, ...between)
  }
  messages.length = 0
  messages.push(...out)
}

/**
 * 孤儿 tool 配对清理：**逐 id 对称裁剪**。
 *
 * `[对端实案]` 老实现是「批内每个 id 都齐才整批保留，否则删掉整个 tool_calls」，
 * 那会留下无主结果（批 `[c1,c2]` 只回了 c1 ⇒ 调用侧整批被删、`tool{c1}` 按 id
 * 仍命中而保留）⇒ 出站载荷变成「无 tool_calls 的 assistant + 孤儿 tool」⇒
 * 上游 11148 顶死整条会话。现改为两侧共用同一份 keepCalls 按 id 对称裁剪。
 *
 * 空名称（含纯空白）的调用一律不保留：上游对这类条目直接判
 * `11133 model_param_invalid`（`tool_calls[i].function.name must be a non-empty
 * string`），带不带配对结果都会被拒。
 *
 * 无任何工具流量时零改动（不重排、不重建数组）。
 */
export function cleanupOrphanToolCalls(messages: WireMessage[]): void {
  const callIds = new Set<string>()
  const resultIds = new Set<string>()
  const badNameIds = new Set<string>()
  for (const message of messages) {
    if (message['role'] === 'tool') {
      const id = message['tool_call_id']
      if (typeof id === 'string' && id.length > 0) resultIds.add(id)
      continue
    }
    if (message['role'] !== 'assistant') continue
    const calls = message['tool_calls']
    if (!Array.isArray(calls)) continue
    for (const raw of calls) {
      if (typeof raw !== 'object' || raw === null) continue
      const call = raw as Record<string, unknown>
      const id = call['id']
      if (typeof id !== 'string' || id.length === 0) continue
      callIds.add(id)
      if (!hasUsableCallName(call)) badNameIds.add(id)
    }
  }
  if (callIds.size === 0 && resultIds.size === 0) return

  const keep = new Set<string>()
  for (const id of callIds) {
    if (badNameIds.has(id)) continue
    if (resultIds.has(id)) keep.add(id)
  }

  // 1) assistant.tool_calls：按 keep 对称裁剪，空则删掉整个 tool_calls 键。
  for (const message of messages) {
    if (message['role'] !== 'assistant') continue
    const calls = message['tool_calls']
    if (!Array.isArray(calls)) continue
    const kept = calls.filter((raw) => {
      if (typeof raw !== 'object' || raw === null) return false
      const id = (raw as Record<string, unknown>)['id']
      return typeof id === 'string' && keep.has(id)
    })
    if (kept.length === calls.length) continue
    if (kept.length === 0) delete message['tool_calls']
    else message['tool_calls'] = kept
  }

  // 2) role:tool 消息：对应调用未保留则整条删除。
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message['role'] !== 'tool') continue
    const id = message['tool_call_id']
    if (typeof id === 'string' && keep.has(id)) continue
    messages.splice(i, 1)
  }
}

/** 工具调用名是否可用（空串/纯空白都不可用 —— 上游 11133）。 */
export function hasUsableCallName(call: Record<string, unknown>): boolean {
  const fn = call['function']
  if (typeof fn === 'object' && fn !== null) {
    const name = (fn as Record<string, unknown>)['name']
    if (typeof name === 'string') return name.trim().length > 0
    return false
  }
  const legacy = call['name']
  if (typeof legacy === 'string') return legacy.trim().length > 0
  return false
}

/** 序列化前的配对判据（对齐对端 `keepCalls` 语义，供 `resolveToolPairing` 的 buddy 变体使用）。 */
export function resolveToolPairingPerCall(
  messages: readonly { role: string, content?: unknown }[],
): { keepCallIds: Set<string>, keepResultIds: Set<string> } {
  const resultIds = new Set<string>()
  for (const message of messages) {
    const parts = Array.isArray(message.content) ? message.content : []
    for (const raw of parts) {
      if (typeof raw !== 'object' || raw === null) continue
      const block = raw as Record<string, unknown>
      if (block['type'] !== 'tool-result') continue
      resultIds.add(String(block['toolCallId']))
    }
  }
  const keepCallIds = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const parts = Array.isArray(message.content) ? message.content : []
    for (const raw of parts) {
      if (typeof raw !== 'object' || raw === null) continue
      const block = raw as Record<string, unknown>
      if (block['type'] !== 'tool-call') continue
      const name = block['name']
      if (typeof name !== 'string' || name.trim().length === 0) continue
      const id = String(block['id'])
      // 逐 id 判定：只要这一个调用有结果就保留它，同批其余的不达标不影响它。
      if (resultIds.has(id)) keepCallIds.add(id)
    }
  }
  const keepResultIds = new Set<string>()
  for (const id of keepCallIds) {
    if (resultIds.has(id)) keepResultIds.add(id)
  }
  return { keepCallIds, keepResultIds }
}

/**
 * deepseek 系多轮回填 `reasoning_content` / `reasoning`，并保证「非空」。
 *
 * `[对端实案]` 部分账号/租户对 thinking 形态校验 `len(reasoning) > 0`：
 * **空串 400、空白串 200**（上游不 trim）。故缺失/空串时补单个空格 ——
 * 该字段是透传校验位、非内容消费位，对模型上下文无语义影响。
 *
 * 门控对齐官方 `ReasoningContentBackfillRule`（`thinkingEnabled || hasTrace`）：
 * - 非 deepseek 系 → 零改动；
 * - `thinkingEnabled`（注入后的 `thinking.type === 'enabled'`）→ 每条 assistant 都补；
 * - 无 thinking 但历史里有思维链痕迹（`hasTrace`）→ 同样补（官方 disabled 分支）。
 */
export function backfillReasoningContent(messages: WireMessage[], ctx: BuddyWireContext): void {
  if (!/^deepseek/i.test(ctx.model.trim())) return
  const assistants = messages.filter(message => message['role'] === 'assistant')
  if (assistants.length === 0) return
  const hasTrace = messages.some((message) => {
    const reasoning = message['reasoning']
    if (typeof reasoning === 'string' && reasoning.length > 0) return true
    return message['reasoning_content'] !== undefined
  })
  if (ctx.thinkingEnabled !== true && !hasTrace) return
  for (const message of assistants) {
    const content = message['reasoning_content']
    const reasoning = message['reasoning']
    if (typeof content === 'string' && content.length > 0) {
      if (typeof reasoning !== 'string' || reasoning.length === 0) message['reasoning'] = content
      continue
    }
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      message['reasoning_content'] = reasoning
      continue
    }
    // 两者皆无/皆空 → 补空白串（空串会 400，见上）。
    message['reasoning_content'] = ' '
    message['reasoning'] = ' '
  }
}

/**
 * 裸错误码反探测改写（对所有角色、所有文本字段生效）。
 *
 * `[对端实案]` 2026-09-13 实验 F4：只要请求体里出现裸错误码就会**整单拦截**，
 * 与该数字的上下文无关（`code=…` / 裸串 / `错误码 …` 全命中），而相邻的其他错误码
 * 放行 —— 上游据此识别「在讨论/回显其内部错误码」的请求。
 *
 * ⚠️ **这是本文件唯一越出「只改 system/assistant」的 pass**：它是**整单级**规则、
 * 与 role 无关。排查类会话里「把报错原文粘进对话」是必然发生的（本仓库自己的
 * 错误文案就含该码）⇒ user 消息不改写会直接失败。模板句指纹仍按 role 级台账
 * 只改 system/assistant（见模块头）。
 */
export function rewriteBareProbeEverywhere(
  messages: WireMessage[],
  rewrite: (text: string) => string,
): void {
  const apply = (value: unknown): unknown => {
    if (typeof value === 'string') return rewrite(value)
    return value
  }
  for (const message of messages) {
    for (const key of ['content', 'reasoning_content', 'reasoning'] as const) {
      const value = message[key]
      if (typeof value === 'string') {
        message[key] = apply(value)
        continue
      }
      if (Array.isArray(value)) {
        for (const raw of value) {
          if (typeof raw !== 'object' || raw === null) continue
          const part = raw as Record<string, unknown>
          if (typeof part['text'] === 'string') part['text'] = rewrite(part['text'])
        }
      }
    }
    const calls = message['tool_calls']
    if (!Array.isArray(calls)) continue
    for (const raw of calls) {
      if (typeof raw !== 'object' || raw === null) continue
      const fn = (raw as Record<string, unknown>)['function']
      if (typeof fn !== 'object' || fn === null) continue
      const args = (fn as Record<string, unknown>)['arguments']
      if (typeof args === 'string') (fn as Record<string, unknown>)['arguments'] = rewrite(args)
    }
  }
}

function asMessageArray(value: unknown): WireMessage[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value as WireMessage[]
}

// ───────────────────────────────────────────────────────────────────────────
// 请求头装配（对齐对端 `CommonHeaders` + `ChatHeaders`）
// ───────────────────────────────────────────────────────────────────────────

/** 装配 chat 请求头所需的全部输入（与产品/凭据相关的部分由调用方给）。 */
export interface ChatHeaderInputs {
  /** `X-Domain` 的取值来源：产品的 `apiDomain`（token 的 `iss` 域）。 */
  apiDomain: string
  /** 网页端站（`webOrigin`）：`Origin` = 它，`Referer` = 它 + `/`。 */
  webOrigin: string
  /** `zh-CN`（CN）/ `en-US`（国际版）。 */
  acceptLanguage: string
  accessToken: string
  /** 账号 uid；缺失时按对端约定发 `X-No-User-Id: 1`。 */
  uid?: string
  /** 企业 id（个人账号为空）。 */
  enterpriseId?: string
  /** 设备风控 token（凭据里登录时上游签发的那一枚）。 */
  deviceToken?: string
  /** 是否国际版（决定企业/域声明头走哪一支）。 */
  isGlobal: boolean
  /** 轮级聚合主键（`X-Conversation-Request-ID` / `X-Root-Request-ID`）。 */
  conversationRequestId: string
  /** 消息级 id（`X-Conversation-Message-ID` / `X-Request-ID`）。 */
  messageId: string
  /** 会话级 id；缺省回落 `conversationRequestId`。 */
  conversationId?: string
  /** 链路 trace；缺省回落 `conversationRequestId`。 */
  traceId?: string
  /** 36 hex 稳定派生（见 {@link derivedStableId}）；由调用方注入 hash 实现。 */
  createHash: (input: string) => string
}

/**
 * 装配一次 chat 出站的请求头（**不含** UA 与归属头族 —— 那两组是产品身份，
 * 由适配器按产品/模型决定）。
 *
 * 逐头的依据与「谁更硬」的证据强度见模块头；这里只记**分支结构**：
 *
 * | 分支 | 发送内容 |
 * |---|---|
 * | CN（个人账号） | `X-No-Enterprise-Id: 1` + `X-Domain: <apiDomain>`（域为空则 `X-No-Department-Info: 1`） |
 * | CN（有企业） | `X-Enterprise-Id: <id>` + `X-Domain` |
 * | 国际版 | `X-No-Enterprise-Id: 1` + `X-Domain: <apiDomain>`（恒不发明细） |
 *
 * ⚠️ 对端在 global 分支把 `X-Domain` 固定成 `www.workbuddy.ai`；本仓库取
 * `apiDomain`（值相同），避免再写一份可能与产品配置漂移的常量。
 */
export function buildChatHeaders(inputs: ChatHeaderInputs): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'x-requested-with': 'XMLHttpRequest',
    origin: inputs.webOrigin,
    referer: `${inputs.webOrigin}/`,
    // 官方客户端的「风控闸门头」：所有 API 请求都带（对端 D1）。
    'x-codebuddy-request': '1',
    'accept-language': inputs.acceptLanguage,
    authorization: `Bearer ${inputs.accessToken}`,
  }

  if (inputs.uid !== undefined && inputs.uid.length > 0) {
    headers['x-user-id'] = inputs.uid
  } else {
    headers['x-no-user-id'] = '1'
  }

  const enterpriseId = inputs.enterpriseId ?? ''
  if (inputs.isGlobal) {
    // 国际版：个人账号声明无企业 + 显式声明国际版域。
    headers['x-no-enterprise-id'] = '1'
    headers['x-domain'] = inputs.apiDomain
  } else if (enterpriseId.length > 0) {
    headers['x-enterprise-id'] = enterpriseId
    headers['x-domain'] = inputs.apiDomain
  } else {
    headers['x-no-enterprise-id'] = '1'
    if (inputs.apiDomain.length > 0) headers['x-domain'] = inputs.apiDomain
    else headers['x-no-department-info'] = '1'
  }

  // 设备指纹族：按 uid 稳定派生（跨重启恒定、账号间互异）。
  if (inputs.uid !== undefined && inputs.uid.length > 0) {
    headers['x-machine-id'] = derivedStableId(inputs.uid, 'machine', inputs.createHash)
    headers['x-session-id'] = derivedStableId(inputs.uid, 'session', inputs.createHash)
  }
  if (inputs.deviceToken !== undefined && inputs.deviceToken.length > 0) {
    headers['x-device-token'] = inputs.deviceToken
  }

  const conversation = buildConversationHeaders({
    ...inputs.conversationId !== undefined ? { conversationId: inputs.conversationId } : {},
    conversationRequestId: inputs.conversationRequestId,
    messageId: inputs.messageId,
    ...inputs.traceId !== undefined ? { traceId: inputs.traceId } : {},
  })
  return { ...headers, ...lowerCaseKeys({ ...conversation }) }
}

/** 头名统一小写（HTTP 字段名大小写不敏感，混写只会让排障时对不上）。 */
function lowerCaseKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value
  return out
}
