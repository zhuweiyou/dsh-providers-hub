/**
 * 局域网地址探测（**宿主专用**）。
 *
 * ## 为什么单独成文件，而不是留在 `config.ts`
 *
 * `plugin-src/client/openai-gateway-panel.js` 会 import `config.ts` 的纯函数
 * （`isWildcardHost` / `gatewayHttpUrl` / `formatGatewayHost`）——**客户端 bundle 跑在
 * 浏览器里，不能出现任何 `node:*` 依赖**。2026-10-23 加「允许局域网访问」时把
 * `networkInterfaces` 直接写进 `config.ts`，esbuild 当场报
 * `Could not resolve "node:os"`（整条客户端构建失败，不只是这个功能）。
 *
 * ⇒ 判据（是否通配 / URL 拼接）留在 `config.ts`；需要 kernel API 的探测留在这里。
 *
 * @module src/openai-gateway/lan.ts
 */

import { networkInterfaces } from 'node:os'
import { gatewayHttpUrl } from './config.js'

/** 一条可用的局域网 IPv4 地址。 */
export interface GatewayLanAddress {
  /** 网卡名（`WLAN` / `以太网` / `eth0` …），同一台机器有多块网卡时用于区分。 */
  iface: string
  address: string
}

/** `networkInterfaces()` 的返回形状（只取用到的字段，便于单测注入假数据）。 */
export type NetworkInterfaceMap = NodeJS.Dict<
  Array<{ address: string; family: string | number; internal: boolean }>
>

/**
 * 列出本机**可供局域网访问**的 IPv4 地址。
 *
 * 用途：`gateway.getEnabled` 回传它们，面板直接显示「局域网可用地址」——
 * 否则用户开了开关也不知道该让手机连哪个 IP（多网卡机器上更难猜）。
 *
 * ⚠️ 过滤规则（每条都有理由）：
 * - `internal === true` ⇒ 回环/本机专用接口，对局域网无意义；
 * - 非 IPv4 ⇒ 跳过（多数家用网络里 IPv6 不可达，列出来只会误导；Node 的 `family`
 *   在旧版本是字符串 `'IPv4'`、新版本是数字 `4`，**两种都认**）；
 * - `169.254.x.x`（link-local）⇒ 跳过：它只在 DHCP 失败时出现，几乎总是连不通；
 * - 去重（同一 IP 可能挂在多块虚拟网卡上，如 WSL 与主网卡共存）。
 *
 * ⚠️ 最多返回 `limit` 条：多网卡 + 虚拟机 + VPN 的机器可能十几个，全列会把面板
 * 撑爆。**不猜优先级**（主用网卡不一定在前），只如实给出。
 */
export function lanAddresses(interfaces: NetworkInterfaceMap = networkInterfaces(), limit = 6): GatewayLanAddress[] {
  const out: GatewayLanAddress[] = []
  const seen = new Set<string>()
  for (const [iface, entries] of Object.entries(interfaces)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (entry.internal === true) continue
      const family = String(entry.family)
      if (family !== 'IPv4' && family !== '4') continue
      const address = entry.address
      if (typeof address !== 'string' || address.length === 0) continue
      if (address.startsWith('169.254.')) continue
      if (seen.has(address)) continue
      seen.add(address)
      out.push({ iface, address })
      if (out.length >= limit) return out
    }
  }
  return out
}

/**
 * 把局域网地址拼成可直接抄走的 OpenAI 兼容基地址（`http://192.168.1.8:8326/v1`）。
 *
 * ⚠️ 只在**网关确实绑在通配地址上**时才有意义（绑 127.0.0.1 时这些 URL 连不通）。
 * 调用方（`gatewayLanFields`）负责判据，这里不猜。
 */
export function lanGatewayUrls(port: number, interfaces?: NetworkInterfaceMap): string[] {
  return lanAddresses(interfaces).map((entry) => gatewayHttpUrl(entry.address, port, '/v1'))
}
