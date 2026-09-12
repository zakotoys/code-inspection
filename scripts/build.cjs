const fs = require("node:fs/promises");
const path = require("node:path");
const esbuild = require("esbuild");

async function notices(metafile) {
  const packages = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    if (!input.replaceAll("\\", "/").includes("node_modules/")) continue;
    let directory = path.dirname(path.resolve(input));
    while (directory !== path.dirname(directory)) {
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
        if (pkg.name) {
          packages.set(directory, pkg);
          break;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      directory = path.dirname(directory);
    }
  }
  const entries = [];
  for (const [directory, pkg] of packages) {
    const licenseFiles = (await fs.readdir(directory)).filter((name) =>
      /^(licen[cs]e|notice|copying)(\..*)?$/i.test(name),
    );
    if (!licenseFiles.length) throw new Error(`Bundled dependency license missing: ${pkg.name}`);
    const texts = await Promise.all(
      licenseFiles.map((name) => fs.readFile(path.join(directory, name), "utf8")),
    );
    entries.push(`${pkg.name}@${pkg.version} (${pkg.license})\n${texts.join("\n")}`);
  }
  await fs.writeFile(
    "dist/THIRD_PARTY_NOTICES.txt",
    `Bundled runtime dependency notices\n\n${entries.sort().join("\n\n--------------------\n\n")}\n`,
  );
}

async function main() {
  const options = {
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["vscode"],
    sourcemap: true,
    metafile: true,
    legalComments: "eof",
    plugins: [
      {
        name: "dependency-notices",
        setup(build) {
          build.onEnd(async (result) => {
            if (result.metafile && !result.errors.length) await notices(result.metafile);
          });
        },
      },
    ],
  };
  if (process.argv.includes("--watch")) await (await esbuild.context(options)).watch();
  else await esbuild.build(options);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
