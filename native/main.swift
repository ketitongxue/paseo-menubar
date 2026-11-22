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

struct UsageWindow: Decodable {
    let id: String
    let label: String
    let shortLabel: String
    let summary: Bool
    let usedPct: Double?
    let remainingPct: Double?
    let resetsAt: Double?
    let tone: String

    var valid: Bool {
        validTones.contains(tone)
            && (usedPct == nil || (usedPct!.isFinite && (0...100).contains(usedPct!)))
            && (remainingPct == nil || (remainingPct!.isFinite && (0...100).contains(remainingPct!)))
            && (resetsAt == nil || resetsAt!.isFinite)
    }
}

struct UsageBalance: Decodable {
    let id: String
    let label: String
    let used: Double?
    let remaining: Double?
    let limit: Double?
    let unit: String
    let resetsAt: Double?
    let tone: String

    var valid: Bool {
        validBalanceUnits.contains(unit)
            && validTones.contains(tone)
            && (used == nil || used!.isFinite)
            && (remaining == nil || remaining!.isFinite)
            && (limit == nil || limit!.isFinite)
            && (resetsAt == nil || resetsAt!.isFinite)
    }
}

struct UsageAccount: Decodable {
    let id: String
    let name: String
    let status: String
    let plan: String?
    let message: String
    let windows: [UsageWindow]
    let balances: [UsageBalance]

    var valid: Bool {
        validUsageAccountStatuses.contains(status)
            && windows.count <= 20
            && balances.count <= 10
            && windows.allSatisfy(\.valid)
            && balances.allSatisfy(\.valid)
    }
}

struct UsageState: Decodable {
    let status: String
    let message: String
    let fetchedAt: Double?
    let accounts: [UsageAccount]
    let omitted: Int

    var valid: Bool {
        validUsageStatuses.contains(status)
            && accounts.count <= 20
            && omitted >= 0
            && (fetchedAt == nil || fetchedAt!.isFinite)
            && accounts.allSatisfy(\.valid)
    }
}

struct Frame: Decodable {
    let version: Int
    let connection: String
    let message: String
    let updatedAt: Double
    let counts: Counts
    let tasks: [MenuTask]
    let omitted: Int
    let usage: UsageState?

    static func decode(_ data: Data) -> Frame? {
        guard data.count <= 1_048_576,
              let frame = try? JSONDecoder().decode(Frame.self, from: data),
              frame.version == 1,
              ["waiting", "connected", "error"].contains(frame.connection),
              frame.counts.valid,
              frame.tasks.count <= 100,
              frame.tasks.allSatisfy({ labels[$0.status] != nil }),
              frame.omitted >= 0,
              frame.usage?.valid ?? true else { return nil }
        return frame
    }
}

