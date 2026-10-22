/**
 * `src/buddy-wire.ts` 的逐 pass 单测（对齐参考实现 workbuddy2api-panel）。
 *
 * 每个 pass 一条用例组，断言**行为**（输入 → 输出）而不是源码文本 ——
 * 本仓库登记过「源码正则断言有假红假绿」的教训（`if (false)` 短路照样全绿）。
 *
 * ⚠️ 涉及上游错误码的用例**必须**用拼接构造字面量：本仓库的文字通道会把该码
 * 规范化成「插入连字符」的可读形态，直写会让「原码」与「改写值」变成同一个值
 * ⇒ 用例变成恒真（假绿）。判据用**长度 5 / 6** + 「真的变了」两道锁。
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  backfillReasoningContent,
  buildChatHeaders,
  buildConversationHeaders,
  cleanupOrphanToolCalls,
  clampGptMinMaxTokens,
  dropReasoningParts,
  derivedStableId,
  ensureStreamOptions,
  isB3TraceId,
  mergeAdjacentToolCalls,
  normalizeDeveloperRole,
  normalizeImageUrlParts,
  normalizeToolChoice,
  prepareBuddyBody,
  repackToolResultBlocks,
  resolveToolPairingPerCall,
  rewriteBareProbeEverywhere,
  translateMaxCompletionTokens,
  unescapeSchemaPatterns,
  type WireMessage,
} from '../../src/buddy-wire.js'
import {
  BARE_ERROR_CODE,
  BARE_ERROR_CODE_NEUTRALIZED,
  redactAnthropicHeaderFingerprints,
  rewriteBareErrorCodeProbe,
} from '../../src/openai-gateway/tencent-fingerprint.js'
import { CODEBUDDY, WORKBUDDY, resolveChatBase } from '../../src/product.js'

/** 与生产同源的 hash：sha256 hex 前 36 位。 */
function hash36(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 36)
}

const msg = (value: Record<string, unknown>): WireMessage => value

describe('translateMaxCompletionTokens', () => {
  it('别名正数翻译成 max_tokens，且别名一律删除', () => {
    const body: Record<string, unknown> = { max_completion_tokens: 1234 }
    translateMaxCompletionTokens(body)
    expect(body['max_tokens']).toBe(1234)
    expect('max_completion_tokens' in body).toBe(false)
  })

  it('显式 max_tokens 优先：别名只删不译', () => {
    const body: Record<string, unknown> = { max_tokens: 99, max_completion_tokens: 1234 }
    translateMaxCompletionTokens(body)
    expect(body['max_tokens']).toBe(99)
    expect('max_completion_tokens' in body).toBe(false)
  })

  it('0 / null / 负数 / 非整数 / 非数值都不翻译（只删别名）', () => {
    for (const raw of [0, null, -5, 1.5, '1024']) {
      const body: Record<string, unknown> = { max_completion_tokens: raw }
      translateMaxCompletionTokens(body)
      expect('max_tokens' in body).toBe(false)
      expect('max_completion_tokens' in body).toBe(false)
    }
  })
})

describe('clampGptMinMaxTokens', () => {
  it('GPT 系低于 16 抬到 16（对端实案：15 拒 / 16 过）', () => {
    const body: Record<string, unknown> = { max_tokens: 15 }
    clampGptMinMaxTokens(body, 'gpt-6-sol')
    expect(body['max_tokens']).toBe(16)
  })

  it('已 ≥ 16 不动；非 GPT 系不动', () => {
    const gpt: Record<string, unknown> = { max_tokens: 64 }
    clampGptMinMaxTokens(gpt, 'gpt-5.6-sol')
    expect(gpt['max_tokens']).toBe(64)
    const deepseek: Record<string, unknown> = { max_tokens: 8 }
    clampGptMinMaxTokens(deepseek, 'deepseek-v4.1-flash')
    expect(deepseek['max_tokens']).toBe(8)
  })
})

