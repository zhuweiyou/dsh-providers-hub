# Gitee PR !131（Qoder 三档分档 + 锁定永久积分）审计记录

- 审计分支：`feat/qoder-expiry-lock-2`（PR 提交 `ba22ded`），基线 `upstream/master` = `dbbbc57`
- 净改动：**21 文件 +1303 / −46**（含新增 `tests/unit/qoder-lock-wiring.spec.ts`，450 行）
- 全量基线：`pnpm test` = **389 passed / 1 failed**（392 文件）、**9857 passed / 1 failed**（9880 用例）
  - 唯一红是 `tests/unit/model-catalog-parity.spec.ts` 的
    `'autoclawintl'：跨家目录契约` —— **在干净的 `upstream/master` 上同样红**（已用
    `git stash push -u` 把本 PR 改动全部移走后实测复现同一失败）。
    根因是该用例会真的去拉 `autoclawintl` 的模型目录，本机网络不通 ⇒ 撞 vitest
    默认 5s 超时（`--testTimeout=40000` 下通过）。**与本 PR 无关。**
- 审计方式：真机取证（两个真实 qodercn 账号 + 本机 Qoder 官方客户端 asar）→
  逐条变异验证（**11 条，全部在本分支基线上实跑**）→ 独立复跑全量 →
  变异还原自查。

## 一、结论摘要

| 维度 | 结论 |
|---|---|
| 报障（Qoder 缺三档分档与永久锁）是否成立 | ✅ 成立。registry 里 `qoder` / `qodercn` 两项能力**完全没登记**，面板上那整行与开关都不渲染 |
| 是否解决 | ✅ 解决（登记 + 折算 + 接线 + 锁定文案四层齐备，22 条新用例 + 9 份既有 spec 适配） |
| 是否引入新问题 | ⚠️ 引入一处**测试基建**欠账（`ratelimit-misreport-behavior.spec.ts` 三条阴性对照在断网机器上超时），已在本 PR 内补 `fetch` 桩修掉 |
| 顺带查出并修掉的既有缺口 | ✅ **两个**：① `jet-hub-rpc.ts` 的 qoder 特例分支漏回传 `windowDays`（会导致三档整行静默不渲染）；② `balance-cache-wiring.spec.ts` 的透传守卫只覆盖 buddy 系四家，另外 5 家（含 qoder）**零守卫** |
| 变异表是否可信 | ✅ 11 条**全部有判别力**（`G` 首轮无牙，已补守卫后复跑确认变红）—— 见 §3 |
| 是否编造日期 | ❌ **没有**。永久哨兵**不写** `deductionEndTime`；代价（临期桶恒为 0）如实记录在断言标题里，没有藏起来 |

## 二、真机取证（决定了本 PR 的形态）

### 2.1 用量端点

`GET https://openapi.qoder.com.cn/sash/api/v2/me/usage`（两个真实 qodercn 账号，200 / 126–178ms）：

```json
{"displayMode":"qoder","qoderUsage":{
  "userId":"01a0cca1-2528-718e-a44e-a31d9263e29a","userType":"personal_standard",
  "usageType":"credits","totalUsagePercentage":0,"isQuotaExceeded":false,
  "expiresAt":253402214400000,
  "userQuota":{"total":0,"used":0,"remaining":0,"percentage":0,"unit":"credits"},
  "addOnQuota":{"total":2000,"used":0,"remaining":2000,"percentage":0,"unit":"credits",
                "detailUrl":"https://qoder.cn/account/usage"},
  "isPlanQuotaProrated":false}}
```

1. `expiresAt = 253402214400000` = `9999-12-31T00:00:00.000Z` ⇒ **永久哨兵**，
   不是到期时刻。另一账号 `addOnQuota.total = 1600`。
2. `addOnQuota`（截图「个人资源包 1,900」）**只给聚合标量 + 一个指向网页端的
   `detailUrl`，零日期字段**。
3. `dedicatedResourcePackages`（**唯一**带真实逐包 `expiresAt` 的字段）本机两个
   账号实测均为 `undefined`。

### 2.2 逐包明细端点（全部拿不到，勿再试）

- `openapi` 域 `/sash/api/v2/me/{usage/detail,resources,packages,usage/packages,
  credit/packages,resource-packs,campaigns,benefits,userplan,quota,addon-quota,
  addOnQuota,addon/detail,quota/detail,usage/addon}` 与 `/v3/me/usage` ⇒ **全 404**。
