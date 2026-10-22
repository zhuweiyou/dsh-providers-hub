# PR !131 + !119 + !123 合并审计与对抗性审计记录

- 审计分支：`pr131`（本地合并分支），起点 `78dc506`（master）
- 合并对象：**master** + Gitee **PR !131**（Qoder 三档分档 + 永久锁）+ **PR !119**（AStudio + MiniMax 分档）
  + **PR !123**（CodeArts 套餐周期转临期 + 赠送包拆到逐包）
- 审计方式：**4 路 subagent 并行**（分档核心判据 / 接线与分派 / 测试守卫真伪 / 对抗性前后端一致性）
  + 编排方独立复核 + 逐条变异验证
- 最终 HEAD：`0f5e521`（含第二轮审计修复），工作区干净
- 净改动（相对 master）：**45 文件 +6274 / −142**
- 全量基线：**9986 passed / 1 failed**（396 文件）
  - 唯一红**不是本次合并引入**，说明见 §六

## 一、结论摘要

| 维度 | 结论 |
|---|---|
| 三个 PR 的合并是否完整 | ✅ 四处「同改」集合全部齐备（见 §二） |
| 合并过程是否引入语义错误 | ✅ 有 **6 处**，全部在合并时被守卫当场抓住并修复（§四） |
| 三个 PR 自身是否有真缺陷 | ❌ 有 **7 处**（P1×4 / P2×3），全部已修（§五） |
| 测试守卫是否有假绿 | ❌ 有 **9 处**，已修 6 处、如实登记 3 处（§七） |
| 是否有不宜在本次修的 | ✅ 3 项登记不修；另 2 项已按用户指示修复（§八 / §八-bis） |

**一句话**：三个 PR 的**功能方向都对、核心判据也扎实**（前后端分桶在穷举穷尽测试下一致），
但存在 **1 个 P1 级共性问题**——「**只堵了一个入口**」：Qoder 的永久哨兵只挡住了
`deductionEndTime`，`expiredTime` 这个第二入口漏着；而三份新 spec 都只守「构造参数字面量」，
不守「注入闭包体内的实参」。这两类都是「**看起来接好了、实际有一半没接**」的形态。

## 二、合并完整性（四处同改）

「新渠道必须同时进四处」是本仓库已复发 7 次的陷阱。脚本比对（剥注释后抽字面量）：

```
WIRED_EXPIRY_PROVIDERS(17) == createProviderExpiry() keys(17) == 客户端 AGG_WIRED_CHANNEL_IDS(17)   ✓ 集合相等
WIRED(17) ⊆ AGGREGATE_CHANNELS(21)                                                                  ✓
AGGREGATE_CHANNELS 多出 4 家 = cline / gemini / opencode / raccoon（既有豁免）                        ✓ 语义自洽
5 个新增渠道逐个在位：qoder / qodercn / astudio / minimax / minimaxintl                              ✓
两站各占一项：qoder+qodercn、minimax+minimaxintl、autoclaw+autoclawintl                              ✓
```

补充两条口径区分（易混）：

- **`usesExpiryWindow`(13) ≠ `WIRED_EXPIRY_PROVIDERS`(17)**。前者决定「是否回传 `windowDays`」，
  后者决定「是否接入临期折算」。`13 ⊆ 17`，多出的 4 家（`accio`/`loomy`/`modelscope`/`zcode`）
  都是**不按到期分桶**的渠道 ⇒ 不回传 `windowDays` 是**正确**的。
- **决定聚合候选可见性的是 `WIRED_EXPIRY_PROVIDERS`，不是 `AGGREGATE_CHANNELS`** ——
  `AGGREGATE_CHANNELS` 只管模型层归并。两张表都对，但它们**职责不同**。

## 三、合并过程的 15 处冲突与 6 处合并磨损

`PR !119` 有 **15 处冲突**、`PR !123` 有 **3 处**。全部属于「两侧各自新增」的并集形态，
但其中 6 处**必须按语句/函数边界重建**，机械并集会坏：

| # | 位置 | 磨损形态 | 为什么机械并集会坏 |
|---|---|---|---|
| 1 | `src/aggregate-expiry.ts` | 三个折算原语（qoder / astudio+minimax）交织 | 冲突边界切在函数体中间 |
| 2 | `src/provider-expiry.ts` | 同上 + 两个 family 工厂共用一段收尾 | 两个函数签名共享同一段 `context.cachedBalance` 代码 |
| 3 | `src/index.ts` | **3 个 `lockedError` 文案函数**（qoder / astudio / minimax）的文档与函数体在 4 个块里交织 | 单纯并集会把 `qoderLockedError` 的函数体从中间截断（tsc 报 30+ 条 TS1109/TS1127） |
| 4 | `src/index.ts` | `registerAstudioLlm` 的选项块两侧各加一项（`accountPool` / `resolveCredential`） | **两者都要**，且 PR119 注释里「没有 accountPool」那句已失实 |
| 5 | `plugin-src/client/jet-hub.js` | `AGG_WIRED_CHANNEL_LABELS`（旧，手抄显示名）vs `AGG_WIRED_CHANNEL_IDS`（新，只存 id） | **不能取并集**：master 已重构为 id 形态，PR119 写的是旧形态；两个常量并存会让既有断言红 |
| 6 | 9 份 spec 的写死名单 | 数组字面量被冲突边界切断 | 5 处出现「一行里混进下半段数组 + 重复的 `const` 头」，其中 3 处 esbuild 直接报语法错 |