describe('ensureStreamOptions', () => {
  it('缺则补 include_usage', () => {
    const body: Record<string, unknown> = {}
    ensureStreamOptions(body)
    expect(body['stream_options']).toEqual({ include_usage: true })
  })

  it('显式带则一字不改（不覆盖用户取值）', () => {
    const body: Record<string, unknown> = { stream_options: { include_usage: false } }
    ensureStreamOptions(body)
    expect(body['stream_options']).toEqual({ include_usage: false })
  })
})

describe('normalizeToolChoice', () => {
  it("字符串 none：删 tool_choice 并连带删 tools / functions", () => {
    const body: Record<string, unknown> = { tool_choice: 'none', tools: [{ type: 'function' }], functions: [] }
    normalizeToolChoice(body)
    expect('tool_choice' in body).toBe(false)
    expect('tools' in body).toBe(false)
    expect('functions' in body).toBe(false)
  })

  it('对象 auto / required：归一成字符串', () => {
    for (const type of ['auto', 'required']) {
      const body: Record<string, unknown> = { tool_choice: { type } }
      normalizeToolChoice(body)
      expect(body['tool_choice']).toBe(type)
    }
  })

  it('对象 function：取名字（上游只认字符串）', () => {
    const body: Record<string, unknown> = { tool_choice: { type: 'function', function: { name: 'get_weather' } } }
    normalizeToolChoice(body)
    expect(body['tool_choice']).toBe('get_weather')
  })

  it('function 缺名字 → 回落 auto（不发明名字）', () => {
    const body: Record<string, unknown> = { tool_choice: { type: 'function', function: {} } }
    normalizeToolChoice(body)
    expect(body['tool_choice']).toBe('auto')
  })

  it('非法形态（数字 / 未知 type）删字段而不是透传', () => {
    const numeric: Record<string, unknown> = { tool_choice: 1 }
    normalizeToolChoice(numeric)
    expect('tool_choice' in numeric).toBe(false)
    const unknown: Record<string, unknown> = { tool_choice: { type: 'weird' } }
    normalizeToolChoice(unknown)
    expect('tool_choice' in unknown).toBe(false)
  })
})

describe('unescapeSchemaPatterns', () => {
  it('pattern 里的 \\_ 归一成 _（上游 11129 归因）', () => {
    const body: Record<string, unknown> = {
      tools: [{ type: 'function', function: { parameters: { type: 'object', properties: { runId: { type: 'string', pattern: '^agent\\_run\\_$' } } } } }],
    }
    unescapeSchemaPatterns(body)
    const params = ((body['tools'] as Record<string, unknown>[])[0] as Record<string, unknown>)['function'] as Record<string, unknown>
    const props = (params['parameters'] as Record<string, unknown>)['properties'] as Record<string, unknown>
    expect((props['runId'] as Record<string, unknown>)['pattern']).toBe('^agent_run_$')
  })

  it('patternProperties 的键也归一（键不可原地改，必须重建该层）', () => {
    const body: Record<string, unknown> = {
      tools: [{ function: { parameters: { patternProperties: { '^a\\_b$': { pattern: 'x\\_y' } } } } }],
    }
    unescapeSchemaPatterns(body)
    const params = ((body['tools'] as Record<string, unknown>[])[0] as Record<string, unknown>)['function'] as Record<string, unknown>
    const patternProps = (params['parameters'] as Record<string, unknown>)['patternProperties'] as Record<string, unknown>
    expect(Object.keys(patternProps)).toEqual(['^a_b$'])
    expect((patternProps['^a_b$'] as Record<string, unknown>)['pattern']).toBe('x_y')
  })

  it('消息正文里的 \\_ 不碰（只动 tools 子树）', () => {
    const body: Record<string, unknown> = {
      messages: [{ role: 'user', content: 'C:\\_x' }],
      tools: [],
    }
    unescapeSchemaPatterns(body)
    expect((body['messages'] as Record<string, unknown>[])[0]!['content']).toBe('C:\\_x')
  })
})

