"""Prototype tests for the Python SDK half.

Run from repo root:
    PYTHONPATH=packages/supatrace/src python3 -m unittest discover \
        -s packages/supatrace/tests -p 'test_*.py'

These are prototype checks, not a release gate: provider protocol is unmeasured here
(no outbound network, no provider key), so nothing in this file asserts a live call.
"""

import hashlib
import json
import os
import pathlib
import tempfile
import unittest

import supatrace

FIXTURE = [{
    "id": "e1",
    "time": "2026-11-14T00:00:00Z",
    "kind": "note",
    "name": "synthetic",
    "data": {"message": "safe", "b": 2, "a": 1},
}]


def new_trace(**kwargs):
    kwargs.setdefault("service", "checkout")
    kwargs.setdefault("spool", tempfile.mkdtemp())
    return supatrace.init(**kwargs)


class SurfaceTest(unittest.TestCase):
    """Public operations preserve the batch and spool contracts."""

    def test_internal_receipts_are_not_public(self):
        for name in ("evidence", "DRIFT", "STATE", "SPEC", "specSha", "decision_record"):
            self.assertFalse(hasattr(supatrace, name), name)
            self.assertNotIn(name, supatrace.__all__)

    def test_public_operations_round_trip(self):
        trace = new_trace()
        ev = [{"id": "e1", "time": "2026-11-14T00:00:00Z", "kind": "note",
               "name": "n", "data": {"a": 1}}]
        self.assertEqual(trace.batch(ev)["batch"]["version"], 1)
        # init
        self.assertIsInstance(supatrace.init(), supatrace.SupaTrace)
        # batch
        self.assertTrue(trace.batch(ev)["report"]["valid"])
        # dry_run must validate without writing, or it is just `write` renamed.
        dry = new_trace().batch(ev, dry_run=True)
        self.assertTrue(dry["report"]["valid"])
        self.assertIsNone(dry["report"]["path"], "dry_run must not write")
        # span
        self.assertTrue(trace.span("checkout.request", {"route": "/x"})["report"]["valid"])
        # attachments: the server's 32 KiB line enforced, not described
        self.assertFalse(trace.batch([{"id": "e2", "time": "2026-11-14T00:00:00Z",
                                        "kind": "note", "name": "big",
                                        "data": "x" * 32769}])["report"]["valid"])
        # close
        trace.close()


    def test_init_defaults_to_source_and_opens_nothing(self):
        trace = supatrace.init()
        self.assertEqual(trace.capture["mode"], "source")
        self.assertFalse(trace.capture["sending"])

    def test_default_spool_matches_the_js_half(self):
        import os
        from unittest import mock

        with mock.patch.dict(os.environ, {"SUPATRACE_SPOOL": ""}):
            trace = supatrace.init()
        self.assertEqual(trace.spool, pathlib.Path.home() / ".supatrace" / "pending")

    def test_init_sets_the_default_handle(self):
        trace = supatrace.init(service="default-check")
        self.assertIs(supatrace.get_default(), trace)


