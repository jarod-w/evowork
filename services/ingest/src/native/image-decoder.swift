// Release-built local decoder. Image headers are checked before any pixel decode.
import Foundation
import ImageIO
import CoreGraphics

func fail() -> Never { exit(2) }
let args = CommandLine.arguments
if args.count != 4 { fail() }
let url = URL(fileURLWithPath: args[1])
guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
      CGImageSourceGetCount(source) == 1,
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let width = properties[kCGImagePropertyPixelWidth] as? Int,
      let height = properties[kCGImagePropertyPixelHeight] as? Int,
      width > 0, height > 0, width <= 16_000_000 / height,
      let rotation = Int(args[3]), [0,90,180,270].contains(rotation),
      let image = CGImageSourceCreateImageAtIndex(source,0,[kCGImageSourceShouldCacheImmediately:true] as CFDictionary)
else { fail() }
let outWidth = rotation % 180 == 0 ? width : height
let outHeight = rotation % 180 == 0 ? height : width
let color = CGColorSpaceCreateDeviceRGB()
var pixels = [UInt8](repeating:255,count:outWidth*outHeight*4)
let succeeded = pixels.withUnsafeMutableBytes { bytes -> Bool in
    guard let context = CGContext(data:bytes.baseAddress,width:outWidth,height:outHeight,bitsPerComponent:8,bytesPerRow:outWidth*4,space:color,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
    context.setFillColor(CGColor(gray:1,alpha:1))
    context.fill(CGRect(x:0,y:0,width:outWidth,height:outHeight))
    context.translateBy(x:CGFloat(outWidth)/2,y:CGFloat(outHeight)/2)
    context.rotate(by:-CGFloat(rotation)*CGFloat.pi/180)
    context.draw(image,in:CGRect(x:-CGFloat(width)/2,y:-CGFloat(height)/2,width:CGFloat(width),height:CGFloat(height)))
    return true
}
if !succeeded { fail() }
var output = Data("P6\n\(outWidth) \(outHeight)\n255\n".utf8)
for offset in stride(from:0,to:pixels.count,by:4) { output.append(contentsOf:pixels[offset..<(offset+3)]) }
do {
    try output.write(to:URL(fileURLWithPath:args[2]),options:[])
    let result: [String:Any] = ["width":width,"height":height,"renderWidth":outWidth,"renderHeight":outHeight]
    let data = try JSONSerialization.data(withJSONObject:result)
    FileHandle.standardOutput.write(data)
} catch { fail() }
