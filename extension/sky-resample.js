// Self-contained so the native hook can inject this factory with .toString().
export function createSkyResampler() {
  let decodeTable = null, encodeTable = null;

  function initializeTables() {
    decodeTable = new Float64Array(256);
    for (let i = 0; i < decodeTable.length; i++) {
      const value = i / 255;
      decodeTable[i] = value <= .04045 ? value / 12.92 : Math.pow((value + .055) / 1.055, 2.4);
    }
    encodeTable = new Uint8Array(65537);
    for (let i = 0; i < encodeTable.length; i++) {
      const value = i / 65536;
      encodeTable[i] = Math.round(255 * (value <= .0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - .055));
    }
  }

  function encode(value) {
    const bin = Math.min(65535, Math.max(0, Math.floor(value * 65536)));
    const low = encodeTable[bin];
    // Equal rounded endpoints guarantee the native result throughout this bin.
    if (low === encodeTable[bin + 1]) return low;
    return Math.round(255 * (value <= .0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - .055));
  }

  return function resample(input, width, height, size, transform, output) {
    const a = transform[0], b = transform[1], c = transform[2];
    const d = transform[3], e = transform[4], f = transform[5];
    if (width === size && height === size && a === 1 && b === 0 && c === 0 && d === 0 && e === 1 && f === 0) {
      output.set(input);
      return output;
    }
    if (width === 1 && height === 1) {
      const red = input[0], green = input[1], blue = input[2], alpha = input[3];
      for (let offset = 0; offset < output.length; offset += 4) {
        output[offset] = red;
        output[offset + 1] = green;
        output[offset + 2] = blue;
        output[offset + 3] = alpha;
      }
      return output;
    }

    const maxX = width - 1, maxY = height - 1;
    let decode = decodeTable, offset = 0;
    for (let row = 0; row < size; row++) {
      const v = (row + .5) / size;
      for (let column = 0; column < size; column++, offset += 4) {
        const u = (column + .5) / size;
        const x = Math.min(maxX, Math.max(0, (a * u + b * v + c) * width - .5));
        const y = Math.min(maxY, Math.max(0, (d * u + e * v + f) * height - .5));
        const left = Math.floor(x), top = Math.floor(y);
        const fx = x - left, fy = y - top;
        const first = (top * width + left) * 4;
        if (fx === 0 && fy === 0) {
          output[offset] = input[first];
          output[offset + 1] = input[first + 1];
          output[offset + 2] = input[first + 2];
          output[offset + 3] = input[first + 3];
          continue;
        }
        if (decode === null) {
          initializeTables();
          decode = decodeTable;
        }
        const right = Math.min(left + 1, maxX), bottom = Math.min(top + 1, maxY);
        const second = (top * width + right) * 4;
        const third = (bottom * width + left) * 4;
        const fourth = (bottom * width + right) * 4;
        const inverseX = 1 - fx, inverseY = 1 - fy;
        for (let channel = 0; channel < 3; channel++) {
          const upper = decode[input[first + channel]] * inverseX + decode[input[second + channel]] * fx;
          const lower = decode[input[third + channel]] * inverseX + decode[input[fourth + channel]] * fx;
          output[offset + channel] = encode(upper * inverseY + lower * fy);
        }
        const upperAlpha = (input[first + 3] / 255) * inverseX + (input[second + 3] / 255) * fx;
        const lowerAlpha = (input[third + 3] / 255) * inverseX + (input[fourth + 3] / 255) * fx;
        output[offset + 3] = Math.round((upperAlpha * inverseY + lowerAlpha * fy) * 255);
      }
    }
    return output;
  };
}
