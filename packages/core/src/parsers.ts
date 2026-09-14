import { XMLParser } from "fast-xml-parser";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";
import type { FindingSeverity, Position, Range, RawDiagnostic } from "./types.js";
import { diagnosticKey } from "./findings.js";

export interface ParserContext {
  root: string;
  cwd: string;
}

type ToolColumnEncoding = "utf8" | "codepoint" | "utf16";

export type DiagnosticParser = (stdout: string, stderr: string, context: ParserContext) => RawDiagnostic[];

export const DIAGNOSTIC_PARSER_IDS = [
  "build",
  "text",
  "ruff-json",
  "pyright-json",
  "go-json",
  "golangci-json",
  "rust-json",
  "checkstyle-xml",
  "pmd-json",
  "sarif-json",
  "clang-json"
] as const;
export type DiagnosticParserId = (typeof DIAGNOSTIC_PARSER_IDS)[number];

export const diagnosticParsers: ReadonlyMap<DiagnosticParserId, DiagnosticParser> = new Map([
  ["build", parseBuild],
  ["text", parseText],
  ["ruff-json", parseRuffJson],
  ["pyright-json", parsePyrightJson],
  ["go-json", parseGoJson],
  ["golangci-json", parseGolangciJson],
  ["rust-json", parseRustJson],
  ["checkstyle-xml", parseCheckstyleXml],
  ["pmd-json", parsePmdJson],
  ["sarif-json", parseSarifJson],
  ["clang-json", parseClangJson]
]);

export function getDiagnosticParser(id: string | undefined): DiagnosticParser {
  const parser = diagnosticParsers.get((id ?? "text") as DiagnosticParserId);
  if (!parser) throw new Error("Unknown diagnostic parser: " + id);
  return parser;
}

function parseBuild(stdout: string, stderr: string, context: ParserContext): RawDiagnostic[] {
  return parseText(stdout + (stdout && stderr ? "\n" : "") + stderr, "", context);
}

function parseText(stdout: string, stderr: string, context: ParserContext, encoding: ToolColumnEncoding = "utf16"): RawDiagnostic[] {
  const values: RawDiagnostic[] = [];
  for (const line of (stdout + (stdout && stderr ? "\n" : "") + stderr).split(/\r?\n/)) {
    const diagnostic = parseTextLine(line, context, encoding);
    if (diagnostic) values.push(diagnostic);
  }
  return values;
}

function parseTextLine(line: string, context: ParserContext, encoding: ToolColumnEncoding = "utf16"): RawDiagnostic | undefined {
  const raw = line.trim();
  const prefix = toolLogPrefix(raw);
  const trimmed = prefix.text;
  if (!trimmed) return undefined;
  // javac may localize the severity label (for example, "错误"/"警告").
  const javaMatch = /^(.*?\.java):(\d+)(?::(\d+))?:\s*(?:(error|warning|fatal error|错误|警告|致命错误)\s*:?[ ]*)?(.*)$/i.exec(trimmed);
  if (javaMatch) {
    const file = javaMatch[1]?.trim();
    const lineNumber = Number(javaMatch[2]);
    const columnNumber = javaMatch[3] ? Number(javaMatch[3]) : 1;
    const severity = severityFromText(javaMatch[4]) ?? prefix.severity ?? (javaMatch[4] === "警告" ? "warning" : "error");
    const message = javaMatch[5]?.trim() ?? "";
    if (file && Number.isFinite(lineNumber) && message) {
      return { message, severity, file, range: rangeFromToolPosition(file, lineNumber, columnNumber, lineNumber, columnNumber + 1, encoding, context) };
    }
  }
  let match = /^(.*?)(?:\((\d+),(\d+)\)|:(\d+):(\d+)(?::(\d+))?):\s*(?:(error|warning|fatal error|note|info|hint)\b\s*:?[ ]*)?(.*)$/i.exec(trimmed);
  if (match) {
    const file = match[1]?.trim();
    const lineNumber = Number(match[2] ?? match[4]);
    const columnNumber = Number(match[3] ?? match[5]);
    const endColumn = match[6] ? Number(match[6]) : undefined;
    const severity = severityFromText(match[7]) ?? prefix.severity;
    const message = match[8]?.trim() ?? "";
    const sourceLike = hasSourceExtension(file ?? "");
    const informational = severity === "info" || severity === "hint";
    if (file && Number.isFinite(lineNumber) && Number.isFinite(columnNumber) && (sourceLike || (severity && !informational))) {
      return { message: message || trimmed, severity: severity ?? "error", file, range: rangeFromToolPosition(file, lineNumber, columnNumber, lineNumber, endColumn ?? columnNumber + 1, encoding, context) };
    }
  }
  match = /^(.*?\.java):\[(\d+),(\d+)\]\s*(.*)$/i.exec(trimmed);
  if (match) {
    const file = match[1] ?? "";
    const lineNumber = Number(match[2]);
    const columnNumber = Number(match[3]);
    const message = match[4]?.trim() || trimmed;
    return { message, severity: prefix.severity ?? "error", file, range: rangeFromToolPosition(file, lineNumber, columnNumber, lineNumber, columnNumber + 1, encoding, context) };
  }
  return undefined;
}

