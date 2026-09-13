"""CPU/RSS for a process group on macOS without entitlements.

`ps -o time,rss,vsz` fails with "requires entitlement" on Darwin 25, so sample
libproc directly. pti_total_user/system are mach ticks, not nanoseconds: on
Apple Silicon the timebase is 125/3, so reading them as ns underreports CPU by
41x and makes a pegged core look like a hung process."""
from __future__ import annotations
import ctypes, ctypes.util, struct, subprocess

_lib = ctypes.CDLL(ctypes.util.find_library("proc") or "/usr/lib/libproc.dylib")
_buf = ctypes.create_string_buffer(256)
PROC_PIDTASKINFO = 4


class _Timebase(ctypes.Structure):
    _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]


_tb = _Timebase()
ctypes.CDLL(ctypes.util.find_library("System")).mach_timebase_info(ctypes.byref(_tb))
TICK_NS = _tb.numer / _tb.denom


def pids_in_group(pgid: int) -> list[int]:
    out = subprocess.run(["ps", "-o", "pid=", "-g", str(pgid)],
                         capture_output=True, text=True)
    return [int(l) for l in out.stdout.split() if l.strip().isdigit()]


def task_info(pid: int):
    if _lib.proc_pidinfo(pid, PROC_PIDTASKINFO, 0, _buf, 256) <= 0:
        return None
    vsz, rss, user, system = struct.unpack_from("<QQQQ", _buf.raw, 0)
    return {"rss": rss, "cpu_seconds": (user + system) * TICK_NS / 1e9}


def sample_group(pgid: int):
    """Summed CPU seconds and RSS across every live process in the group."""
    rows = [t for t in (task_info(p) for p in pids_in_group(pgid)) if t]
    if not rows:
        return None
    return {"processes": len(rows),
            "cpu_seconds": sum(r["cpu_seconds"] for r in rows),
            "rss_kb": sum(r["rss"] for r in rows) // 1024}