describe('normalizeDeveloperRole / normalizeImageUrlParts', () => {
  it('developer → system（上游只认 system/user/assistant/tool）', () => {
    const body: Record<string, unknown> = { messages: [msg({ role: 'Developer' }), msg({ role: 'user' })] }
    normalizeDeveloperRole(body)
    expect((body['messages'] as WireMessage[])[0]!['role']).toBe('system')
  })

  it('image_url 字符串 → { url } 对象（上游 11101）', () => {
    const body: Record<string, unknown> = {
      messages: [msg({
        role: 'user',
        content: [{ type: 'image_url', image_url: 'data:image/png;base64,AAA' }, { type: 'text', text: 'hi' }],
      })],
    }
    normalizeImageUrlParts(body)
    const parts = (body['messages'] as WireMessage[])[0]!['content'] as Record<string, unknown>[]
    expect(parts[0]!['image_url']).toEqual({ url: 'data:image/png;base64,AAA' })
    // 已是对象的形态不动
    const objForm: Record<string, unknown> = {
      messages: [msg({ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x', detail: 'low' } }] })],
    }
    normalizeImageUrlParts(objForm)
    const kept = (objForm['messages'] as WireMessage[])[0]!['content'] as Record<string, unknown>[]
    expect(kept[0]!['image_url']).toEqual({ url: 'x', detail: 'low' })
  })
})

describe('dropReasoningParts', () => {
  it('剔除 reasoning / reasoning_text part，保留其余', () => {
    const body: Record<string, unknown> = {
      messages: [msg({
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'answer' }],
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      })],
    }
    dropReasoningParts(body)
    const parts = (body['messages'] as WireMessage[])[0]!['content'] as Record<string, unknown>[]
    expect(parts.map(p => p['type'])).toEqual(['text'])
  })

  it('剔空且**无** tool_calls → 整条消息删除（不留空发言把 400 挪到上游）', () => {
    const body: Record<string, unknown> = {
      messages: [
        msg({ role: 'user', content: [{ type: 'reasoning_text', text: 'x' }] }),
        msg({ role: 'user', content: 'hello' }),
      ],
    }
    dropReasoningParts(body)
    expect((body['messages'] as WireMessage[]).length).toBe(1)
    expect((body['messages'] as WireMessage[])[0]!['content']).toBe('hello')
  })

  it('剔空但**有** tool_calls → 保留空 content 数组（承接 null 语义）', () => {
    const body: Record<string, unknown> = {
      messages: [msg({
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'x' }],
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      })],
    }
    // ⚠️ 单独调这一步：走 `prepareBuddyBody` 会继续跑 cleanup 把无结果的调用剔掉，
    // 就测不到「content 空数组」这一格了（那是另一条 pass 的职责）。
    dropReasoningParts(body)
    const first = (body['messages'] as WireMessage[])[0]!
    expect(first['content']).toEqual([])
    expect(Array.isArray(first['tool_calls'])).toBe(true)
  })
})

