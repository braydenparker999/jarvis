"""Fail-closed retention admission and cooperative runtime accounting.

No automatic deletion: journals/receipts remain available for reconciliation.
This is not an OS filesystem quota; runtime checks can observe transient excess.
"""
import os
from pathlib import Path
import stat


class BudgetExceeded(RuntimeError):
    pass


class ArtifactBudget:
    def __init__(self, root, *, max_attempts=8, total_bytes=256*1024*1024,
                 attempt_bytes=33*1024*1024, max_files=32):
        self.root = Path(root)
        self.max_attempts, self.total_bytes = max_attempts, total_bytes
        self.attempt_bytes, self.max_files = attempt_bytes, max_files
        if any(type(v) is not int or v <= 0 for v in (max_attempts, total_bytes, attempt_bytes, max_files)):
            raise BudgetExceeded('Invalid retention budget')

    def _size(self, path):
        total = 0; entries = 0; pending = [path]
        while pending:
            current = pending.pop()
            with os.scandir(current) as children:
                for entry in children:
                    entries += 1
                    if entries > self.max_files: raise BudgetExceeded('Attempt file count exceeded')
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISDIR(info.st_mode): pending.append(entry.path)
                    elif stat.S_ISREG(info.st_mode): total += info.st_size
                    else: raise BudgetExceeded('Unexpected retained artifact type')
                    if total > self.attempt_bytes: raise BudgetExceeded('Attempt bytes exceeded')
        return total

    def check(self, *, reserve=False):
        count = 0; size = 0
        with os.scandir(self.root) as entries:
            for entry in entries:
                if not entry.name.startswith('offline-upload-attempt-'): continue
                count += 1
                if count + int(reserve) > self.max_attempts: raise BudgetExceeded('Retained attempt count exceeded')
                if not stat.S_ISDIR(entry.stat(follow_symlinks=False).st_mode):
                    raise BudgetExceeded('Unexpected retained attempt type')
                size += self._size(entry.path)
                if size + (self.attempt_bytes if reserve else 0) > self.total_bytes:
                    raise BudgetExceeded('Retained byte budget exceeded')
        if reserve and (count + 1 > self.max_attempts or size + self.attempt_bytes > self.total_bytes):
            raise BudgetExceeded('Insufficient retained artifact budget')