**教训（值得记）**：冲突块**不等于**语义边界。当两侧都在同一位置插入**完整的函数**或
**完整的多行数组**时，「取并集」会把语句切断 —— 必须先看清冲突块切在哪里，
再按 `/** ... */` / `const X = ` 这类**结构锚点**重组。本次 `src/index.ts` 修了两轮才正确
（第一轮起点锚点取到了 buddy 函数**体内**的注释，导致 qoder 成了 buddy 的局部名）。

## 四、合并过程中被守卫当场抓住的 6 处（合并引入 / 合并暴露）

| # | 问题 | 谁抓到的 | 处置 |
|---|---|---|---|
| 1 | `minimax` / `minimaxintl` 补了 `usesExpiryWindow` + `permanentLock` 但漏 `creditPackages` | `provider-registry.spec.ts` 的「从能力事实派生」守卫 | 补上（缺它 ⇒ 卡片有三档合计、看不到哪几笔构成） |
| 2 | `codearts` 同因同缺（PR !123 也只补了 `usesExpiryWindow`） | 同上 | 补上 |
| 3 | `CACHED_BALANCE_PROVIDERS` 表漏 astudio / minimax / minimaxintl | **PR !131 新加的「遍历整张表」那条腿**（旧形态下这三家零守卫） | 补上 |
| 4 | `credits-capabilities.spec.ts` 的 `SUPPORTED` 名单两侧各改 | 写死名单守卫 | 取并集（11 家） |
| 5 | `credit-expiry.spec.ts` 三处 `toEqual` 缺 `earliestExpiringAmount`（master 新增字段，PR123 写用例时还不存在） | 全等断言 | 补齐 |
| 6 | `supportsCreditPackageList` 的「一律为假」名单里 `codearts` 已不成立 | 同上 | 移出并说明 |

⚠️ 第 1、2 两处**正是 PR !131 自己在 PR 描述里反复强调的那个陷阱的变体**：
「补了能力位却漏了同一份数据的另一条腿」。守卫（从能力事实派生）比人可靠。

## 五、三个 PR 自身的真缺陷（7 处，全部已修）

### P1-1 Qoder 的永久哨兵只堵了一个入口（`e1d9bf1`）

PR !131 只对 `userQuota` 的数字 `expiresAt` 做哨兵识别，判定永久后**落到 `expiredTime`
字符串支路**，而**那条支路没有哨兵判据**。`dedicatedResourcePackages[].expiresAt` 正走它。

实测（构造报文）：

```
toPackage('专用资源包', {total:100,used:0,remaining:100},
          { expiredTime: '9999-12-31T00:00:00.000Z' })
  → deductionEndTime = 253402214400000
  → 前端 formatPackageExpiry = "9999-12-31（2912150 天后）"
```

两个后果：① 荒谬文案；② 该包落 **`longTerm`** 而非 `permanent`，而 `longTerm` 在**锁定永久
积分时仍可选** ⇒ **「锁住的永久积分」在这一路径上照样被烧，锁定形同虚设**。

修法：抽出 `isPermanentSentinelMs(ms)` 纯判据（含「UTC 年份 >= 9999」兜底，覆盖
`9999-01-01`~`9999-12-30`），**两条支路共用**。

### P1-2 上一条修复**不完整**：`expiredTime` 仍留原串（`1e1b6bb`）

`packageExpiryMs()` 是**两段回落**：先 `deductionEndTime`、读不到再 `expiredTime`。
所以即使 `deductionEndTime` 被清空，只要 `expiredTime` 留着原串，tooltip 照样渲染哨兵日期：

```
{ deductionEndTime: undefined, expiredTime: '9999-12-31T00:00:00.000Z' }
→ packageExpiryMs = 253402214400000
→ formatPackageExpiry = "9999-12-31（2912150 天后）"
```

分桶是对的（`permanent`，锁定会拦），但**三档行说「永久」、hover 说「9999-12-31 到期」**
—— 同一个包两句话互相矛盾。修法：哨兵命中时**连 `expiredTime` 一起清空**
（同一份判据的两个出口）。

### P1-3 AStudio `reportPickedAccount: false` 让 `reportAccount` 成死接线（`23a693d`）

PR !119 的理由是「与 buddy 系一致：本家旧闭包也没有回报」。**那是类比错误**：

- buddy 系能写 `false`，是因为它们的**适配器自己回报**（`buddy-adapter.ts` /
  `trae-adapter.ts` / `lobsterai-adapter.ts` 都调 `reportLedgerAccount`）；
- **AStudio 适配器全文零回报**（grep 实测 0 处），且 master 上它根本没有 `reportAccount` 接线
  ⇒「旧闭包也没有回报」描述的是**一个缺陷状态**，不是有意行为。

`credential-resolver.ts` 三条回报点，`false` 时一条都走不到：① 免费短路 —— astudio 无
`isFreeModel`，不进；② 分档选中 `:388` —— 被 `!== false` 拦住；③ 池选号 `:454` —— ②里
`return picked.credential` 已返回。

实测（`lib/credential-resolver.js` 真跑，`getAvailableAccount` 设成「被调用就记标记」）：

```
reportPickedAccount=false     → cred=true reports=[]     poolReached=false
reportPickedAccount=true      → cred=true reports=["a1"] poolReached=false
reportPickedAccount=undefined → cred=true reports=["a1"] poolReached=false
```

