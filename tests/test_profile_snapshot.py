import importlib.util, json, pathlib, tempfile, unittest
ROOT = pathlib.Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location('claude_snapshot', ROOT / 'agent' / 'claude_snapshot.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def line(index):
    return json.dumps({'type': 'assistant', 'timestamp': '2026-10-24T00:00:00Z', 'message': {'content': [{'type': 'text', 'text': f'note {index}'}]}})

class ProfileSnapshot(unittest.TestCase):
    def test_batch_ids_follow_source_chunk_order(self):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / 'trace.jsonl'
            source.write_text('\n'.join(line(i) for i in range(101)) + '\n')
            result = module.convert(source, 'ordered-run', pathlib.Path(directory) / 'out')
        self.assertEqual(result['events'], 101)
        names = [pathlib.Path(path).name for path in result['files']]
        self.assertEqual(len(names), 2)
        self.assertTrue(names[0].startswith('0000000000000000-'))
        self.assertTrue(names[1].startswith('0000000000000001-'))
        self.assertLess(names[0], names[1])

if __name__ == '__main__':
    unittest.main()
