import AVFoundation
import Foundation

// AVSpeechSynthesizer may deliver more than one terminal empty buffer.
// Serialize callbacks and complete the async task exactly once.
final class VoiceWriter: @unchecked Sendable {
    private let lock = NSLock()
    private var finished = false
    func write(_ buffer: AVAudioBuffer, completion: CheckedContinuation<Void, Never>) {
        lock.lock(); defer { lock.unlock() }
        guard !finished, let pcm = buffer as? AVAudioPCMBuffer else { return }
        if pcm.frameLength == 0 { finished = true; completion.resume(); return }
        var samples = [Int16](repeating: 0, count: Int(pcm.frameLength))
        if let floats = pcm.floatChannelData {
            for i in 0..<samples.count {
                let value = floats[0][i]
                samples[i] = value.isFinite ? Int16(max(-32768, min(32767, value * 32767))).littleEndian : 0
            }
        } else if let ints = pcm.int16ChannelData {
            for i in 0..<samples.count { samples[i] = ints[0][i].littleEndian }
        } else { return }
        let data = samples.withUnsafeBytes { Data($0) }
        if let json = try? JSONSerialization.data(withJSONObject: ["pcm": data.base64EncodedString(), "rate": Int(pcm.format.sampleRate)]) {
            FileHandle.standardOutput.write(json + Data([10]))
        }
    }
}

@main struct LocalVoice {
    @MainActor static func main() async {
        guard let text = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8), !text.isEmpty, text.count <= 500 else { exit(1) }
        let synth = AVSpeechSynthesizer(), writer = VoiceWriter()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice.speechVoices().first { $0.name == "Samantha" && $0.language == "en-US" }
        guard utterance.voice != nil else {
            FileHandle.standardError.write(Data("Install the English Samantha voice in macOS Accessibility → Spoken Content.\n".utf8)); exit(2)
        }
        utterance.rate = 0.5
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            synth.write(utterance) { buffer in writer.write(buffer, completion: continuation) }
        }
    }
}