describe('mergeAdjacentToolCalls', () => {
  it('背靠背两条 assistant.tool_calls 合并成一条（deepseek 11148 的正面修复）', () => {
    const messages: WireMessage[] = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
      { role: 'tool', tool_call_id: 'c2', content: 'r2' },
    ]
    mergeAdjacentToolCalls(messages)
    expect(messages.length).toBe(3)
    const calls = messages[0]!['tool_calls'] as Record<string, unknown>[]
    expect(calls.map(c => c['id'])).toEqual(['c1', 'c2'])
  })

  it('反向形态：纯正文 assistant 折进带 tool_calls 的那条', () => {
    const messages: WireMessage[] = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }] },
      { role: 'assistant', content: '正文' },
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
    ]
    mergeAdjacentToolCalls(messages)
    expect(messages.length).toBe(2)
    expect(messages[0]!['content']).toBe('正文')
  })

  it('负例：中间隔了别的消息 → 不合并（不猜语义）', () => {
    const messages: WireMessage[] = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }] },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } }] },
    ]
    mergeAdjacentToolCalls(messages)
    expect(messages.length).toBe(3)
  })

  it('负例：后一条有正文 → 不合并（无正文条件）', () => {
    const messages: WireMessage[] = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }] },
      { role: 'assistant', content: '有正文', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } }] },
    ]
    mergeAdjacentToolCalls(messages)
    expect(messages.length).toBe(2)
  })

  it('reasoning_content 不丢：两边都有则换行拼接（deepseek 多轮回填要求）', () => {
    const messages: WireMessage[] = [
      { role: 'assistant', content: null, reasoning_content: 'A', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }] },
      { role: 'assistant', content: null, reasoning_content: 'B', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } }] },
    ]
    mergeAdjacentToolCalls(messages)
    expect(messages[0]!['reasoning_content']).toBe('A\nB')
  })
})

describe('repackToolResultBlocks', () => {
  it('插在同批 tool 结果中间的消息挪到整组之后，结果相对顺序不变', () => {
    const messages: WireMessage[] = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }, { id: 'c2' }] },
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
      { role: 'system', content: 'notice' },
      { role: 'tool', tool_call_id: 'c2', content: 'r2' },
    ]
    repackToolResultBlocks(messages)
    expect(messages.map(m => m['role'])).toEqual(['assistant', 'tool', 'tool', 'system'])
    expect(messages[1]!['tool_call_id']).toBe('c1')
    expect(messages[2]!['tool_call_id']).toBe('c2')
  })

  it('下一组 assistant.tool_calls 是组头，绝不能被当插入物吞掉', () => {
    const messages: WireMessage[] = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c2' }] },
      { role: 'tool', tool_call_id: 'c2', content: 'r2' },
    ]
    repackToolResultBlocks(messages)
    expect(messages.map(m => m['role'])).toEqual(['assistant', 'tool', 'assistant', 'tool'])
  })

  it('无插入消息时保持原顺序', () => {
    const messages: WireMessage[] = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }, { id: 'c2' }] },
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
      { role: 'tool', tool_call_id: 'c2', content: 'r2' },
    ]
    repackToolResultBlocks(messages)
    expect(messages.map(m => m['role'])).toEqual(['assistant', 'tool', 'tool'])
  })
})

describe('cleanupOrphanToolCalls', () => {
  it('逐 id 对称裁剪：批 [c1,c2] 只有 c1 有结果 → 保留 c1 并删掉 c2 的声明', () => {
    const messages: WireMessage[] = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'a' } }, { id: 'c2', function: { name: 'b' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
    ]
    cleanupOrphanToolCalls(messages)
    const calls = messages[0]!['tool_calls'] as Record<string, unknown>[]
    expect(calls.map(c => c['id'])).toEqual(['c1'])
    expect(messages.length).toBe(2)
  })

  it('无结果的调用全部剔除 → 删掉整个 tool_calls 键（不留空数组）', () => {
    const messages: WireMessage[] = [
      { role: 'assistant', content: 'x', tool_calls: [{ id: 'c9', function: { name: 'a' } }] },
      { role: 'user', content: 'next' },
    ]
    cleanupOrphanToolCalls(messages)
    expect('tool_calls' in messages[0]!).toBe(false)
  })

  it('空名调用一律剔除（上游 11133），带不带结果都一样', () => {
    const messages: WireMessage[] = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: '   ' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
    ]
    cleanupOrphanToolCalls(messages)
    expect('tool_calls' in messages[0]!).toBe(false)
    // 对应结果也一并删除（否则变成孤儿 tool）
    expect(messages.filter(m => m['role'] === 'tool').length).toBe(0)
  })

  it('孤儿 tool 消息（无对应调用）删除', () => {
    const messages: WireMessage[] = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'a' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
      { role: 'tool', tool_call_id: 'ghost', content: 'r2' },
    ]
    cleanupOrphanToolCalls(messages)
    expect(messages.filter(m => m['role'] === 'tool').map(m => m['tool_call_id'])).toEqual(['c1'])
  })

  it('无工具流量时零改动', () => {
    const messages: WireMessage[] = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }]
    cleanupOrphanToolCalls(messages)
    expect(messages).toEqual([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }])
  })
})

