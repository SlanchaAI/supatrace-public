import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { chat } from "../../../lib/chat.mjs";
import { rejectCrossSite } from "../../../lib/guard.mjs";

// The SupaTrace SDK writes the spool with node:fs, so this route cannot run on the Edge runtime.
export const runtime = "nodejs";

const MODEL = process.env.OPENAI_MODEL || "YOUR_MODEL";

export async function POST(request) {
  const refused = rejectCrossSite(request);
  if (refused) return Response.json({ error: refused.error }, { status: refused.status });
  const body = await request.json().catch(() => null);
  const prompt = typeof body?.prompt === "string" ? body.prompt.slice(0, 4000) : "";
  if (!prompt) return Response.json({ error: "prompt_required" }, { status: 400 });
  const result = await chat({ prompt, model: openai(MODEL), modelName: MODEL, generate: generateText });
  if (result.text === null) return Response.json({ error: "model_call_failed", trace: result.trace }, { status: 502 });
  return Response.json(result);
}
