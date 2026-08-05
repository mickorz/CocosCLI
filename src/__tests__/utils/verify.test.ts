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
  it('session.status busy → BUSY', () => {
    const e = { type: 'session.status', properties: { status: { type: 'busy' } } };
    expect(updateStateFromEvent(e, 'STARTING').state).toBe('BUSY');
  });

  it('session.status idle → IDLE', () => {
    const e = { type: 'session.status', properties: { status: { type: 'idle' } } };
    expect(updateStateFromEvent(e, 'BUSY').state).toBe('IDLE');
  });

  it('session.status retry 视为 BUSY', () => {
    const e = { type: 'session.status', properties: { status: { type: 'retry' } } };
    expect(updateStateFromEvent(e, 'IDLE').state).toBe('BUSY');
  });

  it('session.idle → IDLE', () => {
    const e = { type: 'session.idle' };
    expect(updateStateFromEvent(e, 'BUSY').state).toBe('IDLE');
  });

  it('session.error → FAILED 且带 error', () => {
    const e = { type: 'session.error', properties: { error: { msg: 'boom' } } };
    const r = updateStateFromEvent(e, 'BUSY');
    expect(r.state).toBe('FAILED');
    expect(r.error).toBeTruthy();
  });

  it('message.part.updated tool running → RUNNING_TOOL 且带 tool 名', () => {
    const e = {
      type: 'message.part.updated',
      properties: { part: { type: 'tool', tool: 'navigate_page', state: { status: 'running' } } },
    };
    const r = updateStateFromEvent(e, 'BUSY');
    expect(r.state).toBe('RUNNING_TOOL');
    expect(r.tool).toBe('navigate_page');
  });

  it('未知事件保持当前状态', () => {
    const e = { type: 'unknown.event' };
    expect(updateStateFromEvent(e, 'BUSY').state).toBe('BUSY');
  });
});
