import hashlib
import json
from pathlib import Path
import unittest
import compare


class CompareTests(unittest.TestCase):
    source = '"""A docstring"""\nWS="private"\nKEY="secret"\nREPORT_DIRS={"private":"path"}\ndef f():\n    return 1\n'

    def diff(self, other):
        return list(compare.differences(compare.normalized(self.source), compare.normalized(other)))

    def test_config(self):
        self.assertEqual(self.diff(self.source.replace('"private"', '"changed"').replace('"secret"', '"new"')), [])

    def test_executable_literal(self):
        found = self.diff(self.source.replace('return 1', 'return 2'))
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]['path'], 'Module.body[1].body[0].value.value')

    def test_docstring(self):
        found = self.diff(self.source.replace('A docstring', 'Different docstring'))
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]['path'], 'Module.body[0].value.value')

    def test_added_statement_without_execution_or_values(self):
        found = self.diff(self.source + 'raise Exception("DO_NOT_EXECUTE_SECRET")\n')
        self.assertEqual(found[0]['kind'], 'list_length_differs')
        self.assertNotIn('DO_NOT_EXECUTE_SECRET', json.dumps(found))

    def test_reference_pin(self):
        raw = Path(__file__).with_name('queue-runner.redacted.txt').read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), compare.REFERENCE_PIN)


if __name__ == '__main__':
    unittest.main()
