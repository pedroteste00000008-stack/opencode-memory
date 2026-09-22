/**
 * Sanitization boundary (§16, invariant #4).
 *
 * Every untrusted text crosses this boundary BEFORE persistence.
 * - secrets redaction (tokens, keys, passwords)
 * - control-character stripping
 * - length bounding
 * - optional path allow/deny notes left to the caller (no FS access here)
 */

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "github-token", re: /\bgh[op]_[A-Za-z0-9_]{20,}\b/g },
  { name: "generic-bearer", re: /\bbearer\s+[A-Za-z0-9\-._~+/=]{10,}/gi },
  { name: "api-key-assign", re: /(api[_-]?key|secret|senha|passwd|password)\s*[:=]\s*['"]?[^\s'"]{8,}['"]?/gi },
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
]

export interface SanitizeResult {
  text: string
  redacted: string[]
  truncated: boolean
}

export function sanitizeForPersistence(
  input: string,
  maxChars = 4000,
): SanitizeResult {
  let text = input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
  const redacted: string[] = []
  for (const { name, re } of SECRET_PATTERNS) {
    re.lastIndex = 0
    if (re.test(text)) {
      redacted.push(name)
      re.lastIndex = 0
      text = text.replace(re, `[REDACTED:${name}]`)
    }
  }
  let truncated = false
  if (text.length > maxChars) {
    text = text.slice(0, maxChars)
    truncated = true
  }
  text = text.trim()
  return { text, redacted, truncated }
}

/** Refuse to persist empty / trivially short contents. */
export function isPersistableText(text: string, minChars = 8): boolean {
  return text.trim().length >= minChars
}
