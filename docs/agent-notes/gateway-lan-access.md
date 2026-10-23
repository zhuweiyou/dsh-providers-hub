# 网关「允许局域网访问」开关（2026-10-23）

> 触发条件：改 `src/openai-gateway/config.ts` / `lan.ts` / `server.ts` / `runtime.ts`、
> 网关弹窗的地址与安全文案、或排查「开关开了但手机连不上 / 本机也连不上」时先读这一节。

## 0. 用户诉求与交付

> 「网关那边 我们画面和逻辑都只绑定了 127.0.0.1，我希望加个开关控件 支持局域网调用，
> 而不只是本机调用。但默认不开启 …… 包括画面上说只允许 127 的相关文案也要调整了」

交付：网关弹窗新增**独立第二开关**「允许局域网访问」（默认关），拨动即重建监听；
面板同步显示可达的局域网地址；所有「只绑定 127.0.0.1」的文案改为按真实绑定面分支。

## 1. 两个独立开关（别合并）

| 开关 | 持久化键 | 缺键缺省 | 回答的问题 |
|---|---|---|---|
| 启用本机网关 | `gatewayEnabled` | **true** | 跑不跑 |
| 允许局域网访问 | `gatewayLanAccess` | **false** | 谁能连 |

⚠️ **缺键方向刻意相反**：网关开关丢键 ⇒ 网关没跑起来（可观测、点一下就好）；
局域网开关丢键 ⇒ 网关绑全部网卡（暴露面扩大且**毫无提示**）⇒ 必须取更安全的一端。
判据在 `sanitizeGatewayLanAccess`（**只认显式 `true`**），有单测逐值钉住
（`'true'` / `1` / `{}` 一律 false）。

## 2. 绑什么地址：通配，不是"探测到的那个 IP"

`LAN_GATEWAY_HOST = '0.0.0.0'`。为什么不用 `lanAddresses()[0]`：

- 探测式绑定在 **DHCP 换租 / 多网卡（WiFi+有线+WSL+Docker+vEthernet）/ VPN 拨入**下
  会**静默失效**，症状是「开关是开的、手机连不上」，用户完全无从排查；
- 通配覆盖所有当前与将来的接口，IP 变了也不用重启；代价是暴露面 = 这台机器所有
  可路由网卡（含直连公网的情况），故**代价必须写在 UI 上**（列 LAN 地址 + 明说只靠 Key）。

## 3. env 优先级（不要动）

`DSH_OPENAI_GATEWAY_HOST` **显式**给了地址就一律以 env 为准（容器里刻意绑某接口的
部署不能被 UI 顶掉）。开关只影响「env 没说话」那种默认情况。

⚠️⚠️ **env 侧的通配拒绝**（`isWildcardHost` + `isLegalHostText` + fail-closed 字符闸门）
**一个字都不能放宽** —— 那是防手滑/笔误的防线。开关走的是**自己的布尔通路**
（`options.lanAccess`），不是把字符串塞进 env。单测专门有一条：
`DSH_OPENAI_GATEWAY_HOST=0.0.0.0`（以及紧凑写法 `0`）在 `lanAccess: true` 下**仍然抛错**。

## 4. 必须重建监听（Node 不能原地换 host）

`server.listen(port, host)` 是初始化参数 ⇒ 拨开关后只能「关旧实例 + 按新配置再起」。
实现在 `restartGatewayRuntime()`（`src/openai-gateway/runtime.ts`）：

- 关闭旧实例失败**不阻断重建**（旧 socket 可能半关，但新配置必须生效）；
- 不吞掉「没起来」这件事 —— 面板读 `isGatewayRunning()` / `gatewayAddress()` 显示
  「已选择开启但未监听」（与端口被占用的既有提示同一条路径）。

⚠️ 工厂里读开关必须**每次创建时现读**（`readLanSwitch(pool)`），不能在 mount 时快照：
读快照的症状是「开关点了没反应，只有重启 DSH 才生效」。

## 5. ⚠️⚠️ `config.ts` 必须保持「浏览器可打包」

`plugin-src/client/openai-gateway-panel.js` 会 import `config.ts` 的纯函数
（`isWildcardHost` / `gatewayHttpUrl` / `formatGatewayHost`）。2026-10-23 我把
`networkInterfaces` 直接写进 `config.ts`，**esbuild 当场报 `Could not resolve "node:os"`**
—— 失败的是**整条客户端构建**，不只是这个功能（症状极具误导性：先看到的是「Unexpected *」
之类的解析错误）。

⇒ 分工固定：**判据**（是否通配 / URL 拼接）留 `config.ts`；**需要 kernel API 的探测**
（`lanAddresses` / `lanGatewayUrls`）放 `src/openai-gateway/lan.ts`（宿主专用）。

## 6. UI 文案的三条硬要求

1. **通配地址不能印成可抄的 endpoint**：`http://0.0.0.0:8326/v1` 连不上。
   `gatewayEndpoint()` 在通配时回 `127.0.0.1`；监听标签走 `gatewayBindLabel()`
   （「在所有网卡监听」）；局域网地址单独列（`gatewayLanUrls()`，逐条可抄）。
2. **成本与后果写在开关旁**：`gatewayLanSwitchHint()` 说清「关闭=只有这台机器」
   「开启=同网络设备都能访问，隔离只靠 API Key」。**纯文本，不得出现 `**`**（会原样显示星号）。
3. **env 覆盖了开关必须明说**（`gatewayLanOverrideHint()`）：开关开、但绑的不是通配
   ⇒ 只能是 env 指定了具体地址。不说清的话用户会以为「开关坏了」。
4. 页头 tooltip 也要带出「局域网可访问」（`gatewayButtonTitle`）。

## 7. 验证口径

- 配置层：`tests/unit/openai-gateway-lan-access.spec.ts`（默认不变 / 开关开 / env 优先 /
  env 通配仍拒 / lanAddresses 过滤 / URL 拼接）。
- 面板层：`tests/unit/openai-gateway-panel.spec.ts` 新增「允许局域网访问：地址与文案」组。
- 持久化层：`tests/unit/jet-hub-store.spec.ts` 的 `sanitizeGatewayLanAccess` +
  三处「整份文档 deep equal」的期望对象（新增字段要如实补上，**不要**放宽成 `toMatchObject`）。
- **端到端**：`tests/unit/openai-gateway-lan-bind.spec.ts` —— 真起监听并做**阴性对照**：
  开关开 ⇒ 本机局域网 IP 拿到 HTTP 响应；开关关 ⇒ 同一个 IP **拿不到 HTTP 响应**。
  ⚠️ 阴性判据是「没有 HTTP 响应」，**不是**死抠 errno：Windows 实测是 `timeout`
  （本机防火墙静默丢包），Linux 通常是 `ECONNREFUSED` —— 绑死错误码会得到环境性假红。
  ⚠️ 纯回环环境（容器/沙箱）无对照面：用例**跳过**连通性断言（`lanAddresses()` 为空），
  但 `address().host` 的断言照常执行。
- 与既有 `openai-gateway-host-binding.spec.ts` 的关系：那条锁「env 给的 host 真的改变
  绑定面」，本条锁「开关真的改变绑定面」，两者共用同一套探针纪律（显式 `Agent`，
  否则 `NODE_USE_ENV_PROXY` 会把探针送去本机代理、拿到 503 而不是内核行为）。
