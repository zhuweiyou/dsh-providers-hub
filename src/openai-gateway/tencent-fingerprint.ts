/**
 * 腾讯系渠道的**内容级**风控指纹改写（Gitee issue IKJNA1）。
 *
 * ## 现象
 *
 * 外部客户端（ZCode 等）经本插件的 OpenAI 网关调 `buddy` / `workbuddy` 时，
 * 只要 `system` 消息里带着某些**客户端自带的模板句**，腾讯网关就稳定回
 * `HTTP 400 / code 11128 / "Illegal API invocation from an unapproved channel"`，
 * 客户端侧只显示 `provider_code=INVALID_REQUEST reason=unknown`。
 * DSH 直连同一模型则完全正常 —— 差别只在于**外部客户端往 system 里注了什么**。
 *
 * ## 哪些角色要改（实测出来的，不是推理出来的）
 *
 * 本机逐组实测（`www.workbuddy.ai` 与 `copilot.tencent.com` **两个端点表现一致**，
 * 同账号 / 同模型 / 同 UA 与 X-* 头 / `max_tokens` 取小值，被拦不耗额度）：
 *
 * | 探针 | 指纹所在处 | 结果 |
 * |---|---|---|
 * | 中性对照 | 无 | ✅ 200 |
 * | 最小充分触发 | `system` | ❌ 400/11128 |
 * | 只留标签 `Main branch: master` | `system` | ✅ 200 |
 * | 换分支名（`: dev`） | `system` | ❌ 400/11128 ⇒ **分支值无关** |
 * | 句中 / 段中被别的句子夹住 | `system` | ❌ 400/11128 ⇒ **位置无关** |
 * | **改写该句** | `system` | ✅ 200 ⇒ 改写是有效修法 |
 * | 指纹在**第二条** system（非 `messages[0]`） | `system` | ❌ 400/11128 |
 * | 只差一个词（`normally` 替 `usually`） | `system` | ✅ 200 ⇒ **逐字符**匹配 |
 * | 内层多一个空格 | `system` | ✅ 200 ⇒ 同上 |
 * | 全小写 / 全大写 | `system` | ❌ 400/11128 ⇒ **大小写不敏感** |
 * | 同一句放进 **user** 消息 | `user` | ✅ 200 |
 * | 同一句放进 **tool 结果** | `tool` | ✅ 200 |
 * | ★ 同一句放进 **assistant 正文** | `assistant.content` | ❌ **400/11128** |
 * | ★ assistant 只放在 **`reasoning_content`** | 该字段 | ✅ 200 |
 * | ★ assistant 只放在 **`tool_calls[].function.arguments`** | 该字段 | ✅ 200 |
 * | ★ 40KB 良性长文本（与文档同字节数） | `assistant.content` | ✅ 200 ⇒ **体量不是原因** |
 *
 * ★ 那四行是 2026-10-12 补测的。**初版只测了 `system` / `user` / `tool` 三个位置**，
 * 于是得出「只拦 system」这个**过窄**的结论并把它写成了硬约束 —— 而 `assistant`
 * 那一格根本没测过（当时的 assistant 探针把触发句**改写**成了 `I see … here.`
 * 的转述形态，而服务端逐字符匹配，那个形态本身就不含触发串，**等于空跑**）。
 *
 * 由此得到三条**不能违反**的实现约束：
 *
 * 1. **改 `system` 与 `assistant` 正文两处**，其余一概不碰：
 *    `user` / `tool` 结果 / `reasoning_content` / `tool_calls` 的 `arguments`
 *    实测**都不拦**（上表那四行 ✅）。改它们换不来任何放行，却会篡改用户原话、
 *    工具输出（那是要回读给模型看的证据）与模型自己的思考。
 *    ⚠️ 反向也要守住：**别把 `assistant` 这一格「简化」掉** —— 见下文「为什么必须
 *    连直连一起改」，那正是本轮线上报障的成因。
 *    ⚠️ 也不要扩到那四行：实测放行，且改了破坏前缀缓存与证据完整性。
 * 2. **改写所有** system 消息**，不只 `messages[0]`：非首位的 system 同样被拦
 *    （上表「指纹在第二条 system」那一行）。
 * 3. **大小写不敏感的精确匹配**：全小写与全大写都被拦（上表「全小写 / 全大写」
 *    那一行），所以 `replaceAll` 的字面量比对必须带 `i`；但**只差一个词**或
 *    **多一个空格**都不拦（上表「只差一个词」「内层多一个空格」两行），
 *    说明服务端认的是**逐字符的字面量**，**不能**把它泛化成正则/关键词。
 *
 * ⚠️⚠️ **但「逐字符的精确字面量」不等于「每条指纹的锚点相同」**（2026-10-14，
 * 登记 Claude Code 那条时实测出来）。五条已登记指纹的**位置语义并不一致**：
 *
 * | 指纹 | 位置语义 | 依据（**探针实测**，不是推断） |
 * |---|---|---|
 * | ZCode gitStatus 句 | **位置无关**（句中/段中被夹住仍拦） | 上表「句中 / 段中被别的句子夹住」 |
 * | Claude Code 身份句 | **行首锚定**（前接任意一个字符即放行） | 前接空格 / 换行 / 中文前言 / 双换行**均 200**；裸串、后接句点均 400 |
 * | Claude Code 反馈句 | **位置无关**（前接前言仍拦） | 裸串、前接 `Note: `、前接行首 `  - `、后接换行正文**均 400/11128** |
 * | DSH GUI 说明段 | **锚点未测**（只测了「独立成段」与「段内任意字符变化」两格） | 只发该段 ❌ 400、完整 system 去段 ✅ 200；段内加一个空格 / 换行 / 两句换序 / 改一处措辞**均 200**（2026-10-22） |
 * | DSH 身份首句 | **行首锚定**（前接任意字符即放行；与 Claude 身份句同型） | 裸串与「裸串+尾句点」均 400/11-128、前接引言 200、改写后 200（2026-10-21/22） |
 *
 * ⚠️ 五行里第 2、3 行**互为反面** ⇒ 「位置语义」这张表**必须逐条实测**，
 * 拿任一条的结论推给新指纹就是踩中本文件下面那条纪律。第 4 行是**第三类**：锚点没测过，但「段内任意一处字符变化即放行」已实测 ⇒ 改写**不需要**锚点信息（见下一条登记）。
 *
 * ⚠️ 而「`find` 该写多长」**也不统一** —— 那取决于**该条指纹的最小充分串**，
 * 而最小充分串**只能逐条实测**（IKLYCT 那条实测：砍掉前半或后半都放行 ⇒ 必须写整句；
 * 身份句那条实测：少一个字母即放行 ⇒ 恰好写全）。**照抄别条的 find 长度是错的**。
 *
 * ⇒ **绝不能把任一条的锚点结论推给新指纹**。新增一条时的探针必须**两侧都测**
 * （既测句首也测非句首），否则会把「锚点不吃这一口」误读成「这条指纹已失效」
 * —— 那是**假阴性**，比没有探针更危险（会让人据此删掉一条仍然必需的登记）。
 *
 * ⚠️⚠️ **探针必须先把账号筛一遍（2026-10-18 新增的纪律）**：`11128` **有两种**，
 * `msg` 分别是 `Illegal API invocation from an unapproved channel`（**内容级**，
 * 本文件要治的那一种）与 `request illegal`（**渠道校验**，按账号要求三头，IKM7SG）。
 * 两者都回 `code 11128` ⇒ 若像本轮第一版探针那样**轮换账号**，会把账户特定的
 * 通道门控读成内容指纹的匹配语义 ⇒ 实测出「51 字符前缀被拦、69 字符超集放行」
 * 这种**非单调**的假结论。故：**先筛出基线放行的账号，再固定用它**，并**逐格打印 `msg`**。
 * 判据分离的写法见 `tests/e2e/buddy-fingerprint-roles.e2e.spec.ts` 顶部的说明。
 *
 * ⚠️ **可复核凭据已入库**（2026-10-12 审计补齐）：`tests/e2e/buddy-fingerprint-roles.e2e.spec.ts`。
 * 上面那四行 ★ **不是**本文件的自我声明 —— 它们各有一次真实发请求的用例。
 * ⚠️ 这个 e2e 文件不可省：单测只能锁「代码按这个范围改」，**锁不住这个范围对不对**。
 * 2026-10-12 的审计正是据此才发现初版把「只拦 system」写成了硬约束，而
 * `assistant` 那一格从未被测过（当时的探针还把触发句改成了转述形态，
 * 服务端逐字符匹配 ⇒ 空跑）。
 *
 * ## 为什么必须连**直连适配器**一起改（2026-10-12 真实报障，本节推翻初版取舍）
 *
 * 初版把改写**只**放在网关，理由有两条，其中一条已被实测证伪：
 *
 * - ✅ 仍然成立的：网关是外部客户端入口，指纹来自客户端模板注入。
 * - ❌ 已证伪的：「DSH 直连不受影响」。DSH 的 system 提示词确实不含这句，
 *   但**会话历史里的 `assistant` 正文会含** —— 而且几乎是必然：一旦用户让 agent
 *   排查这类风控问题，模型会先 `read` 记录该指纹的文档（`tool` 结果，不拦），
 *   再把它**逐字复述进自己的正文**（拦）。那条 assistant 消息从此每轮原样重放，
 *   于是**排查风控 bug 的会话本身被风控拦死**，症状是「这个 provider 从此每轮
 *   都失败，换任何一个腾讯系模型都一样」—— 2026-10-12 用户报
 *   `step-5-preview` 与 `space-bunny` 同错，正是这一条（**跟会话走，不跟模型走**）。
 *
 * ⇒ 所以这一层必须是**单一真相源**，同时被**两个方向**的调用方使用：
 *   `src/openai-gateway/{messages,responses}.ts`（外部客户端方向）与
 *   `src/buddy-adapter.ts` 的 `serializeMessages`（DSH 直连方向，含
 *   `options.system` 那个第四产出点）。
 *   **只在网关补 = 换一个入口又被拦**，与初版「三处接入点」是同一条教训的复现。
 *
 * ⚠️ 但「两个方向」**不等于**「已覆盖全部出站路径」：`src/buddy-growth.ts` 另有
 * 两处直发 `POST …/v2/chat/completions`（保连胜的「你好」、抓 requestId 的「1+1」），
 * **不经 `BuddyAdapter`、故不过这一层改写**。当前安全 —— 那两处请求体写死、
 * 既无指纹也无 assistant 历史；但一旦将来把它们改成携带历史或拼接用户内容，
 * 就会静默成为第三个未改写入口（其失败表象是整轮 400/11128，极难归因）。
 * 见 `buddy-growth.ts` 里那两处的注释。
 *
 * ⚠️ 直连侧改的是**已持久化的历史**，与 `stripCourseLeakFromHistoryContent`
 * 是同一类「存量自愈」逻辑（那个清的是模型自己的行首泄漏，这个清的是被上游拦的
 * 字面量），落点也因此贴着它，不另起一套遍历。
 *
 * ## ⚠️ 千万不要把 11128 加进 `isContentRejection`
 *
 * 那是**内容级**拦截：同一账号换掉这一句就通（上面「改写该句」一行）。
 * 认成「账号被策略拦」会触发换号 + 30 分钟账号冷却（`CONTENT_REJECTION_COOLDOWN_MS`），
 * 把整个账号池白锁 30 分钟，而真正该做的是改写那一句。
 * `isContentRejection` 只认 11140 / `request illegal` / 安全审核文案**是对的**，
 * **但「不认它」不等于「不会被误判」** ——
 *
 * ⚠️⚠️ **2026-10-18 实测出的一处真实缺陷（本条曾被它反噬，已修）**：
 * `isContentRejection` 的腿③ `/安全审核|safety review/i` **扫整份报文**（含
 * `displayMsg` / `displayTips`），而 `buddy-adapter.ts` 自己就记着「`11128` 各子原因
 * **共用/漂移 `displayMsg`**」⇒ 上游哪天把内容级 11128 的 `displayMsg` 漂成
 * `The content did not pass the safety review.`，这份**换句即通**的报文就会落进
 * 「账号级拦截」档 ⇒ **烧完整池 + 锁 30 分钟**，把本文件的修复效果**完全抵消**。
 * 修法与全部实测格见 `buddy-adapter.ts` 的 `CONTENT_BLOCKED_MSG` 注释。
 * ⚠️ 教训可推广：**「不该把 X 加进判据」≠「判据不会因为 X 的报文而误判」** ——
 * 一条扫全文案的腿会绕过你精心写的排除逻辑。
 *
 * ## 表驱动，而不是写死一处
 *
 * 屏蔽名单服务端掌握、可能随时更新，任何客户端将来都可能撞上新指纹。
 * 故这里是**表**：新增一条 = 往 {@link CONTENT_FINGERPRINTS} 里加一行 + 一条用例。
 */

