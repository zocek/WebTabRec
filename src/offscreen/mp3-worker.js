import { createMp3Encoder } from './mp3-encoder.js';

let encoder = null;

function postChunk(bytes, final = false) {
  if (bytes && bytes.byteLength > 0) {
    const buffer =
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer
        : bytes.slice().buffer;
    globalThis.postMessage(
      {
        type: 'mp3',
        buffer,
        byteLength: buffer.byteLength,
        final
      },
      [buffer]
    );
  }
}

globalThis.onmessage = (event) => {
  const msg = event?.data;
  if (!msg || typeof msg.type !== 'string') {
    return;
  }

  try {
    switch (msg.type) {
      case 'init':
        encoder = createMp3Encoder({
          sampleRate: msg.sampleRate,
          channels: msg.channels,
          bitrateKbps: msg.bitrateKbps
        });
        globalThis.postMessage({
          type: 'ready',
          encodedSampleRate: encoder.encodedSampleRate,
          bitrateKbps: encoder.bitrateKbps
        });
        break;

      case 'encode': {
        if (!encoder) {
          encoder = createMp3Encoder({});
        }
        const inputByteLength = msg.buffer?.byteLength ?? 0;
        const bytes = encoder.encodeInterleavedPcm16(msg.buffer);
        postChunk(bytes, false);
        globalThis.postMessage({
          type: 'ack',
          seq: msg.seq ?? null,
          inputByteLength
        });
        break;
      }

      case 'flush': {
        if (encoder) {
          const tail = encoder.flush();
          postChunk(tail, true);
          encoder = null;
        }
        globalThis.postMessage({ type: 'flushed' });
        break;
      }

      default:
        break;
    }
  } catch (err) {
    globalThis.postMessage({
      type: 'error',
      message: err?.message ?? String(err)
    });
  }
};
