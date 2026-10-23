import { describe, expect, it } from 'vitest'
import { DEFAULT_GATEWAY_HOST, LAN_GATEWAY_HOST, isWildcardHost, resolveGatewayConfig } from '../../src/openai-gateway/config.js'
import { lanAddresses, lanGatewayUrls } from '../../src/openai-gateway/lan.js'

/**
 * 「允许局域网访问」开关（2026-10-23）—— **配置层**判据。
 *
 * 用户诉求：「画面和逻辑都只绑定了 127.0.0.1，希望加个开关支持局域网调用，
 * 默认不开启」。本文件锁三件事：
 *
 * 1. 默认（不传 `lanAccess` / 关）时地址与改动前**逐字节一致**（127.0.0.1）；
 * 2. 开关打开时绑通配地址（`0.0.0.0`）；
 * 3. **env 优先**且 **env 侧的通配拒绝不被开关削弱** —— 这是最容易被"顺手放宽"的一格：
 *    `DSH_OPENAI_GATEWAY_HOST=0.0.0.0` 仍然必须抛错（那是手滑/笔误的防线），
 *    开关走的是自己的布尔通路，不是字符串通路。
 */

const EMPTY = {}

describe('resolveGatewayConfig 的默认行为（不得回归）', () => {
  it('都不设 ⇒ 127.0.0.1（与改动前逐字节一致）', () => {
    expect(resolveGatewayConfig(EMPTY)).toEqual({ host: DEFAULT_GATEWAY_HOST, port: 8326 })
    expect(resolveGatewayConfig(EMPTY, {})).toEqual({ host: DEFAULT_GATEWAY_HOST, port: 8326 })
    expect(resolveGatewayConfig(EMPTY, { lanAccess: false })).toEqual({ host: DEFAULT_GATEWAY_HOST, port: 8326 })
  })

  it('缺省即关闭：不传 lanAccess 不等于打开', () => {
    expect(resolveGatewayConfig(EMPTY).host).toBe('127.0.0.1')
  })
})

describe('开关打开 ⇒ 绑通配地址', () => {
  it('lanAccess=true 且 env 未设 ⇒ 0.0.0.0', () => {
    expect(resolveGatewayConfig(EMPTY, { lanAccess: true })).toEqual({ host: LAN_GATEWAY_HOST, port: 8326 })
    expect(isWildcardHost(LAN_GATEWAY_HOST)).toBe(true)
  })

  it('端口仍走 env 解析（开关不影响端口）', () => {
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_PORT: '9000' }, { lanAccess: true }))
      .toEqual({ host: LAN_GATEWAY_HOST, port: 9000 })
  })
})

describe('env 优先级（容器里刻意绑某接口的部署不能被 UI 顶掉）', () => {
  it('env 给了具体地址 ⇒ 开关打开也用 env 的地址', () => {
    const config = resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: '172.21.0.8' }, { lanAccess: true })
    expect(config.host).toBe('172.21.0.8')
  })

  it('env 给了具体地址 ⇒ 开关关闭同样用它（env 一直优先）', () => {
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: '172.21.0.8' }, { lanAccess: false }).host)
      .toBe('172.21.0.8')
  })

  it('⚠️ env 写通配**仍然抛错**：开关不得成为绕过手滑防线的后门', () => {
    expect(() => resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: '0.0.0.0' }, { lanAccess: false }))
      .toThrow(/不能是通配地址/)
    expect(() => resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: '0.0.0.0' }, { lanAccess: true }))
      .toThrow(/不能是通配地址/)
    // 紧凑写法同样拦（`0` 在 Linux 上就是 0.0.0.0）
    expect(() => resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: '0' }, { lanAccess: true }))
      .toThrow(/不能是通配地址/)
  })

  it('env 空串 / 只有空白 ⇒ 视为未设（走开关的默认分支）', () => {
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: '   ' }, { lanAccess: true }).host)
      .toBe(LAN_GATEWAY_HOST)
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: '' }, { lanAccess: false }).host)
      .toBe(DEFAULT_GATEWAY_HOST)
  })
})

describe('lanAddresses：过滤规则', () => {
  const fake = (entries) => entries

  it('只保留非内部 IPv4 且丢掉 link-local 与重复项', () => {
    const result = lanAddresses(fake({
      'WLAN': [
        { address: '192.168.1.8', family: 'IPv4', internal: false },
        { address: 'fe80::1', family: 'IPv6', internal: false },
      ],
      'Loopback': [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      'vEthernet (WSL)': [{ address: '169.254.10.20', family: 'IPv4', internal: false }],
      'Ethernet': [
        { address: '192.168.1.8', family: 4, internal: false },
        { address: '10.0.0.5', family: 4, internal: false },
      ],
    }))
    expect(result).toEqual([
      { iface: 'WLAN', address: '192.168.1.8' },
      { iface: 'Ethernet', address: '10.0.0.5' },
    ])
  })

  it('family 字符串与数字两种形态都认（Node 版本差异）', () => {
    const both = lanAddresses({
      a: [{ address: '192.168.0.2', family: 'IPv4', internal: false }],
      b: [{ address: '192.168.0.3', family: 4, internal: false }],
    })
    expect(both.map((entry) => entry.address)).toEqual(['192.168.0.2', '192.168.0.3'])
  })

  it('上限生效（多网卡机器不该把面板撑爆）', () => {
    const many = {}
    for (let index = 0; index < 20; index += 1) {
      many[`eth${index}`] = [{ address: `10.0.${index}.1`, family: 'IPv4', internal: false }]
    }
    expect(lanAddresses(many, 3)).toHaveLength(3)
  })

  it('全是内部地址 ⇒ 空数组（UI 会显示「未检测到局域网地址」）', () => {
    expect(lanAddresses({ lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] })).toEqual([])
  })

  it('脏输入不崩', () => {
    expect(lanAddresses({}, 0)).toEqual([])
    expect(lanAddresses({ a: undefined, b: null })).toEqual([])
  })
})

describe('lanGatewayUrls', () => {
  it('拼成可直接抄走的 OpenAI 兼容基地址', () => {
    const urls = lanGatewayUrls(8326, {
      WLAN: [{ address: '192.168.1.8', family: 'IPv4', internal: false }],
    })
    expect(urls).toEqual(['http://192.168.1.8:8326/v1'])
  })

  it('没有可用地址时返回空数组（不是 undefined）', () => {
    expect(lanGatewayUrls(8326, {})).toEqual([])
  })
})
