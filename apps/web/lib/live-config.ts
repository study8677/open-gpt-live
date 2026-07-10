export interface PublicVadEnvironment {
  adaptiveEnabled?: string;
  calibrationMs?: string;
  noiseFloorSmoothing?: string;
  speechNoiseMultiplier?: string;
  silenceNoiseMultiplier?: string;
  dynamicSpeechMin?: string;
  dynamicSpeechMax?: string;
  dynamicSilenceMin?: string;
  dynamicSilenceMax?: string;
  speechThreshold?: string;
  silenceThreshold?: string;
  startDebounceMs?: string;
  minimumSpeechMs?: string;
  hangoverMs?: string;
  maxTurnMs?: string;
  preRollMs?: string;
  playbackThresholdMultiplier?: string;
  playbackSuppressAfterEndMs?: string;
}

export interface VadConfig {
  adaptiveEnabled: boolean;
  calibrationMs: number;
  noiseFloorSmoothing: number;
  speechNoiseMultiplier: number;
  silenceNoiseMultiplier: number;
  dynamicSpeechMin: number;
  dynamicSpeechMax: number;
  dynamicSilenceMin: number;
  dynamicSilenceMax: number;
  speechThreshold: number;
  silenceThreshold: number;
  startDebounceMs: number;
  minimumSpeechMs: number;
  hangoverMs: number;
  maxTurnMs: number;
  preRollMs: number;
  playbackThresholdMultiplier: number;
  playbackSuppressAfterEndMs: number;
}

export const DEFAULT_VAD_CONFIG: VadConfig = {
  adaptiveEnabled: true,
  calibrationMs: 1_000,
  noiseFloorSmoothing: 0.08,
  speechNoiseMultiplier: 3,
  silenceNoiseMultiplier: 1.8,
  dynamicSpeechMin: 0.012,
  dynamicSpeechMax: 0.12,
  dynamicSilenceMin: 0.006,
  dynamicSilenceMax: 0.08,
  speechThreshold: 0.02,
  silenceThreshold: 0.012,
  startDebounceMs: 160,
  minimumSpeechMs: 200,
  hangoverMs: 750,
  maxTurnMs: 30_000,
  preRollMs: 400,
  playbackThresholdMultiplier: 2.5,
  playbackSuppressAfterEndMs: 300
};

/**
 * Resolve browser VAD settings from statically-inlined NEXT_PUBLIC_* values.
 * Invalid or unsafe values fall back to conservative defaults.
 */
export function resolveVadConfig(
  environment: PublicVadEnvironment
): VadConfig {
  const dynamicSpeechMin = readNumber(
    environment.dynamicSpeechMin,
    DEFAULT_VAD_CONFIG.dynamicSpeechMin,
    0.0005,
    0.5
  );
  const dynamicSpeechMax = Math.max(
    dynamicSpeechMin,
    readNumber(
      environment.dynamicSpeechMax,
      DEFAULT_VAD_CONFIG.dynamicSpeechMax,
      0.001,
      1
    )
  );
  const dynamicSilenceMin = readNumber(
    environment.dynamicSilenceMin,
    DEFAULT_VAD_CONFIG.dynamicSilenceMin,
    0.0001,
    0.5
  );
  const dynamicSilenceMax = Math.max(
    dynamicSilenceMin,
    readNumber(
      environment.dynamicSilenceMax,
      DEFAULT_VAD_CONFIG.dynamicSilenceMax,
      0.0005,
      1
    )
  );
  const speechThreshold = readNumber(
    environment.speechThreshold,
    DEFAULT_VAD_CONFIG.speechThreshold,
    0.001,
    1
  );
  const requestedSilenceThreshold = readNumber(
    environment.silenceThreshold,
    DEFAULT_VAD_CONFIG.silenceThreshold,
    0.0005,
    1
  );
  const hangoverMs = readNumber(
    environment.hangoverMs,
    DEFAULT_VAD_CONFIG.hangoverMs,
    250,
    5_000
  );
  const boundedDynamicSilenceMin = Math.min(
    dynamicSilenceMin,
    dynamicSpeechMax * 0.9
  );
  const boundedDynamicSilenceMax = Math.max(
    boundedDynamicSilenceMin,
    Math.min(dynamicSilenceMax, dynamicSpeechMax * 0.9)
  );

  return {
    adaptiveEnabled: readBoolean(
      environment.adaptiveEnabled,
      DEFAULT_VAD_CONFIG.adaptiveEnabled
    ),
    calibrationMs: readNumber(
      environment.calibrationMs,
      DEFAULT_VAD_CONFIG.calibrationMs,
      200,
      10_000
    ),
    noiseFloorSmoothing: readNumber(
      environment.noiseFloorSmoothing,
      DEFAULT_VAD_CONFIG.noiseFloorSmoothing,
      0.001,
      1
    ),
    speechNoiseMultiplier: readNumber(
      environment.speechNoiseMultiplier,
      DEFAULT_VAD_CONFIG.speechNoiseMultiplier,
      1.1,
      20
    ),
    silenceNoiseMultiplier: readNumber(
      environment.silenceNoiseMultiplier,
      DEFAULT_VAD_CONFIG.silenceNoiseMultiplier,
      1,
      15
    ),
    dynamicSpeechMin,
    dynamicSpeechMax,
    dynamicSilenceMin: boundedDynamicSilenceMin,
    dynamicSilenceMax: boundedDynamicSilenceMax,
    speechThreshold,
    // Hysteresis only works when the silence threshold is below speech start.
    silenceThreshold: Math.min(requestedSilenceThreshold, speechThreshold * 0.9),
    startDebounceMs: readNumber(
      environment.startDebounceMs,
      DEFAULT_VAD_CONFIG.startDebounceMs,
      0,
      2_000
    ),
    minimumSpeechMs: readNumber(
      environment.minimumSpeechMs,
      DEFAULT_VAD_CONFIG.minimumSpeechMs,
      0,
      5_000
    ),
    hangoverMs,
    maxTurnMs: readNumber(
      environment.maxTurnMs,
      DEFAULT_VAD_CONFIG.maxTurnMs,
      1_000,
      120_000
    ),
    // The delayed recording stream must catch up before the VAD hangover ends.
    preRollMs: Math.min(
      readNumber(
        environment.preRollMs,
        DEFAULT_VAD_CONFIG.preRollMs,
        0,
        1_000
      ),
      hangoverMs
    ),
    playbackThresholdMultiplier: readNumber(
      environment.playbackThresholdMultiplier,
      DEFAULT_VAD_CONFIG.playbackThresholdMultiplier,
      1,
      10
    ),
    playbackSuppressAfterEndMs: readNumber(
      environment.playbackSuppressAfterEndMs,
      DEFAULT_VAD_CONFIG.playbackSuppressAfterEndMs,
      0,
      5_000
    )
  };
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return fallback;
}

function readNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    return fallback;
  }

  return parsed;
}
