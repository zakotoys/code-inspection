const fs = require("node:fs/promises");
const path = require("node:path");
const { runTests } = require("@vscode/test-electron");

async function main() {
  const root = path.resolve(__dirname, "..");
  const output = path.join(root, ".test-output");
  await fs.mkdir(output, { recursive: true });
  const runDirectory = await fs.mkdtemp(path.join(output, "g2-"));
  const fixture = path.join(runDirectory, "workspace");
  await fs.mkdir(fixture);
  await fs.writeFile(path.join(fixture, "sample.ts"), "export const count: number = 1;\n");
  await fs.writeFile(
    path.join(fixture, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, files: ["sample.ts"] }),
  );
  const workspaceProfile = path.join(runDirectory, "workspace-profile");

  for (const scenario of ["empty", "workspace", "restart"]) {
    console.log(`Starting real VS Code Extension Host: ${scenario}`);
    await runTests({
      version: "1.137.0",
      vscodeExecutablePath: process.env.CODE_INSPECTION_VSCODE_EXECUTABLE,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(root, "dist", "tests", "extension.test.js"),
      extensionTestsEnv: {
        CODE_INSPECTION_TEST_SCENARIO: scenario,
        CODE_INSPECTION_OUTSIDE_FILE: path.join(runDirectory, "outside.ts"),
      },
      launchArgs: [
        ...(scenario === "empty" ? [] : [fixture]),
        "--user-data-dir",
        scenario === "empty" ? path.join(runDirectory, "empty-profile") : workspaceProfile,
        "--extensions-dir",
        path.join(runDirectory, "extensions"),
        "--disable-extensions",
        "--skip-welcome",
        "--skip-release-notes",
        "--disable-workspace-trust",
        "--new-window",
      ],
    });
    console.log(`PASS ${scenario}: host exited successfully`);
  }
  console.log(`G2 host tests passed. Isolated profiles and logs: ${runDirectory}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
