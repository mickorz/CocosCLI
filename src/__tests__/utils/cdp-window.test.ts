import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 用 vi.hoisted 共享 mock 状态（vi.mock 工厂在 hoist 阶段执行，只能引用 hoisted 变量）
const mock = vi.hoisted(() => ({
  // 每个 CDP method 的预设响应：{ result } 成功 / { error } 失败
  responses: {} as Record<string, { result?: unknown; error?: string }>,
  // 是否模拟连接失败（触发 ws 'error' 而非 'open'）
  failOpen: false,
  // fetch 返回的版本信息（resolveBrowserWsUrl 用）
  versionInfo: { webSocketDebuggerUrl: 'ws://localhost:9223/devtools/browser/abc' } as unknown,
  // fetch 是否失败
  fetchOk: true,
}));

// mock ws 模块：用假 WebSocket 替代真实连接
vi.mock('ws', () => ({
  WebSocket: class FakeWebSocket {
    handlers = new Map<string, (...args: unknown[]) => void>();
    constructor(public url: string) {
      // 下一 tick 触发 open 或 error
      setTimeout(() => {
        if (mock.failOpen) {
          this.handlers.get('error')?.(new Error('连接失败'));
        } else {
          this.handlers.get('open')?.();
        }
      }, 0);
    }
    on(event: string, fn: (...args: unknown[]) => void) {
      this.handlers.set(event, fn);
    }
    off(event: string, _fn: (...args: unknown[]) => void) {
      this.handlers.delete(event);
    }
    send(data: string) {
      const { id, method } = JSON.parse(data);
      const resp = mock.responses[method];
      setTimeout(() => {
        const messageHandler = this.handlers.get('message');
        if (!messageHandler) return;
        if (resp && resp.error) {
          messageHandler(Buffer.from(JSON.stringify({ id, error: { message: resp.error } })));
        } else if (resp) {
          messageHandler(Buffer.from(JSON.stringify({ id, result: resp.result })));
        }
      }, 0);
    }
    close() {
      // 空实现
    }
  },
}));

// mock child_process（osFocusBrowserChrome 用）：可按命令返回不同结果
const osMock = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  originalPlatform: process.platform,
}));
vi.mock('child_process', () => ({ spawnSync: osMock.spawnSync }));

// mock global fetch（resolveBrowserWsUrl 用）
vi.stubGlobal('fetch', vi.fn(async () => ({
  ok: mock.fetchOk,
  status: 200,
  statusText: 'OK',
  json: async () => mock.versionInfo,
} as unknown as Response)));

import { resolveBrowserWsUrl, focusAndMaximize, osFocusBrowserChrome } from '../../utils/cdp-window.js';

const setPlatform = (p: string) => {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
};

beforeEach(() => {
  mock.responses = {};
  mock.failOpen = false;
  mock.versionInfo = { webSocketDebuggerUrl: 'ws://localhost:9223/devtools/browser/abc' };
  mock.fetchOk = true;
  vi.mocked(fetch).mockClear();
  osMock.spawnSync.mockReset();
  setPlatform(osMock.originalPlatform);
});

afterEach(() => {
  setPlatform(osMock.originalPlatform);
});

describe('resolveBrowserWsUrl', () => {
  it('从 /json/version 解析出 webSocketDebuggerUrl', async () => {
    const url = await resolveBrowserWsUrl(9223);
    expect(url).toBe('ws://localhost:9223/devtools/browser/abc');
    expect(fetch).toHaveBeenCalledWith('http://localhost:9223/json/version');
  });

  it('HTTP 不 ok 时抛错', async () => {
    mock.fetchOk = false;
    await expect(resolveBrowserWsUrl(9223)).rejects.toThrow(/无法获取 CDP 版本信息/);
  });

  it('无 webSocketDebuggerUrl 时抛错', async () => {
    mock.versionInfo = {};
    await expect(resolveBrowserWsUrl(9223)).rejects.toThrow(/无 webSocketDebuggerUrl/);
  });
});