⇒ `false` 时**零回报** ⇒ `token-ledger.ts` 拿不到 `accountId` ⇒ 整笔用量归到 `'-'`（未归属）
桶 ⇒ AStudio 账号卡片**看不到自己的 token 用量**。零报错、零日志。

修法：改 `true`（master 上 astudio 单凭据、从未回报 ⇒ **纯增益**，无旧闭包要保真）。

### P1-4 两条锁定文案与代码行为**相反**（`e1bb25a`）

| 文案 | 声称 | 代码实际 |
|---|---|---|
| Qoder `exhausted` | 「上游**只下发聚合额度、不给逐包到期时刻**」+「等临期积分到期…会让用户**白等**（本家根本没有那个临期池）」 | `qoder-credits.ts` **确实**解析 `dedicatedResourcePackages[].expiresAt` 并写进 `deductionEndTime` ⇒ 该包的到期日到了窗口内，账号**会自动恢复可用** ⇒「白等」说反了 |
| AStudio `exhausted` | 「所有账号的『N 天内到期』积分（**赠送/活动积分**池）都已用尽。**会员积分与购买积分通常是长期有效的**」 | 三池（会员/购买/赠送）**同等**走 `pushPool`，各自把 `{member,buy,activity}NextExpireTime` 归一到 `deductionEndTime` ⇒ **任何一池**有窗口内到期都进临期桶 |

实测反例（AStudio）：`{memberBalance:800, memberNextExpireTime: NOW+4d, buyBalance:1000,
buyNextExpireTime:null, activityBalance:0}` → `split={expiring:800, permanent:1000}`
—— 临期 800 **全部来自会员池**，赠送池一分没有 ⇒ 用户按旧文案去查赠送池一无所获。

**两处同根**：把「**本机样本**恰好是 `undefined`/`null`」（样本偶然）写成了
「**上游从不**下发 / **通常**长期有效」（通用前提）。这是本仓库反复登记的那类错误。

### P2-1 前后端「数字字符串 `deductionEndTime`」判据不同（`1e1b6bb`）

| 输入 | 前端 `splitCreditsByExpiry` | 后端（旧） |
|---|---|---|
| `1760432000000`（number） | 临期 | 临期 |
| `"1760432000000"`（字符串） | **临期**（`Number()`） | **永久**（`typeof`）|

⇒ 症状正是本仓库反复要防的：**面板说「临期 100」，而锁定永久积分时选号判 `none`、
报「积分已用尽」**。这是全仓**唯一**一处真正的「同一语义两套判据」。

**可达性如实标注：低但非零** —— 三个 PR 新接的 provider 都在写该字段前经
`Number()`/`Date.parse` 归一化，生产主路径不可达；可达的是外部写进 `credits.balances`
的数据（旧缓存 / 备份导入 / 手工编辑 state.json）。

修法：后端改 `Number()`（与前端同源，方向保守），**保留 `> 0`**
（`Number(null)===0`、`Number('')===0`，只看 `isFinite` 会把它们当成「时刻 0」）。

### P2-2 `packages` 含 `null` 时后端抛裸 TypeError（`1e1b6bb`）

前端第一句是 `if (!pkg || pkg.active !== true) continue`，后端直接读 `pkg.active`
⇒ `packages: [null]` 抛 `Cannot read properties of null`。该异常穿出
`BuddyBalanceSelector.select`（无 try/catch），用户看到内部错误而池里可能还有健康账号。

**可达性：当前不可达**（各 provider 都在 push 前过滤非对象），属防御缺口 + 两侧不对称。

### P2-3 MiniMax 注释承诺「绝不填 0」，代码原样透传 0 / 负数

`minimax-credits.ts` 注释：「解析不出就**不写这个键**…绝不填 0（0 会被判成『服务端未下发』）」，
而代码 `...expires === undefined ? {} : { deductionEndTime: expires }` ——
`finiteNumber(0)` 返回 `0`、`finiteNumber(-1)` 返回 `-1`。

分桶结果没错（`0`/`-1` 都被 `end > 0` 挡进永久桶），但 `expiredTime` 会渲染成
`1970-01-01`，且**注释与代码不符**。→ **登记不修**（见 §八）。

## 六、全量测试的 3 条红（均非本次引入）

| 失败 | 性质 | 证据 |
|---|---|---|
| `repo-pii-guard`「入库文本文件里没有完整 11 位手机号」 | **master 基线**：`!130` 把真实手机号写进 `src/openai-gateway/tencent-fingerprint.ts:255` | `git show master:...` 含该号；干净 master 上同样红 |
| `jet-hub-styles-ownership`「宿主真身可定位时可被读出」 | **环境相关**：读已安装的 DSH 宿主产物，断言其 `factory` 后调 `claimStyles(ownerId)`；当前 DSH 版本产物里没有该形态 | 干净 master 上同样红；单跑稳定红 |
| `openai-gateway-server`「超出上限很多倍时同样拿得到 413」 | **并发 flaky** | 单文件重跑 **28/28 passed**；全量并发跑时偶现 |

⚠️ 关于 `repo-pii-guard` 的一条**审计纪律记录**：subagent 初版用裸 `grep` 扫出「113 处命中」，
而守卫自己的判据（`tests/` 整个目录豁免 + 7 个构造示例白名单）算出的是 **1 处**。
**复核一个守卫时必须复用它的判据（含白名单/豁免）**，否则得到的是「grep 的命中数」
而非「守卫的命中数」。

## 七、测试守卫的假绿（9 处）

