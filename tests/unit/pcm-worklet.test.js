import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PCM_PROCESSOR_NAME,
  PcmWorkletProcessor,
  floatToInt16Sample,
  interleaveStereoPcm16
} from '../../src/offscreen/pcm-worklet.js';

function withMockWorkletGlobals(sampleRate, fn) {
  const prevProcessor = globalThis.AudioWorkletProcessor;
  const prevRegister = globalThis.registerProcessor;
  const prevSampleRate = globalThis.sampleRate;

  class StubWorkletProcessor {
    constructor() {
      const ch = new MessageChannel();
      this.port = ch.port1;
      this.nodePort = ch.port2;
      this.port.unref?.();
      this.nodePort.unref?.();
    }
  }

  const registered = new Map();
  globalThis.AudioWorkletProcessor = StubWorkletProcessor;
  globalThis.registerProcessor = (name, cls) => registered.set(name, cls);
  globalThis.sampleRate = sampleRate;

  return Promise.resolve()
    .then(() => fn({ registered }))
    .finally(() => {
      globalThis.AudioWorkletProcessor = prevProcessor;
      globalThis.registerProcessor = prevRegister;
      globalThis.sampleRate = prevSampleRate;
    });
}

test('floatToInt16Sample converts, clamps, and handles non-finite inputs', () => {
  assert.equal(floatToInt16Sample(0), 0);
  assert.equal(floatToInt16Sample(1), 32767);
  assert.equal(floatToInt16Sample(-1), -32768);
  assert.equal(floatToInt16Sample(2.5), 32767);
  assert.equal(floatToInt16Sample(-3.1), -32768);
  assert.equal(floatToInt16Sample(NaN), 0);
  assert.equal(floatToInt16Sample(Infinity), 0);
  assert.equal(floatToInt16Sample(-Infinity), 0);
  assert.equal(floatToInt16Sample(0.5), 16384);
  assert.equal(floatToInt16Sample(-0.5), -16384);
});

test('interleaveStereoPcm16 writes stereo frames and duplicates mono to right channel', () => {
  const target = new Int16Array(8);
  const written = interleaveStereoPcm16(
    new Float32Array([0.5, -0.5]),
    new Float32Array([-0.25, 0.25]),
    2,
    target,
    0
  );
  assert.equal(written, 4);
  assert.deepEqual([...target.subarray(0, 4)], [16384, -8192, -16384, 8192]);

  const monoWritten = interleaveStereoPcm16(
    new Float32Array([0.5, -0.5]),
    null,
    2,
    target,
    4
  );
  assert.equal(monoWritten, 4);
  assert.deepEqual([...target.subarray(4, 8)], [16384, 16384, -16384, -16384]);
});

test('PcmWorkletProcessor chunks ~1s stereo PCM based on sampleRate and supports pause/resume/flush/stop', async () => {
  assert.equal(PCM_PROCESSOR_NAME, 'pcm-worklet-processor');

  await withMockWorkletGlobals(44100, async () => {
    const prevBase = globalThis.AudioWorkletProcessor;
    const prevSr = globalThis.sampleRate;
    // Import a fresh module copy so class extends StubWorkletProcessor with port
    const url = new URL('../../src/offscreen/pcm-worklet.js', import.meta.url);
    url.searchParams.set('t', String(Date.now()));
    const mod = await import(url.href);
    const proc = new mod.PcmWorkletProcessor();
    assert.equal(proc.sampleRate, 44100);
    assert.equal(proc.chunkFrames, 44100);

    const messages = [];
    proc.nodePort.onmessage = (ev) => messages.push(ev.data);

    // Empty inputs keep processor alive without emitting
    assert.equal(proc.process([]), true);
    assert.equal(proc.process([[]]), true);

    // Feed 345 * 128 = 44160 frames (> 1s at 44.1kHz)
    for (let i = 0; i < 345; i += 1) {
      proc.process([[new Float32Array(128).fill(0.25), new Float32Array(128).fill(-0.25)]]);
    }
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'pcm');
    assert.equal(messages[0].byteLength, 44100 * 4);

    // Pause flushes the remaining 60 frames and ignores new audio while paused
    proc.nodePort.postMessage({ type: 'pause' });
    await new Promise((r) => setTimeout(r, 20));
    const afterPausePcm = messages.filter((m) => m.type === 'pcm');
    assert.equal(afterPausePcm.length, 2);
    assert.equal(afterPausePcm[1].byteLength, 60 * 4);
    assert.ok(messages.some((m) => m.type === 'paused'));

    proc.process([[new Float32Array(128).fill(0.5), new Float32Array(128).fill(0.5)]]);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(messages.filter((m) => m.type === 'pcm').length, 2);

    // Resume, feed 128 frames, then flush
    proc.nodePort.postMessage({ type: 'resume' });
    await new Promise((r) => setTimeout(r, 15));
    assert.ok(messages.some((m) => m.type === 'resumed'));
    proc.process([[new Float32Array(128).fill(0.5), new Float32Array(128).fill(-0.5)]]);
    proc.nodePort.postMessage({ type: 'flush' });
    await new Promise((r) => setTimeout(r, 20));
    const afterFlushPcm = messages.filter((m) => m.type === 'pcm');
    const afterFlushAck = messages.filter((m) => m.type === 'flushed');
    assert.equal(afterFlushPcm.length, 3);
    assert.equal(afterFlushPcm[2].byteLength, 128 * 4);
    assert.equal(afterFlushAck.length, 1);
    assert.equal(afterFlushAck[0].final, false);

    // Feed 64 frames and stop -> final flush + stopped=true (process returns false)
    proc.process([[new Float32Array(64).fill(0.1), new Float32Array(64).fill(0.1)]]);
    proc.nodePort.postMessage({ type: 'stop' });
    await new Promise((r) => setTimeout(r, 20));
    const finalPcm = messages.filter((m) => m.type === 'pcm');
    const finalAck = messages.filter((m) => m.type === 'flushed');
    assert.equal(finalPcm.length, 4);
    assert.equal(finalPcm[3].final, true);
    assert.equal(finalPcm[3].byteLength, 64 * 4);
    assert.equal(finalAck.length, 2);
    assert.equal(finalAck[1].final, true);
    assert.equal(proc.process([[new Float32Array(64)]]), false);

    proc.port.close();
    proc.nodePort.close();
    assert.equal(globalThis.AudioWorkletProcessor, prevBase);
    assert.equal(globalThis.sampleRate, prevSr);
  });
});

test('PcmWorkletProcessor can be instantiated directly without global AudioWorkletProcessor', () => {
  const proc = new PcmWorkletProcessor();
  assert.equal(proc.sampleRate, 48000);
  assert.equal(proc.process([[new Float32Array(128)]]), true);
});