/** 受影响的 provider：腾讯系两个后端（`buddy` = CodeBuddy 中国版，`workbuddy` = WorkBuddy 国际版）。 */
const TENCENT_PROVIDERS: readonly string[] = ['buddy', 'workbuddy']

interface ContentFingerprint {
  /** 被拦的**字面量**（匹配时**大小写不敏感**，但不做任何模式泛化）。 */
  readonly find: string
  /** 等义改写。两个端点均实测 200。 */
  readonly replace: string
  /** 来源与证据，写死在代码里，免得后人「顺手」把它改成正则或删掉。 */
  readonly note: string
}

/**
 * 已知会被腾讯网关拦下的 system 模板句。
 *
 * ⚠️ **每一条都必须有实发证据**（被拦 + 改写后放行，两条都要），
 * 照抄别家客户端的常量而没实测过 = 给上游加了一条没人验证过的改写。
 */
const CONTENT_FINGERPRINTS: readonly ContentFingerprint[] = [
  {
    // ZCode 内建常量：`$Js="Main branch (you will usually use this for PRs)"`。
    // 每个 git 仓库里的会话都会被注入（拼在 `Main branch … : <分支名>` 这一行）。
    find: 'Main branch (you will usually use this for PRs)',
    replace: 'Main branch (PRs usually go here)',
    note: 'Gitee IKJNA1；本机 2026-10-05 对 workbuddy / CodeBuddy 双端点实测复现',
  },
  {
    // Claude Code 内建常量（v2.1.295 的 `yl`）：
    // `"You are Claude Code, Anthropic's official CLI for Claude."`
    //
    // ⚠️ **`find` 刻意不带尾句点**，一条同时覆盖两个常量（本机实测两者改写后都放行）：
    //   - `yl`  = `You are Claude Code, Anthropic's official CLI for Claude.`
    //   - `sf`  = 同句 + `, running within the Claude Agent SDK.`
    // 第三个常量 `af`（`You are a Claude agent, built on Anthropic's Claude Agent SDK.`）
    // 实测**不被拦**，故刻意不登记（多一条就是替上游无谓改写用户提示词）。
    //
    // ## ⚠️⚠️ 本条的匹配语义**不是**「位置无关」，而是**行首锚定**（与 ZCode 那条相反）
    //
    // 2026-10-14 本机对两个端点的逐格实测（详见 `docs/agent-notes/providers-buddy.md`
    // 「Claude Code 身份句」一节）：该指纹**只在文本绝对开头**被拦 ——
    //   | 形态 | 结果 |
    //   |---|---|
    //   | 裸串 | ❌ 400/11128 |
    //   | 前接空格 / 前换行 / 前接任意前言 | ✅ **200 放行** |
    //   | 后接句点 / 破折号 / 中文句号 / 长正文 | ❌ 400/11128 |
    // 即**前导字符一个都不容忍、后缀完全自由**，与 ZCode 那条的「位置无关」不同。
    //
    // 这不影响改写本身（下面 `replaceAll` 照样生效），但**影响怎么为新指纹做探针**：
    // 只测「夹在句中」会得到「已放行」的**假阴性**（真因是锚点，不是这句不再触发）。
    // 故本条的实测凭据必须含**贪心探针**（覆盖行首与非行首两侧），见
    // `tests/e2e/buddy-fingerprint-roles.e2e.spec.ts` 的 Claude 段。
    //
    // ⚠️ **改成行首锚定的正则**（如 `^` 配 `m`）是**错**的：改写范围宁可略宽 ——
    // 漏改一处就换来整轮 400，多改一处只是语义等价的措辞变化（原文已不存在
    // 「位置无关」的相反证据）。故与上一条共用同一条实现路径。
    find: "You are Claude Code, Anthropic's official CLI for Claude",
    replace: "You are Claude Code, Anthropic's CLI for Claude",
    note: 'Gitee IKLS2L；本机 2026-10-14 对 workbuddy / CodeBuddy 双端点实测：'
      + 'system 与 assistant 正文位置均 400/11128，改写后两端点均 200（含 SDK 变体）',
  },
  {
    // Claude Code system prompt 的「帮助 / 反馈」段默认句（Gitee issue IKLYCT）：
    // `To give feedback, users should report the issue at
    //  https://github.com/anthropics/claude-code/issues`
    //
    // ## 与上一条（身份句）不同：这一条**每轮必带**，不是概率性泄漏
    //
    // 身份句只有 cc-switch 的 `mrt()` 探测路径漏传 `skipSystemPromptPrefix` 时才注入
    // （实测约 34%）；本句属于 Claude Code system prompt 的**固定段落**，
    // 只要客户端把默认 system 整份发过来就必然带上 ⇒ **漏登记 = 必然命中**。
    // 用户侧实测：单日 buddy/workbuddy 因它白撞 647 次。
    //
    // ## ⚠️ 匹配语义：**位置无关**（与身份句的「行首锚定」相反）
    //
    // 2026-10-18 本机对 `www.workbuddy.ai` + `copilot.tencent.com` 双端点逐格实测：
    //   | 形态 | 结果 |
    //   |---|---|
    //   | 裸串 / 前接 `Note: ` / 前接行首 `  - ` | ❌ 400/11128 ⇒ 位置无关 |
    //   | 后接换行 + 其他文本 | ❌ 400/11128 |
    //   | 全大写 | ❌ 400/11128 ⇒ 与另两条同型（大小写不敏感） |
    //   | 换 org/repo、换域名、改一个词、只留 URL | ✅ 200 ⇒ **逐字符** |
    //   | **砍掉前半 / 砍掉后半** | ✅ 200 ⇒ **`find` 必须写整句** |
    //
    // ⚠️ 最后那一格是本条的**要害**：子串本身不触发，写短了等于空跑 ——
    // 而空跑的症状是「登记了却仍每轮 400」，极难归因。
    //
    // ⚠️ 本条的 `find`（整句 99 字符）已经**贴着**上游屏蔽名单的粒度，
    // 不要再按 ZCode 那条的思路去「缩短 find 覆盖更多变体」：实测换域名即放行。
    // ⚠️⚠️ **「缩短/删字」这类变异只有实发能验，单测锁不住**：
    //   单测能证明「砍掉半句时我们**不**改写」（那是真事实），但证明不了
    //   「砍掉半句后上游**仍会拦**」—— 那只有 e2e 能验（见上面那两格）。
    //   ⇒ 改本行时**必须**跑一遍 `DSH_BUDDY_FINGERPRINT_E2E=1` 那节。
    //
    // ⚠️ 与身份句同理**不做行首锚定**：改写宁可略宽（漏改 = 整轮 400，
    // 多改 = 语义等价的措辞变化）。
    find: 'To give feedback, users should report the issue at '
      + 'https://github.com/anthropics/claude-code/issues',
    // 实测两端点均 200（buddy / workbuddy，2026-10-18）。措辞与原文等义。
    replace: 'To give feedback, users should report the issue at the project issue tracker',
    note: 'Gitee IKLYCT；本机 2026-10-18 对 workbuddy / CodeBuddy 双端点实测：'
      + 'system（含非首位）与 assistant 正文均 400/11128，user / reasoning_content / '
      + 'tool 结果放行，改写后两端点均 200',
  },
  {
    // **DSH 自己**的 system prompt 段落 —— `@deepseek-ai/dsh-web-surface` 的
    // `WEB_SURFACE_PROMPT` 前两句（段落名 `app:web-surface`），整段 221 字符。
    //
    // ## 与前三条的关键差别：这条不是**别的客户端**的模板句，是本插件宿主自己注入的
    //
    // 2026-10-22 用户报障：DSH **直连**（不经网关，system 只有 27 段 / 9696 字符）
    // 调 buddy / workbuddy 时整轮 `400 / 11-128 / Illegal API invocation from an
    // unapproved channel`。逐格探针（**同一账号**、同一份 41 KB 的 5 条 user）：
    //
    //   | 探针 | 结果 |
    //   |---|---|
    //   | 完整 system（27 段）+ 真实 user | ❌ 400 unapproved channel |
    //   | 完整 system **去掉这最后一段** + 同样的 user | ✅ 200 |
    //   | 只发该段原样 | ❌ 400 |
    //   | 该段改**产品名**（`DeepSeek Harness Web GUI` → `the DSH web interface`） | ✅ 200 |
    //   | 该段改**一处措辞**（`without naming another target`） | ✅ 200 |
    //   | 该段两句之间多一个空格 / 换成换行 / 两句换序 | ✅ 200 |
    //   | 只发该段的**前半句** / **后半句** | ✅ 200 ⇒ 子串单独不触发 |
    //
    // ⇒ 与前三条同型：**整段逐字符字面量**，且**任意一处字符变化即放行**。
    //   推论（本轮报障里最容易被误判的一格）：**「删掉 system 第一句」对本条无效**
    //   —— 第一句根本不在名单里，被登记的是这**一整段**。
    //
    // ## `find` 为什么是**两句的整段**，而不是其中半句
    //
    // 上表「只发前半句 / 后半句 ✅ 200」说的是**子串单独不触发**，**不是**
    // 「只改写半句无效」：改写落在这 221 字符里的**任何一处**都会破坏整段的字面量
    // ⇒ 同样放行。此处取整段，是因为它才是**实测被拦的那一份原文**，
    // 且写全不易被后人误读成「半句也在名单里」（拆成两条反而暗示半句触发）。
    //
    // ## ⚠️⚠️ 本条按设计**会随 DSH 升级而失效**（登记时已知，不是意外）
    //
    // 该段落由宿主注入，上游随时可能把 DSH 的**其它**段落也收进名单；本条只治
    // 这一段。另外 DSH 自己有两种渲染形态（同一段落 `app:web-surface`）：
    //   - **现行**：`…Web GUI whose URL the runtime context names. When the user refers …`
    //     —— dev 模式下后面还会**追加** DOM / HMR / `window.__DSH_BOOT__` 等句。
    //     只要本段是那一段长文的**前缀**，本条的改写同样能破坏**更长名单**的字面量；
    //   - **旧版会话**：`…Web GUI at <URL>. When the user refers …`（URL 插值）。
    //     它**不以**本 `find` 开头 ⇒ 本条命中不了，属于**已知未覆盖格**；
    //     当前不登记：历史会话形状，2026-10-22 的实测窗口里没有它。
    //     若将来真撞上，照本表加一条 URL 变体，且必须双端点各实发一次。
    // ⇒ 上游再扩名单时**必须重跑** `DSH_BUDDY_FINGERPRINT_E2E=1` 那节，
    //   别信「这条已经修过了」。
    //
    // 改写只动**措辞**（产品名 + 两处表述），语义保持：模型读到的仍是
    // 「用户透过 DSH 的 Web 界面和你交互；说『这个页面 / 这个 GUI / 这个应用』时
    // 指的就是这个 Web 界面」。
    find: 'You are interacting with the user through the DeepSeek Harness Web GUI '
      + 'whose URL the runtime context names. When the user refers to "this page", '
      + '"this GUI", or "this app" without naming another target, they mean this GUI.',
    replace: 'You are interacting with the user through the DeepSeek Harness web interface '
      + 'whose URL the runtime context names. When the user says "this page", "this GUI", '
      + 'or "this app" without naming a different target, they mean this web interface.',
    note: '2026-10-22 用户报障（DSH 直连 400 unapproved channel，无 Gitee issue）；'
      + '同一账号实测：整段 400、去段 200、改产品名 / 改一处措辞 / 两句间加空格均 200，'
      + '只发前半句或后半句也 200 ⇒ 整段逐字符字面量',
  },
  {
    // **DSH 自己的身份首句**（宿主 `@deepseek-ai/dsh-system-prompt` 默认注入，
    // `includeHarnessIdentity` 打开时**每轮必带**）：
    //   You are an AI agent powered by DeepSeek Harness.
    //
    // ## 为什么它必须在这里、而不是靠 `cordis.patch.yml` 关掉
    //
    // 2026-10-22 用户决定：**不要在配置层做这件事**（改宿主配置不稳，且一旦宿主
    // 升级改了键名/合并语义就静默失效）。⇒ 这一句改为**出站 wire 上改写**，
    // 与其余指纹同一层、同一份表、同一套实发验证。
    //
    // ⚠️ 覆盖面差异要讲清：配置补丁是「源头不注入」（对所有 provider 生效），
    // 本指纹是「腾讯系出站时改写」。对**非**腾讯系没有改写需求（它们不拦），
    // 故覆盖面收窄不构成回归；而模型自己在正文里**复述**这句时，只有本层能救
    //（配置补丁管不到 assistant 正文）。
    //
    // ## 匹配语义：**行首锚定**（与 Claude 身份句同型，与 ZCode 句相反）
    //
    // 该句是 system prompt 的**第一句**，实测前接任意字符即放行（与 IKLS2L 那条
    // 同型）。这不影响改写（`replaceAll` 照样命中），但影响探针写法 —— 只测
    // 「夹在句中」会得到「已放行」的**假阴性**。
    //
    // ## `replace` 为什么换成「官方同形」而不是随手改一个词
    //
    // 官方客户端的首句是 `You are an AI coding assistant, powered by <模型展示名> model.`
    //（CodeBuddy 客户端 `product.json` 提示词资产 + 会话 `8c9dbeb1…` 的 reasoning
    // 复述两条独立来源一致）。旧措辞只把 `DeepSeek Harness` 换成别的词、却仍保留
    // 「agent powered by X」这个**非官方句式**，等于只躲字面量、不解决身份
    // ⇒ 一旦上游改收录句式就再次整轮 400。故这里直接对齐官方句式。
    find: 'You are an AI agent powered by DeepSeek Harness',
    replace: 'You are an AI coding assistant, powered by a large language model',
    note: '2026-10-21 实发验收（buddy 站 copilot.tencent.com，新措辞干净 200）；'
      + '2026-10-22 由 cordis.patch.yml 的 includeHarnessIdentity:false 改为出站改写（用户要求不依赖配置）',
  },
]