describe('resolveToolPairingPerCall（与 sse.ts 批级判据的分叉点）', () => {
  it('批内部分配对：逐 id 保留有结果的那个（批级实现会把整批剔掉）', () => {
    const messages = [{
      role: 'assistant',
      content: [
        { type: 'tool-call', id: 'c1', name: 'a', arguments: '{}' },
        { type: 'tool-call', id: 'c2', name: 'b', arguments: '{}' },
      ],
    }, {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'c1', content: 'r1' }],
    }]
    const { keepCallIds } = resolveToolPairingPerCall(messages)
    expect([...keepCallIds]).toEqual(['c1'])
  })

  it('空名调用不保留（与 cleanup 同口径）', () => {
    const messages = [{
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c1', name: '  ', arguments: '{}' }],
    }, {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'c1', content: 'r1' }],
    }]
    const { keepCallIds } = resolveToolPairingPerCall(messages)
    expect(keepCallIds.size).toBe(0)
  })
})

describe('backfillReasoningContent', () => {
  it('deepseek + thinkingEnabled：空串补空白串（空串 400 / 空白串 200）', () => {
    const messages: WireMessage[] = [{ role: 'assistant', content: 'x', reasoning_content: '' }]
    backfillReasoningContent(messages, { model: 'deepseek-v4.1-flash', thinkingEnabled: true })
    expect(messages[0]!['reasoning_content']).toBe(' ')
    expect(messages[0]!['reasoning']).toBe(' ')
  })

  it('deepseek 且无 thinking 无痕迹 → 零改动（官方 disabled 分支）', () => {
    const messages: WireMessage[] = [{ role: 'assistant', content: 'x' }]
    backfillReasoningContent(messages, { model: 'deepseek-v4.1-flash' })
    expect('reasoning_content' in messages[0]!).toBe(false)
  })

  it('有痕迹（历史里带 reasoning）→ 即便没开 thinking 也补', () => {
    const messages: WireMessage[] = [
      { role: 'assistant', content: 'x', reasoning: 'think' },
      { role: 'assistant', content: 'y' },
    ]
    backfillReasoningContent(messages, { model: 'deepseek-v4-pro' })
    expect(messages[1]!['reasoning_content']).toBe(' ')
  })

  it('非 deepseek 系零改动（glm 有自己的 thinkingFormat）', () => {
    const messages: WireMessage[] = [{ role: 'assistant', content: 'x', reasoning_content: '' }]
    backfillReasoningContent(messages, { model: 'glm-5.3', thinkingEnabled: true })
    expect(messages[0]!['reasoning_content']).toBe('')
  })

  it('已有非空 reasoning_content → 保留，并把 reasoning 镜像成同值', () => {
    const messages: WireMessage[] = [{ role: 'assistant', content: 'x', reasoning_content: 'think' }]
    backfillReasoningContent(messages, { model: 'deepseek-v4.1-flash', thinkingEnabled: true })
    expect(messages[0]!['reasoning_content']).toBe('think')
    expect(messages[0]!['reasoning']).toBe('think')
  })
})

