import AppKit
import Darwin
import Foundation

struct Counts: Decodable {
    let permission: Int
    let error: Int
    let running: Int
    let initializing: Int
    let done: Int
    let idle: Int
    var active: Int { running + initializing }
    var attention: Int { permission + error }
    var total: Int { active + attention + done + idle }
    var valid: Bool { [permission, error, running, initializing, done, idle].allSatisfy { (0...1_000_000).contains($0) } }
}

struct MenuTask: Decodable {
    let id: String
    let title: String
    let provider: String
    let project: String
    let status: String
    let updatedAt: Double
    let startedAt: Double?
    let url: String?
}

struct Frame: Decodable {
    let version: Int
    let connection: String
    let message: String
    let updatedAt: Double
    let counts: Counts
    let tasks: [MenuTask]
    let omitted: Int

    static func decode(_ data: Data) -> Frame? {
        guard data.count <= 1_048_576,
              let frame = try? JSONDecoder().decode(Frame.self, from: data),
              frame.version == 1,
              ["waiting", "connected", "error"].contains(frame.connection),
              frame.counts.valid,
              frame.tasks.count <= 100,
              frame.tasks.allSatisfy({ labels[$0.status] != nil }),
              frame.omitted >= 0 else { return nil }
        return frame
    }
}

let labels: [String: String] = [
    "permission": "等待授权", "error": "异常", "running": "运行中",
    "initializing": "启动中", "done": "已完成", "idle": "空闲"
]
let symbols: [String: String] = [
    "permission": "hand.raised", "error": "exclamationmark.triangle",
    "running": "arrow.triangle.2.circlepath", "initializing": "hourglass",
    "done": "checkmark.circle", "idle": "moon"
]

struct Presentation {
    let title: String
    let symbol: String
    let detail: String

    init(_ frame: Frame?, stale: Bool = false) {
        guard let frame else {
            title = "P …"; symbol = "clock"; detail = "Paseo · 正在连接"
            return
        }
        guard frame.connection == "connected", !stale else {
            let waiting = frame.connection == "waiting" && !stale
            title = waiting ? "P …" : "P 离线"
            symbol = waiting ? "clock" : "wifi.slash"
            detail = stale ? "Paseo 状态桥接超时，列表可能已过期" : frame.message
            return
        }
        let c = frame.counts
        var parts: [String] = []
        if c.active > 0 { parts.append(String(c.active)) }
        if c.attention > 0 { parts.append("!\(c.attention)") }
        if parts.isEmpty { parts.append(c.done > 0 ? "✓\(c.done)" : "空闲") }
        title = "P " + parts.joined(separator: " · ")
        symbol = c.permission > 0 ? "hand.raised.fill" : c.error > 0 ? "exclamationmark.triangle" : c.active > 0 ? "arrow.triangle.2.circlepath" : c.done > 0 ? "checkmark.circle" : "terminal"
        detail = "Paseo · \(c.active) 进行中 · \(c.permission) 等待授权 · \(c.error) 异常 · \(c.done) 已完成 · \(c.idle) 空闲"
    }
}

func emit(_ type: String) {
    guard let data = try? JSONSerialization.data(withJSONObject: ["type": type]) else { return }
    try? FileHandle.standardOutput.write(contentsOf: data + Data([10]))
}

// POSIX read returns the bytes currently available in the pipe. Foundation's
// read(upToCount:) may wait for the requested byte count or EOF on Darwin.
// Keeping this pump shared with --check-live makes small-message latency testable.
func readFrames(_ receive: (Frame) -> Void) {
    var pending = Data()
    var bytes = [UInt8](repeating: 0, count: 65_536)
    while true {
        let count = Darwin.read(STDIN_FILENO, &bytes, bytes.count)
        if count < 0 {
            if errno == EINTR { continue }
            break
        }
        if count == 0 { break }
        pending.append(contentsOf: bytes.prefix(count))
        while let newline = pending.firstIndex(of: 10) {
            let data = Data(pending[..<newline])
            pending.removeSubrange(...newline)
            if let frame = Frame.decode(data) { receive(frame) }
        }
        if pending.count > 1_048_576 { break }
    }
}

func writePresentation(_ frame: Frame) {
    let p = Presentation(frame)
    if let data = try? JSONSerialization.data(withJSONObject: ["title": p.title, "symbol": p.symbol, "detail": p.detail]) {
        try? FileHandle.standardOutput.write(contentsOf: data + Data([10]))
    }
}

func clipped(_ text: String, _ count: Int) -> String {
    text.count > count ? String(text.prefix(count)) + "…" : text
}

func elapsed(_ task: MenuTask) -> String {
    guard task.status == "running", let start = task.startedAt else { return "" }
    let seconds = max(0, Int(Date().timeIntervalSince1970 - start / 1000))
    if seconds >= 3600 { return "运行 \(seconds / 3600)时\(seconds % 3600 / 60)分" }
    if seconds >= 60 { return "运行 \(seconds / 60)分" }
    return "运行 \(seconds)秒"
}

