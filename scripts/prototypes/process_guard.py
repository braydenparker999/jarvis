"""Local POSIX subprocess bounds, not a hostile-code sandbox.

Children must not escape their process group, detach requests, or write outside
retained attempt storage. No remote terminality is inferred from local exit.
"""
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time


class ProcessLimit(RuntimeError):
    pass


def _kill_group(pid):
    try: os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError: pass


def run(argv, *, timeout, output_limit=65536, file_limit=33*1024*1024, check=lambda: None):
    """Drain bounded diagnostic bytes; kill entire cooperating group on any fault.

    The tiny launcher applies a hard per-file RLIMIT_FSIZE before exec without
    using preexec_fn in a possibly multithreaded parent. No output is retained.
    """
    if (not isinstance(argv, (list, tuple)) or not argv or any(type(arg) is not str for arg in argv)
            or type(timeout) not in (int, float) or not 0 < timeout < float('inf')
            or type(output_limit) is not int or output_limit < 0
            or type(file_limit) is not int or file_limit <= 0):
        raise ProcessLimit('Invalid subprocess bounds or argv')
    check()
    launcher = [sys.executable, str(Path(__file__).resolve()), '--launch', str(file_limit), *argv]
    child = subprocess.Popen(launcher, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             stdin=subprocess.DEVNULL, start_new_session=True, close_fds=True)
    deadline = time.monotonic() + timeout
    count = 0
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            while True:
                check()
                if time.monotonic() >= deadline:
                    raise ProcessLimit('Subprocess timeout; outcome held')
                for key, _ in selector.select(min(0.05, max(0, deadline-time.monotonic()))):
                    data = os.read(key.fd, min(65536, output_limit-count+1))
                    if not data: selector.unregister(key.fileobj)
                    else:
                        count += len(data)
                        if count > output_limit: raise ProcessLimit('Diagnostic output limit exceeded')
                code = child.poll()
                if code is not None:
                    # A leader exiting does not authorize surviving descendants.
                    # Zombie-only groups may also conservatively fail this check.
                    try: os.killpg(child.pid, 0)
                    except ProcessLookupError: pass
                    else: raise ProcessLimit('Descendant process group survived leader')
                    if not selector.get_map():
                        check()
                        return code, count
    finally:
        _kill_group(child.pid)
        child.wait()
        child.stdout.close()


if __name__ == '__main__':
    if len(sys.argv) < 4 or sys.argv[1] != '--launch':
        raise SystemExit('Internal launcher arguments required')
    import resource
    limit = int(sys.argv[2])
    resource.setrlimit(resource.RLIMIT_FSIZE, (limit, limit))
    os.execvp(sys.argv[3], sys.argv[3:])
