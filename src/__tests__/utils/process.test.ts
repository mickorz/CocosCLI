import { describe, it, expect } from 'vitest';
import {
  extractProjectFromCommand,
  isProjectMatch,
  parseWindowsOutput,
} from '../../utils/process.js';

describe('extractProjectFromCommand', () => {
  it('提取带引号的 --project 值', () => {
    expect(extractProjectFromCommand('"C:\\exe" --project "D:\\A"')).toBe('D:\\A');
  });

  it('提取不带引号的 --project 值', () => {
    expect(extractProjectFromCommand('--project D:\\A')).toBe('D:\\A');
  });

  it('兼容单横线 -project', () => {
    expect(extractProjectFromCommand('"exe" -project "D:\\A"')).toBe('D:\\A');
  });

  it('无 --project 返回 null', () => {
    expect(extractProjectFromCommand('"C:\\exe" --something else')).toBeNull();
  });
});

describe('isProjectMatch（防误伤）', () => {
  it('精确匹配命中', () => {
    expect(isProjectMatch('"exe" --project "D:\\A"', 'D:\\A')).toBe(true);
  });

  it('D:\\A 不误匹配 D:\\AB', () => {
    expect(isProjectMatch('"exe" --project "D:\\AB"', 'D:\\A')).toBe(false);
  });

  it('D:\\AB 不误匹配 D:\\A', () => {
    expect(isProjectMatch('"exe" --project "D:\\A"', 'D:\\AB')).toBe(false);
  });

  it('大小写与斜杠差异不影响匹配', () => {
    expect(isProjectMatch('"exe" --project "d:/A"', 'D:\\A')).toBe(true);
    expect(isProjectMatch('"exe" --project "D:\\A\\"', 'D:/A')).toBe(true);
  });

  it('无 --project 不匹配', () => {
    expect(isProjectMatch('"exe"', 'D:\\A')).toBe(false);
  });
});

describe('parseWindowsOutput', () => {
  it('解析多行 PID 与命令行', () => {
    const out =
      '1234|||"C:\\Cocos\\CocosCreator.exe" --project "D:\\A"\n' +
      '5678|||"C:\\Cocos\\CocosCreator.exe" --project "D:\\B"\n';
    const result = parseWindowsOutput(out);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      pid: 1234,
      command: '"C:\\Cocos\\CocosCreator.exe" --project "D:\\A"',
    });
  });

  it('忽略无分隔符与空行', () => {
    expect(parseWindowsOutput('badline\n\n  \n')).toEqual([]);
  });
});
