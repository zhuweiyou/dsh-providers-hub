# buddy 成长中心：扩展收益 + 任务中心（2026-10-23）

> 触发条件：改 `src/buddy-growth-center.ts` / `src/buddy-growth.ts` 的任务与领取逻辑、
> `src/growth-run-log.ts`、面板「成长任务中心」卡片，或排查「点了做任务没反应 / 看不出领了什么」时先读这一节。

## 0. 这一节要解决的用户诉求

> 「点了做任务 本仓好像没反应，是默默做的，没地方查询和展示对吗」
> 「只要能实现的，任务全部弄过来」

事实核查（改前）：结果**一直存在**（`credits.claimAll` 的返回里有逐项 `tasks`），
但只作**一次性 toast** 呈现；任务清单从来没读出来展示过；面板刷新 / 重启后
「上次到底做了什么」查无此处。⇒ 两条改造：**把能实现的收益动作全部接上** +
**给一个常驻、可回看、可展开的查看入口**。

## 1. 对照参考实现的缺口（改前 vs 现在）

参考：`linguo2625469/workbuddy2api-panel`（Go）。逐端点对完的结论：

| 动作 | 参考实现 | 本仓库改前 | 现在 |
|---|---|---|---|
| 每日签到 | ✅ | ✅ | ✅ |
| 成长任务完成 + 扫尾补领 | ✅ | ✅（22 项） | ✅（+8 项 mp = 30 项） |
| 连登档位兑换 `7d/14d/28d` | ✅ | ❌ 全仓 0 处 | ✅ `redeemUnlockedTiers` |
| 抽奖（按 chances 抽完） | ✅ | ⚠️ 只在**死代码**里盲抽 1 次 | ✅ `drawAllLottery`（上限 10 次/轮） |
| 猫猫旅行 | ✅ 状态机 | ⚠️ 只发 claim，**无 depart**，`record_id` 也没带 | ✅ `advanceTravel`（status→depart/claim） |
| 补签（保住连登） | ✅ | ❌ | ✅ `makeupYesterday` |
| 新手礼包 `claim-gift` | ✅ | ❌ | ✅ `claimGift` |
| 领养首只 Buddy（+300） | ✅ report→agreement→first | ⚠️ 无前置，且在死代码里 | ✅ `adoptBuddy` |
| 小程序口径任务（8 项） | ✅ | ❌ | ✅ `MP_TASK_CODES` + `mpChat/mpExpert/mpEvent` |
| 官方补偿 | ✅ 自动 | ✅ 但只手动卡片 | 保持手动（一次性活动，刻意不自动） |
| 开学季活动 5 任务 | ✅ | ❌ | ❌ 活动期已结束（2026-09-24），不接 |
| `WorkBuddy_Valorant` | ❌ | ❌ | ❌ 判据未逆向，面板显示「未接线」 |

## 2. 端点与主机（实测，别凭直觉改）

| 动作 | 方法 | 路径 | 主机 |
|---|---|---|---|
| 连登状态 | GET | `/activity/growth/streak`（**也接受** `/v2/` 前缀） | `product.endpoint` |
| 档位兑换 | POST | `/activity/growth/redeem` | 同上 |
| 抽奖次数 | GET | `/activity/growth/lottery/summary` | 同上 |
| 抽奖 | POST | `/activity/growth/lottery/draw` | 同上 |
| 旅行 状态/派出/领奖 | GET/POST | `/activity/growth/buddy/travel/{status,depart,claim}` | 同上 |
| 猫档案 / 协议 / 领养 | GET/POST | `/activity/growth/buddy/{info,agreement,first}` | 同上 |
| 补签 | GET/POST | `/activity/growth/{heatmap,makeup-cards/use}` | 同上 |
| 新手礼包 | POST | `/billing/meter/claim-gift` | `product.webBase` |
| mp 事件上报 | POST | `/v2/report` | **`https://www.codebuddy.cn`**（第三条上报腿） |
| 任务领奖（web） | POST | `{claimBase}/activity/growth/tasks/<code>/claim` | web 域 |
| 任务领奖（mp） | POST | `{endpoint}/activity/growth/tasks/<code>/claim` + mp 头 | chat 域 |

⚠️ `lottery/draw` 的权威路径**不带 `/v2`**。`buddy-growth.ts` 里那枚
`GROWTH_LOTTERY_PATH = '/v2/...'` 是早期按「成长族都带 /v2」推断的，**零生产调用方**
（只被死代码 `claimAllGrowth` 的 `runExotic` 引用）。新代码一律用
`buddy-growth-center.ts` 的 `LOTTERY_DRAW_PATH`。

## 3. 2026-10-23 只读探针实测（`scripts/probe-buddy-growth.mjs`）

跑法：`$env:DSH_BUDDY_GROWTH_PROBE=1; node scripts/probe-buddy-growth.mjs`
（**只发 GET**，闸门必需，输出不含凭据）。真实账号结论：

