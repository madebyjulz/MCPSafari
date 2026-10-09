// What these scripts print, and when they fail, is pinned to the Python
// originals they replaced: the same exception names and messages, `repr()`
// quoting, pathlib's spelling of paths, `str.strip()`, and text-mode reads
// (strict UTF-8, universal newlines). This module is that compatibility layer,
// so the scripts themselves read as ports line for line.
import { readFileSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { getSystemErrorMessage } from "node:util";

/** A decoded JSON document, as `json.loads` would hand it to Python. */
export type Json = null | boolean | number | string | readonly Json[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: Json;
}

export class ValueError extends Error {
  static {
    this.prototype.name = "ValueError";
  }
}

export class JsonDecodeError extends ValueError {
  static {
    this.prototype.name = "json.decoder.JSONDecodeError";
  }
}

export class UnicodeDecodeError extends ValueError {
  static {
    this.prototype.name = "UnicodeDecodeError";
  }
}

export class RuntimeError extends Error {
  static {
    this.prototype.name = "RuntimeError";
  }
}

export class AssertionError extends Error {
  static {
    this.prototype.name = "AssertionError";
  }
}

/** A missing dictionary key; Python prints the key's repr as the message. */
export class KeyError extends Error {
  static {
    this.prototype.name = "KeyError";
  }

  constructor(key: string | number) {
    super(repr(key));
  }
}

export class IndexError extends Error {
  static {
    this.prototype.name = "IndexError";
  }
}

export class AttributeError extends Error {
  static {
    this.prototype.name = "AttributeError";
  }
}

/** Python's own TypeError, distinct from JavaScript's, so it is never caught as an expected failure. */
export class PythonTypeError extends Error {
  static {
    this.prototype.name = "TypeError";
  }
}

/** An OSError with the subclass name and `[Errno N] strerror: 'path'` message Python gives it. */
export class OsError extends Error {
  static {
    this.prototype.name = "OSError";
  }

  constructor(code: string, filename: string) {
    // SAFETY: an unlisted code indexes to undefined, which ?? turns into 0.
    const errno = constants.errno[code as keyof typeof constants.errno] ?? 0;
    super(`[Errno ${errno}] ${strerror(code, errno)}: ${repr(filename)}`);

    const name = OS_ERROR_NAMES.get(code);

    if (name !== undefined) this.name = name;
  }
}

/** subprocess.CalledProcessError for a `check=True` command that failed. */
export class CalledProcessError extends Error {
  static {
    this.prototype.name = "subprocess.CalledProcessError";
  }

  constructor(command: readonly string[], status: number | null, signal: NodeJS.Signals | null) {
    const outcome =
      signal === null
        ? `returned non-zero exit status ${status ?? -1}.`
        : `died with <Signals.${signal}: ${constants.signals[signal]}>.`;

    super(`Command '${repr(command)}' ${outcome}`);
  }
}

const OS_ERROR_NAMES = new Map([
  ["EACCES", "PermissionError"],
  ["EEXIST", "FileExistsError"],
  ["EISDIR", "IsADirectoryError"],
  ["ENOENT", "FileNotFoundError"],
  ["ENOTDIR", "NotADirectoryError"],
  ["EPERM", "PermissionError"],
]);

/** C library wording, which Python uses; libuv words several of these differently. */
const STRERROR = new Map([
  ["EACCES", "Permission denied"],
  ["EEXIST", "File exists"],
  ["EIO", "Input/output error"],
  ["EISDIR", "Is a directory"],
  ["ELOOP", "Too many levels of symbolic links"],
  ["EMFILE", "Too many open files"],
  ["ENAMETOOLONG", "File name too long"],
  ["ENOENT", "No such file or directory"],
  ["ENOSPC", "No space left on device"],
  ["ENOTDIR", "Not a directory"],
  ["EPERM", "Operation not permitted"],
  ["EROFS", "Read-only file system"],
]);

function strerror(code: string, errno: number): string {
  const known = STRERROR.get(code);

  if (known !== undefined) return known;

  const message = errno === 0 ? code : getSystemErrorMessage(-errno);

  return message.charAt(0).toUpperCase() + message.slice(1);
}

/** Convert a Node system error into the OSError Python raises for the same failure. */
export function osError(cause: unknown, filename: string): Error {
  if (cause instanceof Error && "code" in cause && typeof cause.code === "string" && /^E[A-Z]+$/.test(cause.code)) {
    return new OsError(cause.code, filename);
  }

  return cause instanceof Error ? cause : new Error(String(cause));
}

/** `str(pathlib.PurePosixPath(path))`: no `.` or empty segments, no trailing slash, `..` kept. */
export function pyPath(path: string): string {
  const root = path.startsWith("//") && !path.startsWith("///") ? "//" : path.startsWith("/") ? "/" : "";
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  const joined = root + parts.join("/");

  return joined === "" ? "." : joined;
}

const PY_WHITESPACE =
  "[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";

const PY_STRIP = new RegExp(`^${PY_WHITESPACE}+|${PY_WHITESPACE}+$`, "g");

/** `str.strip()`: Python's whitespace set, which differs from `String.prototype.trim` at the edges. */
export function pyStrip(text: string): string {
  return text.replace(PY_STRIP, "");
}

/** `Path.read_text()` / `open(encoding="utf-8")`: strict UTF-8 and universal newlines. */
export function readText(path: string): string {
  let bytes: Buffer;

  try {
    bytes = readFileSync(path);
  } catch (cause) {
    throw osError(cause, path);
  }

  return decodeUtf8(bytes).replace(/\r\n?/g, "\n");
}

/** `Path.write_text()`: UTF-8, newlines written as given. */
export function writeText(path: string, text: string): void {
  try {
    writeFileSync(path, text, "utf8");
  } catch (cause) {
    throw osError(cause, path);
  }
}

/** `json.loads`, failing with a JSONDecodeError (a ValueError) like Python does. */
export function parseJson(text: string): Json {
  try {
    // SAFETY: JSON.parse only ever produces null, booleans, numbers, strings, arrays and plain objects.
    return JSON.parse(text) as Json;
  } catch (cause) {
    throw new JsonDecodeError(cause instanceof Error ? cause.message : String(cause));
  }
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new UnicodeDecodeError(`'utf-8' codec can't decode ${describeInvalidUtf8(bytes)}`);
  }
}

