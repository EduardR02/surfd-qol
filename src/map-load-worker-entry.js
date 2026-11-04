import {runMapLoadWorker} from '../extension/map-load-worker.js';
import {createVisualPackProcessor} from '../extension/map-asset-worker.js';
import {decodeMapImage, decodeMapMesh} from '../extension/map-load-hooks.js';
import {buildMapBoundsTree} from '../extension/map-bvh-preparation.js';
import {buildPackedRampPreparation} from './map-ramp-preparation.js';

runMapLoadWorker({createVisualPackProcessor, decodeImage: decodeMapImage, decodeMesh: decodeMapMesh,
  buildMapBoundsTree, buildPackedRampPreparation});
