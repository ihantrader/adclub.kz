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
  // `authorization`, `proxy-authorization`, `x-sentry-auth`, `www-authenticate`.
  /authori[sz]ation$|(^|[_-])auth$|authenticate$/i,
  // `cookie`, `cookies`, `set-cookie`.
  /cookies?$/i,
  /^otp|otp$/i,
  /(^|_)code(s)?$|Code(s)?$/i,
  // The QR of an order is its second credential: `qrPayload`, `qr_payload`,
  // `qrToken`, `qr` (TASK-022; `qrToken` also matches /token/ above).
  /(^|_)qr(_|$)|qr_?(payload|token|content|data|text|image)/i,
  /(^|_)pin$/i,
  // `apiKey`, `api_key`, `x-api-key`, `signing-key`, …
  /(api|secret|private|public|encryption|signing|hash|access)[_-]?key/i,
  /hash/i,
  /seed/i,
  /signature/i,
  /e?mail/i,
  /address|street|apartment|postcode|zip/i,
  /birth|iin|passport|licen[cs]e/i,
  /^body$|^payload$|^params$|^parameters$|^arguments$/i,
  // What PostgreSQL reports about the data of a failed statement:
  // `Key (phone)=(…) already exists`, `Failing row contains (…)`, the
  // value of a bound parameter (`unnamed portal parameter $1 = '…'`).
  /^detail$|^where$|^internal_?query$/i,
  /^query$|^search$|^q$/i,
  /^message$|^text$|^comment$|^note$|^prompt$|^transcript$/i,
  // `ip`, `ip_address`, `remote_addr`, `x-forwarded-for`, `forwarded`, `x-real-ip`.
  /^ip$|ip[_-]?address|^remote[_-]?addr$|forwarded|(^|[_-])(real|client)[_-]?ip$/i,
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
  // The content of an order's QR, wherever it appears in text (TASK-022).
  /ADCLUB-ORDER:[A-Za-z0-9_-]+/g,
  // The authenticator app URI carries the TOTP secret.
  /otpauth:\/\/\S+/g,
  // A bearer credential wherever it appears in text.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

/** `code=123456`, `token: abc…`, `password="…"` inside a message. */
const SENSITIVE_PAIR =
  /\b(pass(?:word)?|secret|token|credential|authorization|cookie|otp|code|pin|api[_-]?key|seed|signature|email|e-mail)\b\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;)]+)/gi;

/**
 * `name=Айгерим Касымова`, `address: Алматы, ул. Абая 10`: a value with
 * spaces in it, so it runs to the end of the line or the next `;` / `)`,
 * not to the next space.
 */
const SENSITIVE_PHRASE =
  /\b(name|address|params|parameters)\b\s*[=:]\s*("[^"]*"|'[^']*'|[^;)\n]+)/gi;

/**
 * What a failed statement was bound to. Drizzle ends its message with the
 * values as they are — `Failed query: <sql>\nparams: a,b,c`
 * (`DrizzleQueryError`), no brackets, values with commas, spaces and even
 * line breaks in them — so everything after `params:` goes, up to the
 * first stack frame or the end of the text. A driver's `params: [ … ]` is
 * the same case.
 */
const QUERY_PARAMS = /\bparams:(?:\s*\[[^\]]*\]|[\s\S]*?(?=\n\s+at\s|$))/gi;

/**
 * What PostgreSQL puts into a message or a detail about the data itself:
 * the key of a violated unique constraint, the row a check refused, the
 * input a type could not take, a bound parameter. Column and constraint
 * names stay; the values go.
 */
const DATABASE_VALUES: readonly [RegExp, string][] = [
  [/\bKey \(([^)\n]*)\)=\((?:[^()\n]|\([^()\n]*\))*\)/g, `Key ($1)=(${REDACTED})`],
  [/\bFailing row contains \([^\n]*\)/g, `Failing row contains (${REDACTED})`],
  [/(\binvalid input (?:syntax|value) for (?:type|enum) [^:\n]+): "[^\n]*"/g, `$1: "${REDACTED}"`],
  [/(\bparameter \$\d+ = )'[^\n]*'/g, `$1'${REDACTED}'`],
];

const EMAIL = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