/** The position and reason CPython's UTF-8 decoder reports for the first invalid sequence. */
function describeInvalidUtf8(bytes: Uint8Array): string {
  const isContinuation = (byte: number | undefined, low = 0x80, high = 0xbf) =>
    byte !== undefined && byte >= low && byte <= high;

  let index = 0;

  while (index < bytes.length) {
    const lead = bytes[index] ?? 0;

    if (lead < 0x80) {
      index += 1;
      continue;
    }

    const length =
      lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;

    if (length === 0) return `byte 0x${hex(lead)} in position ${index}: invalid start byte`;

    const secondLow = lead === 0xe0 ? 0xa0 : lead === 0xf0 ? 0x90 : 0x80;
    const secondHigh = lead === 0xed ? 0x9f : lead === 0xf4 ? 0x8f : 0xbf;
    let valid = 1;

    while (valid < length) {
      const byte = bytes[index + valid];

      if (byte === undefined) {
        return valid === 1
          ? `byte 0x${hex(lead)} in position ${index}: unexpected end of data`
          : `bytes in position ${index}-${index + valid - 1}: unexpected end of data`;
      }

      const ok = valid === 1 ? isContinuation(byte, secondLow, secondHigh) : isContinuation(byte);

      if (!ok) {
        return valid === 1
          ? `byte 0x${hex(lead)} in position ${index}: invalid continuation byte`
          : `bytes in position ${index}-${index + valid - 1}: invalid continuation byte`;
      }

      valid += 1;
    }

    index += length;
  }

  return `bytes: invalid data`;
}

function hex(byte: number): string {
  return byte.toString(16).padStart(2, "0");
}

/** Python's `repr()` for the values these scripts print: strings, numbers, JSON lists and dicts. */
export function repr(value: Json): string {
  if (value === null) return "None";

  if (value === true) return "True";

  if (value === false) return "False";

  if (typeof value === "number") return reprNumber(value);

  if (typeof value === "string") return reprString(value);

  if (isJsonArray(value)) return `[${value.map(repr).join(", ")}]`;

  return `{${Object.entries(value)
    .map(([key, item]) => `${reprString(key)}: ${repr(item)}`)
    .join(", ")}}`;
}

