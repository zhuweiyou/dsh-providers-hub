# Gitee PR !135 / !136 / !137 / !138 合并审计记录

- 合并基线：`b0940ca`（= `origin/master`，2026-10-21 15:07 推送的那个）
- 四个合并提交：`4ed3683`(!!135) / `6d7cd13`(!136) / `3590bb9`(!137) / `b2f518d`(!138)（**均无冲突**）
- 合并后基线：`pnpm test` = **10151 passed / 0 failed**（403 文件），`typecheck` / `typecheck:tests` 干净
- 审计方法：**5 路 subagent 并行**（4 个 PR 专项 + 1 路跨 PR 对抗审计），共 **30+ 条变异验证**
- 修复提交：`cae7c7b` ｜ 修复后 `pnpm test` = **10155 passed / 0 failed**

> ⚠️ **读审计报告时的第一条纪律**：四个 PR 里 **!135 / !136 / !137 的分支点是 `651dac3`**
> （比我合并 !120/!132/!133/!134 **之前**的那版还旧 2.2 小时），`!138` 的分支点是 `00f96ee`。
> ⇒ `git diff b0940ca pr/NNN` 会把「分支落后 master 的几千行」一并算进 diff
> （实测 !135 得到 43 文件 / −3651 行，含删掉 `model-center.js`、`credits.ts`）——
> **照它审会得出「这个 PR 删了一大堆功能」的错误结论**。
> 正确的写法是 `git diff <merge>^1 <merge>` 或 `git diff <branch>^ <branch>`。

## ✅ 合并完整性（本机独立取证，非 subagent 结论）

| 检查 | 结果 |
|---|---|
| 四对 `<merge>^1 → <merge>` 的改动 vs PR 自身改动 | **22 个文件逐字节相同** ⇒ 未吞 master 的 hunk、未引入额外改动 |
| 两侧都被改过的文件（覆盖盲区） | `!135`：`credit-expiry.js` **与** `credit-expiry.spec.ts`（两者都是）；`!136`：`jet-hub-rpc.ts` |
| 盲区文件的两侧意图是否都在 | ✓ 独立池摘出 + `packageExpiryMs` 兜底 + `expiringRemaining` 拆包全在；`closeProvider`(4 处) 与 `Promise.all` 并发 + `fetchQoderBalanceDetailed`(4 处) 并存 |
| 工作区 | `git status --porcelain` 为空 |

## 修复状态总览

| # | 级别 | 缺陷 | 状态 |
|---|---|---|---|
| ① | **阻断** | qoder 免费判据只查远端 ⇒ 免费模型被判收费（!137 引入） | ✅ `cae7c7b` |
| ② | 重要 | 并发改造打破失败隔离：一个坏账号让整批 `ok:false`（!136 引入） | ✅ `cae7c7b` |
| ③ | 重要 | 徽标 tooltip 变残句（!135 引入） | ✅ `cae7c7b` |
| ④ | 重要 | 失败文案串味 + 机制断言与命中码无关（!136） | ✅ `cae7c7b` |
| ⑤ | 重要 | !137 的两条守卫本身有缺陷（假绿 + 不可执行/同义反复） | ✅ `cae7c7b` |
| ⑥ | 重要 | !138 的 `maxTokens` 是**点状修复**，系统性缺口还在 | ⚠️ 登记（见下） |
| ⑦ | 重要 | !137 兜底表 `dfmodel` 无 `isFree` | ⚠️ 登记（**需真机**，见下） |
| ⑧ | 重要 | !135 的「守恒」用例不与 `balance.total` 对账 | ⚠️ 登记 |
| ⑨ | 次要 | 前后端 `deductionEndTime` 两格分叉；`normalizeWindowDays` fail-open | ⚠️ 登记 |
| ⑩ | 次要 | !136 并发无上限 / 自愈仍串行 / 文案被截断 | ⚠️ 登记 |

---

## ① 【阻断，已修】qoder 免费判据只查远端 ⇒ 免费模型被判收费

`src/qoder-adapter.ts` 新增的 `isFreeModel` 用 `catalogSource()`
（= `this.remoteModels ?? this.product.fallbackModels`）——
**远端一旦落地就把静态表整体顶掉**。