/** The user and password of a URL: `postgres://user:secret@host/db` keeps only the host. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;

/** The query string of a URL: it carries whatever the caller put there. */
const URL_QUERY = /(\bhttps?:\/\/\S*?|\s\/[^\s?]*)\?[^\s"']*/gi;

/**
 * What only looks like a phone number or an address: a UUID, a long hex
 * identifier, a date, a time. Held out of the text while numbers and
 * addresses are looked for, then put back untouched.
 */
const NOT_PERSONAL = new RegExp(
  [
    // UUID.
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/.source,
    // A date with an optional time: `2026-09-18`, `2026-09-18 03:14:33.123456+05`.
    /(?<!\d)\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?(?!\d)/
      .source,
    // A date written the local way: `18.09.2026`.
    /(?<!\d)\d{2}\.\d{2}\.\d{4}(?!\d)/.source,
    // A time on its own: `03:14`, `03:14:33.123`.
    /(?<![\d:])\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?![\d:])/.source,
    // A long hex identifier (an event, a trace, a hash) with at least one letter.
    /(?<![0-9A-Za-z])(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{16,}(?![0-9A-Za-z])/.source,
  ].join("|"),
  "g",
);

/**
 * A candidate phone number in any position: `+7 701 123 45 67`,
 * `8 (701) 123-45-67`, `77011234567` — at the end of a sentence, in
 * brackets, after a dash, glued to a word (`user_77011234567`). Only digits
 * bound it; whether it is a number is then decided by `maskIfPhone`.
 */
const PHONE = /(?<!\d)\+?\d(?:[ ()-]{0,2}\d){9,14}(?!\d)/g;

const IPV4 = /(?<![\w.])\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![\w.])/g;
const HEX4 = "[0-9a-fA-F]{1,4}";
/**
 * IPv6: the full form (eight groups) and every compressed one with `::`
 * (`2a02:2168:8a1f::1`, `fe80::1%eth0`, `::1`, `::ffff:192.0.2.1`). Fewer
 * than eight groups without `::` is not an address — `03:14:33` is a time.
 */
const IPV6 = new RegExp(
  `(?<![\\w:.])(?:(?:${HEX4}:){7}${HEX4}|(?:${HEX4}:){0,7}(?:${HEX4})?::(?:${HEX4}(?::${HEX4}){0,6})?(?:\\.\\d{1,3}){0,3})(?:%[\\w.]+)?(?![\\w:])`,
  "g",
);

/** The last four digits are the only part of a number that may be shown. */
function maskPhoneText(text: string): string {
  const digits = text.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) {
    return text;
  }
  return `+7***${digits.slice(-4)}`;
}

/**
 * A run of digits is a phone number when it is written like one: with `+`
 * or with separators between groups (10–15 digits), or bare in the
 * Kazakhstan shape (`7XXXXXXXXXX`, `8XXXXXXXXXX`, `7XXXXXXXXX`). Any other
 * bare run — a numeric id, a timestamp — stays as it is.
 */
function maskIfPhone(text: string): string {
  const digits = text.replace(/\D/g, "");
  const shaped = text.startsWith("+") || /[ ()-]/.test(text);
  const kazakh =
    (digits.length === 11 && /^[78]/.test(digits)) || (digits.length === 10 && digits[0] === "7");
  return shaped || kazakh ? maskPhoneText(text) : text;
}

/** Marks a held piece of text (NUL); NULs of the input itself are replaced first. */
const HOLD = String.fromCharCode(0);
const HOLD_ANY = new RegExp(HOLD, "g");
const HELD = new RegExp(`${HOLD}([a-z]+)${HOLD}`, "g");

/** Held pieces are numbered in letters, so they never add digits to a number next to them. */
function holdLabel(index: number): string {
  return index.toString(26).replace(/[0-9]/g, (digit) => String.fromCharCode(113 + Number(digit)));
}

function holdIndex(label: string): number {
  return parseInt(
    label.replace(/[q-z]/g, (char) => String(char.charCodeAt(0) - 113)),
    26,
  );
}

