#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sync_to_cocos_tools.py —— 把当前 cocoscli 工程镜像同步到 game-mahjong 的 cocos_tools 副本

目标副本已按约定整理：保留完整工程内容（含 deps/CocosMCP、deps/cdp-cli），
但不含任何 git 元信息（.git / .gitmodules / .gitattributes）。本脚本维持该状态。

 同步流程

 do_sync(source, target)
		 ├─> 扫描源目录（剪掉 .git 目录树，跳过 .gitmodules/.gitattributes）
		 │     ├─> 收集 src_files（rel -> 路径）与 src_dirs
		 │     └─> 复制新增或变更文件（大小或修改时间不同才复制，保留时间戳）
		 ├─> 扫描目标目录
		 │     ├─> .git 目录 / .gitmodules / .gitattributes / .git 指针文件 -> 出现即删
		 │     └─> 源中已不存在的文件 -> 删除（镜像）
		 └─> 清理目标中多余空目录（源里没有的目录，空则移除）

 特点

 - 增量：按 大小 + 修改时间 判断，未变化的文件不重传，node_modules 也只传差异
 - 镜像：源里删掉的文件，目标同步删除
 - 无 git：git 元信息既不复制，目标残留也一并清掉
 - 保留 .gitignore：目标副本需提交 deps/node_modules，忽略规则独立维护，不覆盖不删除

 用法

     python sync_to_cocos_tools.py                 # 源=脚本所在目录，目标=默认 cocos_tools 路径
     python sync_to_cocos_tools.py --dry-run       # 只预览要做的变更，不实际执行
     python sync_to_cocos_tools.py <源目录> <目标目录>
