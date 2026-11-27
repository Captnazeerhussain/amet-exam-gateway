import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateMediaTracks,
  analyzeVideoFrame,
  analyzeAudioSamples,
} from '../src/core/media-monitor.js';

function makeRgbaFrame(pixels) {
  const arr = new Uint8ClampedArray(pixels.length * 4);
  for (let i = 0; i < pixels.length; i += 1) {
    const [r, g, b, a = 255] = pixels[i];
    const offset = i * 4;
    arr[offset] = r;
    arr[offset + 1] = g;
    arr[offset + 2] = b;
    arr[offset + 3] = a;
  }
  return arr;
}

test('validateMediaTracks accepts live unmuted real camera and microphone', () => {
  assert.deepEqual(
    validateMediaTracks({
      videoLabel: 'Integrated Webcam (04f2:b711)',
      videoReadyState: 'live',
      videoMuted: false,
      audioLabel: 'Built-in Microphone',
      audioReadyState: 'live',
      audioMuted: false,
    }),
    { valid: true, reason: null }
  );

  // Muted flags are optional when undefined
  assert.deepEqual(
    validateMediaTracks({
      videoLabel: 'FaceTime HD Camera',
      videoReadyState: 'live',
      audioLabel: 'MacBook Pro Microphone',
      audioReadyState: 'live',
    }),
    { valid: true, reason: null }
  );
});

test('validateMediaTracks rejects missing, ended, or muted camera as CAMERA_INACTIVE', () => {
  assert.deepEqual(validateMediaTracks(null), {
    valid: false,
    reason: 'CAMERA_INACTIVE',
  });

  assert.deepEqual(
    validateMediaTracks({
      videoLabel: 'Integrated Webcam',
      videoReadyState: 'ended',
      videoMuted: false,
      audioLabel: 'Mic',
      audioReadyState: 'live',
    }),
    { valid: false, reason: 'CAMERA_INACTIVE' }
  );

  assert.deepEqual(
    validateMediaTracks({
      videoLabel: 'Integrated Webcam',
      videoReadyState: 'live',
      videoMuted: true,
      audioLabel: 'Mic',
      audioReadyState: 'live',
    }),
    { valid: false, reason: 'CAMERA_INACTIVE' }
  );
});

test('validateMediaTracks blocks OBS and known virtual/fake camera labels', () => {
  const blockedLabels = [
    'OBS Virtual Camera',
    'OBS-Camera',
    'ManyCam Virtual Webcam',
    'Snap Camera',
    'DroidCam Source 3',
    'Iriun Webcam',
    'EpocCam Camera',
    'fake_device',
    'v4l2loopback video0',
    'SplitCam Video Driver',
    'CyberLink YouCam 9',
  ];

  for (const videoLabel of blockedLabels) {
    assert.deepEqual(
      validateMediaTracks({
        videoLabel,
        videoReadyState: 'live',
        videoMuted: false,
        audioLabel: 'Microphone',
        audioReadyState: 'live',
        audioMuted: false,
      }),
      { valid: false, reason: 'VIRTUAL_CAMERA_BLOCKED' },
      `Expected "${videoLabel}" to be blocked`
    );
  }
});

test('validateMediaTracks does not false-positive on substring inside non-virtual label', () => {
  assert.deepEqual(
    validateMediaTracks({
      videoLabel: 'Logitech C920 Observer Cam',
      videoReadyState: 'live',
      videoMuted: false,
      audioLabel: 'Logitech Mic',
      audioReadyState: 'live',
      audioMuted: false,
    }),
    { valid: true, reason: null }
  );
});

test('validateMediaTracks rejects ended or muted microphone as MIC_INACTIVE', () => {
  assert.deepEqual(
    validateMediaTracks({
      videoLabel: 'Integrated Webcam',
      videoReadyState: 'live',
      videoMuted: false,
      audioLabel: 'Mic',
      audioReadyState: 'ended',
      audioMuted: false,
    }),
    { valid: false, reason: 'MIC_INACTIVE' }
  );

  assert.deepEqual(
    validateMediaTracks({
      videoLabel: 'Integrated Webcam',
      videoReadyState: 'live',
      videoMuted: false,
      audioLabel: 'Mic',
      audioReadyState: 'live',
      audioMuted: true,
    }),
    { valid: false, reason: 'MIC_INACTIVE' }
  );
});