function reprNumber(value: number): string {
  // JSON integers decode to Python ints, which print every digit.
  if (Number.isInteger(value)) return BigInt(value).toString();

  if (!Number.isFinite(value)) return Number.isNaN(value) ? "nan" : value > 0 ? "inf" : "-inf";

  // Shortest round-trip digits, laid out the way Python's float repr does.
  const [mantissa = "", exponentText = "0"] = value.toExponential().split("e");
  const exponent = Number(exponentText);
  const negative = mantissa.startsWith("-");
  const digits = mantissa.replace(/[-.]/g, "");
  const sign = negative ? "-" : "";

  if (exponent < -4 || exponent >= 16) {
    const fraction = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;

    return `${sign}${fraction}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }

  if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;

  const whole = digits.padEnd(exponent + 1, "0");
  const integer = whole.slice(0, exponent + 1);
  const fraction = whole.slice(exponent + 1);

  return `${sign}${integer}.${fraction === "" ? "0" : fraction}`;
}

function reprString(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let body = "";

  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;

    if (character === "\\") body += "\\\\";
    else if (character === quote) body += `\\${quote}`;
    else if (character === "\t") body += "\\t";
    else if (character === "\n") body += "\\n";
    else if (character === "\r") body += "\\r";
    else if (character !== " " && /[\p{C}\p{Z}]/u.test(character)) {
      body +=
        code <= 0xff
          ? `\\x${hex(code)}`
          : code <= 0xffff
            ? `\\u${code.toString(16).padStart(4, "0")}`
            : `\\U${code.toString(16).padStart(8, "0")}`;
    } else body += character;
  }

  return `${quote}${body}${quote}`;
}

/** `sorted(set(values))` for strings: unique, in code point order. */
export function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareCodePoints);
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);

  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = (a[index]?.codePointAt(0) ?? 0) - (b[index]?.codePointAt(0) ?? 0);

    if (difference !== 0) return difference;
  }

  return a.length - b.length;
}

export function isJsonArray(value: Json): value is readonly Json[] {
  return Array.isArray(value);
}

export function isJsonObject(value: Json): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Python's type name for a JSON value, as error messages spell it. */
export function typeName(value: Json): string {
  if (value === null) return "NoneType";

  if (typeof value === "boolean") return "bool";

  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";

  if (typeof value === "string") return "str";

  return isJsonArray(value) ? "list" : "dict";
}

/** `value[key]`, raising what Python raises when the key or index is absent. */
export function item(value: Json, key: string | number): Json {
  if (isJsonObject(value) && typeof key === "string") {
    const found = Object.hasOwn(value, key) ? value[key] : undefined;

    if (found === undefined) throw new KeyError(key);

    return found;
  }

  if (isJsonArray(value) && typeof key === "number") {
    const found = value[key < 0 ? value.length + key : key];

    if (found === undefined) throw new IndexError("list index out of range");

    return found;
  }

  if (isJsonObject(value)) throw new KeyError(key);

  if (isJsonArray(value)) throw new PythonTypeError("list indices must be integers or slices, not str");

  if (typeof value === "string")
    throw new PythonTypeError(`string indices must be integers, not '${typeof key === "string" ? "str" : "int"}'`);

  throw new PythonTypeError(`'${typeName(value)}' object is not subscriptable`);
}

/** `value.get(key, fallback)`, which only dicts have. */
export function get(value: Json, key: string, fallback: Json = null): Json {
  if (!isJsonObject(value)) throw new AttributeError(`'${typeName(value)}' object has no attribute 'get'`);

  return Object.hasOwn(value, key) ? (value[key] ?? null) : fallback;
}

/** Python truthiness of a JSON value. */
export function truthy(value: Json): boolean {
  if (value === null || value === false || value === 0 || value === "") return false;

  if (isJsonArray(value)) return value.length > 0;

  if (isJsonObject(value)) return Object.keys(value).length > 0;

  return true;
}

/** Python `==` between JSON values (no int/float or bool/int distinction, like Python). */
export function equal(left: Json, right: Json): boolean {
  if (isJsonArray(left) && isJsonArray(right)) {
    return left.length === right.length && left.every((entry, index) => equal(entry, right[index] ?? null));
  }

  if (isJsonObject(left) && isJsonObject(right)) {
    const keys = Object.keys(left);

    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && equal(left[key] ?? null, right[key] ?? null))
    );
  }

  const asNumber = (value: Json) => (value === true ? 1 : value === false ? 0 : value);

  return asNumber(left) === asNumber(right);
}

/** The last line of the traceback Python prints for an uncaught exception. */
export function exceptionLine(cause: unknown): string {
  if (cause instanceof Error) return cause.message === "" ? cause.name : `${cause.name}: ${cause.message}`;

  return String(cause);
}

/** Python's `str()`: strings as they are, everything else as its repr. */
export function str(value: Json): string {
  return typeof value === "string" ? value : repr(value);
}
