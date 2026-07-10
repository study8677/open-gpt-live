export interface PublicVadEnvironment {
  speechThreshold?: string;
  silenceThreshold?: string;
  startDebounceMs?: string;
  hangoverMs?: string;
  maxTurnMs?: string;
  preRollMs?: string;
  playbackThresholdMultiplier?: string;
  playbackSuppressAfterEndMs?: string;
}

export interface VadConfig {
  speechThreshold: number;
  silenceThreshold: number;
  startDebounceMs: number;
  hangoverMs: number;
  maxTurnMs: number;
  preRollMs: number;
  playbackThresholdMultiplier: number;
  playbackSuppressAfterEndMs: number;
}

export const DEFAULT_VAD_CONFIG: VadConfig = {
  speechThreshold: 0.02,
  silenceThreshold: 0.012,
  startDebounceMs: 160,
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

  return {
    speechThreshold,
    // Hysteresis only works when the silence threshold is below speech start.
    silenceThreshold: Math.min(requestedSilenceThreshold, speechThreshold * 0.9),
    startDebounceMs: readNumber(
      environment.startDebounceMs,
      DEFAULT_VAD_CONFIG.startDebounceMs,
      0,
      2_000
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
