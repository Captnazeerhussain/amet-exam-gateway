const VIRTUAL_CAMERA_LABEL_RE =
  /\b(obs|virtual|manycam|snap camera|droidcam|iriun|epoccam|fake_device|v4l2loopback|splitcam|youcam)\b/i;

const BLACK_MEAN_LUMA_THRESHOLD = 14;
const COVERED_MEAN_LUMA_THRESHOLD = 25;
const COVERED_STDDEV_LUMA_THRESHOLD = 4;
const SPEECH_SPIKE_RMS_THRESHOLD = 0.08;

/**
 * Compute BT.601 perceptual luma for an RGB pixel.
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {number}
 */
function computeBt601Luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Validate webcam and microphone track states and block known virtual/fake camera devices.
 * @param {{
 *   videoLabel: string,
 *   videoReadyState: string,
 *   videoMuted?: boolean,
 *   audioLabel: string,
 *   audioReadyState: string,
 *   audioMuted?: boolean
 * } | null | undefined} tracks
 * @returns {{ valid: boolean, reason: string | null }}
 */
export function validateMediaTracks(tracks) {
  if (!tracks || tracks.videoReadyState !== 'live' || tracks.videoMuted === true) {
    return { valid: false, reason: 'CAMERA_INACTIVE' };
  }

  const videoLabel = typeof tracks.videoLabel === 'string' ? tracks.videoLabel : '';
  if (VIRTUAL_CAMERA_LABEL_RE.test(videoLabel)) {
    return { valid: false, reason: 'VIRTUAL_CAMERA_BLOCKED' };
  }

  if (tracks.audioReadyState !== 'live' || tracks.audioMuted === true) {
    return { valid: false, reason: 'MIC_INACTIVE' };
  }

  return { valid: true, reason: null };
}

/**
 * Analyze RGBA canvas pixel buffer luma statistics to detect black or physically covered lenses.
 * @param {Uint8ClampedArray | number[] | null | undefined} rgbaPixels
 * @returns {{ meanLuma: number, stdDevLuma: number, isBlackOrCovered: boolean }}
 */
export function analyzeVideoFrame(rgbaPixels) {
  if (!rgbaPixels || rgbaPixels.length < 4) {
    return { meanLuma: 0, stdDevLuma: 0, isBlackOrCovered: true };
  }

  const pixelCount = Math.floor(rgbaPixels.length / 4);
  const byteLimit = pixelCount * 4;

  let lumaSum = 0;
  for (let i = 0; i < byteLimit; i += 4) {
    lumaSum += computeBt601Luma(rgbaPixels[i], rgbaPixels[i + 1], rgbaPixels[i + 2]);
  }
  const meanLuma = lumaSum / pixelCount;

  let squaredDiffSum = 0;
  for (let i = 0; i < byteLimit; i += 4) {
    const diff =
      computeBt601Luma(rgbaPixels[i], rgbaPixels[i + 1], rgbaPixels[i + 2]) - meanLuma;
    squaredDiffSum += diff * diff;
  }
  const stdDevLuma = Math.sqrt(squaredDiffSum / pixelCount);

  const isBlackOrCovered =
    meanLuma < BLACK_MEAN_LUMA_THRESHOLD ||
    (meanLuma < COVERED_MEAN_LUMA_THRESHOLD && stdDevLuma < COVERED_STDDEV_LUMA_THRESHOLD);

  return { meanLuma, stdDevLuma, isBlackOrCovered };
}

/**
 * Classify an already-computed RMS level (e.g. averaged over several analyser windows).
 * @param {number} rms
 * @returns {{ rms: number, isSpeechSpike: boolean }}
 */
export function classifyAudioRms(rms) {
  const level = Number.isFinite(rms) && rms > 0 ? rms : 0;
  return { rms: level, isSpeechSpike: level >= SPEECH_SPIKE_RMS_THRESHOLD };
}

/**
 * Compute normalized time-domain audio RMS and flag speech spikes.
 * @param {Float32Array | number[] | null | undefined} timeDomainSamples
 * @returns {{ rms: number, isSpeechSpike: boolean }}
 */
export function analyzeAudioSamples(timeDomainSamples) {
  if (!timeDomainSamples || timeDomainSamples.length === 0) {
    return { rms: 0, isSpeechSpike: false };
  }

  let sumSquares = 0;
  for (let i = 0; i < timeDomainSamples.length; i += 1) {
    const sample = timeDomainSamples[i];
    sumSquares += sample * sample;
  }

  const rms = Math.sqrt(sumSquares / timeDomainSamples.length);
  return {
    rms,
    isSpeechSpike: rms >= SPEECH_SPIKE_RMS_THRESHOLD,
  };
}
