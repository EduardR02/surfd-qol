import {createCinemaWorkerRuntime} from './cinema-worker-runtime.js';
// The debugger response patch supplies native lexical hooks immediately after
// this bundled script. This is source delivery, not eval or a second worker.
globalThis.__surfdQolCreateCinemaWorker = createCinemaWorkerRuntime;
