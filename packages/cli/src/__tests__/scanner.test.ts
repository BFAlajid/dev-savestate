import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import simpleGit from "simple-git";
import {
  scanForSecrets,
  formatFindings,
  SECRET_PATTERNS,
} from "../lib/scanner.js";
import {
  ensureSavestateDir,
  atomicSaveState,
  computeHash,
} from "../lib/storage.js";
import type { SaveState } from "../lib/types.js";

const execFileAsync = promisify(execFile);

// Absolute path to the built CLI. Integration tests execute this via
// `node dist/index.js`.
const CLI_DIR = path.resolve(__dirname, "..", "..");
const CLI_ENTRY = path.join(CLI_DIR, "dist", "index.js");

async function createTestRepo(prefix: string): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `dvs-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await fs.mkdir(dir, { recursive: true });
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig("user.email", "test@test.com");
  await git.addConfig("user.name", "Test");
  await fs.writeFile(path.join(dir, "main.txt"), "initial\n");
  await git.add("main.txt");
  await git.commit("initial");
  return dir;
}

function buildState(
  name: string,
  projectRoot: string,
  overrides: Partial<SaveState> = {}
): SaveState {
  const now = new Date().toISOString();
  return {
    version: 2,
    name,
    createdAt: now,
    updatedAt: now,
    projectRoot,
    note: overrides.note ?? "",
    nextStep: overrides.nextStep,
    tags: overrides.tags || [],
    git: overrides.git || {
      branch: "master",
      commitHash: "abc123",
      hasUncommittedChanges: false,
      patchFile: "git-patch.diff",
      patchHash: computeHash(""),
    },
    processes: overrides.processes || [],
    untracked: overrides.untracked || { files: [] },
    archived: false,
    loadCount: 0,
    ...overrides,
  };
}

// ============================================================
// Unit tests: scanForSecrets
// ============================================================

describe("scanForSecrets — pattern coverage", () => {
  it("detects AWS access key id", () => {
    const findings = scanForSecrets("aws key AKIAIOSFODNN7EXAMPLE here", "note");
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("aws-access-key");
    expect(findings[0].match).toBe("AKIAIO…");
  });

  it("detects AWS session token (ASIA)", () => {
    const findings = scanForSecrets("token ASIAIOSFODNN7EXAMPLE", "note");
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("aws-session-token");
  });

  it("detects Slack token", () => {
    const findings = scanForSecrets(
      "slack xoxb-1234567890-abcdefghij",
      "note"
    );
    const kinds = findings.map((f) => f.kind);
    expect(kinds).toContain("slack-token");
  });

  it("detects GitHub classic PAT", () => {
    const findings = scanForSecrets(
      "gh ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ",
      "note"
    );
    const kinds = findings.map((f) => f.kind);
    expect(kinds).toContain("github-pat");
  });

  it("detects fine-grained GitHub token (gho_)", () => {
    const findings = scanForSecrets(
      "gho_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ",
      "note"
    );
    expect(findings.some((f) => f.kind === "github-pat")).toBe(true);
  });

  it("detects Google API key", () => {
    // AIza + exactly 35 chars, terminating at a word boundary.
    const findings = scanForSecrets(
      "key=AIzaSyabcdefghijklmnopqrstuvwxyz0123456",
      "note"
    );
    expect(findings.some((f) => f.kind === "google-api-key")).toBe(true);
  });

  it("detects Anthropic key and labels it correctly", () => {
    const findings = scanForSecrets(
      "sk-ant-abcdefghijklmnopqrstuvwxyz0123456789",
      "note"
    );
    expect(findings.some((f) => f.kind === "anthropic-key")).toBe(true);
  });

  it("detects OpenAI-like key (but labels openai-like, not openai)", () => {
    const findings = scanForSecrets(
      "sk-abcdefghijklmnopqrstuvwxyz0123456789",
      "note"
    );
    expect(findings.some((f) => f.kind === "openai-like")).toBe(true);
  });

  it("detects Stripe secret key (sk_live)", () => {
    const findings = scanForSecrets(
      "stripe sk_live_abcdefghijklmnopqrstuvwx",
      "note"
    );
    expect(findings.some((f) => f.kind === "stripe-secret")).toBe(true);
  });

  it("detects PEM private key header", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIB...\n-----END RSA PRIVATE KEY-----";
    const findings = scanForSecrets(pem, "note");
    expect(findings.some((f) => f.kind === "private-key")).toBe(true);
  });

  it("detects OpenSSH private key header", () => {
    const pem =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXkt...\n-----END OPENSSH PRIVATE KEY-----";
    const findings = scanForSecrets(pem, "note");
    expect(findings.some((f) => f.kind === "private-key")).toBe(true);
  });

  it("detects Authorization: Bearer header", () => {
    const findings = scanForSecrets(
      "Authorization: Bearer abc123_xyz-tok.en~v2",
      "note"
    );
    expect(findings.some((f) => f.kind === "bearer-token")).toBe(true);
  });

  it("detects generic password= assignment", () => {
    const findings = scanForSecrets('password="supersecret123"', "note");
    expect(findings.some((f) => f.kind === "generic-credential")).toBe(true);
  });

  it("detects generic api_key= assignment", () => {
    const findings = scanForSecrets("api_key=myverysecretvalue", "note");
    expect(findings.some((f) => f.kind === "generic-credential")).toBe(true);
  });
});

describe("scanForSecrets — redaction", () => {
  it("never echoes the full secret in match field", () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const findings = scanForSecrets(`key=${secret}`, "note");
    for (const f of findings) {
      expect(f.match).not.toContain(secret);
      // First 6 chars + "…" → length <= 7. Assert the contract described
      // in the task: match.length is small and redacted.
      expect(f.match.length).toBeLessThanOrEqual(8);
    }
  });

  it("redacts short secrets to '…' entirely", () => {
    // Craft something that hits the bearer pattern with a minimum-length token.
    const findings = scanForSecrets(
      "Authorization: Bearer abcdefgh",
      "note"
    );
    const bearer = findings.find((f) => f.kind === "bearer-token");
    expect(bearer).toBeDefined();
    // 8 chars -> sliced to "abcdef…"
    expect(bearer!.match).toBe("abcdef…");
  });

  it("never leaks the full secret through formatFindings()", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ";
    const findings = scanForSecrets(secret, "note");
    const formatted = formatFindings(findings);
    expect(formatted).not.toContain(secret);
  });
});

describe("scanForSecrets — line numbering", () => {
  it("reports 1-indexed line numbers on multi-line text", () => {
    const text =
      "line one\n" +
      "line two\n" +
      "AKIAIOSFODNN7EXAMPLE\n" +
      "line four\n" +
      "ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ\n";
    const findings = scanForSecrets(text, "note");
    const aws = findings.find((f) => f.kind === "aws-access-key");
    const gh = findings.find((f) => f.kind === "github-pat");
    expect(aws?.line).toBe(3);
    expect(gh?.line).toBe(5);
  });

  it("reports line 1 for single-line text", () => {
    const findings = scanForSecrets("AKIAIOSFODNN7EXAMPLE", "note");
    expect(findings[0].line).toBe(1);
  });

  it("handles CRLF line endings (line counted at \\n)", () => {
    const text = "one\r\ntwo\r\nAKIAIOSFODNN7EXAMPLE\r\n";
    const findings = scanForSecrets(text, "note");
    expect(findings[0].line).toBe(3);
  });
});

describe("scanForSecrets — de-duplication", () => {
  it("same secret on same line emits only once", () => {
    // Two identical tokens on one line should collapse to one finding.
    const dup = "AKIAIOSFODNN7EXAMPLE AKIAIOSFODNN7EXAMPLE";
    const findings = scanForSecrets(dup, "note");
    const aws = findings.filter((f) => f.kind === "aws-access-key");
    expect(aws).toHaveLength(1);
  });

  it("same secret on different lines emits twice", () => {
    const text = "AKIAIOSFODNN7EXAMPLE\nAKIAIOSFODNN7EXAMPLE";
    const findings = scanForSecrets(text, "note");
    const aws = findings.filter((f) => f.kind === "aws-access-key");
    expect(aws).toHaveLength(2);
    expect(aws[0].line).toBe(1);
    expect(aws[1].line).toBe(2);
  });

  it("generic fallback suppressed when a specific pattern fires on same line", () => {
    // `api_key=AKIAIOSFODNN7EXAMPLE` would match both aws-access-key AND
    // the generic credential pattern. We expect only the specific one.
    const findings = scanForSecrets(
      "api_key=AKIAIOSFODNN7EXAMPLE",
      "note"
    );
    expect(findings.some((f) => f.kind === "aws-access-key")).toBe(true);
    expect(findings.some((f) => f.kind === "generic-credential")).toBe(
      false
    );
  });
});

describe("scanForSecrets — negative cases", () => {
  it("clean text yields zero findings", () => {
    expect(scanForSecrets("this is a totally normal note", "note")).toEqual(
      []
    );
    expect(scanForSecrets("", "note")).toEqual([]);
  });

  it("prose containing the word 'password' without an assignment is not flagged", () => {
    expect(
      scanForSecrets(
        "I forgot my password again, need to reset it.",
        "note"
      )
    ).toEqual([]);
  });

  it("short random hex does not trigger AWS access key (needs AKIA prefix)", () => {
    expect(scanForSecrets("abcd1234efgh5678", "note")).toEqual([]);
  });
});

describe("SECRET_PATTERNS export", () => {
  it("is non-empty and every pattern has a kind + regex", () => {
    expect(SECRET_PATTERNS.length).toBeGreaterThan(0);
    for (const p of SECRET_PATTERNS) {
      expect(typeof p.kind).toBe("string");
      expect(p.kind.length).toBeGreaterThan(0);
      expect(p.regex).toBeInstanceOf(RegExp);
    }
  });

  it("returns findings in input order, preserving location", () => {
    const findings = scanForSecrets(
      "AKIAIOSFODNN7EXAMPLE then\nghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ",
      "processes[0].args"
    );
    expect(findings[0].location).toBe("processes[0].args");
    expect(findings.map((f) => f.kind)).toEqual([
      "aws-access-key",
      "github-pat",
    ]);
  });
});

describe("formatFindings", () => {
  it("returns empty string for no findings", () => {
    expect(formatFindings([])).toBe("");
  });

  it("includes kind, location, line, and redacted match", () => {
    const out = formatFindings([
      {
        kind: "aws-access-key",
        match: "AKIAIO…",
        location: "note",
        line: 3,
      },
    ]);
    expect(out).toContain("aws-access-key");
    expect(out).toContain("note");
    expect(out).toContain("line 3");
    expect(out).toContain("AKIAIO…");
  });

  it("omits line suffix when line is undefined", () => {
    const out = formatFindings([
      {
        kind: "github-pat",
        match: "ghp_ab…",
        location: "processes[0].command",
      },
    ]);
    expect(out).toContain("processes[0].command");
    expect(out).not.toContain("line");
  });
});

// ============================================================
// Integration tests: dvs save / dvs share
// ============================================================

describe("dvs save — secret scanner integration", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await createTestRepo("save-scan");
  });

  afterEach(async () => {
    try {
      await fs.rm(repo, { recursive: true, force: true });
    } catch {
      // Windows file locks
    }
  });

  it("warns on stderr when note contains AWS key but still saves", async () => {
    // Run save with a note containing AKIAIOSFODNN7EXAMPLE.
    const { stderr, stdout } = await execFileAsync(
      process.execPath,
      [CLI_ENTRY, "save", "testsec", "AKIAIOSFODNN7EXAMPLE"],
      { cwd: repo }
    );
    expect(stderr).toContain("Possible secrets detected");
    expect(stderr).toContain("aws-access-key");
    // Redacted — full secret should not appear anywhere in output.
    expect(stderr).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(stdout).not.toContain("AKIAIOSFODNN7EXAMPLE");
    // Save still succeeded.
    expect(stdout).toContain("Saved: testsec");
    // state.json exists
    const statePath = path.join(
      repo,
      ".savestate",
      "states",
      "testsec",
      "state.json"
    );
    const stat = await fs.stat(statePath);
    expect(stat.isFile()).toBe(true);
  });

  it("aborts with exit 1 under --strict-secrets and writes no state", async () => {
    let caught: any = null;
    try {
      await execFileAsync(
        process.execPath,
        [
          CLI_ENTRY,
          "save",
          "strict-test",
          "AKIAIOSFODNN7EXAMPLE",
          "--strict-secrets",
        ],
        { cwd: repo }
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe(1);
    expect(String(caught.stderr)).toContain("Possible secrets detected");
    // No state dir created.
    const stateDir = path.join(
      repo,
      ".savestate",
      "states",
      "strict-test"
    );
    await expect(fs.stat(stateDir)).rejects.toThrow();
  });

  it("clean note produces no warning", async () => {
    const { stderr, stdout } = await execFileAsync(
      process.execPath,
      [CLI_ENTRY, "save", "clean-note", "just a normal commit note"],
      { cwd: repo }
    );
    expect(stderr).not.toContain("Possible secrets detected");
    expect(stdout).toContain("Saved: clean-note");
  });
});

describe("dvs share — secret scanner blocks export", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await createTestRepo("share-scan");
  });

  afterEach(async () => {
    try {
      await fs.rm(repo, { recursive: true, force: true });
    } catch {
      // Windows file locks
    }
  });

  it("blocks share when note contains a PEM private key", async () => {
    // Seed a state directly (faster + more deterministic than two CLI calls).
    await ensureSavestateDir(repo);
    const pemNote =
      "Left an SSH key in the note:\n" +
      "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB\n" +
      "-----END OPENSSH PRIVATE KEY-----\n";
    const state = buildState("with-pem", repo, { note: pemNote });
    await atomicSaveState(repo, "with-pem", state, "");

    const outputPath = path.join(repo, "blocked.savestate.json");
    let caught: any = null;
    try {
      await execFileAsync(
        process.execPath,
        [CLI_ENTRY, "share", "with-pem", "-o", outputPath],
        { cwd: repo }
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe(1);
    expect(String(caught.stderr)).toContain("Possible secrets detected");
    expect(String(caught.stderr)).toContain("private-key");
    expect(String(caught.stderr)).toContain("Blocked");
    // Output file must NOT exist.
    await expect(fs.stat(outputPath)).rejects.toThrow();
  });

  it("proceeds under --force and prints findings", async () => {
    await ensureSavestateDir(repo);
    const pemNote =
      "-----BEGIN RSA PRIVATE KEY-----\nbase64stuff\n-----END RSA PRIVATE KEY-----";
    const state = buildState("pem-force", repo, { note: pemNote });
    await atomicSaveState(repo, "pem-force", state, "");

    const outputPath = path.join(repo, "forced.savestate.json");
    const { stderr, stdout } = await execFileAsync(
      process.execPath,
      [CLI_ENTRY, "share", "pem-force", "-o", outputPath, "--force"],
      { cwd: repo }
    );
    // User still sees what they're shipping.
    expect(stderr).toContain("Possible secrets detected");
    expect(stderr).toContain("private-key");
    expect(stderr).toContain("Proceeding due to --force");
    expect(stdout).toContain("Exported:");
    // Output file DOES exist this time.
    const stat = await fs.stat(outputPath);
    expect(stat.isFile()).toBe(true);
  });

  it("clean state shares without any warning", async () => {
    await ensureSavestateDir(repo);
    const state = buildState("clean", repo, { note: "totally normal note" });
    await atomicSaveState(repo, "clean", state, "");

    const outputPath = path.join(repo, "clean.savestate.json");
    const { stderr, stdout } = await execFileAsync(
      process.execPath,
      [CLI_ENTRY, "share", "clean", "-o", outputPath],
      { cwd: repo }
    );
    expect(stderr).not.toContain("Possible secrets detected");
    expect(stdout).toContain("Exported:");
  });

  it("blocks share when patch content contains a secret", async () => {
    await ensureSavestateDir(repo);
    // Synthetic patch body containing an AWS key. `share` reads
    // git-patch.diff off disk as a string and scans it — we don't need
    // the patch to be a valid diff for the scanner to fire.
    const patch =
      "diff --git a/.env b/.env\n" +
      "+++ b/.env\n" +
      "@@\n" +
      "+AWS_KEY=AKIAIOSFODNN7EXAMPLE\n";
    const state = buildState("patch-sec", repo, { note: "clean" });
    await atomicSaveState(repo, "patch-sec", state, patch);

    const outputPath = path.join(repo, "patchsec.savestate.json");
    let caught: any = null;
    try {
      await execFileAsync(
        process.execPath,
        [CLI_ENTRY, "share", "patch-sec", "-o", outputPath],
        { cwd: repo }
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe(1);
    const stderr = String(caught.stderr);
    expect(stderr).toContain("Possible secrets detected");
    expect(stderr).toContain("aws-access-key");
    expect(stderr).toContain("patch");
    // Redacted — no full secret anywhere.
    expect(stderr).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});
