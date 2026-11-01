#if canImport(CoreImage)
import CoreImage
#endif
import Foundation

/// Renders a QR code as text so `cmux-relay pair` can print one straight into a
/// terminal, with no image viewer or web server involved.
public enum QRCodeRenderer {
    public enum RenderError: Error, Equatable {
        case unavailable
        case encodingFailed
    }

    /// Two vertical modules per character cell using half-block glyphs. A QR code
    /// drawn one-module-per-character comes out twice as tall as it is wide in a
    /// terminal, because character cells are not square; pairing rows keeps the
    /// aspect ratio square enough for phone cameras to lock on.
    public static func asciiQR(for text: String, quietZone: Int = 2) throws -> String {
        let matrix = try modules(for: text)
        let size = matrix.count
        guard size > 0 else { throw RenderError.encodingFailed }

        let padded = size + quietZone * 2
        // `true` means a dark module. The quiet zone must stay light.
        func dark(_ x: Int, _ y: Int) -> Bool {
            let mx = x - quietZone
            let my = y - quietZone
            guard mx >= 0, my >= 0, mx < size, my < size else { return false }
            return matrix[my][mx]
        }

        var output = ""
        var y = 0
        while y < padded {
            for x in 0..<padded {
                let top = dark(x, y)
                let bottom = y + 1 < padded ? dark(x, y + 1) : false
                // Foreground is the *light* module: terminals are usually dark,
                // and QR scanners need light quiet zones with dark data.
                switch (top, bottom) {
                case (true, true):   output += " "
                case (true, false):  output += "\u{2584}" // ▄ lower half light
                case (false, true):  output += "\u{2580}" // ▀ upper half light
                case (false, false): output += "\u{2588}" // █ both light
                }
            }
            output += "\n"
            y += 2
        }
        return output
    }

    /// The QR module matrix, row-major, `true` for dark modules.
    public static func modules(for text: String) throws -> [[Bool]] {
        #if canImport(CoreImage)
        guard let data = text.data(using: .isoLatin1) ?? text.data(using: .utf8) else {
            throw RenderError.encodingFailed
        }
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else {
            throw RenderError.unavailable
        }
        filter.setValue(data, forKey: "inputMessage")
        // Pairing payloads are short; medium correction keeps the code small
        // while tolerating a little terminal-rendering imprecision.
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let image = filter.outputImage else { throw RenderError.encodingFailed }

        let width = Int(image.extent.width)
        let height = Int(image.extent.height)
        guard width > 0, height > 0 else { throw RenderError.encodingFailed }

        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let context = CIContext(options: [.useSoftwareRenderer: true])
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else {
            throw RenderError.encodingFailed
        }
        pixels.withUnsafeMutableBytes { buffer in
            guard let base = buffer.baseAddress else { return }
            context.render(
                image,
                toBitmap: base,
                rowBytes: width * 4,
                bounds: image.extent,
                format: .RGBA8,
                colorSpace: colorSpace
            )
        }

        return (0..<height).map { row in
            (0..<width).map { column in
                // CoreImage returns the code with the origin bottom-left; flip
                // vertically so row 0 is the top of the printed code.
                let flipped = height - 1 - row
                let offset = (flipped * width + column) * 4
                return pixels[offset] < 128
            }
        }
        #else
        throw RenderError.unavailable
        #endif
    }
}