远端目录是**按账号**下发的：免费额度号上游**只给 2 条**（`qfmodel` + `dfmodel`）。

**实测复现**（`lib/` 重建后真跑）：

```
①远端收缩目录（无免费）  isFreeModel(qmodel_38max) = false   ★ 应为 true
①远端收缩目录（无免费）  isFreeModel(qfmodel)       = false   ★ 应为 true
②远端只含 qmodel_38max  isFreeModel(qfmodel)       = false   ★ 应为 true
③未接线远端             isFreeModel(qmodel_38max) = true    ✓
```

⇒ 免费模型被判收费 ⇒ 跳过 `credential-resolver.ts` 的「免费模型不受锁定约束」
短路 ⇒ 锁定永久积分时被 `allowPermanent=false` 拦下、报出「额度都属于永久」
这类**与事实相反**的错误 ⇒ 本家 2026-10-21 真实报障**原地复发**，且**零日志**。

⚠️⚠️ **最该记的一条**：**同一文件 `catalogModel()` 的注释逐字记过同一个反模式** ——

> 第一版把它写成 `catalogSource().find(...)`（远端落地后静态表完全不参与），
> 被独立审计打穿（缺陷 1，已复现）：**远端目录是「按账号」下发的**…

能力/元数据判据（`inputModalitiesFor`）当时**改对了**，而 !137 新加免费判据时
**又写回了那个反模式**。⇒ 「同一语义两处判据」在本仓已复发多次，这次是
「同一**反模式**在两个方法里各犯一次」。

**修法**：`return this.catalogModel(modelId)?.isFree === true`（远端优先、静态表兜底）。

⚠️ **方向不对称**（判据为什么必须保守）：判**收费**只是让用户用不上（可恢复）；
判**免费**会绕过锁定**真烧掉永久积分**（不可逆）。并集**不会**把收费模型判成免费
（兜底表的 `isFree` 是策展过的显式标记，不是推断）。

**守卫**：`tests/unit/qoder-adapter.spec.ts` 新增一条 —— 必须**先让远端真的落地**
再断言（原有用例「未接线远端」那格 `remoteModels` 仍是 `undefined`，
`catalogSource()` 恰好等于静态表 ⇒ **测不出**本条缺陷）。
变异：判据改回 `catalogSource()` ⇒ 恰 1 条红。

## ② 【重要，已修】并发改造打破失败隔离

`src/qoder-credits.ts` 的 `const headers = await creditsHeaders(...)` 在 try **之外**
—— 并发改造（串行 `for` → `Promise.all`）时漏了这条腿。

凭据形状异常时它抛 ⇒ `Promise.all` reject ⇒ **整批** `credits.balances` 变
`ok:false` ⇒ 客户端把同一句 message 盖到该 provider 的**每一个**账号卡片上
⇒ 「按账号给原因」在异常路径上一次性全丢。

**实测对照**：BASE 同一路径返回 `null`；HEAD 抛出
（`TypeError: Cannot read properties of null (reading 'security_oauth_token')`）。

**修法**：`creditsHeaders` 包进自己的 try，返回 `{balance:null, error:'…（凭据不可用）'}`。
⚠️ 文案**不复用**「网络异常」那条 —— 凭据构造失败不是网络问题。

**守卫**：`qoder-credits.spec.ts` 新增「凭据形状异常（null）⇒ 返回失败，不得抛」。
变异（`creditsHeaders` 移出 try，`tsc` exit 0 的**有效**注入）⇒ 恰 1 条红。

## ③ 【重要，已修】徽标 tooltip 变残句

`expirySplitParts` 的 `countdown` 已从「裸时长」改成「**可能是完整短语**」
（混合批次时 = `其中 500 于 6 天 0 小时后到期`），而消费方
`plugin-src/client/usage-badge.js` 仍无条件拼 `后`。

**实测**：`最早作废：其中 500 于 6 天 0 小时后到期` **后**
（修前该格是 `最早作废：6 天 0 小时后`）——!135 只改生产者、没同步消费者。