let validUsageStatuses: Set<String> = ["idle", "loading", "ready", "disabled", "unsupported", "error"]
let validUsageAccountStatuses: Set<String> = ["available", "unavailable", "error"]
let validTones: Set<String> = ["default", "ok", "warning", "danger"]
let validBalanceUnits: Set<String> = ["usd", "credits", "requests", "tokens"]

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
    let payload: [String: Any] = [
        "title": p.title,
        "symbol": p.symbol,
        "detail": p.detail,
        "usageStatus": frame.usage?.status ?? "none",
        "usageAccounts": frame.usage?.accounts.count ?? 0
    ]
    if let data = try? JSONSerialization.data(withJSONObject: payload) {
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

func formatCompactPct(_ value: Double) -> String {
    "\(Int(value.rounded()))%"
}

func formatDetailPct(_ value: Double) -> String {
    let rounded = (value * 10).rounded() / 10
    if abs(rounded - rounded.rounded()) < 0.05 { return "\(Int(rounded.rounded()))%" }
    return String(format: "%.1f%%", rounded)
}

func formatReset(_ ms: Double?) -> String {
    guard let ms, ms >= 946_684_800_000 else { return "" }
    let target = Date(timeIntervalSince1970: ms / 1000)
    let diff = Int(target.timeIntervalSinceNow)
    if diff <= 0 { return "即将重置" }
    let formatter = DateFormatter()
    formatter.dateFormat = Calendar.current.isDateInToday(target) ? "今天 HH:mm" : "MM-dd HH:mm"
    let clock = formatter.string(from: target)
    let rel: String
    if diff >= 86_400 {
        let days = diff / 86_400
        let hours = (diff % 86_400) / 3_600
        rel = hours > 0 ? "\(days)天\(hours)小时后" : "\(days)天后"
    } else if diff >= 3_600 {
        let hours = diff / 3_600
        let minutes = (diff % 3_600) / 60
        rel = minutes > 0 ? "\(hours)小时\(minutes)分后" : "\(hours)小时后"
    } else if diff >= 60 {
        rel = "\(diff / 60)分钟后"
    } else {
        rel = "不足1分钟"
    }
    return "\(clock)（\(rel)）"
}

func formatBalanceValue(_ value: Double, unit: String) -> String {
    switch unit {
    case "usd":
        return String(format: "$%.2f", value)
    case "credits":
        return abs(value - value.rounded()) < 0.005
            ? "\(Int(value.rounded())) credits"
            : String(format: "%.2f credits", value)
    case "requests":
        return "\(Int(value.rounded())) 次"
    case "tokens":
        if abs(value) >= 1_000_000 { return String(format: "%.1fM tokens", value / 1_000_000) }
        if abs(value) >= 1_000 { return String(format: "%.1fK tokens", value / 1_000) }
        return "\(Int(value.rounded())) tokens"
    default:
        return "\(value)"
    }
}

func formatBalanceSummary(_ balance: UsageBalance) -> String {
    if let rem = balance.remaining, let lim = balance.limit {
        return "剩 \(formatBalanceValue(rem, unit: balance.unit)) / \(formatBalanceValue(lim, unit: balance.unit))"
    }
    if let rem = balance.remaining {
        return "剩 \(formatBalanceValue(rem, unit: balance.unit))"
    }
    if let used = balance.used, let lim = balance.limit {
        return "已用 \(formatBalanceValue(used, unit: balance.unit)) / \(formatBalanceValue(lim, unit: balance.unit))"
    }
    if let used = balance.used {
        return "已用 \(formatBalanceValue(used, unit: balance.unit))"
    }
    if let lim = balance.limit {
        return "上限 \(formatBalanceValue(lim, unit: balance.unit))"
    }
    return ""
}

func formatWindowCompact(_ window: UsageWindow) -> String {
    let name = window.shortLabel.isEmpty ? clipped(window.label, 14) : clipped(window.shortLabel, 18)
    if let rem = window.remainingPct {
        return name.isEmpty ? "剩\(formatCompactPct(rem))" : "\(name) 剩\(formatCompactPct(rem))"
    }
    if let used = window.usedPct {
        return name.isEmpty ? "已用\(formatCompactPct(used))" : "\(name) 已用\(formatCompactPct(used))"
    }
    return name
}

func toneRank(_ tone: String) -> Int {
    switch tone {
    case "danger": return 3
    case "warning": return 2
    case "ok": return 1
    default: return 0
    }
}

func toneColor(_ tone: String) -> NSColor {
    switch tone {
    case "danger": return .systemRed
    case "warning": return .systemOrange
    case "ok": return .systemGreen
    default: return .secondaryLabelColor
    }
}

func providerColor(_ account: UsageAccount) -> NSColor {
    if account.status == "error" { return .systemRed }
    if account.status == "unavailable" { return .systemOrange }
    let key = (account.id + " " + account.name).lowercased()
    if key.contains("codex") || key.contains("openai") { return .systemTeal }
    if key.contains("antigravity") || key.contains("gemini") { return .systemBlue }
    if key.contains("claude") || key.contains("anthropic") { return .systemOrange }
    if key.contains("cursor") { return .systemPurple }
    if key.contains("copilot") || key.contains("github") { return .systemIndigo }
    if key.contains("kimi") || key.contains("moonshot") { return .systemPink }
    if key.contains("grok") { return .systemRed }
    if key.contains("zai") || key.contains("glm") || key.contains("zhipu") { return .systemCyan }
    if key.contains("minimax") { return .systemMint }
    return .systemBlue
}

func windowMetricColor(_ window: UsageWindow) -> NSColor {
    if window.tone == "danger" { return .systemRed }
    if window.tone == "warning" { return .systemOrange }
    if let rem = window.remainingPct {
        if rem <= 10 { return .systemRed }
        if rem <= 25 { return .systemOrange }
        if rem <= 60 { return .systemBlue }
        return .systemGreen
    }
    return toneColor(window.tone)
}

func coloredSymbol(_ name: String, color: NSColor, description: String) -> NSImage? {
    guard let base = NSImage(systemSymbolName: name, accessibilityDescription: description) else { return nil }
    let config = NSImage.SymbolConfiguration(pointSize: 13, weight: .semibold)
        .applying(NSImage.SymbolConfiguration(paletteColors: [color]))
    let styled = base.withSymbolConfiguration(config) ?? base
    styled.isTemplate = false
    return styled
}

func progressBar(_ remainingPct: Double, color: NSColor) -> NSAttributedString {
    let total = 10
    let filled = max(0, min(total, Int((remainingPct / 10.0).rounded())))
    let bar = NSMutableAttributedString(
        string: String(repeating: "█", count: filled),
        attributes: [.font: NSFont.monospacedSystemFont(ofSize: 9, weight: .regular), .foregroundColor: color]
    )
    if filled < total {
        bar.append(NSAttributedString(
            string: String(repeating: "░", count: total - filled),
            attributes: [.font: NSFont.monospacedSystemFont(ofSize: 9, weight: .regular), .foregroundColor: NSColor.tertiaryLabelColor]
        ))
    }
    return bar
}

func accountTone(_ account: UsageAccount) -> String {
    if account.status == "error" { return "danger" }
    if account.status == "unavailable" { return "warning" }
    let summaryWindows = account.windows.filter(\.summary)
    let candidates: [String]
    if !summaryWindows.isEmpty {
        candidates = summaryWindows.map(\.tone)
    } else if !account.windows.isEmpty {
        candidates = account.windows.map(\.tone)
    } else {
        candidates = account.balances.map(\.tone)
    }
    return candidates.max(by: { toneRank($0) < toneRank($1) }) ?? "default"
}

func accountSymbol(_ account: UsageAccount) -> String {
    if account.status == "error" { return "exclamationmark.triangle.fill" }
    if account.status == "unavailable" { return "person.crop.circle.badge.exclamationmark" }
    switch accountTone(account) {
    case "danger": return "exclamationmark.circle.fill"
    case "warning": return "exclamationmark.triangle.fill"
    default: return "chart.bar.fill"
    }
}

func accountSymbolColor(_ account: UsageAccount) -> NSColor {
    if account.status == "error" { return .systemRed }
    if account.status == "unavailable" { return .systemOrange }
    switch accountTone(account) {
    case "danger": return .systemRed
    case "warning": return .systemOrange
    default: return providerColor(account)
    }
}

func accountTitleAttributed(_ account: UsageAccount) -> NSMutableAttributedString {
    let accent = providerColor(account)
    let result = NSMutableAttributedString(string: "● ", attributes: [
        .font: NSFont.systemFont(ofSize: 10, weight: .bold),
        .foregroundColor: accent
    ])
    let rawName = clipped(account.name, 34)
    if let openParen = rawName.firstIndex(of: "("), openParen > rawName.startIndex {
        let prefix = String(rawName[..<openParen]).trimmingCharacters(in: .whitespaces)
        let suffix = " " + String(rawName[openParen...])
        result.append(NSAttributedString(string: prefix, attributes: [
            .font: NSFont.systemFont(ofSize: 13, weight: .semibold),
            .foregroundColor: NSColor.labelColor
        ]))
        result.append(NSAttributedString(string: suffix, attributes: [
            .font: NSFont.systemFont(ofSize: 12, weight: .regular),
            .foregroundColor: NSColor.secondaryLabelColor
        ]))
    } else {
        result.append(NSAttributedString(string: rawName, attributes: [
            .font: NSFont.systemFont(ofSize: 13, weight: .semibold),
            .foregroundColor: NSColor.labelColor
        ]))
    }
    if let plan = account.plan, !plan.isEmpty {
        result.append(NSAttributedString(string: " · ", attributes: [
            .font: NSFont.systemFont(ofSize: 11),
            .foregroundColor: NSColor.tertiaryLabelColor
        ]))
        result.append(NSAttributedString(string: clipped(plan, 16), attributes: [
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
            .foregroundColor: accent
        ]))
    }
    return result
}

func accountSummaryAttributed(_ account: UsageAccount) -> NSAttributedString {
    let result = NSMutableAttributedString()
    guard account.status == "available" else {
        let text = clipped(account.message.isEmpty ? "暂不可用，请在 Paseo 查看" : account.message, 52)
        result.append(NSAttributedString(string: text, attributes: [
            .font: NSFont.systemFont(ofSize: 10, weight: .medium),
            .foregroundColor: account.status == "error" ? NSColor.systemRed : NSColor.systemOrange
        ]))
        return result
    }
    let summaryWindows = account.windows.filter(\.summary)
    let chosen = summaryWindows.isEmpty ? account.windows : summaryWindows
    if !chosen.isEmpty {
        let shown = Array(chosen.prefix(3))
        for (index, window) in shown.enumerated() {
            if index > 0 {
                result.append(NSAttributedString(string: " · ", attributes: [
                    .font: NSFont.systemFont(ofSize: 10),
                    .foregroundColor: NSColor.tertiaryLabelColor
                ]))
            }
            let name = window.shortLabel.isEmpty ? clipped(window.label, 14) : clipped(window.shortLabel, 18)
            if !name.isEmpty {
                result.append(NSAttributedString(string: name + " ", attributes: [
                    .font: NSFont.systemFont(ofSize: 10, weight: .regular),
                    .foregroundColor: NSColor.secondaryLabelColor
                ]))
            }
            let metric: String
            if let rem = window.remainingPct {
                metric = "剩\(formatCompactPct(rem))"
            } else if let used = window.usedPct {
                metric = "已用\(formatCompactPct(used))"
            } else {
                metric = ""
            }
            if !metric.isEmpty {
                result.append(NSAttributedString(string: metric, attributes: [
                    .font: NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .semibold),
                    .foregroundColor: windowMetricColor(window)
                ]))
            }
        }
        if chosen.count > 3 {
            result.append(NSAttributedString(string: " · 等\(chosen.count)项", attributes: [
                .font: NSFont.systemFont(ofSize: 10),
                .foregroundColor: NSColor.secondaryLabelColor
            ]))
        }
        return result
    }
    if let balance = account.balances.first {
        result.append(NSAttributedString(string: clipped(balance.label, 18) + " ", attributes: [
            .font: NSFont.systemFont(ofSize: 10),
            .foregroundColor: NSColor.secondaryLabelColor
        ]))
        result.append(NSAttributedString(string: clipped(formatBalanceSummary(balance), 36), attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .semibold),
            .foregroundColor: toneColor(balance.tone)
        ]))
        return result
    }
    result.append(NSAttributedString(string: "暂无额度窗口", attributes: [
        .font: NSFont.systemFont(ofSize: 10),
        .foregroundColor: NSColor.secondaryLabelColor
    ]))
    return result
}