- **连登**：两个路径（带/不带 `/v2`）返回**逐字节同形**；`days` 在 `data.streak.days`
  （**不是**顶层 `data.days`），档位状态在 `data.redemption_status.tier_7d_status` 等；
  ⇒ 解析**两种形状都认**（只认一种会让天数恒 0 且无人报错）。
- **任务**：web `/v2`=16 项、web 无 `/v2`=5 项（等级族）、**mp `/v2`=9 项**。
  ⚠️⚠️ **参考实现那句「mp 列表是默认口径的超集」在本机是假的** —— mp 反而**漏掉**
  create_canvas / playbook_prompt / Library_read / Expert_lighthouse / Hp_Appearance /
  Buddy_App / skill_1 / expert_5 / template_5 九项。⇒ **必须三源取并集**。
- **抽奖**：`chances` + `module.enabled`（`enabled` **缺字段按开启**，缺字段≠关闭）。
- **旅行**：`state` / `record_id` / `daily_limit_reached` / `reward_credit` 全在。
- **热力图**：`cells` 365 条（`{date,score}`），今日 `score:0`。

## 4. 小程序口径的三条纪律（错一条就白跑）

1. **accept 分两批**：web 与 mp 的 `X-Client-Platform` 不同，混批会让 mp 任务回
   `task not found`（参考实现 `tasksweep.go` 也是拆开提交）。
2. **事件间隔 ≈45s**（`MP_CHAT_EVENT_GAP_MS`）：数秒级连发会被反作弊判无效并
   **整体回滚**（实测 2s 连发 4 条全灭、45s 间隔全存活）。这是**判据参数**，不是节流；
   首条也要等。代价：`Sequential_Tasks_3`/`6` 分别约 4/8 分钟/账号，由 `budgetMs` 兜住。
3. **accept 后必须回读 target**：接受前 `target` 下发 0，按兜底 1 报会少报
   （Tasks_6 真实 target=10）。旧实现「只补 1 条就领奖」⇒ 400 `task not completed`。

## 5. 「有地方看」是怎么实现的

- **持久化**：`src/growth-run-log.ts` → `$DSH_HOME/jet-hub/growth-runs.json`
  （每账号一条：时间 + 一句话摘要 + 逐项 `extras`）。写入点在
  `provider-credits.ts` 的 `afterClaim`，**永不抛错**（调用在领取关键路径上）。
- **只读 RPC**：`buddy.growthOverview`（`jet-hub-rpc.ts`）→ 逐账号
  `{ streak, lottery, travel, hasBuddy, tasks[], lastRun }`。**纯 GET**、逐账号容错、
  串行（一个账号 6 个上游请求，并发会撞 buddy 限流）。
- **面板**：`plugin-src/client/growth-center-logic.js`（纯函数，可单测）+
  `jet-hub.js` 的**常驻卡片**（`data-testid="growth-center-card"`）：
  「上次执行」一行 + 连登档位 + 「展开任务（N 项：可自动/需客户端/待领取/已领）」。
  ⚠️ 与补偿卡的**关键区别**：补偿卡「有数据才渲染」，本卡**常驻** ——
  用户正是来「找地方看」的，没数据也要有入口与解释。

## 6. 踩到/避开的坑（逐条都是实测或审计）

- **`credits.claimAll` 的 `afterClaim` 只在 `runTasks === true` 时跑**（jet-hub-rpc:5932）
  ⇒ 扩展收益**不会**被开机自动签到触发，只由用户点按钮触发。这也让「一次性写操作」
  （领养 / 礼包）可以安全地挂进去。
- **`claimAllGrowth` 是死代码**（零生产调用方，只有单测）：它里面的盲盒/抽奖/首Buddy
  从来不执行。别被它误导成「已经实现了」。
- **`GROWTH_TRAVEL_STATUS_PATH` 曾经定义了却零引用** —— 旅行只 claim 不 depart
  ⇒ 永远 `no unclaimed travel`、每天 0 收益。
- **旧 `fetchStreakStatus` 零调用方零单测**：形状猜错也永远没人发现（本节点把
  `fetchStreakDetail` 做成两种形状都认 + 有单测）。
- **`Headers` 实例不是普通对象**：测试替身若用 `Object.entries(init.headers)` 读头，
  **恒为空** ⇒ 「mp 头有没有发出去」的断言恒假通过（`buddy-mp-tasks.spec.ts` 已按
  `Headers.get()` 读）。
- **`types.ts` 里加 `days:` 会打红 `token-ledger-panel.spec.ts`**：那条用例
  `slice(indexOf(...))` 切到**文件尾**，后面任何接口出现 `days:` 都会误伤 ⇒ 已收紧到
  该接口自己的闭包（不是放宽断言）。
- **扩展收益里「跳过」≠「失败」**：无补签卡 / 无抽奖次数 / 已有 Buddy / 昨日未漏签
  全部归 `skipped`，UI 不染红；只有真失败才计数。`summarizeGrowthExtras` 也刻意
  只列有信息量的项，否则每轮都是「无抽奖次数、昨日未漏签、已有 Buddy」三连废话。