三份新 spec（`qoder-lock-wiring` 532 行 / `astudio-lock-wiring` / `minimax-lock-wiring`）
与本批改动的既有 spec 共发现 **9 处无牙**。已修 6、如实登记 3。

### 已修

| # | 位置 | 无牙形态 | 变异证据（修复前 → 后） |
|---|---|---|---|
| 1 | `qoder-lock-wiring`「两站都接限流判定」 | **全局** `toMatch(/throwIfAllRateLimited:/)`，而 `index.ts` 有 **16 处** | 删中国版 / 国际站各一次：**两次全绿** → 各红 1 条且点名 |
| 2 | `minimax-lock-wiring`「两站 reportPickedAccount: true」 | 全局出现次数 `>= 2`（全局有 **4 处** true） | 国际站改 false 后仍有 3 处 ⇒ **全绿** → 红 1 条 |
| 3 | `minimax-lock-wiring` 同上「反向对照」 | 切片 `slice(start, indexOf('product: MINIMAX')+400)` 实测 **443 字符，既不含 true 也不含 false** | 在**根本不含该字段**的区间上断言 `not.toMatch` ⇒ 恒真 |
| 4 | `permanent-lock-execution` 的 `drives`（5 个 `index.ts` 项） | 裸 `readFileSync(module).includes(drives)`，而符号在那里**既有定义又有使用** | 删 `lockedError: astudioLockedError('AStudio')` / 整段删 `balance` 块 / selector 换假实现：**三重变异全绿** → 加 `anchor` 后全红 |
| 5 | 三份 spec 的 `fetchBalance:` 闭包 | 只守「构造参数字面量」，**不守闭包体内实参** | qoder 写死 `QODER_CN` / minimax 写死 `MINIMAX_INTL` / astudio 换 `async()=>null`：**三次全绿** → 各红 1 条 |
| 6 | `astudio-lock-wiring` 星火池 | 夹具恒 `sparkTotalBalance: 0` ⇒ 那 12 行是**死代码区间** | 删 `sparkDeductionEndTime` 那行：**13 条全绿** → 红 |

**结构性教训（已写进代码注释）**：三份 spec 都在守「**构造参数字面量**」
（`product:` / `selector:` / `lockedError:`），而**没有一份**守「**注入闭包体内的实参**」。
`BuddyBalanceSelector.select` 调的是 `injected(credential, this.deps.product)` ⇒
闭包里忽略形参、写死站点常量就会打到**对方站点**（余额恒 `null` ⇒ 未锁定时换号优化失效、
锁定时永远「没有可用账号」，零报错）。而这正是 `qoder-lock-wiring` 文件头**逐字警告**的那件事。

⇒ **凡「配置 + 闭包」双入口的接线，判据必须两条腿都切，且都要 `block.length` 自检**
（切片被切成空 ⇒ 断言变同义反复，这是本次两次踩到的形态）。

### 如实登记（不修，附理由）

| # | 位置 | 无牙形态 | 为什么不修 |
|---|---|---|---|
| 7 | `astudioLocalTimeMs` 的 `replace(' ', 'T')` | 全部夹具只喂 `T` 形态 ⇒ 删掉 109 条全绿 | **当前 V8 对空格形态非常宽容**（实测 `Date.parse('2026-11-20 01:50:14') === Date.parse('2026-11-20T01:50:14')`，连多空格都认）⇒ 该行在当前引擎上**是冗余的**，删掉也不会坏。**不为它编恒真用例**（本仓库红线）；改为补「两形态等价」的**契约**断言 + 在源码注释里写明「前向防御，非现存缺陷修复」 |
| 8 | `qoder-lock-wiring` 的支路 B（`expIsPermanent`） | `REAL_USAGE` 无 `dedicatedResourcePackages` ⇒ 该 spec 永远走不到支路 B（改 `false` 后 22 条全绿） | **不是真缺陷**：该支路由 `qoder-credits.spec.ts` 的 3 条守着（`e1d9bf1`）。只是与该 spec 文件头自述的「三层判据（第 3 层驱动生产解析器）」不符 —— 第 3 层对这一支路是空的。已在此登记 |
| 9 | `astudio-lock-wiring` 标题「窗口天数…（可用环境变量覆盖）」 | 函数体只断言常量；废掉 `buddyExpiringWindowDays` 的 env，三份 spec 38 条全绿 | env 覆盖由 `permanent-lock-execution` 的 ⑥ 真守（设 `DSH_BUDDY_EXPIRING_WINDOW_DAYS=31` 断言读到 31）⇒ 是**标题超发**而非零守卫。已把标题改成如实描述 |

## 八、登记不修的 3 项（附可核实理由）

### 1. 已过期包计入 `expiring`（P2，语义缺陷）

两侧一致（故不是「不一致缺陷」）：`end < now && active: true` 的包会被计入临期桶。
可达性成立 —— **四个 provider 的 `active` 都是硬编码 `true`**：Qoder（`options.active ?? true`）、
CodeArts、TRAE、MiniMax。端到端实测：

```
TRAE：500 已过期 10 天 + 300 真实 5 天后到期
  → split = {expiring:800, permanent:0}    ← 800 里 500 已作废
  → 卡片显示「临期 800（5 天 0 小时）」     ← 数字虚高 500
  → 锁定态判「可用」⇒ 选号会选它 ⇒ 上游必然失败一次
```