**修法**：直接用 `part.countdown`（两种形态都自洽），**不按形态分支** ——
那是在消费方复制生产者才知道的知识，必然再次漂移。

⚠️ 该 title 此前**零守卫**（变异成垃圾串 ⇒ 全量**零新增失败**）。

## ④ 【重要，已修】失败文案串味 + 机制断言与命中码无关

`remedy` 写死「Qoder **国际版**端点在本机被阻断（TCP 能连通、TLS 握手被丢）」，
而该分支被 `isQoderFamily` **两站共用** ⇒ 中国版用户读到与同一句里打印的主机名
（`product.openApiBase`）**自相矛盾**的结论；`remedy` 是常量 ⇒ 对 `ENOTFOUND`
（DNS 解析不到）说「TCP 能连通」是**事实性错误**。

⇒ 只留**出路**、不断言机制（站点已由 `subject` 主机名点名）。
变异（remedy 塞回「国际版」）⇒ 新守卫红。

⚠️ `network-hint.ts` 本身**质量高**，两条铁律都避开了（判据只读 `cause` 链的
`code` 不读 `message`；明确「不要归 `AUTH`/`QUOTA`，那两类码会吞掉 message」）。
它刻意与 `refresh.ts` 的 `isUnreachableNetworkError` 分开（收 `ECONNRESET` 会把
正常重连拉长到 30 分钟）—— 那是**用途不同**，不是「同语义两套判据」。

## ⑤ 【重要，已修】!137 的两条守卫本身有缺陷

- **假绿**：`is-free-model-required.spec.ts` 的「undefined 必须崩溃」用例，其
  pool 替身只有 `{listAccounts, readCredential}`，**缺 `listAccountsByProvider`**
  ⇒ 缺陷态下「静默放过」之后必然在**下一步**抛 `TypeError`
  ⇒ `rejects.toThrow(TypeError)` **照样通过**（替身自己缺的那条腿满足了断言）。
  ⇒ 补齐替身腿 + 断言改为点名 `rejects.toThrow(/isFreeModel is not a function/)`。
- **不可执行 + 同义反复**：`@ts-expect-error` 因 `plan` **无上下文类型**而
  无处可用（纳入 tsc 会报 `TS2578: Unused '@ts-expect-error' directive`，
  与原注释声称的「加进 include 就立刻生效」**方向相反** —— 加进去会让
  `pnpm test`（`pretest` → `typecheck:tests`）**直接失败**）；且
  `Object.hasOwn(plan,'isFreeModel')` 断言的是**自己六行前定义的字面量**。
  ⇒ 换成**可执行**的源码级判据（声明里不得带 `?`）。
  真正的编译闸门是 `pnpm typecheck`（`src/**` 全量，实测删任一接线即 `TS2322`）。

---

## ⑥ 【重要，未修，已登记】!138 是点状修复，系统性缺口还在

**机制（代码事实）**：cline 的 `maxTokens` **只有一个来源 —— 4 条静态表条目**：

- `parseEntryList`（`cline-models.ts`）只取 `{id, name, description}`，
  **把 `maxTokens` / `contextWindow` 直接丢弃**（下游即便下发也进不来）；
- `mergeClineModels` 只从 `fallback` 取；
- `cline-models-dev.ts` 口径 3 **刻意不取** `limit.output`
  （理由：本仓有过「据印象填大值 → 400」的真实事故 ⇒ 保守选择，**不是疏忽**）。

**实测（2026-10-21 匿名只读 GET `recommended-models`，HTTP 200，未用凭据）**：

```
free 6 条：cline-free/minimax-m3.1-flash, reflection/beam-free,
           cline-free/nemotron-3.5-super-vl, nvidia/nemotron-3.5-lightning-free,
           poolside/laguna-s-2.1-free, cline-free/solar-mini4
recommended 6 条 / clinePass 13 条 / clineCloud 1 条
⇒ **全表每条只有 {id,name,description,tags}，maxTokens 零命中**
```

⇒ **free 6 条里只有 `minimax-m3.1-flash` 在静态表里** ⇒ 另 **5 条拿不到
`maxTokens`** ⇒ 请求体不发 `max_tokens` ⇒ 退回 cline 网关默认 **4096**
⇒ 长回答 `finish_reason=length` **静默截断**（!138 的故障链对它们逐字成立）。
加上 `/api/v1/models` 的 460 条按量模型（同样无 `max_tokens`）⇒ **同类缺口 ≈482 个**。

