/**
 * 「侧栏入口」偏好的客户端状态与读写（**无 React、无组件依赖**）。
 *
 * 单独成文件是为了避开循环 import：`sidebar-entry.js` 需要 `JetHubPage`，
 * 而页头开关所在的 `jet-hub.js` 又需要本状态 —— 三份模块若互相 import，
 * esbuild 打包后会在模块初始化顺序上留下 TDZ 风险（真机表现是打开设置页
 * 白屏、控制台一条 `Cannot access 'X' before initialization`）。
 *
 * 存宿主侧而不是浏览器本地存储：Web 端 origin 是 `http://127.0.0.1:<随机端口>`，
 * 换端口本地存储就清空，用户会看到「开关自己变回开」。客户端也不该读写浏览器存储
 * （本仓库有一条守卫在扫客户端源码里的存储 API 字面量）。
 */

/**
 * `main` 槽的 key，同时也是 `sidebar.panellist` 的 id 与 `settings.section` 的 id。
 *
 * 宿主按「侧栏 id = 主面板 key」派发，三者不一致时界面看起来完全正常，
 * 只有点下去才会发现「面板没换」。
 */
export const JET_HUB_PANEL_KEY = 'jet-hub';

/**
 * 侧栏行在主导航里的位置。
 *
 * 现有占用：插件 0、插件市场 1、自动化任务 10、记忆系统 30 —— 取 20 落在
 * 自动化任务与记忆系统之间（Jet Hub 偏工具，不是会话入口）。
 */
export const JET_HUB_SIDEBAR_ORDER = 20;

/**
 * 读宿主偏好的超时（毫秒）。
 *
 * 超时按「显示」兜底：一次卡住的 RPC 不该把入口藏掉，用户会以为插件没装好。
 */
const SIDEBAR_ENTRY_READ_TIMEOUT_MS = 5000;

/**
 * 进程内的「侧栏入口」状态。
 *
 * `null` = **还没从宿主读到**（启动中，侧栏行暂不注册）；
 * `true` / `false` = 宿主明确给出的值。
 */
let enabled = null;

/** 最近一次读取是否失败（页头开关据此显示降级文案，不据此禁用开关）。 */
let readFailed = false;

/** 订阅者集合：页头开关与侧栏注册两边共用同一份状态。 */
const listeners = new Set();

/**
 * 侧栏行当前是否应当显示（`null` 视为显示）。
 *
 * @returns {boolean}
 */
export function sidebarEntryVisible() {
  return enabled !== false;
}

/**
 * 最近一次「读宿主偏好」是否失败。
 *
 * ⚠️ 只用于**提示**：失败时仍按「显示」兜底、开关仍可点 —— 与网关面板
 * 「附属字段采集失败不该把用户挡在自救路径之外」同一取向。
 *
 * @returns {boolean}
 */
export function sidebarEntryReadFailed() {
  return readFailed;
}

/**
 * 订阅「侧栏入口」状态的变化（显示与否、读取失败标记都会触发）。
 *
 * @param {() => void} listener
 * @returns {() => void} 取消订阅
 */
export function subscribeSidebarEntry(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 广播一次状态变化。**无变化时不广播**，避免页头开关无谓重渲染。
 *
 * @param {unknown} nextEnabled
 * @param {boolean} nextFailed
 */
function publish(nextEnabled, nextFailed) {
  const normalized = nextEnabled !== false;
  if (enabled === normalized && readFailed === nextFailed) return;
  enabled = normalized;
  readFailed = nextFailed;
  // 复制一份再遍历：监听器里可能自己退订（例如侧栏行被撤销）。
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (caught) {
      console.error('[jet-hub] 侧栏入口监听器抛错', caught);
    }
  }
}

/**
 * 组装读取用的 AbortSignal；老内核没有 `AbortSignal.timeout` 就不带信号。
 *
 * @returns {AbortSignal | undefined}
 */
function readSignal() {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return undefined;
  return AbortSignal.timeout(SIDEBAR_ENTRY_READ_TIMEOUT_MS);
}

/**
 * 从宿主读一次「侧栏入口」偏好（只读，不写回）。
 *
 * 调用点有两处且**都必要**：`apply()` 里注册侧栏行之前读一次（决定这一行要不要
 * 出现），页头开关挂载时也读一次（把「读取失败」标记显示出来）。
 *
 * @param {(endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>} rpcCall
 * @returns {Promise<boolean>} 读到的值；失败时沿用当前状态（兜底显示）
 */
export async function loadSidebarEntry(rpcCall) {
  try {
    const result = await rpcCall('sidebarEntry.getEnabled', {}, readSignal());
    if (typeof result?.enabled === 'boolean') {
      // 宿主明确给了值：清掉失败标记。
      publish(result.enabled, false);
    } else {
      // 回包形状不对：按读取失败处理，但仍保持当前（默认显示）状态。
      publish(sidebarEntryVisible(), true);
    }
  } catch (caught) {
    console.warn('[jet-hub] 读取侧栏入口偏好失败，按显示处理', caught);
    publish(sidebarEntryVisible(), true);
  }
  return sidebarEntryVisible();
}

/**
 * 写回「侧栏入口」偏好，并以宿主返回值更新本地状态。
 *
 * ⚠️ **不猜默认值**：只有宿主明确回 `{ enabled: boolean }` 才更新；失败直接
 * 抛给调用方（页头开关要能回滚并提示用户 —— 静默改本地状态会造成「开关看着
 * 开了、重启后又变回来」）。
 *
 * @param {(endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>} rpcCall
 * @param {boolean} next
 * @returns {Promise<boolean>} 宿主确认后的值
 */
export async function setSidebarEntry(rpcCall, next) {
  const result = await rpcCall('sidebarEntry.setEnabled', { enabled: next !== false });
  if (typeof result?.enabled !== 'boolean') {
    throw new Error('侧栏入口偏好没有返回 enabled');
  }
  publish(result.enabled, false);
  return result.enabled;
}