describe('裸错误码反探测（整单级）', () => {
  it('字面量长度 5 / 6 且互不相同（防止环境改写把两个常量并成一个值）', () => {
    expect(BARE_ERROR_CODE.length).toBe(5)
    expect(BARE_ERROR_CODE_NEUTRALIZED.length).toBe(6)
    expect(BARE_ERROR_CODE).not.toBe(BARE_ERROR_CODE_NEUTRALIZED)
  })

  it('改写真的发生（长度变长 = 插入了连字符）', () => {
    const input = `code=${BARE_ERROR_CODE}`
    const output = rewriteBareErrorCodeProbe(input, 'buddy')
    expect(output).not.toBe(input)
    expect(output.length).toBe(input.length + 1)
    expect(output).toContain(BARE_ERROR_CODE_NEUTRALIZED)
  })

  it('相邻码不误伤（边界断言，非裸 split）', () => {
    const input = `${BARE_ERROR_CODE}0`
    expect(rewriteBareErrorCodeProbe(input, 'buddy')).toBe(input)
  })

  it('非腾讯系 provider 原样返回', () => {
    expect(rewriteBareErrorCodeProbe(BARE_ERROR_CODE, 'qoder')).toBe(BARE_ERROR_CODE)
  })

  it('对**全角色与全文本字段**生效（与模板句指纹的作用域不同）', () => {
    const messages: WireMessage[] = [
      { role: 'user', content: `报错是 ${BARE_ERROR_CODE}` },
      { role: 'tool', content: [{ type: 'text', text: `tool says ${BARE_ERROR_CODE}` }] },
      { role: 'assistant', content: 'ok', reasoning_content: `thought ${BARE_ERROR_CODE}` },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'f', arguments: `{"q":"${BARE_ERROR_CODE}"}` } }] },
    ]
    rewriteBareProbeEverywhere(messages, text => rewriteBareErrorCodeProbe(text, 'buddy'))
    expect(messages[0]!['content']).toContain(BARE_ERROR_CODE_NEUTRALIZED)
    expect((messages[1]!['content'] as Record<string, unknown>[])[0]!['text']).toContain(BARE_ERROR_CODE_NEUTRALIZED)
    expect(messages[2]!['reasoning_content']).toContain(BARE_ERROR_CODE_NEUTRALIZED)
    const args = ((messages[3]!['tool_calls'] as Record<string, unknown>[])[0] as Record<string, unknown>)['function'] as Record<string, unknown>
    expect(args['arguments']).toContain(BARE_ERROR_CODE_NEUTRALIZED)
  })
})

describe('Anthropic header 指纹剥离', () => {
  it('键值形态整段删除，裸键名做最小缩写', () => {
    const input = 'x-anthropic-billing-hdr: abc; rest'
    const output = redactAnthropicHeaderFingerprints(input, 'buddy')
    expect(output).toBe('rest')
  })

  it('cc_ 键值清理', () => {
    const output = redactAnthropicHeaderFingerprints('cc_account=xyz; keep me', 'buddy')
    expect(output).toBe('keep me')
  })

  it('无指纹文本逐字节不变', () => {
    const input = '普通正文，没有任何指纹'
    expect(redactAnthropicHeaderFingerprints(input, 'buddy')).toBe(input)
  })

  it('非腾讯系 provider 不动', () => {
    const input = 'x-anthropic-billing-hdr: abc;'
    expect(redactAnthropicHeaderFingerprints(input, 'qoder')).toBe(input)
  })
})

