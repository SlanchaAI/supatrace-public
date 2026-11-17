// Derived from Hue SDK 4ac88431eab76b4e12737c1b279dc58dbed87bf8. MIT; see LICENSE and provenance.json.
import {
  ConversionError,
  isObject,
  parseNestedJsonText,

} from "./fields.mjs";
import { identityText } from "./fields.mjs";

/**
 * Field readers the row-platform formats (LangSmith, MLflow, Opik, W&B Weave) share: their
 * records are JSON objects whose instants are ISO 8601 text and whose metadata names the end user
 * and conversation under the field names applications commonly give them.
 */



export const object = (value                       )                         =>
  isObject(value) ? (value              ) : undefined;

export const text = (value                       )                     =>
  typeof value === "string" && value ? value : undefined;

/** A token count as recorded, when it is a nonnegative integer. */
export const count = (value                       )                     =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** The first of `names` that holds an identifier in `fields`. */
export function first(
  fields                        ,
  names                   ,
)                     {
  for (const name of names) {
    const value = identityText(fields?.[name]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** The end user a metadata map names: the fields Hue reads in a metadata map, in its order
 * (`userId`, `user_id`, `langfuse_user_id`), then OpenTelemetry's `user.id` and `enduser.id`
 * as an exporter copied them in. `user.id` beside `user.account_uuid` is a Claude Code
 * installation, not a user, and is passed over as Hue passes it over. */
export function metadataUser(metadata                        )                     {
  const user = first(metadata, ["userId", "user_id", "langfuse_user_id"]);
  if (user !== undefined) return user;
  const installation = metadata?.["user.account_uuid"] !== undefined;
  return first(metadata, installation ? ["enduser.id"] : ["user.id", "enduser.id"]);
}
/** The metadata fields applications name the conversation by. */
export const SESSION_FIELDS = [
  "session_id",
  "sessionId",
  "thread_id",
  "threadId",
  "conversation_id",
  "conversationId",
  "gen_ai.conversation.id",
];

const ISO =
  /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(?:([Zz])|([+-]\d{2}):?(\d{2}))?$/;

/**
 * An ISO 8601 instant as Unix nanoseconds: `T` or a space between date and time (Python's
 * `str(datetime)` writes a space), up to nine fractional digits, and `Z` or an offset. An instant
 * without a zone is UTC, as LangSmith documents its run times and its SDK reads them.
 */
export function isoNanos(value                       )         {
  const match = typeof value === "string" ? ISO.exec(value) : null;
  if (!match) throw new ConversionError("Invalid source timestamp");
  const zone = match[5] ? `${match[5]}:${match[6]}` : "Z";
  const millis = Date.parse(`${match[1]}T${match[2]}${zone}`);
  if (!Number.isSafeInteger(millis) || millis <= 0)
    throw new ConversionError("Invalid source timestamp");
  return BigInt(millis) * 1_000_000n + BigInt((match[3] ?? "").padEnd(9, "0"));
}

/** A JSON value recorded as itself or as its JSON text (a column a warehouse export stores as
 * text); text that is not JSON, or nests too deep to read, is undefined. Integers beyond
 * JavaScript's range stay decimal text. */
export function jsonOf(value                       )                        {
  if (typeof value !== "string") return value;
  try {
    return parseNestedJsonText(value).value             ;
  } catch {
    return undefined;
  }
}

/** A field that must be a JSON object when present, recorded as one or as its JSON text. */
export function objectField(value                       , what        )                         {
  if (value === undefined || value === null) return undefined;
  const parsed = jsonOf(value);
  if (parsed === null) return undefined;
  if (!isObject(parsed)) throw new ConversionError(`${what} is not a JSON object`);
  return parsed              ;
}
