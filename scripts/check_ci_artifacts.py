#!/usr/bin/env python3
"""Bound synthetic CI screenshot artifacts before upload. No network or deletions."""
import pathlib, stat, sys
MAX_BYTES = 64 * 1024 * 1024
MAX_FILES = 128
MAX_ENTRIES = 1024

def check(root):
    root = pathlib.Path(root)
    if root.is_symlink() or not root.is_dir():
        raise ValueError('artifact directory is missing or unsafe')
    total = count = entries = 0
    for path in root.rglob('*'):
        entries += 1
        if entries > MAX_ENTRIES or len(path.relative_to(root).as_posix().encode()) > 512:
            raise ValueError('artifact entry/path limit exceeded')
        info = path.lstat()
        mode = info.st_mode
        if stat.S_ISLNK(mode) or stat.S_ISREG(mode) and info.st_nlink != 1 or not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
            raise ValueError('artifact contains a link or special file')
        if stat.S_ISREG(mode):
            count += 1
            total += path.stat().st_size
            if count > MAX_FILES or total > MAX_BYTES:
                raise ValueError('artifact file/byte budget exceeded')
    if not count:
        raise ValueError('artifact directory has no files')
    return count, total

if __name__ == '__main__':
    try:
        count, total = check(sys.argv[1] if len(sys.argv) == 2 else 'test-artifacts/ui')
        print(f'Artifact budget verified: {count} files, {total} bytes')
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
