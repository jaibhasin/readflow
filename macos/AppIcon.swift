import AppKit

let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

func rectangle(_ rect: NSRect, radius: CGFloat, color: NSColor) {
    color.setFill()
    NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
}

for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                                      bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                      isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        NSGraphicsContext.current!.cgContext.scaleBy(x: CGFloat(pixels) / 1024, y: CGFloat(pixels) / 1024)
        rectangle(NSRect(x: 28, y: 28, width: 968, height: 968), radius: 210,
                  color: NSColor(srgbRed: 0.90, green: 0.93, blue: 0.89, alpha: 1))
        rectangle(NSRect(x: 144, y: 274, width: 736, height: 476), radius: 74,
                  color: NSColor(srgbRed: 0.12, green: 0.16, blue: 0.17, alpha: 1))
        rectangle(NSRect(x: 184, y: 508, width: 656, height: 202), radius: 38,
                  color: NSColor(srgbRed: 0.97, green: 0.67, blue: 0.34, alpha: 1))
        rectangle(NSRect(x: 216, y: 366, width: 592, height: 104), radius: 52,
                  color: NSColor(srgbRed: 0.06, green: 0.09, blue: 0.10, alpha: 1))
        for x in [CGFloat(316), CGFloat(708)] {
            NSColor(srgbRed: 0.82, green: 0.88, blue: 0.84, alpha: 1).setFill()
            NSBezierPath(ovalIn: NSRect(x: x - 68, y: 350, width: 136, height: 136)).fill()
            NSColor(srgbRed: 0.18, green: 0.23, blue: 0.24, alpha: 1).setFill()
            NSBezierPath(ovalIn: NSRect(x: x - 24, y: 394, width: 48, height: 48)).fill()
        }
        let play = NSBezierPath()
        play.move(to: NSPoint(x: 470, y: 546))
        play.line(to: NSPoint(x: 470, y: 668))
        play.line(to: NSPoint(x: 580, y: 607))
        play.close()
        NSColor(srgbRed: 0.12, green: 0.16, blue: 0.17, alpha: 1).setFill()
        play.fill()
        NSGraphicsContext.restoreGraphicsState()
        let suffix = scale == 2 ? "@2x" : ""
        let path = directory.appendingPathComponent("icon_\(size)x\(size)\(suffix).png")
        try bitmap.representation(using: .png, properties: [:])!.write(to: path)
    }
}
