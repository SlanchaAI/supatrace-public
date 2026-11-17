#!/usr/bin/env python3
"""A LangGraph agent whose nodes record SupaTrace events.

    python3 agent.py --dry-run                 # scripted model, no network, no key
    pip install langgraph langchain-openai
    OPENAI_API_KEY=... python3 agent.py --model YOUR_MODEL "What is 17 * 23?"

The graph is model -> (tool -> model)* -> end. With --dry-run the same node functions run
with a scripted model; if langgraph is installed they run inside the real compiled graph,
otherwise through the small loop in run_nodes(), which follows the same edges.
Events are spooled to ./spool for review. Nothing is uploaded.
"""
import argparse
import contextlib
import datetime
import json
import os
import pathlib
import sys
import uuid

# LangChain and LangGraph send full inputs and outputs to LangSmith when tracing is switched
# on in the environment. This example promises that nothing leaves the machine, so it turns
# that off for its own process before either library is imported, whatever the shell says.
TRACING_SWITCHES = ("LANGSMITH_TRACING", "LANGSMITH_TRACING_V2", "LANGCHAIN_TRACING", "LANGCHAIN_TRACING_V2")
for _name in TRACING_SWITCHES:
    os.environ[_name] = "false"

try:
    import supatrace
except ImportError:  # run from a repository checkout without installing the package
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "packages" / "supatrace" / "src"))
    import supatrace


def multiply(a, b):
    return a * b


def scripted_model(messages):
    last = messages[-1]
    if last["role"] == "tool":
        return {"role": "assistant", "content": "The answer is " + last["content"] + ".", "tool_calls": []}
    return {"role": "assistant", "content": "", "tool_calls": [{"id": "call-1", "name": "multiply", "args": {"a": 17, "b": 23}}]}


def langchain_model(model):
    from langchain_openai import ChatOpenAI  # imported only on the real path

    llm = ChatOpenAI(model=model).bind_tools([{
        "type": "function",
        "function": {"name": "multiply", "description": "Multiply two integers.",
                     "parameters": {"type": "object", "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}},
                                    "required": ["a", "b"]}}}])

    def call(messages):
        reply = llm.invoke(messages)
        return {"role": "assistant", "content": reply.content,
                "tool_calls": [{"id": c["id"], "name": c["name"], "args": c["args"]} for c in reply.tool_calls]}

    return call


class Recorder:
    """Collects events in order; the graph nodes share one instance."""

    def __init__(self, model_name):
        self.model_name, self.events = model_name, []

    def add(self, kind, name, data):
        stamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
        self.events.append({"id": f"step-{len(self.events) + 1}", "time": stamp, "kind": kind, "name": name, "data": data})


def make_nodes(call_model, recorder):
    def model_node(state):
        recorder.add("request", "model", {"model": recorder.model_name, "messages": len(state["messages"])})
        reply = call_model(state["messages"])
        if not reply["tool_calls"]:
            recorder.add("response", "model", {"output_chars": len(reply["content"] or "")})
        return {"messages": state["messages"] + [reply]}

    def tool_node(state):
        messages = list(state["messages"])
        for call in messages[-1]["tool_calls"]:
            recorder.add("tool_call", call["name"], {"call_id": call["id"]})
            result = multiply(**call["args"])
            recorder.add("tool_result", call["name"], {"call_id": call["id"]})
            messages.append({"role": "tool", "tool_call_id": call["id"], "content": str(result)})
        return {"messages": messages}

    def route(state):
        return "tool" if state["messages"][-1].get("tool_calls") else "end"

    return model_node, tool_node, route


def build_graph(model_node, tool_node, route):
    from typing import TypedDict
    from langgraph.graph import END, StateGraph

    class State(TypedDict):
        messages: list

    graph = StateGraph(State)
    graph.add_node("model", model_node)
    graph.add_node("tool", tool_node)
    graph.set_entry_point("model")
    graph.add_conditional_edges("model", route, {"tool": "tool", "end": END})
    graph.add_edge("tool", "model")
    return graph.compile()


def no_third_party_tracing():
    """A second guard around execution: LangSmith's own off switch, when it is installed."""
    try:
        from langsmith import tracing_context
    except ImportError:
        return contextlib.nullcontext()
    return tracing_context(enabled=False)


def run_nodes(model_node, tool_node, route, state, max_steps=8):
    """The same edges as build_graph(), for a dry run without langgraph installed."""
    for _ in range(max_steps):
        state = model_node(state)
        if route(state) == "end":
            return state
        state = tool_node(state)
    raise RuntimeError("agent did not finish")


def run(question, call_model, model_name, spool="./spool", allow_fallback=False):
    """Returns (answer, report, runner, ok). The batch is spooled even when the graph fails,
    so the failure is part of the trace."""
    trace = supatrace.init(service="langgraph-agent", spool=spool)
    # One run ID per invocation: batches that share a run ID are shown as one trace.
    run_id = "langgraph-agent-" + uuid.uuid4().hex[:12]
    recorder = Recorder(model_name)
    nodes = make_nodes(call_model, recorder)
    state = {"messages": [{"role": "user", "content": question}]}
    try:
        graph, runner = build_graph(*nodes), "langgraph"
    except ImportError:
        if not allow_fallback:
            raise
        graph, runner = None, "run_nodes"
    answer, ok = None, True
    try:
        with no_third_party_tracing():
            final = graph.invoke(state) if graph else run_nodes(*nodes, state)
        answer = final["messages"][-1]["content"]
    except Exception as error:  # provider or graph failure: record its type only, then still spool
        ok = False
        recorder.add("error", "agent", {"type": type(error).__name__})
    report = trace.batch(recorder.events, run_id=run_id)["report"]
    return answer, report, runner, ok and report["valid"]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("question", nargs="?", default="What is 17 * 23?")
    parser.add_argument("--dry-run", action="store_true", help="use the scripted model; no network, no key")
    parser.add_argument("--model", default="YOUR_MODEL")
    parser.add_argument("--spool", default="./spool")
    args = parser.parse_args(argv)
    call_model = scripted_model if args.dry_run else langchain_model(args.model)
    answer, report, runner, ok = run(args.question, call_model, "scripted" if args.dry_run else args.model,
                                     spool=args.spool, allow_fallback=args.dry_run)
    print(json.dumps({"answer": answer, "runner": runner, "ok": ok, "valid": report["valid"],
                      "errors": report["errors"], "path": report["path"]}))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
