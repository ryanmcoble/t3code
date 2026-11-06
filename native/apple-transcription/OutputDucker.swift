import AudioToolbox
import CoreAudio
import Foundation

/// Lowers the default output device's volume while dictating, so music or video
/// keeps playing quietly, and puts it back when recording ends.
///
/// The original volume is restored on every exit path the helper controls: stop,
/// cancel, errors and SIGTERM/SIGINT/SIGHUP. If the volume was changed while
/// recording, that change is kept instead.
final class OutputDucker {
    private static var active: OutputDucker?
    private static var signalSources: [DispatchSourceSignal] = []

    private let device: AudioDeviceID
    private let original: Float32
    private let lowered: Float32

    private init(device: AudioDeviceID, original: Float32, lowered: Float32) {
        self.device = device
        self.original = original
        self.lowered = lowered
    }

    /// Lowers output to `fraction` of its current volume. Returns nil (and changes
    /// nothing) when the device has no settable volume or is already quiet.
    @discardableResult
    static func duck(to fraction: Float32) -> OutputDucker? {
        guard active == nil, fraction > 0, fraction < 1,
              let device = defaultOutputDevice(),
              isVolumeSettable(device),
              let original = volume(of: device), original > 0.02
        else { return nil }
        let lowered = max(0.01, original * fraction)
        guard setVolume(lowered, of: device) else { return nil }
        let ducker = OutputDucker(device: device, original: original, lowered: lowered)
        active = ducker
        installSignalHandlers()
        return ducker
    }

    /// Restores the volume saved by `duck`, unless it was changed meanwhile.
    static func restore() {
        guard let ducker = active else { return }
        active = nil
        if let current = volume(of: ducker.device), abs(current - ducker.lowered) < 0.02 {
            _ = setVolume(ducker.original, of: ducker.device)
        }
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

    private static func defaultOutputDevice() -> AudioDeviceID? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
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
