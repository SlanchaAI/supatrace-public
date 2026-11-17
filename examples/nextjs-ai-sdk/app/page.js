"use client";
import { useState } from "react";

export default function Page() {
  const [prompt, setPrompt] = useState("Say hello.");
  const [reply, setReply] = useState(null);
  const [busy, setBusy] = useState(false);

  async function send(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt }) });
      setReply(await response.json());
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>SupaTrace + Vercel AI SDK</h1>
      <form onSubmit={send}>
        <label htmlFor="prompt">Prompt</label>
        <input id="prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} />
        <button disabled={busy}>{busy ? "Sending" : "Send"}</button>
      </form>
      {reply?.text && <p>{reply.text}</p>}
      {reply?.error && <p role="alert">{reply.error}</p>}
      {reply?.trace && <p>Spooled for review: <code>{reply.trace.path}</code></p>}
    </main>
  );
}
