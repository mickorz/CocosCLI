import { describe, it, expect } from 'vitest';
import {
  parseTscErrors,
  parseOpencodeEvent,
  updateStateFromEvent,
} from '../../utils/verify.js';

describe('parseTscErrors', () => {
  it('解析 error 行（file(line,col): error TSxxxx: message）', () => {
    const out =
      "src/A.ts(10,5): error TS2304: Cannot find name 'x'.\n" +
      'src/B.ts(20,1): error TS1000: Syntax error.';
    const errors = parseTscErrors(out);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toEqual({
      file: 'src/A.ts',
      line: 10,
      col: 5,
      code: 'TS2304',
      message: "Cannot find name 'x'.",
    });
    expect(errors[1].code).toBe('TS1000');
  });

  it('忽略 warning 与普通日志', () => {
    const out = "src/A.ts(1,1): warning TS0: ...\n普通日志行\nCompiling...";
    expect(parseTscErrors(out)).toHaveLength(0);
  });

  it('空输出返回空数组', () => {
    expect(parseTscErrors('')).toEqual([]);
  });
});

describe('parseOpencodeEvent', () => {
  it('解析 JSON 行', () => {
    expect(parseOpencodeEvent('{"type":"session.idle"}')).toEqual({ type: 'session.idle' });
  });

  it('非 JSON 行返回 null', () => {
    expect(parseOpencodeEvent('not json')).toBeNull();
    expect(parseOpencodeEvent('')).toBeNull();
  });
});

describe('updateStateFromEvent', () => {
  it('step_start → BUSY', () => {
    const e = { type: 'step_start', part: { type: 'step-start' } };
    expect(updateStateFromEvent(e, 'STARTING').state).toBe('BUSY');
  });

  it('step_finish → IDLE', () => {
    const e = { type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } };
    expect(updateStateFromEvent(e, 'BUSY').state).toBe('IDLE');
  });

  it('tool_use running → RUNNING_TOOL 且带 tool 名', () => {
    const e = {
      type: 'tool_use',
      part: { type: 'tool', tool: 'read', state: { status: 'running' } },
    };
    const r = updateStateFromEvent(e, 'BUSY');
    expect(r.state).toBe('RUNNING_TOOL');
    expect(r.tool).toBe('read');
  });

  it('tool_use completed → 状态不变但记录 tool 名', () => {
    const e = {
      type: 'tool_use',
      part: { type: 'tool', tool: 'read', state: { status: 'completed' } },
    };
    const r = updateStateFromEvent(e, 'BUSY');
    expect(r.state).toBe('BUSY');
    expect(r.tool).toBe('read');
  });

  it('text → 状态不变', () => {
    const e = { type: 'text', part: { type: 'text', text: 'ok' } };
    expect(updateStateFromEvent(e, 'BUSY').state).toBe('BUSY');
  });

  it('未知事件保持当前状态', () => {
    const e = { type: 'unknown.event' };
    expect(updateStateFromEvent(e, 'BUSY').state).toBe('BUSY');
  });
});
