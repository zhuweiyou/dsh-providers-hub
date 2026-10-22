/**
 * e2e 凭据读取的**通用**工具（YAML 引号标量还原 + 文件读取）。
 *
 * 这段解析逻辑与具体渠道无关 —— 它解决的是「DSH 的 YAML writer 会把超长标量
 * 折行，直接切 JSON 会抛 `Bad control character in string literal`」这个通用问题。
 * 本模块自原 `workbuddy-credential.ts` 抽出（该文件随渠道移除）。
 *
 * ## 为什么不用 `yaml` 库
 *
 * `yaml` 只在 DSH 自身的 profile 目录里，本项目既未声明该依赖、上层目录也都没有它，
 * `import 'yaml'` 在 e2e 运行时抛 `ERR_MODULE_NOT_FOUND`（已实测）。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 凭据文件路径（DSH 默认位置）。 */
export const CREDENTIALS_PATH = join(homedir(), '.dsh', '.credentials.yaml')

/** 凭据不可用时的统一提示后缀。 */
const HINT = '请先登录该账号，或设置对应的 DSH_*_CREDENTIAL_JSON 环境变量'

/** 取出错误消息（抛出物可能是任意值）。 */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 读取凭据文件；文件不存在时给出清晰中文提示，而不是裸 ENOENT。 */
export function readCredentialsFile(path: string = CREDENTIALS_PATH): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`未找到凭据文件 ${path}（${reason(error)}）；${HINT}`)
  }
}

/** 还原 YAML 引号标量的定界引号与转义。 */

function unfoldQuotes(raw: string, ref: string): string {
  if (raw.startsWith("'")) {
    // 单引号标量：内容里的单引号写作 ''，定界引号是首尾各一个
    const closed = raw.length > 1 && raw.endsWith("'")
    const inner = closed ? raw.slice(1, -1) : raw.slice(1)
    return inner.replace(/''/g, "'")
  }
  if (raw.length > 1 && raw.startsWith('"') && raw.endsWith('"')) {
    // 双引号标量的转义与 JSON 兼容；此处失败说明格式异常，给出带 ref 名的提示
    try {
      return JSON.parse(raw) as string
    } catch (error) {
      throw new Error(`凭据 ${ref} 的 YAML 双引号标量无法解码：${reason(error)}`)
    }
  }
  return raw
}

/**
 * 从 `.credentials.yaml` 文本里取出 `ref` 对应的标量原文。
 *
 * 折行还原规则分两种形态：
 *
 * - **单引号 / 普通标量**：`换行 + 缩进` 在 YAML 流式标量中等价于**一个空格**，
 *   续行按空格拼接。
 * - **双引号标量 + 行尾 `\` 硬续行**：当正文含撇号 `'`（writer 会避开单引号形态）
 *   或控制字符（NEL `\u0085` 等，强制双引号）且超长折行时，writer 改用双引号
 *   形态并在折行处追加行尾 `\`；`\` 表示**删除换行、不插空格**，故须去掉反斜杠
 *   后直接拼接。已用 `yaml@2.9.1` 的真实 writer 输出实测交叉验证。
 *
 * 形态守卫的理由：单引号 / 普通标量的行尾反斜杠只是正文内容（`FOLD_FLOW` 只在
 * 空格处折行，不会插入续行标记），若也按硬续行处理会吞掉正文并漏掉空格。
 */
export function extractYamlScalar(text: string, ref: string): string {
  const lines = text.split(/\r?\n/)
  // ref 虽然约定为 POSIX 标识符，仍转义以防调用方传入带正则元字符的名字
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^(\\s*)${escaped}:[ \\t]*(.*)$`)
  for (let index = 0; index < lines.length; index++) {
    const match = pattern.exec(lines[index])
    if (match === null) continue
    const indent = match[1].length
    const doubleQuoted = match[2].trimStart().startsWith('"')
    let scalar = match[2].trimEnd()
    for (let next = index + 1; next < lines.length; next++) {
      const line = lines[next]
      // 折行不会产生空行；跳过空行以免拼出连续空格
      if (line.trim().length === 0) continue
      // 缩进回到键的层级，说明该标量已结束
      if (line.length - line.trimStart().length <= indent) break
      const piece = line.trim()
      // 仅双引号标量的行尾反斜杠可能是 writer 插入的硬续行标记。判据是末尾连续
      // 反斜杠的**奇偶性**：双引号标量里正文的每个字面反斜杠都转义为 `\\`（偶数），
      // writer 只在此基础上再追加一个续行标记，故奇数个即硬续行 —— 去掉一个反斜杠后
      // 直接拼接（删除换行、不插空格）；偶数个是正文自身的转义反斜杠，在空格处正常
      // 折行，须按空格拼接。单引号 / 普通标量绝不插续行标记，行尾反斜杠只是正文内容。
      const trailing = /\\+$/.exec(scalar)?.[0].length ?? 0
      scalar = doubleQuoted && trailing % 2 === 1 ? scalar.slice(0, -1) + piece : `${scalar} ${piece}`
    }
    return unfoldQuotes(scalar.trim(), ref)
  }
  throw new Error(`未找到凭据 ${ref}；${HINT}`)
}

