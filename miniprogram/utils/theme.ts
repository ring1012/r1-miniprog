// 主题：深色（默认）/ 浅色 / 紫色 / 蓝色 / 绿色，存 storage 全局持久化。
// 注意：ES5 引擎，本文件只用三元和 if 判空。
export type Theme = 'dark' | 'light' | 'purple' | 'blue' | 'green';

export interface ThemeOption {
  key: Theme;
  name: string;
}

export const THEMES: ThemeOption[] = [
  { key: 'dark', name: '深色' },
  { key: 'light', name: '浅色' },
  { key: 'purple', name: '紫色' },
  { key: 'blue', name: '蓝色' },
  { key: 'green', name: '绿色' },
];

const NAV_BG: Record<Theme, string> = {
  dark: '#0a0a0a',
  light: '#f5f5f5',
  purple: '#150f22',
  blue: '#0a141f',
  green: '#0a1512',
};

const THEME_KEY = 'theme';

function isTheme(v: unknown): v is Theme {
  return v === 'dark' || v === 'light' || v === 'purple' || v === 'blue' || v === 'green';
}

export function getTheme(): Theme {
  try {
    const saved = wx.getStorageSync(THEME_KEY) as unknown;
    if (isTheme(saved)) return saved;
  } catch {
    // storage 不可用时回落默认
  }
  return 'dark';
}

export function setTheme(theme: Theme): void {
  try {
    wx.setStorageSync(THEME_KEY, theme);
  } catch {
    // ignore
  }
  applyNavBar(theme);
}

/** 导航栏跟随主题，避免深色页配白条。 */
export function applyNavBar(theme: Theme): void {
  try {
    if (theme === 'light') {
      wx.setNavigationBarColor({ frontColor: '#000000', backgroundColor: NAV_BG[theme] });
    } else {
      wx.setNavigationBarColor({ frontColor: '#ffffff', backgroundColor: NAV_BG[theme] });
    }
  } catch {
    // ignore
  }
}
