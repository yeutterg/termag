import AppKit
import ImageIO
import UniformTypeIdentifiers

// Render the existing Terminalz vector mark on an opaque background for App Store assets.
let context = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8,
    bytesPerRow: 4096, space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.setFillColor(NSColor(calibratedWhite: 10.0 / 255, alpha: 1).cgColor)
context.fill(CGRect(x: 0, y: 0, width: 1024, height: 1024))
context.setStrokeColor(NSColor(calibratedWhite: 250.0 / 255, alpha: 1).cgColor)
context.setLineWidth(56)
context.stroke(CGRect(x: 224, y: 292, width: 576, height: 440))
context.setStrokeColor(NSColor(calibratedRed: 34.0 / 255, green: 197.0 / 255, blue: 94.0 / 255, alpha: 1).cgColor)
context.setLineCap(.round)
context.setLineJoin(.round)
context.move(to: CGPoint(x: 328, y: 588))
context.addLine(to: CGPoint(x: 452, y: 496))
context.addLine(to: CGPoint(x: 328, y: 404))
context.move(to: CGPoint(x: 508, y: 404))
context.addLine(to: CGPoint(x: 696, y: 404))
context.strokePath()
let destination = URL(fileURLWithPath: CommandLine.arguments[1])
let output = CGImageDestinationCreateWithURL(destination as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(output, context.makeImage()!, nil)
precondition(CGImageDestinationFinalize(output), "Could not write app icon")
