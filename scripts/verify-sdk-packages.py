"""Verify release archives and README quickstarts from clean, local installs.

Usage: python3 scripts/verify-sdk-packages.py /absolute/path/to/dist
Requires build artifacts, pip, venv, Node 22+ and npm. Never publishes.
"""

import email
import hashlib
import http.server
import json
import os
import shlex
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import threading
import zipfile

from packaging.requirements import Requirement

REPO = Path(__file__).resolve().parents[1]
DIST = Path(sys.argv[1]).resolve()
KEY = "st_pub_" + "a" * 43  # Synthetic fixture; never a hosted credential.
ENV = {k: v for k, v in os.environ.items()
       if not k.startswith(("SUPATRACE_", "OTEL_", "PYTHONPATH"))}


def run(*args, cwd, env=None):
    result = subprocess.run(args, cwd=cwd, env=env or ENV, capture_output=True, text=True, timeout=180)
    if result.returncode:
        # Do not echo subprocess output: exporters may include request diagnostics.
        raise RuntimeError(f"{Path(args[0]).name} failed (exit {result.returncode})")
    return result.stdout


def snippet(readme, language):
    return readme.split(f"```{language}\n", 1)[1].split("```", 1)[0]


def assert_license(text):
    assert "TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION" in text
    assert "END OF TERMS AND CONDITIONS" in text
    assert "Copyright 2026 Slancha, Inc." in text


with zipfile.ZipFile(DIST / "supatrace-0.1.0-py3-none-any.whl") as wheel:
    wheel_files = sorted(wheel.namelist())
    assert set(wheel_files) == {
        "supatrace/__init__.py", "supatrace/py.typed",
        "supatrace-0.1.0.dist-info/METADATA", "supatrace-0.1.0.dist-info/WHEEL",
        "supatrace-0.1.0.dist-info/RECORD", "supatrace-0.1.0.dist-info/licenses/LICENSE",
    }, wheel_files
    meta = email.message_from_bytes(wheel.read("supatrace-0.1.0.dist-info/METADATA"))
    assert meta["Name"] == "supatrace" and meta["Version"] == "0.1.0"
    assert meta["Requires-Python"] == ">=3.10"
    assert meta["License-Expression"] == "Apache-2.0"
    assert not any(c.startswith("License ::") for c in meta.get_all("Classifier", []))
    assert meta["Author"] == "Slancha, Inc."
    assert set(meta.get_all("Project-URL")) == {
        "Homepage, https://supatrace.dev", "Documentation, https://supatrace.dev/docs/",
        "Issues, https://github.com/SlanchaAI/supatrace-public/issues",
    }
    requirements = [Requirement(req) for req in meta.get_all("Requires-Dist", [])]
    assert all(req.marker and not req.marker.evaluate({"extra": ""})
               and req.marker.evaluate({"extra": "otlp"}) for req in requirements)
    assert_license(wheel.read("supatrace-0.1.0.dist-info/licenses/LICENSE").decode())
    py_readme = meta.get_payload()

with tarfile.open(DIST / "supatrace-0.1.0.tar.gz") as sdist:
    sdist_files = sorted(member.name for member in sdist.getmembers() if member.isfile())
    assert set(sdist_files) == {"supatrace-0.1.0/" + f for f in [
        "src/supatrace/__init__.py", "src/supatrace/py.typed", "LICENSE", "README.md",
        "pyproject.toml", "hatch_build.py", "PKG-INFO",
    ]}, sdist_files
    assert sdist.extractfile("supatrace-0.1.0/README.md").read().decode() == py_readme

with tarfile.open(DIST / "supatrace-0.1.0.tgz") as tar:
    npm_files = sorted(member.name for member in tar.getmembers() if member.isfile())
    assert set(npm_files) == {"package/" + f for f in [
        "index.mjs", "trace.mjs", "instrument.mjs", "cli.mjs", "README.md", "LICENSE", "package.json",
    ]}, npm_files
    manifest = json.load(tar.extractfile("package/package.json"))
    assert manifest["name"] == "supatrace" and manifest["version"] == "0.1.0"
    assert not manifest.get("private")
    assert manifest["license"] == "Apache-2.0"
    assert manifest["homepage"] == "https://supatrace.dev"
    assert manifest["engines"]["node"] == ">=22"
    assert manifest["publishConfig"] == {"access": "public"}
    assert manifest["bin"] == {"supatrace": "./cli.mjs"}
    assert "repository" not in manifest
    assert manifest["author"] == "Slancha, Inc."
    assert manifest["bugs"] == {"url": "mailto:support@supatrace.dev"}
    assert manifest["documentation"] == "https://supatrace.dev/docs/"
    assert set(manifest["peerDependencies"]) == set(manifest["devDependencies"])
    assert all(value == {"optional": True} for value in manifest["peerDependenciesMeta"].values())
    assert_license(tar.extractfile("package/LICENSE").read().decode())
    js_readme = tar.extractfile("package/README.md").read().decode()

for readme in (py_readme, js_readme):
    assert "Coming soon." in readme and "public repository root" in readme
    assert "github.com/SlanchaAI" not in readme
    assert "YOUR_INGEST_KEY" in readme and "https://supatrace.dev" in readme

print(json.dumps({"wheel_files": wheel_files, "sdist_files": sdist_files, "npm_files": npm_files}, indent=2))

