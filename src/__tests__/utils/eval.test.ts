import { describe, it, expect } from 'vitest';
import { buildEvalRequest, parseEvalResponse } from '../../utils/verify.js';
import { readEvalSource } from '../../commands/eval.js';

describe('buildEvalRequest', () => {
  it('context 归一化：editor 保留，undefined/乱串/scene 归 scene', () => {
    expect(buildEvalRequest('editor', 'return 1')!.context).toBe('editor');
    expect(buildEvalRequest(undefined, 'return 1')!.context).toBe('scene');
    expect(buildEvalRequest('scene', 'return 1')!.context).toBe('scene');
    expect(buildEvalRequest('乱串', 'return 1')!.context).toBe('scene');
  });

  it('args：合法 JSON 对象解析，默认 {}', () => {
    expect(buildEvalRequest(undefined, 'return 1', '{"a":1}')!.args).toEqual({ a: 1 });
    expect(buildEvalRequest(undefined, 'return 1')!.args).toEqual({});
  });

  it('args：非法 JSON / 非对象（数组/null）返回 {error}', () => {
    expect('error' in buildEvalRequest(undefined, 'return 1', '{坏的')).toBe(true);
    expect('error' in buildEvalRequest(undefined, 'return 1', '[1,2]')).toBe(true);
    expect('error' in buildEvalRequest(undefined, 'return 1', 'null')).toBe(true);
  });

  it('code 原样透传', () => {
    expect(buildEvalRequest(undefined, 'return args.x')!.code).toBe('return args.x');
  });
});

describe('parseEvalResponse', () => {
  it('resp 为 null：ran=false（超时或服务器无响应）', () => {
    const r = parseEvalResponse(null);
    expect(r.ran).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('--timeout');
  });

  it('成功包络：ran=true ok=true，data/message 透传', () => {
    const r = parseEvalResponse({
      success: true,
      tool: 'script_execute_script',
      result: { success: true, data: { answer: 2 }, message: 'executed' },
    });
    expect(r).toEqual({ ran: true, ok: true, data: { answer: 2 }, message: 'executed' });
  });

  it('工具内失败（用户代码抛错）：ran=true ok=false 带 error', () => {
    const r = parseEvalResponse({
      success: true,
      tool: 'script_execute_script',
      result: { success: false, error: 'boom' },
    });
    expect(r.ran).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('boom');
  });

  it('工具内失败且无 error 字段：兜底 JSON.stringify(result)', () => {
    const r = parseEvalResponse({
      result: { success: false, weird: 1 },
    });
    expect(r.ran).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.error).toBe(JSON.stringify({ success: false, weird: 1 }));
  });

  it('HTTP 500 包络（顶层 success:false 无 result）：ran=false 带 error', () => {
    const r = parseEvalResponse({ success: false, error: 'Unknown tool: script_execute_script', tool: 'script/execute_script' });
    expect(r.ran).toBe(false);
    expect(r.error).toBe('Unknown tool: script_execute_script');
  });

  it('result 非对象（数组）：ran=false 兜底 stringify', () => {
    const r = parseEvalResponse({ result: [1, 2] });
    expect(r.ran).toBe(false);
  });
});

describe('readEvalSource', () => {
  it('code 与 -f 都空：返回 {error}（提示双入口）', () => {
    const r = readEvalSource(undefined, undefined);
    expect('error' in r).toBe(true);
    expect((r as { error: string }).error).toContain('-f');
  });

  it('code 为空白串等价于空', () => {
    expect('error' in readEvalSource('   ', undefined)).toBe(true);
  });

  it('命令行直传：source 为 cli', () => {
    const r = readEvalSource('return 1 + 1', undefined);
    expect(r).toEqual({ code: 'return 1 + 1', source: 'cli' });
  });

  it('-f 文件不存在：返回 {error} 含路径', () => {
    const r = readEvalSource(undefined, 'Z:/不存在/no-such-file.js');
    expect('error' in r).toBe(true);
    expect((r as { error: string }).error).toContain('no-such-file.js');
  });
});
