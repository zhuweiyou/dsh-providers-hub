<!-- 新建（2026-10-21）：本仓库的主 provider 一直没有专属笔记，这条缺陷史与取证方式
     都是「改之前必须先读」的，故单独成文件。按需阅读，不进每轮注入。 -->

## CodeArts 的上下文窗口：**上游不下发**，且缺它会让用户的占用条整条消失

### ⚠️⚠️ 真实报障（2026-10-21）

用户原话：「codearts 对话后，DSH 下方本该显示上下文窗口占用比的地方没有显示」，
并补充「好像是 glm-5.3 文本对话有这个问题」。**不是**配置项问题，也**不是**
「我们没解析后端返回的字段」。

### 判据链（宿主侧，**不在本仓**，改之前先照抄这几行去核对版本）

`dsh-client-ui-conversation/lib/client.js`：

```js
function contextOccupancy(pressure) {
  const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
  if (usedTokens === void 0 || pressure?.contextWindow === void 0) return null
  return { percent: Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100)), ... }
}
// ContextMeter 里：
if (context === null) return null
```

⇒ **缺任一个输入 ⇒ 环 + 百分比 + 弹层整条不渲染**（不是显示 0%，是根本不出现）。

| 输入 | 来源 | 本家状态 |
|---|---|---|
| `usedTokens`（分子） | `dsh-token-meter` 读 `assistant/message.usage`，`pressureFrom = inputTokens + cacheReadTokens + cacheWriteTokens` | ✅ **一直是好的**（实测 glm-5.3 上报 `inputTokens:37482, cacheReadTokens:448`） |
| `contextWindow`（分母） | `dsh-agent-loop` 写 `request/context` 事件，值 = 适配器 `resolveModel()` 的 `context.contextWindow` | ❌ **本家唯一会出错的地方** |

⚠️ 顺带记：**`assistant/attempt` 的 `usage` 不可靠**（实测常常 `undefined`、
`stream: []`）—— 但 token-meter 有 `assistant/message.usage` 这条腿，故分子不受影响。
排查时**不要**看到 `assistant/attempt.usage === undefined` 就以为「usage 没上报」。

### 落盘铁证：同一会话内切模型，条就消失

`~/.dsh/sessions/<workspace>/session-<id>/session.v4.jsonl.zstd` 里逐行对照：

```
model/selection:  {"provider":"codearts","model":"deepseek-v4.1-flash"}
request/context:  {"provider":"codearts","model":"deepseek-v4.1-flash","contextWindow":1000000}   ← 有 ⇒ 条在
model/selection:  {"provider":"codearts","model":"glm-5.3"}
request/context:  {"provider":"codearts","model":"glm-5.3"}                                        ← 无 ⇒ 条消失
```

复核脚本（解 zstd、抽 `request/context`）见会话 `session-fd3e2786` 的取证方式；
**判据是 `request/context` 事件里有没有 `contextWindow` 键**，不是看 UI。

### ⚠️⚠️ 上游两个目录端点**都不下发窗口**（2026-10-21 只读探测实测）

- `snap-access /v1/model/builtin` 的条目**键全集**：
  `channel_source, credit, display_enabled, enable, intervals, model_category,
   model_desc, model_id, model_name, model_sku, provider, supports_images, time_slots`
  ⇒ **无任何 context/window/length/token 类字段**（8 条模型逐条核对）。
- `opengw gateway/config`：本机 4 个账号**全回** `4000 invalid channel, group not found`
  （所以别指望从它取窗口；也不要因为它 4000 就以为凭据坏了 ——
  `/v1/model/builtin` 用同一个账号是 200）。
- ⚠️ 探测脚本必须**遍历账号池**：本机第一份凭据（`CODEARTS_ACCESS_TOKEN`）已 401，
  只试它一个会得出「上游不可达」的**假结论**。

⇒ 窗口的权威来源是 **IDE 自己下发的 provider 配置**，不是 HTTP 端点。

### 权威取值：IDE 内核日志的 `limit.context`

位置：`~/.codeartsdoer/codearts-data/log/kernel-*.log`，搜
`provider models replace body is` / `global config models`：

```json
"provider":{"inferhub-provider":{"models":{
  "GLM-5.2":{"id":"GLM-5.2","limit":{"input":1044480,"output":65536,"context":1048576}},
  "glm-5.3":{"id":"glm-5.3","limit":{"input":1044480,"output":65536,"context":1048576}},
  "glm-5.2-sft-harmony":{"id":"...","limit":{"input":196608,"output":131072,"context":202752}},
  "openpangu-2.0-pro":{"id":"...","limit":{"input":512000,"output":131072,"context":524288}},
  "deepseek-v4.1-flash":{"id":"...","limit":{"input":1044480,"output":65536,"context":1048576}}
}}}
```