/** Remove only well-known build-tool log prefixes; bracketed paths remain intact. */
function toolLogPrefix(value: string): { text: string; severity?: FindingSeverity } {
  const match = /^(?:\[(error|warning|warn|info|hint|note|fatal error)\]\s*)+/i.exec(value);
  if (!match) return { text: value };
  const label = match[1];
  const severity = severityFromText(label);
  return severity
    ? { text: value.slice(match[0].length).trim(), severity }
    : { text: value.slice(match[0].length).trim() };
}

function parseRuffJson(stdout: string, _stderr: string, context: ParserContext): RawDiagnostic[] {
  if (!stdout.trim()) return [];
  const value = parseJson(stdout, "Ruff");
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (!isRecord(item)) return [];
    const location = isRecord(item.location) ? item.location : {};
    const end = isRecord(item.end_location) ? item.end_location : location;
    const filename = asString(item.filename);
    const message = asString(item.message);
    if (!filename || !message) return [];
    return [{
      message,
      severity: "error" as const,
      code: asString(item.code),
      file: filename,
      range: rangeFromToolPosition(filename, asNumber(location.row) ?? 1, asNumber(location.column) ?? 1, asNumber(end.row) ?? asNumber(location.row) ?? 1, asNumber(end.column) ?? (asNumber(location.column) ?? 1) + 1, "codepoint", context)
    }];
  });
}

function parsePyrightJson(stdout: string, _stderr: string, _context: ParserContext): RawDiagnostic[] {
  if (!stdout.trim()) return [];
  const value = parseJson(stdout, "Pyright");
  if (!isRecord(value) || !Array.isArray(value.generalDiagnostics)) return [];
  return value.generalDiagnostics.flatMap((item: unknown) => {
    if (!isRecord(item)) return [];
    const range = isRecord(item.range) ? item.range : undefined;
    const start = range && isRecord(range.start) ? range.start : undefined;
    const end = range && isRecord(range.end) ? range.end : start;
    const file = asString(item.file);
    const message = asString(item.message);
    if (!file || !message) return [];
    return [{
      message,
      severity: severityFromText(asString(item.severity)) ?? "error",
      code: asString(item.rule),
      file,
      range: start ? rangeFromZeroBased(asNumber(start.line) ?? 0, asNumber(start.character) ?? 0, asNumber(end?.line) ?? asNumber(start.line) ?? 0, asNumber(end?.character) ?? (asNumber(start.character) ?? 0) + 1) : undefined
    }];
  });
}

function parseGoJson(stdout: string, stderr: string, context: ParserContext): RawDiagnostic[] {
  const values: RawDiagnostic[] = [];
  // `go vet -json` emits one pretty-printed JSON object per package. Parse the
  // complete streams first, including concatenated package documents. Go
  // versions have written this structured output to both stdout and stderr;
  // line-delimited JSON is also used by some wrappers.
  for (const stream of [stdout, stderr]) {
    for (const parsed of parseJsonDocuments(stream)) walkGoValue(parsed, values, context);
  }
  if (values.length > 0) return dedupeDiagnostics(values);
  const combined = stdout + (stdout && stderr ? "\n" : "") + stderr;
  for (const line of combined.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      walkGoValue(JSON.parse(line) as unknown, values, context);
    } catch {
      const diagnostic = parseTextLine(line, context, "utf8");
      if (diagnostic) values.push(diagnostic);
    }
  }
  if (values.length === 0) values.push(...parseText(stdout, stderr, context, "utf8"));
  return dedupeDiagnostics(values);
}

