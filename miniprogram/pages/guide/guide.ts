import { getTheme, applyNavBar, Theme } from '../../utils/theme';
import { logger } from '../../utils/logger';

// 功能指引：纯静态页（文案对标 admin AboutContent），无 ws 订阅。
Component({
  data: {
    theme: 'dark' as Theme,
  },
  lifetimes: {},
  methods: {
    onLoad() {
      const theme = getTheme();
      this.setData({ theme });
      applyNavBar(theme);
      logger.debug('[guide] onLoad');
    },
    onShow() {
      const theme = getTheme();
      if (theme !== this.data.theme) this.setData({ theme });
      applyNavBar(theme);
    },
  },
});