⚠️ 另：静态表 4 条 free 里有 **3 条已不在 live free 数组**
（`stealth/space-bunny-alpha`、`cline-free/mimo-v2.6-flash`、
`cline-free/muse-spark-1.3-contributor`）—— 本 PR 自己的注释写了
「表里有而远端已撤的才是必须同步删掉的」，但没执行。风险面：远端失败时
兜底表整表生效 ⇒ 用户看到已下架的免费模型。**是否真 404 未实测**（需凭据）。

**新增守卫的射程**：`兜底表里每个免费模型都声明了 maxTokens` 只遍历
**表自己的条目**，而本次故障是「**模型压根不在表里**」⇒
**变异实测：整条删除新条目（= PR 前形态）后该守卫仍全绿**
（只有被 !138 改了期望值的**快照用例**变红）。
另：`filter(m => m.maxTokens === undefined)` 放过 `0 / -1 / NaN`，
而它们与 `undefined` **后果完全相同**（`Number.isSafeInteger && > 0` 都丢掉）。

**正确的修法方向**（不是继续补表）：让**远端/模型元数据成为来源** ——
`parseEntryList` 透出 `maxTokens`/`contextWindow` 并让远端优先；
或给「兜底表没有 + 远端不下发」的模型一个**经实测的**保守默认值。
⚠️ 后者要先验「哪个值不会被网关 400」——本仓在 gemini 上踩过
「照抄邻居的 131072 ⇒ `supported range is from 1 to 65537`」。
⚠️ 另注：本 PR 的 `131072` 对**本模型**未实测（提交信息只测到 32768），
且提交信息引的 `providers-cline.md` 那段说的**恰恰相反**（那正是 400 事故，
结论是「兜底表数值凭印象填」）。

## ⑦ 【重要，未修，**需真机**】!137 兜底表 `dfmodel` 无 `isFree`

`src/qoder-product.ts` 两站的 `dfmodel` **没有 `isFree`**（`priceFactor: 0.1`），
而同表 `qmodel_38max` / `qfmodel` 都标了 `isFree: true`。
⇒ 远端不可用时（兜底表路径）`isFreeModel('dfmodel') = false`（CN 与 intl 均然），
而本 PR 自己的 spec 头注释明写「中国版 `Qwen3.8-Flash` / `DeepSeek-Flash`」是免费模型。

**为什么不在本轮修**：⚠️ 若上游的 `is_free` 是**按账号**下发的，把 `dfmodel`
写进**静态**兜底表会让**付费账号**被判免费 ⇒ **绕过锁定真烧永久积分**（不可逆的
危险方向）。⇒ 必须先真机确认「付费账号下 `dfmodel` 是否仍 `is_free`」再定稿。
（文档 `providers-qoder.md` 记的是「`price_factor = 0` + `is_free` + 原价 0.1 被划掉」，
但**未区分账号类型**。）

## ⑧ 【重要，未修，已登记】!135 的「守恒」用例不与 `balance.total` 对账

新用例断言的 `25500` 是**手搓夹具的自和**（`500 + 25000`），
**从不读 `balance.total`**。而宿主侧 `total = totalRemain ?? Σpackages`
（`src/codearts-credits.ts`）—— `totalRemain` 是**上游权威汇总**，
**不保证**等于「可入桶之和」。

⇒ 标题所称的不变式「三档合计恒等于 `total`」实际成立的是
「三档合计 == **Σ(active ∧ remaining>0 ∧ ¬独立池)**」——那是**宿主侧性质**，
不是本函数能保证的。逐格实测：`active:false` / `remaining<0` / 独立池三类输入
会让它与 `total` 脱钩，而新增用例**一格都没覆盖**。
⚠️ 与独立池**自洽**（`total` 不含独立池，实测三档 1900 == 主池 1900），
但那条交叉**没有守卫**（靠独立池用例的精确 `toEqual` 隐式钉住）。

