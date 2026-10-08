"""Inert synthetic network records exercise identity, validation, and refit."""
import gzip
import io
import json
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest

import dpkt
from pcap_samples import connection_samples
from task_samples import TaskDataError, inspect, rows
from test_task_samples import worker, Events


def packet(src='192.0.2.1', dst='192.0.2.2', sport=1234, dport=80, protocol='tcp'):
    layer = dpkt.tcp.TCP(sport=sport, dport=dport, flags=dpkt.tcp.TH_SYN, data=b'inert') if protocol == 'tcp' else dpkt.udp.UDP(sport=sport, dport=dport, data=b'inert')
    ipv6 = ':' in src
    network = dpkt.ip6.IP6(src=socket.inet_pton(socket.AF_INET6, src), dst=socket.inet_pton(socket.AF_INET6, dst), nxt=6, data=layer) if ipv6 else dpkt.ip.IP(src=socket.inet_aton(src), dst=socket.inet_aton(dst), p=6 if protocol == 'tcp' else 17, data=layer)
    return bytes(dpkt.ethernet.Ethernet(src=b'\0' * 6, dst=b'\1' * 6, type=dpkt.ethernet.ETH_TYPE_IP6 if ipv6 else dpkt.ethernet.ETH_TYPE_IP, data=network))


def capture(path, packets, link=dpkt.pcap.DLT_EN10MB):
    stream = io.BytesIO()
    writer = dpkt.pcap.Writer(stream, linktype=link)
    for index, content in enumerate(packets):
        writer.writepkt(content, ts=index)
    content = stream.getvalue()
    Path(path).write_bytes(gzip.compress(content, mtime=0) if str(path).endswith('.gz') else content)
    return str(path)


class PcapSamplesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.train = capture(self.root / 'train.pcap.gz', [packet(protocol='udp'), packet(), packet(src='192.0.2.2', dst='192.0.2.1', sport=80, dport=1234), packet(sport=1235)])
        self.test = capture(self.root / 'test.pcap', [packet(src='198.51.100.1'), packet(src='198.51.100.2')])

    def test_bidirectional_first_observed_identity_and_global_packet_indices(self):
        samples = connection_samples(self.train)
        self.assertEqual([s['id'] for s in samples], ['192.0.2.1:1234->192.0.2.2:80', '192.0.2.1:1235->192.0.2.2:80'])
        self.assertEqual(samples[0]['input']['packetIndices'], [1, 2])
        self.assertEqual(samples[0]['input']['source'], {'ip': '192.0.2.1', 'port': 1234})
        path = capture(self.root / 'reverse.pcap', [packet(src='192.0.2.2', dst='192.0.2.1', sport=80, dport=1234), packet()])
        self.assertEqual(connection_samples(path)[0]['id'], '192.0.2.2:80->192.0.2.1:1234')

    def test_ipv6_and_raw_ip(self):
        content = packet(src='2001:db8::1', dst='2001:db8::2')
        path = capture(self.root / 'ipv6.pcap', [content])
        self.assertEqual(connection_samples(path)[0]['id'], '[2001:db8::1]:1234->[2001:db8::2]:80')
        raw = capture(self.root / 'raw.pcap', [packet()[14:]], dpkt.pcap.DLT_RAW)
        self.assertEqual(connection_samples(raw)[0]['input']['packetIndices'], [0])

    def test_inspect_and_overlap(self):
        spec = {'source': 'pcap_tcp_connections', 'trainZip': self.train, 'testZip': self.test, 'targets': 'none'}
        self.assertEqual(inspect(spec), {'trainRows': 2, 'testRows': 2, 'targets': {'kind': 'none'}})
        with self.assertRaisesRegex(TaskDataError, 'share sample IDs'):
            inspect({**spec, 'testZip': self.train})

    def test_malformed_empty_and_unsupported_fail_closed_in_cli(self):
        fixtures = [b'bad', gzip.decompress(Path(self.train).read_bytes())[:-1]]
        for content in fixtures:
            path = self.root / 'bad.pcap'
            path.write_bytes(content)
            with self.assertRaises(TaskDataError):
                connection_samples(str(path))
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('task_samples.py')), '--rows', json.dumps({'zip': str(path), 'source': 'pcap_tcp_connections'})], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn('error', json.loads(result.stdout))
            self.assertNotIn('Traceback', result.stderr)
        for packets, link, message in [([packet(protocol='udp')], 1, 'no TCP'), ([packet()], 999, 'Unsupported')]:
            with self.assertRaisesRegex(TaskDataError, message):
                connection_samples(capture(self.root / 'empty.pcap', packets, link))

    def test_fragmented_tcp_and_truncated_ip_fail_without_losing_samples(self):
        ethernet = dpkt.ethernet.Ethernet(packet())
        ethernet.data.mf = 1
        with self.assertRaisesRegex(TaskDataError, 'Fragmented TCP'):
            connection_samples(capture(self.root / 'fragment.pcap', [bytes(ethernet)]))
        with self.assertRaisesRegex(TaskDataError, 'truncated IP'):
            connection_samples(capture(self.root / 'short.pcap', [packet()[:20]]))

    def test_refit_descriptor_integrity_and_exact_frame_coverage(self):
        dev = str(self.root / 'development.pcap.gz')
        shutil.copyfile(self.train, dev)
        manifest = self.root / 'samples.json'
        manifest.write_text(json.dumps({'schemaVersion': 1, 'samples': connection_samples(dev)}))
        inputs = {'kind': 'samples', 'task': {'source': 'pcap_tcp_connections', 'kind': 'anomaly_detection', 'targets': 'none', 'execution': 'inductive', 'anomaly': {'anomalyLabel': -1}}, 'trainZip': self.train, 'testZip': self.test, 'devZip': dev, 'devManifest': str(manifest)}
        facts = worker.data(inputs)
        self.assertEqual((facts['trainRows'], facts['developmentRows'], facts['testRows']), (2, 2, 2))
        class Detector:
            def fit(self, frame):
                assert all('pcap' in value for value in frame['input'])
                self.fit_ids = list(frame['id'])
            def predict(self, frame):
                assert all('packetIndices' in value for value in frame['input'])
                return [-1, 1]
        estimator = Detector()
        self.assertEqual(worker.fit_samples(estimator, {'inputs': inputs, 'data': facts}, Events()), ([1, 0], 2, 2))
        self.assertEqual(estimator.fit_ids, facts['trainIds'])
        with self.assertRaisesRegex(AssertionError, 'coverage mismatch'):
            worker.sample_frame(self.test, facts['testIds'][:-1], 'pcap_tcp_connections')
        document = json.loads(manifest.read_text())
        document['samples'][0]['input']['packetIndices'] = [99]
        manifest.write_text(json.dumps(document))
        with self.assertRaisesRegex(AssertionError, 'descriptors drifted'):
            worker.data(inputs)


if __name__ == '__main__':
    unittest.main()