⚠️ **这个值会变，而且变过**（本机 42 份日志，2026-09-11~10-21 按日期收敛）：

| 模型 | 历史 |
|---|---|
| `GLM-5.2` | 09-11~10-20 = `202_752` ⇒ **10-21 起 = `1_048_576`** |
| `glm-5.3` | 10-17 起出现，先 `202_752` ⇒ **10-21 起 = `1_048_576`** |
| `glm-5.2-sft-harmony` | 全期 `202_752` |
| `openpangu-2.0-flash` / `-pro` | 全期 `524_288` |
| `deepseek-v4.1-flash` | 全期 `1_048_576`（本仓曾写 `1_000_000`，**是错的**） |

⚠️⚠️ **留旧值 `GLM-5.2 = 202_752` 有两个静默后果**（与 `officeace-product.ts`
那次「估值偏小 5.3 倍」**逐字同因**）：① 占用比被封顶成 100%（分母小 5 倍）；
② 自动压缩阈值 = `0.8 × 202752 ≈ 162K` ⇒ **1M 的能力永远吃不到**。
⇒ 校准窗口时**两个出口一起想**（占用条的分母 + 压缩阈值），别只看 UI。

### 修法（三条腿，缺一条就会复发）

1. **静态表** `src/llm-adapter.ts` 的 `CONTEXT_WINDOWS` 逐模型校准（写来源+日期）；
2. **具名兜底** `CODEARTS_FALLBACK_CONTEXT_WINDOW = 524_288`（用户 2026-10-21 选定：
   取当前目录**最小真实窗口**；偏小 ⇒ 偏早压缩不报错，偏大 ⇒ 未知模型可能
   **上游溢出报错**一轮对话报废 ⇒ 取偏小一侧）。纪律与
   `aggregate-adapter` 的 `AGGREGATE_COLD_CONTEXT_WINDOW` 同型：**宁给具名兜底、不省略**；
3. **骨架回调** `ModelCatalogConfig.unknownModelContextWindow?(modelId)`
   —— **可选**，只有声明它的家生效（当前**仅 codearts**）。其余 12 家行为逐字不变。

### ⚠️⚠️ 两条踩过的坑（都实测过，别再犯）

1. **回调必须传 `modelId`**：第一版写成无参、直接返回常数兜底 ⇒ `glm-5.3` 在
   窗口表里是 1M，却**不在静态兜底目录 `DEFAULT_MODELS` 里** ⇒ 离线/首次启动
   时它算「目录外 id」⇒ 拿到 `524_288`（**分母错 2 倍**），而它正是报障模型。
   ⇒ 实现必须是 `codeartsContextWindow(modelId)`「**表内优先、查不到才兜底**」。
   ⚠️ 这是**全量测试**（10191 条里的 1 条红）抓出来的，不是审计想出来的。
2. **`listModels` 的返回值里没有 `contextWindow`**：DSH 契约
   `LlmModelInfo`（`dsh-llm/lib/types/types.d.ts`）**只有**
   `provider/id/name/description/inputModalities`；`context?: {contextWindow}`
   只存在于 **`LlmResolvedModelInfo`**（`resolveModel` 的形状）。
   ⇒ 守卫**不能**断言 `listModels` 带窗口（我第一版就这么写，恒红）。
   **契约形状写错会让守卫「假红」，与假绿一样有害**。

### 守卫与变异验证（`tests/unit/codearts-context-window.spec.ts`）

| 变异 | 结果 |
|---|---|
| 目录条目改回 `...cond ? {...} : {}`（缺陷原形） | ①② 红，点名 `glm-5.3` / `GLM-5.2` |
| `unknownModelContextWindow` 改回无参常数 | ③ 红 + 跨家不变式 g 红 |
| 骨架对未知 id 普遍给 `200_000` | **17 条红，逐家点名**（证明其余各家仍受约束） |
| 回调改回 `() => CODEARTS_FALLBACK_CONTEXT_WINDOW` | ③c 红（精确复现上面那个缺陷） |

跨家不变式 (g)「未知 id 不得编造 context」在 `model-catalog-parity.spec.ts`，
现为「**默认禁止 + codearts 具名例外**」；例外**改判据**（必须等于具名常量），
**不是** `if (id !== 'codearts')` 跳过断言 —— 后者会让 codearts 这条完全无牙。
⚠️ 该不变式此前对 **15 家全部有牙**（文件头注有反向验证记录），改它时要保住这一点。
