import { describe, it, expect } from 'vitest';
import { hasCommand } from '../../utils/dep-check.js';

describe('hasCommand', () => {
  it('node 命令必然在 PATH（否则当前进程跑不起来）', () => {
    expect(hasCommand('node')).toBe(true);
  });

  it('不存在的命令返回 false', () => {
    expect(hasCommand('this-command-should-not-exist-xyz123')).toBe(false);
  });

  it('cdp-cli 结果为布尔', () => {
    const r = hasCommand('cdp-cli');
    expect(typeof r).toBe('boolean');
  });
});