final class MenuBar: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private let menu = NSMenu()
    private var frame: Frame?
    private var lastReceived = Date()
    private var stale = false
    private var tracking = false
    private var watchdog: Timer?
    private var showIdle = UserDefaults.standard.bool(forKey: "showIdle")

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        menu.delegate = self
        menu.autoenablesItems = false
        statusItem.menu = menu
        statusItem.button?.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
        statusItem.button?.imagePosition = .imageLeading
        updateButton()
        rebuild()
        watchdog = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.stale = Date().timeIntervalSince(self.lastReceived) > 45
            self.updateButton()
        }
        // A pipe, not a network listener or a world-readable status file.
        DispatchQueue.global(qos: .utility).async { [weak self] in
            readFrames { value in
                DispatchQueue.main.async { self?.receive(value) }
            }
            // Parent closed or died. Never leave an orphan menu item.
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    private func receive(_ value: Frame) {
        frame = value
        lastReceived = Date()
        stale = false
        updateButton()
        if !tracking { rebuild() }
    }

    private func updateButton() {
        let presentation = Presentation(frame, stale: stale)
        statusItem.button?.title = " " + presentation.title
        let image = NSImage(systemSymbolName: presentation.symbol, accessibilityDescription: "Paseo")
        image?.isTemplate = true
        statusItem.button?.image = image
        statusItem.button?.toolTip = presentation.detail
        statusItem.button?.setAccessibilityLabel(presentation.detail)
    }

    private func info(_ title: String, bold: Bool = false) {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        if bold {
            item.attributedTitle = NSAttributedString(string: title, attributes: [
                .font: NSFont.boldSystemFont(ofSize: 12), .foregroundColor: NSColor.labelColor
            ])
        }
        menu.addItem(item)
    }

    private func action(_ title: String, _ selector: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
        item.target = self
        menu.addItem(item)
        return item
    }

    private func addTask(_ task: MenuTask) {
        let title = clipped(task.title, 42)
        let detail = [task.provider, task.project, elapsed(task)].filter { !$0.isEmpty }.joined(separator: " · ")
        let item = action(title, #selector(openTask(_:)))
        item.representedObject = task.url
        item.isEnabled = task.url != nil
        item.toolTip = "\(labels[task.status] ?? "") · \(task.title)\n\(detail)\n点击在 Paseo 中打开"
        item.image = NSImage(systemSymbolName: symbols[task.status] ?? "circle", accessibilityDescription: labels[task.status])
        let text = NSMutableAttributedString(string: title, attributes: [.font: NSFont.systemFont(ofSize: 13)])
        text.append(NSAttributedString(string: "\n" + detail, attributes: [
            .font: NSFont.systemFont(ofSize: 10), .foregroundColor: NSColor.secondaryLabelColor
        ]))
        item.attributedTitle = text
    }

    private func rebuild() {
        menu.removeAllItems()
        info("Paseo 任务状态", bold: true)
        if let frame {
            if frame.connection != "connected" || stale {
                info(clipped(Presentation(frame, stale: stale).detail, 64))
                if !frame.tasks.isEmpty { info("以下为上次同步的状态，不代表当前进度") }
            } else {
                let c = frame.counts
                info("\(c.active) 进行中  ·  \(c.attention) 需处理  ·  \(c.done) 已完成")
            }
            menu.addItem(.separator())
            var displayed = 0
            let groups: [(String, [String])] = [
                ("需要处理", ["permission", "error"]),
                ("进行中", ["running", "initializing"]),
                ("已完成 · 待查看", ["done"]),
                ("空闲", showIdle ? ["idle"] : [])
            ]
            for (name, statuses) in groups {
                let tasks = frame.tasks.filter { statuses.contains($0.status) }
                if tasks.isEmpty { continue }
                info("\(name)（\(tasks.count)）", bold: true)
                for task in tasks { addTask(task); displayed += 1 }
                menu.addItem(.separator())
            }
            if displayed == 0 {
                info(frame.connection == "connected" ? "暂无进行中或需要关注的任务" : "等待任务状态…")
                menu.addItem(.separator())
            }
            if frame.omitted > 0 { info("另有 \(frame.omitted) 个会话，请在 Paseo 查看") }
            let formatter = DateFormatter()
            formatter.dateFormat = "HH:mm:ss"
            info("最近同步 " + formatter.string(from: Date(timeIntervalSince1970: frame.updatedAt / 1000)))
        } else {
            info("正在等待 Paseo 状态桥接…")
            menu.addItem(.separator())
        }
        action("打开 Paseo", #selector(openPaseo))
        action("立即同步", #selector(refresh), key: "r")
        let idle = action("显示空闲会话", #selector(toggleIdle))
        idle.state = showIdle ? .on : .off
        menu.addItem(.separator())
        action("隐藏菜单栏（重载插件恢复）", #selector(hide))
    }

    func menuNeedsUpdate(_ menu: NSMenu) { rebuild() }
    func menuWillOpen(_ menu: NSMenu) { tracking = true }
    func menuDidClose(_ menu: NSMenu) { tracking = false }

    @objc private func openTask(_ sender: NSMenuItem) {
        guard let text = sender.representedObject as? String,
              let url = URL(string: text), url.scheme == "paseo", url.host == "h" else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func openPaseo() {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "sh.paseo.desktop") else { return }
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
    }

    @objc private func refresh() { emit("refresh") }
    @objc private func toggleIdle() {
        showIdle.toggle()
        UserDefaults.standard.set(showIdle, forKey: "showIdle")
    }
    @objc private func hide() {
        emit("hide")
        NSApp.terminate(nil)
    }
}

signal(SIGPIPE, SIG_IGN)

// Headless protocol/presentation check; no NSApplication or GUI is created.
if CommandLine.arguments.contains("--check") {
    guard let line = readLine(), let frame = Frame.decode(Data(line.utf8)) else {
        fputs("Invalid menu frame\n", stderr)
        exit(1)
    }
    writePresentation(frame)
    exit(0)
}
if CommandLine.arguments.contains("--check-live") {
    readFrames(writePresentation)
    exit(0)
}

var lockDescriptor: Int32 = -1
if let index = CommandLine.arguments.firstIndex(of: "--lock-file"), index + 1 < CommandLine.arguments.count {
    lockDescriptor = open(CommandLine.arguments[index + 1], O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
    guard lockDescriptor >= 0, flock(lockDescriptor, LOCK_EX | LOCK_NB) == 0 else { exit(73) }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = MenuBar()
app.delegate = delegate
app.run()
