/**
 * `CodelyAuth`（续期服务）的契约与行为守卫。
 *
 * ## 为什么必须有这份文件（2026-10-22 对抗审计 A5，P1）
 *
 * 审计当时 `CodelyAuth` 是**全仓零实例化**的死代码（`grep "new CodelyAuth"` 零命中），
 * 而 `provider-registry.ts` / `jet-hub-rpc.ts` 的接线清单却逐字写着
 * 「续期实现**已就绪**，推理与目录都不依赖它」。实测它有**两处**必然失败：
 *
 * 1. **编译期 TS2322**：`refreshAll(pool, refreshOne)` 是 2 参，而契约
 *    `JetHubAuthLike.refreshAll(pool)` 是 1 参 ⇒ 下一个人照文档接线时
 *    第一步就是编译红；
 * 2. **运行期 TypeError**：`index.ts` 的注册循环**提供不了** `refreshOne`
 *    ⇒ 按 `refreshAll: (pool) => auth.refreshAll(pool)` 包装调用必抛
 *    `refreshOne is not a function`，而它被外层逐 provider 的 `try` 吞成
 *    一条 warn ⇒ **续期恒不发生且日志几乎零字**（officeace 那条
 *    「把同步池当 Promise」完全同型）。
 *
 * ## 两条判据的性质不同，都要有
 *
 * - **契约判据**（`satisfies JetHubAuthLike`）：编译期就挡住签名漂移；
 * - **行为判据**（真跑 `refreshAll`）：挡住「签名对了但内部逻辑不做事」——
 *   本仓库记过多次「只断言不抛错 ⇒ 读了池但不续期仍全绿」。
 */

import { describe, expect, it, vi } from 'vitest'

import { Context } from '@deepseek-ai/cordis'

import { CodelyAuth, refreshCodelyCredential } from '../../src/codely-auth-service.js'
import type { JetHubAuthLike } from '../../src/jet-hub-rpc.js'
import type { CodelyCredential } from '../../src/codely-auth.js'

/**
 * ★ **契约判据**：`CodelyAuth` 必须能当 `JetHubAuthLike` 用。
 *
 * ⚠️ 这一句是**编译期**判据 —— 修复前它会直接 TS2322（`Expected 2 or more
 * arguments, but got 1`）。`tsc -p tsconfig.tests.json` 会跑到这里
 * （`pretest` 就是它）。
 *
 * ⚠️ 别把它改成 `as unknown as` 之类的断言：那就把判据变成恒真了，
 * 而本文件存在的**唯一理由**就是挡这条签名漂移。
 */
const contractCheck: JetHubAuthLike = new CodelyAuth(new Context(), {})

/** 假凭据库：记录写回，供行为判据断言。 */
function makeCredentialStore(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial))
  const writes: Array<{ ref: string; value: string }> = []
  return {
    store: {
      resolve: async (ref: string) => {
        const value = values.get(ref)
        return value === undefined ? undefined : { value }
      },
      set: async (ref: string, value: string) => {
        values.set(ref, value)
        writes.push({ ref, value })
      },
    },
    writes,
    values,
  }
}

/** 造一份 Codely 凭据（JWT 的 exp 用 base64url 编出来，`expiryMsOf` 才解得出）。 */
function makeCredential(token = 'OLD-ACCESS', refreshToken = 'REFRESH-1'): CodelyCredential {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url')
  return {
    access_token: `${token}.${payload}.sig`,
    refresh_token: refreshToken,
    obtained_at: Date.now() - 1000,
  } as never
}

describe('CodelyAuth 契约', () => {
  it('★★ 能满足 JetHubAuthLike（修复前 refreshAll 是 2 参 ⇒ TS2322）', () => {
    // ⚠️ 这里刻意只做「存在性 + 形状」断言：真正的判别力在上面的
    //    `const contractCheck: JetHubAuthLike = new CodelyAuth(new Context(), {})`（编译期）。
    expect(typeof contractCheck.refreshAccountCredential).toBe('function')
    expect(typeof contractCheck.refreshAll).toBe('function')
    // ⚠️ `refreshAll.length` 必须是 **1**（`(pool)`）—— 写成 2 就是旧契约。
    expect(
      contractCheck.refreshAll.length,
      'refreshAll 必须只接受 1 个参数（pool）；2 参会让 JetHubAuthLike 接线编译失败',
    ).toBe(1)
  })
})