## ⑨ 【次要，未修，已登记】前后端 `deductionEndTime` 两格分叉 + `normalizeWindowDays` fail-open

- **分叉**：后端 `buddy-balance-rank.ts` 已**收窄**为「只接受 `number` 或数字
  字符串」（注释逐字记了 `true` → `1`、`[ms]` → 单元素数组被当数字这两格）；
  **前端 `packageExpiryMs` 仍是裸 `Number()`** ⇒ 同样两格前端判「临期」、
  后端判「永久」。50 格 fuzz 里 2 格分叉。
  ⚠️ 可达性低（两个写入方都同时写 `deductionEndTime`，见
  `astudio-credits.ts` 的「两者都给」注释）⇒ **前向防御缺口**。
- **`normalizeWindowDays` fail-open**：`true → 1 天`、`[] → 0 天`；
  守卫只遍历 `undefined/null/NaN/-1/'abc'` 四格。
- ⚠️ 附带证伪：`buddy-balance-rank.ts` 注释称「这条链路上只有 `typeof`/`Number`
  一处不一致」—— 实测还有 `expiredTime` 兜底那一处（前端认、后端不认）。

## ⑩ 【次要，未修，已登记】!136 的其它三处

- **并发无上限 + 并发放大 spawn**：`Promise.all` 无 cap、`qoder-machine.ts`
  的身份解析**无单飞** ⇒ 冷缓存下 N 个账号并发 ⇒ **N 次真实 `runtime-info.exe`
  spawn**（实测 N=5 ⇒ 5，串行时代恰好 1 次）。本仓已有 `balanceHealInFlight`、
  `officeace-inflight-guard` 同型先例可复用。
- **自愈仍串行** ⇒ 过期账号最坏「读取中」约 **90~105s**
  （60s 自愈预算 + 30s 单账号超时 + 10.7s 余额），而客户端
  `callManagementRpc` **确实不设超时** ⇒ 「一直读取中」只**改善**未**根治**。
  **未实测**（需真实过期账号）。
- **文案被截断**：新的失败文案 **155 字符**、出路起始于第 **54** 字符，而卡片
  错误行是 `.dim-jh-metaRow dd { overflow:hidden; text-overflow:ellipsis;
  white-space:nowrap }` ⇒ 用户看到前缀、**唯一出路看不见**（只有 hover `title` 有全文）。
  本 PR 未改 `plugin-src/client/**`。⚠️ 徽标弹窗侧（280px，`.dim-jh-badgeValue`
  是 `flex:none`）**未目视确认**。
- ⚠️ **同文件成文约定被静默作废**：`jet-hub-rpc.ts` 另两处注释仍写
  「逐账号**顺序**查询（**避免并发触发风控**）」，而本 PR 在同 handler 里改成并发
  且**无风控论证**。⇒ 「并发查询 qoder 余额会不会触发上游风控」**零证据**。

---

## 变异测试表（30+ 条，全部锚点自证 + 还原确认）

本仓纪律：**CRLF 上 `String.replace` 会静默不生效** ⇒ 注入器一律用
Python **二进制/`newline=''`** 模式，并**打印实际注入片段**；锚点未命中报
`PATCH-NOT-APPLIED` 而不是「无牙」。