**为什么不在本次修**：
- 改成 `permanent` **更糟** —— 会让锁定永久积分**反而允许**烧这笔已作废的钱；
- 正确修法是「过期 ⇒ 既不计 expiring 也不计 permanent（单独一档或直接剔除）」，
  要动 `BuddyCreditSplit` 的形状 + 前后端两侧 ⇒ 是一次语义扩展，不该在合并审计里捎带；
- 且**现行守卫把这个缺陷锁住了**：`credit-expiry.spec.ts` 的对账断言要求前后端一致，
  谁先改语义谁变红 —— 修的时候必须两侧同步 + 连带改那条对账用例。

**自洽性说明**：已过期包**不进倒计时**（`if (end > at)` 那条 2026-10-13 修正仍在），
所以它只污染**选号优先级与三档合计**，不污染 `earliestExpiringAt`。

### 2. AStudio 展示日期比上游原文早一天（P2，展示口径）

```
上游原文（本地时间串）    = "2026-11-20T01:50:14"
Date.parse（本机 Asia/Shanghai 解释）= 2026-11-19T17:50:14Z
formatPackageExpiry 用 .toISOString().slice(0,10) ⇒ 取 **UTC 日期**
实测展示                  = "2026-11-19（30 天后）"   ← 比原文早一天
```

只要到期时刻落在北京时间凌晨 0:00–7:59，展示日期就比上游原文早一天 ——
而**上游实测样本恰好是 `01:50:14`（凌晨）**，本机样本就会踩中。

**为什么不修**：`formatPackageExpiry` 是**所有 provider 共用**的显示函数，改它影响面极大
（buddy / trae / lobsterai / qoder / minimax… 全部受影响），而这是一次**展示口径变更**，
需要产品决策。已在源码注释登记。

### 3. `astudioLocalTimeMs` 的**服务端时区未验证**

`Date.parse` 对不带偏移的串按**本机时区**解释 —— 这只解决「我们怎么解释」，
**没有**证明「本机时区 == 服务端时区」。实测样本 `"2026-11-20T01:50:14"` 在
`aggregate-expiry.ts` / `aggregate-adapter.ts` / `src/index.ts` 三处注释里被抄用，
却**没有任何一处记录采集时的机器时区**；e2e 探针也只 `console.log` 原始报文。

三种候选做法（按本机 / 固定 `+08:00` / 要求上游带偏移）**都是猜**，违反「绝不编造」红线
⇒ **保持既有行为 + 如实登记**，并写明取证方式（同一账号同时看官方客户端显示的到期日
与本函数算出的日期，且**在两台不同时区的机器上各做一次**）。

### 4. autoclaw 两站的 `permanentLock` 缺口 —— **✅ 已按用户指示补齐（`0172bf7`）**

`autoclaw-credits.ts` 明确写着「**无到期字段的发放**（活动赠送的永久分）⇒ 不带
`deductionEndTime`（= 永久桶）」⇒ 本家**确实有**永久桶。补之前 `permanentLock` 未登记
⇒ 按钮不渲染（不会出假开关，最坏是**功能缺失**）。

**为什么当时没只加一行 registry**：autoclaw 的 `resolveCredential` 走**纯池选号**
（没有 `balance` 计划）⇒ `credential-resolver.ts` 的 `allowPermanent` 读不到
⇒ **加了会立刻变成假开关**（按钮在、点了不拦）。补齐需要四处同改。

**用户指示「补锁定开关」后的实际改动**（`0172bf7`）：

| # | 位置 | 改动 |
|---|---|---|
| 1 | `provider-registry.ts` | 两站各加 `permanentLock: true` |
| 2 | `index.ts` | 抽出共用 `resolveAutoclawCredentialByRef`（原先两站各一份**逐字重复**的内联 `JSON.parse`）；新建两个选号器；两站各接 `balance` 计划 |
| 3 | `index.ts` | 新增 `autoclawLockedError` 四档文案（池名按本家「钱包流水批次 / 永久桶」写） |
| 4 | `tests/unit/autoclaw-lock-wiring.spec.ts` | 新建，13 条三层判据 |

⚠️ **与 buddy 系取舍不同源**（最易照抄错）：本家 `rateLimit: false`、刻意不做请求级
换号 ⇒ 锁定只作用于「按余额分档选号」这一层。

变异验证：删掉中国版的 `balance` 块 ⇒ **4 条红**（接线层全部命中）；还原后 13 passed。

## 八-bis、master 自带的 PII 泄漏 —— **✅ 已按用户指示修复（`0172bf7`）**

`!130` 把真实手机号写进 `src/openai-gateway/tencent-fingerprint.ts:255` 的注释。
改成「账号 A」（与守卫文件头要求的措辞一致）⇒ `repo-pii-guard` 由
**1 failed → 3 passed**（含扫描面自检）。

## 九、方法论教训（五条，全部本次实测）

1. **`lib/` 陈旧会让你「跑通一个不存在的验证」**：用 `node` 直接 import `lib/*.js`
   做端到端对账时，若 `lib/` 是旧产物，源码里的新判据**根本不参与**。
   实测：PR !123 给 `splitBuddyCreditsByExpiry` 加了 `expiringRemaining`，而
   `lib/buddy-balance-rank.js` 里该符号 **0 处**（源码 3 处）⇒ 那次「前后端逐分一致」
   的 5 组对账全跑在旧实现上，第一组直接给出 `2500 vs 500` 的**假不一致**，
   差点被当成真缺陷。⇒ **凡是走 `lib/` 的验证，先 `pnpm build`**；更稳的是让
   vitest 直接 import `src/`（单测本来就那样）。已写进 `AGENTS.md`。

