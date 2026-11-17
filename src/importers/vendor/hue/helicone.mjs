// Derived from Hue SDK 4ac88431eab76b4e12737c1b279dc58dbed87bf8. MIT; see LICENSE and provenance.json.
import {
  ConversionError,
  isObject,
  parseNestedJsonText,
  unixNano,

} from "./fields.mjs";

import { identityText } from "./fields.mjs";
import { nanosFrom, readRecords,              } from "./fields.mjs";

/**
 * Helicone request logs: the `HeliconeRequest` records `npx @helicone/export` writes as JSON or
 * JSON Lines (with `--include-body`, the request and response bodies too), and the
 * `{"data": […]}` answer of `POST /v1/request/query-clickhouse` it reads them from.
 *
 * - Each request is one model call span. Requests sharing a `Helicone-Session-Id` property are
 *   one trace, its id derived from the session id; a request with no session is a trace of its
 *   own, named by `request_id`. Helicone records no span tree: `Helicone-Session-Path` and
 *   `Helicone-Session-Name` are kept as attributes.
 * - The end user is `request_user_id` (the `Helicone-User-Id` header), never `helicone_user`,
 *   which is the Helicone account. The conversation is the session id.
 * - A span runs from `request_created_at` to `response_created_at`; without a response time it
 *   ends `delay_ms` after it starts (`end_from_latency`).
 * - Helicone stores token counts with the cached and reasoning tokens taken out
 *   (`prompt_tokens` without `prompt_cache_read_tokens` and `prompt_cache_write_tokens`,
 *   `completion_tokens` without `reasoning_tokens`): they are added back, as the GenAI
 *   conventions count input and output, and kept as their own counts too.
 * - The path is that of `target_url` (the ClickHouse export's field), else `request_path`; a
 *   request to an embeddings path is an embedding.
 * - A request of a Helicone experiment (the `Helicone-Experiment-Id` property) or made by a
 *   Helicone evaluator (`Helicone-Evaluator`), matched without regard to case as Helicone matches
 *   them, is evaluation traffic.
 * - A body Helicone left unfetched (`{"helicone_message": …}`) is no content.
 * - A request exported twice keeps its latest `updated_at`.
 *
 * Helicone's CSV export holds no response bodies and is not read.
 */



const object = (value                       )                         =>
  isObject(value) ? (value              ) : undefined;
const text = (value                       )                     =>
  typeof value === "string" && value ? value : undefined;
const count = (value                       )                     =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const isRequest = (value         )                      =>
  isObject(value) &&
  typeof value.request_id === "string" &&
  "request_created_at" in value &&
  ("response_status" in value || "request_user_id" in value || "request_properties" in value);

/** The requests an API answer (`{"data": […]}`) holds, when it holds any. */
function envelopeRequests(value         )                        {
  return isObject(value) && Array.isArray(value.data) && value.data.some(isRequest)
    ? value.data
    : undefined;
}

/** A body as recorded, JSON text parsed; Helicone's placeholder for an unfetched body is none. */
function body(value                       )                        {
  let parsed = value;
  if (typeof value === "string") {
    if (!value) return undefined;
    try {
      parsed = parseNestedJsonText(value).value             ;
    } catch {
      return value;
    }
  }
  const fields = object(parsed);
  if (fields && Object.keys(fields).length === 1 && "helicone_message" in fields) return undefined;
  return parsed ?? undefined;
}

/** A duration in milliseconds as nanoseconds; zero is allowed. */
const milliseconds = (value        )         => (value === 0 ? 0n : nanosFrom(value, "ms"));

/** Properties that mark Helicone's own evaluation traffic, lower-cased as Helicone compares
 * them. */
const EVALUATION_PROPERTIES = new Set(["helicone-experiment-id", "helicone-evaluator"]);

/** The request's path: `target_url`'s, else `request_path` (the older Postgres export's). */
function pathOf(record            )         {
  const target = text(record.target_url);
  if (target)
    try {
      return new URL(target).pathname;
    } catch {
      // Not a URL: the recorded path, if any, is read instead.
    }
  return text(record.request_path) ?? "";
}

/** Input and output as the GenAI conventions count them: Helicone's counts with the cached and
 * reasoning tokens it took out added back. */
