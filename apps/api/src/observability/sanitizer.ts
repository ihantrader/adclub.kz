/**
 * The one place personal data is removed (ARCHITECTURE 15.3, 4.13).
 * Everything that leaves the process as text — the application log and
 * every event sent to error monitoring — goes through here: messages,
 * error objects with their causes and stacks, tags, context objects, query
 * parameters of a failed statement.
 *
 * What is removed or masked: phone numbers (in any shape, inside free text
 * too — only `+7***1234` remains), names, e-mail addresses, postal
 * addresses, IP addresses, login and order codes, tokens and secrets,
 * request and response bodies, the query string of a URL.
 *
 * What stays: identifiers (`accountId`, `requestId`, `sessionId`,
 * `entityId`, …) — they are what an investigation is run on — module
 * names, stack frames, numbers and enum-like words.
 *
 * Pure and dependency-free on purpose: it is unit-tested on fixtures
 * (`sanitizer.test.ts`) and used from the logger, so it must not need Nest,
 * configuration or the database.
 */

export const REDACTED = "[redacted]";
export const REDACTED_IP = "[ip]";
export const SANITIZER_FAILED = "[sanitizer failed]";

/** Nesting below this is replaced by a marker (a cycle can't outrun it either). */
const MAX_DEPTH = 8;
/** At most this many entries of one array or object are kept. */
const MAX_ENTRIES = 50;
/** Longest string kept; the rest is cut with a marker. */
const MAX_STRING = 2000;

/**
 * A key whose value is an identifier: kept as it is. Checked before the
 * sensitive keys below, so `accountId` survives while `account` doesn't.
 */
const IDENTIFIER_KEY = /^(id|.*_id|.*Id)$/;

/** A key whose value is a phone number: only the mask is kept. */
const PHONE_KEY = /(^|_)(phone|msisdn|mobile|tel)(_|$)|(Phone|Msisdn|Mobile)$/;

/**
 * A key whose value is a person's name — always removed. `…Name` of a
 * technical thing (a job, a queue, a table, a file) is not a name of
 * anyone and is kept.
 */
const NAME_KEY = /(^|_)name$|Name$/i;
const TECHNICAL_NAME_KEY =
  /^(job|queue|dead|table|column|file|host|module|class|method|field|key|event|action|channel|route|metric|tag|setting|provider|index|bucket|schema|database|db|service|step|group|package|app|env|command|handler|process|worker|migration|header|entity|type|role|status|platform|rule|limit|policy|template|topic|variable|operation|issuer|constraint|test|container)_?name$/i;

/** A key whose value never leaves the process. */
const SENSITIVE_KEY = [
  /pass(word)?/i,
  /secret/i,
  /token/i,
  /credential/i,
  /^authorization$|^auth$|^cookie$|^cookies$/i,
  /^otp|otp$/i,
  /(^|_)code(s)?$|Code(s)?$/i,
  /(^|_)pin$/i,
  /(api|secret|private|public|encryption|signing|hash|access)_?key/i,
  /hash/i,
  /seed/i,
  /signature/i,
  /e?mail/i,
  /address|street|apartment|postcode|zip/i,
  /birth|iin|passport|licen[cs]e/i,
  /^body$|^payload$|^params$|^parameters$|^arguments$/i,
  /^query$|^search$|^q$/i,
  /^message$|^text$|^comment$|^note$|^prompt$|^transcript$/i,
  /^ip$|ip_?address|^remote_?addr$/i,
  /user_?agent/i,
];

/** …unless the key is one of these: they are safe words, not data. */
const SAFE_KEY =
  /^(codeLength|code_length|attemptsRemaining|statusCode|status_code|errorCode|error_code|httpCode|backupCodesRemaining|backupCodeCount|codesRemaining)$/;

const TOKEN_LIKE = [
  // JSON Web Token (the access token).
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]+)?/g,
  // Refresh token `rt1.<session>.<generation>.<secret>` and sign-in step `st1.<id>.<secret>`.
  /\b[a-z]{2}\d\.[0-9a-fA-F-]{36}\.[A-Za-z0-9_.-]{6,}/g,
  // The authenticator app URI carries the TOTP secret.
  /otpauth:\/\/\S+/g,
  // A bearer credential wherever it appears in text.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

/** `code=123456`, `token: abc…`, `password="…"` inside a message. */
const SENSITIVE_PAIR =
  /\b(pass(?:word)?|secret|token|credential|authorization|cookie|otp|code|pin|api[_-]?key|seed|signature|email|e-mail|name|address|params|parameters)\b\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;)]+)/gi;

/** What a failed statement was bound to (`params: [ … ]` of a driver error). */
const QUERY_PARAMS = /\bparams:\s*\[[^\]]*\]/gi;

const EMAIL = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

/**
 * A phone number: `+7 701 123 45 67`, `+77011234567`, `8 (701) 123-45-67`,
 * `77011234567`. Never a part of a longer word, a UUID group or a decimal
 * number — hence the boundaries on both sides.
 */
const PHONE = /(?<![\w+.-])\+?\d[\d\s().-]{8,18}\d(?![\w.-])/g;

/** The query string of a URL: it carries whatever the caller put there. */
const URL_QUERY = /(\bhttps?:\/\/\S*?|\s\/[^\s?]*)\?[^\s"']*/gi;

const IPV4 = /(?<![\w.])\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![\w.])/g;
const IPV6 = /(?<![\w:])(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}(?![\w:])/g;