/** Phone numbers and IP addresses masked; dates, times and identifiers intact. */
function maskNumbersAndAddresses(value: string): string {
  const held: string[] = [];
  let text = value.replace(HOLD_ANY, String.fromCharCode(0xfffd)).replace(NOT_PERSONAL, (match) => {
    held.push(match);
    return `${HOLD}${holdLabel(held.length - 1)}${HOLD}`;
  });
  // IPv6 first: `::ffff:192.0.2.1` is one address, not a prefix and an IPv4.
  text = text.replace(IPV6, REDACTED_IP);
  text = text.replace(IPV4, REDACTED_IP);
  text = text.replace(PHONE, (match) => maskIfPhone(match));
  return text.replace(HELD, (_match, label: string) => held[holdIndex(label)]!);
}

/**
 * One string with everything personal taken out. Safe to call on anything:
 * a log message, an error message, a stack frame, a tag value.
 */
export function sanitizeText(value: string): string {
  // Cut after cleaning, so a cut never leaves half a number unmasked; the
  // work itself is bounded by a much larger first cut.
  const cleaned = cleanText(
    value.length > MAX_STRING * 10 ? value.slice(0, MAX_STRING * 10) : value,
  );
  return cleaned.length > MAX_STRING ? `${cleaned.slice(0, MAX_STRING)}…[cut]` : cleaned;
}

function cleanText(value: string): string {
  let text = value;
  for (const pattern of TOKEN_LIKE) {
    text = text.replace(pattern, REDACTED);
  }
  text = text.replace(QUERY_PARAMS, `params: ${REDACTED}`);
  for (const [pattern, replacement] of DATABASE_VALUES) {
    text = text.replace(pattern, replacement);
  }
  text = text.replace(SENSITIVE_PAIR, (_match, key: string) => `${key}=${REDACTED}`);
  text = text.replace(SENSITIVE_PHRASE, (_match, key: string) => `${key}=${REDACTED}`);
  text = text.replace(URL_CREDENTIALS, `$1${REDACTED}@`);
  text = text.replace(URL_QUERY, (match) => `${match.slice(0, match.indexOf("?"))}?${REDACTED}`);
  text = text.replace(EMAIL, (_match, domain: string) => `***@${domain}`);
  return maskNumbersAndAddresses(text);
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

/**
 * The stack of an error with its message cleaned the same way as the
 * message itself. The stack starts with the message as it was when the
 * error was made — whatever it holds (Drizzle's bound values span lines)
 * — so that exact text is cut out and replaced rather than matched by a
 * pattern.
 */
function sanitizeStack(stack: string, message: string, cleanMessage: string): string {
  const at = message.length > 0 ? stack.indexOf(message) : -1;
  if (at < 0) {
    return sanitizeText(stack);
  }
  const head = sanitizeText(stack.slice(0, at));
  const frames = sanitizeText(stack.slice(at + message.length));
  return `${head}${cleanMessage}${frames}`;
}

/** Name, message and stack of an error, cleaned (the logger writes these). */
export function sanitizeErrorText(error: Error): { name: string; message: string; stack?: string } {
  const message = sanitizeText(error.message);
  return {
    name: sanitizeText(error.name),
    message,
    ...(typeof error.stack === "string" && {
      stack: sanitizeStack(error.stack, error.message, message),
    }),
  };
}

/**
 * `code` of an error is what an investigation starts from, and it is not a
 * login code: the SQLSTATE of a PostgreSQL error (`23505`, on an error
 * that also has `severity`) or a Node system error (`ECONNREFUSED`).
 */
function isErrorCode(error: Error, key: string): boolean {
  if (key !== "code") {
    return false;
  }
  const { code, severity } = error as Error & { code?: unknown; severity?: unknown };
  if (typeof code !== "string") {
    return false;
  }
  return (
    (typeof severity === "string" && /^[0-9A-Z]{5}$/.test(code)) || /^E[A-Z0-9_]{2,}$/.test(code)
  );
}

function sanitizeErrorLike(error: Error, depth: number, seen: WeakSet<object>): unknown {
  const result: Record<string, unknown> = { ...sanitizeErrorText(error) };
  if (error.cause !== undefined && error.cause !== null) {
    result.cause = walk(error.cause, depth + 1, seen);
  }
  // Fields a driver or a library attaches to its errors (`code`, `detail`,
  // `query`, …) — same key rules as any other object.
  for (const key of Object.keys(error)) {
    if (key === "name" || key === "message" || key === "stack" || key === "cause") {
      continue;
    }
    const verdict = isErrorCode(error, key) ? "keep" : keyVerdict(key);
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
