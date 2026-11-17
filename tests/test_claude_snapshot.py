import pathlib,sys,tempfile,json,unittest
sys.path.insert(0,str(pathlib.Path(__file__).parents[1]/'agent'));from claude_snapshot import convert
class Snapshot(unittest.TestCase):
 def test_real_shape_synthetic_content(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)/'trace.jsonl';p.write_text(json.dumps({'type':'assistant','timestamp':'2026-10-21T00:00:00Z','message':{'content':[{'type':'tool_use','name':'Read','input':{'file_path':'synthetic.txt'}}]}})+'\n');result=convert(p,'synthetic-run',pathlib.Path(d)/'out');self.assertEqual(result['events'],1);b=json.loads(pathlib.Path(result['files'][0]).read_text());self.assertEqual(b['events'][0]['kind'],'tool_call');self.assertEqual(b['events'][0]['data']['input']['file_path'],'synthetic.txt');self.assertEqual(convert(p,'synthetic-run',pathlib.Path(d)/'out'),result)
 def test_missing_time_refused(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)/'trace';p.write_text(json.dumps({'type':'user','message':{'content':'hello'}}))
   with self.assertRaises(ValueError):convert(p,'run',pathlib.Path(d)/'out')
if __name__=='__main__':unittest.main()
