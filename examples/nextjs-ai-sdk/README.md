# Next.js chat on the Vercel AI SDK

A Next.js App Router app with one route handler, `POST /api/chat`, that calls
`generateText` from the Vercel AI SDK and records the call as two SupaTrace events
(request and response, or request and error). The batch is validated and spooled to
`./spool`. Nothing is uploaded, and prompt and reply text are not recorded.

## Three commands to a reviewed batch

From the repository root:

```sh
node examples/nextjs-ai-sdk/smoke.mjs                              # scripted model: no network, no key, no install
cat spool/*.json                                                   # read what was recorded
python3 agent/upload.py ./spool/BATCH.json --config ./supatrace-access.json   # after you have read the file
```

The upload needs the write-only connection from the [setup guide](../../public/agent-setup.html).

## Run the app

```sh
cd examples/nextjs-ai-sdk
npm install                      # installs next, ai, @ai-sdk/openai and the SDK from ../../packages/supatrace-js
OPENAI_API_KEY=... OPENAI_MODEL=YOUR_MODEL npm run dev
```

Open http://127.0.0.1:3000, send a prompt, then read the file under `./spool`. The `dev` and `start` scripts bind to 127.0.0.1 only: `POST /api/chat` has no authentication and spends your provider key, so do not expose it to a network without adding your own. The route also refuses requests whose `Host` is not a loopback address, that are not `application/json`, or that come from another site's page, so a web page you visit cannot spend your key through your local server. This path
calls OpenAI with your key. CI runs only `smoke.mjs`: it exercises `lib/chat.mjs`, the code
the route handler calls, with a scripted model. The Next.js server itself is not started in CI.
It was built and started by hand once (Next.js 15.5, AI SDK 5.0, `@ai-sdk/openai` 2.0): without
a provider key the route returned `model_call_failed` and spooled a valid request and error batch.
A successful model call through the route has not been run.

## Notes

- `@supatrace/client` is not on npm; `package.json` installs it from this checkout. That
  is why there is no Deploy to Vercel button.
- The SDK writes files with `node:fs`. The route sets `runtime = "nodejs"`; it will not
  run on the Edge runtime, and a serverless host with a read-only filesystem cannot spool.
- AI SDK telemetry can send traces to the hosted OTLP/HTTP receiver on supatrace.dev.
