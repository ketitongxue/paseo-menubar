import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { makeFrame } from "../server/model";
import { nativeEnvironment } from "../server/native";
import type { MenuTask } from "../shared/state";

if (process.platform !== "darwin") throw new Error("The native preview requires macOS.");
const root = await mkdtemp(join(tmpdir(), "paseo-menubar-preview-"));
const output = resolve("assets/menubar-preview.png");
const captureOutput = join(root, "preview.png");
const exec = promisify(execFile);
let child: ReturnType<typeof spawn> | undefined;
let timeout: ReturnType<typeof setTimeout> | undefined;

// Instrument a temporary copy of the ACTUAL native menu, not a recreated HTML UI.
// Capture only this synthetic process's own NSViews. No desktop screenshot,
// Accessibility automation, Screen Recording permission, or real daemon access.
const instrumentation = `
        NSApp.appearance = NSAppearance(named: .aqua)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            let timer = Timer(timeInterval: 0.5, repeats: false) { _ in
                defer {
                    self.menu.cancelTrackingWithoutAnimation()
                    NSApp.terminate(nil)
                }
                guard let view = NSApp.windows.first(where: {
                    $0.isVisible && $0.frame.width > 200 && $0.frame.height > 150
                })?.contentView,
                let menuRep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
                view.cacheDisplay(in: view.bounds, to: menuRep)
                let menuImage = NSImage(size: view.bounds.size)
                menuImage.addRepresentation(menuRep)
                let width = max(360, view.bounds.width + 48)
                let height = view.bounds.height + 115
                guard let bitmap = NSBitmapImageRep(
                    bitmapDataPlanes: nil, pixelsWide: Int(width * 2), pixelsHigh: Int(height * 2),
                    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
                ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else { return }
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current = context
                context.cgContext.scaleBy(x: 2, y: 2)
                NSColor(calibratedRed: 0.93, green: 0.94, blue: 0.96, alpha: 1).setFill()
                NSRect(x: 0, y: 0, width: width, height: height).fill()
                ("Paseo Menu Bar" as NSString).draw(at: NSPoint(x: 24, y: height - 49), withAttributes: [
                    .font: NSFont.systemFont(ofSize: 23, weight: .semibold), .foregroundColor: NSColor.black
                ])
                ("Native macOS interface · synthetic tasks" as NSString).draw(at: NSPoint(x: 24, y: height - 71), withAttributes: [
                    .font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.darkGray
                ])
                menuImage.draw(in: NSRect(x: (width - view.bounds.width) / 2, y: 24, width: view.bounds.width, height: view.bounds.height))
                NSGraphicsContext.restoreGraphicsState()
                if let data = bitmap.representation(using: .png, properties: [:]) {
                    try? data.write(to: URL(fileURLWithPath: CommandLine.arguments.last!))
                }
            }
            RunLoop.main.add(timer, forMode: .eventTracking)
            RunLoop.main.add(timer, forMode: .common)
            let area = NSScreen.main!.visibleFrame
            self.menu.popUp(positioning: nil, at: NSPoint(x: area.midX, y: area.midY + 250), in: nil)
        }
`;

try {
  const source = await readFile("native/main.swift", "utf8");
  const marker = "        if !tracking { rebuild() }";
  if (source.split(marker).length !== 2) throw new Error("Native preview marker changed.");
  await writeFile(join(root, "main.swift"), source.replace(marker, marker + instrumentation));
  const binary = join(root, "preview");
  await exec(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-swift-version",
      "5",
      "-framework",
      "AppKit",
      join(root, "main.swift"),
      "-o",
      binary,
    ],
    { env: nativeEnvironment(), timeout: 120_000, maxBuffer: 1024 * 1024 },
  );
  await mkdir("assets", { recursive: true });
  child = spawn(binary, [captureOutput], {
    env: nativeEnvironment(),
    stdio: ["pipe", "ignore", "pipe"],
  });
  child.stderr?.resume();
  const now = Date.now();
  const states: MenuTask["status"][] = ["permission", "error", "running", "running", "done"];
  const titles = [
    "确认测试命令的执行权限",
    "检查构建配置（示例异常）",
    "实现项目搜索功能",
    "运行回归测试",
    "更新项目文档",
  ];
  const tasks = states.map(
    (status, i): MenuTask => ({
      id: `synthetic-${i}`,
      title: titles[i],
      provider: i === 3 ? "claude" : "codex",
      project: "sample-project",
      status,
      updatedAt: now,
      startedAt: status === "running" ? now - 75_000 : null,
      url: `paseo://h/synthetic-host/agent/synthetic-${i}`,
    }),
  );
  child.stdin?.write(`${JSON.stringify(makeFrame(tasks, "connected"))}\n`);
  timeout = setTimeout(() => child?.kill("SIGKILL"), 8000);
  await new Promise<void>((done, fail) => {
    child?.once("error", fail);
    child?.once("close", (code) =>
      code === 0 ? done() : fail(new Error("Native preview failed.")),
    );
  });
  const image = await readFile(captureOutput);
  if (image.length < 1000 || image.subarray(1, 4).toString() !== "PNG")
    throw new Error("Native preview image was not written.");
  await writeFile(output, image);
  console.log(output);
} finally {
  clearTimeout(timeout);
  if (child && child.exitCode === null) child.kill("SIGKILL");
  await rm(root, { recursive: true, force: true });
}
