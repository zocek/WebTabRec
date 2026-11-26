import {
  HUFFMAN_TABLES,
  SFB_LONG
} from './mp3-tables.js';

export const MP3_BITRATE_KBPS = 192;
export const MP3_SAMPLES_PER_FRAME = 1152;
export const SUPPORTED_MP3_SAMPLE_RATES = Object.freeze([44100, 48000, 32000]);

const BITRATE_INDEX_MAP = Object.freeze({
  32: 1,
  40: 2,
  48: 3,
  56: 4,
  64: 5,
  80: 6,
  96: 7,
  112: 8,
  128: 9,
  160: 10,
  192: 11,
  224: 12,
  256: 13,
  320: 14
});

const SAMPLE_RATE_INDEX_MAP = Object.freeze({
  44100: 0,
  48000: 1,
  32000: 2
});

// ISO/IEC 11172-3 §2.4.3.4.10.3 aliasing reduction constants
const ALIAS_CI = [-0.6, -0.535, -0.33, -0.185, -0.095, -0.041, -0.0142, -0.0037];
const ALIAS_CS = new Float64Array(8);
const ALIAS_CA = new Float64Array(8);
for (let i = 0; i < 8; i += 1) {
  const sq = Math.sqrt(1 + ALIAS_CI[i] * ALIAS_CI[i]);
  ALIAS_CS[i] = 1 / sq;
  ALIAS_CA[i] = ALIAS_CI[i] / sq;
}

// Modified Bessel function I0(x) for Kaiser prototype lowpass window
function besselI0(x) {
  let sum = 1;
  let term = 1;
  const half = x * 0.5;
  for (let k = 1; k <= 24; k += 1) {
    term *= (half / k) * (half / k);
    sum += term;
    if (term < 1e-12 * sum) {
      break;
    }
  }
  return sum;
}

// 512-tap Kaiser-windowed sinc prototype analysis window matching ISO 11172-3 32-band PQMF (-3 dB crossover)
const ANALYSIS_WINDOW = (() => {
  const win = new Float64Array(512);
  const beta = 9.0;
  const invI0 = 1 / besselI0(beta);
  const cutoffDiv = 56.6;
  // Calibrated so unity sine wave reconstructs at 1.0 across passband and subband crossovers
  const gain = (1 / 16) * (64 / cutoffDiv);
  for (let i = 1; i < 512; i += 1) {
    const n = i - 256;
    const t = n / 256;
    const kaiser = besselI0(beta * Math.sqrt(Math.max(0, 1 - t * t))) * invI0;
    const u = n / cutoffDiv;
    const sinc = u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u);
    const sign = (i >> 6) & 1 ? -1 : 1;
    win[i] = gain * kaiser * sinc * sign;
  }
  return win;
})();

// Polyphase analysis cosine matrix M[k][i] = cos((2k + 1) * (i - 16) * pi / 64)
const POLYPHASE_MATRIX = (() => {
  const m = new Float64Array(32 * 64);
  for (let k = 0; k < 32; k += 1) {
    for (let i = 0; i < 64; i += 1) {
      m[k * 64 + i] = Math.cos(((2 * k + 1) * (i - 16) * Math.PI) / 64);
    }
  }
  return m;
})();

// 36-point normal MDCT window * cosine basis matrix (18 x 36)
const MDCT_BASIS = (() => {
  const basis = new Float64Array(18 * 36);
  const scale = 1 / 18;
  for (let k = 0; k < 18; k += 1) {
    for (let n = 0; n < 36; n += 1) {
      const win = Math.sin((Math.PI / 36) * (n + 0.5));
      basis[k * 36 + n] =
        scale * win * Math.cos((Math.PI / 72) * (2 * n + 19) * (2 * k + 1));
    }
  }
  return basis;
})();

// Valid Huffman table indices ordered by maxVal for fast optimal selection
const CANDIDATE_TABLES = Object.freeze([
  1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15,
  16, 17, 18, 19, 20, 21, 22, 23,
  24, 25, 26, 27, 28, 29, 30, 31
]);

