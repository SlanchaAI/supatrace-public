#!/usr/bin/env node
// Dry run of the traced chat step with a scripted model: no network, no provider key and
// no installed dependencies. `@supatrace/client` resolves to packages/supatrace-js through
// the import map below when node_modules is absent.
import { register } from "node:module";

const sdk = new URL("../../packages/supatrace-js/index.mjs", import.meta.url).href;
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(specifier, context, next) { return specifier === "@supatrace/client" ? { url: ${JSON.stringify(sdk)}, shortCircuit: true } : next(specifier, context); }`));

const { chat } = await import("./lib/chat.mjs");
const scripted = async ({ prompt }) => ({ text: "Hello from a scripted model.", usage: { totalTokens: prompt.length } });
const result = await chat({ prompt: "Say hello.", model: { scripted: true }, modelName: "scripted", generate: scripted, spool: process.argv[2] || "./spool" });
console.log(JSON.stringify({ answer: result.text, ...result.trace }));
process.exit(result.trace.valid ? 0 : 1);
