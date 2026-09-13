#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyEdits, modify } from "jsonc-parser";
import semver from "semver";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextVersion = process.argv[2];
const jsonTargets = {
  "package.json": [["version"]],
  "package-lock.json": [
    ["version"],
    ["packages", "", "version"],
    ["packages", "packages/core", "version"],
    ["packages", "packages/runtime", "version"],
    ["packages", "packages/runtime", "dependencies", "@zakotoys/code-inspection-core"],
    ["packages", "extensions/vscode", "version"],
  ],
  "packages/core/package.json": [["version"]],
  "packages/runtime/package.json": [
    ["version"],
    ["dependencies", "@zakotoys/code-inspection-core"],
  ],
  "extensions/vscode/package.json": [["version"]],
};
const textTargets = {
  "extensions/zed/Cargo.toml": /^version\s*=\s*"([^"]+)"\s*$/gm,
  "extensions/zed/Cargo.lock":
    /^\[\[package\]\]\r?\nname\s*=\s*"code_inspection_zed"\r?\nversion\s*=\s*"([^"]+)"/gm,
  "extensions/zed/extension.toml": /^version\s*=\s*"([^"]+)"\s*$/gm,
  "packages/runtime/src/version.ts":
    /^export const VERSION\s*=\s*"([^"]+)"\s+as const;\s*$/gm,
};
const readmePaths = ["README.md", "README.zh-CN.md", "README.ja-JP.md"];
const artifactNames = [
  "zakotoys-code-inspection-core",
  "zakotoys-code-inspection-runtime",
  "code-inspection-vscode",
  "code-inspection-zed",
];

if (process.argv.length !== 3 || semver.valid(nextVersion) !== nextVersion) {
  console.error("Usage: npm run version:set -- <semver>");
  process.exitCode = 1;
} else {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

async function main() {
  const paths = [...Object.keys(jsonTargets), ...Object.keys(textTargets), ...readmePaths];
  const entries = await Promise.all(
    paths.map(async (relativePath) => [
      relativePath,
      await readFile(path.join(root, relativePath), "utf8"),
    ]),
  );
  const files = Object.fromEntries(entries);
  const parsedJson = Object.fromEntries(
    Object.keys(jsonTargets).map((relativePath) => {
      try {
        return [relativePath, JSON.parse(files[relativePath])];
      } catch (error) {
        throw new Error(`Cannot parse ${relativePath}: ${error.message}`);
      }
    }),
  );
  const currentVersion = getJsonValue(parsedJson["package.json"], ["version"], "package.json");

  if (semver.valid(currentVersion) !== currentVersion) {
    throw new Error(`Current package version is not valid SemVer: ${currentVersion}`);
  }

  const sources = [];
  for (const [relativePath, propertyPaths] of Object.entries(jsonTargets)) {
    for (const propertyPath of propertyPaths) {
      sources.push([
        `${relativePath}#${propertyPath.join(".")}`,
        getJsonValue(parsedJson[relativePath], propertyPath, relativePath),
      ]);
    }
  }

  const textMatches = {};
  for (const [relativePath, pattern] of Object.entries(textTargets)) {
    const matches = [...files[relativePath].matchAll(pattern)];
    if (matches.length !== 1) {
      throw new Error(`Expected one version in ${relativePath}, found ${matches.length}.`);
    }
    textMatches[relativePath] = matches[0];
    sources.push([relativePath, matches[0][1]]);
  }

  const mismatches = sources.filter(([, version]) => version !== currentVersion);
  if (mismatches.length > 0) {
    const details = mismatches.map(([label, version]) => `  ${label}: ${version}`).join("\n");
    throw new Error(`Version sources do not match package.json (${currentVersion}):\n${details}`);
  }

  if (nextVersion === currentVersion) {
    console.log(`Version is already ${currentVersion}.`);
    return;
  }
  if (!semver.gt(nextVersion, currentVersion)) {
    throw new Error(`Target version ${nextVersion} must be greater than ${currentVersion}.`);
  }

  const updatedFiles = {};
  for (const [relativePath, propertyPaths] of Object.entries(jsonTargets)) {
    updatedFiles[relativePath] = updateJson(files[relativePath], propertyPaths, nextVersion);
  }
  for (const [relativePath, match] of Object.entries(textMatches)) {
    const offset = match[0].lastIndexOf(match[1]);
    const start = match.index + offset;
    updatedFiles[relativePath] =
      files[relativePath].slice(0, start) +
      nextVersion +
      files[relativePath].slice(start + match[1].length);
  }
  for (const relativePath of readmePaths) {
    updatedFiles[relativePath] = updateArtifactExamples(
      files[relativePath],
      relativePath,
      currentVersion,
      nextVersion,
    );
  }

  await Promise.all(
    Object.entries(updatedFiles).map(([relativePath, contents]) =>
      writeFile(path.join(root, relativePath), contents),
    ),
  );
  console.log(`Updated ${Object.keys(updatedFiles).length} files: ${currentVersion} -> ${nextVersion}`);
}

function getJsonValue(value, propertyPath, label) {
  let current = value;
  for (const property of propertyPath) {
    if (current === null || typeof current !== "object" || !(property in current)) {
      throw new Error(`Missing ${label}#${propertyPath.join(".")}.`);
    }
    current = current[property];
  }
  if (typeof current !== "string") {
    throw new Error(`${label}#${propertyPath.join(".")} must be a string.`);
  }
  return current;
}

function updateJson(contents, propertyPaths, version) {
  let updated = contents;
  for (const propertyPath of propertyPaths) {
    updated = applyEdits(
      updated,
      modify(updated, propertyPath, version, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
      }),
    );
  }
  return updated;
}

function updateArtifactExamples(contents, label, currentVersion, version) {
  let updated = contents;
  for (const artifactName of artifactNames) {
    const currentName = `${artifactName}-${currentVersion}`;
    if (!updated.includes(currentName)) {
      throw new Error(`Missing ${currentName} artifact example in ${label}.`);
    }
    updated = updated.replaceAll(currentName, `${artifactName}-${version}`);
  }
  return updated;
}