- dashboard 域 `https://qoder.cn/api/v1/me/{quotas/,quotas/{key}/histories,
  usages/big_model_credits,usages/big_model_credits/histories,
  resource-packs/orders,userplan,third-party-fulfilled/orders}` ⇒ **全 401**
  （`{"errorCode":"Unauthorized"}`，需浏览器登录态 cookie；试过 `Bearer` /
  `Cosy-Authorization` / `Cookie: qoder_session=` / `Cookie: access_token=` /
  `x-qoder-token` / `Token` 全部 401）。
- 同路径打在 `openapi` 域 ⇒ 全 404。

⇒ 插件的 OAuth device token **拿不到逐包/逐笔明细**。这与 codearts 的
`IKJVTF` 完全同型 —— 裁定一致：**不伪造日期，做能如实做到的那一步。**

### 2.3 活动端点给出「语义」而非时刻

`GET /sash/api/v1/me/campaigns` → 200，`benefit.validity =
{ mode: "RELATIVE_DAYS", days: 30 }`，`placements[].description =
"每日 10:00（UTC+8）刷新，领取后 30 天有效"`。
⇒ `days = 30` 是**规则**，不是任何一笔的已知时刻，**不可**用来反推日期。

### 2.4 旁证：官方客户端 asar

本机 `D:\Qoder\resources\app.asar`（139516223 B），扫 1164 文件 / 59.1 MB，
命中相关标识的只有 `/out/main/index.js` 与 `/out/renderer/assets/index-DDa3WwIe.js`。

渲染层 `buildUsageItemGroups`：

- `userQuota` → `renewson: formatRenewal(expiresAt, …)` ⇒ 文案「**将于 {{date}} 刷新**」
  （**订阅刷新日**，不是积分到期日）；
- `addOnQuota` → **只渲染 used / total / remaining，不给任何日期**；
- `dedicatedResourcePackages` → `expiresOn` ⇒ 文案「**有效期至 {{date}}**」。

⇒ 客户端自己也不认为 `userQuota.expiresAt` 是「积分到期时间」。本 PR 把它当
哨兵处理，与该行为一致。

## 三、变异验证矩阵（11 条，全部在本分支基线上实跑）

跑的是 9 个相关 spec（`qoder-lock-wiring` / `provider-registry` /
`provider-registry-consumers` / `permanent-lock-execution` /
`buddy-permanent-lock` / `expiry-runtime-parity` / `credits-runtime-parity` /
`credits-capabilities` / `permanent-lock-trae-lobsterai`），**基线 196 passed**。

