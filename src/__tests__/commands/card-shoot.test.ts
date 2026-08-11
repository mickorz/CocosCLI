import { describe, it, expect } from 'vitest';
import {
  parseFirstNdjson,
  parsePageId,
  parseEvalValue,
  parseSections,
  buildMeasureScript,
  buildStageScript,
  buildCleanupScript,
  computeClipScale,
} from '../../commands/card-shoot.js';

// card shoot 命令的纯函数单测（不依赖 Chrome 运行时）

describe('card-shoot 纯函数', () => {
  describe('parseFirstNdjson', () => {
    it('解析第一行 JSON 对象', () => {
      const out = '噪声行\n{"success":true,"value":"x"}\n{"success":false}';
      expect(parseFirstNdjson(out)).toEqual({ success: true, value: 'x' });
    });

    it('无 JSON 行返回 null', () => {
      expect(parseFirstNdjson('普通文本\n另一行')).toBeNull();
    });

    it('跳过非法 JSON 取下一个合法行', () => {
      expect(parseFirstNdjson('{bad json}\n{"ok":1}')).toEqual({ ok: 1 });
    });
  });

  describe('parsePageId', () => {
    it('从 cdp-cli new 输出取 data.id', () => {
      const out =
        '{"success":true,"message":"Page created","data":{"id":"ABC123","title":"t","url":"u"}}';
      expect(parsePageId(out)).toBe('ABC123');
    });

    it('无 data.id 返回 null', () => {
      expect(parsePageId('{"success":true}')).toBeNull();
    });
  });

  describe('parseEvalValue', () => {
    it('取 eval 的 value 字段', () => {
      const out = '{"success":true,"value":"hello","type":"string"}';
      expect(parseEvalValue(out)).toBe('hello');
    });

    it('无 value 返回 null', () => {
      expect(parseEvalValue('{"success":true}')).toBeNull();
    });
  });

  describe('parseSections', () => {
    it('解析 JSON 字符串数组', () => {
      const v = JSON.stringify([
        { id: 'what', w: 448, h: 300 },
        { id: 'concept', w: 448, h: 500 },
      ]);
      const r = parseSections(v);
      expect(r).toHaveLength(2);
      expect(r[0]).toEqual({ id: 'what', w: 448, h: 300 });
    });

    it('解析已解析数组', () => {
      const r = parseSections([{ id: 'a', w: 10, h: 20 }, { id: 'b' }]);
      expect(r).toHaveLength(2);
      expect(r[1].h).toBe(0); // 缺 h 时兜底为 0
    });

    it('非数组返回空', () => {
      expect(parseSections(null)).toEqual([]);
      expect(parseSections('not json')).toEqual([]);
      expect(parseSections({})).toEqual([]);
    });

    it('过滤无 id 项', () => {
      const r = parseSections([{ w: 1 }, { id: 'x', w: 1, h: 1 }]);
      expect(r).toHaveLength(1);
      expect(r[0].id).toBe('x');
    });
  });

  describe('buildMeasureScript', () => {
    it('包含 section.card 查询与尺寸字段', () => {
      const s = buildMeasureScript();
      expect(s).toContain("querySelectorAll('section.card')");
      expect(s).toContain('offsetWidth');
      expect(s).toContain('offsetHeight');
    });
  });

  describe('buildStageScript', () => {
    it('包含 section id 与目标尺寸及等比缩放', () => {
      const s = buildStageScript('what', 1080, 1440);
      expect(s).toContain('"what"');
      expect(s).toContain('1080');
      expect(s).toContain('1440');
      expect(s).toContain('Math.min(1080/sw, 1440/sh)');
      expect(s).toContain('transform:scale');
      expect(s).toContain('shoot-stage');
      expect(s).toContain('cloneNode');
    });

    it('不同 id 生成不同脚本', () => {
      expect(buildStageScript('a', 1080, 1440)).not.toBe(buildStageScript('b', 1080, 1440));
    });

    it('不同尺寸生成不同脚本', () => {
      expect(buildStageScript('a', 1080, 1440)).not.toBe(buildStageScript('a', 800, 1200));
    });
  });

  describe('buildCleanupScript', () => {
    it('移除舞台节点', () => {
      const s = buildCleanupScript();
      expect(s).toContain('shoot-stage');
      expect(s).toContain('remove');
    });
  });

  describe('computeClipScale', () => {
    it('目标 dpr 除以系统 dpr 抵消系统缩放', () => {
      expect(computeClipScale(2, 1.25)).toBeCloseTo(1.6, 5);
      expect(computeClipScale(2, 2)).toBe(1);
      expect(computeClipScale(3, 1.5)).toBe(2);
    });

    it('系统 dpr 异常时回退为目标 dpr', () => {
      expect(computeClipScale(2, 0)).toBe(2);
      expect(computeClipScale(2, -1)).toBe(2);
    });
  });
});
