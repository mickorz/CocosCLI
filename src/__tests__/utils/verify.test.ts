import { describe, it, expect } from 'vitest';
import {
  parseTscErrors,
  parseOpencodeEvent,
  updateStateFromEvent,
  judgeNoise,
  classifyDiagnostics,
  ScriptDiagnostic,
} from '../../utils/verify.js';

/** 构造一条诊断（测试辅助） */
const mkDiag = (code: string, message: string): ScriptDiagnostic => ({
  file: 'a.ts',
  line: 1,
  column: 1,
  code,
  message,
});

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

describe('judgeNoise', () => {
  it('TS2503 找不到命名空间归 noise 并提取 ns', () => {
    expect(judgeNoise(mkDiag('TS2503', "Cannot find namespace 'gf'."))).toEqual({ noise: true, ns: 'gf' });
  });

  it('TS1192 无默认导出归 noise（message 含双层引号）', () => {
    expect(judgeNoise(mkDiag('TS1192', `Module '"proto_cm_protocol"' has no default export.`))).toEqual({
      noise: true,
      ns: 'proto_cm_protocol',
    });
  });

  it('TS7006/TS7005 隐式 any 归 noise', () => {
    expect(judgeNoise(mkDiag('TS7006', "Parameter 'x' implicitly has an 'any' type.")).noise).toBe(true);
    expect(judgeNoise(mkDiag('TS7005', "Variable 'x' implicitly has an 'any' type.")).noise).toBe(true);
  });

  it('TS2307 非相对模块归 noise', () => {
    expect(
      judgeNoise(
        mkDiag('TS2307', "Cannot find module 'gamePlatformModule' or its corresponding type declarations.")
      ).noise
    ).toBe(true);
  });

  it('TS2307 相对路径归 real', () => {
    expect(
      judgeNoise(
        mkDiag('TS2307', "Cannot find module './not-exist-module' or its corresponding type declarations.")
      ).noise
    ).toBe(false);
  });

  it('TS2304 首字母大写归 noise', () => {
    expect(judgeNoise(mkDiag('TS2304', "Cannot find name 'RoomPlayerData'.")).noise).toBe(true);
  });

  it('TS2304 首字母小写归 real', () => {
    expect(judgeNoise(mkDiag('TS2304', "Cannot find name 'playerLevel'.")).noise).toBe(false);
  });

  it('TS2322/TS1208/TS2339/TS2551 归 real（不在层1处理，交频次法）', () => {
    expect(judgeNoise(mkDiag('TS2322', "Type 'string' is not assignable to type 'number'.")).noise).toBe(false);
    expect(judgeNoise(mkDiag('TS1208', 'cannot be compiled under --isolatedModules')).noise).toBe(false);
    expect(judgeNoise(mkDiag('TS2339', "Property 'hp' does not exist on type 'Player'.")).noise).toBe(false);
    expect(
      judgeNoise(mkDiag('TS2551', "Property 'x' does not exist on type 'Player'. Did you mean 'y'?")).noise
    ).toBe(false);
  });
});

