import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import pkg from "../package.json";
import manifest from "../paseo-plugin.json";

it("ships bilingual listing metadata and a real PNG interface preview", async () => {
  expect(manifest.name).toBe("Paseo Menu Bar");
  expect(manifest.translations["zh-CN"].description).toBeTruthy();
  expect(pkg.files).toEqual(expect.arrayContaining(["assets", "OVERVIEW.md", "OVERVIEW.*.md"]));
  for (const asset of manifest.media) {
    const path = resolve(asset);
    expect(path.startsWith(`${process.cwd()}/assets/`)).toBe(true);
    expect((await stat(path)).isFile()).toBe(true);
    const png = await readFile(path);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(500);
    expect(png.readUInt32BE(20)).toBeGreaterThanOrEqual(500);
  }
});

it("keeps installation instructions out of overviews and needs no runtime dependency setup", async () => {
  for (const name of ["OVERVIEW.md", "OVERVIEW.zh-CN.md"]) {
    const overview = await readFile(name, "utf8");
    expect(overview).not.toMatch(/paseo\s+plugin\s+(add|install)|npm\s+(install|i)\b/i);
    expect(overview).not.toContain("/Users/");
    expect(overview).toContain("https://raw.githubusercontent.com/ketitongxue/paseo-menubar/");
  }
  expect(Object.hasOwn(manifest, "build")).toBe(false);
  expect(Object.hasOwn(pkg, "dependencies")).toBe(false);
});
