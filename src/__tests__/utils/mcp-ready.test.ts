import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import * as net from 'net';
import { AddressInfo } from 'net';
import {
  httpGetJson,
  fetchMcpHealth,
  waitForMcpReady,
  describeMcpPhase,
} from '../../utils/verify.js';

/**
 * mcp-ready 测试：真实回环 HTTP server（listen(0) 取临时端口），不 mock http。
 * 与仓库 utils 测试风格一致（真实环境 + 真实等待，intervalMs/timeoutMs 用小值）。
 */

/** 已启动待清理的 server 列表 */
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        })
    )
  );
  servers.length = 0;
});

/** 起一个 /health 返回指定响应的 server，返回端口 */
async function startHealthServer(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

/** JSON 响应辅助 */
function jsonRes(res: http.ServerResponse, body: unknown): void {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

/** 找一个几乎不可能被监听的端口（连接必然拒绝） */
async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

describe('httpGetJson', () => {
  it('正常 JSON：解析返回对象', async () => {
    const port = await startHealthServer((req, res) => {
      if (req.url === '/health') jsonRes(res, { ready: true, tools: 46 });
      else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    const obj = await httpGetJson(`http://127.0.0.1:${port}/health`);
    expect(obj).toEqual({ ready: true, tools: 46 });
  });

  it('404：返回 null', async () => {
    const port = await startHealthServer((_req, res) => {
      res.statusCode = 404;
      res.end('not found');
    });
    expect(await httpGetJson(`http://127.0.0.1:${port}/health`)).toBeNull();
  });

  it('200 但坏 JSON：返回 null', async () => {
    const port = await startHealthServer((_req, res) => {
      res.statusCode = 200;
      res.end('not-json{{{');
    });
    expect(await httpGetJson(`http://127.0.0.1:${port}/health`)).toBeNull();
  });

  it('连接拒绝：返回 null', async () => {
    const port = await freePort();
    expect(await httpGetJson(`http://127.0.0.1:${port}/health`)).toBeNull();
  });
});

describe('fetchMcpHealth', () => {
  it('新版响应：reachable + health 都有', async () => {
    const port = await startHealthServer((_req, res) =>
      jsonRes(res, { status: 'ok', ready: false, phase: 'sceneLoading', tools: 10 })
    );
    const check = await fetchMcpHealth(port);
    expect(check.reachable).toBe(true);
    expect(check.health?.ready).toBe(false);
    expect(check.health?.phase).toBe('sceneLoading');
  });

  it('200 坏 JSON：reachable true + health null（与旧 httpOk 判据一致）', async () => {
    const port = await startHealthServer((_req, res) => {
      res.statusCode = 200;
      res.end('broken');
    });
    const check = await fetchMcpHealth(port);
    expect(check.reachable).toBe(true);
    expect(check.health).toBeNull();
  });

  it('不可达：reachable false', async () => {
    const port = await freePort();
    const check = await fetchMcpHealth(port);
    expect(check.reachable).toBe(false);
    expect(check.health).toBeNull();
  });
});

describe('waitForMcpReady', () => {
  it('立即就绪：ready:true 直接 ok，legacy false', async () => {
    const port = await startHealthServer((_req, res) =>
      jsonRes(res, { status: 'ok', ready: true, phase: 'ready', tools: 46, version: '1.5.5' })
    );
    const result = await waitForMcpReady(port, { timeoutMs: 2_000, intervalMs: 50 });
    expect(result.ok).toBe(true);
    expect(result.legacy).toBe(false);
    expect(result.phase).toBe('ready');
    expect(result.health?.tools).toBe(46);
  });

  it('阶段推进：sceneLoading 两次后 ready，onProgress 依次收到阶段变化', async () => {
    let hits = 0;
    const port = await startHealthServer((_req, res) => {
      hits += 1;
      if (hits <= 2) jsonRes(res, { status: 'ok', ready: false, phase: 'sceneLoading' });
      else jsonRes(res, { status: 'ok', ready: true, phase: 'ready' });
    });
    const phases: string[] = [];
    const result = await waitForMcpReady(port, {
      timeoutMs: 3_000,
      intervalMs: 50,
      onProgress: (p) => phases.push(p),
    });
    expect(result.ok).toBe(true);
    // 首 tick sceneLoading（connecting 之后第一次成功探测即切阶段），随后 ready
    expect(phases).toEqual(['sceneLoading', 'ready']);
    expect(result.phase).toBe('ready');
  });

  it('旧版降级：无 ready 字段 → ok 且 legacy true', async () => {
    const port = await startHealthServer((_req, res) =>
      jsonRes(res, { status: 'ok', tools: 46 })
    );
    const result = await waitForMcpReady(port, { timeoutMs: 2_000, intervalMs: 50 });
    expect(result.ok).toBe(true);
    expect(result.legacy).toBe(true);
  });

  it('不可达超时：ok false，phase connecting', async () => {
    const port = await freePort();
    const result = await waitForMcpReady(port, { timeoutMs: 300, intervalMs: 80 });
    expect(result.ok).toBe(false);
    expect(result.phase).toBe('connecting');
  });

  it('卡阶段超时：恒 sceneLoading → ok false，phase sceneLoading', async () => {
    const port = await startHealthServer((_req, res) =>
      jsonRes(res, { status: 'ok', ready: false, phase: 'sceneLoading' })
    );
    const result = await waitForMcpReady(port, { timeoutMs: 300, intervalMs: 80 });
    expect(result.ok).toBe(false);
    expect(result.phase).toBe('sceneLoading');
  });

  it('404：视为不可达（connecting 超时）', async () => {
    const port = await startHealthServer((_req, res) => {
      res.statusCode = 404;
      res.end('{}');
    });
    const result = await waitForMcpReady(port, { timeoutMs: 300, intervalMs: 80 });
    // httpGetJson 对 404 返回 null，但 httpOk 判据 <400 → reachable false → connecting
    expect(result.ok).toBe(false);
    expect(result.phase).toBe('connecting');
  });
});

describe('describeMcpPhase', () => {
  it('各阶段有中文描述', () => {
    expect(describeMcpPhase('connecting')).toContain('server');
    expect(describeMcpPhase('sceneLoading')).toContain('场景');
    expect(describeMcpPhase('ready')).toBe('就绪');
  });
});
