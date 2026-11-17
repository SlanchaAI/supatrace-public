# LangGraph agent

A two-node LangGraph agent (`model` and `tool`, with a conditional edge between them).
The nodes record one SupaTrace event per model request, tool call, tool result and final
response. The batch is validated and spooled to `./spool`. Nothing is uploaded.

## Three commands to a reviewed batch

From the repository root:

```sh
pip install ./packages/supatrace langgraph                         # preview SDK from this checkout; not on PyPI
python3 examples/langgraph-agent/agent.py --dry-run                # scripted model: no network, no key
python3 agent/upload.py ./spool/BATCH.json --config ./supatrace-access.json   # after you have read the file
```

The dry run prints `"runner": "langgraph"` when LangGraph is installed and the compiled
graph ran. Without LangGraph it prints `"runner": "run_nodes"`: the same node functions
driven by a small loop that follows the same edges. CI does not install LangGraph, so CI
covers the nodes and the recorded batch, not the LangGraph wiring. The compiled-graph path
was run by hand against LangGraph 1.2.22, including with LangSmith tracing switched on in the shell: no connection was attempted.

## With a real model

```sh
pip install langgraph langchain-openai
OPENAI_API_KEY=... python3 examples/langgraph-agent/agent.py --model YOUR_MODEL "What is 17 * 23?"
```

This path calls OpenAI with your key. It is not run in CI.

## LangSmith tracing is switched off

LangChain and LangGraph upload full inputs and outputs to LangSmith when `LANGSMITH_TRACING`
or `LANGCHAIN_TRACING_V2` is set in your shell. This example sets those switches to `false`
for its own process before importing either library, and runs the graph inside LangSmith's
`tracing_context(enabled=False)`, so a run does not send your question, tool arguments or
answer anywhere. Remove that code only if you want LangSmith traces as well.

## What is recorded

Model name, message counts, tool names, call IDs and output length. No prompt, tool
argument, tool result or answer text is recorded.
