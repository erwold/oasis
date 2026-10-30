"""Bounded matcher and capability-model tests. These are NOT Linux-machine evidence."""
import fnmatch
import importlib.util
import os
import pathlib
import tempfile
import unittest
import builtins
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('policy_adapter', pathlib.Path(__file__).with_name('adapter.py'))
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)


class PolicyMatcherTests(unittest.TestCase):
    def test_sensitive_dp_agrees_with_fnmatchcase(self):
        names = ['', 'a', 'A', '_', '-', '/', 'a/b.txt', 'Secrets/note.TXT', 'é.txt', 'e\u0301.txt', '[a]', '[', ']']
        patterns = ['', '*', '**', '?', '*?*', '*.txt', '**/*.TXT', 'Secrets/**', '[A-z]*', '[Z-a]*', '[!A-Z]*',
                    '[!a]', '[[]', '[]]', '[!]]', '[', '[a]', '[^a]', '?/*', 'é.*', 'e\u0301.*']
        for name in names:
            for pattern in patterns:
                with self.subTest(name=name, pattern=pattern):
                    self.assertEqual(a.policy_glob(name, pattern, [2000000]), fnmatch.fnmatchcase(name, pattern))

    def test_insensitive_classes_preserve_ranges_and_negate_alias_union(self):
        for char in '[\\]^_`':
            self.assertTrue(a.policy_glob(char+'.txt', '[A-z]*.txt', [2000000], insensitive=True))
        self.assertFalse(a.policy_glob('alpha.txt', '[!A-Z]*.txt', [2000000], insensitive=True))
        self.assertFalse(a.policy_glob('ALPHA.TXT', '[!a-z]*.txt', [2000000], insensitive=True))
        self.assertTrue(a.policy_glob('_alpha.txt', '[!a-z]*.txt', [2000000], insensitive=True))

    def test_byte_exact_model_keeps_absent_case_and_unicode_distinct(self):
        # The two lookup names are absent in a real private temp directory; only the
        # capability is modeled. Actual Linux fd/ioctl integration belongs to QA.
        with tempfile.TemporaryDirectory(prefix='oasis-policy-model-', dir='/tmp') as root:
            fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                scope = dict(case_sensitive=True, unicode='byte-exact')
                self.assertEqual(a.policy_literal_component((fd, 'UPPER.TXT', None, scope), 'upper.txt'), (False, False))
                self.assertEqual(a.policy_literal_component((fd, 'e\u0301.txt', None, scope), 'é.txt'), (False, False))
            finally:
                os.close(fd)

    def test_unknown_absent_comparison_cannot_guess_negative(self):
        with tempfile.TemporaryDirectory(prefix='oasis-policy-model-', dir='/tmp') as root:
            fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                with self.assertRaises(a.Refused) as result:
                    a.policy_literal_component((fd, 'MISSING', None, dict(case_sensitive=None, unicode='opaque')), 'missing')
                self.assertEqual(result.exception.code, 'policy_semantics_unavailable')
            finally:
                os.close(fd)

    def test_missing_optional_native_binding_is_unknown_not_protocol_crash(self):
        original = builtins.__import__
        def missing(name, *args, **kwargs):
            if name == 'ctypes':
                raise ImportError('test minimal Python build without native bindings')
            return original(name, *args, **kwargs)
        with tempfile.TemporaryDirectory(prefix='oasis-policy-model-', dir='/tmp') as root:
            fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                with patch('builtins.__import__', missing):
                    scope = a.policy_scope(fd, '.')
                self.assertIsNone(scope['case_sensitive'])
                self.assertEqual(scope['source'], 'unknown')
            finally:
                os.close(fd)

    def test_work_budget_precedes_expensive_match(self):
        with self.assertRaises(a.Refused) as result:
            a.policy_glob('b'*1000, 'a*'*1000, [100])
        self.assertEqual(result.exception.code, 'policy_budget_exceeded')


if __name__ == '__main__':
    unittest.main()
