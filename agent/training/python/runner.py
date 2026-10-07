"""Durable worker launch receipt and exit status, with a kernel trial lock.

This small parent survives a service crash and owns the entire worker lifetime.
The supervisor gives it an append-only log descriptor and its own process group.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import time

from smartlab_trial.artifacts import _atomic_json


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', required=True, type=Path)
    parser.add_argument('--token', required=True)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    with (args.directory / '.worker.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if os.uname().sysname == 'Darwin':
            import ctypes
            import struct
            library = ctypes.CDLL('/usr/lib/libproc.dylib')
            buffer = ctypes.create_string_buffer(136)
            if library.proc_pidinfo(os.getpid(), 3, 0, buffer, 136) != 136:
                raise RuntimeError('Process birth identity unavailable')
            sec, usec = struct.unpack_from('<QQ', buffer.raw, 120)
            birth, state = f'darwin:{sec}:{usec}', 'R'
        else:
            stat = Path(f'/proc/{os.getpid()}/stat').read_text().rsplit(')', 1)[1].split()
            birth = Path('/proc/sys/kernel/random/boot_id').read_text().strip() + ':' + stat[19]
            state = stat[0]
        _atomic_json(args.directory / 'worker-owner.json', {
            'token': args.token, 'identity': {'pid': os.getpid(), 'pgid': os.getpgrp(), 'birth': birth, 'state': state},
        })
        deadline = time.monotonic() + 30
        while True:
            try:
                if json.loads((args.directory / 'launch-released.json').read_text()).get('token') == args.token:
                    break
            except (FileNotFoundError, ValueError):
                pass
            if time.monotonic() >= deadline:
                return 3  # No durable launch acknowledgement: never enter a fit.
            time.sleep(0.05)
        # Group signals also reach the child; keep the receipt writer alive.
        signal.signal(signal.SIGTERM, lambda *_: None)
        signal.signal(signal.SIGINT, lambda *_: None)
        command = args.command[1:] if args.command[0] == '--' else args.command
        child = subprocess.Popen(command)
        started = time.monotonic()
        while child.poll() is None:
            _atomic_json(args.directory / 'worker-runtime.json', {'token': args.token, 'seconds': time.monotonic() - started})
            time.sleep(0.25)
        code = child.wait()
        _atomic_json(args.directory / 'worker-runtime.json', {'token': args.token, 'seconds': time.monotonic() - started})
        _atomic_json(args.directory / 'worker-exit.json', {'token': args.token, 'exitCode': code})
        return code


if __name__ == '__main__':
    raise SystemExit(main())
