/**
 * Secret scanner for notes, process commands, and patch content.
 *
 * Used by `dvs save` (warning only) and `dvs share` (blocking, unless --force)
 * to prevent leaking credentials when states are exported or shared.
 *
 * Design notes:
 * - Regex-based. High-signal patterns only — we'd rather miss a custom secret
 *   than spam warnings on every hex string. False positives are user-hostile.
 * - `match` is always redacted. We never echo a full secret to stdout/stderr.
 * - Generic `password=...` assignments are de-duplicated by `kind` so they
 *   don't fire alongside a more-specific pattern match on the same value.
 */

export interface ScanFinding {
  /** e.g. "aws-access-key", "github-pat", "private-key" */
  kind: string;
  /** REDACTED snippet: first 6 chars of the secret + "…" */
  match: string;
  /** Caller-supplied: "note" | "process[0].command" | "patch" | etc. */
  location: string;
  /** 1-indexed line number for multi-line text */
  line?: number;
}

interface PatternDef {
  kind: string;
  regex: RegExp;
  /**
   * Which capture group (0 = full match) holds the actual secret to redact.
   * Defaults to 0.
   */
  secretGroup?: number;
  /**
   * If true, a finding for this kind is suppressed when any other finding
   * already exists at the same line. Used for the generic `password=` catch-all
   * so it doesn't fire on top of a specific AWS/GitHub/etc. match.
   */
  genericFallback?: boolean;
}

/**
 * Patterns are ordered most-specific-first. Order matters for the generic
 * fallback suppression (specific patterns run first, generic ones defer).
 */
export const SECRET_PATTERNS: readonly PatternDef[] = [
  // AWS
  { kind: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "aws-session-token", regex: /\bASIA[0-9A-Z]{16}\b/g },

  // Slack
  { kind: "slack-token", regex: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/g },

  // GitHub (classic PAT, fine-grained, OAuth, user-to-server, server-to-server, refresh)
  { kind: "github-pat", regex: /\bgh[pousr]_[A-Za-z0-9]{36}\b/g },

  // Google / Firebase
  { kind: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },

  // Anthropic (match before "openai-like" because Anthropic keys start sk- too)
  { kind: "anthropic-key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },

  // OpenAI-shaped. Labeled "openai-like" — many vendors emit sk- prefixed keys.
  { kind: "openai-like", regex: /\bsk-[A-Za-z0-9]{20,}\b/g },

  // Stripe
  { kind: "stripe-secret", regex: /\b(?:sk|rk)_live_[0-9a-zA-Z]{24,}\b/g },

  // PEM private keys — single-line match; "BEGIN ... PRIVATE KEY" marker is enough.
  {
    kind: "private-key",
    regex: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },

  // HTTP Authorization: Bearer <token>
  {
    kind: "bearer-token",
    regex: /\bAuthorization\s*:\s*Bearer\s+([A-Za-z0-9+/._~-]{8,})/gi,
    secretGroup: 1,
  },

  // Generic assignment: password/api_key/secret/token = "..."
  // De-duped by kind so it doesn't fire on top of a more-specific match on
  // the same line.
  {
    kind: "generic-credential",
    regex:
      /\b(?:password|passwd|api[-_]?key|secret|token)\s*[:=]\s*['"]?([^\s'"\n]{8,})/gi,
    secretGroup: 1,
    genericFallback: true,
  },
];

/**
 * Redact a secret for display: first 6 chars + "…". Never echo the full value.
 * Short secrets (< 6 chars) get the whole thing truncated to "…" so callers
 * can't accidentally leak them.
 */
function redact(secret: string): string {
  if (secret.length <= 6) return "…";
  return secret.slice(0, 6) + "…";
}

/**
 * Compute 1-indexed line number for a byte offset into `text`.
 * Counts '\n' characters up to (but not including) the offset.
 */
function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}

export function scanForSecrets(text: string, location: string): ScanFinding[] {
  if (!text) return [];

  const findings: ScanFinding[] = [];
  // Track (kind|match|line) triples for de-dup and (line -> nonGenericHit)
  // for the generic-fallback suppression rule.
  const seen = new Set<string>();
  const specificByLine = new Set<number>();

  // First pass: all non-fallback patterns.
  for (const pat of SECRET_PATTERNS) {
    if (pat.genericFallback) continue;
    collect(pat, text, location, findings, seen, specificByLine, false);
  }

  // Second pass: generic fallback patterns. Skip any line that already has
  // a specific finding.
  for (const pat of SECRET_PATTERNS) {
    if (!pat.genericFallback) continue;
    collect(pat, text, location, findings, seen, specificByLine, true);
  }

  return findings;
}

function collect(
  pat: PatternDef,
  text: string,
  location: string,
  findings: ScanFinding[],
  seen: Set<string>,
  specificByLine: Set<number>,
  isFallback: boolean
): void {
  // Clone the regex so we don't carry lastIndex state across calls.
  const re = new RegExp(pat.regex.source, pat.regex.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const group = pat.secretGroup ?? 0;
    const secret = m[group] ?? m[0];
    const line = lineOf(text, m.index);

    // Generic fallback: suppress if a specific pattern already matched here.
    if (isFallback && specificByLine.has(line)) {
      // Advance lastIndex past zero-length matches to avoid infinite loop.
      if (m.index === re.lastIndex) re.lastIndex++;
      continue;
    }

    const redacted = redact(secret);
    const key = `${pat.kind}|${redacted}|${line}`;
    if (!seen.has(key)) {
      seen.add(key);
      findings.push({
        kind: pat.kind,
        match: redacted,
        location,
        line,
      });
      if (!isFallback) specificByLine.add(line);
    }

    // Regex-global safety: if the match was zero-length, step lastIndex
    // forward so exec() doesn't loop on the same position.
    if (m.index === re.lastIndex) re.lastIndex++;
  }
}

/**
 * Format findings for CLI output. Caller is responsible for the header line
 * (e.g. the blocking message in `share` vs. the advisory message in `save`).
 */
export function formatFindings(findings: ScanFinding[]): string {
  if (findings.length === 0) return "";
  const lines = findings.map((f) => {
    const loc = f.line !== undefined ? `${f.location} (line ${f.line})` : f.location;
    return `  - ${f.kind} in ${loc}: ${f.match}`;
  });
  return lines.join("\n");
}
