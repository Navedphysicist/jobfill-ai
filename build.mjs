import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

const watch = process.argv.includes("--watch");

const ENTRIES = {
  "dist/background.js": "src/background.js",
  "dist/content.js": "src/content.js",
  "dist/popup.js": "src/ui/popup/popup.js",
  "dist/options.js": "src/ui/options/options.js",
  "dist/dashboard.js": "src/ui/dashboard/dashboard.js"
};

const STATIC = [
  ["manifest.json", "dist/manifest.json"],
  ["profile.json", "dist/profile.json"],
  ["src/content.css", "dist/content.css"],
  ["src/ui/popup/popup.html", "dist/popup.html"],
  ["src/ui/popup/popup.css", "dist/popup.css"],
  ["src/ui/options/options.html", "dist/options.html"],
  ["src/ui/options/options.css", "dist/options.css"],
  ["src/ui/dashboard/dashboard.html", "dist/dashboard.html"],
  ["src/ui/dashboard/dashboard.css", "dist/dashboard.css"]
];

async function copyStatic() {
  for (const [from, to] of STATIC) {
    try {
      await cp(from, to);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      console.warn(`WARNING: static file missing, not copied: ${from}`);
    }
  }
}

async function run() {
  await rm("dist", { recursive: true, force: true });
  await mkdir("dist", { recursive: true });

  const common = {
    bundle: true,
    format: "iife",
    target: "chrome120",
    logLevel: "info"
  };

  for (const [out, entry] of Object.entries(ENTRIES)) {
    if (!existsSync(entry)) {
      console.log(`skip: ${entry} (not yet created)`);
      continue;
    }
    const opts = { ...common, entryPoints: [entry], outfile: out };
    if (watch) {
      const ctx = await esbuild.context(opts);
      await ctx.watch();
    } else {
      await esbuild.build(opts);
    }
  }

  await copyStatic();
  console.log(watch ? "watching…" : "build complete");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
