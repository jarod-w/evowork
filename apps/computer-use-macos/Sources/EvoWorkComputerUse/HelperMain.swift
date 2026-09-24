import AppKit
import ApplicationServices
import ScreenCaptureKit
import Security
import Darwin
import EvoWorkComputerUsePolicy

// 单一权限主体；不启动网络服务，不读取模型参数以外的文件，不写屏幕正文日志。
let frameLimit = 16 * 1024 * 1024
struct Failure: Error { let code: String }
func fail(_ code: String) throws -> Never { throw Failure(code: code) }
func ax(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success ? value : nil
}
func pointValue(_ value: CFTypeRef?) -> CGPoint? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(unsafeBitCast(value, to: AXValue.self), .cgPoint, &point) ? point : nil
}
func sizeValue(_ value: CFTypeRef?) -> CGSize? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var size = CGSize.zero
    return AXValueGetValue(unsafeBitCast(value, to: AXValue.self), .cgSize, &size) ? size : nil
}
func identity(_ app: NSRunningApplication) -> String? {
    guard let url = app.bundleURL else { return nil }
    var code: SecStaticCode?
    guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code,
          SecStaticCodeCheckValidity(code, [], nil) == errSecSuccess else { return nil }
    var info: CFDictionary?
    guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
          let dictionary = info as? [String: Any], let hash = dictionary[kSecCodeInfoUnique as String] as? Data else { return nil }
    return hash.map { String(format: "%02x", $0) }.joined()
}

@MainActor final class Controller {
    // 未完成类别识别的第三方 App 一律不可操作；不能靠可伪造的显示名判终端。
    let supported: Set<String> = ["com.apple.TextEdit", "com.apple.finder", "com.apple.iWork.Numbers"]
    var elements: [Int: AXUIElement] = [:]
    var snapshot: [String: Any]?
    var observedAt = Date.distantPast
    var interrupted = false
    var lastRequest = Date()
    var tap: CFMachPort?
    var statusItem: NSStatusItem?
    var termination: DispatchSourceSignal?
    var heartbeat: Timer?
    let syntheticMarker: Int64 = 0x45564f574f524b