function walkGoValue(value: unknown, values: RawDiagnostic[], context: ParserContext): void {
  if (Array.isArray(value)) {
    for (const item of value) walkGoValue(item, values, context);
    return;
  }
  if (!isRecord(value)) return;
  if (Array.isArray(value.Issues)) {
    for (const issue of value.Issues) walkGoValue(issue, values, context);
  }
  const position = isRecord(value.Pos) ? value.Pos : isRecord(value.Position) ? value.Position : undefined;
  const posn = asString(value.posn) ?? asString(value.Posn) ?? asString(value.position) ?? asString(value.Position);
  const message = asString(value.message) ?? asString(value.Message) ?? asString(value.Text);
  if (message && position) {
    const file = asString(position.Filename) ?? asString(position.file);
    const line = asNumber(position.Line) ?? asNumber(position.line);
    const column = asNumber(position.Column) ?? asNumber(position.column);
    if (file && line) values.push({ message, severity: severityFromText(asString(value.Severity)) ?? "error", code: asString(value.Code) ?? asString(value.code), file, range: rangeFromToolPosition(file, line, column ?? 1, line, (column ?? 1) + 1, "utf8", context) });
  } else if (message && posn) {
    const parsed = parsePositionString(posn, context, "utf8");
    if (parsed) {
      const end = parsePositionString(asString(value.end) ?? "", context, "utf8");
      values.push({ message, severity: severityFromText(asString(value.Severity) ?? asString(value.severity)) ?? "error", file: parsed.file, range: end ? { start: parsed.range.start, end: end.range.start } : parsed.range });
    }
  } else if (message && asString(value.file) && asNumber(value.line)) {
    const line = asNumber(value.line) ?? 1;
    const column = asNumber(value.column) ?? 1;
    const file = asString(value.file);
    if (file) values.push({ message, severity: severityFromText(asString(value.severity)) ?? "error", code: asString(value.code), file, range: rangeFromToolPosition(file, line, column, line, column + 1, "utf8", context) });
  }
  for (const [key, child] of Object.entries(value)) {
    if (!["Issues", "Pos", "posn", "Posn", "position", "Position", "message", "Message", "Text", "file", "line", "column", "severity", "Severity", "code", "Code"].includes(key)) walkGoValue(child, values, context);
  }
}

function parseGolangciJson(stdout: string, stderr: string, context: ParserContext): RawDiagnostic[] {
  const text = stdout.trim() || stderr.trim();
  if (!text) return [];
  const values: RawDiagnostic[] = [];
  // golangci-lint has emitted both one JSON document and NDJSON over its
  // supported releases. Parse either form and retain the text fallback for
  // wrappers that prepend human-readable log lines.
  for (const document of parseJsonDocuments(text)) collectGolangciIssues(document, values, context);
  if (values.length === 0) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { collectGolangciIssues(JSON.parse(line) as unknown, values, context); } catch { /* try the text parser below */ }
    }
  }
  if (values.length > 0) return dedupeDiagnostics(values);
  return parseText(stdout, stderr, context, "utf8");
}

function collectGolangciIssues(value: unknown, values: RawDiagnostic[], context: ParserContext): void {
  if (Array.isArray(value)) {
    for (const item of value) collectGolangciIssues(item, values, context);
    return;
  }
  if (!isRecord(value)) return;
  // v1/v2 use different casing and, in some wrappers, an `issue` singular
  // field. Handle all known spellings without depending on a specific release.
  const issues = value.Issues ?? value.issues ?? value.Issue ?? value.issue;
  if (issues !== undefined) {
    collectGolangciIssues(issues, values, context);
    return;
  }
  const position = isRecord(value.Pos) ? value.Pos : isRecord(value.pos) ? value.pos : isRecord(value.Position) ? value.Position : isRecord(value.position) ? value.position : {};
  const file = asString(position.Filename) ?? asString(position.filename) ?? asString(position.RelativePath) ?? asString(position.relativePath) ?? asString(value.File) ?? asString(value.file);
  const line = asNumber(position.Line) ?? asNumber(position.line) ?? asNumber(value.Line) ?? asNumber(value.line);
  const column = asNumber(position.Column) ?? asNumber(position.column) ?? asNumber(value.Column) ?? asNumber(value.column);
  const message = asString(value.Text) ?? asString(value.text) ?? asString(value.Message) ?? asString(value.message);
  if (file && line && message) {
    values.push({
      message,
      severity: severityFromText(asString(value.Severity) ?? asString(value.severity)) ?? "error",
      code: asString(value.FromLinter) ?? asString(value.fromLinter) ?? asString(value.Code) ?? asString(value.code),
      file,
      range: rangeFromToolPosition(file, line, column ?? 1, line, (column ?? 1) + 1, "utf8", context)
    });
  }
}