"""

import argparse
import os
import shutil
import sys
from datetime import datetime, timezone, timedelta

# 北京时间（工程约定：时间显示一律 UTC+8）
_BJT = timezone(timedelta(hours=8))

# 默认目标：game-mahjong client 下的 cocos_tools/cocoscli 副本
DEFAULT_TARGET = r"E:\WorkProjects\xc-flow\.xflow\xc\xcodeDev\game-mahjong\client\cocos_tools\cocoscli"

# git 元信息目录名（出现即排除/删除，含 submodule 的 .git 指针文件场景由文件名判断兜底）
_GIT_DIR_NAMES = {'.git'}
# git 元信息文件名（不复制；目标出现即删）
_GIT_FILE_NAMES = {'.git', '.gitmodules', '.gitattributes'}
# 保留目标侧文件的名单（同步时不覆盖、不删除，目标侧可能被本地修改过）
# .gitignore：目标副本要提交 deps/node_modules，会改成自己的忽略规则，不能被源覆盖
_KEEP_TARGET_FILES = {'.gitignore'}


def now_str() -> str:
    """当前北京时间字符串"""
    return datetime.now(_BJT).strftime('%Y-%m-%d %H:%M:%S')


def lp(path: str) -> str:
    """Windows 长路径支持：绝对路径加 \\\\?\\ 前缀，绕过 260 字符限制（node_modules 深层路径需要）"""
    if os.name == 'nt' and os.path.isabs(path) and not path.startswith('\\\\?\\'):
        return '\\\\?\\' + path
    return path


def is_git_dir(name: str) -> bool:
    return name.lower() in _GIT_DIR_NAMES


def is_git_file(name: str) -> bool:
    return name.lower() in _GIT_FILE_NAMES


def needs_copy(src: str, dst: str) -> bool:
    """目标缺失，或大小/修改时间（秒）任一不同时需要复制"""
    try:
        ss = os.stat(src)
        ds = os.stat(dst)
    except OSError:
        return True
    return ss.st_size != ds.st_size or int(ss.st_mtime) != int(ds.st_mtime)


def do_sync(source: str, target: str, dry_run: bool = False) -> dict:
    """
    镜像同步 source -> target（不携带 git 元信息）

    返回统计：{copied, deleted, unchanged, copied_bytes, errors}
    copied/deleted 为相对路径列表，errors 为 (rel, 错误信息) 列表。
    """
    src_files = {}  # normcase(rel) -> (rel 显示用, src 绝对路径)
    src_dirs = set()  # normcase(rel_dir)

    # 第一步：扫描源（剪掉 .git 目录，跳过 git 元信息文件）
    for dirpath, dirnames, filenames in os.walk(lp(source)):
        dirnames[:] = sorted(d for d in dirnames if not is_git_dir(d))
        rel_dir = os.path.relpath(dirpath, lp(source))
        if rel_dir != '.':
            src_dirs.add(os.path.normcase(rel_dir))
        for fname in sorted(filenames):
            if is_git_file(fname):
                continue
            rel = fname if rel_dir == '.' else os.path.join(rel_dir, fname)
            src_files[os.path.normcase(rel)] = (rel, os.path.join(dirpath, fname))

    # 第二步：复制新增/变更文件（保留时间戳，二次运行只传增量）
    # _KEEP_TARGET_FILES 中的文件跳过不复制（目标侧独立维护）
    copied, errors = [], []
    copied_bytes = 0
    unchanged = 0
    for key, (rel, src_abs) in sorted(src_files.items()):
        if os.path.basename(rel).lower() in _KEEP_TARGET_FILES:
            continue
        dst_abs = lp(os.path.join(target, rel))
        if not needs_copy(src_abs, dst_abs):
            unchanged += 1
            continue
        copied.append(rel)
        if dry_run:
            continue
        try:
            os.makedirs(os.path.dirname(dst_abs), exist_ok=True)
            shutil.copy2(src_abs, dst_abs)
            copied_bytes += os.stat(src_abs).st_size
        except OSError as e:
            errors.append((rel, str(e)))

    # 第三步：清理目标——git 元信息出现即删；源中已不存在的文件删除
    deleted = []
    for dirpath, dirnames, filenames in os.walk(lp(target)):
        # .git 目录整树删除（submodule 真目录场景）
        for d in list(dirnames):
            if is_git_dir(d):
                full = os.path.join(dirpath, d)
                deleted.append(os.path.relpath(full, lp(target)) + os.sep)
                if not dry_run:
                    shutil.rmtree(full, ignore_errors=True)
                dirnames.remove(d)
        rel_dir = os.path.relpath(dirpath, lp(target))
        for fname in sorted(filenames):
            # 保留名单内的文件不删（.gitignore 目标侧独立维护）
            if fname.lower() in _KEEP_TARGET_FILES:
                continue
            rel = fname if rel_dir == '.' else os.path.join(rel_dir, fname)
            if is_git_file(fname) or os.path.normcase(rel) not in src_files:
                deleted.append(rel)
                if not dry_run:
                    try:
                        os.remove(os.path.join(dirpath, fname))
                    except OSError as e:
                        errors.append((rel, str(e)))

    # 第四步：清理目标中多余的空目录（源里没有的目录，空则移除；根目录不动）
    if not dry_run:
        for dirpath, _dirnames, _files in os.walk(lp(target), topdown=False):
            if dirpath == lp(target):
                continue
            rel_dir = os.path.relpath(dirpath, lp(target))
            if os.path.normcase(rel_dir) not in src_dirs:
                try:
                    os.rmdir(dirpath)  # 非空（还有应保留内容）会抛错，忽略即可
                except OSError:
                    pass

    return {
        'copied': copied,
        'deleted': deleted,
        'unchanged': unchanged,
        'copied_bytes': copied_bytes if not dry_run else sum(
            os.path.getsize(v[1]) for v in src_files.values()
            if os.path.normcase(v[0]) in {os.path.normcase(c) for c in copied}
        ),
        'errors': errors,
        'kept': sorted(f for f in _KEEP_TARGET_FILES
                       if os.path.exists(os.path.join(target, f))),
    }


def fmt_size(n: float) -> str:
    """字节数转可读字符串"""
    for unit in ('B', 'KB', 'MB', 'GB'):
        if n < 1024 or unit == 'GB':
            return f'{n:.1f} {unit}' if unit != 'B' else f'{int(n)} B'
        n /= 1024
    return f'{n:.1f} GB'


def print_result(r: dict, dry_run: bool) -> None:
    tag = '[预览]' if dry_run else '[完成]'
    print(f"{tag} 复制 {len(r['copied'])} 个文件（{fmt_size(r['copied_bytes'])}），"
          f"删除 {len(r['deleted'])} 项，未变化 {r['unchanged']} 个")
    if r.get('kept'):
        print(f"  保留目标侧：{', '.join(r['kept'])}")
    for rel in r['copied'][:30]:
        print(f"  复制 {rel}")
    if len(r['copied']) > 30:
        print(f"  ... 其余 {len(r['copied']) - 30} 个略")
    for rel in r['deleted']:
        print(f"  删除 {rel}")
    if r['errors']:
        print(f"[失败] {len(r['errors'])} 项出错：")
        for rel, msg in r['errors']:
            print(f"  {rel}: {msg}")


def parse_args(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    p = argparse.ArgumentParser(description='把 cocoscli 工程镜像同步到 cocos_tools 副本（不携带 git 元信息）')
    p.add_argument('source', nargs='?', default=here, help='源目录（默认：脚本所在目录）')
    p.add_argument('target', nargs='?', default=DEFAULT_TARGET, help='目标目录（默认：game-mahjong cocos_tools/cocoscli）')
    p.add_argument('--dry-run', action='store_true', help='只预览要做的变更，不实际执行')
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    source = os.path.abspath(args.source)
    target = os.path.abspath(args.target)
    print(f"[{now_str()}] 同步开始（北京时间）")
    print(f"  源：{source}")
    print(f"  目标：{target}")
    if not os.path.isdir(source):
        print('[失败] 源目录不存在')
        return 1
    r = do_sync(source, target, args.dry_run)
    print_result(r, args.dry_run)
    return 1 if r['errors'] else 0


if __name__ == '__main__':
    sys.exit(main())
