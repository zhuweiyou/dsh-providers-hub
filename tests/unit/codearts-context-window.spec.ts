/**
 * CodeArts 的**上下文占用条**分母（`context.contextWindow`）守卫（2026-10-21 真实报障）。
 *
 * ## 报障原文
 *
 * 「codearts 对话后，DSH 下方本该显示上下文窗口占用比的地方没有显示」，
 * 复现模型是 `glm-5.3`。
 *
 * ## 判据链（宿主侧，**不在本仓**）
 *
 * 1. `dsh-client-ui-conversation/lib/client.js` 的 `contextOccupancy()`：
 *
 *    ```js
 *    const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
 *    if (usedTokens === void 0 || pressure?.contextWindow === void 0) return null
 *    ```
 *
 *    而 `ContextMeter` 在 `context === null` 时 **`return null`** ⇒
 *    环 + 百分比 + 弹层**整条不渲染**（不是显示 0%，是**根本不出现**）。
 * 2. 分母来自 `dsh-agent-loop` 写的 `request/context` 事件，值即适配器
 *    `resolveModel()` 返回的 `context.contextWindow`；
 * 3. 分子（`pressureTokens`）由 token-meter 从 `assistant/message.usage` 算
 *    （`inputTokens + cacheReadTokens + cacheWriteTokens`）—— **本家这条腿一直是好的**
 *    （实测 glm-5.3 上报 `inputTokens:37482, cacheReadTokens:448`）。
 *
 * ⇒ **本家唯一能出错的就是分母**。故本文件的判据全部打在「分母恒有值」上。
 *
 * ## 为什么这个文件必须存在（合并前的实测）
 *
 * 修前全仓 `llm-adapter.spec.ts` 112 条 + `codearts-rate-display.spec.ts` 7 条
 * **全绿**，却漏掉了这个用户可见缺陷 —— 因为**没有任何一条断言「目录里每个
 * 可见条目都带窗口」**：旧用例只逐个点名了几个**表里有的**模型，缺窗口的
 * （`glm-5.3` / `openpangu-*` / `glm-5.2-sft-harmony`）**一条都没被问到**。
 *
 * ## 三条守卫各自的「有牙」判据
 *
 * | 守卫 | 若把生产代码改回缺陷态 | 为什么有牙 |
 * |---|---|---|
 * | ① 目录逐条都有正数窗口 | `contextWindow` 改回 `...cond ? {...} : {}` ⇒ 缺键 ⇒ 红 | **遍历目录**（不是点名），并断言 `Number.isInteger && > 0` |
 * | ② `resolveModel` 逐条都有窗口 | 同上（走的是同一份 `CatalogEntry`） | 对**目录里每一个 id** 调 `resolveModel` 比对 |
 * | ③ 未知 id 也有窗口 | 兜底删掉 ⇒ 手填模型无占用条 | 传一个**确定不在表里**的 id，断言等于兜底常量 |
 */
import { describe, expect, it } from 'vitest'
import {
  CODEARTS_FALLBACK_CONTEXT_WINDOW,
  CodeArtsAdapter,
  codeartsContextWindow,
} from '../../src/llm-adapter.js'
import type { CodeArtsCredential } from '../../src/types.js'

const validCredential: CodeArtsCredential = {
  access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
  expires_at: '2099-01-01T00:00:00Z',
}

/**
 * 造适配器。`remote` 为 `undefined` ⇒ 远端拉取失败 ⇒ 走**静态兜底表**
 * （`DEFAULT_MODELS`），这也是首次启动 / 未登录时的真实形态。
 */
function makeAdapter(remote?: Array<{ id: string; name: string }>) {
  return new CodeArtsAdapter({
    credentialRef: 'CODEARTS_ACCESS_TOKEN',
    resolveCredential: async () => validCredential,
    refresh: async () => {},
    fetchImpl: async () => new Response('not found', { status: 404 }),
    ...remote === undefined ? { fetchRemoteModels: async () => { throw new Error('offline') } } : { fetchRemoteModels: async () => remote },
  })
}

/** 断言一个窗口值是**可用的分母**（DSH 侧要求正整数，否则抛 INVALID_MODEL_CONTEXT）。 */
function expectUsableWindow(value: unknown, label: string): void {
  // ⚠️ 参数顺序是 (actual, expected)：把说明串放**第二个**，失败时才会打印出
  //    「是哪个模型、拿到了什么值」—— 写反了只会打印 `true`，定位不到模型。
  expect(Number.isInteger(value) && (value as number) > 0, `${label} 的 contextWindow 必须是正整数，实际=${String(value)}`).toBe(true)
}

