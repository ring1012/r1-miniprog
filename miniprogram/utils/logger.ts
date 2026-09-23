// 全局日志门面：按微信环境自动切换，无需上线前手动改级别。
// develop（开发版/开发者工具）/ trial（体验版）-> debug 全量；release（正式版）-> 仅 error。
// 级别顺序：debug < info < warn < error，低级别会被高阈值过滤掉。
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type EnvVersion = 'develop' | 'trial' | 'release';

/** 兜底默认值（取不到环境信息时用，一般走不到）。 */
export const LOG_LEVEL: LogLevel = 'debug';

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let runtimeOverride: LogLevel | null = null;

/** 运行时覆盖（优先级高于常量，可用于调试面板切换）。 */
export function setLogLevel(level: LogLevel): void {
  runtimeOverride = level;
}

function currentLevel(): LogLevel {
  if (runtimeOverride) return runtimeOverride;
  try {
    const saved = wx.getStorageSync('logLevel') as LogLevel | undefined;
    if (saved === 'debug' || saved === 'info' || saved === 'warn' || saved === 'error') {
      return saved;
    }
  } catch {
    // storage 不可用时继续按环境自动判定
  }
  return levelForEnv(getEnvVersion());
}

/** 当前微信环境：develop=开发版（含开发者工具预览/真机调试），trial=体验版，release=正式版。 */
export function getEnvVersion(): EnvVersion | undefined {
  try {
    const info = wx.getAccountInfoSync() as unknown as {
      miniProgram?: { envVersion?: EnvVersion };
    } | null;
    const v = info && info.miniProgram ? info.miniProgram.envVersion : undefined;
    if (v === 'develop' || v === 'trial' || v === 'release') return v;
  } catch {
    // 低版本基础库无此接口，回 undefined 走兜底
  }
  return undefined;
}

/** 环境 -> 级别映射：只有 release 是 error，其余全 debug，上线无需手动改。 */
export function levelForEnv(env?: EnvVersion): LogLevel {
  if (env === 'release') return 'error';
  if (env === 'develop' || env === 'trial') return 'debug';
  return LOG_LEVEL;
}

function enabled(level: LogLevel): boolean {
  return ORDER[level] >= ORDER[currentLevel()];
}

export const logger = {
  debug(...args: unknown[]): void {
    // 注：不用 console.debug，它在开发者工具里默认被归到 Verbose 且隐藏；
    // 用 console.log 保证 debug 在 develop/trial 下默认可见，release 下被级别拦截。
    if (enabled('debug')) console.log('[debug]', ...args);
  },
  info(...args: unknown[]): void {
    if (enabled('info')) console.info(...args);
  },
  warn(...args: unknown[]): void {
    if (enabled('warn')) console.warn(...args);
  },
  error(...args: unknown[]): void {
    if (enabled('error')) console.error(...args);
  },
};
