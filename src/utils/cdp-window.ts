import { WebSocket } from 'ws';

// CDP 窗口控制工具
//
// 直连 browser-level WebSocket 发 Browser.setWindowBounds / Target.activateTarget，
// 不经 cdp-cli subprocess（cdp-cli 无窗口控制命令）。
//
// focusAndMaximize(port, pageId) 调用链：
//
//   resolveBrowserWsUrl(port)
//         └─> fetch http://localhost:${port}/json/version → webSocketDebuggerUrl
//   connectBrowserWs(url)
//         └─> new WebSocket(browserWsUrl) → 等 open
//   sendCdpCommand(ws, 'Browser.getWindowForTarget', { targetId: pageId })
//         └─> { windowId, bounds }
//   sendCdpCommand(ws, 'Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } })
//         └─> 最大化
//   sendCdpCommand(ws, 'Target.activateTarget', { targetId: pageId })
//         └─> 激活置前
//   ws.close()

/** 窗口控制结果 */
export interface WindowControlResult {
  maximized: boolean;
  activated: boolean;
  windowId?: number;
  /** 任一步失败的错误信息（不抛出，调用方黄字提示） */
  error?: string;
}

/** 从 /json/version 拿 browser-level WebSocket URL */
export async function resolveBrowserWsUrl(port: number): Promise<string> {
  const resp = await fetch(`http://localhost:${port}/json/version`);
  if (!resp.ok) {
    throw new Error(`无法获取 CDP 版本信息（端口 ${port}）：${resp.status} ${resp.statusText}`);
  }
  const info = (await resp.json()) as { webSocketDebuggerUrl?: string };
  if (!info.webSocketDebuggerUrl) {
    throw new Error('CDP 版本信息中无 webSocketDebuggerUrl');
  }
  return info.webSocketDebuggerUrl;
}

/** 单条 CDP 命令的消息 ID（递增） */
let cdpMessageId = 1;

/** 发 CDP 命令并等响应（按 id 匹配，过滤无关事件） */
function sendCdpCommand(
  ws: WebSocket,
  method: string,
  params?: Record<string, unknown>
): Promise<any> {
  const id = cdpMessageId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`CDP 命令超时：${method}`));
    }, 10000);

    const handler = (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          clearTimeout(timeout);
          ws.off('message', handler);
          if (msg.error) {
            reject(new Error(`${method} 失败：${msg.error.message}`));
          } else {
            resolve(msg.result);
          }
        }
      } catch {
        // 非 JSON 或无关事件消息，忽略
      }
    };

    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/** 连接 browser-level WebSocket */
function connectBrowserWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('连接 browser WebSocket 超时'));
    }, 10000);

    ws.on('open', () => {
      clearTimeout(timeout);
      resolve(ws);
    });
    ws.on('error', (err: Error) => {
      clearTimeout(timeout);
      reject(new Error(`browser WebSocket 连接失败：${err.message}`));
    });
  });
}

/**
 * 最大化窗口并激活置前
 *
 * 链路：连 browser WS → getWindowForTarget(pageId) 拿 windowId
 *       → setWindowBounds(windowState=maximized) → activateTarget(pageId)
 *
 * 任一步失败不抛，返回标记位，调用方据黄字提示。
 *
 * @param port CDP 远程调试端口（previewscene 用 9223）
 * @param pageId 目标页面 id（cdp-cli tabs 拿到的 pageId 即 targetId）
 */
export async function focusAndMaximize(
  port: number,
  pageId: string
): Promise<WindowControlResult> {
  let ws: WebSocket | undefined;
  try {
    const url = await resolveBrowserWsUrl(port);
    ws = await connectBrowserWs(url);
  } catch (e) {
    return { maximized: false, activated: false, error: (e as Error).message };
  }

  let windowId: number | undefined;
  let maximized = false;
  let activated = false;

  try {
    const r = await sendCdpCommand(ws, 'Browser.getWindowForTarget', {
      targetId: pageId,
    });
    windowId = r?.windowId;
    if (windowId === undefined) {
      try { ws.close(); } catch { /* 忽略关闭错误 */ }
      return { maximized: false, activated: false, error: 'getWindowForTarget 未返回 windowId' };
    }
  } catch (e) {
    try { ws.close(); } catch { /* 忽略关闭错误 */ }
    return { maximized: false, activated: false, error: (e as Error).message };
  }

  try {
    await sendCdpCommand(ws, 'Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'maximized' },
    });
    maximized = true;
  } catch {
    // 最大化失败不阻断激活
  }

  try {
    await sendCdpCommand(ws, 'Target.activateTarget', { targetId: pageId });
    activated = true;
  } catch {
    // 激活失败不阻断整体
  }

  try { ws.close(); } catch { /* 忽略关闭错误 */ }

  return { maximized, activated, windowId };
}