- **领养门槛错误不是失败**：HTTP 400 `first_buddy task not completed yet` = 今日活跃
  还没点亮，`isBuddyAdoptNotReady` 归 `skipped` + 「明天再试」。

## 7.5 按需读取 + 状态行 + 后台语义（2026-10-23 第二轮，用户报障）

用户原话（两条，都是对着面板说的）：

> 「这个要弄个按钮点了才读取，而不是打开插件面板就读取，这样每次都要向上游发 API 请求太多了」
> 「看不到任务执行进度，至少也要给到一个状态行，告知当前哪个号正在做什么任务，还有面板切走了，任务在后台还会做吗？还是会停止，这个要在画面说明出来」

⇒ 三条改造，**判据都在「请求成本」与「事实」上**：

### 7.5.1 读的粒度分三层（这是本轮的核心）

| 数据 | RPC | 成本 | 何时读 |
|---|---|---|---|
| 实时进度 | `buddy.growthProgress` | **0 上游**（宿主内存） | 打开面板 + 每 3s 轮询 |
| 上次执行结果 | `buddy.growthLastRuns` | **0 上游**（读 `growth-runs.json`） | 打开面板 + 领取后 |
| 任务清单 + 连登/抽奖/旅行/猫 | `buddy.growthOverview` | **每账号约 6 个上游 GET** | **只在点「读取任务清单」时** |

⚠️ 旧实现是「挂载就跑总览」⇒ 6 个账号就是 36 个上游请求，而且卡片会长时间停在
「读取中…」（用户截图里那个外观）。守卫见 `tests/unit/growth-center-wiring.spec.ts`
（挂载 effect 不得出现 `loadGrowthCenter(` / `buddy.growthOverview`；总览 RPC 全局只有
**一个**调用点）。
⚠️ 该守卫的锚点踩过一次坑：**不能锚 `mounted.current = true;`** —— 文件里别的组件
（模型选择弹窗）也有同款语句，`indexOf` 会命中那里、切片跨到 9 万字符后（假红）。

### 7.5.2 状态行（「哪个号正在做什么」）

- 宿主：`src/growth-progress.ts` 单例记 `{runId, running, doneAccounts/totalAccounts,
  current:{accountId, nickname, text}}`，由 `collectClaimResults` 在**每个账号前后**维护，
  由 `provider-credits` 的 `afterClaim` 通过 `GrowthRunOptions.onStep` 逐动作上报
  （`任务 chat_5：发一条对话` / `补领 xxx` / `猫猫旅行` …）。
- 客户端：每 3s 轮询 `buddy.growthProgress`，卡片第一行显示
  `⏳ 正在跑 <昵称> · <步骤> · 账号 2/3`；结束后显示本轮摘要。
- ⚠️ **`running` 必须能回到 false**：`collectClaimResults` 的循环包在 `try/catch` 里，
  异常路径也调 `finishGrowthRun` —— 否则面板会**永远显示「执行中」并禁用按钮**（比没有进度更糟）。

### 7.5.3 后台语义（用户明确要求写在画面上）

事实：一键领取是**一次宿主侧 RPC**，逐账号循环跑在宿主进程里（`collectClaimResults`）。
面板切走只影响「结果怎么显示」（`mounted.current=false` 后不上屏），**请求不会被打断**；
进度表与结果日志都在宿主侧 ⇒ 切回来仍能看到「正在执行 / 刚刚完成」。

⇒ 卡片常驻一行 `backgroundHint()`：「执行在宿主进程里进行：切换渠道、关掉面板、刷新页面
都**不会中断**；回来后再点开本面板即可看到进度与「上次执行」结果。进度每 3 秒刷新一次
（本地内存，不请求上游）。」

⚠️ 因为切走后本地 `claimInFlightRef` 会重置，**必须**再加一条宿主侧防重入：
`credits.claimAll` 在 `runTasks === true` 且 `growthRunActive(provider)` 时直接返回
`busy` 错误（文案指引去看进度），否则连点两次会**并发跑两轮**（同一批账号被两套事件链
重复上报 ⇒ 上游判无效/回滚 + 限流风险翻倍）。

## 7. 验证口径
- 单测：`tests/unit/buddy-growth-center.spec.ts`（26+2）、
  `tests/unit/buddy-mp-tasks.spec.ts`（8，含 2 条 30s 超时的真实节奏用例）、
  `tests/unit/growth-center-logic.spec.ts`（17）、`tests/unit/growth-run-log.spec.ts`（7）。
- **没有 live e2e**：这批全是写操作，没加自动闸门。真实核对用只读探针
  `scripts/probe-buddy-growth.mjs`；要验「真的领到了」只能人工点一次按钮看
  `growth-runs.json` 与余额。
- 已知**基线失败**（与本改动无关，已在 clean main 上复现）：
  `jet-hub-styles-ownership`（1）、`lobsterai-credits`（1）、
  `officeace-ikm741-abandoned-login`（1）、`raccoon-auth`（3 条 5s 超时）。
