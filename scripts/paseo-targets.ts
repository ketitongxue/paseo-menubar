import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const paseoTargets = [
  { version: "0.14.0-beta.1", package: "@getpaseo/server" },
  { version: "0.15.0-beta.1", package: "paseo-server-015" },
  { version: "0.15.4", package: "paseo-server-015-stable" },
  { version: "0.16.0-beta.1", package: "paseo-server-016-beta1" },
  { version: "0.16.0-beta.2", package: "paseo-server-016-beta2" },
] as const;
export type PaseoTarget = (typeof paseoTargets)[number];
export interface PackageMetadata {
  name: string;
  version: string;
  exports?: Record<string, { types?: string } | string>;
}
export function metadata(directory: string): PackageMetadata {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}
export function serverDirectory(target: PaseoTarget): string {
  const directory = resolve(projectRoot, "node_modules", target.package);
  if (metadata(directory).version !== target.version)
    throw new Error(`Wrong runtime installed for ${target.version}`);
  return directory;
}
export function hostPackage(target: PaseoTarget, name: string): string {
  const require = createRequire(join(serverDirectory(target), "package.json"));
  let directory = dirname(
    require.resolve(name === "@getpaseo/protocol" ? `${name}/messages` : name),
  );
  for (;;) {
    try {
      const pkg = metadata(directory);
      if (pkg.name === name) {
        if (pkg.version !== target.version)
          throw new Error(`Wrong ${name} version: ${pkg.version}`);
        return directory;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate ${name} for ${target.version}`);
    directory = parent;
  }
}
