import Foundation
import AVFoundation
import CoreML
import FluidAudio

// This helper receives only audio explicitly sent by an authenticated local
// session. It never opens a microphone or audio device. Network downloads are
// allowed only for the explicit install command; inference loads local files.
final class Output: @unchecked Sendable {
    static let shared = Output()
    private let lock = NSLock()
    func send(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
        lock.lock(); defer { lock.unlock() }
        FileHandle.standardOutput.write(data + Data([10]))
    }
}

@main struct QuickenSpeech {
    static func main() async {
        let configuration = MLModelConfiguration()
        configuration.computeUnits = .cpuAndNeuralEngine
        let recognizer = StreamingEouAsrManager(configuration: configuration, chunkSize: .ms160, eouDebounceMs: 480)
        ModelRegistry.revisionOverrides = ["FluidInference/parakeet-realtime-eou-120m-coreml": "40a23f4c0b333aa17ad8c0f2ea47ec2347f2f355"]
        ModelHub.offlineMode = true
        await recognizer.setPartialCallback { text in Output.shared.send(["event": "partial", "text": text]) }
        var loaded = false
        var samplesInTurn = 0
        Output.shared.send(["event": "booted"])
        while let line = readLine() {
            guard let data = line.data(using: .utf8), let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            let id = command["id"] as? Int ?? 0
            do {
                switch command["op"] as? String {
                case "install", "load":
                    guard let path = command["directory"] as? String else { throw NSError(domain: "Quicken", code: 1, userInfo: [NSLocalizedDescriptionKey: "Missing model directory"]) }
                    let root = URL(fileURLWithPath: path, isDirectory: true)
                    if command["op"] as? String == "install" {
                        ModelHub.offlineMode = false
                        defer { ModelHub.offlineMode = true }
                        Output.shared.send(["event": "progress", "detail": "Downloading the English speech model…"])
                        try await recognizer.loadModels(to: root)
                    } else {
                        // Explicit local load cannot silently redownload or contact a provider.
                        try await recognizer.loadModels(from: root.appendingPathComponent(Repo.parakeetEou160.folderName))
                    }
                    loaded = true
                    Output.shared.send(["id": id, "ok": true, "folder": Repo.parakeetEou160.folderName])
                case "reset":
                    await recognizer.reset(); samplesInTurn = 0
                    Output.shared.send(["id": id, "ok": true])
                case "audio":
                    guard loaded, let base64 = command["pcm"] as? String, let bytes = Data(base64Encoded: base64), bytes.count > 0, bytes.count <= 32_000, bytes.count % 2 == 0 else {
                        throw NSError(domain: "Quicken", code: 2, userInfo: [NSLocalizedDescriptionKey: "Invalid local audio or speech model not loaded"])
                    }
                    let count = bytes.count / 2
                    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
                    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count))!
                    buffer.frameLength = AVAudioFrameCount(count)
                    bytes.withUnsafeBytes { raw in
                        for i in 0..<count {
                            let sample = raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self)
                            buffer.floatChannelData![0][i] = Float(Int16(littleEndian: sample)) / 32768
                        }
                    }
                    _ = try await recognizer.process(audioBuffer: buffer)
                    samplesInTurn += count
                    if await recognizer.eouDetected || samplesInTurn >= 16_000 * 30 {
                        let text = try await recognizer.finish().trimmingCharacters(in: .whitespacesAndNewlines)
                        if !text.isEmpty { Output.shared.send(["event": "final", "text": text]) }
                        await recognizer.reset(); samplesInTurn = 0
                    }
                    Output.shared.send(["id": id, "ok": true])
                case "flush":
                    if loaded {
                        let text = try await recognizer.finish().trimmingCharacters(in: .whitespacesAndNewlines)
                        if !text.isEmpty { Output.shared.send(["event": "final", "text": text]) }
                        await recognizer.reset(); samplesInTurn = 0
                    }
                    Output.shared.send(["id": id, "ok": true])
                default:
                    Output.shared.send(["id": id, "ok": false, "error": "Unknown operation"])
                }
            } catch {
                Output.shared.send(["id": id, "ok": false, "error": error.localizedDescription])
            }
        }
    }
}
