const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  runTests,
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
} = require("@vscode/test-electron");

async function main() {
  const root = path.resolve(__dirname, "..");
  const output = path.join(root, ".test-output");
  await fs.mkdir(output, { recursive: true });
  const installed = process.argv.includes("--installed");
  const runDirectory = await fs.mkdtemp(path.join(output, installed ? "installed-" : "host-"));
  const fixture = path.join(runDirectory, "workspace");
  await fs.mkdir(fixture);
  await fs.writeFile(path.join(fixture, "sample.ts"), "export const count: number = 1;\n");
  await fs.writeFile(
    path.join(fixture, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, files: ["sample.ts"] }),
  );
  const connectionRecord = path.join(runDirectory, "connection.json");
  const workspaceProfile = path.join(runDirectory, "workspace-profile");

  const extensions = path.join(runDirectory, "extensions");
  let executable = process.env.CODE_INSPECTION_VSCODE_EXECUTABLE;
  let developmentPath = root;
  if (installed) {
    executable ??= await downloadAndUnzipVSCode("1.137.0");
    const [cli] = resolveCliArgsFromVSCodeExecutablePath(executable, { reuseMachineInstall: true });
    assert.ok(cli);
    const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    const args = [
      "--user-data-dir",
      workspaceProfile,
      "--extensions-dir",
      extensions,
      "--install-extension",
      path.join(root, "artifacts", `${manifest.name}-${manifest.version}.vsix`),
      "--force",
    ];
    const windows = process.platform === "win32";
    if (windows && [cli, ...args].some((arg) => /["%\r\n]/.test(arg)))
      throw new Error("Unsafe Windows CLI path");
    await new Promise((resolve, reject) => {
      const child = spawn(
        windows ? `"${cli}"` : cli,
        windows ? args.map((arg) => `"${arg}"`) : args,
        {
          shell: windows,
          windowsHide: true,
          stdio: "inherit",
        },
      );
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`VSIX install exited ${code}`)),
      );
    });
    // Only this empty driver is loaded in development mode. The product must load from the installed VSIX.
    developmentPath = path.join(runDirectory, "test-driver");
    await fs.mkdir(developmentPath);
    await fs.writeFile(
      path.join(developmentPath, "package.json"),
      JSON.stringify({
        name: "inspection-test-driver",
        publisher: "local-test",
        version: "0.0.1",
        engines: { vscode: "^1.137.0" },
      }),
    );
    const installedEntries = await fs.readdir(extensions);
    assert.ok(
      installedEntries.some((name) => name.startsWith("zakotoys.code-inspection-")),
      "VSIX installation missing",
    );
  }
  for (const scenario of installed ? ["workspace", "restart"] : ["empty", "workspace", "restart"]) {
    console.log(`Starting real VS Code Extension Host: ${scenario}`);
    await runTests({
      version: "1.137.0",
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: developmentPath,
      extensionTestsPath: path.join(root, "dist", "tests", "extension.test.js"),
      extensionTestsEnv: {
        CODE_INSPECTION_TEST_SCENARIO: scenario,
        CODE_INSPECTION_INSTALLED_DIR: installed ? extensions : undefined,
        CODE_INSPECTION_CONNECTION_RECORD: connectionRecord,
        CODE_INSPECTION_OUTSIDE_FILE: path.join(runDirectory, "outside.ts"),
      },
      launchArgs: [
        ...(scenario === "empty" ? [] : [fixture]),
        "--user-data-dir",
        scenario === "empty" ? path.join(runDirectory, "empty-profile") : workspaceProfile,
        "--extensions-dir",
        extensions,
        ...(installed ? [] : ["--disable-extensions"]),
        "--skip-welcome",
        "--skip-release-notes",
        "--disable-workspace-trust",
        "--new-window",
      ],
    });
    const connection = JSON.parse(await fs.readFile(connectionRecord, "utf8"));
    try {
      await fetch(connection.url, { signal: AbortSignal.timeout(2000) });
      throw new Error("MCP listener survived extension host shutdown");
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    console.log(`PASS ${scenario}: host exited successfully and MCP port is closed`);
  }
  console.log(
    `${installed ? "Installed VSIX" : "Development"} host tests passed. Isolated profiles and logs: ${runDirectory}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