func accountTitleText(_ account: UsageAccount) -> String {
    let base = clipped(account.name, 34)
    if let plan = account.plan, !plan.isEmpty {
        return "\(base) · \(clipped(plan, 16))"
    }
    return base
}

func accountSummaryText(_ account: UsageAccount) -> String {
    guard account.status == "available" else {
        return clipped(account.message.isEmpty ? "暂不可用，请在 Paseo 查看" : account.message, 52)
    }
    let summaryWindows = account.windows.filter(\.summary)
    let chosen = summaryWindows.isEmpty ? account.windows : summaryWindows
    if !chosen.isEmpty {
        var parts = chosen.prefix(3).map(formatWindowCompact)
        if chosen.count > 3 { parts.append("等\(chosen.count)项") }
        return clipped(parts.joined(separator: " · "), 64)
    }
    if let balance = account.balances.first {
        return clipped("\(balance.label) \(formatBalanceSummary(balance))", 56)
    }
    return "暂无额度窗口"
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

    private func info(_ title: String, bold: Bool = false, in target: NSMenu? = nil) {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        if bold {
            item.attributedTitle = NSAttributedString(string: title, attributes: [
                .font: NSFont.boldSystemFont(ofSize: 12), .foregroundColor: NSColor.labelColor
            ])
        }
        (target ?? menu).addItem(item)
    }

    private func action(_ title: String, _ selector: Selector, key: String = "", in target: NSMenu? = nil) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
        item.target = self
        (target ?? menu).addItem(item)
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

    private func buildUsageSubmenu(_ account: UsageAccount) -> NSMenu {
        let sub = NSMenu()
        sub.autoenablesItems = false
        let header = NSMenuItem(title: accountTitleText(account), action: nil, keyEquivalent: "")
        header.isEnabled = false
        header.attributedTitle = accountTitleAttributed(account)
        sub.addItem(header)
        sub.addItem(.separator())
        if account.status == "available" {
            for window in account.windows {
                let color = windowMetricColor(window)
                var metrics: [String] = []
                if let rem = window.remainingPct { metrics.append("剩 \(formatDetailPct(rem))") }
                if let used = window.usedPct { metrics.append("已用 \(formatDetailPct(used))") }
                let row = NSMenuItem(title: window.label, action: nil, keyEquivalent: "")
                row.isEnabled = false
                let text = NSMutableAttributedString(string: clipped(window.label, 34), attributes: [
                    .font: NSFont.systemFont(ofSize: 12, weight: .medium),
                    .foregroundColor: NSColor.labelColor
                ])
                if !metrics.isEmpty {
                    text.append(NSAttributedString(string: "  " + metrics.joined(separator: " / "), attributes: [
                        .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold),
                        .foregroundColor: color
                    ]))
                }
                let reset = formatReset(window.resetsAt)
                if window.remainingPct != nil || !reset.isEmpty {
                    text.append(NSAttributedString(string: "\n", attributes: [.font: NSFont.systemFont(ofSize: 10)]))
                    if let rem = window.remainingPct {
                        text.append(progressBar(rem, color: color))
                    }
                    if !reset.isEmpty {
                        text.append(NSAttributedString(
                            string: (window.remainingPct != nil ? "  " : "") + "重置：\(reset)",
                            attributes: [.font: NSFont.systemFont(ofSize: 10), .foregroundColor: NSColor.secondaryLabelColor]
                        ))
                    }
                }
                row.attributedTitle = text
                sub.addItem(row)
            }
            if !account.balances.isEmpty {
                if !account.windows.isEmpty { sub.addItem(.separator()) }
                for balance in account.balances {
                    let summary = formatBalanceSummary(balance)
                    let row = NSMenuItem(title: balance.label, action: nil, keyEquivalent: "")
                    row.isEnabled = false
                    let text = NSMutableAttributedString(string: clipped(balance.label, 28) + "：", attributes: [
                        .font: NSFont.systemFont(ofSize: 12, weight: .medium),
                        .foregroundColor: NSColor.labelColor
                    ])
                    text.append(NSAttributedString(string: summary, attributes: [
                        .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold),
                        .foregroundColor: balance.tone == "default" ? NSColor.labelColor : toneColor(balance.tone)
                    ]))
                    let reset = formatReset(balance.resetsAt)
                    if !reset.isEmpty {
                        text.append(NSAttributedString(string: "\n重置：\(reset)", attributes: [
                            .font: NSFont.systemFont(ofSize: 10), .foregroundColor: NSColor.secondaryLabelColor
                        ]))
                    }
                    row.attributedTitle = text
                    sub.addItem(row)
                }
            }
            if account.windows.isEmpty && account.balances.isEmpty {
                info("暂无额度窗口明细", in: sub)
            }
        } else {
            let msg = clipped(account.message.isEmpty ? "当前不可用，请在 Paseo 查看" : account.message, 60)
            let item = NSMenuItem(title: msg, action: nil, keyEquivalent: "")
            item.isEnabled = false
            item.attributedTitle = NSAttributedString(string: msg, attributes: [
                .font: NSFont.systemFont(ofSize: 12, weight: .medium),
                .foregroundColor: account.status == "error" ? NSColor.systemRed : NSColor.systemOrange
            ])
            sub.addItem(item)
        }
        sub.addItem(.separator())
        _ = action("在 Paseo 中查看", #selector(openPaseo), in: sub)
        return sub
    }

    private func addUsageAccount(_ account: UsageAccount) {
        let title = accountTitleText(account)
        let summary = accountSummaryText(account)
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.image = coloredSymbol(accountSymbol(account), color: accountSymbolColor(account), description: title)
        let text = accountTitleAttributed(account)
        text.append(NSAttributedString(string: "\n", attributes: [.font: NSFont.systemFont(ofSize: 10)]))
        text.append(accountSummaryAttributed(account))
        item.attributedTitle = text
        item.toolTip = "\(title)\n\(summary)\n悬停查看全部窗口与重置时间"
        item.submenu = buildUsageSubmenu(account)
        menu.addItem(item)
    }

    private func addUsageSection(_ usage: UsageState, connection: String) {
        if usage.status == "idle" && connection == "waiting" { return }
        if usage.accounts.isEmpty {
            info("账号额度", bold: true)
            switch usage.status {
            case "loading", "idle":
                info("正在查询账号额度…")
            case "disabled", "unsupported", "error":
                info(clipped(usage.message.isEmpty ? "暂无额度数据" : usage.message, 60))
            default:
                info("暂无已配置的额度账号")
            }
            menu.addItem(.separator())
            return
        }
        info("账号额度（\(usage.accounts.count)）", bold: true)
        if usage.status == "error" && !usage.message.isEmpty {
            info(clipped(usage.message, 60))
        }
        for account in usage.accounts { addUsageAccount(account) }
        if usage.omitted > 0 { info("另有 \(usage.omitted) 个额度账号，请在 Paseo 查看") }
        if let fetchedAt = usage.fetchedAt, fetchedAt > 0 {
            let formatter = DateFormatter()
            formatter.dateFormat = "HH:mm:ss"
            info("额度更新 " + formatter.string(from: Date(timeIntervalSince1970: fetchedAt / 1000)))
        }
        menu.addItem(.separator())
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
            if let usage = frame.usage {
                addUsageSection(usage, connection: frame.connection)
            }
            let formatter = DateFormatter()
            formatter.dateFormat = "HH:mm:ss"
            info("最近同步 " + formatter.string(from: Date(timeIntervalSince1970: frame.updatedAt / 1000)))
        } else {
            info("正在等待 Paseo 状态桥接…")
            menu.addItem(.separator())
        }
        action("打开 Paseo", #selector(openPaseo))
        action("立即同步", #selector(refresh), key: "r")
        action("刷新额度", #selector(refreshUsage), key: "u")
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
    @objc private func refreshUsage() { emit("refreshUsage") }
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
