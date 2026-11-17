// Derived from Hue SDK 4ac88431eab76b4e12737c1b279dc58dbed87bf8. MIT; see LICENSE and provenance.json.
export class ConversionError extends Error {}

/**
 * A failure that refuses only what was being read: a ConversionError as itself, and a RangeError
 * (a value too large or nested too deep for a reader to walk) as one. Anything else is a defect
 * and is undefined, for the caller to rethrow.
 */
export function conversionFailure(error         )                              {
  if (error instanceof ConversionError) return error;
  if (error instanceof RangeError)
    return new ConversionError("the record is too large or nested too deep to read");
  return undefined;
}

/** How deep a value read from a source may nest: far beyond any export's records, and well
 * inside what the readers and serializers that walk a value can follow. */
export const MAX_SOURCE_NESTING = 512;

/** Whether a parsed JSON value nests deeper than `max` levels, walked without recursion and
 * holding only the path to the value being looked at. */
export function nestedTooDeep(value         , max = MAX_SOURCE_NESTING)          {
  if (value === null || typeof value !== "object") return false;
  const members = (item        ) => (Array.isArray(item) ? item : Object.values(item));
  const path                                       = [{ items: members(value), next: 0 }];
  while (path.length) {
    const level = path[path.length - 1] ;
    if (level.next >= level.items.length) {
      path.pop();
      continue;
    }
    const child = level.items[level.next++];
    if (child === null || typeof child !== "object") continue;
    if (path.length >= max) return true;
    path.push({ items: members(child), next: 0 });
  }
  return false;
}


export function isObject(value         )                                   {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const LONG_INTEGER = /\d{16}/;

/**
 * JSON text parsed with every integer too large for a JavaScript number kept as its decimal
 * text, so an OTLP timestamp written as a number keeps its nanoseconds. `unsafeIntegers` says
 * whether any was found; the Langfuse and ATIF readers refuse such a file, as Hue's do.
 */
export function parseJsonText(text        )                                              {
  if (!LONG_INTEGER.test(text)) return { value: JSON.parse(text), unsafeIntegers: false };
  let unsafeIntegers = false;
  const reviver = (_key        , value         , context                      ) => {
    if (
      typeof value === "number" &&
      !Number.isSafeInteger(value) &&
      typeof context?.source === "string" &&
      /^-?\d+$/.test(context.source)
    ) {
      unsafeIntegers = true;
      return context.source;
    }
    return value;
  };
  try {
    return {
      value: JSON.parse(text, reviver                                            ),
      unsafeIntegers,
    };
  } catch (error) {
    // The reviver walks recursively; a body nested too deep for it is read without it.
    if (error instanceof RangeError) return { value: JSON.parse(text), unsafeIntegers: false };
    throw error;
  }
}

/** JSON text a record holds (metadata values, tool arguments, a column a warehouse stores as text)
 * parsed as {@link parseJsonText} parses it; text nested deeper than {@link MAX_SOURCE_NESTING}
 * throws, so the caller keeps it as the text it is. */
export function parseNestedJsonText(text        )                                              {
  const parsed = parseJsonText(text);
  if (nestedTooDeep(parsed.value)) throw new ConversionError("JSON text nested too deep");
  return parsed;
}


const MAX_NANOS = 18_446_744_073_709_551_615n;

const UNITS = { s: 9, ms: 6, us: 3, ns: 0 }         ;

/** A timestamp in `unit` (a number or its decimal text, exponent allowed) as Unix nanoseconds,
 * read from its decimal digits so no float rounding is added. */
export function nanosFrom(value         , unit                    )         {
  const text =
    typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : typeof value === "string"
        ? value
        : "";
  const match = /^(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) throw new ConversionError("Invalid source timestamp");
  const shift = UNITS[unit] + Number(match[3] ?? 0);
  const digits = match[1]  + (match[2] ?? "");
  const point = match[1] .length + shift;
  if (point > 40) throw new ConversionError("Invalid source timestamp");
  const whole = point <= 0 ? "0" : digits.padEnd(point, "0").slice(0, point);
  const nanos = BigInt(whole);
  if (nanos <= 0n || nanos > MAX_NANOS) throw new ConversionError("Invalid source timestamp");
  return nanos;
}

/** Reads each record with `read`: a record that throws a ConversionError (or is too deep or
 * large to walk) refuses the trace `traceKeyOf` names (or is reported alone), never the rest of
 * the value. */
export function readRecords   (
  context                ,
  records              ,
  traceKeyOf                                   ,
  read                     ,
)       {
  for (const [index, record] of records.entries())
    try {
      read(record);
    } catch (error) {
      const failure = conversionFailure(error);
      if (!failure) throw error;
      const at = records.length > 1 ? `record ${index + 1}: ` : "";
      let traceKey                    ;
      try {
        traceKey = traceKeyOf(record);
      } catch (keyError) {
        if (!conversionFailure(keyError)) throw keyError;
      }
      context.refuse(`${at}${failure.message}`, traceKey);
    }
}


export function identityText(value         )                     {
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return undefined;
}


export function unsigned(value         )                     {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d{1,20}$/.test(value)) return BigInt(value);
  return undefined;
}

import {isoNanos} from "./row-platform-fields.mjs";
export const unixNano = value => isoNanos(value).toString();
