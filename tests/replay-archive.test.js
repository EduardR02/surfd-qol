import { expect, test } from 'bun:test';
import { packReplay, unpackReplay } from '../src/replay-archive.js';

test('a packed replay unpacks to exactly the same commands, much smaller', async () => {
  let yaw = -94.72559999999929;
  const commands = Array.from({ length: 6000 }, (_, i) => {
    yaw += (i % 7) * 0.0132 - 0.0264;
    return { forward: i % 3 ? 0 : 400, side: i % 2 ? -400 : 400, jump: i % 50 === 0, duck: false, yaw, pitch: 10.084800000000019 + i * 1e-7 };
  });
  const replay = { format: 8, mapId: 'surf_utopia_njv', mapVersion: 'v1', config: { dt: 0.014999999664723873, gravity: 800 },
    initialState: { tick: 0, position: { x: 1.5, y: -2.25, z: 64 } }, commands };
  const packed = await packReplay(replay);
  expect(packed.byteLength).toBeLessThan(JSON.stringify(replay).length / 3);
  const back = await unpackReplay(packed);
  expect(back).toEqual(replay);
  expect(back.commands.every((command, i) => Object.is(command.yaw, commands[i].yaw) && Object.is(command.pitch, commands[i].pitch))).toBe(true);
  // Chunk joins (here every 7 commands) must not change anything.
  expect(await unpackReplay(await packReplay(replay, { chunk: 7, yieldTask: async () => {} }))).toEqual(replay);
  expect(await unpackReplay(await packReplay({ ...replay, commands: [] }))).toEqual({ ...replay, commands: [] });
});
