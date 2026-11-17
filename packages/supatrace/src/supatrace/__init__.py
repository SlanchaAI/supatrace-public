"""Alpha SupaTrace client: local batches by default, explicit opt-in OTLP export.

Source mode writes local JSON batches. OTLP mode sends explicit spans when an
endpoint, ingest key and optional exporter are present. Content capture is a
separate opt-in. Importing this module sends nothing.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import math
import os
import re
import threading
from pathlib import Path

PROVIDER_PACKAGES = ("openai", "anthropic", "langchain", "llama_index")

# The only instruments we attach. Anything else is reported as `skipped`, never guessed at.
DEFAULT_INSTRUMENTS = ("openai", "anthropic")

KEY_FILE_ENV = "SUPATRACE_API_KEY"
ENDPOINT_ENV = "SUPATRACE_OTLP_ENDPOINT"
CONTENT_ENV = "SUPATRACE_CAPTURE_CONTENT"

PROJECT_RE = re.compile(r"proj_[a-f0-9]{32}")
# A bare 43-character pairing key, or a typed st_pub_ (ingest) / st_sec_ (secret) key.
KEY_RE = re.compile(r"^(?:st_(?:pub|sec)_)?[A-Za-z0-9_-]{43}$")

_BATCH_KEYS = ("version", "batch_id", "run_id", "events")
_EVENT_KEYS = ("id", "time", "kind", "name", "data")
_KINDS = ("request", "tool_call", "tool_result", "response", "error", "note")
_LIMITS = {"bytes": 524288, "events": 100, "text": 32768, "nesting": 32}

def _canonical_bytes(value):
    """Canonical bytes for hashing and for the spool file.

    allow_nan=False is deliberate, not cosmetic. Python's default emits bare `Infinity` /
    `NaN`, which is not JSON: the server's `JSON.parse` reads `Infinity` as a syntax error,
    and `JSON.stringify(1e400)` in JS emits `null`. The same logical payload would therefore
    spool to different bytes depending on which CLI wrote it, and both the spool filename and
    the `x-amz-content-sha256` dedup key are taken over these bytes. Rejecting unsafe numbers
    at build time keeps one batch equal to itself across languages.
    """
    return json.dumps(_js_numbers(value), sort_keys=True, ensure_ascii=False,
                      separators=(",", ":"), allow_nan=False).encode()


def _js_numbers(value):
    """Write integral floats the way JSON.stringify does: 1.0 becomes 1.

    Python's encoder writes ``1.0`` and JS writes ``1``, so the same event got two batch ids
    and two spool names. Non-finite values pass through and are refused by allow_nan=False.
    Known residue: exponent forms (Python ``1e-07``, JS ``1e-7``) still differ.
    """
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {k: _js_numbers(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_js_numbers(v) for v in value]
    return value


def _canonical(value):
    """Canonical bytes, or None if the payload cannot be expressed as strict JSON."""
    try:
        return _canonical_bytes(value)
    except (ValueError, TypeError, RecursionError):
        return None


def _redacted(secret: str) -> str:
    """Never return a whole secret. Used in every diagnostic and repr."""
    if not secret or len(secret) <= 12:
        return "<redacted>"
    return f"{secret[:4]}…{secret[-4:]} (len {len(secret)}, redacted)"


def parse_api_key(value):
    """Split a redacted key into (secret, project).

    Accepted shapes, in order:
      1. ``<secret>.<proj_hex>``            — redacted, project carried in the key
      2. ``<secret>``                       — project taken from SUPATRACE_PROJECT if set
      3. ``proj_<32 hex>``                  — project-only, no key; stays source-mode

    Returns a dict. Raises ValueError on a shape that cannot be interpreted, because a
    mistyped key silently downgrading to "no project" is how traces get misattributed.
    """
    if not isinstance(value, str) or not value.strip():
        raise ValueError("SUPATRACE_API_KEY is empty")
    text = value.strip()
    secret, project = None, None
    if "." in text:
        secret, _, project = text.partition(".")
        if not KEY_RE.fullmatch(secret):
            raise ValueError(
                f"key secret part is not {KEY_RE.pattern} (redacted: {_redacted(secret)})"
            )
        if not PROJECT_RE.fullmatch(project):
            raise ValueError(
                "project part after the dot must be proj_ + 32 lowercase hex "
                f"(redacted: {_redacted(project)})"
            )
    elif PROJECT_RE.fullmatch(text):
        project = text
    else:
        secret = text
        if not KEY_RE.fullmatch(secret):
            raise ValueError(f"key does not match {KEY_RE.pattern} (redacted: {_redacted(text)})")
    if project is None:
        project = os.environ.get("SUPATRACE_PROJECT") or "default"
        if not project:
            raise ValueError("no project in the key and SUPATRACE_PROJECT is empty")
    return {
        "secret": secret,
        "project": project,
        "redacted": _redacted(text),
        "source": "key" if "." in text or PROJECT_RE.fullmatch(text) else "SUPATRACE_PROJECT",
    }


class SupaTrace:
    """The object ``init()`` returns.

    ``capture`` holds what actually took effect after the opt-ins were applied, so a
    reader can tell "instrumented and sending" apart from "instrumentation installed,
    nowhere to send it".
    """

    def __init__(self, *, service, mode, endpoint, secret, project, instruments,
                 capture_content, spool, environment, sink=None):
        self.service = service
        self.mode = mode
        self.endpoint = endpoint
        self.project = project
        self.environment = environment
        self.spool = Path(spool) if spool else None
        self.capture_content = bool(capture_content)
        self._secret = secret  # never printed, never returned
        self.sink = sink
        self.tracer = None
        self._provider = None
        self._instrumented = []
        self._skipped = []
        self._telemetry_used = False
        self._batches = []
        self._lock = threading.Lock()

    # -- introspection ----------------------------------------------------
    @property
    def capture(self):
        return {
            "mode": self.mode,
            "endpoint": self.endpoint or None,
            "sending": bool(self.endpoint and self._provider is not None),
            "project": self.project,
            "instrumented": list(self._instrumented),
            "skipped": list(self._skipped),
            "capture_content": self.capture_content,
            "telemetry_used": self._telemetry_used,
            "key": "present" if self._secret else "absent",
        }

    def __repr__(self):
        c = self.capture
        return (f"<SupaTrace service={self.service!r} mode={c['mode']} "
                f"project={c['project']} sending={c['sending']} "
                f"instrumented={c['instrumented']} key={c['key']}>")

    # -- batch path (source mode, and the offline half of otlp mode) -----
    def batch(self, events, *, batch_id=None, run_id=None, write=True, dry_run=False):
        """Build a SupaTrace batch from a list of events or a callable.

        Zero-event input produces no batch. A callable source is read once and its items
        are not retained by the SDK afterwards (zero-copy intent, matching the JS half).
        """
        source_label = None
        if callable(events):
            source_label = getattr(events, "__name__", "callable")
            events = events()
        events = [dict(e) for e in (events or []) if isinstance(e, dict)]
        if not events:
            return {"batch": None, "report": {"empty": True, "source": source_label,
                                               "errors": ["empty_batch_skipped"]}}
        body = {
            "version": 1,
            "run_id": run_id or self.service,
            "events": events,
        }
        # Validate the content *before* deriving an identity from it. Ordering matters: an
        # unencodable value (Infinity, an oversized int) makes canonical encoding raise, and
        # hashing first turned bad-but-observable data into a traceback in the caller's thread.
        probe_errors = _validate({**body, "batch_id": "probe"})
        if probe_errors:
            return {"batch": None, "report": {"empty": False, "source": source_label,
                                              "valid": False, "deduplicated": False,
                                              "errors": probe_errors, "path": None,
                                              "sha256": None}}
        batch_id = batch_id or _batch_id(self.service, body)
        payload = {**body, "batch_id": batch_id}
        errors = _validate(payload)
        path = None
        deduplicated = False
        if not errors and write and not dry_run and self.mode == "source" \
                and self.spool is not None:
            path, deduplicated = _write_batch(self.spool, payload)
            if not deduplicated:
                with self._lock:
                    self._batches.append((payload, path))
        return {
            "batch": payload,
            "report": {
                "empty": False,
                "source": source_label,
                "valid": not errors,
                "errors": errors,
                "deduplicated": deduplicated,
                "path": str(path) if path else None,
                "sha256": (hashlib.sha256(_canonical(payload)).hexdigest()
                           if _canonical(payload) is not None else None),
            },
        }

    def span(self, name, attributes=None, *, kind="note"):
        """One traced span. In otlp mode with an endpoint this becomes OTLP; otherwise it
        is recorded into a batch you still review yourself. Never sends silently."""
        self._telemetry_used = True
        if self._provider is not None and self.tracer is not None:
            with self.tracer.start_as_current_span(name, attributes=attributes or {}):
                return {"recorded": "otlp", "name": name}
        event = {"id": f"span-{len(self._batches)}-{os.getpid()}",
                 "time": _now(), "kind": kind, "name": name,
                 "data": dict(attributes or {})}
        return self.batch([event])

    def exported(self):
        """Span names held by the collect-mode exporter, for tests. Empty unless
        ``init(collect=True)`` was used; never populated in otlp mode."""
        if self.sink is None:
            return []
        spans = self.sink.get_finished_spans()
        return [s.name for s in spans]

    def flush(self, timeout_millis=3000):
        if self._provider is None:
            return {"flushed": False, "reason": "no provider — source mode or no endpoint"}
        return {"flushed": self._provider.force_flush(timeout_millis)}

    def shutdown(self, timeout_millis=3000):
        if self._provider is None:
            return {"shutdown": False, "reason": "no provider"}
        result = self._provider.shutdown()
        self._provider = None
        return {"shutdown": result is not False, "reason": None}

    def close(self, timeout_millis=3000):
        result = self.shutdown(timeout_millis)
        self.tracer = None
        return result


def _now():
    import datetime

    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds")


def _batch_id(service, payload_body):
    # Content-derived IDs let identical retries reuse the same spool file.
    digest = hashlib.sha256(_canonical_bytes(payload_body)).hexdigest()[:16]
    return f"{service}-{digest}"


def _write_batch(spool: Path, payload):
    """Spool one batch. Returns (path, deduplicated).

    The filename is the content digest, so an identical retry resolves to the same path. That
    is a dedup hit, not a collision: the bytes about to be written are already on disk.
    O_EXCL still guards the genuine case — same digest, different bytes cannot happen by
    construction, but a half-written file from an earlier crash must never be silently reused.
    """
    spool.mkdir(parents=True, exist_ok=True)
    data = _canonical(payload)
    if data is None:
        # Unreachable via batch() — _validate rejects it first — but a caller that hands us a
        # raw dict must get a refusal, not a traceback from deep inside json.dumps.
        raise ValueError("batch contains values that are not valid JSON")
    path = spool / (hashlib.sha256(data).hexdigest() + ".json")
    if path.exists():
        if path.read_bytes() == data:
            return path, True
        # Same digest, different bytes means the file is not what we think it is. Refuse it
        # rather than overwrite someone else's evidence.
        raise OSError(f"spool entry {path.name} does not match its digest")
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)
    return path, False


def _validate(payload):
    """Validate the batch format before writing local files."""
    errors = []
    for key in payload:
        if key not in _BATCH_KEYS:
            errors.append(f"unknown_field:{key}")
    if payload.get("version") != 1:
        errors.append("invalid_version")
    for key in ("batch_id", "run_id"):
        value = payload.get(key)
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}", value or ""):
            errors.append(f"invalid_id:{key}")
    events = payload.get("events")
    if not isinstance(events, list) or not 1 <= len(events) <= _LIMITS["events"]:
        errors.append("invalid_count")
    else:
        seen = set()
        for event in events:
            if not isinstance(event, dict):
                errors.append("invalid_event")
                continue
            for key in event:
                if key not in _EVENT_KEYS:
                    errors.append(f"unknown_event_field:{key}")
            eid = event.get("id")
            if not isinstance(eid, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}", eid or ""):
                errors.append(f"invalid_id:{eid}")
            elif eid in seen:
                errors.append(f"duplicate_event:{eid}")
            else:
                seen.add(eid)
            # Timestamps must carry a timezone. A naive stamp used to pass here and then get
            # rejected by trace.mjs, which is the exact divergence delegation avoids.
            stamp = event.get("time")
            if (not isinstance(stamp, str)
                    or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})", stamp or "")
                    or _parse_time(stamp) is None):
                errors.append(f"invalid_time:{eid}")
            if event.get("kind") not in _KINDS:
                errors.append(f"invalid_kind:{event.get('kind')}")
            name = event.get("name")
            # trace.mjs measures name.length in UTF-16 code units, not code points.
            if (not isinstance(name, str) or not name.strip()
                    or len(name.encode("utf-16-le", "surrogatepass")) // 2 > 200):
                errors.append(f"invalid_name:{eid}")
            try:
                # Measured as trace.mjs does: compact JSON.stringify of data, in UTF-8 bytes,
                # with numbers written the JS way.
                data_bytes = len(json.dumps(_js_numbers(event.get("data")), ensure_ascii=False,
                                            separators=(",", ":")).encode())
            except (TypeError, ValueError):
                data_bytes = None
            if "data" not in event or data_bytes is None:
                errors.append(f"invalid_data:{eid}")
            elif data_bytes > _LIMITS["text"]:
                errors.append(f"event_data_exceeds_32KiB:{eid}")
            else:
                # trace.mjs counts depth from the batch root; data sits at
                # batch -> events -> [i] -> data, three levels down.
                depth, bad_number = _scan(event.get("data"), 3)
                if bad_number:
                    errors.append(f"unsupported_number:{eid}")
                if depth > 32:
                    errors.append(f"too_deep:{eid}")
    canonical_bytes = _canonical(payload)
    if canonical_bytes is None:
        # Reached only when _scan already flagged it; kept so the size check cannot raise.
        errors.append("unsupported_number")
    elif len(canonical_bytes) > _LIMITS["bytes"]:
        errors.append("too_large")
    return errors


def _parse_time(stamp):
    try:
        # fromisoformat handles the '+05:30' offsets the server regex allows.
        parsed = datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def _scan(value, _depth=0):
    """Return (max_depth, has_unsafe_number) mirroring trace.mjs depthCheck."""
    max_depth = _depth
    bad = False
    stack = [(value, _depth)]
    while stack:
        node, depth = stack.pop()
        if isinstance(node, bool):
            continue
        # Same rule as trace.mjs depthCheck, so a fraction like 1.5 is accepted by both halves
        # and neither side silently rewrites it (see _canonical_bytes for why that matters).
        if isinstance(node, int):
            # Checked as an int: float(10**400) would raise OverflowError.
            if abs(node) >= 2 ** 53:
                bad = True
        elif isinstance(node, float):
            if not math.isfinite(node) or (node.is_integer() and abs(node) >= 2 ** 53):
                bad = True
        if isinstance(node, dict):
            for child in node.values():
                stack.append((child, depth + 1))
                max_depth = max(max_depth, depth + 1)
        elif isinstance(node, list):
            for child in node:
                stack.append((child, depth + 1))
                max_depth = max(max_depth, depth + 1)
    return max_depth, bad


def _endpoint(value=None):
    endpoint = value or os.environ.get(ENDPOINT_ENV) or ""
    return endpoint.strip().rstrip("/") or None


def _content_requested(explicit):
    if explicit is not None:
        return bool(explicit)
    return os.environ.get(CONTENT_ENV, "").strip().lower() in ("1", "true", "yes", "on")


def init(component=None, config=None, **kwargs):
    """One-line entry point.

    Python:  ``supatrace.init()``  /  ``supatrace.init(service="checkout")``
    JS:      ``supatrace.init({...})`` — same contract in the JavaScript client.

    Reads ``SUPATRACE_API_KEY`` (secret + project), ``SUPATRACE_OTLP_ENDPOINT`` and
    ``SUPATRACE_CAPTURE_CONTENT``. Anything passed explicitly wins over the environment.

    No provider client is imported, no exporter is created and no socket is opened unless
    ``mode="otlp"`` is requested. ``init()`` is safe to call at import time for that reason.
    """
    options = dict(config or {})
    options.update(kwargs)
    service = component or options.get("service") or os.environ.get("SUPATRACE_SERVICE") or "supatrace"
    # Export is opt-in: an endpoint in the environment alone never turns on a sender.
    mode = options.get("mode") or "source"
    if mode not in ("source", "otlp"):
        raise ValueError(f'unknown mode {mode!r}; use "source" or "otlp"')

    key = options.get("api_key") or os.environ.get(KEY_FILE_ENV) or ""
    parsed = None
    key_error = None
    if key:
        try:
            parsed = parse_api_key(key)
        except ValueError as error:
            key_error = str(error)
            parsed = {"secret": None, "project": options.get("project", "default"),
                      "redacted": _redacted(key), "source": "unparsed"}

    project = options.get("project") or (parsed["project"] if parsed else None) \
        or os.environ.get("SUPATRACE_PROJECT") or "default"
    secret = parsed["secret"] if parsed else None
    endpoint = _endpoint(options.get("endpoint"))
    capture_content = _content_requested(options.get("capture_content"))
    spool = options.get("spool") or os.environ.get("SUPATRACE_SPOOL") \
        or (str(Path.home() / ".supatrace" / "pending") if mode == "source" else None)

    trace = SupaTrace(
        service=service, mode=mode, endpoint=endpoint, secret=secret, project=project,
        instruments=None, capture_content=capture_content, spool=spool,
        environment=options.get("environment") or "default",
    )
    trace.key_error = key_error
    trace.key_summary = parsed["redacted"] if parsed else "absent"

    if mode == "otlp":
        _attach_telemetry(trace, options)
    global _DEFAULT
    _DEFAULT = trace
    return trace


def _attach_telemetry(trace, options):
    """Only called when mode == "otlp". Imports OTel lazily, so a source-mode install
    never needs opentelemetry on the interpreter path."""
    instruments = tuple(options.get("instruments") or DEFAULT_INSTRUMENTS)
    trace.instruments = list(instruments)
    _apply_content_policy(trace.capture_content)
    if not trace.endpoint:
        trace._skipped = [f"{name}: no {ENDPOINT_ENV}; nothing to export to" for name in instruments]
        return
    if not trace._secret and not options.get("collect"):
        trace._skipped = [f"{name}: no {KEY_FILE_ENV} secret; refusing to export unauthenticated"
                          for name in instruments]
        return
    try:
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
    except ImportError:
        trace._skipped = [f"{name}: opentelemetry-sdk is not installed" for name in instruments]
        return

    sink = None
    if options.get("collect"):
        # Test/inspection hook only: the SDK's own InMemorySpanExporter. Nothing is sent
        # in this mode, which is the point — it shows what *would* be exported without
        # opening a socket. Requires opentelemetry-sdk on the path.
        from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

        sink = InMemorySpanExporter()
        exporter = sink
    else:
        try:
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

            # Authenticate the OTLP request with the supplied ingest key.
            exporter = OTLPSpanExporter(
                endpoint=trace.endpoint + "/v1/traces",
                headers={"Authorization": "Bearer " + trace._secret,
                         "X-Supatrace-Key": trace._secret},
            )
        except ImportError:
            trace._skipped = [f"{name}: opentelemetry-exporter-otlp-proto-http is not installed"
                              for name in instruments]
            return

    provider = TracerProvider(
        resource=Resource.create({"service.name": trace.service,
                                  "supatrace.project": trace.project,
                                  "supatrace.mode": "otlp"}),
    )
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace._provider = provider
    trace.sink = sink
    trace.tracer = provider.get_tracer("supatrace", "0.1.0")

    import importlib

    for name in trace.instruments:
        target = _INSTRUMENTORS.get(name)
        if target is None:
            trace._skipped.append(f"{name}: unknown instrumentor")
            continue
        module, class_name = target
        try:
            mod = importlib.import_module(module)
        except ImportError:
            trace._skipped.append(f"{name}: {module} not installed")
            continue
        cls = getattr(mod, class_name, None)
        if cls is None:
            trace._skipped.append(f"{name}: {module} has no {class_name}")
            continue
        # Both families (OpenLLMetry and openinference) subclass BaseInstrumentor, which
        # takes the provider itself, not a tracer.
        kwargs = {"tracer_provider": provider}
        if module.startswith("openinference."):
            # Pass the hide settings explicitly too, so the policy does not depend on when
            # the instrumentor reads its environment. No TraceConfig means no way to hide
            # content, so the instrumentor is skipped unless content capture was asked for.
            try:
                from openinference.instrumentation import TraceConfig
                kwargs["config"] = TraceConfig()
            except ImportError:
                if not trace.capture_content:
                    trace._skipped.append(f"{name}: openinference TraceConfig unavailable; "
                                          "cannot hide content")
                    continue
        cls().instrument(**kwargs)
        trace._instrumented.append(name)


# The instrumentors read their own switches, not ours. opentelemetry-instrumentation-openai /
# -anthropic (OpenLLMetry) record prompts and completions unless TRACELOOP_TRACE_CONTENT is
# "false", so without this the capture_content=False default was a label, not a behaviour.
_CONTENT_SWITCHES = ("TRACELOOP_TRACE_CONTENT", "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT")
# openinference (LangChain / LlamaIndex) has the opposite polarity: it records content unless
# told to hide it.
_HIDE_SWITCHES = ("OPENINFERENCE_HIDE_INPUTS", "OPENINFERENCE_HIDE_OUTPUTS",
                  "OPENINFERENCE_HIDE_INPUT_MESSAGES", "OPENINFERENCE_HIDE_OUTPUT_MESSAGES",
                  "OPENINFERENCE_HIDE_INPUT_TEXT", "OPENINFERENCE_HIDE_OUTPUT_TEXT",
                  "OPENINFERENCE_HIDE_INPUT_IMAGES")


def _apply_content_policy(capture_content):
    value = "true" if capture_content else "false"
    for name in _CONTENT_SWITCHES:
        os.environ[name] = value
    hide = "false" if capture_content else "true"
    for name in _HIDE_SWITCHES:
        os.environ[name] = hide


_INSTRUMENTORS = {
    "openai": ("opentelemetry.instrumentation.openai", "OpenAIInstrumentor"),
    "anthropic": ("opentelemetry.instrumentation.anthropic", "AnthropicInstrumentor"),
    "langchain": ("openinference.instrumentation.langchain", "LangChainInstrumentor"),
    "llama_index": ("openinference.instrumentation.llama_index", "LlamaIndexInstrumentor"),
}


_DEFAULT = None


def get_default():
    return _DEFAULT


def shutdown_all():
    global _DEFAULT
    if _DEFAULT is not None:
        _DEFAULT.close()
        _DEFAULT = None


__all__ = ["init", "SupaTrace", "parse_api_key", "PROVIDER_PACKAGES"]
