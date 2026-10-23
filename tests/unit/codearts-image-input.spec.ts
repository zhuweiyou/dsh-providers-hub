/**
 * CodeArts 的**图片输入**守卫（2026-10-21 接通，用户报障驱动）。
 *
 * ## 报障原文
 *
 * 「我们现在使用 codearts 发送图片后端模型不支持图片，发送带图的信息会直接跳出
 * 提示阻止发送信息，但是 codearts（IDE）发送识图任务是支持识图的」
 *
 * ## 真实机制（本机 IDE 内核日志 + 只读探测，2026-10-21）
 *
 * CodeArts 的模型分两类（`/v1/model/builtin` 的 `supports_images` 逐条实测）：
 *
 * | 模型 | `supports_images` | `model_category` |
 * |---|---|---|
 * | `kimi-k2.6-vl` / `Qwen3-VL-235B` | **true** | **图片理解** |
 * | `glm-5.3` / `GLM-5.2` / `openpangu-*` / `deepseek-v4.1-flash` / `glm-5.2-sft-harmony` | false | 文本生成 |
 *
 * ⇒ 文本模型**真的不能收图**（上游原文 `InferHub.001001020.406 The request model
 * is not multimodal`，本文件的反向对照用例复现它）。IDE 的做法是**两段式**：
 * 用 `fetchMultimodalModelId` 挑一个 VL 模型，由 `analyzeImage` 工具先看图、
 * 把结果变成文字，再交给主模型。
 *
 * ## 本仓的接法（与 IDE 同构的第一段）
 *
 * 1. VL 模型**仍不进对话目录**（上下文小、不支持工具调用），但 `resolveModel`
 *    对它们声明 `['text','image']` ⇒ 主模型可以按 id 借它们识图；
 * 2. 图片 wire 形态**实测只有一种被接受**（四选一，见 `codeartsImagePart` 注释）；
 * 3. 非 VL 模型**根本不读图片字节**（`codeartsAcceptsImage` 闸门）。
 *
 * ## 四条守卫各自的「有牙」判据
 *
 * | 守卫 | 若把生产代码改坏 | 为什么有牙 |
 * |---|---|---|
 * | ① VL 模型声明 image | 改回恒 `['text']` ⇒ DSH 在入库阶段拒图 | 断言 `includes('image')` |
 * | ② 文本模型**不**声明 image | 给所有模型都加 image ⇒ 用户能选 glm-5.3 发图、上游 406 | 断言 `not.toContain('image')` |
 * | ③ VL 模型仍在目录外 | 把它们放进 `listModels` ⇒ 用户可选中当主模型（回归） | 断言目录 id 集合**不含**它们 |
 * | ④ `prepareCall` 不覆盖模态 | 加回 `inputModalities: ['text']` 硬覆盖 ⇒ ① 被静默抹平 | 断言 `prepareCall().model` 与 `resolveModel()` **一致** |
 */
import { describe, expect, it } from 'vitest'
import {
  CODEARTS_FALLBACK_CONTEXT_WINDOW,
  CodeArtsAdapter,
  codeartsAcceptsImage,
  codeartsImagePart,
  codeartsVisionModel,
} from '../../src/llm-adapter.js'
import type { CodeArtsCredential } from '../../src/types.js'

const validCredential: CodeArtsCredential = {
  access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
  expires_at: '2099-01-01T00:00:00Z',
}

/** 造适配器；`readImage` 可选（用来观察「非 VL 模型到底读不读字节」）。 */
function makeAdapter(options: {
  remote?: Array<{ id: string; name: string }>
  readImage?: (ref: unknown) => Promise<{ data: Uint8Array; mediaType: string }>
} = {}) {
  return new CodeArtsAdapter({
    credentialRef: 'CODEARTS_ACCESS_TOKEN',
    resolveCredential: async () => validCredential,
    refresh: async () => {},
    fetchImpl: async () => new Response('not found', { status: 404 }),
    ...options.remote === undefined
      ? { fetchRemoteModels: async () => { throw new Error('offline') } }
      : { fetchRemoteModels: async () => options.remote },
    ...options.readImage === undefined ? {} : { readImage: options.readImage },
  })
}

