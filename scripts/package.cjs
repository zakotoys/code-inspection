const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createVSIX, listFiles } = require("@vscode/vsce");

async function main() {
  const manifest = JSON.parse(await fs.readFile("package.json", "utf8"));
  await fs.mkdir("artifacts", { recursive: true });
  const packagePath = path.resolve("artifacts", `${manifest.name}-${manifest.version}.vsix`);
  await createVSIX({
    packagePath,
    dependencies: false,
    useYarn: false,
    rewriteRelativeLinks: false,
  });
  const files = (await listFiles({ packagedDependencies: [] }))
    .map((file) => file.replaceAll("\\", "/"))
    .sort();
  const required = [
    "package.json",
    "README.md",
    "LICENSE",
    "dist/extension.cjs",
    "dist/THIRD_PARTY_NOTICES.txt",
    "examples/sample.ts",
    "examples/tsconfig.json",
    "examples/README.md",
  ];
  for (const file of required) assert.ok(files.includes(file), `Missing VSIX file: ${file}`);
  for (const file of files)
    assert.ok(
      required.includes(file) || /^knowledge\/[^/]+\.md$/.test(file),
      `Unexpected VSIX file: ${file}`,
    );
  await fs.writeFile("artifacts/package-files.json", JSON.stringify(files, null, 2));
  await fs.cp("examples", "artifacts/example", { recursive: true });
  console.log(`Verified package allowlist: ${files.length} files; VSIX: ${packagePath}`);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
