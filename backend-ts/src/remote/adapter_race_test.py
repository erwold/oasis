"""Supplemental real-filesystem fault tests; SSH acceptance lives in transport.test.ts.
Run with --adapter /tmp/baseline.py for behavioral old-fail/new-pass (not missing imports).
"""
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

path = pathlib.Path(__file__).with_name('adapter.py')
if '--adapter' in sys.argv:
    index = sys.argv.index('--adapter')
    path = pathlib.Path(sys.argv[index + 1])
    del sys.argv[index:index + 2]
spec = importlib.util.spec_from_file_location('adapter_under_test', path)
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)


class FileRaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='oasis-file-race-', dir='/tmp')
        self.root = pathlib.Path(self.temp.name)
        a.registry_path = lambda: str(self.root / '.test-private-registry')
        self.meta = a.root_open({'path': str(self.root)})
        self.lease = dict(lease_id='test', owner_id='test', fence=1, updated_at=a.now())
        a.atomic(str(pathlib.Path(self.meta['state_path']) / 'lease.json'), self.lease)

    def tearDown(self):
        self.temp.cleanup()

    def request(self, before):
        return dict(protocol=1, request_id='r', operation_id='write', generation=self.meta['generation'], root_id=self.meta['root_id'],
                    method='files.write', params=dict(path='file', expected_hash=a.sha(before) if before is not None else None,
                    data=a.b64(b'ours'), lease=self.lease))

    def during_image_sync(self, before):
        file = self.root / 'file'
        if before is not None:
            file.write_bytes(before)
        real = a.atomic
        def atomic(path, value):
            real(path, value)
            if path.endswith('.images'):
                file.write_bytes(b'external writer')
        with patch.object(a, 'atomic', atomic):
            with self.assertRaises(a.Refused) as caught:
                a.dispatch(self.meta, self.request(before))
        self.assertEqual(caught.exception.code, 'version_conflict')
        self.assertEqual(file.read_bytes(), b'external writer')

    def job_fixture(self):
        job = pathlib.Path(self.meta['state_path']) / 'jobs' / 'job'
        job.mkdir(mode=0o700)
        a.atomic(str(job / 'spec.json'), dict(job_id='job', operation_id='start', timeout_s=None, output_cap_bytes=1000))
        return job

    def test_storage_failure_visible_without_trustworthy_exit(self):
        job = self.job_fixture()
        a.atomic(str(job / 'storage-failed.json'), {'at': a.now()})
        result = a.job_status(self.meta, 'job')
        self.assertEqual(result['state'], 'unknown')
        self.assertEqual(result['reason'], 'storage_failed')

    def test_capped_output_counter_before_terminal(self):
        job = self.job_fixture()
        (job / 'stdout').write_bytes(b'x' * 1000)
        a.atomic(str(job / 'progress.json'), dict(totals={'stdout': 10000}, retained={'stdout': 1000}))
        request = self.request(None)
        request.update(method='jobs.read', params=dict(job_id='job', stream='stdout'))
        page = a.dispatch(self.meta, request)
        self.assertEqual(page['total_written'], 10000)
        self.assertEqual(page['total_retained'], 1000)
        self.assertEqual(page['gaps'], [dict(start=1000, end=10000)])
        self.assertFalse(page['eof'])

    def test_probe_refuses_unavailable_pid_identity(self):
        with patch.object(a, 'process_identity', return_value=None):
            with self.assertRaises(a.Refused) as caught:
                a.probe()
        self.assertEqual(caught.exception.code, 'unsupported_transport')

    def test_existing_file_recheck_after_durable_images(self):
        self.during_image_sync(b'original')

    def test_absent_file_recheck_after_durable_images(self):
        self.during_image_sync(None)

    def test_absent_file_atomic_create_after_last_check(self):
        file = self.root / 'file'
        real = a.os.fsync
        triggered = False
        def fsync(fd):
            nonlocal triggered
            # The content fsync of the same-directory temp occurs after the final read check.
            if not triggered and any(self.root.glob('.oasis-write-*')):
                triggered = True
                file.write_bytes(b'external creator')
            return real(fd)
        with patch.object(a.os, 'fsync', fsync):
            with self.assertRaises(a.Refused) as caught:
                a.dispatch(self.meta, self.request(None))
        self.assertTrue(triggered)
        self.assertEqual(caught.exception.code, 'version_conflict')
        self.assertEqual(file.read_bytes(), b'external creator')


if __name__ == '__main__':
    unittest.main()
