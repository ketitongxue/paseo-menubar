import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { nativeSource } from "./native-source";

const exec = promisify(execFile);

export function dataRoot(): string {
  return resolve(process.env.PASEO_HOME || join(homedir(), ".paseo"), "menubar");
}

// Do not pass provider credentials, daemon secrets, or the user's shell environment to the GUI.
export function nativeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: homedir(),
    TMPDIR: tmpdir(),
    LANG: process.env.LANG || "en_US.UTF-8",
  };
  if (process.env.DEVELOPER_DIR) env.DEVELOPER_DIR = process.env.DEVELOPER_DIR;
  return env;
}

export async function prepareNative(root = dataRoot(), signal?: AbortSignal): Promise<string> {
  if (process.platform !== "darwin") throw new Error("Paseo Menu Bar 仅支持 macOS。");
  const hash = createHash("sha256")
    .update(`paseo-menubar-0.1.1-macos13-swift5\0${nativeSource}`)
    .digest("hex")
    .slice(0, 20);
  const app = join(root, `native-${hash}-${process.arch}.app`);
  const binary = join(app, "Contents", "MacOS", "PaseoMenuBar");
  try {
    await access(binary, constants.X_OK);
    return binary;
  } catch {
    // A source/architecture-specific private cache; compile only once per revision.
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const stage = await mkdtemp(join(root, ".build-"));
  const stagedApp = join(stage, "PaseoMenuBar.app");
  const stagedBinary = join(stagedApp, "Contents", "MacOS", "PaseoMenuBar");
  try {
    await mkdir(join(stagedApp, "Contents", "MacOS"), { recursive: true, mode: 0o700 });
    const source = join(stage, "main.swift");
    await writeFile(source, nativeSource, { mode: 0o600 });
    await writeFile(
      join(stagedApp, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>PaseoMenuBar</string>
<key>CFBundleIdentifier</key><string>sh.paseo.menubar</string>
<key>CFBundleName</key><string>Paseo Menu Bar</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>`,
      { mode: 0o600 },
    );
    try {
      await exec(
        "/usr/bin/xcrun",
        [
          "swiftc",
          "-O",
          "-swift-version",
          "5",
          "-target",
          `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx13.0`,
          "-module-name",
          "PaseoMenuBar",
          "-framework",
          "AppKit",
          source,
          "-o",
          stagedBinary,
        ],
        { env: nativeEnvironment(), timeout: 120_000, maxBuffer: 1024 * 1024, signal },
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(
        "无法编译菜单栏组件。请先运行 xcode-select --install 安装 Apple Command Line Tools。",
        { cause: error },
      );
    }
    await chmod(stagedBinary, 0o700);
    try {
      await rename(stagedApp, app);
    } catch (error) {
      // Another trusted instance may have completed the same immutable artifact first.
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
      await access(binary, constants.X_OK);
    }
    return binary;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
