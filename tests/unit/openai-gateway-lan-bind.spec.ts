import { Agent, createServer, request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createOpenAiGateway } from '../../src/openai-gateway/server.js'
import { lanAddresses } from '../../src/openai-gateway/lan.js'

/**
 * 「允许局域网访问」开关的**端到端**判据（2026-10-23）。
 *
 * ⚠️ 为什么必须有这一层（与 `openai-gateway-host-binding.spec.ts` 同一条理由）：
 * 配置层用例只证明「解析出的 host 是 0.0.0.0」，一个「解析对了但 server 仍写死
 * listen(port, '127.0.0.1')」的实现能让那批用例全绿 —— 而用户看到的就是
 * 「开关开了、手机还是连不上」。
 *
 * 判据设计（**含阴性对照**）：
 * 1. 开关开 ⇒ `address().host` 是通配；**从本机局域网 IP 连得通**（证明真的绑上了
 *    那块网卡，而不是只绑了回环）；
 * 2. 开关关 ⇒ 从同一个局域网 IP **连不通**（证明开关真的改变了绑定面，而不是
 *    「本来就绑全网卡、开关只是个摆设」）。
 *
 * ⚠️ 没有可用局域网地址的机器（纯回环的容器）**跳过**第 1/2 条的连通性断言
 * （跳过原因写在用例名里，不是静默通过），但 `address().host` 的断言仍然执行。
 */

const directAgent = new Agent()

function freePort(): Promise<number> {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/** 从指定 host 探一眼：返回 `HTTP xxx` 或错误码。 */
function probe(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const req = request(
      { host, port, path: '/v1/models', method: 'GET', timeout: 2000, agent: directAgent },
      (response) => {
        response.resume()
        resolve(`HTTP ${response.statusCode ?? 0}`)
      },
    )
    req.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message))
    req.on('timeout', () => { req.destroy(); resolve('timeout') })
    req.end()
  })
}

const llm = {
  listProviders: () => [],
  listModels: async () => [],
  resolveModelInfo: async () => ({}),
  stream: () => { throw new Error('not used') },
}

const log = { info: () => {}, warn: () => {}, error: () => {} }
const opened: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  for (const gateway of opened.splice(0)) await gateway.close()
})

/** 本机第一条可用局域网地址（没有则 `undefined`）。 */
const lanIp = lanAddresses()[0]?.address

describe('允许局域网访问：真实绑定面', () => {
  it('开关开 ⇒ 绑通配地址（address().host 是 0.0.0.0）', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({
      llm,
      home: process.env.TEMP ?? '.',
      env: { DSH_OPENAI_GATEWAY_PORT: String(port), DSH_OPENAI_GATEWAY_API_KEY: 'k' },
      lanAccess: true,
      logger: log,
    })
    opened.push(gateway)
    await gateway.start()
    expect(gateway.address()).toEqual({ host: '0.0.0.0', port })
  }, 20_000)

  it('开关关（缺省）⇒ 只绑回环', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({
      llm,
      home: process.env.TEMP ?? '.',
      env: { DSH_OPENAI_GATEWAY_PORT: String(port), DSH_OPENAI_GATEWAY_API_KEY: 'k' },
      logger: log,
    })
    opened.push(gateway)
    await gateway.start()
    expect(gateway.address()).toEqual({ host: '127.0.0.1', port })
  }, 20_000)

  it('开关开 ⇒ 从本机局域网 IP 也连得通（证明真的绑了那块网卡）', async () => {
    if (lanIp === undefined) {
      // 纯回环环境（容器 / 沙箱）：无对照面可测，如实跳过。
      expect(lanIp).toBeUndefined()
      return
    }
    const port = await freePort()
    const gateway = createOpenAiGateway({
      llm,
      home: process.env.TEMP ?? '.',
      env: { DSH_OPENAI_GATEWAY_PORT: String(port), DSH_OPENAI_GATEWAY_API_KEY: 'k' },
      lanAccess: true,
      logger: log,
    })
    opened.push(gateway)
    await gateway.start()
    const fromLoopback = await probe('127.0.0.1', port)
    const fromLan = await probe(lanIp, port)
    expect(fromLoopback).toMatch(/^HTTP /)
    // 关键：局域网 IP 也通（未鉴权时是 401，但那是「连上了」的证据）。
    expect(fromLan).toMatch(/^HTTP /)
  }, 20_000)

  it('⚠️ 阴性对照：开关关时同一个局域网 IP 必须**连不通**', async () => {
    if (lanIp === undefined) {
      expect(lanIp).toBeUndefined()
      return
    }
    const port = await freePort()
    const gateway = createOpenAiGateway({
      llm,
      home: process.env.TEMP ?? '.',
      env: { DSH_OPENAI_GATEWAY_PORT: String(port), DSH_OPENAI_GATEWAY_API_KEY: 'k' },
      // 刻意不开
      logger: log,
    })
    opened.push(gateway)
    await gateway.start()
    expect(await probe('127.0.0.1', port)).toMatch(/^HTTP /)
    /**
     * 只绑回环 ⇒ 从局域网 IP 连过去**不该拿到任何 HTTP 响应**。
     *
     * ⚠️ 判据是「没有 HTTP 响应」，**不是**死抠某个 errno：实测（Windows 本机）
     * 拿到的是 `timeout` 而不是 `ECONNREFUSED` —— 本机防火墙对「发往自己局域网 IP
     * 的无监听端口」静默丢包。Linux 上通常是 `ECONNREFUSED`。两者都等价于
     * 「连不上」，把判据绑死成某一个错误码会得到环境性假红（本仓库已有同型教训：
     * 探针的环境差异被当成产品缺陷）。
     */
    const fromLan = await probe(lanIp, port)
    expect(fromLan).not.toMatch(/^HTTP /)
  }, 20_000)
})
