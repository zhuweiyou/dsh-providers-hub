/**
 * JWT / 凭据过期时间的通用解析工具。
 *
 * 本模块从原 `buddy.ts` 抽出 —— 这些函数**不是**某个渠道专属：`jwtExpiresAtMs`
 * 被 trae / lobsterai / astudio / gemini 等渠道共用，`credentialExpiresAtMs`
 * 被 jet-hub-rpc / loomy / minimax / modelscope 等共用。抽成独立模块后，
 * 渠道实现可以各自独立演进，不必把它们绑在某个渠道的文件上。
 *
 * 两条纪律（沿用抽取前的既有语义，**不要凭直觉改**）：
 *
 * 1. **只解码、不验签**。这里读出的 `exp` 只用于展示与续期调度，不承担任何
 *    安全判定。验签是服务端的事。
 * 2. **解析失败一律返回 `undefined`，绝不编造值**。各调用方据此判定「时间未知」，
 *    而不是拿到一个看起来合理的假死线（历史上「编造 +7 天」曾导致续期永不触发）。
 */

/** 凭据中承载过期信息的最小形状（各渠道的凭据对象都满足它）。 */
export interface ExpiringCredential {
  readonly expires_at?: unknown
  readonly access_token?: unknown
  readonly refresh_token?: unknown
}

/**
 * 从凭据的 `expires_at` 读取过期时刻（毫秒）。
 *
 * 支持三种形态：毫秒时间戳字符串、秒时间戳字符串、可被 `Date.parse` 解析的
 * 日期串。都读不到时**回退到 access_token 的 JWT `exp`**；仍读不到则
 * `undefined`（= 未知），**不编造**。
 */
export function credentialExpiresAtMs(credential: ExpiringCredential): number | undefined {
  const raw = credential.expires_at
  if (typeof raw === 'string' && raw.length > 0) {
    // 纯数字：视为时间戳。> 1e12 为毫秒，否则为秒。
    if (/^\d+$/.test(raw)) {
      const value = Number(raw)
      return value > 1_000_000_000_000 ? value : value * 1000
    }
    const parsed = Date.parse(raw)
    if (!Number.isNaN(parsed)) return parsed
  }
  const token = credential.access_token
  return typeof token === 'string' ? jwtExpiresAtMs(token) : undefined
}

/**
 * 从 JWT 的 payload 读取 `exp`（秒）并换算为毫秒；非 JWT 或解析失败返回 undefined。
 * 仅做 base64url 解码，不验签——该值只用于展示与续期调度。
 */
export function jwtExpiresAtMs(token: string): number | undefined {
  if (typeof token !== 'string' || token.length === 0) return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

/**
 * 从 JWT payload 读取昵称（`nickname` / `preferred_username` / `name`）。
 * 解析失败返回空串。
 */
export function jwtNickname(token: string): string {
  if (typeof token !== 'string' || token.length === 0) return ''
  const parts = token.split('.')
  if (parts.length < 2) return ''
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>
    const nickname = payload.nickname ?? payload.preferred_username ?? payload.name
    return typeof nickname === 'string' ? stripControlChars(nickname) : ''
  } catch {
    return ''
  }
}

/** 凭据是否已过期；无法解析过期时间时**不判定过期**（对齐 Rust `is_expired`）。 */
export function isExpired(credential: ExpiringCredential): boolean {
  const expiresAt = credentialExpiresAtMs(credential)
  return expiresAt === undefined ? false : Date.now() >= expiresAt
}

/** 凭据是否携带可静默续期的 `refresh_token`。 */
export function isRefreshable(credential: ExpiringCredential): boolean {
  return typeof credential.refresh_token === 'string' && credential.refresh_token.length > 0
}

/**
 * 把控制字符替换成空格并压缩连续空白（JWT 声明里的昵称可能混入）。
 *
 * ⚠️ 语义是**替换 + 压缩**，不是删除：抽取时若写成「直接删掉控制字符」，
 * `a\u0000b` 会从 `a b` 变成 `ab`，与抽取前行为不一致。
 */
function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

/**
 * 渠道产品的通用描述形状。
 *
 * 原先是某个腾讯系渠道的专属配置类型；但选号器、凭据解析器与各渠道的
 * 余额查询都用它做**泛型约束**，实际只要求这几个字段存在。抽成通用形状后，
 * 任何渠道的产品配置都能传进来。
 */
export interface ProviderProduct {
  /** 产品标识（同时用作 provider id 与账本归属）。 */
  readonly id: string
  /** 展示名（用于错误文案）。 */
  readonly displayName: string
  /** API 根地址。 */
  readonly endpoint: string
  /** API 域名（部分渠道用它构造请求头；缺省回落到 endpoint 的主机名）。 */
  readonly apiDomain?: string
  /** 该产品已知的域名集合（用于「外来账号」判定）。 */
  readonly knownDomains?: readonly string[]
  /** 网页端根地址（部分渠道的余额/补偿端点走它）。 */
  readonly webBase?: string
  /** 请求头里的产品码。 */
  readonly productCode?: string
  /** User-Agent。 */
  readonly userAgent?: string
  /** 凭据默认存放的 ref 名。 */
  readonly defaultCredentialRef?: string
}

/**
 * 通用凭据形状：所有渠道的凭据都至少有这两个令牌字段。
 *
 * 它替代原先某个渠道专属的 `Credential` 类型 —— 后者只在**泛型默认值**与
 * **类型断言**处被用到，换成通用形状不改变任何运行时行为。
 */
export interface ChannelCredential {
  /** 访问令牌。 */
  access_token: string
  /** 刷新令牌（可为空串：部分渠道不发）。 */
  refresh_token: string
  /** 过期时间原始值（毫秒/秒时间戳或 ISO 字符串）。 */
  expires_at?: string
  /** refresh_token 过期时间。 */
  refresh_expires_at?: string
  /** 令牌类型。 */
  token_type?: string
  /** OAuth scope。 */
  scope?: string
  /** API 域名。 */
  domain?: string
  /** 用户 ID。 */
  user_id?: string
  /** 用户昵称。 */
  nickname?: string
  /** 企业 ID。 */
  enterprise_id?: string
  /** 账户类型。 */
  account_type?: string
}