function parseRustJson(stdout: string, stderr: string, context: ParserContext): RawDiagnostic[] {
  const values: RawDiagnostic[] = [];
  const collect = (value: unknown): void => {
    if (!isRecord(value) || value.reason !== "compiler-message" || !isRecord(value.message)) return;
    const message = value.message;
    const spans = Array.isArray(message.spans) ? message.spans.filter(isRecord) : [];
    const primary = spans.find((span) => span.is_primary === true) ?? spans[0];
    const text = asString(message.message) ?? asString(message.rendered);
    if (!primary || !text) return;
    const related = spans.slice(1).flatMap((span) => {
      const file = asString(span.file_name);
      const label = asString(span.label);
      if (!file || !label) return [];
      return [{ message: label, file, range: rustSpanRange(file, span, context) }];
    });
    const primaryFile = asString(primary.file_name);
    values.push({ message: stripAnsi(text), severity: severityFromText(asString(message.level)) ?? "error", code: isRecord(message.code) ? asString(message.code.code) : undefined, file: primaryFile, range: primaryFile ? rustSpanRange(primaryFile, primary, context) : undefined, relatedInformation: related });
  };
  // A wrapper may pretty-print or concatenate Cargo JSON documents even though
  // Cargo itself normally emits one object per line.
  for (const value of parseJsonDocuments(stdout)) collect(value);
  if (values.length === 0) {
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { collect(JSON.parse(line) as unknown); } catch { /* Ignore progress/text lines. */ }
    }
  }
  return values.length > 0 ? dedupeDiagnostics(values) : parseText(stdout, stderr, context, "utf8");
}

function parseCheckstyleXml(stdout: string, _stderr: string, _context: ParserContext): RawDiagnostic[] {
  if (!stdout.trim()) return [];
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" }).parse(stdout) as unknown;
  const root = isRecord(parsed) && isRecord(parsed.checkstyle) ? parsed.checkstyle : parsed;
  const files = root && isRecord(root) ? asArray(root.file) : [];
  const values: RawDiagnostic[] = [];
  for (const fileNode of files) {
    if (!isRecord(fileNode)) continue;
    const file = asString(fileNode.name);
    for (const errorNode of asArray(fileNode.error)) {
      if (!isRecord(errorNode)) continue;
      const line = asNumber(errorNode.line);
      const column = asNumber(errorNode.column);
      const message = asString(errorNode.message);
      if (!file || !line || !message) continue;
      values.push({ message, severity: severityFromText(asString(errorNode.severity)) ?? "warning", code: asString(errorNode.source) ?? asString(errorNode.id), file, range: lineRange(line, column) });
    }
  }
  return values;
}

function parsePmdJson(stdout: string, _stderr: string, _context: ParserContext): RawDiagnostic[] {
  if (stdout.trim().startsWith("<")) return parsePmdXml(stdout);
  const value = parseJson(stdout, "PMD");
  const roots = Array.isArray(value) ? value : [value];
  const values: RawDiagnostic[] = [];
  for (const root of roots) {
    if (!isRecord(root)) continue;
    const fileNodes = asArray(root.files).length > 0 ? asArray(root.files) : (root.filename ? [root] : []);
    for (const fileNode of fileNodes) {
      if (!isRecord(fileNode)) continue;
      const file = asString(fileNode.filename);
      for (const violation of asArray(fileNode.violations)) {
        if (!isRecord(violation)) continue;
        const line = asNumber(violation.beginline);
        const column = asNumber(violation.begincolumn);
        const message = asString(violation.description) ?? asString(violation.message);
        if (!file || !line || !message) continue;
        const priority = asNumber(violation.priority) ?? 3;
        values.push({ message, severity: priority <= 2 ? "error" : priority === 3 ? "warning" : "info", code: asString(violation.rule), file, range: lineRange(line, column) });
      }
    }
  }
  return values;
}

