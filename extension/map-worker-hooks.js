import {createMapLoadJobs} from './map-load-worker.js';
import {zoneFloorCandidates} from './map-floor-hooks.js';

export function nativeMapWorkerHooks(source, workerSource) {
  if (!workerSource || source.includes('const __qolMapWorkerSource=')) return source;
  return `const __qolMapWorkerSource=${JSON.stringify(workerSource)};\n` +
    `const __qolFloorWorlds=new WeakMap;\n` +
    `const __qolZoneFloorCandidates=(${zoneFloorCandidates.toString()});\n` +
    `const __qolCreateMapLoadJobs=(${createMapLoadJobs.toString()});\n` + source;
}