    func start() {
        NSApplication.shared.setActivationPolicy(.accessory)
        // SIGTERM 先撤销动作，留给 paste 的 defer 恢复剪贴板，再退出。
        signal(SIGTERM, SIG_IGN)
        termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termination?.setEventHandler { [weak self] in
            self?.interrupted = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { exit(0) }
        }
        termination?.resume()
        heartbeat = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                if Date().timeIntervalSince(self.lastRequest) > 60 { self.interrupted = true; exit(0) }
            }
        }
    }
    func guardSession() throws {
        if interrupted { try fail("USER_STOPPED") }
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any],
              session["CGSSessionScreenIsLocked"] as? Bool != true,
              session[kCGSessionOnConsoleKey as String] as? Bool == true else { try fail("SCREEN_LOCKED") }
    }
    func installInputMonitor() throws {
        if tap != nil { return }
        let mask = [CGEventType.keyDown, .leftMouseDown, .rightMouseDown, .mouseMoved, .scrollWheel].reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        let pointer = Unmanaged.passUnretained(self).toOpaque()
        guard let created = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask, callback: { _, type, event, info in
            guard let info else { return Unmanaged.passUnretained(event) }
            let controller = Unmanaged<Controller>.fromOpaque(info).takeUnretainedValue()
            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput || event.getIntegerValueField(.eventSourceUserData) != controller.syntheticMarker {
                controller.interrupted = true
            }
            return Unmanaged.passUnretained(event)
        }, userInfo: pointer) else { try fail("PERMISSION_REQUIRED") }
        tap = created
        CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, created, 0), .commonModes)
        CGEvent.tapEnable(tap: created, enable: true)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem?.button?.title = "EvoWork 正在控制 · Esc 停止"
    }
    func app(_ params: [String: Any]) throws -> NSRunningApplication {
        try guardSession()
        guard let id = params["app"] as? String, supported.contains(id) else { try fail("POLICY_DENIED") }
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: id).first else { try fail("APP_NOT_FOUND") }
        guard let signature = identity(app), signature == params["identity"] as? String else { try fail("POLICY_DENIED") }
        return app
    }
    func window(_ app: NSRunningApplication) throws -> (AXUIElement, [String: Any]) {
        guard AXIsProcessTrusted() else { try fail("PERMISSION_REQUIRED") }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else { try fail("STALE_STATE") }
        let root = AXUIElementCreateApplication(app.processIdentifier)
        guard let raw = ax(root, kAXFocusedWindowAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() else { try fail("WINDOW_NOT_FOUND") }
        let win = unsafeBitCast(raw, to: AXUIElement.self)
        guard let origin = pointValue(ax(win, kAXPositionAttribute)), let size = sizeValue(ax(win, kAXSizeAttribute)), size.width > 0, size.height > 0,
              ax(win, kAXMinimizedAttribute) as? Bool != true else { try fail("WINDOW_NOT_FOUND") }
        // CG 窗口号绑定 AX bounds；多窗口重叠导致不唯一时直接拒绝。
        let matches = matchingWindowNumbers(CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? [], processID: app.processIdentifier, origin: origin, size: size)
        guard matches.count == 1, let number = matches.first else { try fail("WINDOW_NOT_FOUND") }
        return (win, ["app": app.bundleIdentifier!, "processId": Int(app.processIdentifier), "windowId": String(number), "x": origin.x, "y": origin.y, "width": size.width, "height": size.height, "scale": 1])
    }
    func tree(_ root: AXUIElement) -> String {
        elements.removeAll()
        var lines: [String] = [], bytes = 0, visited = Set<CFHashCode>()
        func visit(_ node: AXUIElement, depth: Int) {
            guard depth <= 30, lines.count < 2000, bytes < 65536, !visited.contains(CFHash(node)) else { return }
            visited.insert(CFHash(node))
            if ax(node, "AXHidden") as? Bool == true { return }
            let role = ax(node, kAXRoleAttribute) as? String ?? "unknown"
            let subrole = ax(node, kAXSubroleAttribute) as? String ?? ""
            if subrole == kAXSecureTextFieldSubrole { lines.append("secureTextField"); return }
            let index = elements.count + 1
            elements[index] = node
            let title = ax(node, kAXTitleAttribute) as? String ?? ""
            let value = ax(node, kAXValueAttribute) as? String ?? ""
            let line = "[\(index)] depth=\(depth) \(role) \(String(title.prefix(512))) value=\(String(value.prefix(2048)))"
            if bytes + line.utf8.count > 65536 { return }
            bytes += line.utf8.count; lines.append(line)
            for child in ax(node, kAXChildrenAttribute) as? [AXUIElement] ?? [] { visit(child, depth: depth + 1) }
        }
        visit(root, depth: 0)
        return lines.joined(separator: "\n")
    }
    func postKey(_ code: CGKeyCode, flags: CGEventFlags = []) throws {
        try guardSession()
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true), let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { try fail("INTERNAL") }
        for event in [down, up] { event.flags = flags; event.setIntegerValueField(.eventSourceUserData, value: syntheticMarker); event.post(tap: .cghidEventTap) }
    }
    func point(_ params: [String: Any], _ xKey: String, _ yKey: String, _ bounds: [String: Any]) throws -> CGPoint {
        guard let x = params[xKey] as? Double, let y = params[yKey] as? Double,
              let width = bounds["width"] as? Double, let height = bounds["height"] as? Double,
              x.isFinite, y.isFinite, x >= 0, y >= 0, x < width, y < height else { try fail("POLICY_DENIED") }
        return CGPoint(x: x + (bounds["x"] as! Double), y: y + (bounds["y"] as! Double))
    }
    func mouse(_ type: CGEventType, _ location: CGPoint, _ button: CGMouseButton = .left, _ count: Int = 1) throws {
        try guardSession()
        guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: location, mouseButton: button) else { try fail("INTERNAL") }
        event.setIntegerValueField(.eventSourceUserData, value: syntheticMarker)
        event.setIntegerValueField(.mouseEventClickState, value: Int64(count)); event.post(tap: .cghidEventTap)
    }
    func handle(_ method: String, _ params: [String: Any]) async throws -> Any {
        lastRequest = Date()
        if method == "health" { return ["protocolVersion": 1, "buildVersion": ProcessInfo.processInfo.environment["EVOWORK_CUA_BUILD_VERSION"] ?? "", "accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()] as [String: Any] }
        try guardSession()
        if method == "list_apps" {
            return NSWorkspace.shared.runningApplications.compactMap { app -> [String: Any]? in
                guard let id = app.bundleIdentifier, supported.contains(id), let signature = identity(app) else { return nil }
                return ["app": id, "name": app.localizedName ?? id, "identity": signature, "kind": "ordinary"]
            }
        }
        let target = try app(params)
        if method == "get_app_state" {
            guard AXIsProcessTrusted() else { try fail("PERMISSION_REQUIRED") }
            target.activate(options: [])
            try await Task.sleep(nanoseconds: 150_000_000)
            try guardSession()
            let (win, bounds) = try window(target)
            let text = tree(win)
            var result: [String: Any] = ["window": bounds, "text": text, "elements": Array(elements.keys), "coordinateFallback": false]
            if params["include_screenshot"] as? Bool == true {
                guard CGPreflightScreenCaptureAccess() else { try fail("PERMISSION_REQUIRED") }
                let available = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                guard let id = UInt32(bounds["windowId"] as! String), let captured = available.windows.first(where: { $0.windowID == id && $0.owningApplication?.processID == target.processIdentifier }) else { try fail("WINDOW_NOT_FOUND") }
                let configuration = SCStreamConfiguration()
                configuration.width = Int(bounds["width"] as! Double); configuration.height = Int(bounds["height"] as! Double)
                configuration.showsCursor = false
                let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: captured), configuration: configuration)
                guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { try fail("INTERNAL") }
                try guardSession()
                let (_, after) = try window(target)
                guard NSDictionary(dictionary: bounds).isEqual(to: after) else { try fail("STALE_STATE") }
                result["screenshot"] = png.base64EncodedString()
            }
            snapshot = bounds; observedAt = Date()
            try installInputMonitor()
            return result
        }
        let (_, bounds) = try window(target)
        if method == "window_identity" { return bounds }
        guard let before = snapshot, NSDictionary(dictionary: before).isEqual(to: bounds), Date().timeIntervalSince(observedAt) < 30 else { try fail("STALE_STATE") }
        let appRoot = AXUIElementCreateApplication(target.processIdentifier)
        if let focus = ax(appRoot, kAXFocusedUIElementAttribute), CFGetTypeID(focus) == AXUIElementGetTypeID(),
           ax(unsafeBitCast(focus, to: AXUIElement.self), kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole { try fail("POLICY_DENIED") }
        snapshot = nil // 失败也不能重用这批元素。
        defer { elements.removeAll() }
        var selected: AXUIElement?
        if let index = params["element_index"] as? Int {
            guard let element = elements[index], ax(element, kAXRoleAttribute) != nil else { try fail("ELEMENT_NOT_FOUND") }
            if ax(element, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole { try fail("POLICY_DENIED") }
            selected = element
        }
        switch method {
        case "click":
            guard let selected, (params["click_count"] as? Int ?? 1) == 1, (params["button"] as? String ?? "left") == "left" else { try fail("POLICY_DENIED") }
            guard AXUIElementPerformAction(selected, kAXPressAction as CFString) == .success else { try fail("ELEMENT_NOT_FOUND") }
        case "set_value":
            guard let selected, let value = params["value"] as? String else { try fail("POLICY_DENIED") }
            guard AXUIElementSetAttributeValue(selected, kAXValueAttribute as CFString, value as CFString) == .success else { try fail("ELEMENT_NOT_FOUND") }
        case "perform_secondary_action":
            guard let selected, let action = params["action"] as? String else { try fail("POLICY_DENIED") }
            let allowed = ["ShowMenu": kAXShowMenuAction, "Confirm": kAXConfirmAction, "Cancel": kAXCancelAction, "Increment": kAXIncrementAction, "Decrement": kAXDecrementAction]
            guard let name = allowed[action], AXUIElementPerformAction(selected, name as CFString) == .success else { try fail("ELEMENT_NOT_FOUND") }
        case "press_key":
            let keys: [String: (CGKeyCode, CGEventFlags)] = ["Enter": (36, []), "Tab": (48, []), "Shift+Tab": (48, .maskShift), "Escape": (53, []), "Backspace": (51, []), "Delete": (117, []), "ArrowUp": (126, []), "ArrowDown": (125, []), "ArrowLeft": (123, []), "ArrowRight": (124, []), "Home": (115, []), "End": (119, []), "PageUp": (116, []), "PageDown": (121, []), "Meta+A": (0, .maskCommand), "Meta+C": (8, .maskCommand), "Meta+V": (9, .maskCommand), "Meta+X": (7, .maskCommand), "Meta+Z": (6, .maskCommand), "Meta+Shift+Z": (6, [.maskCommand, .maskShift]), "Meta+S": (1, .maskCommand)]
            guard let key = params["key"] as? String, let value = keys[key] else { try fail("POLICY_DENIED") }
            try postKey(value.0, flags: value.1)
        case "paste":
            guard let text = params["text"] as? String, params["format"] as? String == "plain" else { try fail("POLICY_DENIED") }
            let pasteboard = NSPasteboard.general
            let saved: [[NSPasteboard.PasteboardType: Data]] = (pasteboard.pasteboardItems ?? []).map { item in Dictionary(uniqueKeysWithValues: item.types.compactMap { type in item.data(forType: type).map { (type, $0) } }) }
            pasteboard.clearContents(); pasteboard.setString(text, forType: .string)
            let change = pasteboard.changeCount
            defer {
                // 用户在此期间复制了内容时不覆盖用户的新剪贴板。
                if pasteboard.changeCount == change {
                    pasteboard.clearContents()
                    pasteboard.writeObjects(saved.map { data in let item = NSPasteboardItem(); for (type, value) in data { item.setData(value, forType: type) }; return item })
                }
            }
            try postKey(9, flags: .maskCommand)
            try await Task.sleep(nanoseconds: 150_000_000)
            try guardSession()
        case "type_text":
            guard let text = params["text"] as? String else { try fail("POLICY_DENIED") }
            // 整段 Unicode 一个事件；不把换行偷偷转换成按键序列。
            let units = Array(text.utf16)
            guard units.count <= 4096 else { try fail("POLICY_DENIED") }
            for down in [true, false] {
                guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else { try fail("INTERNAL") }
                event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                event.setIntegerValueField(.eventSourceUserData, value: syntheticMarker); event.post(tap: .cghidEventTap)
            }
        case "select_text":
            guard let selected, let value = ax(selected, kAXValueAttribute) as? String,
                  let text = params["text"] as? String, !text.isEmpty,
                  let mode = params["mode"] as? String, mode == "replace" || mode == "extend" else { try fail("POLICY_DENIED") }
            var previous: CFRange?
            if mode == "extend" {
                guard let current = ax(selected, kAXSelectedTextRangeAttribute), CFGetTypeID(current) == AXValueGetTypeID() else { try fail("ELEMENT_NOT_FOUND") }
                var range = CFRange()
                guard AXValueGetValue(unsafeBitCast(current, to: AXValue.self), .cfRange, &range) else { try fail("ELEMENT_NOT_FOUND") }
                previous = range
            }
            guard var range = selectedTextRange(value: value, text: text, prefix: params["prefix"] as? String ?? "", suffix: params["suffix"] as? String ?? "", mode: mode, existing: previous) else { try fail("ELEMENT_NOT_FOUND") }
            guard let axRange = AXValueCreate(.cfRange, &range), AXUIElementSetAttributeValue(selected, kAXSelectedTextRangeAttribute as CFString, axRange) == .success else { try fail("ELEMENT_NOT_FOUND") }
        case "scroll", "drag":
            // 坐标回退需独立验收：不以未经验证的坐标替代 AX 动作。
            try fail("POLICY_DENIED")
        default: try fail("POLICY_DENIED")
        }
        try guardSession()
        return ["ok": true]
    }
}

func exactRead(_ count: Int) -> Data? {
    var output = Data()
    while output.count < count {
        guard let chunk = try? FileHandle.standardInput.read(upToCount: count - output.count), !chunk.isEmpty else { return nil }
        output.append(chunk)
    }
    return output
}
func writeResponse(_ response: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: response), data.count <= frameLimit else { exit(1) }
    var size = UInt32(data.count).bigEndian
    FileHandle.standardOutput.write(Data(bytes: &size, count: 4)); FileHandle.standardOutput.write(data)
}
@main struct HelperMain {
@MainActor static func main() {
let controller = Controller()
controller.start()
DispatchQueue.global().async {
    while let header = exactRead(4) {
        let size = header.reduce(0) { ($0 << 8) | Int($1) }
        guard size > 0, size <= frameLimit, let data = exactRead(size),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let method = object["method"] as? String else { exit(1) }
        let semaphore = DispatchSemaphore(value: 0)
        Task { @MainActor in
            defer { semaphore.signal() }
            do { writeResponse(["ok": true, "value": try await controller.handle(method, object["params"] as? [String: Any] ?? [:])]) }
            catch let failure as Failure { writeResponse(["ok": false, "code": failure.code]) }
            catch { writeResponse(["ok": false, "code": "INTERNAL"]) }
        }
        semaphore.wait()
    }
    exit(0)
}
NSApplication.shared.run()

}
}