describe('prepareBuddyBody 端到端（管线顺序）', () => {
  it('一次调用把多件事同时做掉：stream/stream_options/角色/工具配对', () => {
    const body: Record<string, unknown> = {
      model: 'deepseek-v4.1-flash',
      messages: [
        { role: 'developer', content: 'sys' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', function: { name: 'a', arguments: '{}' } }],
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c2', function: { name: 'b', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'r1' },
      ],
    }
    prepareBuddyBody(body, { model: 'deepseek-v4.1-flash', thinkingEnabled: true })
    expect(body['stream']).toBe(true)
    expect(body['stream_options']).toEqual({ include_usage: true })
    const messages = body['messages'] as WireMessage[]
    expect(messages[0]!['role']).toBe('system')
    // 两条背靠背调用合并，且 c2 无结果被裁掉 → 只剩 c1
    const calls = messages[1]!['tool_calls'] as Record<string, unknown>[]
    expect(calls.map(c => c['id'])).toEqual(['c1'])
  })
})

describe('buildConversationHeaders / isB3TraceId', () => {
  it('B3 TraceId 只认 16/32 hex，非法时回落消息级 id', () => {
    expect(isB3TraceId('a'.repeat(32))).toBe(true)
    expect(isB3TraceId('a'.repeat(16))).toBe(true)
    expect(isB3TraceId('not-hex-zz')).toBe(false)
    const headers = buildConversationHeaders({
      conversationRequestId: 'not-a-hex-id',
      messageId: 'b'.repeat(32),
    })
    expect(headers['X-B3-TraceId']).toBe('b'.repeat(32))
    expect(headers['X-B3-SpanId']).toBe('b'.repeat(16))
  })

  it('会话 id 缺失时回落聚合主键（不因为「透传优先」而漏发该头）', () => {
    const headers = buildConversationHeaders({
      conversationRequestId: 'c'.repeat(32),
      messageId: 'd'.repeat(32),
    })
    expect(headers['X-Conversation-ID']).toBe('c'.repeat(32))
    expect(headers['X-Root-Request-ID']).toBe('c'.repeat(32))
  })
})

describe('derivedStableId', () => {
  it('同 uid 同用途恒同值；不同 uid / 不同用途互异；36 hex', () => {
    const machine = derivedStableId('u1', 'machine', hash36)
    expect(machine).toBe(derivedStableId('u1', 'machine', hash36))
    expect(machine).toHaveLength(36)
    expect(machine).not.toBe(derivedStableId('u2', 'machine', hash36))
    expect(machine).not.toBe(derivedStableId('u1', 'session', hash36))
  })
})

describe('buildChatHeaders', () => {
  const base = {
    apiDomain: 'copilot.tencent.com',
    webOrigin: 'https://www.codebuddy.cn',
    acceptLanguage: 'zh-CN',
    accessToken: 'tok',
    conversationRequestId: 'a'.repeat(32),
    messageId: 'b'.repeat(32),
    createHash: hash36,
  }

  it('CN 个人账号：无企业声明 + X-Domain + 全部对齐头', () => {
    const headers = buildChatHeaders({ ...base, uid: 'u1', isGlobal: false })
    expect(headers['authorization']).toBe('Bearer tok')
    expect(headers['accept']).toBe('application/json, text/event-stream')
    expect(headers['origin']).toBe('https://www.codebuddy.cn')
    expect(headers['referer']).toBe('https://www.codebuddy.cn/')
    expect(headers['x-codebuddy-request']).toBe('1')
    expect(headers['accept-language']).toBe('zh-CN')
    expect(headers['x-requested-with']).toBe('XMLHttpRequest')
    expect(headers['x-user-id']).toBe('u1')
    expect(headers['x-no-enterprise-id']).toBe('1')
    expect(headers['x-domain']).toBe('copilot.tencent.com')
    expect(headers['x-machine-id']).toHaveLength(36)
    expect(headers['x-session-id']).toHaveLength(36)
    expect(headers['x-b3-sampled']).toBe('1')
  })

  it('CN 企业账号：发 X-Enterprise-Id（不发明细声明）', () => {
    const headers = buildChatHeaders({ ...base, uid: 'u1', enterpriseId: 'ent-1', isGlobal: false })
    expect(headers['x-enterprise-id']).toBe('ent-1')
    expect('x-no-enterprise-id' in headers).toBe(false)
  })

  it('缺 uid → X-No-User-Id: 1（且不派生设备指纹）', () => {
    const headers = buildChatHeaders({ ...base, isGlobal: false })
    expect(headers['x-no-user-id']).toBe('1')
    expect('x-machine-id' in headers).toBe(false)
  })

  it('域为空 → 改发 X-No-Department-Info: 1（不发空 X-Domain）', () => {
    const headers = buildChatHeaders({ ...base, apiDomain: '', uid: 'u1', isGlobal: false })
    expect('x-domain' in headers).toBe(false)
    expect(headers['x-no-department-info']).toBe('1')
  })

  it('国际版：恒声明无企业 + 国际域（忽略凭据里的企业 id）', () => {
    const headers = buildChatHeaders({
      ...base,
      apiDomain: 'www.workbuddy.ai',
      webOrigin: 'https://www.workbuddy.ai',
      acceptLanguage: 'en-US',
      uid: 'u1',
      enterpriseId: 'ent-1',
      isGlobal: true,
    })
    expect(headers['x-no-enterprise-id']).toBe('1')
    expect('x-enterprise-id' in headers).toBe(false)
    expect(headers['x-domain']).toBe('www.workbuddy.ai')
    expect(headers['accept-language']).toBe('en-US')
  })

  it('deviceToken 有则注入', () => {
    const headers = buildChatHeaders({ ...base, uid: 'u1', deviceToken: 'dev-1', isGlobal: false })
    expect(headers['x-device-token']).toBe('dev-1')
  })
})

describe('resolveChatBase', () => {
  it('无环境变量 → 产品 endpoint', () => {
    delete process.env['DSH_BUDDY_CHAT_BASE']
    expect(resolveChatBase(CODEBUDDY)).toBe(CODEBUDDY.endpoint)
  })

  it('可覆盖 CN chat 基址并剥掉尾斜杠', () => {
    process.env['DSH_BUDDY_CHAT_BASE'] = 'https://www.workbuddy.cn/'
    try {
      expect(resolveChatBase(CODEBUDDY)).toBe('https://www.workbuddy.cn')
      // 覆盖不影响另一个产品
      expect(resolveChatBase(WORKBUDDY)).toBe(WORKBUDDY.endpoint)
    } finally {
      delete process.env['DSH_BUDDY_CHAT_BASE']
    }
  })

  it('非法值忽略并回落默认（一个手滑的变量不该让渠道起不来）', () => {
    process.env['DSH_BUDDY_CHAT_BASE'] = 'not-a-url'
    try {
      expect(resolveChatBase(CODEBUDDY)).toBe(CODEBUDDY.endpoint)
    } finally {
      delete process.env['DSH_BUDDY_CHAT_BASE']
    }
  })
})

describe('产品配置的对齐不变量', () => {
  it('国际版 UA 只有一份（不允许按模型族降级成国内平台段）', () => {
    expect(WORKBUDDY.userAgentByModelFamily ?? []).toHaveLength(0)
    expect(WORKBUDDY.userAgent).toContain('WorkBuddy AI/')
    // CLI 段必须是真实 CLI 版本号（历史上填的是客户端版本，与任何真实客户端都不对应）
    expect(WORKBUDDY.userAgent).toContain(`CLI/${WORKBUDDY.cliVersion}`)
    expect(WORKBUDDY.cliVersion).toBe('2.137.1')
    expect(WORKBUDDY.clientVersion).toBe('5.5.4')
  })

  it('两个产品的 Origin / Accept-Language 都配齐且与 API 域分开', () => {
    expect(CODEBUDDY.webOrigin).toBe('https://www.codebuddy.cn')
    expect(CODEBUDDY.acceptLanguage).toBe('zh-CN')
    expect(WORKBUDDY.webOrigin).toBe('https://www.workbuddy.ai')
    expect(WORKBUDDY.acceptLanguage).toBe('en-US')
    // CN 的网页站与 API 站**不是同一个站**（这是 Origin 不能取 endpoint 的理由）
    expect(CODEBUDDY.webOrigin).not.toBe(CODEBUDDY.endpoint)
  })
})
