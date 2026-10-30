import type { VoiceInputSettings } from "@t3tools/contracts";
import { VoiceTranscriptionError, throwIfVoiceTranscriptionAborted } from "./transcription.ts";

export function voiceServerUrl(baseUrl: string, resource: "models" | "audio/transcriptions") {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new VoiceTranscriptionError(
      "preparation-failed",
      "Enter a valid transcription server URL.",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new VoiceTranscriptionError(
      "preparation-failed",
      "Use an HTTP or HTTPS server URL without credentials, query parameters, or a fragment.",
    );
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path.endsWith("/v1") ? path : `${path}/v1`}/${resource}`;
  return url.href;
}

function authorization(settings: VoiceInputSettings) {
  const headers = new Headers();
  if (settings.apiKey.trim()) headers.set("Authorization", `Bearer ${settings.apiKey.trim()}`);
  return headers;
}

async function requireSuccess(response: Response) {
  if (response.ok) return;
  throw new VoiceTranscriptionError(
    "transcription-failed",
    response.status === 401 || response.status === 403
      ? "The transcription server rejected the API key."
      : `The transcription server returned HTTP ${response.status}.`,
  );
}

export async function listVoiceServerModels(
  settings: VoiceInputSettings,
  signal: AbortSignal,
  request = globalThis.fetch,
): Promise<readonly string[]> {
  throwIfVoiceTranscriptionAborted(signal);
  const response = await request(voiceServerUrl(settings.serverUrl, "models"), {
    headers: authorization(settings),
    signal,
    redirect: "error",
  });
  await requireSuccess(response);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data)) {
    throw new VoiceTranscriptionError(
      "transcription-failed",
      "The server did not return a model list.",
    );
  }
  return body.data.flatMap((entry: unknown) =>
    entry && typeof entry === "object" && "id" in entry && typeof entry.id === "string"
      ? [entry.id]
      : [],
  );
}

export async function transcribeOnVoiceServer(
  settings: VoiceInputSettings,
  audio: Blob,
  signal: AbortSignal,
  request = globalThis.fetch,
): Promise<string> {
  throwIfVoiceTranscriptionAborted(signal);
  if (!settings.model.trim()) {
    throw new VoiceTranscriptionError(
      "preparation-failed",
      "Enter a transcription model in Chat settings.",
    );
  }
  const form = new FormData();
  form.set("file", audio, "dictation.wav");
  form.set("model", settings.model.trim());
  form.set("response_format", "json");
  if (settings.language.trim()) form.set("language", settings.language.trim().split(/[-_]/)[0]!);
  const response = await request(voiceServerUrl(settings.serverUrl, "audio/transcriptions"), {
    method: "POST",
    headers: authorization(settings),
    body: form,
    signal,
    redirect: "error",
  });
  await requireSuccess(response);
  const body: unknown = await response.json();
  throwIfVoiceTranscriptionAborted(signal);
  if (!body || typeof body !== "object" || !("text" in body) || typeof body.text !== "string") {
    throw new VoiceTranscriptionError(
      "transcription-failed",
      "The server did not return a text transcript.",
    );
  }
  return body.text.trim();
}
