import AVFoundation
import Foundation

enum NativeVoiceRecording {
    @MainActor
    static func run(_ args: [String]) async throws {
        guard args.count == 3, let duration = TimeInterval(args[2]), duration > 0, duration.isFinite else { throw TranscriptionFailure(message: "Missing recording path or duration.") }
        guard await AVCaptureDevice.requestAccess(for: .audio) else {
            throw TranscriptionFailure(message: "Allow microphone access for T3 Code in System Settings, then try again.")
        }
        let recorder = try AVAudioRecorder(url: URL(fileURLWithPath: args[1]), settings: [
            AVFormatIDKey: Int(kAudioFormatLinearPCM), AVSampleRateKey: 16000,
            AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
        ])
        guard recorder.record(forDuration: duration) else {
            throw TranscriptionFailure(message: "Could not start the microphone.")
        }
        try AppleTranscription.emit(["event": "ready"])
        let command = await Task.detached {
            String(data: FileHandle.standardInput.availableData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        }.value
        recorder.stop()
        guard command == "stop" else { throw TranscriptionFailure(message: "Recording cancelled.") }
        try AppleTranscription.emit(["event": "finished"])
    }
}
