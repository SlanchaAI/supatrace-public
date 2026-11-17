// The traced chat step, kept free of Next.js so it can be smoke-tested with a scripted
// model. `generate` is the Vercel AI SDK's generateText (or a stand-in with its shape).
import { randomUUID } from "node:crypto";
import { init } from "@supatrace/client";

export async function chat({ prompt, model, modelName, generate, spool = process.env.SUPATRACE_SPOOL || "./spool" }) {
  const trace = init("nextjs-ai-sdk", { spool });
  const started = new Date().toISOString();
  const events = [{ id: "req-1", time: started, kind: "request", name: "generateText", data: { model: modelName } }];
  let text = null;
  try {
    const result = await generate({ model, prompt });
    text = result.text;
    events.push({ id: "res-1", time: new Date().toISOString(), kind: "response", name: "generateText",
      data: { totalTokens: result.usage?.totalTokens ?? null, outputChars: text.length } });
  } catch (error) {
    events.push({ id: "err-1", time: new Date().toISOString(), kind: "error", name: "generateText", data: { type: error.name } });
  }
  // Prompt and reply text are not recorded. The batch is validated and spooled, not sent.
  // One run ID per request: batches that share a run ID are shown as one trace.
  const { report } = trace.batch(events, { runId: "nextjs-ai-sdk-" + randomUUID().replace(/-/g, "").slice(0, 12) });
  return { text, trace: { valid: report.valid, errors: report.errors, path: report.path } };
}
