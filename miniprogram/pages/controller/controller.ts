import { getWs } from '../../utils/ws-client';
import { getTheme, applyNavBar, Theme } from '../../utils/theme';
import { logger } from '../../utils/logger';

interface Cmd {
  name: string;
  what: number;
  arg1: number;
  arg2: number;
  obj?: string;
  modifiable?: string[];
}

interface LogLine {
  time: string;
  text: string;
}

// 小讯控制器：控制代码走线上 `/api/commands`（对标 admin message 页），
// select 选择 → 按 modifiable 锁定字段 → message.send 发送 + 回声日志。
// 拉取失败用内置预设兜底，页面不白板。
const COMMANDS_URL = 'https://air1.pp.ua/api/commands';

const FALLBACK: Cmd[] = [
  { name: '⏸ 暂停音乐', what: 65536, arg1: 1024, arg2: 3, obj: 'pause', modifiable: ['what', 'arg1', 'arg2', 'obj'] },
  { name: '▶ 继续播放', what: 65536, arg1: 1024, arg2: 4, obj: 'continue', modifiable: ['what', 'arg1', 'arg2', 'obj'] },
  { name: '🔊 TTS播报测试', what: 100, arg1: 0, arg2: 0, obj: '你好，我是小讯', modifiable: ['what', 'arg1', 'arg2', 'obj'] },
  { name: '⚠️ 重启音箱', what: 65536, arg1: 2048, arg2: 10, obj: 'reboot', modifiable: ['what', 'arg1', 'arg2', 'obj'] },
];

const NUM_KEYS = ['what', 'arg1', 'arg2'];

function isEditable(cmd: Cmd, key: string): boolean {
  const m = cmd.modifiable || [];
  for (let i = 0; i < m.length; i++) {
    if (m[i] === key) return true;
  }
  return false;
}

function cmdStr(cmd: Cmd, key: string): string {
  const v = (cmd as unknown as Record<string, unknown>)[key];
  return v === undefined || v === null ? '' : String(v);
}