describe('CodeArts 图片输入：模态声明', () => {
  /**
   * 守卫 ①：**VL 模型必须声明 `image`**。
   *
   * ⚠️ 这是「能不能发图」的总闸门 —— DSH 的图片准入读的就是它
   *（官方 `read_image` 的 `assertImageCapableRoute` 同源判据）。
   * 改回恒 `['text']` 会让用户在入库阶段就被拒，请求根本不发出。
   */
  it('① VL 模型（kimi-k2.6-vl / Qwen3-VL-235B）声明 image 模态', async () => {
    const adapter = makeAdapter({
      remote: [
        { id: 'kimi-k2.6-vl', name: 'Kimi-K2.6-VL' },
        { id: 'Qwen3-VL-235B', name: 'Qwen3-VL-235B' },
      ],
    })
    for (const id of ['kimi-k2.6-vl', 'Qwen3-VL-235B']) {
      const resolved = await adapter.resolveModel('codearts', id)
      expect({ id, modalities: resolved.inputModalities }).toEqual({ id, modalities: ['text', 'image'] })
    }
  })

  /**
   * 守卫 ②：**文本模型不得声明 `image`**（反向对照）。
   *
   * ⚠️ 这一条与 ① 同等重要：若「所有模型都给 image」，用户就能选 `glm-5.3` 发图，
   * 而实测上游会回 `InferHub.001001020.406 The request model is not multimodal`
   * ⇒ **每一轮带图对话都失败**，且错误信息看不出是「这个模型不收图」。
   */
  it('② 文本模型不声明 image（上游实测会 406 拒绝）', async () => {
    const adapter = makeAdapter({
      remote: [
        { id: 'glm-5.3', name: 'GLM-5.3' },
        { id: 'GLM-5.2', name: 'GLM-5.2' },
        { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },
      ],
    })
    for (const id of ['glm-5.3', 'GLM-5.2', 'deepseek-v4.1-flash']) {
      const resolved = await adapter.resolveModel('codearts', id)
      expect({ id, modalities: resolved.inputModalities }).toEqual({ id, modalities: ['text'] })
    }
  })

  /**
   * 守卫 ③：**VL 模型仍不进对话目录**（回归守卫）。
   *
   * ⚠️ 它们上下文小、不支持工具调用，当 agent 主模型会踩别的坑 —— 这是本家
   * 一直以来的刻意过滤（`-VL-` / `-vl` 判据）。接图片时**很容易顺手把它们
   * 放进目录**（那样"发图"确实也能用），但那是**另一个行为变更**，不在本次范围。
   */
  it('③ VL 模型仍被排除在对话目录外（但可按 id 解析）', async () => {
    const adapter = makeAdapter({
      remote: [
        { id: 'glm-5.3', name: 'GLM-5.3' },
        { id: 'kimi-k2.6-vl', name: 'Kimi-K2.6-VL' },
        { id: 'Qwen3-VL-235B', name: 'Qwen3-VL-235B' },
      ],
    })
    const ids = (await adapter.listModels('codearts')).map((m) => m.id)
    expect(ids).toContain('glm-5.3')
    expect(ids).not.toContain('kimi-k2.6-vl')
    expect(ids).not.toContain('Qwen3-VL-235B')
    // 但 `resolveModel` 仍认它们（识图工具要按 id 借它们）。
    expect((await adapter.resolveModel('codearts', 'kimi-k2.6-vl')).context)
      .toEqual({ contextWindow: CODEARTS_FALLBACK_CONTEXT_WINDOW })
  })

  /**
   * 守卫 ④：`prepareCall` **不得覆盖** `resolveModel` 算出的模态。
   *
   * ⚠️⚠️ 这条是接图片时发现的**真缺陷**：原代码是
   * `{ ...await this.resolveModel(...), inputModalities: ['text'] }` ——
   * 硬覆盖。只要目录开始按模型区分模态，这一行就会**静默抹平**，
   * 症状是「VL 模型明明声明了 image，发图仍被 DSH 拒掉」，且两处代码各自看都对。
   */
  it('④ prepareCall 的模态与 resolveModel 一致（不得硬覆盖成 text）', async () => {
    const adapter = makeAdapter({
      remote: [
        { id: 'kimi-k2.6-vl', name: 'Kimi-K2.6-VL' },
        { id: 'glm-5.3', name: 'GLM-5.3' },
      ],
    })
    for (const id of ['kimi-k2.6-vl', 'glm-5.3']) {
      const direct = await adapter.resolveModel('codearts', id)
      const prepared = await adapter.prepareCall('codearts', id)
      expect({ id, modalities: prepared.model.inputModalities })
        .toEqual({ id, modalities: direct.inputModalities })
    }
  })
})

