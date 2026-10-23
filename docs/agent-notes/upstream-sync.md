# 上游同步节点（供下次从这里开始找 diff）

> 本文件只记「同步到哪了」，不记同步内容本身（内容见各 provider 笔记与 git log）。
> 每次同步完成后**更新下表最后一行**，并在提交信息里带上新的基点 hash。

## 上游仓库

| 项 | 值 |
|---|---|
| 仓库 | <https://gitee.com/iJetLi/deepseek-harness-codearts> |
| 本地 remote | `upstream`（`git remote -v` 可查） |
| 默认分支 | `master` |

```bash
git fetch upstream --prune
git log <上次基点>..upstream/master --no-merges --date=short \
  --pretty='%h %ad %s'
```

## 同步记录

| 同步日期 | 上游基点 commit | 上游 commit 时间 | 本地同步提交 | 备注 |
|---|---|---|---|---|
| 2026-10-23 | `24e3988` | 2026-10-23T18:31:22+08:00 | `51a33e8`（`feat/sync-upstream`） | codely 渠道 / codearts 识图 / minimax 账号真名；未跟 `d5f5ac6`（共享骨架 refactor，行为等价） |

## 下次同步的起手式

```bash
git fetch upstream --prune
git log 24e3988..upstream/master --no-merges --pretty='%h %ad %s' --date=iso-strict
```

- 只取**修复 / 新增 / 更新**；上游的**删除一律不跟**（渠道、`src/` 文件、接线、测试键）。
- `buddy` / `workbuddy` 与网关「允许局域网访问」是本仓库红线，**任何情况下不得删**。
- ⚠️ 上游会 **force-push / 重写历史**：`471fd64` 等旧基点已从上游消失
  （2026-10-22 同步时实测 `git cat-file` 报 Not a valid object name）。
  ⇒ 起点 hash 找不到时**不要**退回 `git log 全部` 硬看，改用内容比对：
  `git diff upstream/master HEAD -- <file>` 看 `+`/`-` 两侧的功能归属，
  或按本文件表格里的日期用 `--since` 圈定候选提交，再用 `git patch-id` 去重。
- 同步后验证：`pnpm typecheck` + `pnpm typecheck:tests` + 全量 `pnpm test`，
  并逐项确认 buddy 文件与用例**仍在且仍绿**。
