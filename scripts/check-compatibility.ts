// Validate shipped code against each real host SDK, not just the minimum development SDK.
import { relative, resolve } from "node:path";
import ts from "typescript";
import { hostPackage, metadata, paseoTargets, projectRoot } from "./paseo-targets";

const config = ts.readConfigFile(resolve(projectRoot, "tsconfig.json"), ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, projectRoot);
const files = parsed.fileNames.filter((file) =>
  /^(?:index\.|client\/|server\/|shared\/)/.test(relative(projectRoot, file).replaceAll("\\", "/")),
);
let failed = false;
for (const target of paseoTargets) {
  const paths: Record<string, string[]> = {};
  for (const name of ["@getpaseo/plugin", "@getpaseo/client", "@getpaseo/protocol"]) {
    const directory = hostPackage(target, name);
    for (const [entry, value] of Object.entries(metadata(directory).exports ?? {})) {
      if (typeof value === "object" && value.types)
        paths[`${name}${entry === "." ? "" : entry.slice(1)}`] = [resolve(directory, value.types)];
    }
  }
  const program = ts.createProgram(files, { ...parsed.options, paths });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) {
    failed = true;
    console.error(`Paseo ${target.version}: incompatible SDK types`);
    console.error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: () => projectRoot,
        getNewLine: () => "\n",
      }),
    );
  } else console.log(`Paseo ${target.version}: server/client/shared SDK types OK`);
}
if (failed) process.exitCode = 1;
