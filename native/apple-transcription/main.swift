import AVFoundation
import Foundation
import Speech

struct TranscriptionFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

@main
struct AppleTranscription {
    static func emit(_ value: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }

    static func main() async {
        do {
            let args = Array(CommandLine.arguments.dropFirst())
            if args.first == "record" {
                try await NativeVoiceRecording.run(args)
                return
            }
            if args.first == "hotkey" {
                try GlobalDictationHotkey.run(args)
                return
            }
            guard args.count >= 2 else {
                throw TranscriptionFailure(message: "Missing transcription operation or language.")
            }
            guard #available(macOS 26.0, *), SpeechTranscriber.isAvailable else {
                if args[0] == "capabilities" {
                    try emit(["available": false, "locale": args[1], "installed": false])
                    return
                }
                throw TranscriptionFailure(message: "Apple transcription requires a supported Mac with macOS 26 or later.")
            }
            try await run(args)
        } catch {
            try? emit(["error": error.localizedDescription])
            exit(1)
        }
    }

    @available(macOS 26.0, *)
    static func run(_ args: [String]) async throws {
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: args[1])) else {
            if args[0] == "capabilities" {
                try emit(["available": false, "locale": args[1], "installed": false])
                return
            }
            throw TranscriptionFailure(message: "Apple transcription does not support this language. Choose another language or a custom server in Chat settings.")
        }
        let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [])
        let status = await AssetInventory.status(forModules: [transcriber])
        switch args[0] {
        case "capabilities":
            try emit(["available": true, "locale": locale.identifier, "installed": status == .installed])
        case "prepare":
            if status != .installed {
                if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                    try await request.downloadAndInstall()
                }
            }
            guard await AssetInventory.status(forModules: [transcriber]) == .installed else {
                throw TranscriptionFailure(message: "Could not install Apple's transcription language assets.")
            }
            try emit(["available": true, "locale": locale.identifier, "installed": true])
        case "transcribe":
            guard args.count == 3, status == .installed else {
                throw TranscriptionFailure(message: "Prepare the transcription language before recording.")
            }
            let file = try AVAudioFile(forReading: URL(fileURLWithPath: args[2]))
            let analyzer = SpeechAnalyzer(modules: [transcriber])
            let collector = Task { () throws -> String in
                var parts: [String] = []
                for try await result in transcriber.results {
                    if result.isFinal { parts.append(String(result.text.characters)) }
                }
                return parts.joined(separator: " ")
            }
            do {
                if let end = try await analyzer.analyzeSequence(from: file) {
                    try await analyzer.finalizeAndFinish(through: end)
                } else {
                    await analyzer.cancelAndFinishNow()
                }
                try emit(["text": try await collector.value])
            } catch {
                collector.cancel()
                await analyzer.cancelAndFinishNow()
                _ = try? await collector.value
                throw error
            }
        default:
            throw TranscriptionFailure(message: "Unknown transcription operation.")
        }
    }
}