| 变异 | 做法 | 实测结果 | 判别力 |
|---|---|---|---|
| **A** | `src/provider-registry.ts:273` qoder 的 `permanentLock: true` → `false` | **6 条红 / 5 文件**：`provider-registry.spec.ts`「permanentLock 恰好是既有的 8 家」、`permanent-lock-execution.spec.ts`「登记表逐向对账」、`credits-capabilities.spec.ts`「前后端支持面完全一致」、`provider-registry-consumers.spec.ts`「支持锁定的渠道 ⊆ usesExpiryWindow ∪ {loomy}」、`qoder-lock-wiring.spec.ts` ×2（registry 契约 + 白名单派生） | ✅ |
| **B** | 同处 `usesExpiryWindow: true` → `false` | **6 条红 / 4 文件**：`provider-registry.spec.ts`「usesExpiryWindow 恰好是 9 家」、`provider-registry-consumers.spec.ts` ×2、`credits-runtime-parity.spec.ts` ×2（windowDays 回传 + 登记值与实测集合一致）、`qoder-lock-wiring.spec.ts`「两站都同时登记」 | ✅ |
| **C** | `src/qoder-credits.ts:465` `explicitUsable && !explicitIsPermanent` → `explicitUsable`（删掉永久哨兵判据 ⇒ 无条件写 `deductionEndTime`） | **5 条红**（全在 `qoder-lock-wiring.spec.ts`，**行为层真红、非源码级**）：「永久哨兵 ⇒ 不写 deductionEndTime」「边界 9999-01-01 也不写」「**用户可见后果 `packageExpiryMs === null`**」「前后端同规则分桶」「本家临期桶恒为 0」 | ✅ |
| **D** | `src/index.ts:1810` 国际版 `reportPickedAccount: true` → `false` | **1 条红**：`qoder-lock-wiring.spec.ts`「两站都必须 reportPickedAccount: true」 | ✅（唯一守卫，但存在且有效） |
| **E** | `src/index.ts:1744` 两站 `product` 互换（国际版改成 `QODER_CN`） | **3 条红 / 2 文件**：`qoder-lock-wiring.spec.ts` ×2（选号器接线 + **product 不得互换**）、`buddy-permanent-lock.spec.ts`「每个支持锁定的 provider 各建一个选号器」 | ✅ |
| **F** | `src/aggregate-expiry.ts:251` `WIRED_EXPIRY_PROVIDERS` 删掉 `'qoder'` | **3 条红**（全在 `expiry-runtime-parity.spec.ts`）：不变式一「逐项相等」、不变式三「AGGREGATE_CHANNELS 真渠道都已接入」、不变式二「7 家哨兵逐个返回自己的」 | ✅ |
| **G** | `src/provider-expiry.ts:271` 把 `context?.cachedBalance === undefined` 改成恒 `true`（关掉 qoder 的透传） | 修守卫**前**：在姊妹集成分支上用**逐字相同**的旧判据（`for (const id of ['buddy','workbuddy','lobsterai','trae'])`）实测 **74 passed 全绿 ⇒ 无牙**；本分支修守卫**后**复跑 **1 条红**（`balance-cache-wiring.spec.ts`「★ qoder 必须透传 cachedBalance」） | ⚠️→✅ 见 §4.2 |
| **H** | `src/index.ts:1891` 中国版 `lockedError` 改用 `qoderLockedError('Qoder')`（两家共用同一句文案） | **2 条红**（`qoder-lock-wiring.spec.ts`：「两处 lockedError 逐站点名」「两站都必须 reportPickedAccount: true」——后者因块内切片同时命中） | ✅ |
| **I** | `src/qoder-credits.ts:460` 删掉 `getUTCFullYear() >= 9999` 年份分支（只留 `>= 常量`） | **1 条红**：「边界：`9999-01-01`（**小于**常量但年份 9999）也不写」 | ✅（精确锁住年份分支的必要性） |
| **J** | `src/provider-expiry.ts` 生产表里**多挂一个未登记**的透传户（`qoderfake: qoderFamilyExpiry(QODER)`） | **1 条红**：「这些渠道在生产里接了 cachedBalance 透传，必须收进本表：expected [ 'qoderfake' ] to deeply equal []」 | ✅ |

**还原自查**：11 条全部还原后 `git diff` 为空、`git status` 无残留、
`grep qoderfake` / `真 \? undefined` 均无命中；复跑同一组 spec 回到
**196 passed**。

### 3.1 判据的「三方印证」与边界成对性

- `qoder-lock-wiring.spec.ts:296` 用 `Date.UTC(9999, 11, 31)` **独立算出**
  `9999-12-31T00:00:00.000Z`，再与常量 `QODER_PERMANENT_EXPIRY_MS`、与实测报文
  三者交叉验证（任一处漂移即红）—— 不是从被测代码自己算出来的同义反复。
- `:316` 的 `1_793_000_000_000` 先断言 `getUTCFullYear() < 9999`（**自证不是哨兵**），
  再断言原样写入 ⇒ 证明判据没把真到期也一起吞掉。
- `:325` / `:335` 的 `9999-01-01` / `9998-12-31` 是**成对**边界：前者证明「年份
  分支必要」（变异 I），后者证明「判据没过度收窄」。只有一侧会退化成同义
  反复，两侧齐备才锁得住。

## 四、确认的缺口（本次修的）

### 4.1 🔴 `src/jet-hub-rpc.ts`：qoder 家族特例分支漏回传 `windowDays`

**位置**：`if (isQoderFamily(req.provider))` 的短路分支，原为
`return { ok: true, value: { accounts: values } }`。

**机制**：同文件另两处都显式回传 —— `:6187` 查表分派段
`? { accounts: values, windowDays: buddyExpiringWindowDays() }`、
officeace 分支（`:5993`）。而 `plugin-src/client/credit-expiry.js` 的
`normalizeWindowDays(windowDays)` 对 `undefined` / `null` / `''` **一律返回 `null`**
⇒ `splitCreditsByExpiry` 拿不到窗口 ⇒ **面板上「永久 X · 长期 Y · 临期 Z」
那整行静默不渲染**（零报错、零日志）。

⇒ 结论：`usesExpiryWindow` 只是闸门的一半，**`windowDays` 是另一半**；特例
短路分支天然补不上通用逻辑，必须自己带上。已修为
`{ accounts: values, windowDays: buddyExpiringWindowDays() } satisfies RpcCreditsBalancesResponse`。

