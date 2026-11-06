import AVFoundation
import Foundation

enum NativeVoiceRecording {
    @MainActor
    static func run(_ args: [String]) async throws {
        guard args.count == 3 || args.count == 4, let duration = TimeInterval(args[2]), duration > 0, duration.isFinite else { throw TranscriptionFailure(message: "Missing recording path or duration.") }
        // Optional 4th argument: lower other audio to this fraction of its volume while recording.
        let duckFraction = args.count == 4 ? Float32(args[3]) : nil
        guard await AVCaptureDevice.requestAccess(for: .audio) else {
            throw TranscriptionFailure(message: "Allow microphone access for T3 Code in System Settings, then try again.")
        }
        let recorder = try AVAudioRecorder(url: URL(fileURLWithPath: args[1]), settings: [
            AVFormatIDKey: Int(kAudioFormatLinearPCM), AVSampleRateKey: 16000,
            AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
        ])
        recorder.isMeteringEnabled = true
        guard recorder.record(forDuration: duration) else {
            throw TranscriptionFailure(message: "Could not start the microphone.")
        }
        if let duckFraction { OutputDucker.duck(to: duckFraction) }
        defer { OutputDucker.restore() }
        try AppleTranscription.emit(["event": "ready"])
        // Report input loudness (0...1) about 20 times a second so the app can
        // show that audio is actually being captured.
        let meter = Task { @MainActor in
            while !Task.isCancelled && recorder.isRecording {
                recorder.updateMeters()
                try? AppleTranscription.emit(["event": "level", "level": normalizedLevel(recorder.averagePower(forChannel: 0))])
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
        }
        let command = await Task.detached {
            String(data: FileHandle.standardInput.availableData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        }.value
        meter.cancel()
        recorder.stop()
        OutputDucker.restore()
        guard command == "stop" else { throw TranscriptionFailure(message: "Recording cancelled.") }
        try AppleTranscription.emit(["event": "finished"])
    }

    /// Maps average power (-160...0 dBFS) to 0...1, treating -50 dBFS as silence.
    static func normalizedLevel(_ decibels: Float) -> Double {
        guard decibels.isFinite else { return 0 }
        let floor: Float = -50
        return Double(max(0, min(1, (decibels - floor) / -floor)))
    }
}
