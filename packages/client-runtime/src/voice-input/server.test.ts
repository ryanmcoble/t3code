import { describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_VOICE_INPUT_SETTINGS } from "@t3tools/contracts";
import { listVoiceServerModels, transcribeOnVoiceServer, voiceServerUrl } from "./server.ts";
import { encodeVoiceWav } from "./wav.ts";

const settings = {
  ...DEFAULT_VOICE_INPUT_SETTINGS,
  engine: "server" as const,
  serverUrl: "http://localhost:8000/v1/",
  model: "mlx-community/test",
  language: "en-US",
  apiKey: "local-key",
};

describe("transcription server protocol", () => {
  it.each([
    ["http://localhost:8000", "http://localhost:8000/v1/audio/transcriptions"],
    ["https://speech.example/api/v1/", "https://speech.example/api/v1/audio/transcriptions"],
    ["https://speech.example/api/", "https://speech.example/api/v1/audio/transcriptions"],
  ])("resolves the API endpoint from %s", (base, expected) => {
    expect(voiceServerUrl(base, "audio/transcriptions")).toBe(expected);
  });

  it.each([
    "file:///tmp/audio",
    "http://name:secret@localhost",
    "https://speech.example?token=secret",
    "https://speech.example#fragment",
    "localhost:8000",
  ])("rejects an invalid or credential-bearing base URL: %s", (base) => {
    expect(() => voiceServerUrl(base, "models")).toThrow();
  });

  it("sends a portable WAV, explicit model, optional authentication and a JSON response request", async () => {
    const audio = encodeVoiceWav([new Float32Array([0, -1, 1])], 16000);
    const request = vi.fn<typeof fetch>(async (url, options) => {
      expect(url).toBe("http://localhost:8000/v1/audio/transcriptions");
      expect(new Headers(options?.headers).get("Authorization")).toBe("Bearer local-key");
      expect(options?.redirect).toBe("error");
      const form = options?.body as FormData;
      expect(form.get("model")).toBe("mlx-community/test");
      expect(form.get("language")).toBe("en");
      expect(form.get("response_format")).toBe("json");
      const file = form.get("file") as File;
      expect(file.type).toBe("audio/wav");
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio);
      return Response.json({ text: "  Insert this text.  " });
    });
    expect(
      await transcribeOnVoiceServer(
        settings,
        new Blob([audio], { type: "audio/wav" }),
        new AbortController().signal,
        request,
      ),
    ).toBe("Insert this text.");
    const withoutOptionalFields = vi.fn<typeof fetch>(async (_, options) => {
      expect(new Headers(options?.headers).has("Authorization")).toBe(false);
      expect((options!.body as FormData).has("language")).toBe(false);
      return Response.json({ text: "" });
    });
    expect(
      await transcribeOnVoiceServer(
        { ...settings, language: "", apiKey: "" },
        new Blob([audio]),
        new AbortController().signal,
        withoutOptionalFields,
      ),
    ).toBe("");
  });

  it("reports server authentication and malformed response failures without echoing credentials", async () => {
    const signal = new AbortController().signal;
    for (const response of [
      new Response("secret upstream details", { status: 401 }),
      new Response("failure", { status: 503 }),
      Response.json({ unexpected: "shape" }),
    ]) {
      const request = vi.fn<typeof fetch>(async () => response);
      await expect(transcribeOnVoiceServer(settings, new Blob(), signal, request)).rejects.toThrow(
        /API key|HTTP 503|text transcript/,
      );
    }
    await expect(
      listVoiceServerModels(
        settings,
        signal,
        vi.fn<typeof fetch>(async () =>
          Response.json({ data: [{ id: "speech-model" }, { id: 42 }] }),
        ),
      ),
    ).resolves.toEqual(["speech-model"]);
  });

  it("cancels an in-flight request and avoids starting a cancelled request", async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const request = vi.fn<typeof fetch>(
      (_, options) =>
        new Promise((_, reject) => {
          options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), {
            once: true,
          });
          entered();
        }),
    );
    const operation = transcribeOnVoiceServer(settings, new Blob(), controller.signal, request);
    await started;
    controller.abort();
    await expect(operation).rejects.toThrow();
    await expect(
      transcribeOnVoiceServer(settings, new Blob(), controller.signal, request),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

it("encodes stereo audio as clamped mono 16-bit PCM with a valid WAV header", () => {
  const wav = encodeVoiceWav(
    [new Float32Array([-2, 0.5, 1]), new Float32Array([-2, -0.5, 1])],
    16000,
  );
  const view = new DataView(wav.buffer);
  expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
  expect(view.getUint32(4, true)).toBe(wav.length - 8);
  expect(new TextDecoder().decode(wav.subarray(8, 16))).toBe("WAVEfmt ");
  expect(view.getUint16(20, true)).toBe(1);
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint32(24, true)).toBe(16000);
  expect(view.getUint32(28, true)).toBe(32000);
  expect(view.getUint32(40, true)).toBe(6);
  expect([44, 46, 48].map((offset) => view.getInt16(offset, true))).toEqual([-32768, 0, 32767]);
});