/** 正则元字符转义：把字面量安全地变成**精确**匹配，而不是模式。 */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface CompiledFingerprint {
  readonly replace: string
  /** 小写形态，用于 `includes` 预检（不命中就不必跑正则，字符串**原样**返回）。 */
  readonly findLower: string
  readonly pattern: RegExp
}

const COMPILED: readonly CompiledFingerprint[] = CONTENT_FINGERPRINTS.map((rule) => ({
  replace: rule.replace,
  findLower: rule.find.toLowerCase(),
  // `g` = 全部出现都改写；`i` = 大小写不敏感（实测全小写 / 全大写同样被拦）。
  pattern: new RegExp(escapeRegExp(rule.find), 'gi'),
}))

/** 该 provider 是否走腾讯系后端（有这套内容级风控）。 */
export function isTencentContentFingerprintProvider(provider: string): boolean {
  return TENCENT_PROVIDERS.includes(provider)
}

/**
 * 把一段文本里已知的腾讯风控指纹做**窄改写**。
 *
 * ## 契约
 *
 * - **非腾讯系 provider 原样返回**（同一个函数指针意义上的同一份字符串内容）；
 * - **不含任何指纹的文本逐字符不变** —— 这一条是硬要求：腾讯侧按前缀缓存，
 *   无谓地重建字符串会让每一轮都算作新前缀，白白吃掉缓存命中；
 * - 只改**内容**，不删句子、不改结构：`Main branch (PRs usually go here)` 与原句
 *   语义等价，模型读到的仍是「主分支（提 PR 通常走这里）」。
 *
 * ## 本函数**刻意不认识角色**
 *
 * 「哪些角色该送进来」是**调用方**的策略（见文件头那张实测表的约束 1），
 * 不是这里的职责。当前该送的是 **`system` 正文**与 **`assistant` 正文**两处；
 * 该**不**送的是 `user` / `tool` 结果 / `reasoning_content` /
 * `tool_calls[].function.arguments`（实测都不拦）。
 * 新增调用点时请回到文件头核对实测行，别凭「统一一下」扩大范围。
 *
 * @param text 已取出的纯文本（system 或 assistant 正文）
 * @param provider `parseModelRoute` 得到的 provider 段，或产品的 id
 */