describe('CodelyAuth 续期行为', () => {
  it('★★ refreshAll(pool) 必须真的遍历池并逐号续期（不是只读池不做事）', async () => {
    const cred1 = makeCredential('A1')
    const cred2 = makeCredential('A2')
    const { store, writes } = makeCredentialStore({
      REF_A: JSON.stringify(cred1),
      REF_B: JSON.stringify(cred2),
    })
    // ⚠️ 必须返回**合法 JWT**：`expiryMsOf` 解不出 `exp` 就会给
    //    `writebackExpiry(accountId, undefined)` ⇒ 界面「有效期」停在旧值。
    //    用裸串（如 'NEW-ACCESS'）会让这条判据变成**恒假**。
    const futureJwt = (): string => {
      const exp = Math.floor(Date.now() / 1000) + 7200
      const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url')
      return `NEW.${payload}.sig`
    }
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ access_token: futureJwt(), refresh_token: 'REFRESH-1' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    const expiryWrites: Array<{ accountId: string; ms: number | undefined }> = []
    const auth = new CodelyAuth(new Context(), {
      credentials: store,
      fetcher: fetchImpl as never,
      writebackExpiry: async (accountId, ms) => { expiryWrites.push({ accountId, ms }) },
    })

    // 与真实 `AccountPool.listAccountsByProvider` 同形（同步返回数组）。
    const pool = {
      listAccountsByProvider: (provider: string) => (provider === 'codely'
        ? [
            { id: 'acc-a', credentialRef: 'REF_A' },
            { id: 'acc-b', credentialRef: 'REF_B' },
          ]
        : []),
    }

    await auth.refreshAll(pool)

    // ① 决定性断言：两个号都**真发了续期请求**（只读池不做事会得到 0 次）
    expect(fetchImpl, 'refreshAll 必须为每个账号真发一次续期请求').toHaveBeenCalledTimes(2)
    // ② 两个号的凭据都被写回
    expect(writes.map((w) => w.ref).sort()).toEqual(['REF_A', 'REF_B'])
    // ③ 池里的有效期被回写（否则界面「有效期」停在旧值 —— officeace 同款缺陷）
    expect(expiryWrites.map((w) => w.accountId).sort()).toEqual(['acc-a', 'acc-b'])
    expect(expiryWrites.every((w) => typeof w.ms === 'number' && w.ms > Date.now())).toBe(true)
  })

  it('★ 空池 / 读池抛错 ⇒ 静默返回（一个渠道的池抖动不该让整轮续期炸掉）', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const auth = new CodelyAuth(new Context(), { credentials: makeCredentialStore({}).store, fetcher: fetchImpl as never })

    // 空池
    await expect(auth.refreshAll({ listAccountsByProvider: () => [] })).resolves.toBeUndefined()
    // 读池抛错（同步抛）
    await expect(auth.refreshAll({
      listAccountsByProvider: () => { throw new Error('pool read failed') },
    })).resolves.toBeUndefined()
    // 池形状完全不对（undefined / 缺方法）
    await expect(auth.refreshAll(undefined)).resolves.toBeUndefined()
    await expect(auth.refreshAll({})).resolves.toBeUndefined()

    expect(fetchImpl, '池有问题时不得白发续期请求').not.toHaveBeenCalled()
  })

  it('★ 单个账号续期失败不影响其余账号', async () => {
    const { store, writes } = makeCredentialStore({
      REF_BAD: JSON.stringify(makeCredential('BAD', 'REFRESH-BAD')),
      REF_OK: JSON.stringify(makeCredential('OK', 'REFRESH-OK')),
    })
    let call = 0
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      call += 1
      const body = JSON.parse(String(init?.body ?? '{}')) as { refresh_token?: string }
      // 第一个号（BAD）失败，第二个成功
      if (body.refresh_token === 'REFRESH-BAD') return new Response('nope', { status: 401 })
      return new Response(JSON.stringify({ access_token: 'NEW', refresh_token: 'REFRESH-OK' }), { status: 200 })
    })
    const auth = new CodelyAuth(new Context(), { credentials: store, fetcher: fetchImpl as never })
    await auth.refreshAll({
      listAccountsByProvider: () => [
        { id: 'acc-bad', credentialRef: 'REF_BAD' },
        { id: 'acc-ok', credentialRef: 'REF_OK' },
      ],
    })
    expect(call, '两个号都要被尝试').toBe(2)
    expect(writes.map((w) => w.ref), '只有成功的那个号被写回').toEqual(['REF_OK'])
  })
})

describe('refreshCodelyCredential', () => {
  it('★ refresh_token 不轮换：响应缺该字段时沿用旧值（实测上游不轮换）', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ access_token: 'NEW-ACCESS' }),
      { status: 200 },
    ))
    const next = await refreshCodelyCredential('OLD-REFRESH', { fetcher: fetchImpl as never })
    expect(next?.accessToken).toBe('NEW-ACCESS')
    expect(next?.refreshToken, '响应缺 refresh_token 时必须沿用旧值，不得变成空串').toBe('OLD-REFRESH')
  })

  it('★ 空 refresh_token ⇒ 直接返回 undefined（不发请求）', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const next = await refreshCodelyCredential('', { fetcher: fetchImpl as never })
    expect(next).toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('★ 失败（401 / 非 JSON / 网络异常）一律 undefined，不抛错', async () => {
    const unauthorized = await refreshCodelyCredential('R', {
      fetcher: (async () => new Response('nope', { status: 401 })) as never,
    })
    expect(unauthorized).toBeUndefined()
    const notJson = await refreshCodelyCredential('R', {
      fetcher: (async () => new Response('not json', { status: 200 })) as never,
    })
    expect(notJson).toBeUndefined()
    const network = await refreshCodelyCredential('R', {
      fetcher: (async () => { throw new Error('ECONNRESET') }) as never,
    })
    expect(network).toBeUndefined()
  })

  it('★ 续期请求必须带超时（与 A3 同一纪律：不能永久挂住）', async () => {
    let seenSignal: unknown
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenSignal = init?.signal
      return new Response(JSON.stringify({ access_token: 'X' }), { status: 200 })
    })
    await refreshCodelyCredential('R', { fetcher: fetchImpl as never })
    expect(seenSignal, '续期请求必须带 signal（上游挂住即续期链永久卡住）').toBeDefined()
  })
})
