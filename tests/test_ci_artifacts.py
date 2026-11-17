import importlib.util, pathlib, tempfile, unittest, os
ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('ci_budget', ROOT / 'scripts/check_ci_artifacts.py')
budget = importlib.util.module_from_spec(spec)
spec.loader.exec_module(budget)

class CiArtifactTests(unittest.TestCase):
    def test_normal_and_exact_byte_boundary(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / 'screen.png').write_bytes(b'synthetic')
            self.assertEqual(budget.check(root), (1, 9))
            with (root / 'screen.png').open('wb') as file:
                file.truncate(budget.MAX_BYTES)
            self.assertEqual(budget.check(root)[1], budget.MAX_BYTES)
            with (root / 'screen.png').open('ab') as file:
                file.write(b'x')
            with self.assertRaises(ValueError): budget.check(root)

    def test_file_limit_empty_missing_and_symlink_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            with self.assertRaises(ValueError): budget.check(root)
            with self.assertRaises(ValueError): budget.check(root / 'missing')
            for index in range(budget.MAX_FILES): (root / str(index)).write_bytes(b'x')
            self.assertEqual(budget.check(root)[0], budget.MAX_FILES)
            (root / 'extra').write_bytes(b'x')
            with self.assertRaises(ValueError): budget.check(root)
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / 'target').write_bytes(b'x')
            (root / 'link').symlink_to(root / 'target')
            with self.assertRaises(ValueError): budget.check(root)

    def test_hard_link_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / 'target').write_bytes(b'x')
            os.link(root / 'target', root / 'hardlink')
            with self.assertRaises(ValueError): budget.check(root)

    def test_workflow_bound_and_existing_triggers_preserved(self):
        source = (ROOT / '.github/workflows/ci.yml').read_text()
        self.assertIn('  pull_request:\n  push:\n  workflow_call:', source)
        self.assertIn('    timeout-minutes: 15', source)
        self.assertNotIn('cache: npm', source)
        self.assertLess(source.index('python3 scripts/check_ci_artifacts.py'), source.index('actions/upload-artifact@v4'))
        self.assertIn('retention-days: 7', source)
        deploy = (ROOT / '.github/workflows/deploy.yml').read_text()
        self.assertIn('branches: [main]', deploy)