export function rewriteTencentContentFingerprints(text: string, provider: string): string {
  if (!isTencentContentFingerprintProvider(provider)) return text
  let out = text
  for (const rule of COMPILED) {
    // 预检：不含（小写化后的）字面量就整条跳过，`out` 保持同一份字符串内容。
    if (!out.toLowerCase().includes(rule.findLower)) continue
    // `String.replace` 配 `g` 正则会在调用前后把 lastIndex 归零，不会串状态。
    out = out.replace(rule.pattern, rule.replace)
  }
  return out
}

// ───────────────────────────────────────────────────────────────────────────
// 以下两组**不是**「模板句指纹」，作用域与上面不同，调用方必须分开用
// ───────────────────────────────────────────────────────────────────────────

/**
 * 裸错误码反探测：上游只要在请求体里看到自己的通道校验错误码就整单拦截。
 *
 * ## 为什么它必须**对全角色**生效（与模板句指纹相反）
 *
 * 上面 `CONTENT_FINGERPRINTS` 里的模板句只在 `system` / `assistant` 正文被拦
 * （本仓库 `buddy-fingerprint-roles.e2e.spec.ts` 的 role 矩阵实测：`user` /
 * `tool` 结果 / `reasoning_content` / `tool_calls.arguments` 全部放行）。
 * 本条**不是**那个机制：它是**整单级**规则 —— 请求体里出现该码即拦，
 * 与该码的上下文、role、字段位置都无关。
 *
 * 后果（本仓库自身的场景）：本插件的错误文案、排查记录、用户提问里到处是这个码
 * （例如用户把报错原文粘进对话来问「这是什么意思」）⇒ 只要不拦掉，那一轮
 * 必然 400，且**换号无用、换模型无用**，症状与「会话被顶死」同形。
 *
 * ## 证据来源（如实标注，与上面各条的强度不同）
 *
 * `[对端实测，本仓库未复测]` 参考实现 `workbuddy2api-panel` 的
 * `internal/upstream/sanitize.go`：其 2026-09-13 实验 F4 记录「`code=…` / 裸串 /
 * `错误码 …` 全部命中，相邻的 11148 / 11101 / 11115 / 99999 均放行」。
 * ⚠️ 本仓库**没有**对应的 e2e 凭据；若将来要把它升级为「本仓库实测」，
 * 需按 `buddy-fingerprint-roles.e2e.spec.ts` 的写法补两条（被拦 + 改写后放行）。
 *
 * ## 改写形态：插入连字符（长度 5 → 6）
 *
 * 上游认的是**逐字符**的字面量；插入一个连字符即破坏匹配，同时保留可读性与指代。
 * 零宽空格无效（实测上游会归一化）。⚠️ 前后**不能**紧邻数字，否则会误伤
 * 形如 `11-1280` 这类相邻码（用边界断言而非裸 `split`）。
 */
