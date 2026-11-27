import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const npm = (args: string[], cwd: string) => run("npm", args, { cwd });

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const peerRange: string = pkg.peerDependencies["@openfeature/server-sdk"];
const typescriptVersions = ["5.8.3", pkg.devDependencies.typescript];
const typesNode = `@types/node@${pkg.devDependencies["@types/node"]}`;

const { stdout } = await npm(["view", `@openfeature/server-sdk@${peerRange}`, "version", "--json"], ".");
const byVersion = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split(/[.-]/).map(Number));
  return (x ?? []).reduce((order, part, i) => order || part - (y?.[i] ?? 0), 0);
};
const inRange: string[] = [JSON.parse(stdout)].flat().sort(byVersion);
const sdkVersions = [...new Set([inRange[0], inRange.at(-1)])];
if (sdkVersions.length === 1) console.log(`${peerRange} allows only @openfeature/server-sdk ${sdkVersions[0]}`);

const work = await mkdtemp(join(tmpdir(), "satee-consumers-"));
try {
  const packed = JSON.parse((await npm(["pack", "--json", "--pack-destination", work], ".")).stdout);
  const tarball = join(work, packed[0].filename);
  for (const sdk of sdkVersions) {
    for (const typescript of typescriptVersions) {
      for (const fixture of ["esm", "cjs", "bundler"]) {
        const setup = `server-sdk ${sdk} and TypeScript ${typescript}`;
        const dir = join(work, `${fixture}-${sdk}-${typescript}`);
        await cp(join("test/consumers", fixture), dir, { recursive: true });
        const deps = [tarball, `@openfeature/server-sdk@${sdk}`, `typescript@${typescript}`, typesNode];
        await npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", ...deps], dir);
        await npm(["exec", "--no", "--", "tsc", "-p", "."], dir).catch((error) => {
          throw new Error(`tsc failed for the ${fixture} consumer with ${setup}:\n${error.stdout}${error.stderr}`, {
            cause: error,
          });
        });
        if (fixture === "cjs") await run(process.execPath, [join(dir, "out/index.cjs")]);
        console.log(`${fixture} consumer type-checks with ${setup}`);
      }
    }
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
