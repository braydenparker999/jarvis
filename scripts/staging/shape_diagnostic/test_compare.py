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

    def aligned(self, left, right):
        return compare.aligned_differences(compare.normalized(left), compare.normalized(right))

    def test_leading_docstrings_do_not_shift_statements(self):
        left = 'def validate():\n    x = 1\n    return x\ndef decode():\n    return True\n'
        right = '"""PRIVATE MODULE DOC"""\ndef validate():\n    """PRIVATE FUNCTION DOC"""\n    x = 1\n    return x\ndef decode():\n    """PRIVATE DECODE DOC"""\n    return True\n'
        found = self.aligned(left, right)
        self.assertEqual(len(found), 3)
        self.assertTrue(all(d['category'] == 'leading_docstring' for d in found))
        self.assertNotIn('PRIVATE', json.dumps(found))

    def test_only_true_docstrings_are_classified(self):
        left = 'def f():\n    x = 1\n    return x\n'
        for statement in ('"PRIVATE"', 'b"PRIVATE"', 'f"PRIVATE"'):
            found = self.aligned(left, left.replace('    return x', '    '+statement+'\n    return x'))
            self.assertEqual(len(found), 1)
            self.assertEqual(found[0]['category'], 'structure')
        found = self.aligned('if True:\n    pass\n', 'if True:\n    "PRIVATE"\n    pass\n')
        self.assertTrue(all(d['category'] == 'structure' for d in found))

    def test_nested_class_async_docstrings_and_real_change(self):
        left = 'class C:\n    async def f(self):\n        return 1\n'
        right = 'class C:\n    "PRIVATE"\n    async def f(self):\n        "PRIVATE"\n        return 2\n'
        found = self.aligned(left, right)
        self.assertEqual([d['category'] for d in found], ['leading_docstring', 'leading_docstring', 'structure'])

    def test_inserted_statements_and_functions_align(self):
        left = 'x = 1\nx = 2\ndef f():\n    return 1\ndef g():\n    return 2\n'
        right = 'x = 0\nx = 1\nx = 2\ndef extra():\n    return 9\ndef f():\n    "PRIVATE"\n    return 1\ndef g():\n    return 3\n'
        found = self.aligned(left, right)
        self.assertEqual(sum(d['kind'] == 'statement_added' for d in found), 2)
        self.assertEqual(sum(d['category'] == 'leading_docstring' for d in found), 1)
        self.assertEqual(sum(d['kind'] == 'value_differs' for d in found), 1)
        self.assertEqual(len(found), 4)

    def test_no_twenty_difference_limit_or_private_values(self):
        left = '\n'.join('def f%d():\n    return 1' % i for i in range(35))
        right = left.replace('return 1', 'return "PRIVATE VALUE"')
        found = self.aligned(left, right)
        self.assertEqual(len(found), 35)
        self.assertNotIn('PRIVATE VALUE', json.dumps(found))

    def test_deletion_reordering_and_argument_addition_detected(self):
        left = 'def f():\n    return 1\ndef g():\n    return 2\n'
        right = 'def g():\n    return 2\ndef f():\n    return 1\n'
        self.assertTrue(self.aligned(left, right))
        self.assertTrue(self.aligned(left, 'def f():\n    return 1\n'))
        self.assertTrue(self.aligned('f(1)\n', 'f(1, "PRIVATE")\n'))

    def test_comparison_does_not_mutate_admission_trees(self):
        import ast
        left = compare.normalized('"PRIVATE"\ndef f():\n    return 1\n')
        right = compare.normalized('def f():\n    "PRIVATE"\n    return 1\n')
        before = (ast.dump(left), ast.dump(right))
        compare.aligned_differences(left, right)
        self.assertEqual(before, (ast.dump(left), ast.dump(right)))


if __name__ == '__main__':
    unittest.main()
