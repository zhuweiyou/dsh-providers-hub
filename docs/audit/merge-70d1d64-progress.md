# 合并上游 `70d1d64` 进度（分支 `upstream-base`）

规则（用户定）：**以上游为基准**，但**上游删掉的文件与接线要补回来**；上游新增的一律采纳。

## 已完成

1. `git merge -X theirs 70d1d64` —— **0 冲突**，自动保留「仅我们有」的 35 个文件
   （9 个 buddy 源文件 + 25 个测试 + 2 份文档 + `web-native.spec`）。
   上游 22370 行新增（astudio / gemini-proxy+rpc / qoder-catalog / network-hint /
   login-failure / model-center / sidebar-entry / trae-lottery 等）全部进入。
2. 编译修复（`5970fb3`）：`src` 侧 `tsc` **0 error**
   - `tencent-fingerprint.ts` 取**本仓库**版本（上游那份缺第四条 DSH 指纹与两条脱敏腿）
   - `src/types.ts` 补回 buddy RPC 契约（`RpcBuddyGrowth*` / `RpcBuddyCompensation*`）
   - `src/product.ts` 补回 `BuddyProduct` 别名、`resolveChatBase`、`webOrigin`/`acceptLanguage`
   - `src/jet-hub-rpc.ts` 的 `growth` 数组按本合同标注类型

## 当前测试状态（全量）：`40 failed / 10170 passed`，15 个文件

分四类，均已定位：

| 类 | 文件 | 原因 / 下一步 |
|---|---|---|
| A buddy 渠道**未重新注册** | `buddy-permanent-lock`(8)、`buddy-ratelimit-misreport`(3)、`dsml-normalizer-coverage`、`error-detail-wiring`(3)、`provider-runtime-wiring` | `provider-registry.ts` 没有 `buddy`/`workbuddy` 条目；`index.ts` 无 buddy 装配；`JetHubAuths` 无 buddy 键；`WRITE_SITE_FILES`/DSML 出口清单未登记 `buddy-adapter.ts` |
| B 我们的 WORKBUDDY UA 单一化被上游版本覆盖 | `buddy-wire`（期望 `userAgentByModelFamily` 长度 0，实得 7） | 把 `WORKBUDDY_UA_INTL` 单一形态搬回 `product.ts`（上游那份是「按模型族分档」的旧形态） |
| C 上游行为变更，用例期望值需更新 | `llm-adapter`（codearts `GLM-5.2` 窗口 202752 → 1048576） | 更新期望值（与 `docs/agent-notes/providers-codearts.md` 记录的 10-21 变更一致） |
| D 与合并无关 / 环境 | `openai-gateway-host-binding`(3)、`openai-gateway-wiring`(1)：`127.0.0.2` `EADDRNOTAVAIL`；`repo-pii-guard`：`providers-buddy.md` 手机号正则命中 | D 组先单独复跑确认是否 pre-existing |

## 待办（按序）

1. `provider-registry.ts` 补 `buddy` / `workbuddy` 条目（从 `feat/buddy-align-panel` 取）。
2. `index.ts` 补 buddy 装配：imports、`probeById` 两项、`BuddyAuth` 实例、`registerBuddyLlm`、
   `credits` 的 `afterClaim`、`JetHubAuths` 键、`modelAdapters`、`installWebNative` 的 buddy 侧、
   `SELF_HEAL` 登记、账号清理（`pruneAccountsWithForeignDomain`）。
3. 把上游新增（astudio / autoclawintl / sidebar-entry / model-center …）与我们的 buddy 装配
   **并存**，逐项跑测试收敛。
4. `product.ts`：恢复 WORKBUDDY UA 单一形态。
5. 更新 C 组期望值；复跑 D 组确认环境因素。

## 参考

- 上游提交：`70d1d64`（父提交 `b3b927d` = 双方 2026-08-26 的共同祖先）
- 我们的原分支：`feat/buddy-align-panel`（HEAD `0a23c37`）
- IKP8OF 移植（未采用，已在 `stash@{0}`；上游已自带该修复）