describe('上下文占用条的分母（contextWindow）', () => {
  /**
   * 守卫 ①：**远端目录里每一条**经 `resolveModel` 都拿到可用窗口。
   *
   * ⚠️⚠️ **不能断言 `listModels` 的返回值带 `contextWindow`** ——
   * DSH 契约里 `LlmModelInfo`（`listModels` 的返回形状）**没有这个字段**，
   * 只有 `LlmResolvedModelInfo`（`resolveModel` 的返回形状）才有
   * `context?: { contextWindow }`（见 `dsh-llm/lib/types/types.d.ts:321/394`）。
   * 我第一版就是这么写的，实测恒红（`glm-5.3 的 contextWindow 实际=undefined`）——
   * **契约形状写错会让守卫变成假红**，与「假绿」一样有害。
   *
   * ⚠️ 这里刻意喂一份「静态表里查不到」的远端目录 —— 真实目录就是这种形态：
   * 上游 `/v1/model/builtin` 的条目键全集里**没有任何 context/window 字段**
   * （实测见 `CONTEXT_WINDOWS` 的注释），所以远端 id 全部依赖本地表/兜底。
   */
  it('① 远端目录里每一条经 resolveModel 都拿到正数窗口（含表里没有的新模型）', async () => {
    const remote = [
      { id: 'glm-5.3', name: 'GLM-5.3' },
      { id: 'GLM-5.2', name: 'GLM-5.2' },
      { id: 'openpangu-2.0-pro', name: 'OpenPangu-2.0-Pro' },
      { id: 'glm-5.2-sft-harmony', name: 'GLM-5.2-ArkTS-SPARK' },
      // ⚠️ 故意造一个**将来才会出现**的上游新模型：它必然不在静态表里，
      //    旧实现（省略 context）会让它没有占用条。
      { id: 'brand-new-model-2030', name: 'Brand New' },
    ]
    const adapter = makeAdapter(remote)
    const models = await adapter.listModels('codearts')
    expect(models.length).toBe(remote.length)
    for (const model of models) {
      const resolved = await adapter.resolveModel('codearts', model.id)
      expectUsableWindow(resolved.context?.contextWindow, model.id)
    }
  })

  /**
   * 守卫 ①b：**静态兜底目录**（远端失败）里每一条经 `resolveModel` 都有可用窗口。
   *
   * ⚠️ 这条覆盖的是「首次启动 / 未登录 / 远端全挂」的真实形态 ——
   * 用户在那时发第一句话，占用条也必须出现。
   */
  it('①b 静态兜底目录（远端失败）里每一条都带正数 contextWindow', async () => {
    const adapter = makeAdapter()
    const models = await adapter.listModels('codearts')
    expect(models.length).toBeGreaterThan(0)
    for (const model of models) {
      const resolved = await adapter.resolveModel('codearts', model.id)
      expectUsableWindow(resolved.context?.contextWindow, model.id)
    }
  })

  /**
   * 守卫 ②：`resolveModel` 给出的窗口与「该 id 应有值」**逐条一致**。
   *
   * ⚠️ 这是真正喂给 `request/context` 的那条路（`agent-loop` 读的是
   * `resolveModel().context.contextWindow`，不是 `listModels`）。
   * 本用例把**权威值表**与适配器输出直接比对，任一侧漂移都会红。
   */
  it('② resolveModel 的窗口与权威值逐条一致', async () => {
    const adapter = makeAdapter([
      { id: 'glm-5.3', name: 'GLM-5.3' },
      { id: 'GLM-5.2', name: 'GLM-5.2' },
      { id: 'openpangu-2.0-flash', name: 'OpenPangu-2.0-Flash' },
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },
    ])
    for (const [id, window] of [
      ['glm-5.3', 1_048_576],
      ['GLM-5.2', 1_048_576],
      ['openpangu-2.0-flash', 524_288],
      ['deepseek-v4.1-flash', 1_048_576],
    ] as const) {
      const resolved = await adapter.resolveModel('codearts', id)
      expect({ id, window: resolved.context?.contextWindow }).toEqual({ id, window })
    }
  })

  /**
   * 守卫 ③：**手填的未知 id** 也有窗口。
   *
   * ⚠️ 用户可以在设置页手填任意模型 id（`model-catalog.ts` 的
   * `unknownModelInputModalities` / `unknownModelReasoning` 就是为这条路存在的）。
   * 若未知 id 省略 context，手填模型就**永远**没有占用条。
   */
  it('③ 手填的未知 id 也拿到兜底窗口（否则手填模型永远没有占用条）', async () => {
    const adapter = makeAdapter([{ id: 'GLM-5.2', name: 'GLM-5.2' }])
    const resolved = await adapter.resolveModel('codearts', '手填-不存在的模型-id')
    expect(resolved.context).toEqual({ contextWindow: CODEARTS_FALLBACK_CONTEXT_WINDOW })
  })

  /**
   * 守卫 ③c：**「静态窗口表里有、但静态兜底目录里没有」的 id，离线路径也必须
   * 拿到表内值，不能拿兜底值。**
   *
   * ⚠️⚠️ 这条是**全量测试抓出来的真缺陷**（2026-10-21），不是预防性用例：
   * 第一版把 `unknownModelContextWindow` 写成无参、直接返回常数兜底 ⇒
   * `glm-5.3` 在 `CONTEXT_WINDOWS` 里是 1M，但它**不在** `DEFAULT_MODELS`
   * （静态兜底目录）里 ⇒ 远端失败（首次启动 / 未登录）时它走「目录外」分支
   * ⇒ 拿到 524_288 ⇒ **占用比分母错 2 倍**，而它**正是用户报障的模型**。
   *
   * ⇒ 判据是「离线路径的取值 == 表内值」，且**必须与兜底常量不同**才算有判别力
   * （若两者恰好相等，这条用例会恒真）。
   */
  it('③c 表里有、静态目录里没有的 id（glm-5.3），离线路径也拿表内值', async () => {
    // 先自证这条用例有判别力：表内值必须与兜底值**不同**。
    expect(codeartsContextWindow('glm-5.3')).not.toBe(CODEARTS_FALLBACK_CONTEXT_WINDOW)
    // 离线：远端拉取失败 ⇒ 目录回落到静态兜底表（里面**没有** glm-5.3）。
    const adapter = makeAdapter()
    const listed = await adapter.listModels('codearts')
    expect(listed.map((m) => m.id)).not.toContain('glm-5.3')
    // 但用户仍可能（通过远端目录 / 手填 / 会话历史）请求它。
    const resolved = await adapter.resolveModel('codearts', 'glm-5.3')
    expect(resolved.context).toEqual({ contextWindow: 1_048_576 })
  })

  /**
   * 守卫 ③b：**兜底常量本身**必须是可用的分母，且不等于「表里最小的真实窗口」
   * 之外的任意值 —— 取值口径是「当前目录最小真实窗口」（用户 2026-10-21 选定）。
   *
   * ⚠️ 断言**具体数值**：改大改小都是行为变更（偏大 ⇒ 未知模型可能上游溢出报错），
   * 必须有人主动改这条断言，不能静默漂移。
   */
  it('③b 兜底常量是 524_288（当前目录最小真实窗口，用户选定）', () => {
    expect(CODEARTS_FALLBACK_CONTEXT_WINDOW).toBe(524_288)
    expectUsableWindow(CODEARTS_FALLBACK_CONTEXT_WINDOW, 'CODEARTS_FALLBACK_CONTEXT_WINDOW')
  })

  /**
   * 守卫 ④：**逐模型的权威值**（IDE 下发的 `inferhub-provider.models[*].limit.context`）。
   *
   * ⚠️ 这条钉的是**数值本身**，防两件事：
   * ① `GLM-5.2` 被改回过期的 `202_752`（10-20 及以前的 IDE 配置；上游 10-21 已改 1M）
   *    —— 留着它会让分母小 5 倍，占用比封顶 100%、自动压缩阈值降到 ~162K；
   * ② 有人把兜底值「顺手」也填进表里冒充实测值。
   *
   * 取证方式与日期见 `CONTEXT_WINDOWS` 的注释（本机 42 份内核日志，2026-09-11~10-21）。
   */
  it('④ 逐模型窗口等于 IDE 下发的权威值（GLM-5.2 不得退回 202_752）', () => {
    expect({
      'GLM-5.2': codeartsContextWindow('GLM-5.2'),
      'glm-5.3': codeartsContextWindow('glm-5.3'),
      'glm-5.3-flash': codeartsContextWindow('glm-5.3-flash'),
      'glm-5.2-sft-harmony': codeartsContextWindow('glm-5.2-sft-harmony'),
      'openpangu-2.0-flash': codeartsContextWindow('openpangu-2.0-flash'),
      'openpangu-2.0-pro': codeartsContextWindow('openpangu-2.0-pro'),
      'deepseek-v4.1-flash': codeartsContextWindow('deepseek-v4.1-flash'),
    }).toEqual({
      'GLM-5.2': 1_048_576,
      'glm-5.3': 1_048_576,
      'glm-5.3-flash': 1_048_576,
      'glm-5.2-sft-harmony': 202_752,
      'openpangu-2.0-flash': 524_288,
      'openpangu-2.0-pro': 524_288,
      'deepseek-v4.1-flash': 1_048_576,
    })
  })

  /**
   * 守卫 ⑤：兜底**不得**污染表内值（表内命中时绝不返回兜底）。
   *
   * ⚠️ 变异「`codeartsContextWindow` 恒返回兜底」会让 ①②③ 全绿而这条红。
   */
  it('⑤ 表内命中时返回表内值，不是兜底', () => {
    expect(codeartsContextWindow('GLM-5.2')).not.toBe(CODEARTS_FALLBACK_CONTEXT_WINDOW)
    expect(codeartsContextWindow('deepseek-v4.1-flash')).not.toBe(CODEARTS_FALLBACK_CONTEXT_WINDOW)
  })
})