### 4.2 🟡 `tests/unit/balance-cache-wiring.spec.ts`：透传守卫只覆盖四家

**位置**：原 `:194` 的 `for (const id of ['buddy', 'workbuddy', 'lobsterai', 'trae'])`。

**实测（变异 G）**：把 `qoderFamilyExpiry` 的 `cachedBalance` 透传整段改成
恒 `true`（= 关掉透传）。⚠️ 该「无牙」观测是在**姊妹集成分支**上用**逐字相同**
的旧判据（`for (const id of ['buddy', 'workbuddy', 'lobsterai', 'trae'])`）跑出来的
（**74 passed 全绿**）—— 本分支的同一行文本完全相同，故结论成立；本分支上实测的是
**修完之后**的版本（变异 G ⇒ 1 条红，变异 J ⇒ 1 条红）。

**根因**：此后陆续接入透传的 `modelscope` / `autoclaw` / `autoclawintl` /
`qoder` / `qodercn` **都没进这张表** —— 它们当时全都零守卫。文件里直接调
`buddyExpiry(product, credential, cached)` 的那些用例证明原语**支持**共享读数，
但**完全绕过**了 `provider-expiry.ts` 的透传层；只有经 `createProviderExpiry()`
真实表驱动的用例才有牙。

**修法**：提出 describe 级常量 `CACHED_BALANCE_PROVIDERS`（列全 9 家），
用例标题改为「★★ 所有接了 `cachedBalance` 透传的渠道都必须真的透传（本表即清单）」，
并**遍历整张生产表**（不是只遍历本表）逐家探测 `cachedBalance` 是否真被调用：
登记过的家断言 `called === 1` 且原语立刻返回；未登记却调用了的家进
`unregistered` 并点名报红。⇒ 两个方向都有牙（变异 G / 变异 J）。

**附带的报错质量修复**：无闸门时漏透传会让原语真的去打上游（本机
`openapi.qoder.sh` 不可达 ~10.7s）⇒ 撞 vitest 5s 默认超时 ⇒ 报的是
「Test timed out in 5000ms」而不是「qoder 必须透传 cachedBalance」。
已加 2s 有界 `Promise.race`，失败直接给出**带渠道名的断言**。

### 4.3 🟡 `tests/unit/ratelimit-misreport-behavior.spec.ts`：缺 `fetch` 桩

**位置**：`describe('不得误伤：三种「不是全部限流」的情形')` 的三条阴性对照。

**症状**：本 PR 接上 `balance:` 之后，该组取号会真的走
`createCredentialResolver` 的 `kind: 'buddy'` 分档路径 ⇒
`fetchQoderCreditBalance` 真发请求 ⇒ 本机 `openapi.qoder.sh` 不可达 ⇒
各超时 ~10.3–10.7s。加 `--testTimeout=40000` 后**全绿** ⇒ **纯超时，判据本身是对的**。

**性质**：**测试基建没跟上生产接线**，不是生产缺陷；但不桩的话本文件在断网
机器上恒红（CI 里表现为 flaky）。已在**该 describe 内**补
`vi.stubGlobal('fetch', …)` + `afterEach(() => vi.unstubAllGlobals())`
（不能放文件级：同文件「端到端」那条自己塞了 `adapter.fetchImpl`，文件级桩会
改变它的时序前提）。

桩响应体用实测的真实报文形状（`userQuota.total = 0`、额度落在 `addOnQuota`），
并刻意让 `remaining` 非 0 —— 余额为 0 会让分档判 `none`，那三条就测不到
「正常取号」了。

## 五、明确**不是**缺陷的几点