function parsePmdXml(stdout: string): RawDiagnostic[] {
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" }).parse(stdout) as unknown;
  const root = isRecord(parsed) && isRecord(parsed.pmd) ? parsed.pmd : parsed;
  const values: RawDiagnostic[] = [];
  for (const fileNode of asArray(root && isRecord(root) ? root.file : undefined)) {
    if (!isRecord(fileNode)) continue;
    const file = asString(fileNode.name);
    for (const violation of asArray(fileNode.violation)) {
      if (!isRecord(violation)) continue;
      const line = asNumber(violation.beginline);
      const column = asNumber(violation.begincolumn);
      const message = asString(violation["#text"]) ?? asString(violation.description) ?? asString(violation.message);
      if (!file || !line || !message) continue;
      const priority = asNumber(violation.priority) ?? 3;
      values.push({ message, severity: priority <= 2 ? "error" : priority === 3 ? "warning" : "info", code: asString(violation.rule), file, range: lineRange(line, column) });
    }
  }
  return values;
}

function parseSarifJson(stdout: string, _stderr: string, _context: ParserContext): RawDiagnostic[] {
  if (!stdout.trim()) return [];
  const value = parseJson(stdout, "SARIF");
  if (!isRecord(value)) return [];
  const values: RawDiagnostic[] = [];
  for (const run of asArray(value.runs)) {
    if (!isRecord(run)) continue;
    const bases = isRecord(run.originalUriBaseIds) ? run.originalUriBaseIds : {};
    for (const result of asArray(run.results)) {
      if (!isRecord(result)) continue;
      const location = asArray(result.locations)[0];
      const physical = isRecord(location) && isRecord(location.physicalLocation) ? location.physicalLocation : undefined;
      const artifact = physical && isRecord(physical.artifactLocation) ? physical.artifactLocation : undefined;
      const region = physical && isRecord(physical.region) ? physical.region : undefined;
      const file = artifact ? sarifArtifactPath(artifact, bases) : undefined;
      const messageNode = isRecord(result.message) ? result.message : undefined;
      const message = messageNode ? asString(messageNode.text) ?? asString(messageNode.markdown) : undefined;
      if (!file || !message) continue;
      const line = asNumber(region?.startLine) ?? 1;
      const column = asNumber(region?.startColumn) ?? 1;
      values.push({ message, severity: severityFromText(asString(result.level)) ?? "warning", code: asString(result.ruleId), file, range: rangeFromOneBased(line, column, asNumber(region?.endLine) ?? line, asNumber(region?.endColumn) ?? column + 1) });
    }
  }
  return values;
}

function parseClangJson(stdout: string, stderr: string, context: ParserContext): RawDiagnostic[] {
  const values: RawDiagnostic[] = [];
  for (const text of [stdout.trim(), stderr.trim()]) {
    if (!text) continue;
    for (const document of parseJsonDocuments(text)) {
      if (Array.isArray(document)) values.push(...document.flatMap((item) => clangItem(item, context)));
      else if (isRecord(document) && Array.isArray(document.diagnostics)) values.push(...document.diagnostics.flatMap((item) => clangItem(item, context)));
    }
    if (values.length > 0) continue;
    try {
      const value = JSON.parse(text) as unknown;
      if (Array.isArray(value)) values.push(...value.flatMap((item) => clangItem(item, context)));
      else if (isRecord(value) && Array.isArray(value.diagnostics)) values.push(...value.diagnostics.flatMap((item) => clangItem(item, context)));
    } catch {
      // Fall back to the compiler's traditional diagnostic format.
    }
  }
  return values.length > 0 ? dedupeDiagnostics(values) : parseText(stdout, stderr, context, "utf8");
}

