/**
 * Session tool path normalization helpers.
 *
 * Expands user/file URL inputs and resolves read/write paths against the active cwd with macOS filename variants.
 */
import { accessSync, constants } from "node:fs";
import * as os from "node:os";
import { basename, isAbsolute, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";
function normalizeUnicodeSpaces(str: string): string {
  return str.replace(UNICODE_SPACES, " ");
}

function tryMacOSScreenshotPath(filePath: string): string {
  return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNFDVariant(filePath: string): string {
  // macOS stores filenames in NFD (decomposed) form, try converting user input to NFD
  return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
  // macOS uses U+2019 (right single quotation mark) in screenshot names like "Capture d'écran"
  // Users typically type U+0027 (straight apostrophe)
  return filePath.replace(/'/g, "\u2019");
}

function fileExists(filePath: string): boolean {
  try {
    accessSync(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizeAtPrefix(filePath: string): string {
  return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

function expandPath(filePath: string): string {
  const normalized = normalizeAtPrefix(filePath);
  if (normalized.startsWith("file://")) {
    try {
      return fileURLToPath(normalized);
    } catch {
      return normalized;
    }
  }
  if (normalized === "~") {
    return os.homedir();
  }
  if (normalized.startsWith("~/")) {
    return os.homedir() + normalized.slice(1);
  }
  return normalized;
}

/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  if (isAbsolute(expanded)) {
    return expanded;
  }
  return resolvePath(cwd, expanded);
}

export function resolveReadPath(filePath: string, cwd: string): string {
  const resolved = resolveToCwd(filePath, cwd);

  if (fileExists(resolved)) {
    return resolved;
  }

  // Only vary the filename: the parent may already have passed the workspace
  // guard, so normalization must not select a different directory.
  const filename = basename(resolved);
  const parentPrefix = resolved.slice(0, resolved.length - filename.length);
  const asciiFilename = normalizeUnicodeSpaces(filename);
  const asciiVariant = parentPrefix + asciiFilename;
  if (asciiVariant !== resolved && fileExists(asciiVariant)) {
    return asciiVariant;
  }
  const amPmVariant = parentPrefix + tryMacOSScreenshotPath(asciiFilename);
  if (amPmVariant !== resolved && fileExists(amPmVariant)) {
    return amPmVariant;
  }

  // Try NFD variant (macOS stores filenames in NFD form)
  const nfdVariant = parentPrefix + tryNFDVariant(asciiFilename);
  if (nfdVariant !== resolved && fileExists(nfdVariant)) {
    return nfdVariant;
  }

  // Try curly quote variant (macOS uses U+2019 in screenshot names)
  const curlyVariant = parentPrefix + tryCurlyQuoteVariant(asciiFilename);
  if (curlyVariant !== resolved && fileExists(curlyVariant)) {
    return curlyVariant;
  }

  // Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
  const nfdCurlyVariant = parentPrefix + tryCurlyQuoteVariant(tryNFDVariant(asciiFilename));
  if (nfdCurlyVariant !== resolved && fileExists(nfdCurlyVariant)) {
    return nfdCurlyVariant;
  }

  return resolved;
}
