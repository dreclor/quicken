import Foundation
import CoreAudio

// Read activity metadata only. This helper never opens an audio stream or records samples.
func microphoneApps() throws -> [String] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    let system = AudioObjectID(kAudioObjectSystemObject)
    guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else {
        throw NSError(domain: "QuickenAudioActivity", code: 1)
    }
    var processes = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard !processes.isEmpty else { return [] }
    let status = processes.withUnsafeMutableBytes { buffer in AudioObjectGetPropertyData(system, &address, 0, nil, &size, buffer.baseAddress!) }
    guard status == noErr else { throw NSError(domain: "QuickenAudioActivity", code: 2) }
    var apps = Set<String>()
    for process in processes {
        var active: UInt32 = 0
        var activeSize = UInt32(MemoryLayout<UInt32>.size)
        address.mSelector = kAudioProcessPropertyIsRunningInput
        guard AudioObjectGetPropertyData(process, &address, 0, nil, &activeSize, &active) == noErr, active != 0 else { continue }
        var bundle: Unmanaged<CFString>? = nil
        var bundleSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        address.mSelector = kAudioProcessPropertyBundleID
        if AudioObjectGetPropertyData(process, &address, 0, nil, &bundleSize, &bundle) == noErr, let bundle {
            apps.insert(bundle.takeRetainedValue() as String)
        }
    }
    return apps.sorted()
}
var last = ""
func report() {
    let payload: [String: Any]
    do { payload = ["supported": true, "microphoneApps": try microphoneApps()] }
    catch { payload = ["supported": false, "microphoneApps": [], "error": "Microphone activity detection is unavailable on this Mac."] }
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]), let line = String(data: data, encoding: .utf8), line != last else { return }
    last = line
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}
report()
if !CommandLine.arguments.contains("--once") {
    Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in report() }
    RunLoop.main.run()
}