function clangItem(value: unknown, context: ParserContext): RawDiagnostic[] {
  if (!isRecord(value)) return [];
  const locations = asArray(value.locations ?? value.location).filter(isRecord);
  const firstLocation = locations[0];
  const caret = firstLocation && isRecord(firstLocation.caret) ? firstLocation.caret : firstLocation;
  const file = asString(value.file) ?? asString(value.filename) ?? (caret ? asString(caret.file) ?? asString(caret.filename) : undefined);
  const line = asNumber(value.line) ?? (caret ? asNumber(caret.line) : undefined);
  const column = asNumber(value.column) ?? (caret ? asNumber(caret.column) : undefined);
  const message = asString(value.message) ?? asString(value.text);
  if (!file || !line || !message) return [];
  const ranges = asArray(value.ranges).filter(isRecord);
  const firstRange = ranges[0];
  const start = firstRange && isRecord(firstRange.start) ? firstRange.start : undefined;
  const end = firstRange && isRecord(firstRange.end) ? firstRange.end : undefined;
  const startLine = start ? asNumber(start.line) ?? line : line;
  const startColumn = start ? asNumber(start.column) ?? column ?? 1 : column ?? 1;
  const endLine = end ? asNumber(end.line) ?? startLine : startLine;
  const endColumn = end ? asNumber(end.column) ?? startColumn + 1 : startColumn + 1;
  return [{ message, severity: severityFromText(asString(value.severity) ?? asString(value.level) ?? asString(value.kind)) ?? "error", code: asString(value.code), file, range: rangeFromToolPosition(file, startLine, startColumn, endLine, endColumn, "utf8", context) }];
}

