import CoreFoundation
import CoreGraphics
import EvoWorkComputerUsePolicy

func check(_ condition: @autoclosure () -> Bool, _ name: String) {
    precondition(condition(), "Native policy check failed: \(name)")
}

func window(_ number: Int, pid: Int32 = 42, layer: Int = 0, x: Double = 10, width: Double = 800) -> [String: Any] {
    [
        kCGWindowOwnerPID as String: pid,
        kCGWindowLayer as String: layer,
        kCGWindowNumber as String: number,
        kCGWindowBounds as String: ["X": x, "Y": 20, "Width": width, "Height": 600]
    ]
}

struct NativePolicyTests {
    static func main() {
        let origin = CGPoint(x: 10, y: 20)
        check(applicationKind(bundleID: "com.apple.iWork.Pages", signingID: "com.apple.iWork.Pages", teamID: nil, appleSigned: true) == "ordinary", "Apple office discovered")
        check(applicationKind(bundleID: "com.apple.TextEdit", signingID: "com.apple.TextEdit", teamID: "FAKE", appleSigned: false) == "unknown", "Apple bundle spoof denied")
        check(applicationKind(bundleID: "com.microsoft.Word", signingID: "com.microsoft.Word", teamID: "UBF8T346G9", appleSigned: false) == "ordinary", "Microsoft office publisher")
        check(applicationKind(bundleID: "com.microsoft.Word", signingID: "com.microsoft.Word", teamID: "FAKE", appleSigned: false) == "unknown", "wrong publisher denied")
        check(applicationKind(bundleID: "com.microsoft.Word", signingID: "different", teamID: "UBF8T346G9", appleSigned: false) == "unknown", "signing identifier mismatch")
        check(applicationKind(bundleID: "com.apple.Terminal", signingID: "com.apple.Terminal", teamID: nil, appleSigned: true) == "terminal", "terminal separated before activation")
        check(applicationKind(bundleID: "com.google.Chrome", signingID: "com.google.Chrome", teamID: "any", appleSigned: false) == "browser", "browser cannot use ordinary route")
        check(applicationKind(bundleID: "com.example.Unknown", signingID: "com.example.Unknown", teamID: "any", appleSigned: false) == "unknown", "unknown signed app denied")
        check(validatedWindowPoint(x: 0, y: 0, width: 800, height: 600) == CGPoint.zero, "window origin accepted")
        check(validatedWindowPoint(x: 800, y: 10, width: 800, height: 600) == nil, "exclusive right edge")
        check(validatedWindowPoint(x: -1, y: 0, width: 800, height: 600) == nil, "negative coordinate denied")
        check(validatedWindowPoint(x: .nan, y: 0, width: 800, height: 600) == nil, "NaN denied")
        check(validatedWindowPoint(x: 0, y: 0, width: .infinity, height: 600) == nil, "invalid bounds denied")
        let rectangle = CGRect(x: 10, y: 20, width: 3000, height: 600)
        let path = validatedDragPath(from: origin, to: CGPoint(x: 110, y: 120), window: rectangle, duration: 500)
        check(path?.last == CGPoint(x: 110, y: 120) && path?.count == 25, "drag reaches exact endpoint with interruption steps")
        check(validatedDragPath(from: origin, to: CGPoint(x: 2011, y: 20), window: rectangle, duration: 500) == nil, "drag distance budget")
        check(validatedDragPath(from: origin, to: CGPoint(x: 10, y: 620), window: rectangle, duration: 500) == nil, "drag endpoint outside window")
        check(validatedDragPath(from: origin, to: CGPoint(x: 110, y: 120), window: rectangle, duration: 2001) == nil, "drag duration budget")
        let size = CGSize(width: 800, height: 600)
        let entries = [window(1, pid: 43), window(2, layer: 1), window(3, x: 11), window(4, width: .nan), window(5)]
        check(matchingWindowNumbers(entries, processID: 42, origin: origin, size: size) == [5], "unique process/window match")
        check(matchingWindowNumbers(entries + [window(6)], processID: 42, origin: origin, size: size) == [5, 6], "ambiguous windows remain visible to caller")
        check(matchingWindowNumbers([window(1, pid: 43)], processID: 42, origin: origin, size: size).isEmpty, "other process denied")

        let range = selectedTextRange(value: "😀 前缀目标后缀", text: "目标", prefix: "前缀", suffix: "后缀", mode: "replace", existing: nil)
        check(range?.location == 5 && range?.length == 2, "UTF-16 text range")
        check(selectedTextRange(value: "目标 目标", text: "目标", prefix: "", suffix: "", mode: "replace", existing: nil) == nil, "duplicate text denied")
        check(selectedTextRange(value: "aaa", text: "aa", prefix: "", suffix: "", mode: "replace", existing: nil) == nil, "overlapping duplicate denied")
        check(selectedTextRange(value: "é", text: "e\u{301}", prefix: "", suffix: "", mode: "replace", existing: nil) == nil, "different UTF-16 normalization denied")
        check(selectedTextRange(value: "正文", text: "", prefix: "", suffix: "", mode: "replace", existing: nil) == nil, "empty text denied")

        let value = "甲乙丙丁戊"
        let fromLeft = selectedTextRange(value: value, text: "丁", prefix: "", suffix: "", mode: "extend", existing: CFRange(location: 1, length: 1))
        check(fromLeft?.location == 1 && fromLeft?.length == 3, "extend selection right")
        let fromRight = selectedTextRange(value: value, text: "乙", prefix: "", suffix: "", mode: "extend", existing: CFRange(location: 3, length: 1))
        check(fromRight?.location == 1 && fromRight?.length == 3, "extend selection left")
        check(selectedTextRange(value: value, text: "乙", prefix: "", suffix: "", mode: "extend", existing: nil) == nil, "missing original selection denied")
        check(selectedTextRange(value: value, text: "乙", prefix: "", suffix: "", mode: "extend", existing: CFRange(location: 4, length: 2)) == nil, "out-of-bounds selection denied")
        print("Native policy checks passed (29 cases).")
    }
}

NativePolicyTests.main()