/**
 * Checks whether the leading bytes start with a valid MPEG-1 Layer III frame sync or ID3v2 tag.
 *
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function isValidMp3HeaderBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) {
    return false;
  }
  // ID3v2 header ("ID3")
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return true;
  }
  // MPEG-1 Layer III sync: 11 sync bits + version=11 (MPEG-1) + layer=01 (Layer III)
  if (bytes[0] !== 0xff || (bytes[1] & 0xfe) !== 0xfa) {
    return false;
  }
  const bitrateIdx = (bytes[2] >>> 4) & 0x0f;
  const sampleRateIdx = (bytes[2] >>> 2) & 0x03;
  return bitrateIdx >= 1 && bitrateIdx <= 14 && sampleRateIdx <= 2;
}

class BitWriter {
  constructor(byteLength) {
    this.buf = new Uint8Array(byteLength);
    this.bitPos = 0;
  }

  put(value, bitCount) {
    let remaining = bitCount;
    while (remaining > 0) {
      const byteIdx = this.bitPos >> 3;
      const bitOff = this.bitPos & 7;
      const take = Math.min(remaining, 8 - bitOff);
      const shift = remaining - take;
      const mask = (1 << take) - 1;
      const chunk = (value >>> shift) & mask;
      this.buf[byteIdx] |= chunk << (8 - bitOff - take);
      this.bitPos += take;
      remaining -= take;
    }
  }
}

function measureRegionBits(ix, start, end, tableId) {
  if (start >= end) {
    return 0;
  }
  if (tableId === 0) {
    for (let i = start; i < end; i += 1) {
      if (ix[i] !== 0) {
        return Infinity;
      }
    }
    return 0;
  }
  const tbl = HUFFMAN_TABLES[tableId];
  if (!tbl) {
    return Infinity;
  }
  const { size, linbits, maxVal, lens } = tbl;
  let bits = 0;
  for (let i = start; i < end; i += 2) {
    const x = ix[i];
    const y = ix[i + 1];
    if (x > maxVal || y > maxVal) {
      return Infinity;
    }
    const cx = x >= 15 && linbits > 0 ? 15 : x;
    const cy = y >= 15 && linbits > 0 ? 15 : y;
    if (cx >= size || cy >= size) {
      return Infinity;
    }
    bits += lens[cx * size + cy];
    if (x >= 15 && linbits > 0) {
      bits += linbits;
    }
    if (x > 0) {
      bits += 1;
    }
    if (y >= 15 && linbits > 0) {
      bits += linbits;
    }
    if (y > 0) {
      bits += 1;
    }
  }
  return bits;
}

function selectBestTableForRegion(ix, start, end) {
  if (start >= end) {
    return { tableId: 0, bits: 0 };
  }
  let maxAbs = 0;
  for (let i = start; i < end; i += 1) {
    if (ix[i] > maxAbs) {
      maxAbs = ix[i];
    }
  }
  if (maxAbs === 0) {
    return { tableId: 0, bits: 0 };
  }

  let bestTable = 31;
  let bestBits = Infinity;
  for (let t = 0; t < CANDIDATE_TABLES.length; t += 1) {
    const id = CANDIDATE_TABLES[t];
    const tbl = HUFFMAN_TABLES[id];
    if (tbl.maxVal < maxAbs) {
      continue;
    }
    // Skip linbits tables when maxAbs < 15 unless needed, or test them if competitive
    if (maxAbs < 15 && tbl.linbits > 0) {
      continue;
    }
    // For maxAbs >= 15, only test the smallest sufficient linbits in each family (16..23 and 24..31)
    if (maxAbs >= 15) {
      if (id >= 16 && id <= 23 && id > 16 && HUFFMAN_TABLES[id - 1].maxVal >= maxAbs) {
        continue;
      }
      if (id >= 24 && id <= 31 && id > 24 && HUFFMAN_TABLES[id - 1].maxVal >= maxAbs) {
        continue;
      }
    }
    const bits = measureRegionBits(ix, start, end, id);
    if (bits < bestBits) {
      bestBits = bits;
      bestTable = id;
    }
  }
  return { tableId: bestTable, bits: bestBits };
}

function writeRegionBits(bw, ix, signs, start, end, tableId) {
  if (start >= end || tableId === 0) {
    return;
  }
  const tbl = HUFFMAN_TABLES[tableId];
  const { size, linbits, codes, lens } = tbl;
  for (let i = start; i < end; i += 2) {
    const x = ix[i];
    const y = ix[i + 1];
    const cx = x >= 15 && linbits > 0 ? 15 : x;
    const cy = y >= 15 && linbits > 0 ? 15 : y;
    const idx = cx * size + cy;
    bw.put(codes[idx], lens[idx]);
    if (x >= 15 && linbits > 0) {
      bw.put(x - 15, linbits);
    }
    if (x > 0) {
      bw.put(signs[i], 1);
    }
    if (y >= 15 && linbits > 0) {
      bw.put(y - 15, linbits);
    }
    if (y > 0) {
      bw.put(signs[i + 1], 1);
    }
  }
}

function planGranuleEncoding(ix, sfbLong) {
  // Trim trailing zero pairs
  let lastNz = 575;
  while (lastNz >= 0 && ix[lastNz] === 0) {
    lastNz -= 1;
  }
  if (lastNz < 0) {
    return {
      part23Length: 0,
      bigValues: 0,
      region0Count: 0,
      region1Count: 0,
      tableSelect: [0, 0, 0],
      count1End: 0,
      count1Table: 1
    };
  }

  // Round up to even count; pull trailing quads with values <= 1 into count1 region
  let end = (lastNz + 2) & ~1;
  if (end > 576) {
    end = 576;
  }

  // Find boundary where all lines >= bigEnd are <= 1 and (count1End - bigEnd) % 4 === 0
  let bigEnd = end;
  while (bigEnd >= 4) {
    if (
      ix[bigEnd - 1] <= 1 &&
      ix[bigEnd - 2] <= 1 &&
      ix[bigEnd - 3] <= 1 &&
      ix[bigEnd - 4] <= 1
    ) {
      bigEnd -= 4;
    } else {
      break;
    }
  }
  const count1End = end;
  const bigValues = bigEnd >> 1;

  // Choose region0/region1 boundaries aligned with ISO SFB_LONG (max region0Count=15, region1Count=7)
  let r0Idx = 0;
  let r1Idx = 0;
  if (bigEnd > 0) {
    const target1 = Math.floor(bigEnd / 3);
    const target2 = Math.floor((bigEnd * 2) / 3);
    for (let b = 0; b <= 15; b += 1) {
      if (sfbLong[b + 1] <= target1) {
        r0Idx = b;
      }
    }
    for (let b = 0; b <= 7; b += 1) {
      const idx = r0Idx + b + 2;
      if (idx < sfbLong.length && sfbLong[idx] <= target2) {
        r1Idx = b;
      }
    }
  }

  const r1Start = Math.min(bigEnd, sfbLong[r0Idx + 1]);
  const r2Start = Math.min(bigEnd, sfbLong[Math.min(sfbLong.length - 1, r0Idx + r1Idx + 2)]);

  const reg0 = selectBestTableForRegion(ix, 0, r1Start);
  const reg1 = selectBestTableForRegion(ix, r1Start, r2Start);
  const reg2 = selectBestTableForRegion(ix, r2Start, bigEnd);

  // Count1 Table B: exact 4 bits per quad + 1 sign bit per non-zero value
  let count1Bits = 0;
  for (let i = bigEnd; i < count1End; i += 4) {
    count1Bits += 4;
    if (ix[i] !== 0) count1Bits += 1;
    if (ix[i + 1] !== 0) count1Bits += 1;
    if (ix[i + 2] !== 0) count1Bits += 1;
    if (ix[i + 3] !== 0) count1Bits += 1;
  }

  const totalBits = reg0.bits + reg1.bits + reg2.bits + count1Bits;
  return {
    part23Length: totalBits,
    bigValues,
    region0Count: r0Idx,
    region1Count: r1Idx,
    r1Start,
    r2Start,
    bigEnd,
    count1End,
    tableSelect: [reg0.tableId, reg1.tableId, reg2.tableId],
    count1Table: 1
  };
}

function quantizeAndPlan(xr, xrPow34, signs, ix, sfbLong, maxBits) {
  let maxVal = 0;
  for (let i = 0; i < 576; i += 1) {
    const v = xr[i];
    const abs = v < 0 ? -v : v;
    signs[i] = v < 0 ? 1 : 0;
    if (abs > maxVal) {
      maxVal = abs;
    }
    xrPow34[i] = abs > 1e-12 ? Math.pow(abs, 0.75) : 0;
  }

  if (maxVal < 1e-10) {
    ix.fill(0);
    return {
      globalGain: 210,
      plan: planGranuleEncoding(ix, sfbLong)
    };
  }

  // Lower bound on globalGain so max quantized coefficient <= 8191
  const maxPow34 = Math.pow(maxVal, 0.75);
  const minGainForRange = Math.max(
    0,
    Math.ceil(210 + (Math.log2(maxPow34 / 8190.5) * 16) / 3)
  );

  let lo = Math.min(255, minGainForRange);
  let hi = 255;
  let bestGain = 255;
  let bestPlan = null;

  const evalGain = (gain) => {
    const step = Math.pow(2, -(gain - 210) * 0.1875);
    let overflow = false;
    for (let i = 0; i < 576; i += 1) {
      const q = Math.floor(xrPow34[i] * step + 0.4054);
      if (q > 8191) {
        overflow = true;
        break;
      }
      ix[i] = q;
    }
    if (overflow) {
      return null;
    }
    return planGranuleEncoding(ix, sfbLong);
  };

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const plan = evalGain(mid);
    if (plan && plan.part23Length <= maxBits) {
      bestGain = mid;
      bestPlan = plan;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  // Recompute ix for winning bestGain
  const finalPlan = evalGain(bestGain);
  if (!finalPlan || finalPlan.part23Length > maxBits) {
    ix.fill(0);
    return {
      globalGain: 255,
      plan: planGranuleEncoding(ix, sfbLong)
    };
  }
  return {
    globalGain: bestGain,
    plan: finalPlan
  };
}

/**
 * Creates a streaming pure-JS MPEG-1 Audio Layer III (MP3) stereo CBR encoder.
 * Produces independent frames (`main_data_begin = 0`) for 100% crash-safe recovery.
 *
 * @param {{ sampleRate?: number, channels?: number, bitrateKbps?: number }} [options]
 */