class BatchTest(unittest.TestCase):
    def test_valid_batch_spools_and_reads_back_identical(self):
        trace = new_trace()
        result = trace.batch(FIXTURE)
        self.assertTrue(result["report"]["valid"], result["report"]["errors"])
        self.assertIsNotNone(result["report"]["path"])
        on_disk = json.loads(pathlib.Path(result["report"]["path"]).read_bytes())
        self.assertEqual(on_disk, result["batch"])

    def test_retry_of_identical_content_is_a_dedup_hit_not_a_crash(self):
        # Regression: content-derived filenames made the second write hit O_EXCL and raise.
        trace = new_trace()
        first = trace.batch(FIXTURE)
        second = trace.batch(FIXTURE)
        self.assertFalse(first["report"]["deduplicated"])
        self.assertTrue(second["report"]["deduplicated"])
        self.assertEqual(first["batch"]["batch_id"], second["batch"]["batch_id"])

    def test_batch_id_and_filename_are_content_derived(self):
        # A time- or random-based id made one logical batch look like new evidence on retry.
        first = new_trace().batch(FIXTURE)
        second = new_trace().batch(FIXTURE)
        self.assertEqual(first["batch"]["batch_id"], second["batch"]["batch_id"])
        self.assertTrue(first["report"]["path"].endswith(
            first["report"]["sha256"] + ".json"))

    def test_spool_bytes_match_the_uploader_canonical_form(self):
        # Canonical UTF-8 bytes determine both the digest and the filename.
        trace = new_trace()
        result = trace.batch(FIXTURE)
        written = pathlib.Path(result["report"]["path"]).read_bytes()
        canonical = json.dumps(result["batch"], sort_keys=True, ensure_ascii=False,
                               separators=(",", ":")).encode("utf-8")
        expected = hashlib.sha256(canonical).hexdigest()
        self.assertEqual(result["report"]["path"].split("/")[-1], expected + ".json")
        self.assertEqual(written, canonical)

    def test_spool_is_flat_to_match_the_uploader(self):
        # upload.py's --spool IS the pending directory; a spool/pending/ subdir here would
        # mean the shipped uploader never sees the file.
        trace = new_trace()
        path = trace.batch(FIXTURE)["report"]["path"]
        self.assertNotIn("pending", pathlib.Path(path).parts)

    def test_hostile_text_is_kept_as_data(self):
        trace = new_trace()
        result = trace.batch([{"id": "e1", "time": "2026-11-14T00:00:00Z",
                               "kind": "note", "name": "xss",
                               "data": "<script>alert(1)</script>"}])
        self.assertTrue(result["report"]["valid"])

    def test_rejects_what_the_server_rejects(self):
        trace = new_trace()
        for label, event in {
            "kind": {"kind": "admin"},
            "timezone": {"time": "2026-11-14T00:00:00"},
        }.items():
            base = {"id": "e1", "time": "2026-11-14T00:00:00Z", "kind": "note",
                    "name": "n", "data": {}}
            base.update(event)
            with self.subTest(label):
                self.assertFalse(trace.batch([base])["report"]["valid"])

    def test_duplicate_event_ids_rejected_and_not_spooled(self):
        trace = new_trace()
        event = {"id": "e1", "time": "2026-11-14T00:00:00Z", "kind": "note",
                 "name": "n", "data": {}}
        result = trace.batch([event, {**event, "name": "m"}])
        self.assertFalse(result["report"]["valid"])
        self.assertIsNone(result["report"]["path"])

    def test_empty_source_produces_no_batch(self):
        trace = new_trace()
        self.assertTrue(trace.batch([])["report"]["empty"])
        self.assertTrue(trace.batch(lambda: [])["report"]["empty"])

    def test_oversized_payload_refused_at_the_same_line_as_the_server(self):
        trace = new_trace()
        result = trace.batch([{"id": "e1", "time": "2026-11-14T00:00:00Z",
                               "kind": "note", "name": "big",
                               "data": "x" * 32769}])
        self.assertFalse(result["report"]["valid"])


class ContentTest(unittest.TestCase):
    def test_capture_content_is_opt_in(self):
        self.assertFalse(supatrace.init().capture["capture_content"])

    def test_otlp_mode_tells_the_instrumentors_not_to_record_content(self):
        # The instrumentors default to recording prompts; the flag must reach them.
        import os
        from unittest import mock

        switches = ("TRACELOOP_TRACE_CONTENT", "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT")
        with mock.patch.dict(os.environ, {"TRACELOOP_TRACE_CONTENT": "true"}):
            supatrace.init(mode="otlp")
            self.assertEqual([os.environ[n] for n in switches], ["false", "false"])
            supatrace.init(mode="otlp", capture_content=True)
            self.assertEqual([os.environ[n] for n in switches], ["true", "true"])


class KeyTest(unittest.TestCase):
    def test_key_parses_and_never_leaks(self):
        parsed = supatrace.parse_api_key("a" * 43 + ".proj_" + "0" * 32)
        self.assertEqual(parsed["project"], "proj_" + "0" * 32)
        with self.assertRaises(ValueError):
            supatrace.parse_api_key("totally-not-a-key")
        trace = supatrace.init(api_key="totally-not-a-key-that-is-long")
        self.assertNotIn("totally-not-a-key-that-is-long", json.dumps(trace.capture))

    def test_typed_keys_parse_and_wrong_prefixes_do_not(self):
        project = "proj_" + "0" * 32
        for prefix in ("st_pub_", "st_sec_"):
            key = prefix + "a" * 43
            self.assertEqual(supatrace.parse_api_key(key + "." + project)["secret"], key)
            self.assertEqual(supatrace.parse_api_key(key)["secret"], key)
        for bad in ("st_adm_" + "a" * 43, "st_pub_" + "a" * 42, "st_pub_" + "a" * 44, "ST_PUB_" + "a" * 43):
            with self.assertRaises(ValueError):
                supatrace.parse_api_key(bad)


def _has_otel_sdk():
    try:
        import opentelemetry.sdk.trace  # noqa: F401
    except ImportError:
        return False
    return True


