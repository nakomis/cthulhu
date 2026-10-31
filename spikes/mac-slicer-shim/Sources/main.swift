// CthulhuSlicerShim — step 1, a NoOp probe.
//
// Purpose: prove that SolidCraft's "Send to Slicer" can target a Cthulhu app,
// and capture *how* the model arrives and *what format* it is. It does nothing
// but record every path it is handed, through every channel macOS might use.
//
// SolidCraft stores registered slicers as .app bundle paths (see
// ~/Library/Application Support/SolidCraft/app.ron → custom_slicers) with no
// argument template, so on macOS the hand-off goes through LaunchServices: the
// chosen .app receives the temp mesh as a *document to open*, not as argv. This
// probe logs both the open-document delegate callbacks AND argv, so we find out
// for certain which one fires — and sniffs the file so we learn the format.
//
// Output goes to three places:
//   • ~/Library/Logs/CthulhuSlicerShim/received.log  (the thing to `tail -f`)
//   • the unified log (Console.app, or `log stream --predicate …`)
//   • stdout (only visible when launched from a terminal)
//
// It is an accessory app (LSUIElement) — no Dock icon, no window. Quit it with
// `killall CthulhuSlicerShim` or from Activity Monitor. Step 2 replaces this
// with the real pipeline (slice → trim → upload) and a proper display.

import AppKit
import Foundation
import os.log

let osLogger = OSLog(subsystem: "com.nakomis.cthulhu.slicer-shim", category: "handoff")

let logDir = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Logs/CthulhuSlicerShim", isDirectory: true)
let logFile = logDir.appendingPathComponent("received.log")

func timestamp() -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: Date())
}

func emit(_ message: String) {
    let line = "[\(timestamp())] \(message)\n"

    // 1. stdout (visible if run from a terminal)
    if let data = line.data(using: .utf8) {
        FileHandle.standardOutput.write(data)
    }

    // 2. unified log — Console.app / `log stream`
    os_log("%{public}@", log: osLogger, type: .default, message)

    // 3. a predictable append-only file
    try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
    if let data = line.data(using: .utf8) {
        if let fh = try? FileHandle(forWritingTo: logFile) {
            fh.seekToEndOfFile()
            fh.write(data)
            try? fh.close()
        } else {
            try? data.write(to: logFile)
        }
    }
}

/// Inspect a received file: extension, size, first 16 bytes, and a format guess.
/// This is how we learn what SolidCraft's "Send to Slicer" actually writes.
func sniff(_ path: String) -> String {
    let url = URL(fileURLWithPath: path)
    let ext = url.pathExtension.isEmpty ? "(none)" : url.pathExtension
    let attrs = try? FileManager.default.attributesOfItem(atPath: path)
    let size = (attrs?[.size] as? NSNumber)?.intValue ?? -1

    var head = Data()
    if let fh = try? FileHandle(forReadingFrom: url) {
        head = fh.readData(ofLength: 16)
        try? fh.close()
    }
    let hex = head.map { String(format: "%02x", $0) }.joined(separator: " ")
    let ascii = String(decoding: head, as: UTF8.self)
        .replacingOccurrences(of: "\n", with: "·")
        .replacingOccurrences(of: "\r", with: "·")

    var guess = "unknown"
    if head.starts(with: Array("solid".utf8)) {
        guess = "STL — ASCII, or binary STL whose 80-byte header starts 'solid'"
    } else if head.starts(with: [0x50, 0x4B]) {
        guess = "ZIP container — most likely 3MF"
    } else if ascii.hasPrefix("# ") || ascii.hasPrefix("v ") || ascii.hasPrefix("o ") || ascii.hasPrefix("mtllib") {
        guess = "OBJ (text)"
    } else if size >= 84 {
        guess = "binary STL (likely — fixed 84-byte minimum, no text header)"
    }
    return "ext=\(ext) size=\(size)B head16=[\(hex)] ascii=\"\(ascii)\" guess=\(guess)"
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ note: Notification) {
        emit("LAUNCH argv=\(CommandLine.arguments)")
    }

    // Single-file open (older odoc Apple event path).
    func application(_ sender: NSApplication, openFile filename: String) -> Bool {
        emit("openFile: \(filename) | \(sniff(filename))")
        return true
    }

    // Multiple-file open.
    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        for f in filenames { emit("openFiles: \(f) | \(sniff(f))") }
        sender.reply(toOpenOrPrint: .success)
    }

    // URL-based open (newer path).
    func application(_ sender: NSApplication, open urls: [URL]) {
        for u in urls { emit("open(urls): \(u.path) | \(sniff(u.path))") }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)   // no Dock icon, no menu-bar presence
let delegate = AppDelegate()
app.delegate = delegate
emit("=== CthulhuSlicerShim starting (pid \(ProcessInfo.processInfo.processIdentifier)) ===")
app.run()