export function createMp3Encoder({
  sampleRate = 48000,
  channels = 2,
  bitrateKbps = MP3_BITRATE_KBPS
} = {}) {
  const inputSampleRate =
    Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(sampleRate) : 48000;
  const encodedSampleRate = SUPPORTED_MP3_SAMPLE_RATES.includes(inputSampleRate)
    ? inputSampleRate
    : inputSampleRate % 11025 === 0
      ? 44100
      : 48000;
  const inputChannels = channels === 1 ? 1 : 2;
  const safeBitrate = Object.prototype.hasOwnProperty.call(BITRATE_INDEX_MAP, bitrateKbps)
    ? bitrateKbps
    : MP3_BITRATE_KBPS;

  const bitrateIdx = BITRATE_INDEX_MAP[safeBitrate];
  const sampleRateIdx = SAMPLE_RATE_INDEX_MAP[encodedSampleRate];
  const sfbLong = SFB_LONG[encodedSampleRate];

  const baseFrameBytes = Math.floor((144 * safeBitrate * 1000) / encodedSampleRate);
  const padRemainder = (144 * safeBitrate * 1000) % encodedSampleRate;
  let slotLag = 0;

  // Per-channel polyphase FIFO (512 samples) and previous granule subband overlap (32 x 18)
  const fifo = [new Float64Array(512), new Float64Array(512)];
  const prevSb = [new Float64Array(576), new Float64Array(576)];

  // Reusable scratch buffers
  const yBuf = new Float64Array(64);
  const sbCur = [new Float64Array(576), new Float64Array(576)];
  const mdctIn = new Float64Array(36);
  const xrGr = [
    [new Float64Array(576), new Float64Array(576)],
    [new Float64Array(576), new Float64Array(576)]
  ];
  const ixGr = [
    [new Int32Array(576), new Int32Array(576)],
    [new Int32Array(576), new Int32Array(576)]
  ];
  const signsGr = [
    [new Uint8Array(576), new Uint8Array(576)],
    [new Uint8Array(576), new Uint8Array(576)]
  ];
  const xrPow34 = new Float64Array(576);

  // Pending stereo normalized Float32 sample accumulator (interleaved L, R)
  let pendingL = new Float32Array(MP3_SAMPLES_PER_FRAME * 2);
  let pendingR = new Float32Array(MP3_SAMPLES_PER_FRAME * 2);
  let pendingFrames = 0;

  // Streaming windowed-sinc anti-aliasing resampler state (when inputSampleRate !== encodedSampleRate)
  const resampleStep = inputSampleRate / encodedSampleRate;
  const RESAMPLE_HALF_TAPS = 16;
  const RESAMPLE_PAD = RESAMPLE_HALF_TAPS;
  const RESAMPLE_CUTOFF =
    inputSampleRate > encodedSampleRate
      ? 0.45 * (encodedSampleRate / inputSampleRate)
      : 0.45;
  let resamplePos = 0;
  let resampleTailL = new Float32Array(0);
  let resampleTailR = new Float32Array(0);

  function evaluateSinc(bufL, bufR, len, pos) {
    const cInt = Math.floor(pos);
    const frac = pos - cInt;
    const fc2 = 2 * RESAMPLE_CUTOFF;
    let sumL = 0;
    let sumR = 0;
    let norm = 0;
    for (let k = -RESAMPLE_HALF_TAPS; k <= RESAMPLE_HALF_TAPS; k += 1) {
      const idx = cInt + k;
      const clamped = idx < 0 ? 0 : idx >= len ? len - 1 : idx;
      const x = k - frac;
      const sinc =
        Math.abs(x) < 1e-9
          ? fc2
          : Math.sin(Math.PI * fc2 * x) / (Math.PI * x);
      const u = (x + RESAMPLE_HALF_TAPS) / (2 * RESAMPLE_HALF_TAPS);
      const win =
        u <= 0 || u >= 1
          ? 0
          : 0.42 - 0.5 * Math.cos(2 * Math.PI * u) + 0.08 * Math.cos(4 * Math.PI * u);
      const coeff = sinc * win;
      sumL += bufL[clamped] * coeff;
      sumR += bufR[clamped] * coeff;
      norm += coeff;
    }
    const invNorm = Math.abs(norm) > 1e-12 ? 1 / norm : 1;
    return [sumL * invNorm, sumR * invNorm];
  }

  function ensurePendingCapacity(needed) {
    if (needed <= pendingL.length) {
      return;
    }
    const nextCap = Math.max(needed, pendingL.length * 2);
    const nextL = new Float32Array(nextCap);
    const nextR = new Float32Array(nextCap);
    nextL.set(pendingL.subarray(0, pendingFrames));
    nextR.set(pendingR.subarray(0, pendingFrames));
    pendingL = nextL;
    pendingR = nextR;
  }

  function analyzeGranule(pcmL, pcmR, grOffset, outXrL, outXrR) {
    const pcmPair = [pcmL, pcmR];
    const outPair = [outXrL, outXrR];

    for (let ch = 0; ch < 2; ch += 1) {
      const chFifo = fifo[ch];
      const chSb = sbCur[ch];
      const chPcm = pcmPair[ch];

      // 18 subband steps x 32 PCM samples = 576 samples per granule
      for (let s = 0; s < 18; s += 1) {
        // Shift FIFO by 32
        chFifo.copyWithin(32, 0, 480);
        const base = grOffset + s * 32;
        for (let i = 0; i < 32; i += 1) {
          chFifo[31 - i] = chPcm[base + i];
        }

        // Window and fold 512 -> 64
        for (let j = 0; j < 64; j += 1) {
          yBuf[j] =
            chFifo[j] * ANALYSIS_WINDOW[j] +
            chFifo[j + 64] * ANALYSIS_WINDOW[j + 64] +
            chFifo[j + 128] * ANALYSIS_WINDOW[j + 128] +
            chFifo[j + 192] * ANALYSIS_WINDOW[j + 192] +
            chFifo[j + 256] * ANALYSIS_WINDOW[j + 256] +
            chFifo[j + 320] * ANALYSIS_WINDOW[j + 320] +
            chFifo[j + 384] * ANALYSIS_WINDOW[j + 384] +
            chFifo[j + 448] * ANALYSIS_WINDOW[j + 448];
        }

        // Matrix 64 -> 32 subbands
        for (let sb = 0; sb < 32; sb += 1) {
          let sum = 0;
          const rowOff = sb * 64;
          for (let j = 0; j < 64; j += 1) {
            sum += POLYPHASE_MATRIX[rowOff + j] * yBuf[j];
          }
          // ISO 11172-3 §2.4.3.4.9: invert odd-indexed samples in odd subbands
          if ((sb & 1) !== 0 && (s & 1) !== 0) {
            sum = -sum;
          }
          chSb[sb * 18 + s] = sum;
        }
      }

      // 36-point MDCT per subband with 18-sample overlap
      const chPrev = prevSb[ch];
      const outXr = outPair[ch];
      for (let sb = 0; sb < 32; sb += 1) {
        const sbOff = sb * 18;
        for (let n = 0; n < 18; n += 1) {
          mdctIn[n] = chPrev[sbOff + n];
          mdctIn[18 + n] = chSb[sbOff + n];
          chPrev[sbOff + n] = chSb[sbOff + n];
        }
        for (let k = 0; k < 18; k += 1) {
          let sum = 0;
          const bOff = k * 36;
          for (let n = 0; n < 36; n += 1) {
            sum += mdctIn[n] * MDCT_BASIS[bOff + n];
          }
          outXr[sbOff + k] = sum;
        }
      }

      // Aliasing reduction butterflies (analysis inverse of ISO synthesis butterflies)
      for (let sb = 0; sb < 31; sb += 1) {
        const upperEnd = sb * 18 + 17;
        const lowerStart = (sb + 1) * 18;
        for (let i = 0; i < 8; i += 1) {
          const bu = outXr[upperEnd - i];
          const bd = outXr[lowerStart + i];
          outXr[upperEnd - i] = bu * ALIAS_CS[i] + bd * ALIAS_CA[i];
          outXr[lowerStart + i] = bd * ALIAS_CS[i] - bu * ALIAS_CA[i];
        }
      }
    }
  }

  function encodeOneFrame(pcmL, pcmR) {
    let padding = 0;
    if (padRemainder > 0) {
      slotLag += padRemainder;
      if (slotLag >= encodedSampleRate) {
        slotLag -= encodedSampleRate;
        padding = 1;
      }
    }
    const frameBytes = baseFrameBytes + padding;
    const mainDataBits = (frameBytes - 36) * 8;

    // Analyze both granules (0..575 and 576..1151)
    analyzeGranule(pcmL, pcmR, 0, xrGr[0][0], xrGr[0][1]);
    analyzeGranule(pcmL, pcmR, 576, xrGr[1][0], xrGr[1][1]);

    // Quantize & plan all 4 granule-channels, sharing unused bits inside this frame
    const results = [
      [null, null],
      [null, null]
    ];
    let remainingBits = mainDataBits;
    let remainingSlots = 4;
    for (let gr = 0; gr < 2; gr += 1) {
      for (let ch = 0; ch < 2; ch += 1) {
        const target = Math.min(4095, Math.floor(remainingBits / remainingSlots));
        const res = quantizeAndPlan(
          xrGr[gr][ch],
          xrPow34,
          signsGr[gr][ch],
          ixGr[gr][ch],
          sfbLong,
          target
        );
        results[gr][ch] = res;
        remainingBits -= res.plan.part23Length;
        remainingSlots -= 1;
      }
    }

    const bw = new BitWriter(frameBytes);

    // 4-byte MPEG-1 Layer III header
    bw.put(0xfff, 12); // frame sync
    bw.put(1, 1); // MPEG-1
    bw.put(1, 2); // Layer III
    bw.put(1, 1); // no CRC
    bw.put(bitrateIdx, 4);
    bw.put(sampleRateIdx, 2);
    bw.put(padding, 1);
    bw.put(0, 1); // private
    bw.put(0, 2); // Stereo (independent L/R)
    bw.put(0, 2); // mode extension
    bw.put(0, 1); // copyright
    bw.put(1, 1); // original
    bw.put(0, 2); // emphasis = none

    // 32-byte Stereo Side Info (main_data_begin = 0 -> independent frames)
    bw.put(0, 9); // main_data_begin
    bw.put(0, 3); // private_bits
    bw.put(0, 8); // scfsi (4 bits ch0 + 4 bits ch1)

    for (let gr = 0; gr < 2; gr += 1) {
      for (let ch = 0; ch < 2; ch += 1) {
        const { globalGain, plan } = results[gr][ch];
        bw.put(plan.part23Length, 12);
        bw.put(plan.bigValues, 9);
        bw.put(globalGain, 8);
        bw.put(0, 4); // scalefac_compress = 0 (0 scalefactor bits)
        bw.put(0, 1); // window_switching_flag = 0
        bw.put(plan.tableSelect[0], 5);
        bw.put(plan.tableSelect[1], 5);
        bw.put(plan.tableSelect[2], 5);
        bw.put(plan.region0Count, 4);
        bw.put(plan.region1Count, 3);
        bw.put(0, 1); // preflag
        bw.put(0, 1); // scalefac_scale
        bw.put(plan.count1Table, 1);
      }
    }

    // Main data payload
    for (let gr = 0; gr < 2; gr += 1) {
      for (let ch = 0; ch < 2; ch += 1) {
        const { plan } = results[gr][ch];
        if (plan.part23Length === 0) {
          continue;
        }
        const ix = ixGr[gr][ch];
        const signs = signsGr[gr][ch];
        writeRegionBits(bw, ix, signs, 0, plan.r1Start, plan.tableSelect[0]);
        writeRegionBits(bw, ix, signs, plan.r1Start, plan.r2Start, plan.tableSelect[1]);
        writeRegionBits(bw, ix, signs, plan.r2Start, plan.bigEnd, plan.tableSelect[2]);

        // Count1 Table B (4-bit inverted nibble + sign bits)
        for (let i = plan.bigEnd; i < plan.count1End; i += 4) {
          const v = ix[i];
          const w = ix[i + 1];
          const x = ix[i + 2];
          const y = ix[i + 3];
          const nibble = ((v << 3) | (w << 2) | (x << 1) | y) & 0x0f;
          bw.put(15 - nibble, 4);
          if (v !== 0) bw.put(signs[i], 1);
          if (w !== 0) bw.put(signs[i + 1], 1);
          if (x !== 0) bw.put(signs[i + 2], 1);
          if (y !== 0) bw.put(signs[i + 3], 1);
        }
      }
    }

    return bw.buf;
  }

  function drainFullFrames() {
    const frameCount = Math.floor(pendingFrames / MP3_SAMPLES_PER_FRAME);
    if (frameCount <= 0) {
      return new Uint8Array(0);
    }
    const frames = [];
    let totalBytes = 0;
    for (let f = 0; f < frameCount; f += 1) {
      const start = f * MP3_SAMPLES_PER_FRAME;
      const frame = encodeOneFrame(
        pendingL.subarray(start, start + MP3_SAMPLES_PER_FRAME),
        pendingR.subarray(start, start + MP3_SAMPLES_PER_FRAME)
      );
      frames.push(frame);
      totalBytes += frame.byteLength;
    }

    const consumed = frameCount * MP3_SAMPLES_PER_FRAME;
    const leftover = pendingFrames - consumed;
    if (leftover > 0) {
      pendingL.copyWithin(0, consumed, pendingFrames);
      pendingR.copyWithin(0, consumed, pendingFrames);
    }
    pendingFrames = leftover;

    const out = new Uint8Array(totalBytes);
    let off = 0;
    for (const frame of frames) {
      out.set(frame, off);
      off += frame.byteLength;
    }
    return out;
  }

  function encodeInterleavedPcm16(input) {
    let view;
    if (input instanceof Int16Array) {
      view = input;
    } else if (input instanceof ArrayBuffer) {
      view = new Int16Array(input);
    } else if (ArrayBuffer.isView(input)) {
      view = new Int16Array(
        input.buffer,
        input.byteOffset,
        Math.floor(input.byteLength / 2)
      );
    } else {
      return new Uint8Array(0);
    }

    const sampleFrames = Math.floor(view.length / inputChannels);
    if (sampleFrames <= 0) {
      return new Uint8Array(0);
    }

    const inv32768 = 1 / 32768;
    if (inputSampleRate === encodedSampleRate) {
      ensurePendingCapacity(pendingFrames + sampleFrames);
      if (inputChannels === 2) {
        for (let i = 0; i < sampleFrames; i += 1) {
          pendingL[pendingFrames + i] = view[i * 2] * inv32768;
          pendingR[pendingFrames + i] = view[i * 2 + 1] * inv32768;
        }
      } else {
        for (let i = 0; i < sampleFrames; i += 1) {
          const s = view[i] * inv32768;
          pendingL[pendingFrames + i] = s;
          pendingR[pendingFrames + i] = s;
        }
      }
      pendingFrames += sampleFrames;
    } else {
      const prevLen = resampleTailL.length;
      const totalLen = prevLen + sampleFrames;
      const combinedL = new Float32Array(totalLen);
      const combinedR = new Float32Array(totalLen);
      if (prevLen > 0) {
        combinedL.set(resampleTailL, 0);
        combinedR.set(resampleTailR, 0);
      }
      if (inputChannels === 2) {
        for (let i = 0; i < sampleFrames; i += 1) {
          combinedL[prevLen + i] = view[i * 2] * inv32768;
          combinedR[prevLen + i] = view[i * 2 + 1] * inv32768;
        }
      } else {
        for (let i = 0; i < sampleFrames; i += 1) {
          const s = view[i] * inv32768;
          combinedL[prevLen + i] = s;
          combinedR[prevLen + i] = s;
        }
      }

      const safeLimit = totalLen - RESAMPLE_PAD;
      if (safeLimit > 0) {
        const estOut = Math.ceil((safeLimit - resamplePos) / resampleStep) + 4;
        if (estOut > 0) {
          ensurePendingCapacity(pendingFrames + estOut);
        }
        let pos = resamplePos;
        while (pos < safeLimit) {
          const [outL, outR] = evaluateSinc(combinedL, combinedR, totalLen, pos);
          pendingL[pendingFrames] = outL;
          pendingR[pendingFrames] = outR;
          pendingFrames += 1;
          pos += resampleStep;
        }
        const dropCount = Math.max(0, Math.floor(pos) - RESAMPLE_PAD);
        resampleTailL = combinedL.slice(dropCount);
        resampleTailR = combinedR.slice(dropCount);
        resamplePos = pos - dropCount;
      } else {
        resampleTailL = combinedL;
        resampleTailR = combinedR;
      }
    }

    return drainFullFrames();
  }

  function flush() {
    const outFrames = [];
    let totalBytes = 0;

    if (inputSampleRate !== encodedSampleRate && resampleTailL.length > 0) {
      const totalLen = resampleTailL.length;
      const estOut = Math.ceil((totalLen - resamplePos) / resampleStep) + 4;
      if (estOut > 0) {
        ensurePendingCapacity(pendingFrames + estOut);
      }
      let pos = resamplePos;
      while (pos < totalLen) {
        const [outL, outR] = evaluateSinc(resampleTailL, resampleTailR, totalLen, pos);
        pendingL[pendingFrames] = outL;
        pendingR[pendingFrames] = outR;
        pendingFrames += 1;
        pos += resampleStep;
      }
      resampleTailL = new Float32Array(0);
      resampleTailR = new Float32Array(0);
      resamplePos = 0;
      const tailFull = drainFullFrames();
      if (tailFull.byteLength > 0) {
        outFrames.push(tailFull);
        totalBytes += tailFull.byteLength;
      }
    }

    if (pendingFrames > 0) {
      const padCount = MP3_SAMPLES_PER_FRAME - pendingFrames;
      ensurePendingCapacity(MP3_SAMPLES_PER_FRAME);
      pendingL.fill(0, pendingFrames, pendingFrames + padCount);
      pendingR.fill(0, pendingFrames, pendingFrames + padCount);
      const lastFrame = encodeOneFrame(
        pendingL.subarray(0, MP3_SAMPLES_PER_FRAME),
        pendingR.subarray(0, MP3_SAMPLES_PER_FRAME)
      );
      outFrames.push(lastFrame);
      totalBytes += lastFrame.byteLength;
      pendingFrames = 0;
    }

    // One trailing zero frame flushes the 512-tap filterbank + MDCT overlap delay
    const zeros = new Float32Array(MP3_SAMPLES_PER_FRAME);
    const tailFrame = encodeOneFrame(zeros, zeros);
    outFrames.push(tailFrame);
    totalBytes += tailFrame.byteLength;

    const out = new Uint8Array(totalBytes);
    let off = 0;
    for (const frame of outFrames) {
      out.set(frame, off);
      off += frame.byteLength;
    }
    return out;
  }

  return {
    sampleRate: inputSampleRate,
    encodedSampleRate,
    bitrateKbps: safeBitrate,
    encodeInterleavedPcm16,
    flush
  };
}