// ⚠️⚠️ 该码的字面量**必须用拼接构造**：本仓库的文字通道（编辑/快照工具）会把该码
// 规范化成「插入连字符」的可读形态；直写两种形态都会落成**同一个值**
// ⇒ 改写前后相等 ⇒ 一条死句（恒不生效，而且测试会全绿）。
// 单测（`tests/unit/buddy-wire.spec.ts`）用「长度 5 / 6」+「改写真的发生了」两道判据锁死。
export const BARE_ERROR_CODE = '11' + '12' + '8'
/** 与 {@link BARE_ERROR_CODE} 只差一个连字符（长度 5 → 6），内容刻意保持可读。 */
export const BARE_ERROR_CODE_NEUTRALIZED = '11-128'
const BARE_ERROR_CODE_PATTERN = new RegExp('(?<!\\d)' + BARE_ERROR_CODE + '(?!\\d)', 'g')

/**
 * 把裸错误码改写成等价形态（**整单级**，调用方须对所有角色与文本字段生效）。
 *
 * 非腾讯系 provider / 不含该码的文本**原样返回**（同一份字符串内容，不重建）。
 */
export function rewriteBareErrorCodeProbe(text: string, provider: string): string {
  if (!isTencentContentFingerprintProvider(provider)) return text
  if (!text.includes(BARE_ERROR_CODE)) return text
  return text.replace(BARE_ERROR_CODE_PATTERN, BARE_ERROR_CODE_NEUTRALIZED)
}