2. **「全红」和「全绿」一样需要先证明工具有牙**：subagent 的变异脚本用
   `execFileSync('npx', …)`，Windows 上 `npx` **ENOENT** ⇒ 每一条变异都「变红」（18 个假红）。
   是「19 条全红且 summary 为空」太整齐才被识破。⇒ **变异脚本必须有控制组**
   （只改注释的变异必须 STILL-GREEN）。

3. **冲突块 ≠ 语义边界**（见 §三）。取并集前先看清冲突块切在哪里。

4. **复核守卫必须复用守卫自己的判据**（含白名单/豁免），不能用更宽的独立 grep 代替
   —— 否则得到的是「grep 的命中数」而非「守卫的命中数」（113 vs 1）。

5. **切片判据必须有长度自检**：本次两次踩到「区间被切成空 ⇒ 断言变同义反复」
   （`\n  }` / `'},'` 在带缩进大括号的箭头函数体内提前命中）。
   ⇒ 所有 `slice(x, indexOf(锚点))` 之后都要 `expect(block.length).toBeGreaterThan(N)`。

## 十、最终验证

```
npx tsc -p tsconfig.json --noEmit        → exit 0
npx tsc -p tsconfig.tests.json --noEmit  → exit 0
npx vitest run --testTimeout=40000       → 9966 passed / 3 failed（395 文件）
                                           唯一红为环境相关，见 §六
git status --short                       → 空（干净）
```

## 十一、提交清单（本次审计产出 9 个提交）

| 提交 | 内容 |
|---|---|
| `8d77776` | Merge master |
| `7eae663` | Merge PR !119 |
| `471bb61` | Merge PR !123 |
| `e1d9bf1` | **fix**：Qoder `dedicatedResourcePackages` 哨兵拦截（P1-1） |
| `8cdf919` | docs：登记 astudio 时区未验证 |
| `8baab14` | docs(AGENTS)：`lib/` 陈旧陷阱 |
| `23a693d` | **fix**：astudio `reportPickedAccount` 死接线（P1-3） |
| `6d7f12d` | test：`reportPickedAccount` 守卫 + `anchor` 带牙锚点 |
| `96e64ca` | docs：登记 autoclaw 的 `permanentLock` 缺口 |
| `1e1b6bb` | **fix**：`expiredTime` 哨兵泄漏 + 前后端两处判据不一致（P1-2 / P2-1 / P2-2） |
| `e1bb25a` | **fix**：Qoder / AStudio 锁定文案与代码相反（P1-4） |
| `509f2ff` | test：补 `fetchBalance` 闭包 / 星火池 / 空格形态三处零覆盖 + 修两条全局断言 |
| `88f4899` | docs：本审计报告 |
| `0172bf7` | **feat**：autoclaw 两站补永久锁开关（四层同改）+ **fix** master 的 PII 泄漏 |

每个修复提交都附**变异验证证据**（修复前全绿 / 修复后红且点名），且都做了**还原自证**。

## 十二、用户对审计结论的三项裁决（2026-10-21）

| # | 审计项 | 用户指示 | 结果 |
|---|---|---|---|
| 1 | `repo-pii-guard` 的 PII 泄漏（master `!130` 引入） | **「帮他改」** | ✅ 已修 `0172bf7`，守卫 1 failed → 3 passed |
| 2 | 已过期包计入 `expiring` | **「可以」**（接受登记不修） | ✅ 保持登记，理由见 §八-1 |
| 3 | autoclaw 两站缺 `permanentLock` | **「补锁定开关」** | ✅ 已补 `0172bf7`（四处同改 + 13 条守卫 + 变异验证） |

⚠️ 第 3 项的关键教训：**「补开关」不是加一行 registry**。registry 只让按钮渲染，
真正的拦截在 `credential-resolver.ts` 读 `allowPermanent`，而它只在 `balance` 计划
存在时才被求值 ⇒ 只加 registry 会立刻造出**假开关**（按钮在、点了不拦），
比「没有按钮」更糟。本次四处同改（registry + 选号器 + 文案 + 守卫）缺一不可。

## 十三、第二轮审计（针对本轮修复本身）

第一轮修了 7 处缺陷 + 6 处假绿。**修 bug 的代码最容易引入新 bug**，故对修复本身再启动一轮
4 路 subagent 审计（生产代码修复 / 新守卫真伪 / autoclaw 新功能对抗 / 文档声称一致性）。
**本轮又查出 4 处真缺陷 + 3 处文档失真，全部已修。**

### 十三-1 真缺陷（4 处）

| # | 缺陷 | 严重度 | 修法 | 提交 |
|---|---|---|---|---|
| R2-1 | **`Number()` 的两格类型污染**：`Number(true)===1`、`Number([ms])===ms` ⇒ `true` 被判「1970 年就过期」⇒ 进 `expiring` 桶 ⇒ **锁定时该号仍可选**（可能烧掉本该保护的长久积分） | P2（生产不可达，但方向不保守） | 判据收窄为「只接受 `number` 或 `string`」；修复后 16 格逐格复测，**翻转数 2 → 1**（剩下的正是那条有意变更） | `1917cf4` |
| R2-2 | **流水降级被谎报成「积分都已用尽」**：`fetchAutoclawBalanceDetailed` 在流水失败/守恒不成立时**静默回退钱包包**（无 `deductionEndTime`）⇒ 被算进永久桶 ⇒ 锁定下报 `exhausted` ⇒ **把用户推向不可撤回的解锁** | **P1** | `CreditBalance.degraded` 标记 + `noAccountReason` 把降级与失败同等对待（归 `unknown`） | `e3b75f1` |
| R2-3 | **降级结果走 60 秒长 TTL**：`ok:true` + `degraded:true` 是瞬态不确定性，却按成功读数缓存 ⇒ 一次流水抖动 = 60 秒内持续报错 | P2 | 降级与失败同等对待，走 `errorTtlMs`（5s）⇒ 抖动一过即自愈 | `3cba16c` |
| R2-4 | **锁定文案点名未实测的池名**：「活动赠送」「注册奖励」**没有任何实测来源**，是编的（真实包名是「`AutoClaw 用户登录奖励积分，7天有效`」这类上游原样字符串） | **P1**（文案失实） | 文案不再点名具体池名，改述**判据本身**（「流水里不带到期时间的那些发放」） | `2f1e7ce` |

