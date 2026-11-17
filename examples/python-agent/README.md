# Python agent with tools

A small tool-calling loop on the OpenAI Python client. Each model request, tool call, tool
result and final response becomes one SupaTrace event; the batch is validated and spooled
to `./spool` for you to review. Nothing is uploaded.

## Three commands to a reviewed batch

From the repository root:

```sh
pip install ./packages/supatrace                                  # preview SDK from this checkout; not on PyPI
python3 examples/python-agent/agent.py --dry-run                  # scripted model: no network, no key
python3 agent/upload.py ./spool/BATCH.json --config ./supatrace-access.json   # after you have read the file
```

The first command is optional: without it the script loads the SDK from `packages/`. The
last one needs the write-only connection from the [setup guide](../../public/agent-setup.html).

## With a real model

```sh
pip install openai
OPENAI_API_KEY=... python3 examples/python-agent/agent.py --model YOUR_MODEL "What is 17 * 23?"
```

This path calls OpenAI with your key. It is not run in CI.

## What is recorded

By default: model name, message count, tool names, call IDs and token counts. `--content`
adds the question, tool arguments, tool results and the answer; review the spooled file
for secrets and personal information before uploading it.