describe('CodeArts 图片输入：能力判定与 wire 形态', () => {
  /**
   * 守卫 ⑤：`codeartsAcceptsImage` **大小写不敏感**。
   *
   * ⚠️ 上游目录里两种写法都出现过（`kimi-k2.6-vl` 全小写、`Qwen3-VL-235B` 混合
   * 大小写），而用户手填的 id 大小写不可控 ⇒ 判据必须归一化，否则
   * 「手填 `Kimi-K2.6-VL`」会被判成不支持图片。
   */
  it('⑤ 能力判定大小写不敏感，且不误判文本模型', () => {
    expect(codeartsAcceptsImage('kimi-k2.6-vl')).toBe(true)
    expect(codeartsAcceptsImage('Kimi-K2.6-VL')).toBe(true)
    expect(codeartsAcceptsImage('Qwen3-VL-235B')).toBe(true)
    expect(codeartsAcceptsImage('qwen3-vl-235b')).toBe(true)
    expect(codeartsAcceptsImage(' kimi-k2.6-vl ')).toBe(true)
    // 反向：文本模型与「长得像但不是」的 id 都不能放行。
    expect(codeartsAcceptsImage('glm-5.3')).toBe(false)
    expect(codeartsAcceptsImage('GLM-5.2')).toBe(false)
    expect(codeartsAcceptsImage('deepseek-v4.1-flash')).toBe(false)
    expect(codeartsAcceptsImage('kimi-k2.6')).toBe(false)
  })

  /**
   * 守卫 ⑥：wire 形态**必须是 OpenAI 的「对象套 url」**。
   *
   * ⚠️ 这是实测四选一的结果（见 `codeartsImagePart` 注释）：
   * 字符串形态 / `{type:'image'}` / `{type:'input_image'}` 全部被拒。
   * 本用例把「必须的形状」逐字钉住 —— 若有人「顺手简化」成字符串形态，
   * 上游会回 406 且错误信息（`multimodal content ... incorrect`）**指不出**
   * 是哪个字段错了。
   */
  it('⑥ codeartsImagePart 产出 image_url 对象形态（唯一被接受的形状）', () => {
    const url = 'data:image/png;base64,AAAA'
    const part = codeartsImagePart(url)
    expect(part).toEqual({ type: 'image_url', image_url: { url } })
    // 反向对照：字符串形态**不是**本函数的产物（它是被拒的那种）。
    expect(typeof (part as { image_url: unknown }).image_url).toBe('object')
  })

  /** 守卫 ⑦：识图用的 VL 模型是 IDE 自己选的那个（不是我们猜的）。 */
  it('⑦ 识图模型是 kimi-k2.6-vl（IDE fetchMultimodalModelId 的实测选择）', () => {
    expect(codeartsVisionModel()).toBe('kimi-k2.6-vl')
    expect(codeartsAcceptsImage(codeartsVisionModel())).toBe(true)
  })
})
