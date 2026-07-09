export type LLMRole = "system" | "user" | "assistant";

export interface LLMMessage {
  role: LLMRole;
  content: string;
}

export interface LLMStreamChunk {
  delta: string;
}

export interface ProviderCallOptions {
  signal?: AbortSignal;
}

export interface STTAudioInput {
  data: Uint8Array;
  mimeType: string;
  filename?: string;
}

export interface LLMProvider {
  streamText(
    messages: LLMMessage[],
    options?: ProviderCallOptions
  ): AsyncIterable<LLMStreamChunk>;
}

export interface STTProvider {
  transcribe(input: STTAudioInput, options?: ProviderCallOptions): Promise<{
    text: string;
  }>;
}

export interface TTSProvider {
  synthesize(text: string, options?: ProviderCallOptions): AsyncIterable<Uint8Array>;
}

export interface OpenAILLMProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface OpenAIWhisperProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

interface OpenAIChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string;
    };
  }>;
}

export class OpenAILLMProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(config: OpenAILLMProviderConfig = {}) {
    this.apiKey = firstNonEmpty(config.apiKey, process.env.OPENAI_API_KEY) ?? "";
    this.baseUrl = stripTrailingSlash(
      firstNonEmpty(config.baseUrl, process.env.OPENAI_BASE_URL) ??
        "https://api.openai.com/v1"
    );
    this.model =
      firstNonEmpty(config.model, process.env.OPENAI_MODEL) ?? "gpt-4o-mini";
  }

  async *streamText(
    messages: LLMMessage[],
    options: ProviderCallOptions = {}
  ): AsyncIterable<LLMStreamChunk> {
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is required");
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: true
      }),
      signal: options.signal
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI-compatible API error ${response.status}: ${body}`);
    }

    if (!response.body) {
      throw new Error("OpenAI-compatible API returned no response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const event of events) {
          for (const data of readSseDataLines(event)) {
            if (data === "[DONE]") {
              return;
            }

            const parsed = JSON.parse(data) as OpenAIChatCompletionChunk;
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              yield { delta };
            }
          }
        }
      }
    } catch (error) {
      if (options.signal?.aborted) {
        return;
      }
      throw error;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}

export class OpenAIWhisperProvider implements STTProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(config: OpenAIWhisperProviderConfig = {}) {
    this.apiKey = firstNonEmpty(
      config.apiKey,
      process.env.STT_API_KEY,
      process.env.OPENAI_API_KEY
    ) ?? "";
    this.baseUrl = stripTrailingSlash(
      firstNonEmpty(
        config.baseUrl,
        process.env.STT_BASE_URL,
        process.env.OPENAI_BASE_URL
      ) ??
        "https://api.openai.com/v1"
    );
    this.model = firstNonEmpty(config.model, process.env.STT_MODEL) ?? "whisper-1";
  }

  async transcribe(
    input: STTAudioInput,
    options: ProviderCallOptions = {}
  ): Promise<{ text: string }> {
    if (!this.apiKey) {
      throw new Error("STT_API_KEY or OPENAI_API_KEY is required");
    }

    const formData = new FormData();
    formData.append("model", this.model);
    formData.append(
      "file",
      new Blob([input.data], { type: input.mimeType }),
      input.filename ?? filenameForMimeType(input.mimeType)
    );

    const response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`
      },
      body: formData,
      signal: options.signal
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI-compatible STT API error ${response.status}: ${body}`);
    }

    const parsed = (await response.json()) as { text?: unknown };
    if (typeof parsed.text !== "string") {
      throw new Error("OpenAI-compatible STT API returned no text");
    }

    return { text: parsed.text };
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0);
}

function filenameForMimeType(mimeType: string): string {
  if (mimeType.includes("webm")) {
    return "recording.webm";
  }
  if (mimeType.includes("mp4")) {
    return "recording.mp4";
  }
  if (mimeType.includes("mpeg")) {
    return "recording.mp3";
  }
  if (mimeType.includes("wav")) {
    return "recording.wav";
  }
  return "recording.webm";
}

function readSseDataLines(event: string): string[] {
  return event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter(Boolean);
}
