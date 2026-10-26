// Pure HUD view model: every decision about what the HUD shows, with no DOM.
// The view renders this once per 67 ms tick; speed and timer stay on the
// view's own frame-capped fast path.

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const milliseconds = Math.round(seconds * 1000);
  return `${String(Math.floor(milliseconds / 60000)).padStart(2, '0')}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
}
export function formatDelta(value, digits = 0) {
  if (!Number.isFinite(value)) return '—';
  const rounded = Number(value.toFixed(digits));
  return `${rounded > 0 ? '+' : rounded < 0 ? '−' : '±'}${Math.abs(rounded).toFixed(digits)}`;
}
export const formatNumber = (value, digits = 0) => Number.isFinite(value) ? value.toFixed(digits) : '—';
export function formatSplitDelta(seconds, referenceUs) {
  if (!Number.isFinite(seconds) || !Number.isSafeInteger(referenceUs)) return null;
  const milliseconds = Math.round((Math.round(seconds * 1e6) - referenceUs) / 1000);
  return {
    text: `${milliseconds > 0 ? '+' : milliseconds < 0 ? '−' : '±'}${(Math.abs(milliseconds) / 1000).toFixed(3)}`,
    tone: milliseconds < 0 ? 'good' : milliseconds > 0 ? 'loss' : 'muted'
  };
}
export function startTone(value, amazingBelow, goodBelow) {
  return !Number.isFinite(value) ? 'muted' : value < amazingBelow ? 'good' : value < goodBelow ? 'warn' : 'loss';
}
export function referenceTone(value, reference, tolerance = 0) {
  if (!Number.isFinite(value) || !Number.isFinite(reference)) return 'muted';
  const difference = Number((value - reference).toFixed(1));
  return difference <= 0 ? 'good' : difference <= tolerance ? 'warn' : 'loss';
}
export const syncTone = sync => !Number.isFinite(sync) ? 'muted' : sync >= 95 ? 'good' : sync >= 85 ? 'warn' : 'loss';
const lossTone = (loss, good, warning) => !Number.isFinite(loss) ? 'muted' : loss <= good ? 'good' : loss <= warning ? 'warn' : 'loss';
const relative = source => source === 'pb' || source === 'wr';

// The shared slot selects by completion time, not availability: an unavailable
// enabled result must show a dash rather than borrowing a disabled metric.
export function selectFeedbackType(metrics, settings) {
  const air = settings.showAir !== false, surf = settings.showSurf !== false;
  if (!air) return surf ? 'surf' : null;
  if (!surf) return 'air';
  if (settings.continuousFeedback === true) return metrics?.strafe?.mode === 'surf' ? 'surf' : 'air';
  return Number.isFinite(metrics?.surf?.tick) &&
    (!Number.isFinite(metrics?.air?.tick) || metrics.surf.tick >= metrics.air.tick) ? 'surf' : 'air';
}

const slot = (hidden, label, value, tone, title, stale = false) => ({
  hidden, label, value: hidden ? null : value, text: hidden || value === null ? '—' : formatDelta(-value, 1),
  tone: hidden || value === null ? 'muted' : tone, title, stale,
});

export function buildFeedback(metrics, runRefs, settings) {
  const continuous = settings.continuousFeedback === true;
  const type = selectFeedbackType(metrics, settings);
  const split = settings.rampResult !== 'total';
  const margin = settings.referenceLossTolerance;
  const boardHidden = settings.showBoard === false;
  const reference = (field, value) => referenceTone(value, runRefs?.[field]?.status === 'ready' ? runRefs[field].loss : null, margin);
  const sourceName = source => source === 'pb' ? 'PB' : settings.wrSource === 'leaderboard' ? 'site WR' : 'KSF WR';
  const referenceNote = (field, source) => {
    const ref = runRefs?.[field];
    return ref?.status === 'ready' ? ` ${sourceName(source)} on this ramp: ${formatDelta(-ref.loss, 1)}.` : ` ${sourceName(source)} ${ref?.status ?? 'missing'}.`;
  };
  if (continuous) {
    const strafe = metrics?.strafe?.mode === type ? metrics.strafe : null;
    const strafeLoss = strafe?.available && Number.isFinite(strafe.loss) ? strafe.loss : null;
    const ramp = metrics?.ramp;
    const rampLoss = ramp?.available && Number.isFinite(ramp.loss) ? ramp.loss : null;
    const result = slot(type === null, type === 'surf' ? 'INPUT' : 'STRAFE', strafeLoss, lossTone(strafeLoss, .5, 5),
      type === 'surf' ? 'Live ramp input against the best same-pressure input.' : 'Live missed strafe gain over the recent window.');
    const board = slot(boardHidden, ramp?.kind === 'turn' ? 'CLIP' : ramp?.kind === 'contact' ? 'CONTACT' : 'BOARD', rampLoss,
      startTone(rampLoss, settings.boardLossAmazing, settings.boardLossGood), 'Live ramp collision loss.');
    const up = slot(true, 'UP', null, 'muted', '');
    return { hidden: result.hidden && board.hidden, result, board, up };
  }
  const air = metrics?.air, surf = metrics?.surf, boardMetric = metrics?.board;
  const airMetric = settings.airMetric === 'missed' || settings.airMetric === 'braking' ? settings.airMetric : 'combined';
  let result;
  if (type === 'air') {
    const value = !air?.available ? null : airMetric === 'missed' ? air.missedGain : airMetric === 'braking' ? air.brakingLoss : air.loss;
    result = slot(false, airMetric === 'missed' ? 'MISSED' : airMetric === 'braking' ? 'BRAKE' : 'AIR', Number.isFinite(value) ? value : null,
      startTone(value, settings.airLossAmazing, settings.airLossGood),
      `Last flight: ${formatNumber(air?.brakingLoss, 1)} air braking + ${formatNumber(air?.missedGain, 1)} missed strafe gain.`);
  } else if (type === 'surf') {
    const field = split ? 'down' : 'surf';
    const value = surf?.available && Number.isFinite(split ? surf.downLoss : surf.loss) ? (split ? surf.downLoss : surf.loss) : null;
    const source = settings.surfColorReference;
    result = slot(false, split ? 'DOWN' : 'SURF', value,
      relative(source) ? reference(field, value) : startTone(value, settings.airLossAmazing, settings.airLossGood),
      (split ? 'Last ramp, on the way down (includes the board).' : 'Last ramp, net against gravity-only conversion (includes the board).') +
        (relative(source) ? referenceNote(field, source) : ''));
  } else result = slot(true, 'AIR', null, 'muted', '');

  const rampShown = settings.showSurf !== false;
  const upValue = surf?.available && Number.isFinite(surf.upLoss) ? surf.upLoss : null;
  // Up always belongs to the same ramp as Down. Once a newer flight takes the
  // shared slot it describes the previous ramp, so it is flagged stale.
  const up = slot(!rampShown || !split, 'UP', upValue,
    relative(settings.surfColorReference) ? reference('up', upValue) : startTone(upValue, settings.airLossAmazing, settings.airLossGood),
    'Last ramp, on the way up.' + (relative(settings.surfColorReference) ? referenceNote('up', settings.surfColorReference) : ''),
    rampShown && split && type === 'air');

  const boardLoss = boardMetric?.available && Number.isFinite(boardMetric.loss) ? boardMetric.loss : null;
  const boardSource = settings.boardColorReference;
  const board = slot(boardHidden, 'BOARD', boardLoss,
    relative(boardSource) ? reference('board', boardLoss) : startTone(boardLoss, settings.boardLossAmazing, settings.boardLossGood),
    'Collision loss at the latest ramp entry.' + (relative(boardSource) ? referenceNote('board', boardSource) : ''));
  return { hidden: result.hidden && board.hidden && up.hidden, result, board, up };
}

// The ramp meter: the last flight and the latest ramp, in the order they
// happened. Down runs from just before the board clip, so the bar draws the
// board, the rest of the way down, then the way up, and Surf (Down + Up) is
// the whole ramp, board included. Right after boarding a new ramp, the
// finished one stays as a ghost behind the new board.
export function buildMeter(metrics, runRefs, settings) {
  const margin = settings.referenceLossTolerance;
  const reference = field => runRefs?.[field]?.status === 'ready' && Number.isFinite(runRefs[field].loss) ? runRefs[field].loss : null;
  const finite = value => Number.isFinite(value) ? value : null;
  const board = metrics?.board, surf = metrics?.surf, air = metrics?.air;
  const boardLoss = settings.showBoard !== false && board?.available ? finite(board.loss) : null;
  const rampShown = settings.showSurf !== false && surf?.available === true;
  const down = rampShown ? finite(surf.downLoss) : null, up = rampShown ? finite(surf.upLoss) : null, total = rampShown ? finite(surf.loss) : null;
  const airValue = settings.showAir !== false && air?.available
    ? finite(settings.airMetric === 'missed' ? air.missedGain : settings.airMetric === 'braking' ? air.brakingLoss : air.loss) : null;
  // A board newer than the last finished ramp belongs to the ramp you're on.
  const fresh = board?.available === true && Number.isFinite(board.tick) &&
    (!surf?.available || !Number.isFinite(surf.tick) || board.tick > surf.tick);
  const boardTone = relative(settings.boardColorReference) ? referenceTone(boardLoss, reference('board'), margin)
    : startTone(boardLoss, settings.boardLossAmazing, settings.boardLossGood);
  const rampTone = (field, value) => relative(settings.surfColorReference) ? referenceTone(value, reference(field), margin)
    : startTone(value, settings.airLossAmazing, settings.airLossGood);
  const item = (value, tone, stale = false) => value === null ? null : {value, text: formatDelta(-value, 1), tone, stale};
  const boardItem = item(boardLoss, boardTone), surfItem = item(total, rampTone('surf', total), fresh);
  return {
    hidden: boardItem === null && surfItem === null && airValue === null,
    fresh, split: settings.rampResult !== 'total',
    air: item(airValue, startTone(airValue, settings.airLossAmazing, settings.airLossGood)),
    board: boardItem,
    down: item(down, rampTone('down', down), fresh), up: item(up, rampTone('up', up), fresh), surf: surfItem,
    // The reference ramp's loss spans the speed's width; null grades on fixed cutoffs.
    // A new ramp's board is drawn at the last ramp's scale, so the bar doesn't jump.
    reference: relative(settings.surfColorReference) ? reference('surf') : null,
    // What the ramp you're on has cost so far: its board, then the whole ramp.
    ramp: fresh ? boardItem : surfItem ?? boardItem,
  };
}

export function buildStart(start, startReference, settings, spectator) {
  const relativeStart = relative(settings.startColorReference);
  const ready = startReference?.status === 'ready';
  const available = start?.available === true;
  const sourceName = settings.startColorReference === 'pb' ? 'PB' : settings.wrSource === 'leaderboard' ? 'site WR' : 'KSF WR';
  const note = relativeStart
    ? ready ? `${sourceName}: ${formatNumber(startReference.speed, 1)} u/s, ${formatDelta(startReference.heightAboveFloor, 1)} u.` : `${sourceName} ${startReference?.status ?? 'missing'}.`
    : 'Fixed targets.';
  return {
    hidden: spectator || settings.showStart === false || !available || start.age > 1800,
    title: note,
    speed: {
      text: available ? formatNumber(start.speed) : '—',
      tone: relativeStart
        ? referenceTone(ready ? startReference.speed : null, available ? start.speed : null)
        : startTone(available ? Math.max(0, -start.speedDelta) : null, settings.startDeficitAmazing, settings.startDeficitGood),
      title: available ? `${formatNumber(start.speed, 1)} u/s at exit; ${start.label === 'Unrestricted start' ? 'uncapped start' : `${formatDelta(start.speedDelta, 1)} versus the ${formatNumber(start.targetSpeed)} cap`}.` : '',
    },
    height: {
      text: Number.isFinite(start?.heightAboveFloor) ? formatDelta(start.heightAboveFloor, 1) : '—',
      tone: relativeStart
        ? referenceTone(start?.heightAboveFloor, ready ? startReference.heightAboveFloor : null)
        : startTone(Number.isFinite(start?.heightAboveFloor) ? Math.max(0, start.heightAboveFloor) : null, settings.startHeightAmazing, settings.startHeightGood),
      title: 'Feet height above the start platform; lower is better.',
    },
  };
}

// Checkpoint splits show for 6.5 s after progress changes; the model keeps
// that clock so the view stays a pure renderer.
export function createHudModel(clock = () => performance.now()) {
  let splitOwner = null, splitIndex = -1, splitAt = -Infinity;
  return function buildHudModel({snapshot, session, view, metrics, refs, runRefs, settings, inSurf = true, bindingStatus = null}) {
    const spectator = view?.target != null;
    const zen = settings.zen === true;
    // Replays and spectating show everything; a live run uses the compact
    // surfing layout unless the full HUD is chosen for surfing too.
    const layout = zen ? 'zen' : spectator || snapshot?.playback || settings.surfHud === 'full' ? 'full' : 'surf';
    const continuous = settings.continuousFeedback === true;
    const pose = spectator ? view.view?.pose : null;
    const timer = spectator ? null : snapshot?.run ?? session?.timer?.state;
    const now = clock();
    const sync = spectator ? null : snapshot?.strafeSync?.percentage;
    const runState = spectator
      ? `SPECTATING · ${view.view?.player?.name ?? 'PLAYER'}${!pose ? ' · WAITING' : view.view?.stale ? ' · STALE' : ''}`
      : snapshot?.playback ? 'REPLAY' : session?.practice ? 'PRACTICE' : timer?.invalidReason ? 'INVALID'
        : !session ? 'CONNECT EXTENSION' : timer?.phase === 'finished' ? 'FINISHED' : '';

    const speeds = spectator ? null : session?.checkpointSpeeds;
    const index = (speeds?.length ?? 0) - 1;
    const viewedCheckpoint = Number.isInteger(pose?.checkpoints) ? pose.checkpoints : null;
    const owner = spectator ? view.target : session;
    const progress = spectator ? (viewedCheckpoint ?? -1) : index;
    if (splitOwner !== owner || splitIndex !== progress) { splitOwner = owner; splitIndex = progress; splitAt = now; }
    const fresh = now - splitAt <= 6500;
    const recordSource = refs?.recordSource ?? settings.wrSource;
    const comparison = (id, values, status, splitsUs) => {
      const delta = !spectator && index >= 0 && Number.isFinite(values?.[index]) ? speeds[index] - values[index] : null;
      const time = !spectator && index >= 0 ? formatSplitDelta(timer?.splits?.[index], splitsUs?.[index]) : null;
      return {
        hidden: spectator || (id === 'pb' ? settings.checkpointReference === 'wr' : settings.checkpointReference === 'pb'),
        label: id === 'pb' ? 'PB' : recordSource === 'leaderboard' ? 'SITE' : 'KSF',
        time: { text: time?.text ?? '—', tone: time?.tone ?? 'muted', title: '' },
        speed: {
          text: delta === null ? '—' : formatDelta(delta), tone: delta === null ? 'muted' : delta < 0 ? 'loss' : 'good',
          title: delta === null
            ? status === 'loading' ? id === 'wr' ? `Loading ${recordSource === 'leaderboard' ? 'Surfd leaderboard #1' : 'KSF record route'}…` : 'Reconstructing your PB replay…' : 'No matching checkpoint reference.'
            : `Reference: ${formatNumber(values[index], 1)} u/s`,
        },
      };
    };
    const kind = session?.map?.stages?.length ? 'S' : 'CP';
    const checkpoint = spectator ? {
      hidden: !pose || !viewedCheckpoint || pose.phase === 'ready' || !fresh,
      label: !pose ? '' : view.view?.detailed ? `CP ${viewedCheckpoint ?? '—'}${Number.isInteger(pose?.stage) && pose.stage > 0 ? ` · S${pose.stage}` : ''}` : 'CP —',
      time: '—', speed: '—',
      pb: comparison('pb', null, null, null), wr: comparison('wr', null, null, null),
    } : {
      hidden: index < 0 || !fresh,
      label: index >= 0 ? `${kind}${index + 1}` : '',
      time: formatTime(timer?.splits?.[index]),
      speed: index >= 0 ? formatNumber(speeds[index]) : '—',
      pb: comparison('pb', refs?.own, refs?.ownStatus, refs?.ownSplitsUs),
      wr: comparison('wr', refs?.record, refs?.recordStatus, refs?.recordSplitsUs),
    };

    const startModel = buildStart(metrics?.start, runRefs?.start, settings, spectator);
    const checkpointModel = zen ? {...checkpoint, hidden: true} : checkpoint;
    const replayDuck = session?.state?.ducked;
    const bindingText = typeof bindingStatus === 'string' ? bindingStatus : bindingStatus?.message;
    // Per-tick reasons (air, no-wish, surf…) are not user-facing; only real problems are.
    const analysisStatus = metrics?.status === 'unsupported-physics' ? 'Unsupported acceleration physics; strafe feedback excluded.' : '';
    const feedbackStatus = spectator
      ? 'Spectating: coaching needs a local physics session, so only speed, time and checkpoints are shown.'
      : !session ? 'Physics adapter unavailable; reload Surfd with the extension enabled.' : analysisStatus;
    return {
      spectator,
      // Last completed tick touched a ramp ('surf') or not ('air', including
      // ground); null when unknown. Used to keep the speed tint off ramps.
      motion: spectator || metrics?.active === false ? null : metrics?.strafe?.mode ?? null,
      zen, layout,
      // The timer row: sync, time and run label. While surfing, the start and
      // checkpoint deltas take its place, and sync shows only with the start.
      clock: { hidden: zen || layout === 'surf' && (!startModel.hidden || !checkpointModel.hidden) },
      sync: { hidden: zen || layout === 'surf' || settings.showSync === false || spectator, value: Number.isFinite(sync) ? sync : null,
        text: Number.isFinite(sync) ? `${sync.toFixed(1)}%` : '—', tone: syncTone(sync) },
      runState: { text: runState, title: spectator ? runState : timer?.invalidReason || '' },
      // Live feedback keeps its own row; everything else is the ramp meter.
      feedback: spectator || zen || !continuous ? buildFeedback(null, null, {...settings, showBoard: false, showAir: false, showSurf: false}) : buildFeedback(metrics, runRefs, settings),
      meter: spectator || zen || continuous ? {hidden: true} : buildMeter(metrics, runRefs, settings),
      start: startModel,
      startSync: { hidden: layout !== 'surf' || startModel.hidden || settings.showSync === false || !Number.isFinite(sync),
        text: Number.isFinite(sync) ? `${sync.toFixed(1)}%` : '', tone: syncTone(sync) },
      checkpoint: checkpointModel,
      hull: { hidden: snapshot?.playback !== true || spectator || !inSurf || typeof replayDuck !== 'boolean', crouched: replayDuck === true },
      status: [feedbackStatus, bindingText].filter(Boolean).join(' · '),
    };
  };
}