Component({
  data: {
    theme: 'dark' as Theme,
    commands: [] as Cmd[],
    cmdNames: ['请选择控制代码…'] as string[],
    selIdx: 0,
    selectedName: '',
    form: { what: '', arg1: '', arg2: '', obj: '' },
    locked: { what: true, arg1: true, arg2: true, obj: true },
    loadingCmds: true,
    cmdsError: '',
    sending: false,
    logs: [] as LogLine[],
  },

  lifetimes: {},

  methods: {
    onLoad() {
      const theme = getTheme();
      this.setData({ theme });
      applyNavBar(theme);
      logger.debug('[controller] onLoad');
      const self = this;
      const h = function (d: unknown) { self._onReply(d); };
      (this as unknown as { _h: unknown })._h = h;
      getWs().on('chat.reply', h);
      const snap = getWs().snapshot('chat.reply') as { text?: string } | undefined;
      if (snap) this._onReply(snap);
      this.loadCommands();
    },

    onShow() {
      const theme = getTheme();
      if (theme !== this.data.theme) this.setData({ theme });
      applyNavBar(theme);
    },

    onUnload() {
      const h = (this as unknown as { _h?: (d: unknown) => void })._h;
      if (h) getWs().off('chat.reply', h);
      logger.debug('[controller] onUnload, unsubscribed');
    },

    loadCommands() {
      wx.request({
        url: COMMANDS_URL,
        success: (res) => {
          const body = res.data as Cmd[] | { commands?: Cmd[] } | undefined;
          const list = Array.isArray(body) ? body : (body && (body as { commands?: Cmd[] }).commands) || [];
          if (res.statusCode >= 200 && res.statusCode < 300 && list.length > 0) {
            this.applyCommands(list, '');
          } else {
            logger.warn('[controller] commands empty, fallback:', res.statusCode);
            this.applyCommands(FALLBACK, '线上列表为空，已用内置预设兜底');
          }
        },
        fail: (err) => {
          logger.warn('[controller] commands fetch fail', err);
          this.applyCommands(FALLBACK, '控制代码加载失败，已用内置预设兜底');
        },
      });
    },

    applyCommands(list: Cmd[], errMsg: string) {
      const names = ['请选择控制代码…'];
      for (let i = 0; i < list.length; i++) names.push(list[i].name || ('命令' + (i + 1)));
      this.setData({
        commands: list as never,
        cmdNames: names as never,
        selIdx: 0 as never,
        selectedName: '' as never,
        form: ({ what: '', arg1: '', arg2: '', obj: '' } as never),
        loadingCmds: false as never,
        cmdsError: errMsg as never,
      });
    },

    _onReply(d: unknown) {
      const obj = ((d || {}) as { text?: string; ok?: boolean });
      const text = obj.text !== undefined ? String(obj.text) : JSON.stringify(d);
      logger.debug('[controller] chat.reply event:', text);
      this.pushLog('📥 回声：' + text);
    },

    pushLog(text: string) {
      const d = new Date();
      const hh = d.getHours() < 10 ? '0' + d.getHours() : '' + d.getHours();
      const mm = d.getMinutes() < 10 ? '0' + d.getMinutes() : '' + d.getMinutes();
      const ss = d.getSeconds() < 10 ? '0' + d.getSeconds() : '' + d.getSeconds();
      const list = [{ time: hh + ':' + mm + ':' + ss, text }].concat(this.data.logs as LogLine[]);
      this.setData({ logs: list.slice(0, 20) as never });
    },

    onCmdChange(e: WechatMiniprogram.CustomEvent) {
      const idx = Number((e.detail as { value: number }).value) || 0;
      if (idx <= 0) {
        this.setData({
          selIdx: 0 as never,
          selectedName: '' as never,
          form: ({ what: '', arg1: '', arg2: '', obj: '' } as never),
        });
        return;
      }
      const list = this.data.commands as Cmd[];
      const cmd = list[idx - 1];
      if (!cmd) return;
      this.setData({
        selIdx: idx as never,
        selectedName: (cmd.name as never),
        form: ({
          what: cmdStr(cmd, 'what'),
          arg1: cmdStr(cmd, 'arg1'),
          arg2: cmdStr(cmd, 'arg2'),
          obj: cmdStr(cmd, 'obj'),
        } as never),
        locked: ({
          what: !isEditable(cmd, 'what'),
          arg1: !isEditable(cmd, 'arg1'),
          arg2: !isEditable(cmd, 'arg2'),
          obj: !isEditable(cmd, 'obj'),
        } as never),
      });
      logger.debug('[controller] select:', cmd.name);
    },

    onFormInput(e: WechatMiniprogram.CustomEvent) {
      const field = (e.currentTarget.dataset.field || '') as string;
      const value = (e.detail as { value: string }).value;
      const form = { ...(this.data.form as Record<string, string>) };
      form[field] = value;
      this.setData({ form: form as never });
    },

    submitForm() {
      const name = (this.data.selectedName as string) || '自定义消息';
      const f = this.data.form as Record<string, string>;
      const nums: Record<string, number> = {};
      for (let i = 0; i < NUM_KEYS.length; i++) {
        const k = NUM_KEYS[i];
        const n = Number((f[k] || '').trim());
        if (isNaN(n)) {
          wx.showToast({ title: k + ' 须为数字', icon: 'none' });
          return;
        }
        nums[k] = n;
      }
      // 重启类二次确认（服务端列表里的「重启」同理）
      if (name.indexOf('重启') >= 0 || name.toLowerCase().indexOf('reboot') >= 0) {
        const self = this;
        wx.showModal({
          title: '确认执行？',
          content: name + ' 可能中断播放或重启设备，确认发送？',
          success(r) {
            if (r.confirm) self.doSend(nums['what'], nums['arg1'], nums['arg2'], f['obj'] || '', name);
          },
        });
        return;
      }
      this.doSend(nums['what'], nums['arg1'], nums['arg2'], f['obj'] || '', name);
    },

    doSend(what: number, arg1: number, arg2: number, obj: string, label: string) {
      this.setData({ sending: true as never });
      logger.debug('[controller] send message.send:', { what, arg1, arg2, obj });
      this.pushLog('📤 ' + label + ' → (' + what + ',' + arg1 + ',' + arg2 + ')');
      try {
        getWs().send('message.send', { what, arg1, arg2, obj });
        logger.debug('[controller] sent ok');
      } catch (e) {
        logger.error('[controller] send failed', e);
        wx.showToast({ title: '发送失败', icon: 'none' });
      }
      const self = this;
      setTimeout(() => {
        // 盲投递：只等回声事件，不做成功判定；超时仅提示查看日志
        self.setData({ sending: false as never });
        logger.debug('[controller] send window closed for', label);
      }, 5000);
    },

    clearLogs() {
      this.setData({ logs: [] as never });
    },
  },
});
