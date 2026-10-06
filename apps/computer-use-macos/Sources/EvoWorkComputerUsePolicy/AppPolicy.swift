// 已验证的签名标识和发布者决定类别；显示名、工具参数、可编辑 plist 不参与准入。
public func applicationKind(bundleID: String, signingID: String, teamID: String?, appleSigned: Bool) -> String {
    guard bundleID == signingID else { return "unknown" }
    let id = bundleID.lowercased()
    if id == "com.evowork.desktop" || id == "com.evowork.desktop.computer-use" { return "self" }
    let terminals: Set<String> = ["com.apple.terminal", "com.googlecode.iterm2", "dev.warp.warp-stable", "dev.warp.warp", "com.mitchellh.ghostty", "net.kovidgoyal.kitty", "org.alacritty"]
    if terminals.contains(id) { return "terminal" }
    if ["com.apple.passwords", "com.apple.keychainaccess", "com.agilebits.onepassword7", "com.1password.1password"].contains(id) { return "credentials" }
    if ["com.apple.systempreferences", "com.apple.loginwindow", "com.apple.securityagent"].contains(id) { return "system" }
    if ["com.apple.screensharing", "com.microsoft.rdc.macos", "com.teamviewer.teamviewer", "com.anydesk.anydesk"].contains(id) { return "remote-desktop" }
    if ["com.apple.safari", "com.google.chrome", "com.microsoft.edgemac", "org.mozilla.firefox", "com.brave.browser", "company.thebrowser.browser"].contains(id) { return "browser" }
    let appleApps: Set<String> = ["com.apple.textedit", "com.apple.finder", "com.apple.iwork.numbers", "com.apple.iwork.pages", "com.apple.iwork.keynote", "com.apple.preview", "com.apple.notes", "com.apple.reminders", "com.apple.ical", "com.apple.addressbook", "com.apple.mail"]
    if appleSigned && appleApps.contains(id) { return "ordinary" }
    let officeApps: Set<String> = ["com.microsoft.word", "com.microsoft.excel", "com.microsoft.powerpoint", "com.microsoft.onenote.mac", "com.microsoft.outlook"]
    if teamID == "UBF8T346G9" && officeApps.contains(id) { return "ordinary" }
    return "unknown"
}
