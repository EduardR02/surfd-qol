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
    if (width === 1 && height === 1 && Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) &&
        Number.isFinite(d) && Number.isFinite(e) && Number.isFinite(f)) {
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

// The worker receives structured clones, never transfers of the renderer's
// ImageBitmaps. Native conversion returns original images only when every face
// is unchanged; otherwise every face uploads as a canvas.
export function runSkyResampleWorker(createResampler) {
  const resample = createResampler();
  self.onmessage = async ({data: {images, matrices, size}}) => {
    let buffers;
    try {
      buffers = images.map((image, index) => {
        if (!image) return null;
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext('2d', {willReadFrequently: true});
        context.drawImage(image, 0, 0);
        const input = context.getImageData(0, 0, image.width, image.height).data;
        const output = new Uint8ClampedArray(size * size * 4);
        resample(input, image.width, image.height, size, matrices[index], output);
        return output.buffer;
      });
    } catch {
      self.postMessage({failed: true});
      return;
    } finally {
      for (const image of images) image?.close();
    }
    // A canvas upload of an opaque face carries exactly these bytes, but reads
    // the canvas back first. Unpremultiplied bitmaps upload them directly.
    // Translucent faces keep the canvas round trip and its rounding.
    if (typeof createImageBitmap === 'function' && typeof ImageData === 'function' && buffers.some(Boolean) &&
        buffers.every(buffer => {
          if (!buffer) return true;
          const pixels = new Uint8Array(buffer);
          for (let offset = 3; offset < pixels.length; offset += 4) if (pixels[offset] !== 255) return false;
          return true;
        })) {
      let bitmaps = [];
      try {
        for (const buffer of buffers) {
          bitmaps.push(buffer && await createImageBitmap(new ImageData(new Uint8ClampedArray(buffer), size, size),
            {premultiplyAlpha: 'none', colorSpaceConversion: 'none'}));
        }
        self.postMessage({bitmaps}, bitmaps.filter(Boolean));
        return;
      } catch {
        for (const bitmap of bitmaps) bitmap?.close();
        bitmaps = null;
      }
    }
    self.postMessage({buffers}, buffers.filter(Boolean));
  };
}

// Self-contained for injection. A missing capability, CSP rejection, clone
// failure, or worker error defers exactly one native conversion until finish().
// In particular, the original images are never detached from their owner.
export function createSkyPreparation(images, transforms, signal, parse, createResampler, workerMain, environment = globalThis) {
  // Faces are split across workers when cores allow; each face comes back as
  // a bitmap (opaque) or as pixels for a canvas.
  let workers = [], buffers = null, bitmaps = null, unchanged = null, finishPromise = null, published = null;
  let settled = false, cancelled = false, cancellationReason, resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});

  function stopWorker() {
    for (const worker of workers) worker.terminate();
    workers = [];
  }

  function settle() {
    if (settled) return;
    settled = true;
    stopWorker();
    resolveReady();
  }

  function closeBitmaps() {
    for (const bitmap of bitmaps ?? []) bitmap?.close?.();
    bitmaps = null;
  }

  function fallback(event) {
    event?.preventDefault?.();
    if (settled || cancelled) return;
    buffers = null;
    closeBitmaps();
    settle();
  }

  function cancel(reason = signal.reason) {
    if (cancelled) return;
    cancelled = true;
    cancellationReason = reason ?? new DOMException('Sky preparation aborted', 'AbortError');
    buffers = null;
    closeBitmaps();
    unchanged = null;
    images = null;
    signal.removeEventListener('abort', abort);
    stopWorker();
    if (!settled) {
      settled = true;
      rejectReady(cancellationReason);
    }
  }

  function abort() {
    cancel(signal.reason);
  }

  function finish(nativeConversion) {
    if (finishPromise) return finishPromise;
    finishPromise = ready.then(() => {
      if (cancelled) throw cancellationReason;
      try {
        if (unchanged) return images;
        if (bitmaps?.every(Boolean)) {
          published = bitmaps;
          bitmaps = null;
          return published;
        }
        if (bitmaps || buffers) {
          try {
            const faces = images.map((image, index) => {
              if (bitmaps?.[index]) return bitmaps[index];
              const canvas = environment.document.createElement('canvas');
              canvas.width = canvas.height = size;
              const context = canvas.getContext('2d');
              const pixels = new Uint8ClampedArray(buffers[index]);
              let data;
              if (typeof environment.ImageData === 'function') data = new environment.ImageData(pixels, size, size);
              else {
                data = context.createImageData(size, size);
                data.data.set(pixels);
              }
              context.putImageData(data, 0, 0);
              return canvas;
            });
            published = bitmaps?.filter(Boolean) ?? null;
            bitmaps = null;
            return faces;
          } catch {
            return nativeConversion();
          }
        }
        return nativeConversion();
      } finally {
        buffers = null;
        closeBitmaps();
        unchanged = null;
        images = null;
        signal.removeEventListener('abort', abort);
      }
    });
    finishPromise.catch(() => {});
    return finishPromise;
  }

  let size;
  if (signal.aborted) cancel(signal.reason);
  else {
    signal.addEventListener('abort', abort, {once: true});
    try {
      size = Math.max(...images.map(image => Math.max(image.width, image.height)));
      const identity = [1, 0, 0, 0, 1, 0];
      if (transforms === undefined) transforms = [];
      const matrices = images.map((image, index) => parse(transforms[index]));
      const unchangedFaces = images.every((image, index) => image.width === size && image.height === size &&
        matrices[index].every((value, axis) => Math.abs(value - identity[axis]) < 1e-12));
      if (unchangedFaces) {
        unchanged = true;
        settle();
      } else if (typeof environment.Worker !== 'function' || typeof environment.OffscreenCanvas !== 'function' ||
          typeof environment.ImageBitmap !== 'function' || typeof environment.Blob !== 'function' ||
          typeof environment.URL?.createObjectURL !== 'function' ||
          images.some(image => !(image instanceof environment.ImageBitmap))) {
        fallback();
      } else {
        const script = `(${workerMain.toString()})(${createResampler.toString()})`;
        const url = environment.URL.createObjectURL(new environment.Blob([script], {type: 'text/javascript'}));
        const cores = environment.navigator?.hardwareConcurrency;
        const count = Number.isInteger(cores) ? Math.max(1, Math.min(images.length, cores >> 2)) : 1;
        let pending = count;
        try {
          for (let index = 0; index < count; index++) workers.push(new environment.Worker(url));
        } finally {
          environment.URL.revokeObjectURL(url);
        }
        const faces = images.map(() => null), pixels = images.map(() => null);
        bitmaps = faces;
        buffers = pixels;
        workers.forEach((worker, slot) => {
          const owned = images.map((_, index) => index % count === slot), length = images.length;
          worker.onmessage = ({data}) => {
            const bitmapResult = data?.bitmaps, bufferResult = data?.buffers, result = bitmapResult ?? bufferResult;
            const close = () => { if (Array.isArray(bitmapResult)) for (const face of bitmapResult) face?.close?.(); };
            if (settled || cancelled) { close(); return; }
            let accepted = Array.isArray(result) && result.length === length;
            for (let index = 0; accepted && index < length; index++) {
              const value = result[index];
              accepted = owned[index] !== (value == null) && (value == null || (bitmapResult
                ? value instanceof environment.ImageBitmap && value.width === size && value.height === size
                : value instanceof ArrayBuffer && value.byteLength === size * size * 4));
            }
            if (!accepted) {
              close();
              fallback();
              return;
            }
            owned.forEach((mine, index) => {
              if (!mine) return;
              if (bitmapResult) faces[index] = bitmapResult[index];
              else pixels[index] = bufferResult[index];
            });
            if (--pending === 0) settle();
          };
          worker.onerror = fallback;
          worker.onmessageerror = fallback;
          // ImageBitmap is serializable. Omitting a transfer list makes worker
          // copies without changing the images used by other native textures.
          worker.postMessage({images: images.map((image, index) => owned[index] ? image : null), matrices, size});
        });
      }
    } catch {
      fallback();
    }
  }

  // Bitmaps handed to the renderer are released with it.
  function release() {
    for (const bitmap of published ?? []) bitmap.close();
    published = null;
  }

  return {ready, finish, cancel, release};
}
