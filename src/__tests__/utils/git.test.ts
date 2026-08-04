import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isGitRepo } from '../../utils/git.js';

describe('isGitRepo', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cocoscli-git-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('普通目录不是 git 仓库', () => {
    expect(isGitRepo(tmp)).toBe(false);
  });

  it('git init 后是 git 仓库', () => {
    execSync('git init', { cwd: tmp, stdio: 'ignore' });
    expect(isGitRepo(tmp)).toBe(true);
  });
});
