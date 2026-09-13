#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(".");
const runtimeEntry = resolve(process.env.CODE_INSPECTION_RUNTIME_ENTRY ?? "packages/runtime/dist/cli.js");
const strict = process.env.STRICT_LANGUAGE_SMOKE === "1";
const protocols = process.env.LANGUAGE_SMOKE_PROTOCOLS === "1";
const smokeState = await mkdtemp(join(tmpdir(), "code-inspection-language-smoke-"));

const fixtures = [
  { smokeKey: "javascript", language: "javascript", clean: "eslint-clean", broken: "eslint-broken", check: "eslint", file: "broken.js" },
  { smokeKey: "typescript", language: "typescript", clean: "typescript-clean", broken: "typescript-broken", check: "typescript", file: "broken.ts" },
  { smokeKey: "python-ruff", language: "python", clean: "python-clean", broken: "python-broken", check: "ruff", file: "broken.py" },
  { smokeKey: "python-pyright", language: "python", clean: "python-pyright-clean", broken: "python-pyright-broken", check: "pyright", file: "broken.py" },
  { smokeKey: "go-vet", language: "go", clean: "go-clean", broken: "go-broken", check: "go-vet", file: "main.go" },
  { smokeKey: "go-lint", language: "go", clean: "go-lint-clean", broken: "go-lint-broken", check: "golangci-lint", file: "main.go" },
  { smokeKey: "rust", language: "rust", clean: "rust-clean", broken: "rust-broken", check: "cargo-check", file: "src/lib.rs" },
  { smokeKey: "java-build", language: "java", clean: "java-clean", broken: "java-broken", check: "java-build", file: "src/Broken.java" },
  { smokeKey: "java-checkstyle", language: "java", clean: "java-maven-checkstyle-clean", broken: "java-maven-checkstyle-broken", check: "checkstyle", file: "src/main/java/Main.java" },
  { smokeKey: "java-pmd", language: "java", clean: "java-gradle-pmd-clean", broken: "java-gradle-pmd-broken", check: "pmd", file: "src/main/java/Main.java" },
  { smokeKey: "c", language: "c", clean: "c-clean", broken: "c-broken", check: "clang-build", file: "main.c" },
  { smokeKey: "cpp", language: "cpp", clean: "cpp-clean", broken: "cpp-broken", check: "clang-build", file: "main.cpp" },
  { smokeKey: "c-clang-tidy", language: "c", clean: "c-clang-tidy-clean", broken: "c-clang-tidy-broken", check: "clang-tidy", file: "main.c" },
  { smokeKey: "cpp-clang-tidy", language: "cpp", clean: "cpp-clang-tidy-clean", broken: "cpp-clang-tidy-broken", check: "clang-tidy", file: "main.cpp" }
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run(command, args, env = {}) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

async function runCli(fixture, check, env) {
  const item = fixtures.find((candidate) => candidate.clean === fixture || candidate.broken === fixture);
  const fixturePath = resolve("tests/fixtures", fixture);
  const args = [runtimeEntry, "inspect", "--workspace", fixturePath, "--check", check, "--trust", "--json"];
  if (item?.file && existsSync(resolve(fixturePath, item.file))) args.push("--file", item.file);
  return await run(process.execPath, args, env);
}

function findingCount(result) {
  try {
    const runs = JSON.parse(result.stdout);
    return runs.reduce((total, run) => total + (run.summary?.errorCount ?? 0) + (run.summary?.warningCount ?? 0) + (run.summary?.infoCount ?? 0) + (run.summary?.hintCount ?? 0), 0);
  } catch {
    return 0;
  }
}

function failureText(result) {
  try {
    const runs = JSON.parse(result.stdout);
    const error = runs.find((run) => run.error)?.error;
    if (error) return `${error.code}: ${error.message}`;
    if (Array.isArray(runs) && runs.length > 0) return `run outcomes: ${runs.map((run) => `${run.checkId ?? "unknown"}=${run.outcome ?? "unknown"}`).join(", ")}`;
  } catch { /* keep the generic status below */ }
  if (result.stderr.trim()) return result.stderr.trim();
  return `exit ${result.code}`;
}

async function probe(command, args = ["--version"]) {
  let result;
  try {
    result = await run(command, args, { CODE_INSPECTION_DATA_DIR: smokeState });
  } catch (error) {
    if (strict) throw new Error(`Required tool ${command} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write(`SKIP tool ${command}: unavailable\n`);
    return false;
  }
  if (result.code !== 0) {
    if (strict) throw new Error(`Required tool ${command} is unavailable: ${result.stderr || result.stdout}`);
    process.stdout.write(`SKIP tool ${command}: ${result.stderr.trim() || "version probe failed"}\n`);
    return false;
  }
  const versionLine = (result.stdout || result.stderr)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !/^[-=]+$/.test(line));
  process.stdout.write(`TOOL ${command}: ${versionLine ?? "version available"}\n`);
  return true;
}

try {
  assert(existsSync(runtimeEntry), `Runtime CLI is missing: ${runtimeEntry}. Run npm run build first.`);
  for (const item of fixtures) {
    const cleanPath = resolve("tests/fixtures", item.clean);
    const brokenPath = resolve("tests/fixtures", item.broken);
    if (!existsSync(cleanPath) || !existsSync(brokenPath)) {
      if (strict) throw new Error(`Missing ${item.language} smoke fixture.`);
      process.stdout.write(`SKIP ${item.language}: fixture missing\n`);
      continue;
    }
    const fixtureState = join(smokeState, item.smokeKey);
    await mkdir(fixtureState, { recursive: true });
    const env = { CODE_INSPECTION_DATA_DIR: fixtureState, CODE_INSPECTION_IDLE_TIMEOUT_MS: "1000" };
    const clean = await runCli(item.clean, item.check, env);
    if (clean.code === 2) {
      if (strict) throw new Error(`${item.language} clean inspection failed: ${failureText(clean)}`);
      process.stdout.write(`SKIP ${item.language}: ${failureText(clean)}\n`);
      continue;
    }
    assert(clean.code === 0, `${item.language} clean fixture returned ${clean.code}: ${failureText(clean)}`);
    const broken = await runCli(item.broken, item.check, env);
    if (broken.code === 2) {
      if (strict) throw new Error(`${item.language} broken inspection failed: ${failureText(broken)}`);
      process.stdout.write(`SKIP ${item.language}: ${failureText(broken)}\n`);
      continue;
    }
    assert(broken.code === 1, `${item.language} broken fixture returned ${broken.code}: ${failureText(broken)}`);
    const count = findingCount(broken);
    assert(count > 0, `${item.language} broken fixture produced no findings.`);
    process.stdout.write(`PASS ${item.language}: clean=0, broken=${count}\n`);
    if (protocols) {
      const protocolEnv = {
        ...env,
        SMOKE_CHECK_ID: item.check,
        SMOKE_EXPECTED_FINDINGS: String(count),
        SMOKE_FILE: item.file,
        SMOKE_LANGUAGE_ID: item.language
      };
      const mcp = await run(process.execPath, [resolve("scripts/smoke-mcp.mjs"), brokenPath], protocolEnv);
      assert(mcp.code === 0, `${item.language} MCP smoke failed: ${mcp.stderr || mcp.stdout}`);
      const lsp = await run(process.execPath, [resolve("scripts/smoke-lsp.mjs"), brokenPath], protocolEnv);
      assert(lsp.code === 0, `${item.language} LSP smoke failed: ${lsp.stderr || lsp.stdout}`);
    }
  }
  for (const [tool, args] of [["ruff", ["--version"]], ["pyright", ["--version"]], ["go", ["version"]], ["golangci-lint", ["version"]], ["cargo", ["--version"]], ["javac", ["-version"]], ["mvn", ["--version"]], ["gradle", ["--version"]], ["clang", ["--version"]], ["clang-tidy", ["--version"]]]) await probe(tool, args);
  process.stdout.write(`Language smoke passed${strict ? " (strict)" : ""}.\n`);
} finally {
  await rm(smokeState, { recursive: true, force: true });
}