function usageOf(record            )                                {
  const prompt = count(record.prompt_tokens);
  const completion = count(record.completion_tokens);
  const cacheRead = count(record.prompt_cache_read_tokens);
  const cacheWrite = count(record.prompt_cache_write_tokens);
  const reasoning = count(record.reasoning_tokens);
  return {
    input: prompt === undefined ? undefined : prompt + (cacheRead ?? 0) + (cacheWrite ?? 0),
    output: completion === undefined ? undefined : completion + (reasoning ?? 0),
    cacheRead,
    cacheWrite,
    reasoning,
  };
}

function readRequest(record            , context                )       {
  const requestId = text(record.request_id);
  if (!requestId) throw new ConversionError("a request without a request_id");
  const properties = object(record.request_properties) ?? object(record.properties);
  for (const key of ["request_properties", "properties"])
    if (record[key] != null && !object(record[key]))
      throw new ConversionError(`${key} is not an object`);
  const session = identityText(properties?.["Helicone-Session-Id"]);
  if (typeof record.request_created_at !== "string")
    throw new ConversionError("a request without request_created_at");
  const start = BigInt(unixNano(record.request_created_at));
  let end                    ;
  let timing                    ;
  if (text(record.response_created_at)) end = BigInt(unixNano(record.response_created_at));
  else if (typeof record.delay_ms === "number" && record.delay_ms >= 0) {
    end = start + milliseconds(record.delay_ms);
    timing = "end_from_latency";
  }
  const path = pathOf(record);
  const embedding = /\/embeddings\/?$/.test(path);
  const requestBody = body(record.request_body);
  const responseBody = body(record.response_body);
  const recorded = text(record.model);
  const model =
    text(record.model_override) ??
    text(record.request_model) ??
    (recorded !== "unknown" ? recorded : undefined);
  const status = record.response_status;
  const user = identityText(record.request_user_id);
  const cost = typeof record.cost === "number" ? record.cost : record.costUSD;
  const row          = {
    traceKey: session ?? requestId,
    spanKey: requestId,
    name: `${embedding ? "embeddings" : "chat"}${model ? ` ${model}` : ""}`,
    kind: embedding ? "embedding" : "llm",
    start,
    ...(end !== undefined ? { end } : {}),
    ...(timing ? { timing } : {}),
    ...(model ? { model } : {}),
    ...(text(record.response_model) ? { responseModel: text(record.response_model)  } : {}),
    ...(text(record.provider) ? { provider: text(record.provider) .toLowerCase() } : {}),
    usage: usageOf(record),
    ...(user !== undefined ? { user } : {}),
    ...(session !== undefined ? { session } : {}),
    attributes: {
      ...(properties && Object.keys(properties).length
        ? { "helicone.properties": JSON.stringify(properties) }
        : {}),
      ...(text(properties?.["Helicone-Session-Path"])
        ? { "helicone.session.path": text(properties?.["Helicone-Session-Path"])  }
        : {}),
      ...(text(properties?.["Helicone-Session-Name"])
        ? { "helicone.session.name": text(properties?.["Helicone-Session-Name"])  }
        : {}),
      ...(path ? { "helicone.request.path": path } : {}),
      ...(typeof cost === "number" && Number.isFinite(cost) ? { "helicone.cost_usd": cost } : {}),
    },
    record,
    ...(text(record.updated_at) ? { revision: text(record.updated_at)  } : {}),
  };
  if (Object.keys(properties ?? {}).some((key) => EVALUATION_PROPERTIES.has(key.toLowerCase())))
    row.origin = "evaluation";
  if (typeof status === "number" && status >= 400) {
    const message = text(object(object(responseBody)?.error)?.message);
    row.error = { message: message ?? `HTTP ${status}`, type: String(status) };
  }
  context.row(row);
}

export const helicone                = {
  id: "helicone",
  manifestFormat: "otlp_json",
  detect: (value) => isRequest(value) || envelopeRequests(value) !== undefined,
  convert(value, context) {
    const records = isRequest(value) ? [value] : (envelopeRequests(value) ?? []);
    readRecords(
      context,
      records,
      (record) => {
        if (!isRequest(record)) return undefined;
        const properties = object(record.request_properties) ?? object(record.properties);
        return identityText(properties?.["Helicone-Session-Id"]) ?? text(record.request_id);
      },
      (record) => {
        if (!isRequest(record))
          throw new ConversionError("a record that is not a Helicone request");
        readRequest(record, context);
      },
    );
  },
};