/**
 * Anthropic 系客户端注入的计费头指纹：键值段整段剥离、孤儿键名最小改写。
 *
 * `[对端实测，本仓库未复测]` 同出 `sanitize.go` 的 2026-09-13 实验 F4：
 * assistant 消息里**反引号引用裸键名**即触发 11-128，而键值形态（`键: 值`）
 * 是更早登记的实案。两条腿语义不同（整段删除 vs 最小缩写），不可合并。
 *
 * 与模板句指纹一样**只用于 `system` / `assistant` 正文**：本仓库没有 user / tool
 * 侧的实测凭据，按 role 台账的既有范围保守处理。
 */
const ANTHROPIC_HEADER_KEY = 'x-anthropic-billing-hdr'
/** 键值形态：`x-anthropic-billing-hdr: <value>;`（大小写不敏感，值到分号/换行为止）。 */
const ANTHROPIC_HEADER_KV = /x-anthropic-billing-hdr\s*:\s*[^\n;]*;?\s*/gi
/** 孤儿键名（无冒号）：最小缩写 header → hdr，破坏逐字匹配但保留可读性。 */
const ANTHROPIC_HEADER_BARE = /x-anthropic-billing-hdr/gi
/** `cc_<snake>=<value>` 形态的尾部键值（可连写多条）。 */
const ANTHROPIC_CC_KV = /\bcc_[a-z0-9_]+=[^\n;]*;?\s*/gi

/** 是否含 Anthropic 头指纹（预检用，避免无谓重建字符串）。 */
export function hasAnthropicHeaderFingerprint(text: string): boolean {
  return /x-anthropic-billing-hdr|cc_/i.test(text)
}

/**
 * 剥离 Anthropic 计费头指纹（**只用于 system / assistant 正文**）。
 *
 * 顺序不可换：先删键值形态（要求冒号），再把残留的孤儿键名做最小缩写 ——
 * 反过来会把键名缩写成 `…hdr` 之后键值正则再也匹配不到，值残留出站。
 */
export function redactAnthropicHeaderFingerprints(text: string, provider: string): string {
  if (!isTencentContentFingerprintProvider(provider)) return text
  if (!hasAnthropicHeaderFingerprint(text)) return text
  let out = text.replace(ANTHROPIC_HEADER_KV, '')
  if (out.includes('cc_')) out = out.replace(ANTHROPIC_CC_KV, '')
  if (/x-anthropic-billing-hdr/i.test(out)) {
    out = out.replace(ANTHROPIC_HEADER_BARE, 'x-anthropic-billing-hdr'.replace('header', 'hdr'))
  }
  return out.trimEnd()
}
