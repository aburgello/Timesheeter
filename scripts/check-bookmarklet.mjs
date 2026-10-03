// Fails if bookmarklet.txt is not what bookmarklet.src.js builds to.
//
// The bookmark people actually install is bookmarklet.txt, a minified copy of
// bookmarklet.src.js. They're kept in step by hand (the command is at the top of
// the source file), which means one can be edited and the other forgotten. The
// result would be a fix that looks done in review but never reaches anyone's
// browser. This rebuilds the source the documented way and compares.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const out = await build({
  entryPoints: ["bookmarklet.src.js"],
  minify: true,
  write: false,
  logLevel: "error",
});
// Same as `npx esbuild bookmarklet.src.js --minify | sed 's/^/javascript:/'`:
// prefix every line.
const expected = new TextDecoder()
  .decode(out.outputFiles[0].contents)
  .split("\n")
  .map((l, i, all) => (i === all.length - 1 && l === "" ? l : "javascript:" + l))
  .join("\n");
const actual = readFileSync("bookmarklet.txt", "utf8");

if (actual !== expected) {
  console.error("bookmarklet.txt is out of date with bookmarklet.src.js.");
  console.error("Regenerate it with the command at the top of bookmarklet.src.js, then commit both.");
  process.exit(1);
}
console.log("bookmarklet.txt matches its source.");
