"""Cross-language parity: the same logical batch must produce byte-identical spool output.

The issue asks for one specification covering both targets. That claim is only real if a
batch authored in Python and the same batch authored in Node land in the same spool file,
byte for byte — the spool filename and the `x-amz-content-sha256` dedup key are both taken
over those bytes. If this test ever splits, the two CLIs would file the same evidence twice
under two different identities.

Skipped when node is unavailable, so a machine without JS still runs the Python suite.
"""

import json
import pathlib
import shutil
import subprocess
import tempfile
import unittest

import supatrace

REPO = pathlib.Path(__file__).resolve().parents[3]
FIXTURE = [{"id": "e1", "time": "2026-11-14T00:00:00Z", "kind": "note",
            "name": "synthetic", "data": {"message": "safe", "b": 2, "a": 1}}]

JS_DRIVER = """
import {init} from %s;
const t = init('checkout', {spool: %s});
const r = t.build(%s);
console.log(JSON.stringify({valid: r.report.valid, errors: r.report.errors}));
"""


class CrossParityTest(unittest.TestCase):
    @unittest.skipIf(shutil.which("node") is None, "node not available")
    def test_same_batch_same_bytes_in_both_languages(self):
        py_dir = pathlib.Path(tempfile.mkdtemp())
        js_dir = pathlib.Path(tempfile.mkdtemp())
        try:
            py_result = supatrace.init(service="checkout", spool=str(py_dir)).batch(FIXTURE)
            self.assertTrue(py_result["report"]["valid"], py_result["report"]["errors"])

            driver = js_dir / "drive.mjs"
            driver.write_text(JS_DRIVER % (
                json.dumps(f"{(REPO / 'packages/supatrace-js/index.mjs').as_posix()}"),
                json.dumps(str(js_dir)),
                json.dumps(FIXTURE),
            ))
            run = subprocess.run(["node", str(driver)], capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)

            py_files = sorted(p.name for p in py_dir.glob("*.json"))
            js_files = sorted(p.name for p in js_dir.glob("*.json"))
            # Filename equality is the dedup key; content equality is the payload.
            self.assertEqual(py_files, js_files,
                             "spool names differ -> the two CLIs would file one batch twice")
            self.assertEqual((py_dir / py_files[0]).read_bytes(),
                             (js_dir / js_files[0]).read_bytes())
        finally:
            shutil.rmtree(py_dir, ignore_errors=True)
            shutil.rmtree(js_dir, ignore_errors=True)

    @unittest.skipIf(shutil.which("node") is None, "node not available")
    def test_both_halfs_reject_the_same_unsafe_numbers(self):
        # A number that JSON cannot carry must be refused, not silently rewritten. JS
        # JSON.stringify turns Infinity into null; Python's default encoder writes bare
        # `Infinity`. Either rewrite splits one batch into two different payloads.
        py_dir = pathlib.Path(tempfile.mkdtemp())
        js_dir = pathlib.Path(tempfile.mkdtemp())
        try:
            for label, py_value, js_literal in [("Infinity", float("inf"), "Infinity"),
                                                ("NaN", float("nan"), "NaN"),
                                                ("unsafe int", 10 ** 25, "12345678901234567890123")]:
                with self.subTest(label):
                    py = supatrace.init(service="checkout", spool=str(py_dir)).batch(
                        [{"id": f"e-{label}", "time": "2026-11-14T00:00:00Z",
                          "kind": "note", "name": "n", "data": {"v": py_value}}])
                    self.assertFalse(py["report"]["valid"],
                                     f"{label}: python accepted a payload it cannot encode")

                    driver = js_dir / f"drive-{label}.mjs"
                    driver.write_text(JS_DRIVER % (
                        json.dumps(f"{(REPO / 'packages/supatrace-js/index.mjs').as_posix()}"),
                        json.dumps(str(js_dir)),
                        json.dumps([{"id": f"e-{label}", "time": "2026-11-14T00:00:00Z",
                                     "kind": "note", "name": "n",
                                     "data": {"v": None}}]).replace("null", js_literal),
                    ))
                    run = subprocess.run(["node", str(driver)], capture_output=True, text=True)
                    self.assertEqual(run.returncode, 0, run.stderr)
                    reported = json.loads(run.stdout)
                    self.assertFalse(reported["valid"],
                                     f"{label}: node accepted a payload JSON cannot carry")
                    self.assertEqual([], sorted(p.name for p in js_dir.glob("*.json")),
                                     f"{label}: unsafe batch still reached the spool")
        finally:
            shutil.rmtree(py_dir, ignore_errors=True)
            shutil.rmtree(js_dir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()