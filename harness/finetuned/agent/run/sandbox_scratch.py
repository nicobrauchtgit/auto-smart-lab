"""Private disk scratch for one bubblewrap invocation; project Python, -I -S.

No session, process group or supervision receipts are created here. The existing
supervisor/reaper owns the process tree. Only this invocation's tmp directory is
mounted; the parent, lock and sibling invocations remain outside the sandbox.
"""

import ctypes
import fcntl
import os
import secrets
import signal
import stat
import subprocess
import sys
import time

LIBC = ctypes.CDLL(None, use_errno=True)
NOFOLLOW = os.O_NOFOLLOW | os.O_DIRECTORY
MEMORY_FILESYSTEMS = {0x01021994, 0x858458F6, 0x958458F6}  # tmpfs, ramfs, hugetlbfs


def open_root(path):
    """Pin every component, refusing symlinks and RAM-backed storage."""
    if not os.path.isabs(path):
        raise ValueError("scratch root must be absolute")
    descriptor = os.open("/", os.O_RDONLY | NOFOLLOW)
    try:
        for part in path.split("/"):
            if not part or part == ".":
                continue
            if part == "..":
                raise ValueError("invalid scratch root")
            try:
                os.mkdir(part, 0o700, dir_fd=descriptor)
            except FileExistsError:
                pass
            child = os.open(part, os.O_RDONLY | NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        info = os.fstat(descriptor)
        if info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValueError("scratch root must be private to the harness user (mode 0700)")
        # f_type is the first native long in Linux struct statfs. A generously
        # sized buffer avoids assumptions about the remaining ABI fields.
        filesystem = ctypes.create_string_buffer(256)
        if LIBC.fstatfs(descriptor, filesystem) != 0:
            raise OSError(ctypes.get_errno(), "cannot inspect scratch filesystem")
        if ctypes.c_long.from_buffer(filesystem).value & 0xFFFFFFFF in MEMORY_FILESYSTEMS:
            raise ValueError("scratch must be disk-backed, not tmpfs/ramfs/hugetlbfs")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def erase_contents(descriptor, deadline, keep_lock=False):
    """Descriptor-relative deletion; even hostile symlinks/chmod stay local."""
    os.fchmod(descriptor, 0o700)
    # Iterative traversal also handles agent-created trees deeper than Python's
    # recursion limit. All descriptors close if the cleanup time budget expires.
    directory = os.dup(descriptor)
    stack = [(directory, os.scandir(directory), None)]
    try:
        while stack:
            if time.monotonic() >= deadline:
                raise TimeoutError("scratch cleanup deadline reached")
            current, entries, name = stack[-1]
            try:
                entry = next(entries)
            except StopIteration:
                entries.close()
                os.close(current)
                stack.pop()
                if stack:
                    os.rmdir(name, dir_fd=stack[-1][0])
                continue
            if keep_lock and len(stack) == 1 and entry.name == "owner.lock":
                continue
            handle = os.open(entry.name, os.O_PATH | os.O_NOFOLLOW, dir_fd=current)
            try:
                if stat.S_ISDIR(os.fstat(handle).st_mode):
                    # O_PATH pins the directory even if agent code chmodded it
                    # to 000. /proc/self/fd refers to that pinned object only.
                    os.chmod(f"/proc/self/fd/{handle}", 0o700)
                    child = os.open(".", os.O_RDONLY | NOFOLLOW, dir_fd=handle)
                    stack.append((child, os.scandir(child), entry.name))
                else:
                    os.unlink(entry.name, dir_fd=current)
            finally:
                os.close(handle)
    finally:
        for directory, entries, _name in stack:
            entries.close()
            os.close(directory)


def remove_job(root, name, descriptor, deadline):
    erase_contents(descriptor, deadline, keep_lock=True)
    try:
        os.unlink("owner.lock", dir_fd=descriptor)
    except FileNotFoundError:
        pass
    os.rmdir(name, dir_fd=root)


def recover_stale(root):
    """Bounded best-effort GC of old hard-kill remnants, never active jobs.

    The protected lock is held for the wrapper's whole lifetime. No agent can
    read/write it. Locks avoid PID reuse ambiguity; the age grace also gives
    bubblewrap's --die-with-parent time to finish after a SIGKILL.
    """
    deadline = time.monotonic() + 0.25
    with os.scandir(root) as entries:
        for index, entry in enumerate(entries):
            if index >= 32 or time.monotonic() >= deadline:
                break
            if not entry.name.startswith("call-"):
                continue
            job = lock = None
            try:
                job = os.open(entry.name, os.O_RDONLY | NOFOLLOW, dir_fd=root)
                if time.time() - os.fstat(job).st_mtime < 60:
                    continue
                lock = os.open("owner.lock", os.O_RDWR | os.O_NOFOLLOW, dir_fd=job)
                if not stat.S_ISREG(os.fstat(lock).st_mode):
                    continue
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                remove_job(root, entry.name, job, deadline)
            except (OSError, TimeoutError):
                pass
            finally:
                if lock is not None:
                    os.close(lock)
                if job is not None:
                    os.close(job)


def run(root_path, command):
    root = open_root(root_path)
    job = lock = temporary = None
    name = f"call-{os.getpid()}-{secrets.token_hex(12)}"
    child = None
    requested = None
    kill_at = None

    def terminate(number, _frame):
        nonlocal requested, kill_at
        requested = number
        kill_at = time.monotonic() + 0.5
        if child is not None:
            try:
                child.send_signal(number)
            except ProcessLookupError:
                pass

    try:
        recover_stale(root)
        os.mkdir(name, 0o700, dir_fd=root)
        job = os.open(name, os.O_RDONLY | NOFOLLOW, dir_fd=root)
        lock = os.open("owner.lock", os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=job)
        fcntl.flock(lock, fcntl.LOCK_EX)
        os.mkdir("tmp", 0o700, dir_fd=job)
        temporary = os.open("tmp", os.O_RDONLY | NOFOLLOW, dir_fd=job)
        os.mkdir("home", 0o700, dir_fd=temporary)
        for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(number, terminate)
        parent = os.getppid()
        if LIBC.prctl(1, signal.SIGTERM, 0, 0, 0) != 0:  # PR_SET_PDEATHSIG
            raise OSError(ctypes.get_errno(), "cannot install sandbox parent-death signal")
        if os.getppid() != parent or parent == 1:
            requested = signal.SIGTERM
        if requested is not None:
            return -requested
        if not command:  # preflight exercises creation, disk check and cleanup
            return 0
        child = subprocess.Popen([command[0], "--bind-fd", str(temporary), "/tmp", *command[1:]], pass_fds=(temporary,))
        if requested is not None:
            terminate(requested, None)
        while True:
            try:
                code = child.wait(timeout=0.1)
                break
            except subprocess.TimeoutExpired:
                if kill_at is not None and time.monotonic() >= kill_at:
                    child.kill()
        return code
    finally:
        if temporary is not None:
            os.close(temporary)
        if job is not None:
            try:
                remove_job(root, name, job, time.monotonic() + 3)
            except (OSError, TimeoutError):
                # SIGKILL/huge scratch can leave private files. A later launch
                # retries conservatively; cleanup never reads them as evidence.
                os.write(2, b"sandbox scratch cleanup incomplete; retained privately for later cleanup\n")
            os.close(job)
        if lock is not None:
            os.close(lock)
        os.close(root)


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--check":
        return run(sys.argv[2], [])
    if len(sys.argv) < 5 or sys.argv[3] != "--":
        os.write(2, b"usage: sandbox_scratch.py <disk-root> <bwrap> -- <args...>\n")
        return 125
    return run(sys.argv[1], [sys.argv[2], *sys.argv[4:]])


def exit_like(code):
    """Exit as the sandbox did. A signal death stays a signal death (scratch is
    already cleaned up), so callers that tell an interrupted process from a
    failed one (training recovery) see exactly what they saw without this wrapper."""
    if code < 0:
        if -code not in (signal.SIGKILL, signal.SIGSTOP):
            signal.signal(-code, signal.SIG_DFL)
            signal.pthread_sigmask(signal.SIG_UNBLOCK, [-code])
        os.kill(os.getpid(), -code)
        code = 128 - code  # Only if the signal could not end this process.
    sys.exit(code)


if __name__ == "__main__":
    try:
        result = main()
    except (OSError, ValueError) as error:
        os.write(2, f"sandbox disk scratch unavailable: {error}\n".encode())
        sys.exit(125)
    exit_like(result)
