import { mkdtemp, rm, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  InspectorRegistry,
  InspectionEngine,
  WorkspaceConfigSchema,
  getDiagnosticParser,
  isExcludedPath,
  languagesForFile,
  locateProject,
  locateProjects,
  disambiguateHeaderLanguage,
  matchesAnyPattern,
  projectMarkers,
  validatePatterns
} from "../src/index.js";

const context = { root: "/workspace", cwd: "/workspace" };

describe("language catalog and registry", () => {
  it("classifies all requested extensions and keeps headers ambiguous", () => {
    expect(languagesForFile("src/main.py")).toEqual(["python"]);
    expect(languagesForFile("src/Main.java")).toEqual(["java"]);
    expect(languagesForFile("src/main.go")).toEqual(["go"]);
    expect(languagesForFile("src/lib.rs")).toEqual(["rust"]);
    expect(languagesForFile("src/main.c")).toEqual(["c"]);
    expect(languagesForFile("src/main.cpp")).toEqual(["cpp"]);
    expect(languagesForFile("include/common.h")).toEqual(["c", "cpp"]);
  });

  it("validates configured adapters through the built-in registry", () => {
    const config = WorkspaceConfigSchema.parse({ version: 2, checks: {
      ruff: { adapter: "ruff", enabled: true, languages: ["python"], scope: "file", cwd: "." }
    } });
    const registry = new InspectorRegistry();
    expect(registry.enabled(config)[0]?.definition.displayName).toBe("Ruff");
    expect(() => registry.resolve(config, "missing")).toThrow("Unknown configured check");
  });

  it("requires a Python project marker before running Pyright", async () => {
    const root = await mkdtemp(join(tmpdir(), "inspection-pyright-config-"));
    try {
      const config = WorkspaceConfigSchema.parse({ version: 2, checks: {
        pyright: { adapter: "pyright", enabled: true, languages: ["python"], scope: "project", cwd: "." }
      } });
      await expect(new InspectionEngine({ root, config }).run({
        runId: "pyright-missing-config",
        checkId: "pyright",
        language: "python",
        projectRoot: root,
        scope: {},
        trigger: "cli",
        generation: 0
      })).rejects.toMatchObject({ code: "missing-configuration" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes project markers for each language", () => {
    expect(projectMarkers("python")).toContain("pyproject.toml");
    expect(projectMarkers("rust")).toContain("Cargo.toml");
  });
});

describe("diagnostic parsers", () => {
  it("normalizes Ruff JSON locations", () => {
    const diagnostics = getDiagnosticParser("ruff-json")(JSON.stringify([{
      filename: "src/错误.py",
      code: "F401",
      message: "unused import",
      location: { row: 2, column: 3 },
      end_location: { row: 2, column: 8 }
    }]), "", context);
    expect(diagnostics[0]).toMatchObject({ code: "F401", file: "src/错误.py", range: { start: { line: 1, character: 2 } } });
  });

  it("parses pretty-printed go vet JSON", () => {
    const diagnostics = getDiagnosticParser("go-json")(JSON.stringify({
      "example/module": { printf: [{ posn: "/workspace/main.go:4:9", end: "/workspace/main.go:4:12", message: "bad format" }] }
    }, null, 2), "", context);
    expect(diagnostics[0]).toMatchObject({ file: "/workspace/main.go", range: { start: { line: 3, character: 8 }, end: { line: 3, character: 11 } } });
  });

  it("parses concatenated go vet package documents", () => {
    const first = JSON.stringify({ first: { printf: [{ posn: "/workspace/one.go:2:3", message: "first" }] } }, null, 2);
    const second = JSON.stringify({ second: { printf: [{ posn: "/workspace/two.go:5:7", message: "second" }] } }, null, 2);
    const diagnostics = getDiagnosticParser("go-json")(`${first}\n${second}`, "", context);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((item) => item.file)).toEqual(["/workspace/one.go", "/workspace/two.go"]);
  });

  it("keeps Windows drive letters in compiler positions", () => {
    const diagnostics = getDiagnosticParser("go-json")(JSON.stringify({ pkg: { vet: [{ posn: "C:\\src\\main.go:4:9", message: "bad" }] } }), "", context);
    expect(diagnostics[0]?.file).toBe("C:\\src\\main.go");
  });

  it("parses Cargo JSON with related information", () => {
    const diagnostics = getDiagnosticParser("rust-json")(JSON.stringify({ reason: "compiler-message", message: {
      level: "error", message: "mismatch", code: { code: "E1" },
      spans: [{ file_name: "src/lib.rs", line_start: 2, column_start: 1, line_end: 2, column_end: 4, is_primary: true, label: "found" }]
    } }), "", context);
    expect(diagnostics[0]).toMatchObject({ code: "E1", file: "src/lib.rs", range: { start: { line: 1, character: 0 } } });
  });

  it("uses Rust byte offsets to preserve UTF-16 positions", async () => {
    const root = await mkdtemp(join(tmpdir(), "inspection-rust-unicode-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      const source = "fn main() { let 字 = 1; }\n";
      await writeFile(join(root, "src", "lib.rs"), source, "utf8");
      const start = Buffer.byteLength("fn main() { let ", "utf8");
      const end = start + Buffer.byteLength("字", "utf8");
      const diagnostics = getDiagnosticParser("rust-json")(JSON.stringify({ reason: "compiler-message", message: {
        level: "error", message: "bad", spans: [{ file_name: "src/lib.rs", line_start: 1, column_start: 18, line_end: 1, column_end: 19, byte_start: start, byte_end: end, is_primary: true, label: "bad" }]
      } }), "", { root, cwd: root });
      expect(diagnostics[0]?.range).toEqual({ start: { line: 0, character: 16 }, end: { line: 0, character: 17 } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses Java and Clang text diagnostics", () => {
    const java = getDiagnosticParser("text")("", "src/Main.java:7: error: incompatible types\n", context);
    const clang = getDiagnosticParser("clang-json")("", "main.c:3:4: warning: unused variable\n", context);
    expect(java[0]).toMatchObject({ file: "src/Main.java", severity: "error", range: { start: { line: 6, character: 0 } } });
    expect(clang[0]).toMatchObject({ file: "main.c", severity: "warning", range: { start: { line: 2, character: 3 } } });
  });

  it("parses Maven compiler diagnostics without retaining the log prefix", () => {
    const diagnostics = getDiagnosticParser("text")("", "[ERROR] /workspace/src/Main.java:[3,4] incompatible types: String cannot be converted to int\n", context);
    expect(diagnostics[0]).toMatchObject({
      file: "/workspace/src/Main.java",
      severity: "error",
      message: "incompatible types: String cannot be converted to int",
      range: { start: { line: 2, character: 3 }, end: { line: 2, character: 4 } }
    });
  });

  it("parses Checkstyle XML and SARIF", () => {
    const checkstyle = getDiagnosticParser("checkstyle-xml")("<checkstyle><file name=\"src/Main.java\"><error line=\"3\" column=\"2\" severity=\"warning\" message=\"bad\" source=\"Style\"/></file></checkstyle>", "", context);
    const sarif = getDiagnosticParser("sarif-json")(JSON.stringify({ runs: [{ results: [{ ruleId: "R1", level: "error", message: { text: "bad" }, locations: [{ physicalLocation: { artifactLocation: { uri: "main.go" }, region: { startLine: 2, startColumn: 1 } } }] }] }] }), "", context);
    expect(checkstyle[0]).toMatchObject({ code: "Style", severity: "warning", range: { start: { line: 2, character: 1 } } });
    expect(sarif[0]).toMatchObject({ code: "R1", file: "main.go", range: { start: { line: 1, character: 0 } } });
  });

  it("parses canonical Clang JSON diagnostics", () => {
    const diagnostics = getDiagnosticParser("clang-json")(JSON.stringify([{
      level: "error",
      message: "use of undeclared identifier",
      locations: [{ caret: { file: "main.cpp", line: 3, column: 4 } }],
      ranges: [{ start: { line: 3, column: 4 }, end: { line: 3, column: 9 } }]
    }]), "", context);
    expect(diagnostics[0]).toMatchObject({ file: "main.cpp", severity: "error", range: { start: { line: 2, character: 3 }, end: { line: 2, character: 8 } } });
  });

  it("does not assign an ambiguous header to C or C++ without evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "inspection-header-language-"));
    try {
      await writeFile(join(root, "main.h"), "int value;\n", "utf8");
      const config = WorkspaceConfigSchema.parse({ version: 2, checks: {
        "clang-build": {
          adapter: "clang-build", enabled: true, languages: ["c", "cpp"], scope: "workspace", cwd: ".",
          command: [process.execPath, "-e", "process.stdout.write(JSON.stringify([{file:'main.h',line:1,column:1,message:'header issue'}]))"],
          parser: "clang-json"
        }
      } });
      const output = await new InspectionEngine({ root, config }).run({
        runId: "ambiguous-header", checkId: "clang-build", projectRoot: root, scope: {}, trigger: "cli", generation: 0
      });
      expect(output.findings[0]?.language).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses modern golangci JSON and NDJSON issue shapes", () => {
    const modern = getDiagnosticParser("golangci-json")(JSON.stringify({ issues: [{
      text: "unchecked error", fromLinter: "errcheck", severity: "warning",
      pos: { relativePath: "main.go", line: 2, column: 4 }
    }] }), "", context);
    const ndjson = getDiagnosticParser("golangci-json")('{"Issue":{"Text":"another","FromLinter":"govet","Pos":{"Filename":"main.go","Line":3,"Column":2}}}\n', "", context);
    expect(modern[0]).toMatchObject({ code: "errcheck", file: "main.go", severity: "warning", range: { start: { line: 1 } } });
    expect(ndjson[0]).toMatchObject({ code: "govet", file: "main.go", range: { start: { line: 2, character: 1 } } });
  });

  it("parses PMD XML and percent-encoded SARIF locations", () => {
    const pmd = getDiagnosticParser("pmd-json")('<pmd><file name="src/Main.java"><violation beginline="4" begincolumn="3" rule="AvoidFoo">avoid foo</violation></file></pmd>', "", context);
    const sarif = getDiagnosticParser("sarif-json")(JSON.stringify({ runs: [{ originalUriBaseIds: { SRC: { uri: "file:///workspace/src/" } }, results: [{ ruleId: "R2", message: { text: "bad" }, locations: [{ physicalLocation: { artifactLocation: { uri: "Main%20File.go", uriBaseId: "SRC" }, region: { startLine: 1, startColumn: 2 } } }] }] }] }), "", context);
    expect(pmd[0]).toMatchObject({ code: "AvoidFoo", message: "avoid foo", range: { start: { line: 3, character: 2 } } });
    expect(sarif[0]).toMatchObject({ file: "/workspace/src/Main File.go", range: { start: { line: 0, character: 1 } } });
  });
});

describe("matching and project discovery", () => {
  it("matches nested paths and rejects malformed globs", () => {
    expect(matchesAnyPattern("src/pkg/main.py", ["**/*.py"])).toBe(true);
    expect(isExcludedPath("/workspace", "/workspace/node_modules/pkg/index.py", ["**/node_modules/**"])).toBe(true);
    expect(isExcludedPath("/workspace", "/workspace/src/main.py", ["**/node_modules/**"])).toBe(false);
    expect(() => validatePatterns(["["])).toThrow("Invalid glob pattern");
  });

  it("matches files through a workspace symlink alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "inspection-match-alias-"));
    const alias = `${root}-alias`;
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "main.go"), "package main\n", "utf8");
      await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
      expect(isExcludedPath(root, join(alias, "src", "main.go"), ["**/node_modules/**"])).toBe(false);
    } finally {
      await rm(alias, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers nested projects and uses compile commands to classify headers", async () => {
    const root = await mkdtemp(join(tmpdir(), "inspection-projects-"));
    try {
      await mkdir(join(root, "packages", "one"), { recursive: true });
      await mkdir(join(root, "packages", "two"), { recursive: true });
      await writeFile(join(root, "packages", "one", "pyproject.toml"), "[project]\nname='one'\n");
      await writeFile(join(root, "packages", "two", "go.mod"), "module example.com/two\n");
      const pythonProjects = locateProjects(root, "python");
      expect(pythonProjects).toHaveLength(1);
      expect(pythonProjects[0]?.root.endsWith("packages/one")).toBe(true);
      expect(locateProject(root, "go", "packages/two/main.go").root.endsWith("packages/two")).toBe(true);
      await writeFile(join(root, "compile_commands.json"), JSON.stringify([
        { directory: ".", file: "src/main.c", command: "clang -c src/main.c" },
        { directory: ".", file: "src/main.cpp", command: "clang++ -c src/main.cpp" },
        { directory: ".", file: "include/common.h", command: "clang++ -x c++-header -c include/common.h" }
      ]));
      expect(disambiguateHeaderLanguage(root, "include/common.h", ["c", "cpp"])).toBe("cpp");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads Java report files after a non-zero Checkstyle/PMD command", async () => {
    const root = await mkdtemp(join(tmpdir(), "inspection-java-reports-"));
    try {
      await mkdir(join(root, "target"), { recursive: true });
      const run = async (checkId: "checkstyle" | "pmd", report: string, parser: string) => {
        const config = WorkspaceConfigSchema.parse({ version: 2, checks: {
          [checkId]: {
            adapter: checkId,
            enabled: true,
            languages: ["java"],
            scope: "project",
            cwd: ".",
            command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(checkId === "checkstyle" ? "target/checkstyle-result.xml" : "target/pmd.xml")}, ${JSON.stringify(report)}); process.exit(1)`],
            parser
          }
        } });
        return new InspectionEngine({ root, config }).run({ runId: checkId, checkId, language: "java", projectRoot: root, scope: {}, trigger: "cli", generation: 0 });
      };
      const checkstyle = await run("checkstyle", '<checkstyle><file name="src/Main.java"><error line="2" column="4" severity="warning" message="avoid" source="Style"/></file></checkstyle>', "checkstyle-xml");
      expect(checkstyle.findings[0]).toMatchObject({ code: "Style", severity: "warning", language: "java" });
      const pmd = await run("pmd", '<pmd><file name="src/Main.java"><violation beginline="3" begincolumn="2" priority="2" rule="Rule">bad</violation></file></pmd>', "pmd-json");
      expect(pmd.findings[0]).toMatchObject({ code: "Rule", severity: "error", range: { start: { line: 2, character: 1 } } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes Maven compiler text emitted on stderr", async () => {
    const root = await mkdtemp(join(tmpdir(), "inspection-maven-text-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "Main.java"), "class Main { int value = \"bad\"; }\n", "utf8");
      const config = WorkspaceConfigSchema.parse({ version: 2, checks: {
        "java-build": {
          adapter: "java-build", enabled: true, languages: ["java"], scope: "project", cwd: ".",
          command: [process.execPath, "-e", "process.stderr.write('[ERROR] ' + process.cwd() + '/src/Main.java:[1,25] incompatible types\\n'); process.exit(1)"],
          parser: "text"
        }
      } });
      const output = await new InspectionEngine({ root, config }).run({ runId: "maven-text", checkId: "java-build", language: "java", projectRoot: root, scope: {}, trigger: "cli", generation: 0 });
      expect(output.findings[0]).toMatchObject({ file: expect.stringContaining("src/Main.java"), severity: "error", language: "java" });
      expect(output.findings[0]?.range?.start).toEqual({ line: 0, character: 24 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
