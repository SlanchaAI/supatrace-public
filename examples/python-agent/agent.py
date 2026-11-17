#!/usr/bin/env python3
"""A tool-calling agent that records each step as a SupaTrace event.

    python3 agent.py --dry-run "What is 17 * 23?"     # scripted model, no network, no key
    OPENAI_API_KEY=... python3 agent.py --model YOUR_MODEL "What is 17 * 23?"

Events are spooled to ./spool for review. Nothing is uploaded. By default only tool names,
model name and token counts are recorded; pass --content to also record the question, tool
arguments, tool results and the answer.
"""
import argparse
import datetime
import json
import pathlib
import sys
import uuid

try:
    import supatrace
except ImportError:  # run from a repository checkout without installing the package
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "packages" / "supatrace" / "src"))
    import supatrace

TOOLS = [{
    "type": "function",
    "function": {
        "name": "multiply",
        "description": "Multiply two integers.",
        "parameters": {"type": "object", "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}},
                       "required": ["a", "b"]},
    },
}]


def multiply(a, b):
    return a * b


def scripted_model(messages):
    """Stands in for the provider in --dry-run: one tool call, then a final answer."""
    last = messages[-1]
    if last["role"] == "tool":
        return {"content": "The answer is " + last["content"] + ".", "tool_calls": [], "total_tokens": 9}
    return {"content": None, "tool_calls": [{"id": "call-1", "name": "multiply", "arguments": {"a": 17, "b": 23}}],
            "total_tokens": 21}


def openai_model(model):
    from openai import OpenAI  # imported only on the real path

    client = OpenAI()

    def call(messages):
        reply = client.chat.completions.create(model=model, messages=messages, tools=TOOLS)
        message = reply.choices[0].message
        calls = [{"id": c.id, "name": c.function.name, "arguments": json.loads(c.function.arguments)}
                 for c in (message.tool_calls or [])]
        return {"content": message.content, "tool_calls": calls, "total_tokens": reply.usage.total_tokens,
                "raw": message}

    return call


def run(question, call_model, model_name, content=False, spool="./spool", max_turns=4):
    """Returns (answer, report, ok). The batch is spooled even when the run fails, so the
    failure is part of the trace."""
    trace = supatrace.init(service="python-agent", spool=spool)
    # One run ID per invocation: batches that share a run ID are shown as one trace.
    run_id = "python-agent-" + uuid.uuid4().hex[:12]
    now = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
    events, answer, failure = [], None, None

    def record(kind, name, data, body=None):
        if content and body:
            data = {**data, **body}
        events.append({"id": f"step-{len(events) + 1}", "time": now(), "kind": kind, "name": name, "data": data})

    messages = [{"role": "user", "content": question}]
    try:
        for _ in range(max_turns):
            record("request", "chat.completions", {"model": model_name, "messages": len(messages)},
                   {"last_message": messages[-1]["content"]})
            reply = call_model(messages)
            if not reply["tool_calls"]:
                answer = reply["content"]
                record("response", "chat.completions", {"total_tokens": reply["total_tokens"]}, {"answer": answer})
                break
            messages.append(reply.get("raw") or {"role": "assistant", "content": None, "tool_calls": [
                {"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": json.dumps(c["arguments"])}}
                for c in reply["tool_calls"]]})
            for call in reply["tool_calls"]:
                record("tool_call", call["name"], {"call_id": call["id"]}, {"arguments": call["arguments"]})
                try:
                    if call["name"] != "multiply":
                        raise ValueError("unknown tool " + call["name"])
                    result = multiply(**call["arguments"])
                    record("tool_result", call["name"], {"call_id": call["id"]}, {"result": result})
                except Exception as error:  # a failed tool is reported to the model and recorded
                    result = "error: " + type(error).__name__
                    record("error", call["name"], {"call_id": call["id"], "type": type(error).__name__})
                messages.append({"role": "tool", "tool_call_id": call["id"], "content": str(result)})
        else:
            failure = "max_turns"
            record("error", "agent", {"type": "max_turns", "max_turns": max_turns})
    except Exception as error:  # provider failure: record its type only, then still spool the steps so far
        failure = type(error).__name__
        record("error", "chat.completions", {"type": failure})

    report = trace.batch(events, run_id=run_id)["report"]
    return answer, report, failure is None and report["valid"]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("question", nargs="?", default="What is 17 * 23?")
    parser.add_argument("--dry-run", action="store_true", help="use the scripted model; no network, no key")
    parser.add_argument("--model", default="YOUR_MODEL")
    parser.add_argument("--content", action="store_true", help="also record question, arguments, results and answer")
    parser.add_argument("--spool", default="./spool")
    args = parser.parse_args(argv)
    call_model = scripted_model if args.dry_run else openai_model(args.model)
    answer, report, ok = run(args.question, call_model, "scripted" if args.dry_run else args.model,
                             content=args.content, spool=args.spool)
    print(json.dumps({"answer": answer, "ok": ok, "valid": report["valid"], "errors": report["errors"],
                      "path": report["path"]}))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
