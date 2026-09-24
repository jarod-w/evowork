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
        print("Native policy checks passed (12 cases).")
    }
}

NativePolicyTests.main()