test('analyzeVideoFrame handles empty or insufficient pixel buffers as black/covered', () => {
  assert.deepEqual(analyzeVideoFrame(null), {
    meanLuma: 0,
    stdDevLuma: 0,
    isBlackOrCovered: true,
  });

  assert.deepEqual(analyzeVideoFrame(new Uint8ClampedArray([100, 100, 100])), {
    meanLuma: 0,
    stdDevLuma: 0,
    isBlackOrCovered: true,
  });
});

test('analyzeVideoFrame flags black frames and dim uniform covered-lens frames', () => {
  const blackFrame = makeRgbaFrame([
    [0, 0, 0],
    [0, 0, 0],
    [2, 2, 2],
    [2, 2, 2],
  ]);
  const blackRes = analyzeVideoFrame(blackFrame);
  assert.ok(blackRes.meanLuma < 14);
  assert.equal(blackRes.isBlackOrCovered, true);

  // Dark frame with high variance still flagged when meanLuma < 14
  const darkHighVar = makeRgbaFrame([
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [40, 40, 40],
  ]);
  const darkVarRes = analyzeVideoFrame(darkHighVar);
  assert.equal(darkVarRes.meanLuma, 10);
  assert.ok(darkVarRes.stdDevLuma > 10);
  assert.equal(darkVarRes.isBlackOrCovered, true);

  // Dim uniform frame (meanLuma between 14 and 25, stdDevLuma < 4)
  const coveredFinger = makeRgbaFrame([
    [18, 18, 18],
    [20, 20, 20],
    [20, 20, 20],
    [22, 22, 22],
  ]);
  const coveredRes = analyzeVideoFrame(coveredFinger);
  assert.equal(coveredRes.meanLuma, 20);
  assert.ok(coveredRes.stdDevLuma < 4);
  assert.equal(coveredRes.isBlackOrCovered, true);
});

test('analyzeVideoFrame allows dim textured frames and bright uniform or varied frames', () => {
  // Dim but varied texture (meanLuma = 20, stdDevLuma = 10 >= 4)
  const dimVaried = makeRgbaFrame([
    [10, 10, 10],
    [10, 10, 10],
    [30, 30, 30],
    [30, 30, 30],
  ]);
  const dimVariedRes = analyzeVideoFrame(dimVaried);
  assert.equal(dimVariedRes.meanLuma, 20);
  assert.equal(dimVariedRes.stdDevLuma, 10);
  assert.equal(dimVariedRes.isBlackOrCovered, false);

  // Normal lit frame using BT.601 weights
  const litFrame = [
    100, 150, 200, 255,
    50, 80, 110, 255,
  ];
  const expectedLuma1 = 0.299 * 100 + 0.587 * 150 + 0.114 * 200;
  const expectedLuma2 = 0.299 * 50 + 0.587 * 80 + 0.114 * 110;
  const expectedMean = (expectedLuma1 + expectedLuma2) / 2;
  const expectedStd = Math.sqrt(
    ((expectedLuma1 - expectedMean) ** 2 + (expectedLuma2 - expectedMean) ** 2) / 2
  );

  const litRes = analyzeVideoFrame(litFrame);
  assert.ok(Math.abs(litRes.meanLuma - expectedMean) < 1e-9);
  assert.ok(Math.abs(litRes.stdDevLuma - expectedStd) < 1e-9);
  assert.equal(litRes.isBlackOrCovered, false);
});

test('analyzeAudioSamples computes RMS and flags speech spikes at threshold 0.08', () => {
  assert.deepEqual(analyzeAudioSamples(null), { rms: 0, isSpeechSpike: false });
  assert.deepEqual(analyzeAudioSamples(new Float32Array(0)), { rms: 0, isSpeechSpike: false });

  const quiet = new Float32Array([0.01, -0.01, 0.02, -0.02]);
  const quietRes = analyzeAudioSamples(quiet);
  assert.ok(Math.abs(quietRes.rms - Math.sqrt((0.0001 + 0.0001 + 0.0004 + 0.0004) / 4)) < 1e-6);
  assert.equal(quietRes.isSpeechSpike, false);

  // Exactly at threshold 0.08
  const threshold = [0.08, -0.08, 0.08, -0.08];
  const thresholdRes = analyzeAudioSamples(threshold);
  assert.ok(Math.abs(thresholdRes.rms - 0.08) < 1e-9);
  assert.equal(thresholdRes.isSpeechSpike, true);

  // Loud speech spike
  const loud = new Float32Array([0.3, -0.4, 0.5, -0.2]);
  const loudRes = analyzeAudioSamples(loud);
  assert.ok(Math.abs(loudRes.rms - Math.sqrt((0.09 + 0.16 + 0.25 + 0.04) / 4)) < 1e-6);
  assert.equal(loudRes.isSpeechSpike, true);
});
