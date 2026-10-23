// Local macOS review helper. Produces OCR geometry, not an aesthetic judgment.
import AppKit
import Foundation
import Vision

struct TextRegion: Codable {
    let text: String
    let confidence: Float
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}
struct ImageReview: Codable {
    let path: String
    let width: Int
    let height: Int
    let regions: [TextRegion]
}

let output = URL(fileURLWithPath: "artifacts/ui-image-review", isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
for path in CommandLine.arguments.dropFirst() {
    let url = URL(fileURLWithPath: path)
    guard let image = NSImage(contentsOf: url),
          let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        throw NSError(domain: "UIReview", code: 1, userInfo: [NSLocalizedDescriptionKey: "Cannot decode image: \(path)"])
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.recognitionLanguages = ["en-US"]
    request.minimumTextHeight = 0.006
    try VNImageRequestHandler(cgImage: cg, options: [:]).perform([request])
    let regions = (request.results ?? []).compactMap { observation -> TextRegion? in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let box = observation.boundingBox
        return TextRegion(text: candidate.string, confidence: candidate.confidence,
                          x: box.minX * Double(cg.width), y: (1 - box.maxY) * Double(cg.height),
                          width: box.width * Double(cg.width), height: box.height * Double(cg.height))
    }.sorted { $0.y < $1.y }
    let record = ImageReview(path: url.path, width: cg.width, height: cg.height, regions: regions)
    try encoder.encode(record).write(to: output.appendingPathComponent(url.deletingPathExtension().lastPathComponent + ".json"))
    print("\(url.lastPathComponent): \(cg.width)x\(cg.height), \(regions.count) recognized regions")
}