| 观察 | 裁定 |
|---|---|
| `deductionEndTime` 不写 ⇒ 前端显示「长期」 | ✅ 正确。`formatPackageExpiry` 对 `null` 返回「长期」，而「不知道什么时候到期」与「永久」在本仓库的分桶语义里**同桶**（`splitBuddyCreditsByExpiry` 把缺 `deductionEndTime` 的包放 permanent 桶，保守方向） |
| 临期桶恒为 0 | ✅ **如实结果**。上游只给聚合标量；没有为了凑一档而编造日期。该限制写在断言标题里：`⚠️ 本家的临期桶恒为 0（上游不给逐包到期，如实记录代价）` |
| 锁定文案里没有任何天数 | ✅ **有意为之**。`qoderLockedError` 全文**不调用** `buddyExpiringWindowDays()` —— 因为无法确认哪些是临期，报「N 天内到期」会是假信息。这和 buddy 系各家（文案带天数）是**刻意的差异** |
| 断言「锁定后只剩永久 ⇒ tier = none」 | ✅ 这是**预期的拦截效果**：用 `buddyBalanceTier(entry, { allowPermanent: false })` 驱动生产判据（不是复述实现），落 `BUDDY_BALANCE_TIER.none` 且 `buddyTierUsable()` 为 false |
| `qoderLockedError` 是 Qoder 独有的构造器 | ✅ 与 `buddyLockedError` / `loomyLockedError` / `minimaxLockedError` **并列**，不共用；`qoder-lock-wiring.spec.ts:266`「锁定文案本家独有（不与 buddy 系共用）」守着这一点。对照：`src/index.ts` 里 buddy 系的 `${days} 天内到期` 文案与本家无关，边界正确 |
| `resolveQoderCredentialByRef` 用裸 `JSON.parse`（无 `as` 断言） | ✅ 有意。`BuddyBalanceSelector<BuddyProduct, BuddyCredential>` 的泛型默认值要求 `BuddyCredential`；加 `as QoderCredential` 会触发 `TS2322`。两处共用同一份解析器（零行为变更，逐字保留裸 parse） |

## 六、已知限制（如实记录）

1. **`dedicatedResourcePackages` 路径没有真实样本。** 本机两个账号该字段均为
   `undefined`，故「上游给了真实逐包 `expiresAt` 时临期桶会不会正确非 0」只在
   **构造报文**上验证过（`qoder-lock-wiring.spec.ts:325` / `:335` 的边界用例），
   没有真实报文佐证。
2. **国际版 `openapi.qoder.sh` 本机不可达**（`fetch failed` ~10.7s，两个账号
   都失败）⇒ 只测到「取不到 ⇒ 返回 `null` ⇒ `UNUSABLE`（保守剔除）」这一支，
   没有真实国际版报文的端到端验证。
3. **上游若改变哨兵形态**（例如改成 stream 那种 `expiresAt = -1`），本 PR 的
   判据（`>= 253402214400000` 或年份 `>= 9999`）**不会**把它识别成永久 —— 此时
   它会落进 `expiresAtMs > 0` 的失败分支 ⇒ 不写 `deductionEndTime` ⇒ 仍然落
   永久桶。**结论不变**，但判据的语义覆盖面没有实测支撑。
4. `model-catalog-parity.spec.ts` 的 `autoclawintl` 红是本机网络问题（已在干净
   基线上复现），**不属于本 PR 的验收范围**。

## 七、复核方式（可复现）

```bash
# 基线
pnpm typecheck && npx tsc -p tsconfig.tests.json --noEmit
npx vitest run                      # 389 passed / 1 failed（392 文件）

# 相关 spec（本审计的变异矩阵跑的就是这 9 个）
npx vitest run tests/unit/qoder-lock-wiring.spec.ts \
  tests/unit/provider-registry.spec.ts tests/unit/provider-registry-consumers.spec.ts \
  tests/unit/permanent-lock-execution.spec.ts tests/unit/buddy-permanent-lock.spec.ts \
  tests/unit/expiry-runtime-parity.spec.ts tests/unit/credits-runtime-parity.spec.ts \
  tests/unit/credits-capabilities.spec.ts tests/unit/permanent-lock-trae-lobsterai.spec.ts
# ⇒ 196 passed

# 变异（改一处 → 跑上面这组 → 应见红 → 还原）
#   A: provider-registry.ts  qoder 的 permanentLock: true  → false
#   B: provider-registry.ts  qoder 的 usesExpiryWindow: true → false
#   C: qoder-credits.ts:465  explicitUsable && !explicitIsPermanent → explicitUsable
#   D: index.ts:1810         reportPickedAccount: true → false
#   E: index.ts:1744         product: QODER → QODER_CN（两站互换）
#   F: aggregate-expiry.ts:251  WIRED_EXPIRY_PROVIDERS 删 'qoder'
#   G: provider-expiry.ts:271   context?.cachedBalance === undefined → true
#   H: index.ts:1891         qoderLockedError('Qoder (中国版)') → qoderLockedError('Qoder')
#   I: qoder-credits.ts:460  删掉 || getUTCFullYear() >= 9999
#   J: provider-expiry.ts    表里多挂一个未登记的透传户
```