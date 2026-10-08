"""TCP identity only: no packet features, labels, or attack interpretation.

One sample is a bidirectional endpoint tuple across the capture. Direction is
that of the first observed packet, as in connection IDs supplied by the lab;
reverse packets share its ID. Reused tuples are intentionally one sample.
Packet indices are zero-based across all capture records, including non-TCP.
IPv6 endpoints use brackets to keep the port boundary unambiguous.
"""
from __future__ import annotations

import gzip
import socket
import struct
from pathlib import Path

from task_samples import TaskDataError


def connection_samples(path: str) -> list[dict]:
    try:
        import dpkt
    except ImportError as error:
        raise TaskDataError("PCAP samples require dpkt; run ./dev setup to sync the declared Python dependencies") from error
    samples = {}
    try:
        opener = gzip.open if str(path).endswith('.gz') else open
        with opener(path, 'rb') as stream:
            magic = stream.read(4)
            stream.seek(0)
            capture = dpkt.pcap.Reader(stream)
            endian = '<' if magic in (b'\xd4\xc3\xb2\xa1', b'\x4d\x3c\xb2\xa1') else '>'
            link = capture.datalink()
            if link not in (dpkt.pcap.DLT_EN10MB, dpkt.pcap.DLT_RAW, dpkt.pcap.DLT_LINUX_SLL):
                raise TaskDataError(f"Unsupported PCAP link type {link}; supported: Ethernet, raw IP, Linux cooked capture")
            for index, content in enumerate(packet_records(stream, endian)):
                if link == dpkt.pcap.DLT_EN10MB:
                    frame = dpkt.ethernet.Ethernet(content)
                    network = frame.data
                    if frame.type in (dpkt.ethernet.ETH_TYPE_IP, dpkt.ethernet.ETH_TYPE_IP6) and not isinstance(network, (dpkt.ip.IP, dpkt.ip6.IP6)):
                        raise TaskDataError(f"Malformed or truncated IP header at record {index}")
                elif link == dpkt.pcap.DLT_LINUX_SLL:
                    network = dpkt.sll.SLL(content).data
                else:
                    if not content:
                        raise TaskDataError(f"Empty raw IP packet at record {index}")
                    version = content[0] >> 4
                    if version not in (4, 6):
                        raise TaskDataError(f"Invalid raw IP version at record {index}")
                    network = dpkt.ip.IP(content) if version == 4 else dpkt.ip6.IP6(content)
                if not isinstance(network, (dpkt.ip.IP, dpkt.ip6.IP6)):
                    continue
                # Fragmented TCP cannot be assigned reliably without reassembly.
                # Fail closed instead of silently omitting connections or packets.
                if isinstance(network, dpkt.ip.IP) and network.p == dpkt.ip.IP_PROTO_TCP and (network.offset or network.mf):
                    raise TaskDataError(f"Fragmented TCP packet at record {index}; reassemble the capture before declaring samples")
                if isinstance(network, dpkt.ip6.IP6) and dpkt.ip.IP_PROTO_FRAGMENT in network.extension_hdrs:
                    raise TaskDataError(f"Fragmented IPv6 packet at record {index}; reassemble the capture before declaring samples")
                if not isinstance(network.data, dpkt.tcp.TCP):
                    if getattr(network, 'p', None) == dpkt.ip.IP_PROTO_TCP:
                        raise TaskDataError(f"Malformed or truncated TCP header at record {index}")
                    continue
                tcp = network.data
                family = socket.AF_INET if isinstance(network, dpkt.ip.IP) else socket.AF_INET6
                source = (socket.inet_ntop(family, network.src), tcp.sport)
                destination = (socket.inet_ntop(family, network.dst), tcp.dport)
                key = tuple(sorted((source, destination)))
                if key not in samples:
                    endpoint = lambda value: f"[{value[0]}]:{value[1]}" if ':' in value[0] else f"{value[0]}:{value[1]}"
                    samples[key] = {'id': f'{endpoint(source)}->{endpoint(destination)}', 'input': {
                        'pcap': str(Path(path).resolve()), 'packetIndices': [],
                        'source': {'ip': source[0], 'port': source[1]},
                        'destination': {'ip': destination[0], 'port': destination[1]},
                    }}
                samples[key]['input']['packetIndices'].append(index)
    except TaskDataError:
        raise
    except (OSError, EOFError, ValueError, struct.error, dpkt.dpkt.Error) as error:
        raise TaskDataError(f"Malformed PCAP {Path(path).name}: {type(error).__name__}") from error
    if not samples:
        raise TaskDataError(f"PCAP has no TCP connections: {Path(path).name}")
    return sorted(samples.values(), key=lambda sample: sample['id'])


def packet_records(stream, endian):
    """Validate record boundaries; dpkt's reader accepts short packet bodies."""
    total = 24
    for index in range(2_000_000):
        header = stream.read(16)
        if not header:
            return
        if len(header) != 16:
            raise TaskDataError("Truncated PCAP packet record header")
        _seconds, _fraction, captured, original = struct.unpack(endian + 'IIII', header)
        if captured > original or captured > 64 * 1024 * 1024:
            raise TaskDataError("Invalid or excessive PCAP packet length")
        total += 16 + captured
        if total > 2 * 1024 * 1024 * 1024:
            raise TaskDataError("PCAP exceeds 2 GiB decompressed inspection limit")
        content = stream.read(captured)
        if len(content) != captured:
            raise TaskDataError("Truncated PCAP packet body")
        yield content
    raise TaskDataError("PCAP exceeds 2,000,000 packet inspection limit")
