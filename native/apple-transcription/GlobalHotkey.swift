import Carbon
import AppKit
import Foundation

private func dispatchDictationHotkey(_ handler: EventHandlerCallRef?, _ event: EventRef?, _ context: UnsafeMutableRawPointer?) -> OSStatus {
    guard let event else { return OSStatus(eventNotHandledErr) }
    let kind = GetEventKind(event)
    guard kind == UInt32(kEventHotKeyPressed) || kind == UInt32(kEventHotKeyReleased) else {
        return OSStatus(eventNotHandledErr)
    }
    try? AppleTranscription.emit(["event": kind == UInt32(kEventHotKeyPressed) ? "pressed" : "released"])
    return noErr
}

enum GlobalDictationHotkey {
    static func keyCode(_ key: String) -> UInt32? {
        let named: [String: Int] = [" ": kVK_Space, "enter": kVK_Return, "escape": kVK_Escape, "tab": kVK_Tab,
            "arrowleft": kVK_LeftArrow, "arrowright": kVK_RightArrow, "arrowup": kVK_UpArrow, "arrowdown": kVK_DownArrow,
            "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5, "f6": kVK_F6,
            "f7": kVK_F7, "f8": kVK_F8, "f9": kVK_F9, "f10": kVK_F10, "f11": kVK_F11, "f12": kVK_F12,
            "f13": kVK_F13, "f14": kVK_F14, "f15": kVK_F15, "f16": kVK_F16, "f17": kVK_F17, "f18": kVK_F18, "f19": kVK_F19, "f20": kVK_F20]
        if let code = named[key] { return UInt32(code) }
        guard let input = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let property = TISGetInputSourceProperty(input, kTISPropertyUnicodeKeyLayoutData) else { return nil }
        let data = Unmanaged<CFData>.fromOpaque(property).takeUnretainedValue()
        let layout = unsafeBitCast(CFDataGetBytePtr(data), to: UnsafePointer<UCKeyboardLayout>.self)
        for code in UInt16(0)..<128 {
            var dead: UInt32 = 0
            var count = 0
            var characters = [UniChar](repeating: 0, count: 8)
            let status = UCKeyTranslate(layout, code, UInt16(kUCKeyActionDown), 0, UInt32(LMGetKbdType()), OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, characters.count, &count, &characters)
            if status == noErr && String(utf16CodeUnits: characters, count: count).lowercased() == key.lowercased() { return UInt32(code) }
        }
        return nil
    }

    static func run(_ args: [String]) throws {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        guard args.count == 3, let key = keyCode(args[1]), let modifiers = UInt32(args[2]) else {
            throw TranscriptionFailure(message: "Invalid global dictation shortcut.")
        }
        var handler: EventHandlerRef?
        var events = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
        ]
        guard InstallEventHandler(GetApplicationEventTarget(), dispatchDictationHotkey, events.count, &events, nil, &handler) == noErr else {
            throw TranscriptionFailure(message: "Could not listen for the global dictation shortcut.")
        }
        defer { if let handler { RemoveEventHandler(handler) } }
        var shortcut: EventHotKeyRef?
        guard RegisterEventHotKey(key, modifiers, EventHotKeyID(signature: 0x54335649, id: 1), GetApplicationEventTarget(), OptionBits(kEventHotKeyExclusive), &shortcut) == noErr else {
            throw TranscriptionFailure(message: "The global dictation shortcut is already in use. Choose another shortcut.")
        }
        defer { if let shortcut { UnregisterEventHotKey(shortcut) } }
        try AppleTranscription.emit(["event": "ready"])
        DispatchQueue.global().async {
            while !FileHandle.standardInput.availableData.isEmpty {}
            exit(0)
        }
        app.run()
    }
}