def _has_otlp_exporter():
    try:
        import opentelemetry.exporter.otlp.proto.http.trace_exporter  # noqa: F401
    except ImportError:
        return False
    return _has_otel_sdk()


KEY = "a" * 43 + ".proj_" + "0" * 32


@unittest.skipUnless(_has_otel_sdk(), "opentelemetry-sdk not installed")
class ProviderIsolationTest(unittest.TestCase):
    def test_application_can_set_global_provider_before_or_after_init(self):
        import subprocess
        import sys

        # Separate interpreters honor OpenTelemetry's once-only global registration.
        script = r"""
import sys
from opentelemetry import trace as otel
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
import supatrace

sink = InMemorySpanExporter()
app = TracerProvider()
app.add_span_processor(SimpleSpanProcessor(sink))
if sys.argv[1] == "before":
    otel.set_tracer_provider(app)
original = otel.get_tracer_provider()
client = supatrace.init(mode="otlp", endpoint="http://127.0.0.1:4318",
                       collect=True, instruments=("unknown",))
assert client.capture["sending"], client.capture
assert otel.get_tracer_provider() is original
if sys.argv[1] == "after":
    otel.set_tracer_provider(app)
assert otel.get_tracer_provider() is app
with otel.get_tracer("application").start_as_current_span("app-before-close"):
    pass
client.span("sdk-only")
client.flush()
assert [s.name for s in client.sink.get_finished_spans()] == ["sdk-only"]
client.close()
with otel.get_tracer("application").start_as_current_span("app-after-close"):
    pass
assert [s.name for s in sink.get_finished_spans()] == ["app-before-close", "app-after-close"]
app.shutdown()
"""
        for order in ("before", "after"):
            with self.subTest(order=order):
                subprocess.run([sys.executable, "-c", script, order], check=True,
                               capture_output=True, text=True)


class ParityEdgeTest(unittest.TestCase):
    def test_integral_float_spools_like_js(self):
        a = new_trace().batch([{**FIXTURE[0], "data": {"v": 1.0}}])
        b = new_trace().batch([{**FIXTURE[0], "data": {"v": 1}}])
        self.assertEqual(a["batch"]["batch_id"], b["batch"]["batch_id"])
        self.assertEqual(pathlib.Path(a["report"]["path"]).read_bytes(),
                         pathlib.Path(b["report"]["path"]).read_bytes())

    def test_depth_counts_from_the_batch_root_like_trace_mjs(self):
        def nested(n):
            value = 1
            for _ in range(n):
                value = [value]
            return value
        # data at depth 3; trace.mjs rejects any node deeper than 32.
        self.assertTrue(new_trace().batch([{**FIXTURE[0], "data": nested(29)}])["report"]["valid"])
        self.assertFalse(new_trace().batch([{**FIXTURE[0], "data": nested(30)}])["report"]["valid"])

    def test_size_limit_counts_utf8_bytes_like_trace_mjs(self):
        # 6000 x "é" is 12000 UTF-8 bytes; ASCII escaping made it 36000 and refused it.
        self.assertTrue(new_trace().batch([{**FIXTURE[0], "data": "é" * 6000}])["report"]["valid"])

    def test_size_limit_measures_floats_the_js_way(self):
        # [1.0]*9000 is 18001 bytes as JS writes it; Python's "1.0" made it 36001.
        self.assertTrue(new_trace().batch([{**FIXTURE[0], "data": [1.0] * 9000}])["report"]["valid"])

    def test_name_length_counts_utf16_units_like_trace_mjs(self):
        self.assertTrue(new_trace().batch([{**FIXTURE[0], "name": "😀" * 100}])["report"]["valid"])
        self.assertFalse(new_trace().batch([{**FIXTURE[0], "name": "😀" * 101}])["report"]["valid"])

    def test_unhashable_event_id_is_reported_not_raised(self):
        result = new_trace().batch([{**FIXTURE[0], "id": []}])
        self.assertFalse(result["report"]["valid"])

    def test_non_json_data_is_reported_not_raised(self):
        result = new_trace().batch([{**FIXTURE[0], "data": {1, 2}}])
        self.assertFalse(result["report"]["valid"])

    def test_huge_integer_is_reported_not_raised(self):
        result = new_trace().batch([{**FIXTURE[0], "data": 10 ** 400}], dry_run=True)
        self.assertFalse(result["report"]["valid"])

    def test_endpoint_in_env_alone_does_not_select_otlp(self):
        from unittest import mock
        with mock.patch.dict(os.environ, {"SUPATRACE_OTLP_ENDPOINT": "http://127.0.0.1:9"}):
            trace = supatrace.init(api_key=KEY)
        self.assertEqual(trace.capture["mode"], "source")
        self.assertFalse(trace.capture["sending"])


