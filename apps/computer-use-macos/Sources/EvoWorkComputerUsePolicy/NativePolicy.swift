import CoreFoundation
import CoreGraphics
import Foundation

// AX bounds 必须唯一对应目标进程的前台普通窗口，不能按数组顺序猜测。
public func matchingWindowNumbers(_ entries: [[String: Any]], processID: Int32, origin: CGPoint, size: CGSize) -> [Int] {
    entries.compactMap { entry in
        guard entry[kCGWindowOwnerPID as String] as? Int32 == processID,
              entry[kCGWindowLayer as String] as? Int == 0,
              let number = entry[kCGWindowNumber as String] as? Int,
              let bounds = entry[kCGWindowBounds as String] as? [String: Any],
              let x = bounds["X"] as? NSNumber,
              let y = bounds["Y"] as? NSNumber,
              let width = bounds["Width"] as? NSNumber,
              let height = bounds["Height"] as? NSNumber else { return nil }
        let rect = CGRect(x: x.doubleValue, y: y.doubleValue, width: width.doubleValue, height: height.doubleValue)
        guard rect.origin.x.isFinite, rect.origin.y.isFinite, rect.width.isFinite, rect.height.isFinite,
              abs(rect.origin.x - origin.x) < 1, abs(rect.origin.y - origin.y) < 1,
              abs(rect.width - size.width) < 1, abs(rect.height - size.height) < 1 else { return nil }
        return number
    }
}

// NSString/AX 的范围均以 UTF-16 代码单元计；重复命中或无效原选区一律拒绝。
public func selectedTextRange(value: String, text: String, prefix: String, suffix: String, mode: String, existing: CFRange?) -> CFRange? {
    guard !text.isEmpty, mode == "replace" || mode == "extend" else { return nil }
    let source = value as NSString
    let needle = prefix + text + suffix
    let match = source.range(of: needle)
    guard match.location != NSNotFound else { return nil }
    // NSString 搜索可能把规范等价但 UTF-16 长度不同的文本视作命中；AX 选区不能沿用查询串的偏移。
    guard Array(source.substring(with: match).utf16) == Array(needle.utf16) else { return nil }
    guard source.range(of: needle, options: .backwards).location == match.location else { return nil }
    let start = match.location + (prefix as NSString).length
    let end = start + (text as NSString).length
    if mode == "replace" { return CFRange(location: start, length: end - start) }
    guard let existing, existing.location >= 0, existing.length >= 0,
          existing.location <= source.length, existing.length <= source.length - existing.location else { return nil }
    let unionStart = min(start, existing.location)
    return CFRange(location: unionStart, length: max(end, existing.location + existing.length) - unionStart)
}