| 归属 | 变异 | 结果 |
|---|---|---|
| ① 修复 | `isFreeModel` 改回 `catalogSource()` | 🟥 新用例恰 1 红 |
| ② 修复 | `creditsHeaders` 移出 try（tsc exit 0） | 🟥 新用例恰 1 红 |
| ③ 修复 | 徽标 title 拼回 `后` | 🟥 新用例红 |
| ④ 修复 | `remedy` 塞回「国际版」 | 🟥 新用例红 |
| ⑤ 修复 | 消费侧恢复 `=== undefined ? false` | 🟥 新用例红（**且红因是被测语义**，不再是替身缺腿） |
| !135 | 临期数字退回 `earliestExpiringAmount` | 🟥 5 红（含逐字复现报障的 `22500 → 25500`） |
| !135 | `partial` 恒 `false` / 恒 `true` | 🟥 3 红 / 3 红 |
| !135 | 独立池放回 `permanent` | 🟥 6 红 |
| !136 | `Promise.all` → 串行 | 🟥 1 红（618ms ≥ 600ms） |
| !136 | 网络腿退回统一话术 | 🟥 2 红 |
| !136 | 判据改读 `message` 而非 `cause` 码 | 🟥 3 红 |
| !137 | 删任一接线 | 🟥 `TS2322` + 行为用例 |
| !137 | `NO_FREE_MODEL` 恒真 | 🟥 6 红 |
| !138 | 删静态表的 `maxTokens` | 🟥 1 红（**仅表内**） |
| **无牙** | 徽标 title 换垃圾前缀 | ⬜ 全量**零新增失败** ⇒ ③ 成立 |
| **无牙** | `creditsHeaders` 移回 try 内 | ⬜ 96 全绿 ⇒ ② 成立 |
| **无牙** | `isFreeModel` 改成**更正确的**并集 | ⬜ 5 spec 全绿 ⇒ ① 成立（修前的守卫） |
| **无牙** | `aborted` 腿钉成 `false` | ⬜ 67 全绿（该腿**实测承重**） |
| **无牙** | 整条删除 !138 新条目（= PR 前形态） | ⬜ 新守卫全绿 ⇒ ⑥ 成立 |
| **无牙** | `maxTokens: 0` | ⬜ 191 全绿 ⇒ ⑥ 的值域缺口成立 |
| **无效注入** | `creditsHeaders` 移出 try 的**第一次**注入 | ⚠️ vitest 报 `no tests`（语法无效）⇒ **判为无效、未计入**，重做后采信 |

## 未证实 / 未覆盖（如实登记）

1. **网关默认 4096 + 静默截断**只存在于 !138 的提交信息/注释里 ——
   本机复现的是它的**前提**（远端 free 全表无 `maxTokens`），
   **没有**用真实凭据发推理请求去量 `completion_tokens=4096`。
2. **`131072` 对 `minimax-m3.1-flash` 是否真被接受**未实测（提交信息只测到 32768）。
3. **`dfmodel` 的 `is_free` 是否按账号**未核实 ⇒ ⑦ 的修复方向待定。
4. **3 条「僵尸」兜底条目是否已 404** 未实测（需凭据）。
5. **并发温度**：并发查询 qoder 余额是否触发上游风控 **零证据**。
6. **!136 的 90~105s** 是按常量推算，**未用真实过期账号实测**。
7. **徽标弹窗侧**（280px）的溢出/换行形态**未目视确认**。
8. **e2e 一律未跑**（需真凭据；本仓有「诊断脚本对真实凭据发起 refresh 烧掉
   token」的事故史 ⇒ 刻意不跑）。
9. **!135 的「上游汇总行恒等于分类之和」**这一前提未取证 ——
   而它正是「三档 ≠ total」复发的入口。

## 环境附注（供复核者判断「现场」）

审计期间 **5 路 subagent 在同一 workspace 并发**做变异，观测到：

- `src/qoder-credits.ts` 一度出现「把 `creditsHeaders` 移回 try」的未提交改动
  （这正是 ② 的修法，由某路审计员改后又自行还原）；
- `src/cline-product.ts` 一度为 `maxTokens: 0`、`src/jet-hub-rpc.ts` 被改又还原；
- 一次 `npx tsc` 报 `TS2588 Cannot assign to 'headers' because it is a constant`
  是上述**中途态**的假警报（干净 HEAD 上 tsc exit 0，已复核）；
- `lib/` 于 15:20 被某路审计员重建（对「`lib/` 陈旧」那条纪律是好事，
  但**任何在 15:20 前用 `lib/` 做的端到端验证结论都要重新核对**）。

⇒ **最终复核**：`git status --porcelain` 为空；四个 merge 的 22 个文件改动与
PR 自身逐字节相同；`pnpm test` = 10155 passed / 0 failed。

**教训**：并发审计的效率优势明显（30+ 变异、5 个面同时推进），但
**必须约定「谁在改哪个文件」**，否则中途态会污染彼此的基线与结论
（本轮至少产生 1 次假警报 + 2 次「文件被外部改动」的告警）。
