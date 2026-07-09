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

export interface LLMProvider {
  streamText(
    messages: LLMMessage[],
    options?: ProviderCallOptions
  ): AsyncIterable<LLMStreamChunk>;
}

export interface STTProvider {
  transcribe(input: unknown, options?: ProviderCallOptions): Promise<{
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
    this.apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.baseUrl = stripTrailingSlash(
      config.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"
    );
    this.model = config.model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";
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

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function readSseDataLines(event: string): string[] {
  return event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter(Boolean);
}
