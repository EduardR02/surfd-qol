const identifier = '[A-Za-z_$][\\w$]*';
const literal = name => name.replace(/\$/g, () => '\\$');

function unique(source, pattern) {
  const matches = [...source.matchAll(pattern)];
  return matches.length === 1 ? matches[0] : null;
}

// Practice stations have a ready timer and no preceding splits. Let live play
// restart their current stage without inventing timer progress or clearing its
// invalidation. Replay seeking also restores practice snapshots, so practice
// alone must never opt Session.step into different simulation rules.
export function nativeStageResetHooks(source) {
  if (source.includes('__qolLiveStageReset')) return source;
  const session = unique(source, new RegExp(`stageRestartReason\\(\\)\\{if\\(!this\\.map\\.stages\\?\\.length\\)return"[^"]*";if\\(this\\.replayFormat<7\\)return"[^"]*";if\\(this\\.timer\\.state\\.phase!=="running"\\)return"[^"]*";if\\(this\\.state\\.pendingStageTeleport\\)return"[^"]*";const (${identifier})=this\\.state\\.stage\\?\\?1;return!this\\.map\\.stages\\[\\1-1\\]\\|\\|\\1!==this\\.timer\\.state\\.splits\\.length\\+1\\?"[^"]*":null\\}step\\((${identifier})\\)\\{this\\.previous=structuredClone\\(this\\.state\\);const (${identifier})=this\\.state\\.tick;if\\(this\\.commands\\.push\\(\\{\\.\\.\\.\\2\\}\\),this\\.replayFormat>=7&&\\2\\.restartStage&&this\\.stageRestartReason\\(\\)===null\\)`, 'g'));
  const action = unique(source, new RegExp(`if\\((${identifier})\\|\\|(${identifier})\\)\\{(${identifier})\\("Return to play before restarting a stage\\."\\);return\\}const (${identifier})=(${identifier})\\.stageRestartReason\\(\\);\\4\\?\\3\\(\\4\\):(${identifier})\\.queueStageRestart\\(\\)`, 'g'));
  if (!session || !action) return source;
  const [, replay, spectator, , , state, input] = action;
  const tick = unique(source, new RegExp(`const (${identifier})=${literal(input)}\\.sample\\(${literal(state)}\\.config\\.dt\\);\\1\\.restartStage&&${literal(state)}\\.stageRestartReason\\(\\)&&delete \\1\\.restartStage,${literal(replay)}\\|\\|${identifier}\\?\\.recordSpectatorInputs\\(${identifier}\\(\\1\\)\\);const (${identifier})=${identifier}\\(${literal(state)}\\),(${identifier})=${literal(state)}\\.step\\(\\1\\);`, 'g'));
  if (!tick) return source;

  // Match all three gates before changing any of them. Only these native
  // practice invalidations may bypass ready/progress checks, never map/version,
  // pending handoff, finished-run or missing-stage restrictions.
  const allowed = '__qolLiveStageReset===true&&this.practice&&(this.timer.state.phase==="ready"||this.timer.state.phase==="running")&&(this.timer.state.invalidReason==="Practice mode"||this.timer.state.invalidReason==="Practice restore"||this.timer.state.invalidReason==="Practice station")';
  const methods = session[0]
    .replace('stageRestartReason(){', `stageRestartReason(__qolLiveStageReset=false){const __qolPracticeStageReset=${allowed};`)
    .replace('if(this.timer.state.phase!=="running")', 'if(this.timer.state.phase!=="running"&&!__qolPracticeStageReset)')
    .replace(`${session[1]}!==this.timer.state.splits.length+1?`, `!__qolPracticeStageReset&&${session[1]}!==this.timer.state.splits.length+1?`)
    .replace(`step(${session[2]}){`, `step(${session[2]},__qolLiveStageReset=false){`)
    .replace('this.stageRestartReason()===null', 'this.stageRestartReason(__qolLiveStageReset)===null');
  const live = `!${replay}&&!${spectator}`;
  return source
    .replace(session[0], () => methods)
    .replace(action[0], () => action[0].replace(`${state}.stageRestartReason()`, `${state}.stageRestartReason(true)`))
    .replace(tick[0], () => tick[0]
      .replace(`${state}.stageRestartReason()`, `${state}.stageRestartReason(${live})`)
      .replace(`${state}.step(${tick[1]})`, `${state}.step(${tick[1]},${live})`));
}