describe('focusAndMaximize', () => {
  it('成功路径：最大化 + 激活均成功', async () => {
    mock.responses['Browser.getWindowForTarget'] = { result: { windowId: 42 } };
    mock.responses['Browser.setWindowBounds'] = { result: {} };
    mock.responses['Target.activateTarget'] = { result: {} };

    const r = await focusAndMaximize(9223, 'PAGE_ID');
    expect(r.maximized).toBe(true);
    expect(r.activated).toBe(true);
    expect(r.windowId).toBe(42);
    expect(r.error).toBeUndefined();
  });

  it('getWindowForTarget 未返回 windowId 时返回 error', async () => {
    mock.responses['Browser.getWindowForTarget'] = { result: {} };

    const r = await focusAndMaximize(9223, 'PAGE_ID');
    expect(r.maximized).toBe(false);
    expect(r.activated).toBe(false);
    expect(r.error).toMatch(/未返回 windowId/);
  });

  it('getWindowForTarget 报错时返回 error', async () => {
    mock.responses['Browser.getWindowForTarget'] = { error: '找不到目标' };

    const r = await focusAndMaximize(9223, 'PAGE_ID');
    expect(r.maximized).toBe(false);
    expect(r.activated).toBe(false);
    expect(r.error).toMatch(/找不到目标/);
  });

  it('setWindowBounds 失败但 activate 仍执行', async () => {
    mock.responses['Browser.getWindowForTarget'] = { result: { windowId: 7 } };
    mock.responses['Browser.setWindowBounds'] = { error: '窗口操作被拒' };
    mock.responses['Target.activateTarget'] = { result: {} };

    const r = await focusAndMaximize(9223, 'PAGE_ID');
    expect(r.maximized).toBe(false);
    expect(r.activated).toBe(true);
    expect(r.windowId).toBe(7);
  });

  it('activate 失败但 maximize 已成功', async () => {
    mock.responses['Browser.getWindowForTarget'] = { result: { windowId: 9 } };
    mock.responses['Browser.setWindowBounds'] = { result: {} };
    mock.responses['Target.activateTarget'] = { error: '激活被拒' };

    const r = await focusAndMaximize(9223, 'PAGE_ID');
    expect(r.maximized).toBe(true);
    expect(r.activated).toBe(false);
  });

  it('browser WS 连接失败时返回 error', async () => {
    mock.failOpen = true;

    const r = await focusAndMaximize(9223, 'PAGE_ID');
    expect(r.maximized).toBe(false);
    expect(r.activated).toBe(false);
    expect(r.error).toMatch(/WebSocket 连接失败/);
  });
});

describe('osFocusBrowserChrome', () => {
  it('Windows：AppActivate 返回 OK → true', () => {
    setPlatform('win32');
    osMock.spawnSync.mockImplementation(() => ({ status: 0, stdout: 'OK' }));
    expect(osFocusBrowserChrome()).toBe(true);
  });

  it('Windows：AppActivate 返回 FAIL → false', () => {
    setPlatform('win32');
    osMock.spawnSync.mockImplementation(() => ({ status: 0, stdout: 'FAIL' }));
    expect(osFocusBrowserChrome()).toBe(false);
  });

  it('Windows：powershell 退出码非 0 → false', () => {
    setPlatform('win32');
    osMock.spawnSync.mockImplementation(() => ({ status: 1, stdout: '' }));
    expect(osFocusBrowserChrome()).toBe(false);
  });

  it('macOS：osascript 成功 → true', () => {
    setPlatform('darwin');
    osMock.spawnSync.mockImplementation(() => ({ status: 0, stdout: '' }));
    expect(osFocusBrowserChrome()).toBe(true);
  });

  it('Linux：wmctrl 成功 → true（不试 xdotool）', () => {
    setPlatform('linux');
    osMock.spawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'wmctrl') return { status: 0, stdout: '' };
      return { status: 1, stdout: '' };
    });
    expect(osFocusBrowserChrome()).toBe(true);
    const calls = osMock.spawnSync.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(['wmctrl']);
  });

  it('Linux：wmctrl 失败，xdotool 成功 → true', () => {
    setPlatform('linux');
    osMock.spawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'wmctrl') return { status: 1, stdout: '' };
      return { status: 0, stdout: '' };
    });
    expect(osFocusBrowserChrome()).toBe(true);
  });

  it('Linux：wmctrl 与 xdotool 都失败 → false', () => {
    setPlatform('linux');
    osMock.spawnSync.mockImplementation(() => ({ status: 1, stdout: '' }));
    expect(osFocusBrowserChrome()).toBe(false);
  });

  it('spawnSync 抛错时返回 false 不中断', () => {
    setPlatform('win32');
    osMock.spawnSync.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(osFocusBrowserChrome()).toBe(false);
  });
});
