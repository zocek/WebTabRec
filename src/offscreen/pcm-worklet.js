export const PCM_PROCESSOR_NAME = 'pcm-worklet-processor';

/**
 * Converts a Float32 audio sample in [-1, 1] to signed 16-bit PCM.
 * Non-finite values resolve to 0; out-of-range values clamp safely.
 *
 * @param {number} sample
 * @returns {number}
 */
export function floatToInt16Sample(sample) {
  if (!Number.isFinite(sample)) {
    return 0;
  }
  const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  if (clamped < 0) {
    return Math.max(-32768, Math.round(clamped * 32768));
  }
  return Math.min(32767, Math.round(clamped * 32767));
}

/**
 * Interleaves stereo Float32 channels into a signed 16-bit PCM Int16Array.
 * Duplicates `leftChannel` when `rightChannel` is absent (mono-to-stereo).
 *
 * @param {Float32Array | number[]} leftChannel
 * @param {Float32Array | number[] | null | undefined} rightChannel
 * @param {number} frameCount
 * @param {Int16Array} targetView
 * @param {number} [targetOffsetSamples=0]
 * @returns {number} Number of samples written (frameCount * 2)
 */
export function interleaveStereoPcm16(
  leftChannel,
  rightChannel,
  frameCount,
  targetView,
  targetOffsetSamples = 0
) {
  const right = rightChannel && rightChannel.length > 0 ? rightChannel : leftChannel;
  let outIdx = targetOffsetSamples;
  for (let i = 0; i < frameCount; i += 1) {
    targetView[outIdx] = floatToInt16Sample(leftChannel[i]);
    targetView[outIdx + 1] = floatToInt16Sample(right[i] ?? leftChannel[i]);
    outIdx += 2;
  }
  return frameCount * 2;
}

const BaseAudioWorkletProcessor = globalThis.AudioWorkletProcessor ?? class {};

export class PcmWorkletProcessor extends BaseAudioWorkletProcessor {
  constructor() {
    super();
    const sr =
      Number.isFinite(globalThis.sampleRate) && globalThis.sampleRate > 0
        ? globalThis.sampleRate
        : 48000;
    this.sampleRate = sr;
    this.chunkFrames = Math.max(128, Math.round(sr));
    this.buffer = new Int16Array(this.chunkFrames * 2);
    this.writeFrame = 0;
    this.paused = false;
    this.stopped = false;

    if (this.port) {
      this.port.onmessage = (event) => {
        const type = event?.data?.type;
        if (type === 'pause') {
          this._flush(false);
          this.paused = true;
          this.port.postMessage({ type: 'paused' });
        } else if (type === 'resume') {
          this.paused = false;
          this.port.postMessage({ type: 'resumed' });
        } else if (type === 'flush') {
          this._flush(false);
          this.port.postMessage({ type: 'flushed', final: false });
        } else if (type === 'stop') {
          this._flush(true);
          this.stopped = true;
          this.port.postMessage({ type: 'flushed', final: true });
        }
      };
    }
  }

  _flush(final = false) {
    if (this.writeFrame <= 0 || !this.port) {
      return;
    }
    const sampleCount = this.writeFrame * 2;
    const out = this.buffer.slice(0, sampleCount);
    this.writeFrame = 0;
    this.port.postMessage(
      {
        type: 'pcm',
        buffer: out.buffer,
        byteLength: out.byteLength,
        sampleCount,
        final
      },
      [out.buffer]
    );
  }

  process(inputs) {
    if (this.stopped) {
      return false;
    }
    if (this.paused) {
      return true;
    }

    const input = inputs?.[0];
    if (!input || input.length === 0) {
      return true;
    }

    const left = input[0];
    if (!left || left.length === 0) {
      return true;
    }
    const right = input[1] && input[1].length > 0 ? input[1] : left;
    const totalFrames = left.length;

    let offset = 0;
    while (offset < totalFrames) {
      const space = this.chunkFrames - this.writeFrame;
      const take = Math.min(space, totalFrames - offset);
      interleaveStereoPcm16(
        left.subarray(offset, offset + take),
        right.subarray(offset, offset + take),
        take,
        this.buffer,
        this.writeFrame * 2
      );
      this.writeFrame += take;
      offset += take;

      if (this.writeFrame >= this.chunkFrames) {
        this._flush(false);
      }
    }

    return true;
  }
}

if (typeof globalThis.registerProcessor === 'function') {
  globalThis.registerProcessor(PCM_PROCESSOR_NAME, PcmWorkletProcessor);
}