/** The last four digits are the only part of a number that may be shown. */
function maskPhoneText(text: string): string {
  const digits = text.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) {
    return text;
  }
  return `+7***${digits.slice(-4)}`;
}

/**
 * One string with everything personal taken out. Safe to call on anything:
 * a log message, an error message, a stack frame, a tag value.
 */
export function sanitizeText(value: string): string {
  let text = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[cut]` : value;
  for (const pattern of TOKEN_LIKE) {
    text = text.replace(pattern, REDACTED);
  }
  text = text.replace(QUERY_PARAMS, `params: ${REDACTED}`);
  text = text.replace(SENSITIVE_PAIR, (_match, key: string) => `${key}=${REDACTED}`);
  text = text.replace(URL_QUERY, (match) => `${match.slice(0, match.indexOf("?"))}?${REDACTED}`);
  text = text.replace(EMAIL, (_match, domain: string) => `***@${domain}`);
  text = text.replace(PHONE, (match) => maskPhoneText(match));
  text = text.replace(IPV4, REDACTED_IP);
  text = text.replace(IPV6, REDACTED_IP);
  return text;
}

function isIdentifierKey(key: string): boolean {
  return IDENTIFIER_KEY.test(key);
}

function keyVerdict(key: string): "keep" | "phone" | "drop" {
  if (SAFE_KEY.test(key) || isIdentifierKey(key)) {
    return "keep";
  }
  if (PHONE_KEY.test(key)) {
    return "phone";
  }
  if (NAME_KEY.test(key)) {
    return TECHNICAL_NAME_KEY.test(key) ? "keep" : "drop";
  }
  return SENSITIVE_KEY.some((pattern) => pattern.test(key)) ? "drop" : "keep";
}

function sanitizeErrorLike(error: Error, depth: number, seen: WeakSet<object>): unknown {
  const result: Record<string, unknown> = {
    name: sanitizeText(error.name),
    message: sanitizeText(error.message),
  };
  if (typeof error.stack === "string") {
    result.stack = sanitizeText(error.stack);
  }
  if (error.cause !== undefined && error.cause !== null) {
    result.cause = walk(error.cause, depth + 1, seen);
  }
  // Fields a driver or a library attaches to its errors (`code`, `detail`,
  // `query`, …) — same key rules as any other object.
  for (const key of Object.keys(error)) {
    if (key === "name" || key === "message" || key === "stack" || key === "cause") {
      continue;
    }
    const verdict = keyVerdict(key);
    result[key] =
      verdict === "drop"
        ? REDACTED
        : walk((error as unknown as Record<string, unknown>)[key], depth + 1, seen);
  }
  return result;
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value ?? null;
  }
  switch (typeof value) {
    case "string":
      return sanitizeText(value);
    case "number":
    case "boolean":
      return value;
    case "bigint":
      return `${value.toString()}n`;
    case "function":
      return "[function]";
    case "symbol":
      return "[symbol]";
    default:
      break;
  }
  if (depth >= MAX_DEPTH) {
    return "[depth]";
  }
  const object = value as object;
  if (seen.has(object)) {
    return "[circular]";
  }
  seen.add(object);
  try {
    if (value instanceof Error) {
      return sanitizeErrorLike(value, depth, seen);
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (value instanceof Map) {
      return walk(Object.fromEntries(value), depth, seen);
    }
    if (value instanceof Set) {
      return walk([...value], depth, seen);
    }
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ENTRIES).map((item) => walk(item, depth + 1, seen));
      if (value.length > MAX_ENTRIES) {
        items.push(`[${String(value.length - MAX_ENTRIES)} more]`);
      }
      return items;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    const result: Record<string, unknown> = {};
    for (const [key, item] of entries.slice(0, MAX_ENTRIES)) {
      const verdict = keyVerdict(key);
      if (verdict === "drop") {
        result[key] = REDACTED;
      } else if (verdict === "phone") {
        result[key] = typeof item === "string" ? maskPhoneText(item) : REDACTED;
      } else {
        result[key] = walk(item, depth + 1, seen);
      }
    }
    if (entries.length > MAX_ENTRIES) {
      result["[more]"] = entries.length - MAX_ENTRIES;
    }
    return result;
  } finally {
    seen.delete(object);
  }
}

/**
 * Anything at all — a value, an object, an array, an error with its causes
 * — with personal data removed at any depth. Throws only if the value
 * itself makes sanitizing impossible; callers that send data outwards
 * treat that as "send nothing" (`sanitizeForTransport`).
 */
export function sanitizeValue(value: unknown): unknown {
  return walk(value, 0, new WeakSet<object>());
}

/**
 * For anything leaving the process: the sanitized value, or `undefined` if
 * sanitizing failed — nothing unsanitized is ever returned, so a failure
 * inside the sanitizer means the event is dropped rather than sent as it
 * was (business rule, TASK-009).
 */
export function sanitizeForTransport(value: unknown): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: sanitizeValue(value) };
  } catch {
    return { ok: false };
  }
}

/**
 * For the application log: the sanitized text, or a marker if sanitizing
 * failed — the line is still written (the request must not be lost with
 * it), only without the text that could not be cleaned.
 */
export function sanitizeForLog(value: string): string {
  try {
    return sanitizeText(value);
  } catch {
    return SANITIZER_FAILED;
  }
}
