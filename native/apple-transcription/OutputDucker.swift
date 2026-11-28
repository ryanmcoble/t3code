import AudioToolbox
import CoreAudio
import Foundation

/// Lowers the default output device's volume while dictating, so music or video
/// keeps playing quietly, and puts it back when recording ends.
///
/// Restores the saved volume on stop, cancel, and handled termination signals.
final class OutputDucker {
    private static var active: OutputDucker?
    private static var signalSources: [DispatchSourceSignal] = []

    private let lock: Int32
    private let fraction: Float32
    private let initialOutput: (device: AudioDeviceID, volume: Float32)?
    private var output: (device: AudioDeviceID, original: Float32, lowered: Float32)?

    private init(lock: Int32, fraction: Float32) {
        self.lock = lock
        self.fraction = fraction
        if let device = Self.defaultDevice(kAudioHardwarePropertyDefaultOutputDevice),
           let volume = Self.volume(of: device) {
            initialOutput = (device, volume)
        } else {
            initialOutput = nil
        }
    }

    static func start(at fraction: Float32) {
        guard active == nil, fraction > 0, fraction < 1,
              let lock = lockOutputVolume()
        else { return }
        active = OutputDucker(lock: lock, fraction: fraction)
        installSignalHandlers()
    }

    static func refresh() {
        guard let ducker = active else { return }
        let device = defaultDevice(kAudioHardwarePropertyDefaultOutputDevice)
        if let previous = ducker.output, previous.device != device {
            _ = setVolume(previous.original, of: previous.device)
            ducker.output = nil
        }

        guard let device, let current = volume(of: device) else { return }
        if let output = ducker.output, current <= output.lowered { return }
        guard isVolumeSettable(device) else { return }
        let original = ducker.output?.original ?? current
        guard original > 0 else { return }
        let target = original * ducker.fraction
        guard setVolume(target, of: device) else { return }
        // Bluetooth profile switches can change the output volume after capture starts.
        let lowered = volume(of: device) ?? target
        ducker.output = (device, original, lowered)
    }

    static func restoreBluetoothVolume(_ args: [String]) {
        guard args.count == 4, let parent = Int32(args[1]),
              let device = AudioDeviceID(args[2]), let original = Float32(args[3]),
              original.isFinite, (0...1).contains(original)
        else { return }
        for _ in 0..<20 where getppid() == parent { usleep(50_000) }
        guard getppid() != parent else { return }

        // The stereo profile can take over only after the mic process exits.
        for _ in 0..<30 {
            guard let lock = lockOutputVolume() else { return }
            if defaultDevice(kAudioHardwarePropertyDefaultOutputDevice) == device,
               volume(of: device) != original {
                _ = setVolume(original, of: device)
            }
            close(lock)
            usleep(100_000)
        }
    }

    static func restore() {
        guard let ducker = active else { return }
        active = nil
        defer { close(ducker.lock) }
        if let output = ducker.output {
            let original = ducker.initialOutput.flatMap { $0.device == output.device ? $0.volume : nil }
            _ = setVolume(original ?? output.original, of: output.device)
        }
        if ducker.output != nil, let initial = ducker.initialOutput, isBluetooth(initial.device),
           let executable = Bundle.main.executableURL {
            let restore = Process()
            restore.executableURL = executable
            restore.arguments = ["restore-bluetooth-volume", String(getpid()), String(initial.device), String(initial.volume)]
            restore.standardInput = FileHandle.nullDevice
            restore.standardOutput = FileHandle.nullDevice
            restore.standardError = FileHandle.nullDevice
            try? restore.run()
        }
    }

    private static func lockOutputVolume() -> Int32? {
        // Every desktop instance's helper shares the same macOS output volume.
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("t3-dictation-volume.lock").path
        let descriptor = open(path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { return nil }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            close(descriptor)
            return nil
        }
        return descriptor
    }

    private static func installSignalHandlers() {
        guard signalSources.isEmpty else { return }
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler {
                restore()
                exit(128 + sig)
            }
            source.resume()
            signalSources.append(source)
        }
    }

    private static var volumeAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
        mScope: kAudioDevicePropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain
    )

    private static func defaultDevice(_ selector: AudioObjectPropertySelector) -> AudioDeviceID? {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var device = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device
        )
        return status == noErr && device != kAudioObjectUnknown ? device : nil
    }

    private static func isBluetooth(_ device: AudioDeviceID) -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyTransportType,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var transport: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &transport)
        return status == noErr && (transport == kAudioDeviceTransportTypeBluetooth
            || transport == kAudioDeviceTransportTypeBluetoothLE)
    }

    private static func isVolumeSettable(_ device: AudioDeviceID) -> Bool {
        guard AudioObjectHasProperty(device, &volumeAddress) else { return false }
        var settable: DarwinBoolean = false
        return AudioObjectIsPropertySettable(device, &volumeAddress, &settable) == noErr
            && settable.boolValue
    }

    private static func volume(of device: AudioDeviceID) -> Float32? {
        var value = Float32(0)
        var size = UInt32(MemoryLayout<Float32>.size)
        let status = AudioObjectGetPropertyData(device, &volumeAddress, 0, nil, &size, &value)
        return status == noErr && value.isFinite ? value : nil
    }

    private static func setVolume(_ value: Float32, of device: AudioDeviceID) -> Bool {
        var value = max(0, min(1, value))
        let size = UInt32(MemoryLayout<Float32>.size)
        return AudioObjectSetPropertyData(device, &volumeAddress, 0, nil, size, &value) == noErr
    }
}
