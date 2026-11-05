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

  // Rows [start, end) of the face; output holds only those rows.
  return function resample(input, width, height, size, transform, output, start = 0, end = size) {
    const a = transform[0], b = transform[1], c = transform[2];
    const d = transform[3], e = transform[4], f = transform[5];
    if (width === size && height === size && a === 1 && b === 0 && c === 0 && d === 0 && e === 1 && f === 0) {
      output.set(input.subarray(start * size * 4, end * size * 4));
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
    for (let row = start; row < end; row++) {
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
// is unchanged; otherwise every face is converted to a canvas.
export function runSkyResampleWorker(createResampler) {
  const resample = createResampler();
  // A worker's first canvas read pays a one-time setup cost; pay it while
  // the faces are still decoding.
  try { new OffscreenCanvas(1, 1).getContext('2d', {willReadFrequently: true}).getImageData(0, 0, 1, 1); } catch { /* Reported on use. */ }
  self.onmessage = ({data: {images, matrices, size, tasks}}) => {
    let bands;
    try {
      const sources = images.map(image => {
        if (!image) return null;
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext('2d', {willReadFrequently: true});
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height).data;
      });
      bands = tasks.map(({face, start, end}) => {
        const image = images[face], output = new Uint8ClampedArray((end - start) * size * 4);
        resample(sources[face], image.width, image.height, size, matrices[face], output, start, end);
        let opaque = true;
        for (let offset = 3; offset < output.length; offset += 4) if (output[offset] !== 255) { opaque = false; break; }
        return {face, start, end, opaque, buffer: output.buffer};
      });
    } catch {
      self.postMessage({failed: true});
      return;
    } finally {
      for (const image of images) image?.close();
    }
    self.postMessage({bands}, bands.map(band => band.buffer));
  };
}

// Self-contained for injection. A missing capability, CSP rejection, copy
// failure, or worker error defers exactly one native conversion until finish().
// In particular, the original images are never detached from their owner.
export function createSkyPreparation(faces, transforms, signal, parse, createResampler, workerMain, environment = globalThis) {
  // Workers start before the page thread is busy installing the map, and
  // receive the faces as soon as they are decoded. They return row bands; a
  // face that needs resampling is split across all of them. Opaque converted
  // faces upload as raw pixels, which carry exactly the bytes a canvas upload
  // would and skip the browser's image path.
  let workers = [], images = null, pixels = null, opaque = null, unchanged = null, finishPromise = null, size;
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

  function fallback(event) {
    event?.preventDefault?.();
    if (settled || cancelled) return;
    pixels = null;
    settle();
  }

  function cancel(reason = signal.reason) {
    if (cancelled) return;
    cancelled = true;
    cancellationReason = reason ?? new DOMException('Sky preparation aborted', 'AbortError');
    pixels = null;
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
        if (pixels && opaque.every(Boolean)) {
          return pixels.map(buffer => ({isDataTexture: true, image: {data: new Uint8Array(buffer), width: size, height: size}}));
        }
        if (pixels) {
          try {
            return pixels.map(buffer => {
              const canvas = environment.document.createElement('canvas');
              canvas.width = canvas.height = size;
              const context = canvas.getContext('2d');
              const data = new Uint8ClampedArray(buffer);
              let image;
              if (typeof environment.ImageData === 'function') image = new environment.ImageData(data, size, size);
              else {
                image = context.createImageData(size, size);
                image.data.set(data);
              }
              context.putImageData(image, 0, 0);
              return canvas;
            });
          } catch {
            return nativeConversion();
          }
        }
        // Native conversion returns the original images for an unchanged sky.
        return unchanged ? images : nativeConversion();
      } finally {
        pixels = null;
        opaque = null;
        unchanged = null;
        images = null;
        signal.removeEventListener('abort', abort);
      }
    });
    finishPromise.catch(() => {});
    return finishPromise;
  }

  async function start(decoded) {
    if (settled || cancelled) return;
    images = decoded;
    size = Math.max(...images.map(image => Math.max(image.width, image.height)));
    const identity = [1, 0, 0, 0, 1, 0];
    if (transforms === undefined) transforms = [];
    const matrices = images.map((image, index) => parse(transforms[index]));
    unchanged = images.every((image, index) => image.width === size && image.height === size &&
      matrices[index].every((value, axis) => Math.abs(value - identity[axis]) < 1e-12));
    if (unchanged) {
      settle();
      return;
    }
    spawn();
    if (!workers.length || images.some(image => !(image instanceof environment.ImageBitmap))) {
      fallback();
      return;
    }
    // Relative costs per pixel: reading a source, copying a row, resampling a row.
    const limit = workers.length, tasks = [];
    images.forEach((image, face) => {
      const [a, b, c, d, e, f] = matrices[face];
      const copy = image.width === size && image.height === size && a === 1 && b === 0 && c === 0 && d === 0 && e === 1 && f === 0;
      const rows = copy ? size : Math.ceil(size / limit);
      for (let first = 0; first < size; first += rows) {
        const end = Math.min(size, first + rows);
        tasks.push({face, start: first, end, cost: (end - first) * size * (copy ? .5 : 12)});
      }
    });
    // Longest task first onto the least-loaded worker, counting each source a
    // worker must read once.
    tasks.sort((x, y) => y.cost - x.cost);
    const loads = new Array(limit).fill(0), assigned = Array.from({length: limit}, () => []);
    for (const task of tasks) {
      let best = 0, bestLoad = Infinity;
      for (let slot = 0; slot < limit; slot++) {
        const source = images[task.face], read = assigned[slot].some(other => other.face === task.face) ? 0 : source.width * source.height;
        if (loads[slot] + read < bestLoad) { best = slot; bestLoad = loads[slot] + read; }
      }
      loads[best] = bestLoad + task.cost;
      assigned[best].push(task);
    }
    for (let slot = limit - 1; slot >= 0; slot--) {
      if (assigned[slot].length) continue;
      workers[slot].terminate();
      workers.splice(slot, 1);
      assigned.splice(slot, 1);
    }
    const plan = assigned.map(list => list.sort((x, y) => x.face - y.face || x.start - y.start).map(({face, start, end}) => ({face, start, end})));
    const bands = images.map(() => []);
    let pending = plan.length;
    const receive = tasks => ({data}) => {
      if (settled || cancelled) return;
      const result = data?.bands;
      let accepted = Array.isArray(result) && result.length === tasks.length;
      for (let index = 0; accepted && index < tasks.length; index++) {
        const band = result[index], task = tasks[index];
        accepted = !!band && band.face === task.face && band.start === task.start && band.end === task.end &&
          typeof band.opaque === 'boolean' && band.buffer instanceof ArrayBuffer &&
          band.buffer.byteLength === (task.end - task.start) * size * 4;
      }
      if (!accepted) {
        fallback();
        return;
      }
      for (const band of result) bands[band.face].push(band);
      if (--pending) return;
      pixels = bands.map(list => {
        if (list.length === 1) return list[0].buffer;
        const face = new Uint8Array(size * size * 4);
        for (const band of list) face.set(new Uint8Array(band.buffer), band.start * size * 4);
        return face.buffer;
      });
      opaque = bands.map(list => list.every(band => band.opaque));
      settle();
    };
    // A copy shares the decoded pixels and transfers without the page thread
    // serializing them; a plain structured clone would copy every face here.
    const copies = await Promise.all(plan.map(tasks => Promise.all(images.map((image, face) =>
      !tasks.some(task => task.face === face) ? null : typeof environment.createImageBitmap === 'function' ? environment.createImageBitmap(image) : image))));
    const owned = copies.flat().filter(copy => copy && !images.includes(copy));
    if (settled || cancelled) {
      for (const copy of owned) copy.close();
      return;
    }
    workers.forEach((worker, slot) => {
      worker.onmessage = receive(plan[slot]);
      const sent = copies[slot].filter(copy => copy && !images.includes(copy));
      worker.postMessage({images: copies[slot], matrices, size, tasks: plan[slot]}, sent);
    });
  }

  // Workers start as soon as the sky is known to need conversion: from a
  // transform at once, or from the first face whose size differs. A sky of
  // equal square faces without transforms never starts them.
  let spawned = false;
  const sizes = new Set();
  function spawn() {
    if (spawned || settled || cancelled) return;
    spawned = true;
    try {
      if (typeof environment.Worker === 'function' && typeof environment.OffscreenCanvas === 'function' &&
          typeof environment.ImageBitmap === 'function' && typeof environment.Blob === 'function' &&
          typeof environment.URL?.createObjectURL === 'function') {
        const cores = environment.navigator?.hardwareConcurrency;
        const count = Number.isInteger(cores) ? Math.max(1, Math.min(6, cores >> 2)) : 1;
        const script = `(${workerMain.toString()})(${createResampler.toString()})`;
        const url = environment.URL.createObjectURL(new environment.Blob([script], {type: 'text/javascript'}));
        try {
          for (let index = 0; index < count; index++) {
            const worker = new environment.Worker(url);
            worker.onerror = fallback;
            worker.onmessageerror = fallback;
            workers.push(worker);
          }
        } finally {
          environment.URL.revokeObjectURL(url);
        }
      }
    } catch {
      stopWorker();
    }
  }

  function observe(image) {
    if (spawned || settled || cancelled) return;
    sizes.add(`${image?.width}x${image?.height}`);
    if (sizes.size > 1 || image?.width !== image?.height) spawn();
  }

  if (signal.aborted) cancel(signal.reason);
  else {
    signal.addEventListener('abort', abort, {once: true});
    try {
      const identity = [1, 0, 0, 0, 1, 0];
      if ((transforms ?? []).some(transform => !parse(transform).every((value, axis) => Math.abs(value - identity[axis]) < 1e-12))) spawn();
    } catch {
      spawn();
    }
    Promise.resolve(faces).then(start).catch(() => fallback());
  }

  // Pixels handed to the renderer belong to its texture.
  function release() {}

  return {ready, finish, cancel, release, observe};
}
