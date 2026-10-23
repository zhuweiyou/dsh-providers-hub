# dsh-providers-hub

DeepSeek Harness 插件：把多家 AI 编程服务的账号统一接进 DSH 的模型选择器。

> 本项目基于 [iJetLi/deepseek-harness-codearts](https://gitee.com/iJetLi/deepseek-harness-codearts) 分叉二次开发。

<img width="842" height="838" alt="image" src="https://github.com/user-attachments/assets/51a01136-975a-4ea5-aa96-783d9c003347" />

## 安装

### Desktop 版

在 DSH 桌面端的插件安装入口里**直接填写插件名称** `dsh-providers-hub` 即可。

### Web 版

```sh
dsh plugin --profile web add dsh-providers-hub
```

包内已包含编译产物（`lib/`），装完即用，不需要再构建。升级同样是再执行一次
`add`。

## 能力

- **多账号池** —— 同一服务可登录多个账号，按可用性自动选号；限流、额度耗尽、
  渠道校验失败都会自动换下一个号，并把坏号按原因标记冷却。
- **凭据静默续期** —— 访问令牌在到期前自动刷新，不用再开一次浏览器。
- **积分统一管理** —— 余额、每日签到 / 一键领取、成长任务、永久积分锁定，
  全部集中在 Jet Hub 的一个页面里。
- **聚合路由** —— 把各家同名模型合成一个虚拟模型，跨渠道按「最早到期」自动轮换；
  也可以固定用某一家的某个模型。
- **本机 OpenAI 兼容网关** —— 让其它客户端复用这里已经登录好的账号。

## 支持的渠道

21 个渠道，外加 1 个 `aggregate` 聚合路由：

| 服务 | 渠道 id |
|---|---|
| CodeBuddy（腾讯） | `buddy` |
| WorkBuddy（国际版） | `workbuddy` |
| CodeArts（华为云） | `codearts` |
| OfficeAce（华为云） | `officeace` |
| Qoder | `qoder` |
| Qoder（中国版） | `qodercn` |
| MiniMax Code（中国版） | `minimax` |
| MiniMax Code（国际版） | `minimaxintl` |
| AutoClaw（智谱） | `autoclaw` |
| AutoClaw（国际版） | `autoclawintl` |
| 智谱 ZCode | `zcode` |
| 字节 TRAE | `trae` |
| 有道 LobsterAI | `lobsterai` |
| 讯飞 Loomy | `loomy` |
| 讯飞 AStudio | `astudio` |
| 商汤 Raccoon Work | `raccoon` |
| 阿里 Accio | `accio` |
| Cline | `cline` |
| OpenCode | `opencode` |
| Gemini Code Assist | `gemini` |
| 魔搭 ModelScope | `modelscope` |

## 首次使用

1. 打开 **Jet Hub 设置页**，选中要用的渠道，点「+ 新建账号」按提示登录。
2. 登录成功后，该渠道的模型会自动出现在 DSH 的模型选择器里。

插件**不注册任何斜杠命令** —— 登录、状态查看、续期、积分领取全部在 Jet Hub
设置页完成。

## 更多

协议细节、实测记录与排障笔记在 [`docs/`](docs/)；开发、构建与测试说明见
[`AGENTS.md`](AGENTS.md)。

## 使用声明

本项目仅供学习研究使用，请遵守各服务提供方的服务条款。