describe('classifyDiagnostics', () => {
  it('层1明确规则噪音被归类并统计', () => {
    const r = classifyDiagnostics([
      mkDiag('TS2503', "Cannot find namespace 'gf'."),
      mkDiag('TS7006', "Parameter 'x' implicitly has an 'any' type."),
    ]);
    expect(r.noise).toHaveLength(2);
    expect(r.real).toHaveLength(0);
    expect(r.noiseSummary.byCode.TS2503).toBe(1);
    expect(r.noiseSummary.byCode.TS7006).toBe(1);
    expect(r.noiseSummary.byNamespace.gf).toBe(1);
  });

  it('TS2339 同 type > 阈值归 noise（频次阈值法，默认阈值 5）', () => {
    const sameType = Array.from({ length: 6 }, () =>
      mkDiag('TS2339', "Property 'x' does not exist on type 'ScrollPane'.")
    );
    const r = classifyDiagnostics(sameType);
    expect(r.noise).toHaveLength(6);
    expect(r.real).toHaveLength(0);
    expect(r.noiseSummary.byType.ScrollPane).toBe(6);
  });

  it('TS2339 同 type ≤ 阈值归 real（testerror Player 2 条场景）', () => {
    const sameType = [
      mkDiag('TS2339', "Property 'hp' does not exist on type 'Player'."),
      mkDiag('TS2339', "Property 'attack' does not exist on type 'Player'."),
    ];
    const r = classifyDiagnostics(sameType);
    expect(r.real).toHaveLength(2);
    expect(r.noise).toHaveLength(0);
  });

  it('混合：真实错误归 real，噪音归 noise（testerror + 高频 type 噪音）', () => {
    const realErrors: ScriptDiagnostic[] = [
      mkDiag('TS1208', "'01.ts' cannot be compiled under --isolatedModules"),
      mkDiag('TS2322', "Type 'string' is not assignable to type 'number'."),
      mkDiag('TS2304', "Cannot find name 'playerLevel'."),
      mkDiag('TS2339', "Property 'hp' does not exist on type 'Player'."),
      mkDiag('TS2339', "Property 'attack' does not exist on type 'Player'."),
      mkDiag('TS2345', "Argument of type 'string' is not assignable to parameter of type 'number'."),
      mkDiag('TS2554', 'Expected 2 arguments, but got 1.'),
      mkDiag('TS2307', "Cannot find module './not-exist-module' or its corresponding type declarations."),
    ];
    const noiseSameType = Array.from({ length: 10 }, () =>
      mkDiag('TS2339', "Property 'x' does not exist on type 'ScrollPane'.")
    );
    const r = classifyDiagnostics([...realErrors, ...noiseSameType]);
    expect(r.real).toHaveLength(realErrors.length);
    expect(r.noise).toHaveLength(noiseSameType.length);
  });

  it('syntactic 错误全部归 real（不降噪），且计入 syntacticCount', () => {
    const r = classifyDiagnostics([
      { ...mkDiag('TS1005', "',' expected."), category: 'syntactic' },
      { ...mkDiag('TS2503', "Cannot find namespace 'gf'."), category: 'semantic' },
      { ...mkDiag('TS2322', "Type 'string' is not assignable to type 'number'."), category: 'semantic' },
    ]);
    // syntactic TS1005 全 real；semantic 里 TS2503 归 noise、TS2322 归 real
    expect(r.real).toHaveLength(2);
    expect(r.noise).toHaveLength(1);
    expect(r.syntacticCount).toBe(1);
    expect(r.semanticCount).toBe(1);
  });

  it('TS2339 的 typeof import(...) 嵌套引号 type 完整提取，不同 import 不被错误合并（P3.1 regression）', () => {
    // 外层单引号包裹 type，内部双引号是 import 路径
    // 原 [^'"]+ 会在内部双引号截断成 'typeof import('，导致不同 import type 错误合并 > 阈值
    const msgA = "Property 'a' does not exist on type 'typeof import(\"E:/proto_a\")'.";
    const msgB = "Property 'b' does not exist on type 'typeof import(\"E:/proto_b\")'.";
    const diags = [
      ...Array.from({ length: 3 }, () => mkDiag('TS2339', msgA)),
      ...Array.from({ length: 3 }, () => mkDiag('TS2339', msgB)),
    ];
    const r = classifyDiagnostics(diags);
    // 不同 import type 不截断不合并；各自 count=3 ≤ 阈值 5 → 全 real
    expect(r.real).toHaveLength(6);
    expect(r.noise).toHaveLength(0);
  });

  it('TS2339 同一 typeof import(...) > 阈值归 noise，byType key 为完整 type 不截断', () => {
    const msg = "Property 'game_scmj' does not exist on type 'typeof import(\"E:/proto_cm_protocol\")'.";
    const sameType = Array.from({ length: 6 }, () => mkDiag('TS2339', msg));
    const r = classifyDiagnostics(sameType);
    expect(r.noise).toHaveLength(6);
    const fullType = 'typeof import("E:/proto_cm_protocol")';
    expect(r.noiseSummary.byType[fullType]).toBe(6);
    // 不应出现被截断的 'typeof import(' 作为 key
    expect(r.noiseSummary.byType['typeof import(']).toBeUndefined();
  });
});