class OtlpTest(unittest.TestCase):
    def test_otlp_without_a_key_does_not_export(self):
        trace = supatrace.init(mode="otlp", endpoint="http://127.0.0.1:9")
        self.assertFalse(trace.capture["sending"])
        self.assertRegex(" ".join(trace.capture["skipped"]), r"refusing to export unauthenticated")

    @unittest.skipUnless(_has_otlp_exporter(), "opentelemetry exporter not installed")
    def test_otlp_export_carries_the_api_key(self):
        import http.server
        import threading

        seen = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                seen.append((self.path, self.headers.get("Authorization"),
                             self.headers.get("X-Supatrace-Key")))
                self.send_response(200)
                self.end_headers()

            def log_message(self, *args):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            endpoint = f"http://127.0.0.1:{server.server_port}"
            trace = supatrace.init(mode="otlp", endpoint=endpoint, api_key=KEY, instruments=[])
            self.assertTrue(trace.capture["sending"])
            self.assertEqual(trace.span("checkout.request")["recorded"], "otlp")
            self.assertTrue(trace.flush()["flushed"])
            trace.close()
        finally:
            server.shutdown()
        self.assertTrue(seen, "no OTLP request reached the listener")
        self.assertEqual(seen[0], ("/v1/traces", "Bearer " + "a" * 43, "a" * 43))

    @unittest.skipUnless(_has_otel_sdk(), "opentelemetry-sdk not installed")
    def test_openinference_needs_its_instrumentor_class(self):
        import sys
        import types
        from unittest import mock

        calls = []

        class LangChainInstrumentor:
            def instrument(self, **kwargs):
                calls.append(kwargs)

        class TraceConfig:
            def __init__(self):
                self.hide_inputs = os.environ.get("OPENINFERENCE_HIDE_INPUTS") == "true"
                self.hide_outputs = os.environ.get("OPENINFERENCE_HIDE_OUTPUTS") == "true"

        root = types.ModuleType("openinference")
        pkg = types.ModuleType("openinference.instrumentation")
        pkg.TraceConfig = TraceConfig
        bare = types.ModuleType("openinference.instrumentation.llama_index")
        good = types.ModuleType("openinference.instrumentation.langchain")
        good.LangChainInstrumentor = LangChainInstrumentor
        fakes = {"openinference": root, "openinference.instrumentation": pkg,
                 "openinference.instrumentation.llama_index": bare,
                 "openinference.instrumentation.langchain": good}
        with mock.patch.dict(sys.modules, fakes), mock.patch.dict(os.environ, {}):
            trace = supatrace.init(mode="otlp", endpoint="http://127.0.0.1:9", collect=True,
                                   instruments=["langchain", "llama_index"])
        self.assertEqual(trace.capture["instrumented"], ["langchain"])
        self.assertIn("llama_index: openinference.instrumentation.llama_index has no "
                      "LlamaIndexInstrumentor", trace.capture["skipped"])
        self.assertIs(calls[0]["tracer_provider"], trace._provider)
        # capture_content defaults off, so openinference must be told to hide content.
        self.assertTrue(calls[0]["config"].hide_inputs)
        self.assertTrue(calls[0]["config"].hide_outputs)

    @unittest.skipUnless(_has_otel_sdk(), "opentelemetry-sdk not installed")
    def test_openinference_without_trace_config_is_skipped_when_content_is_off(self):
        import sys
        import types
        from unittest import mock

        class LangChainInstrumentor:
            def instrument(self, **kwargs):
                raise AssertionError("must not instrument without a way to hide content")

        good = types.ModuleType("openinference.instrumentation.langchain")
        good.LangChainInstrumentor = LangChainInstrumentor
        fakes = {"openinference": types.ModuleType("openinference"),
                 "openinference.instrumentation": types.ModuleType("openinference.instrumentation"),
                 "openinference.instrumentation.langchain": good}
        with mock.patch.dict(sys.modules, fakes), mock.patch.dict(os.environ, {}):
            trace = supatrace.init(mode="otlp", endpoint="http://127.0.0.1:9", collect=True,
                                   instruments=["langchain"])
        self.assertEqual(trace.capture["instrumented"], [])
        self.assertRegex(" ".join(trace.capture["skipped"]), r"cannot hide content")


if __name__ == "__main__":
    unittest.main()