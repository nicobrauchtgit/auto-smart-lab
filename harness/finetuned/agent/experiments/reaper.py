"""Child subreaper for one supervised command (Linux only).

Usage: reaper.py <status-path> -- <argv...>

Marks itself a child subreaper (prctl PR_SET_CHILD_SUBREAPER), so every
process the command leaves behind -- a daemonised worker, a `setsid` child
whose parent exited -- re-parents here instead of to init and stays a
descendant the supervisor finds through parent links, whenever it samples.

It runs the command and writes its PID to <status-path>, then adds the
command's own exit as soon as the command ends (a shell call returns then).
It keeps reaping until no descendant remains and only then exits, with the
command's exit code (128 plus the signal number when a signal ended it).
SIGTERM, SIGINT and SIGHUP do not end it: the supervisor signals every
descendant itself, and the reaper must outlive them so none escapes. Only
SIGKILL ends it, and the supervisor sends that last. Standard library only;
run with `-I -S`.

A descendant escapes only past a dead reaper. A bubblewrap sandbox's PID
namespace is itself a descendant, and everything in it ends with its init.
"""

import ctypes
import json
import os
import signal
import sys

PR_SET_CHILD_SUBREAPER = 36


def write_status(path, value):
    temporary = f"{path}.{os.getpid()}.tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(value, handle)
    os.replace(temporary, path)


def main():
    if len(sys.argv) < 4 or sys.argv[2] != "--":
        os.write(2, b"usage: reaper.py <status-path> -- <argv...>\n")
        return 125
    status_path, argv = sys.argv[1], sys.argv[3:]
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        os.write(2, f"reaper: prctl(PR_SET_CHILD_SUBREAPER) failed: {os.strerror(ctypes.get_errno())}\n".encode())
        return 125
    # A Python-level handler, not SIG_IGN: ignored signals would be inherited
    # by the command across exec, caught ones are reset to the default.
    for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(number, lambda *_: None)
    command = os.fork()
    if command == 0:
        # Python ignores SIGPIPE and SIGXFSZ, and an ignored signal survives exec:
        # without this `yes | head` would print EPIPE errors instead of ending.
        for number in (signal.SIGPIPE, signal.SIGXFSZ):
            signal.signal(number, signal.SIG_DFL)
        try:
            os.execvp(argv[0], argv)
        except OSError as error:
            os.write(2, f"{argv[0]}: {error.strerror}\n".encode())
        os._exit(127)
    write_status(status_path, {"pid": command})
    code = None
    while True:
        try:
            pid, status = os.waitpid(-1, 0)
        except ChildProcessError:
            break
        if pid != command:
            continue
        if os.WIFSIGNALED(status):
            number = os.WTERMSIG(status)
            code = 128 + number
            try:
                name = signal.Signals(number).name
            except ValueError:
                name = f"SIG{number}"
            write_status(status_path, {"pid": command, "signal": name})
        else:
            code = os.WEXITSTATUS(status)
            write_status(status_path, {"pid": command, "exitCode": code})
    return 127 if code is None else code


if __name__ == "__main__":
    sys.exit(main())
