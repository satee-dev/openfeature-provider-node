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
// Every install is held back a week, so a compromised publish is likely caught before it runs here.
const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
const published = JSON.parse((await npm(["view", "@openfeature/server-sdk", "time", "--json"], ".")).stdout);
const lowest = inRange[0];
if (lowest === undefined) throw new Error(`No @openfeature/server-sdk release matches ${peerRange}`);
if (new Date(published[lowest]) > cutoff) throw new Error(`@openfeature/server-sdk ${lowest} is less than a week old`);
const newestPastCutoff = inRange.filter((v) => new Date(published[v]) <= cutoff).at(-1) ?? lowest;
const sdkVersions = [...new Set([lowest, newestPastCutoff])];
if (sdkVersions.length === 1) console.log(`${peerRange} has no release newer than ${lowest} that is a week old`);

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
        const install = ["install", "--ignore-scripts", "--no-audit", "--no-fund"];
        await npm([...install, `--before=${cutoff.toISOString()}`, tarball, `@openfeature/server-sdk@${sdk}`], dir);
        // Exact pins this repo already vets would fall foul of the cutoff, so they go in after it.
        await npm([...install, `typescript@${typescript}`, typesNode], dir);
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
