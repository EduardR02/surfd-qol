import {runMapLoadWorker} from '../extension/map-load-worker.js';
import {createVisualPackProcessor} from '../extension/map-asset-worker.js';
import {decodeMapImage, decodeMapMesh} from '../extension/map-load-hooks.js';

runMapLoadWorker({createVisualPackProcessor, decodeImage: decodeMapImage, decodeMesh: decodeMapMesh});
