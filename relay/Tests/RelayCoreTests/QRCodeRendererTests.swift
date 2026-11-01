import CoreImage
import XCTest
@testable import RelayCore

final class QRCodeRendererTests: XCTestCase {
    func testProducesASquareModuleMatrix() throws {
        let matrix = try QRCodeRenderer.modules(for: "cmux://pair?server=a&relay=b&code=c")
        XCTAssertFalse(matrix.isEmpty)
        for row in matrix {
            XCTAssertEqual(row.count, matrix.count, "QR matrices are square")
        }
    }

    /// CoreImage emits the code with a 1-module quiet zone already around it, so
    /// the top-left finder pattern starts at index 1, not 0. Assert the full 7x7
    /// ring: dark border, light inner ring, dark 3x3 core.
    func testTopLeftFinderPatternIsIntactAndUnflipped() throws {
        let matrix = try QRCodeRenderer.modules(for: "cmux://pair?server=a&relay=b&code=c")
        XCTAssertFalse(matrix[0][0], "built-in quiet zone must stay light")

        for i in 1...7 {
            XCTAssertTrue(matrix[1][i], "finder top edge")
            XCTAssertTrue(matrix[7][i], "finder bottom edge")
            XCTAssertTrue(matrix[i][1], "finder left edge")
            XCTAssertTrue(matrix[i][7], "finder right edge")
        }
        XCTAssertFalse(matrix[2][2], "ring inside the finder border is light")
        XCTAssertTrue(matrix[4][4], "finder core is dark")
    }

    func testASCIIOutputIncludesQuietZoneRows() throws {
        let art = try QRCodeRenderer.asciiQR(for: "cmux://pair?server=a", quietZone: 2)
        let lines = art.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.isEmpty }
        XCTAssertFalse(lines.isEmpty)
        // Every line must be the same width or a scanner sees a skewed code.
        let widths = Set(lines.map(\.count))
        XCTAssertEqual(widths.count, 1)
        // The first row is inside the quiet zone, so it renders as all-light.
        XCTAssertEqual(Set(lines[0]), Set("\u{2588}"))
    }

    func testLongerPayloadsProduceLargerMatrices() throws {
        let short = try QRCodeRenderer.modules(for: "cmux://pair?server=a")
        let long = try QRCodeRenderer.modules(
            for: "cmux://pair?server=https://relay.example.com/cmux-remote&relay=home-mac&code="
                + String(repeating: "a", count: 64)
        )
        XCTAssertGreaterThan(long.count, short.count)
    }

    /// The assertions above check structure; this one checks the thing that
    /// actually matters, that a real QR reader recovers the exact payload.
    func testRenderedMatrixIsDecodableByAQRReader() throws {
        let payload = "cmux://pair?server=https://relay.example.com/cmux-remote"
            + "&relay=home-mac&code=" + String(repeating: "a1b2", count: 16)
        let matrix = try QRCodeRenderer.modules(for: payload)

        let scale = 8
        let size = matrix.count * scale
        var pixels = [UInt8](repeating: 0, count: size * size)
        for y in 0..<size {
            for x in 0..<size {
                pixels[y * size + x] = matrix[y / scale][x / scale] ? 0 : 255
            }
        }
        let data = Data(pixels)
        guard let colorSpace = CGColorSpace(name: CGColorSpace.linearGray),
              let provider = CGDataProvider(data: data as CFData),
              let cgImage = CGImage(
                  width: size, height: size,
                  bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: size,
                  space: colorSpace, bitmapInfo: CGBitmapInfo(rawValue: 0),
                  provider: provider, decode: nil, shouldInterpolate: false,
                  intent: .defaultIntent
              )
        else { return XCTFail("could not build a bitmap from the module matrix") }

        let detector = CIDetector(
            ofType: CIDetectorTypeQRCode,
            context: CIContext(),
            options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]
        )
        let features = detector?.features(in: CIImage(cgImage: cgImage)) ?? []
        let decoded = features.compactMap { ($0 as? CIQRCodeFeature)?.messageString }
        XCTAssertEqual(decoded, [payload])
    }
}