#### R2-2 的可复现证据（同一账号、同一 5000 余额，**只改流水端点是否 500**）

```
流水正常 → split={expiring:5000} tier=expiring  select=ok         ✅
流水 500 → split={permanent:5000} tier=none      select=exhausted  ❌ 修前
流水 500 → degraded=true                          select=unknown    ✅ 修后
```

根因链：`autoclaw-credits.ts` 的 `catch {}`（流水失败静默回退）+ 守恒校验（不成立也静默回退）
⇒ 回退路径产出「无 `deductionEndTime`」的包 ⇒ `splitBuddyCreditsByExpiry` 判永久桶 ⇒
锁定分支读成「用户只剩永久积分」。**这是「数据缺失」伪装成「数据是 0」的路径**，
正是 `BuddyNoAccountReason` 四档设计要防的那种误报。

#### R2-4 的五层转述链（值得单独记）

```
autoclaw-credits.ts:264 注释（描述代码分支：「无到期字段的发放（活动赠送的永久分）」）
  → registry 注释「本家确实有永久桶」
  → 审计报告「本家确实有永久桶」
  → 提交信息「用户钱包里确实可能有一笔永不作废的积分」
  → autoclawLockedError 文案「永久桶（「活动赠送」「注册奖励」…）」
```

**第一层就已经把「代码允许」写成了「上游会发」**，之后层层放大。
`git log -S "活动赠送"` 4 个提交，全部同一条注释链，**从未有一次报文支撑**。

### 十三-2 文档失真（3 处，全部是「绝对性声称没做全仓清点」）

| # | 失真 | 实际 | 提交 |
|---|---|---|---|
| R2-5 | 「**两个**渠道把上游串原样透传到 `expiredTime`」 | **6 处**（漏了 `jet-hub-rpc.ts` 的 officeace 与 `provider-credits.ts` 两处）| `d37053c` |
| R2-6 | 「这是全仓**唯一**一处同义双判据」 | 还有多处 `Date.parse` 型（`astudioLocalTimeMs` vs `packageExpiryMs`、`credits.ts` 的失效判定、`buddy.ts`/`cline.ts`/`codearts-credits.ts`）⇒ 改为「**前后端分档对账这条链路上**唯一一处」| `cc06489` |
| R2-7 | 「`unknown` 档 `QUOTA_EXCEEDED` + 请重试」被指为自相矛盾 | 它是**全仓既有口径**（buddy/qoder/astudio/minimax/autoclaw 五家一致，只有 loomy 用 `TRANSPORT`）⇒ 归「既有缺口」，登记不修 | `c2b918a` |

**教训（与第一轮 §九-4 同源）**：「唯一」「两个」「从不」这类**绝对断言必须先全仓清点**，
不能凭本轮改到的范围下结论。这三次失真里有两次是我在**同一轮里新写**的注释 ——
「刚查过的东西最容易被当成查全了」。

### 十三-3 新增的架构性缺口登记（`c6587df`）

`packageExpiryMs` 的 `expiredTime` **兜底路径不认永久哨兵** —— 我修 Qoder 时只清了
**这一家**的 `expiredTime`，但该兜底路径是**所有渠道共用**的。实测：
`{ expiredTime: '9999-12-31T00:00:00.000Z' }` → 渲染「9999-12-31（2912150 天后）」。

全仓清点后**5 处**来自上游原样串（astudio 星火池 / lobsterai / jet-hub-rpc 的 officeace /
provider-credits 两处），3 处从已归一的 `deductionEndTime` 反推（codearts / minimax / qoder）。

⚠️ **本段初版写的是「6 处」—— 又一次漏数**（把 provider-credits 的两处记成三处）。
这是本轮**第二次**在同一类数字上出错（第一次见 §十三-2 的 R2-5），说明
「我刚才查过了」不等于「我查全了」——**数字必须在报告定稿前再 grep 一遍**。

**当前不可达**（那几家上游实测都不发 9999 哨兵）⇒ 前向防御缺口，**登记不修**：
改 `packageExpiryMs` 会改变**所有**渠道的展示语义，而「遥远处到期」在别家可能是真实的。
正确修法是在**写入点各自过滤**。

### 十三-4 autoclaw 永久桶的**前提未验证**（重要，如实标注）

`0172bf7` 补锁定功能的立论前提是「本家钱包里存在**不带 `wallet_expires_at`** 的永久积分批次」。

**仓库内没有任何实测证据支持该形态存在，且唯一的相关实测反向指向它不存在：**

