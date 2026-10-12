"""Inspect the supplied reference as data; never import or execute it."""
import ast
import hashlib
from pathlib import Path
import unittest

from scripts.staging import build_mast_package as builder


class BuilderReference(unittest.TestCase):
    def setUp(self):
        self.source = (Path(__file__).resolve().parents[1] / 'scripts/staging/shape_diagnostic/build-queue-manifest.redacted.txt').read_bytes()

    def test_pins_and_shape(self):
        self.assertEqual(builder.WRITER_PINS['build-queue-manifest.py'], 'a56a29dbb8dac08b95c9cd5218251daebe1f395112d2b46570fb68923f349951')
        self.assertEqual(hashlib.sha256(self.source).hexdigest(), builder.REDACTED_PINS['build-queue-manifest.py'])
        self.assertEqual(builder.writer_shape(self.source), builder.WRITER_SHAPES['build-queue-manifest.py'])
        self.assertEqual(builder.writer_shape(self.source), '711f34f2303c0cf243b0a8ff0dfe58241e387eb1ea02d477d1e122a40e7a4fea')

    def test_report_discovery_is_not_excluded_from_admission(self):
        changed = self.source.replace(b'"altrock", "altrock2"', b'"different", "altrock2"')
        self.assertNotEqual(builder.writer_shape(changed), builder.writer_shape(self.source))

    def test_transform_preserves_discovery_and_fenced_reconciliation(self):
        before = ast.parse(self.source)
        after = ast.parse(builder.queue_builder(self.source.decode()))
        loop = lambda tree: next(n for n in tree.body if isinstance(n, ast.For))
        self.assertEqual(ast.dump(loop(before)), ast.dump(loop(after)))
        self.assertEqual(len(loop(before).iter.elts), 7)
        main = next(n for n in after.body if isinstance(n, ast.FunctionDef) and n.name == 'main')
        calls = [ast.unparse(n.func) for n in ast.walk(main) if isinstance(n, ast.Call)]
        self.assertIn('manifest_lib.reconcile_scan', calls)
        self.assertIn('manifest_lib.mast.require_qualification', calls)
        self.assertNotIn('os.replace', calls)
        self.assertNotIn('open', calls)


if __name__ == '__main__':
    unittest.main()
