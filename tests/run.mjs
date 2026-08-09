// Minimal test runner: bundle each *.test.mjs with esbuild (already present via
// Vite) so Node can resolve the app's extensionless imports, then run it.
// Deliberately not a new dependency — this repo has no test framework and one
// isn't warranted for a handful of pure functions.
import { build } from "esbuild";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let failed = 0;
const results = [];

globalThis.check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`));
};

const files = readdirSync("tests").filter((f) => f.endsWith(".test.mjs"));
for (const f of files) {
  const out = join(tmpdir(), `xyi-${f}.bundled.mjs`);
  await build({ entryPoints: [join("tests", f)], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
  await import(pathToFileURL(out).href);
}

console.log(results.join("\n"));
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
