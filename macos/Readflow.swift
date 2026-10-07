import AppKit
import Foundation
import Darwin

@MainActor
final class ReadflowApp: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var server: Process?
    private var input: FileHandle?
    private var log: FileHandle?
    private var quitting = false
    private let status = NSTextField(labelWithString: "Starting Readflow…")
    private let detail = NSTextField(wrappingLabelWithString: "Getting ready to read in Chrome.")
    private let spinner = NSProgressIndicator()
    private var retry: NSButton!
    private var logButton: NSButton!
    private let logs = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/Readflow/app-bridge.log")

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        startBridge()
    }

    private func buildMenu() {
        let menu = NSMenu()
        let item = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Readflow", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Readflow", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = appMenu
        menu.addItem(item)
        NSApp.mainMenu = menu
    }

    private func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 300),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Readflow"
        window.isReleasedWhenClosed = false
        let mark = NSImageView(image: NSImage(systemSymbolName: "play.rectangle.fill", accessibilityDescription: "Readflow")!)
        mark.contentTintColor = .controlAccentColor
        mark.setContentHuggingPriority(.required, for: .vertical)
        mark.widthAnchor.constraint(equalToConstant: 48).isActive = true
        mark.heightAnchor.constraint(equalToConstant: 40).isActive = true
        status.font = .systemFont(ofSize: 22, weight: .semibold)
        status.alignment = .center
        detail.alignment = .center
        detail.textColor = .secondaryLabelColor
        detail.preferredMaxLayoutWidth = 390
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.startAnimation(nil)
        retry = NSButton(title: "Try Again", target: self, action: #selector(retryStart))
        retry.isHidden = true
        let quit = NSButton(title: "Quit Readflow", target: NSApp, action: #selector(NSApplication.terminate(_:)))
        logButton = NSButton(title: "View Log", target: self, action: #selector(viewLog))
        logButton.isHidden = true
        let buttons = NSStackView(views: [retry, logButton, quit])
        buttons.spacing = 10
        let stack = NSStackView(views: [mark, status, detail, spinner, buttons])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: window.contentView!.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: window.contentView!.centerYAnchor),
            stack.widthAnchor.constraint(equalToConstant: 400),
            detail.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func retryStart() { startBridge() }
    @objc private func viewLog() { NSWorkspace.shared.open(logs) }

    private func fail(_ message: String) {
        spinner.stopAnimation(nil)
        spinner.isHidden = true
        status.stringValue = "Readflow couldn’t start"
        detail.stringValue = message
        retry.isHidden = false
        logButton.isHidden = false
    }

    private func startBridge() {
        guard server?.isRunning != true, !quitting else { return }
        guard let path = Bundle.main.object(forInfoDictionaryKey: "ReadflowProjectDirectory") as? String,
              let runner = Bundle.main.url(forResource: "bridge_runner", withExtension: "py") else {
            fail("The app is incomplete. Reinstall Readflow from your project.")
            return
        }
        let project = URL(fileURLWithPath: path, isDirectory: true)
        let python = project.appendingPathComponent(".venv/bin/python")
        guard FileManager.default.isExecutableFile(atPath: python.path),
              FileManager.default.fileExists(atPath: project.appendingPathComponent("bridge/main.py").path),
              FileManager.default.fileExists(atPath: project.appendingPathComponent(".env").path) else {
            fail("Readflow’s project, Python environment, or .env is missing. Restore your setup and try again.")
            return
        }
        let process = Process()
        let pipe = Pipe()
        process.executableURL = python
        process.arguments = [runner.path, "--project", project.path]
        process.currentDirectoryURL = project
        process.standardInput = pipe
        process.qualityOfService = .utility
        do {
            try FileManager.default.createDirectory(at: logs.deletingLastPathComponent(), withIntermediateDirectories: true)
            if !FileManager.default.fileExists(atPath: logs.path) {
                FileManager.default.createFile(atPath: logs.path, contents: nil)
            }
            log = try FileHandle(forWritingTo: logs)
            try log?.seekToEnd()
            process.standardOutput = log
            process.standardError = log
            process.terminationHandler = { [weak self] child in
                DispatchQueue.main.async {
                    guard let self, self.server === child else { return }
                    try? self.input?.close()
                    try? self.log?.close()
                    self.input = nil
                    self.log = nil
                    if self.quitting {
                        NSApp.reply(toApplicationShouldTerminate: true)
                    } else {
                        self.fail("The server stopped. Another copy may be running, or startup failed. View the log, then try again.")
                    }
                }
            }
            server = process
            input = pipe.fileHandleForWriting
            retry.isHidden = true
            logButton.isHidden = true
            spinner.isHidden = false
            spinner.startAnimation(nil)
            status.stringValue = "Starting Readflow…"
            detail.stringValue = "Getting ready to read in Chrome."
            try process.run()
            try pipe.fileHandleForReading.close()
            checkHealth(process, attempt: 0)
        } catch {
            try? input?.close()
            try? log?.close()
            fail("Could not launch the server. View the log and check your Readflow setup.")
        }
    }

    private func checkHealth(_ process: Process, attempt: Int) {
        guard server === process, process.isRunning, !quitting else { return }
        var request = URLRequest(url: URL(string: "http://127.0.0.1:4179/health")!)
        request.timeoutInterval = 0.75
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            DispatchQueue.main.async {
                guard let self, self.server === process, process.isRunning, !self.quitting else { return }
                if data == Data("{\"status\":\"ok\"}".utf8) {
                    self.spinner.stopAnimation(nil)
                    self.spinner.isHidden = true
                    self.status.stringValue = "Ready to listen"
                    self.detail.stringValue = "Click Readflow’s icon in Chrome, then press Play.\nQuit this app when you’re finished."
                } else if attempt < 30 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                        self.checkHealth(process, attempt: attempt + 1)
                    }
                } else {
                    try? self.input?.close()
                    self.fail("The server did not become ready. View the log, then try again.")
                }
            }
        }.resume()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let process = server, process.isRunning else { return .terminateNow }
        if quitting { return .terminateLater }
        quitting = true
        status.stringValue = "Stopping Readflow…"
        retry.isEnabled = false
        try? input?.close()
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
            if process.isRunning { process.terminate() }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
        return .terminateLater
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }
}

@main
struct ReadflowLauncher {
    @MainActor static func main() {
        let application = NSApplication.shared
        let delegate = ReadflowApp()
        application.setActivationPolicy(.regular)
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }
}
