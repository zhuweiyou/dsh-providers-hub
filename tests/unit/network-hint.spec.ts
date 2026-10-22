/**
 * `src/network-hint.ts` —— 「连不上」的统一判据与提示。
 *
 * ## 这些用例守的是什么
 *
 * 该模块是从 `gemini-proxy.ts` 的 `geminiNetworkHint` 抽出来的**全仓唯一一份**
 * 判据。抽出来的动机是真实的报障：Qoder 国际版被 SNI 阻断时，面板只显示
 * 「积分查询失败（凭据失效或响应异常）」—— 把**网络不通**说成**凭据问题**，
 * 用户于是反复重新登录，永远修不好。
 *
 * ⇒ 用例分两组：① 判据（哪些错误算「出不去」、哪些**不算**）② 文案
 *（能不能让人据此做对一件事）。
 */

import { describe, expect, it } from 'vitest'

import {
  NETWORK_BLOCKED_CODE_RE,
  collectCauseCodes,
  isNetworkBlocked,
  networkBlockedHint,
} from '../../src/network-hint.js'

/** 造一个带 cause 链的 `fetch failed`（Node/undici 的真实形态）。 */
function fetchFailed(code: string, depth = 1): Error {
  let error: Error = new Error(`leaf ${code}`) as Error & { code?: string }
  ;(error as Error & { code?: string }).code = code
  for (let i = 1; i < depth; i += 1) {
    error = new TypeError('fetch failed', { cause: error })
  }
  return error
}

describe('collectCauseCodes（沿 cause 链收码）', () => {
  it('单层 cause：取到码', () => {
    const error = new TypeError('fetch failed', { cause: fetchFailed('UND_ERR_CONNECT_TIMEOUT') })
    expect(collectCauseCodes(error)).toEqual(['UND_ERR_CONNECT_TIMEOUT'])
  })

  it('多层 cause：能穿到底', () => {
    const error = new TypeError('fetch failed', {
      cause: new TypeError('nested', { cause: fetchFailed('ECONNRESET') }),
    })
    expect(collectCauseCodes(error)).toEqual(['ECONNRESET'])
  })

  it('无码时返回**空数组**而不是 undefined（调用方据此区分「有码不在表里」与「无码」）', () => {
    const codes = collectCauseCodes(new Error('HTTP 500'))
    expect(Array.isArray(codes)).toBe(true)
    expect(codes).toEqual([])
  })

  it('重复码去重', () => {
    const inner = fetchFailed('ENOTFOUND')
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new TypeError('mid', { cause: inner }), { code: 'ENOTFOUND' }),
    })
    expect(collectCauseCodes(error)).toEqual(['ENOTFOUND'])
  })

  it('病态自引用链不会死循环（遍历有上限）', () => {
    const loop: Error & { cause?: unknown } = new Error('loop')
    loop.cause = loop
    expect(() => collectCauseCodes(loop)).not.toThrow()
  })
})

describe('isNetworkBlocked（判「出不去」）', () => {
  it.each([
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
    'ENOTFOUND',
    'ECONNREFUSED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ECONNRESET',
  ])('%s ⇒ 是', (code) => {
    expect(isNetworkBlocked(fetchFailed(code), false)).toBe(true)
  })

  it('aborted=true 时**不看码**也算（自 arm 的超时没有 UND_ERR_* 码）', () => {
    // ⚠️ 这是 IKLTZ2 审计 P2-2 的实际教训：`AbortSignal.timeout()` 触发的
    //    墙外连接超时没有错误码，只靠码表判会漏掉主症状。
    expect(isNetworkBlocked(new Error('This operation was aborted'), true)).toBe(true)
  })

  it('普通业务错误不算（HTTP 500 / 401 都不是「出不去」）', () => {
    expect(isNetworkBlocked(new Error('HTTP 500'), false)).toBe(false)
    expect(isNetworkBlocked(new Error('unauthorized'), false)).toBe(false)
  })

  it('⚠️ 判据读码不读 message：message 含 ENOTFOUND 但无 code ⇒ 不算', () => {
    // 反例守卫：若实现改成读 message，这条会红。读 message 会把「服务端
    // 恰好回了这段文字」误判成网络故障。
    expect(isNetworkBlocked(new Error('ENOTFOUND in a log line'), false)).toBe(false)
  })
})

describe('networkBlockedHint（文案即出路）', () => {
  it('命中时：带主体名 + 根因码 + 出路', () => {
    const hint = networkBlockedHint({
      error: fetchFailed('UND_ERR_CONNECT_TIMEOUT'),
      aborted: false,
      subject: 'Qoder 国际版（https://openapi.qoder.sh）',
      remedy: '请在能访问该地址的网络下使用，或导出 HTTPS_PROXY。',
    })
    expect(hint).toBeDefined()
    expect(hint).toContain('连不上 Qoder 国际版（https://openapi.qoder.sh）')
    expect(hint).toContain('UND_ERR_CONNECT_TIMEOUT')
    expect(hint).toContain('HTTPS_PROXY')
  })

  it('无码但 aborted ⇒ 提示里不出现空的括号', () => {
    const hint = networkBlockedHint({
      error: new Error('aborted'),
      aborted: true,
      subject: 'Google',
      remedy: '请配代理。',
    })
    expect(hint).toBe('连不上 Google：请配代理。')
    expect(hint).not.toContain('（）')
  })

  it('不命中时返回 undefined（调用方用自己更精确的措辞，不许拿它兜底）', () => {
    expect(networkBlockedHint({
      error: new Error('HTTP 500'),
      aborted: false,
      subject: 'Google',
      remedy: '请配代理。',
    })).toBeUndefined()
  })
})

describe('NETWORK_BLOCKED_CODE_RE 与 refresh.ts 的判据刻意不同', () => {
  it('本表收 ECONNRESET', () => {
    expect(NETWORK_BLOCKED_CODE_RE.test('ECONNRESET')).toBe(true)
  })
})