function sarifArtifactPath(artifact: Record<string, unknown>, bases: Record<string, unknown>): string | undefined {
  const uri = asString(artifact.uri);
  if (!uri) return undefined;
  let decoded = decodeUri(uri);
  const baseId = asString(artifact.uriBaseId);
  if (baseId) {
    const base = bases[baseId];
    const baseUri = isRecord(base) ? asString(base.uri) : undefined;
    if (baseUri) {
      const decodedBase = decodeUri(baseUri);
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(decodedBase) || decodedBase.startsWith("file:")) {
        try { decoded = new URL(decoded, decodedBase).href; } catch { decoded = decodedBase.replace(/\/$/, "") + "/" + decoded.replace(/^\//, ""); }
      } else {
        decoded = join(decodedBase, decoded);
      }
    }
  }
  if (decoded.startsWith("file:")) {
    try { return fileUrlPath(decoded); } catch { /* keep the URI when it is not a valid file URL */ }
  }
  return decoded;
}

function fileUrlPath(value: string): string {
  const url = new URL(value);
  try {
    return fileURLToPath(url);
  } catch (error) {
    // Windows rejects absolute POSIX file URLs even though they are valid
    // SARIF emitted by tools running in containers or remote environments.
    if (url.protocol === "file:" && !url.hostname && url.pathname.startsWith("/")) return decodeUri(url.pathname);
    throw error;
  }
}

function decodeUri(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function parseJson(text: string, name: string): unknown {
  try {
    return JSON.parse(text || "null") as unknown;
  } catch (error) {
    throw new Error(name + " returned invalid JSON: " + (error instanceof Error ? error.message : String(error)));
  }
}

/** Parse one or more balanced JSON objects/arrays from a tool stream. */
function parseJsonDocuments(text: string): unknown[] {
  const documents: unknown[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (start < 0) {
      if (character === "{" || character === "[") {
        start = index;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) {
        try { documents.push(JSON.parse(text.slice(start, index + 1)) as unknown); } catch { /* Ignore malformed fragments and continue scanning. */ }
        start = -1;
      } else if (depth < 0) {
        start = -1;
        depth = 0;
      }
    }
  }
  return documents;
}

function parsePositionString(value: string, context?: ParserContext, encoding: ToolColumnEncoding = "utf16"): { file: string; range: Range } | undefined {
  // Greedy file capture keeps Windows drive letters (for example
  // `C:\\src\\main.go:4:9`) in the filename.
  const match = /^(.*):(\d+):(\d+)$/.exec(value.trim());
  if (!match) return undefined;
  const line = Number(match[2]);
  const column = Number(match[3]);
  const file = match[1] ?? value;
  return { file, range: context ? rangeFromToolPosition(file, line, column, line, column + 1, encoding, context) : lineRange(line, column) };
}

function rangeFromToolPosition(file: string, startLine: number, startColumn: number, endLine: number, endColumn: number, encoding: ToolColumnEncoding, context: ParserContext): Range {
  return {
    start: toolPosition(file, startLine, startColumn, encoding, context),
    end: toolPosition(file, endLine, endColumn, encoding, context)
  };
}

/** Rust exposes byte offsets for exact spans; prefer them over display columns. */
function rustSpanRange(file: string, span: Record<string, unknown>, context: ParserContext): Range {
  const byteStart = asNumber(span.byte_start);
  const byteEnd = asNumber(span.byte_end);
  if (byteStart !== undefined && byteEnd !== undefined) {
    const source = sourceText(file, context);
    if (source !== undefined) {
      return { start: positionFromUtf8Offset(source, byteStart), end: positionFromUtf8Offset(source, byteEnd) };
    }
  }
  const lineStart = asNumber(span.line_start) ?? 1;
  const columnStart = asNumber(span.column_start) ?? 1;
  const lineEnd = asNumber(span.line_end) ?? lineStart;
  const columnEnd = asNumber(span.column_end) ?? columnStart + 1;
  // rustc's display columns count Unicode scalar values, rather than UTF-8
  // bytes, when byte offsets are unavailable.
  return rangeFromToolPosition(file, lineStart, columnStart, lineEnd, columnEnd, "codepoint", context);
}

function toolPosition(file: string, line: number, column: number, encoding: ToolColumnEncoding, context: ParserContext): Position {
  const zeroLine = Math.max(0, line - 1);
  const zeroColumn = Math.max(0, column - 1);
  if (encoding === "utf16") return { line: zeroLine, character: zeroColumn };
  const source = sourceLine(file, zeroLine, context);
  if (source === undefined) return { line: zeroLine, character: zeroColumn };
  if (encoding === "codepoint") {
    return { line: zeroLine, character: Array.from(source).slice(0, zeroColumn).join("").length };
  }
  // Go/Rust/Clang generally report UTF-8 byte columns. Truncating a buffer at
  // the reported byte offset gives the corresponding UTF-16 code-unit count.
  let consumedBytes = 0;
  let consumedUtf16 = 0;
  for (const character of source) {
    const width = Buffer.byteLength(character, "utf8");
    if (consumedBytes + width > zeroColumn) break;
    consumedBytes += width;
    consumedUtf16 += character.length;
  }
  return { line: zeroLine, character: consumedUtf16 };
}

function sourceLine(file: string, line: number, context: ParserContext): string | undefined {
  const text = sourceText(file, context);
  return text === undefined ? undefined : text.split(/\r?\n/)[line] ?? "";
}

function sourceText(file: string, context: ParserContext): string | undefined {
  try {
    const raw = file.startsWith("file://") ? fileUrlPath(file) : file;
    const candidates = isAbsolute(raw) ? [raw] : [join(context.cwd, raw), join(context.root, raw)];
    for (const candidate of candidates) {
      try {
        return readFileSync(candidate, "utf8");
      } catch {
        // Try the next base directory.
      }
    }
  } catch {
    // Position conversion falls back to the reported column when source is unavailable.
  }
  return undefined;
}

function positionFromUtf8Offset(source: string, offset: number): Position {
  const target = Math.max(0, Math.floor(offset));
  let consumed = 0;
  let line = 0;
  let character = 0;
  for (const value of source) {
    const width = Buffer.byteLength(value, "utf8");
    if (consumed + width > target) break;
    consumed += width;
    if (value === "\n") {
      line += 1;
      character = 0;
    } else {
      character += value.length;
    }
  }
  return { line, character };
}

function lineRange(line: number, column?: number): Range {
  return rangeFromOneBased(line, column ?? 1, line, (column ?? 1) + 1);
}

function rangeFromOneBased(startLine: number, startColumn: number, endLine: number, endColumn: number): Range {
  return { start: { line: Math.max(0, startLine - 1), character: Math.max(0, startColumn - 1) }, end: { line: Math.max(0, endLine - 1), character: Math.max(0, endColumn - 1) } };
}

function rangeFromZeroBased(startLine: number, startColumn: number, endLine: number, endColumn: number): Range {
  return { start: { line: Math.max(0, startLine), character: Math.max(0, startColumn) }, end: { line: Math.max(0, endLine), character: Math.max(0, endColumn) } };
}

function severityFromText(value: string | undefined): FindingSeverity | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (normalized.includes("error") || normalized === "failure") return "error";
  if (normalized.includes("warn")) return "warning";
  if (normalized === "hint" || normalized === "help") return "hint";
  if (normalized === "info" || normalized === "information" || normalized === "note") return "info";
  return undefined;
}

function hasSourceExtension(file: string): boolean {
  return /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|go|java|js|jsx|mjs|cjs|ts|tsx|mts|cts|py|pyi|rs)$/i.test(file);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim();
}

function dedupeDiagnostics(values: RawDiagnostic[]): RawDiagnostic[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = diagnosticKey(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}