with tempfile.TemporaryDirectory(prefix="supatrace-release-") as temp:
    work = Path(temp)
    run(sys.executable, "-m", "venv", str(work / "venv"), cwd=work)
    python = str(work / "venv/bin/python")
    wheel = DIST / "supatrace-0.1.0-py3-none-any.whl"
    run(python, "-m", "pip", "install", "--no-deps", str(wheel), cwd=work)
    run(python, "-c", "import supatrace; import importlib.util; assert importlib.util.find_spec('opentelemetry') is None; assert not supatrace.init().capture['sending']; assert not any(hasattr(supatrace, n) for n in ('evidence', 'DRIFT', 'STATE', 'SPEC', 'specSha', 'decision_record'))", cwd=work)
    (work / "package.json").write_text('{"private":true,"type":"module"}\n')
    run("npm", "install", "--ignore-scripts", str(DIST / "supatrace-0.1.0.tgz"), cwd=work)
    assert run(str(work / "node_modules/.bin/supatrace"), "--version", cwd=work).strip() == "0.1.0"
    run("node", "--input-type=module", "-e", "import * as sdk from 'supatrace'; const {init}=sdk; if(['evidence','DRIFT','STATE','SPEC','specSha','decision_record'].some(n=>n in sdk || n in sdk.default)) throw Error('internal API'); if(init().capture.sending) throw Error('default sender')", cwd=work)
    run(python, "-m", "pip", "install", str(wheel) + "[otlp]", cwd=work)
    exporter_install = next(line for line in js_readme.splitlines() if line.startswith("npm install @opentelemetry/"))
    run(*shlex.split(exporter_install), "--ignore-scripts", cwd=work)

    seen = []

    class Receiver(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            if self.headers.get("Transfer-Encoding") == "chunked":
                chunks = []
                while True:
                    size = int(self.rfile.readline().split(b";", 1)[0], 16)
                    if not size:
                        while self.rfile.readline().strip():
                            pass
                        break
                    chunks.append(self.rfile.read(size))
                    assert self.rfile.read(2) == b"\r\n"
                body = b"".join(chunks)
            else:
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            valid = (self.path == "/v1/traces" and self.headers.get("x-supatrace-key") == KEY
                     and self.headers.get("Authorization") == "Bearer " + KEY)
            seen.append((valid, self.headers.get("Content-Type"), body))
            self.send_response(200 if valid else 401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b"{}" if "json" in self.headers.get("Content-Type", "") else b"")

        def log_message(self, *_):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Receiver)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = f"http://127.0.0.1:{server.server_port}"
    env = {**ENV, "SUPATRACE_API_KEY": KEY, "SUPATRACE_OTLP_ENDPOINT": origin,
           "SUPATRACE_SPOOL": str(work / "spool")}
    try:
        # Neither credentials in the environment nor explicit OTLP with one missing
        # prerequisite may send. Count requests at the receiver, not at an SDK mock.
        quiet_py = """import supatrace
assert not supatrace.init().capture['sending']; assert not any(hasattr(supatrace, n) for n in ('evidence', 'DRIFT', 'STATE', 'SPEC', 'specSha', 'decision_record'))
assert not supatrace.init(mode='otlp', endpoint='ENDPOINT').capture['sending']
assert not supatrace.init(mode='otlp', api_key='KEY').capture['sending']
""".replace("ENDPOINT", origin).replace("KEY", KEY)
        run(python, "-c", quiet_py, cwd=work, env=ENV)
        run(python, "-c", "import supatrace; t=supatrace.init(); t.span('local-only'); assert not t.capture['sending']", cwd=work, env=env)
        quiet_js = """import {init} from 'supatrace';
if (init().capture.sending || init({mode:'otlp',endpoint:'ENDPOINT'}).capture.sending || init({mode:'otlp',apiKey:'KEY'}).capture.sending) throw Error('unexpected sender');
""".replace("ENDPOINT", origin).replace("KEY", KEY)
        run("node", "--input-type=module", "-e", quiet_js, cwd=work, env=ENV)
        run("node", "--input-type=module", "-e", "import {init} from 'supatrace'; const t=init(); t.span('local-only'); if(t.capture.sending) throw Error('default sender')", cwd=work, env=env)
        assert not seen, "non-opt-in path sent a request"
        run(python, "-c", snippet(py_readme, "python"), cwd=work, env=env)
        (work / "quickstart.mjs").write_text(snippet(js_readme, "js"))
        run("node", "quickstart.mjs", cwd=work, env=env)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    assert len(seen) == 2, "expected exactly one request per README quickstart"
    assert all(item[0] for item in seen), "wrong OTLP route or authentication headers"
    assert seen[0][1] == "application/x-protobuf"
    (work / "trace.pb").write_bytes(seen[0][2])
    py_summary = json.loads(run(python, "-c", """import json
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
from pathlib import Path
r = ExportTraceServiceRequest.FromString(Path('trace.pb').read_bytes())
print(json.dumps([[s.name for scope in rs.scope_spans for s in scope.spans] for rs in r.resource_spans]))
""", cwd=work))
    assert py_summary == [["hello-supatrace"]], py_summary
    js_body = json.loads(seen[1][2])
    assert [span["name"] for rs in js_body["resourceSpans"] for scope in rs["scopeSpans"] for span in scope["spans"]] == ["hello-supatrace"]
    print("PASS: clean wheel and npm installs; base imports without exporters; CLI version; zero non-opt-in requests; exactly one authenticated OTLP trace per verbatim README snippet (decoded protobuf and JSON).")

for artifact in sorted(DIST.glob("supatrace-0.1.0*")):
    print(hashlib.sha256(artifact.read_bytes()).hexdigest(), artifact.name)
