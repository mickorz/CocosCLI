import ora from 'ora';
import type { Ora } from 'ora';

// 纯文本 spinner 工具
//
// 用 ASCII 动画帧 + [完成]/[失败] 标记替代 ora 默认的 unicode 符号
// （ora 默认成功 ✔、失败 ✖，落在「无特殊符号」规则的边缘）
//
// createSpinner(text).start()   启动 ASCII 动画
// spinnerSucceed(spinner, text) 成功结束，显示 [完成] text
// spinnerFail(spinner, text)    失败结束，显示 [失败] text

/** ASCII 纯文本 spinner 动画帧 */
const ASCII_SPINNER = { interval: 100, frames: ['|', '/', '-', '\\'] };

/** 成功标记（替代 ora 默认 ✔） */
export const SUCC_SYMBOL = '[完成]';
/** 失败标记（替代 ora 默认 ✖） */
export const FAIL_SYMBOL = '[失败]';

/**
 * 创建纯文本 spinner（ASCII 动画）
 */
export function createSpinner(text: string): Ora {
  return ora({ text, spinner: ASCII_SPINNER });
}

/** spinner 成功结束（纯文本符号） */
export function spinnerSucceed(spinner: Ora, text: string): void {
  spinner.stopAndPersist({ symbol: SUCC_SYMBOL, text });
}

/** spinner 失败结束（纯文本符号） */
export function spinnerFail(spinner: Ora, text: string): void {
  spinner.stopAndPersist({ symbol: FAIL_SYMBOL, text });
}