| 查证面 | 结果 |
|---|---|
| `5fbe7ab` commit message（仓库内**唯一**一次流水字段完整性实测） | 「每笔发放**带** `wallet_expires_at`。**实测 28/28 全带值**」⇒ 永久桶样本数 **0** |
| `e2a850d` 真机取证的 5 个批次 | **全部带到期日**（19456→10/24、200 每日签到→10/24、500→10/25、500→10/26、200→10/26） |
| `docs/agent-notes/providers-autoclaw.md` | 全文 203 行，**无一句**提到观测到无到期字段的发放 |
| PR 引用的 `scripts/probe-autoclaw-expiry.mjs` | **仓库里不存在**（该笔记已明确「不得当作实测证据」）|
| `tests/unit/autoclaw-credits.spec.ts` 的 fixture | 带 `wallet_expires_at` 是实测形状；「无到期 ⇒ 永久桶」那几条全是**手写对象**，文件头自陈「形状示例，不是可复核的真机取证」|

⇒ **准确表述：结构上可达、零实测，且现有唯一实测方向否定。**

**后果（如实）**：若上游确实恒带到期字段，则本家永久桶**恒为空** ⇒
`allowPermanent` 为 true/false 行为完全相同 ⇒ 这个开关**永不产生实际效果**
（但**也不会出错** —— 它只是把已存在的分档能力接上，与仓库 11 家同构；
且 R2-2/R2-3 的降级修复让它在「明细不可达」时也能正确报 `unknown` 而非误报）。

⚠️ **绝不得据此声称「本家确实有永久桶」**。已在 `provider-registry.ts` 与
`index.ts` 选号器注释里如实标注这一段（把「确实有」改成「代码分支存在但零实测」）。

**可反驳的验证方法（成本极低，一条命令）**：拿任意真实账号调
```
GET /agent-assetmgr/api/v1/ledgers_std?asset_type=point&wallet_type=all&page_size=100&flow_direction=all
```
检查是否存在 `mutation_type === 'credit' && (wallet_expires_at 缺失 || === 0)` 的条目：
**有** ⇒ 前提成立，锁定功能有效；**没有** ⇒ 该开关应标注为「当前无实际效果」。

### 十三-5 第二轮已排除 / 已登记的项

| 项 | 结论 |
|---|---|
| 13 家 `permanentLock` 是否都有执行路径 | ✅ 全部有（11 家 `balance` 计划、loomy `kind:'loomy'`、officeace `credentialProvider`）—— **无假开关** |
| autoclaw 两站 product 是否传对 | ✅ 抓真实 URL 确认：`autoclaw` → `autoglm-acceleration-api.zhipuai.cn`；`autoclawintl` → `autoglm-api.autoglm.ai`（互不串站）|
| 锁定是否按 provider 隔离 | ✅ 锁 `autoclaw` 时 `autoclawintl` 照常可用 |
| 穷尽性守卫是否有牙 | ✅ 加一档 ⇒ `tsc` 报 **5 个 TS2322**（正好五个 `lockedError`）|
| `resolveAutoclawCredentialByRef` 抽取有无行为变更 | ✅ **逐字比对确认零变更**（旧的一直是裸 `JSON.parse`、无形状校验）|
| D5：`unknown` 档写死「24h」 | ✅ **可接受**（是 JWT 规格常量，不随 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 变）；登记不修 |
| 前后端分桶穷举对齐 | ✅ 审计员独立跑 17820 组组合**零差异** |

### 十三-6 第二轮过程事故（如实登记）

⚠️ **一个审计员在主工作区做变异并留下未还原的坏状态**：
`fetchBalance: (credential, QODER_CN) => fetchQoderCreditBalance(credential, product)`
（形参改名但函数体还用 `product`）⇒ 编译期就过不了。我两次 `git checkout --` 还原、
并中断该审计员后才稳定。**差点被 `git add -A` 一起提交。**

⇒ 教训：**并行审计必须一开始就强制隔离 worktree**；`git add -A` 在多人/多 agent 场景下
是有风险的（应 `git add <具体文件>` 或提交前 `git status` 复核）。

⚠️ 另一条：两个 subagent **异常退出无收尾消息**（一个 `failed`、一个被中断），
意味着「4 路审计全部收口」这件事**没有完全做到** —— 未收口的项我在本轮已独立补验
（见 §十三-5 那七项），但**这是有缺口的一次审计**，如实记录。

### 十三-7 第二轮修复的 9 个提交

| 提交 | 内容 |
|---|---|
| `c6587df` | docs：登记 `packageExpiryMs` 的 `expiredTime` 兜底不认哨兵（架构性缺口） |
| `d37053c` | docs：修正「两个渠道」漏数为完整清点（6 处） |
| `cc06489` | docs：修正「全仓唯一」的过度声称 |
| `1917cf4` | **fix**：挡住 `Number()` 的两格类型污染（`true` / 单元素数组） |
| `c2b918a` | docs：登记 `unknown` 档「`QUOTA_EXCEEDED` + 请重试」的全仓既有矛盾 |
| `e3b75f1` | **fix**：流水降级不得谎报「积分都已用尽」（P1） |
| `2f1e7ce` | **fix**：锁定文案不得点名未实测的池名（P1） |
| `3cba16c` | **fix**：降级结果走短 TTL（5s）而非长 TTL（60s） |
| `0f5e521` | **fix**：订正 `zai_glm-5.3-flash` 的 `isFree` 失实标记（P1） |

每个修复都附**变异验证**（修复前全绿 / 修复后红且点名，含还原自证）。
