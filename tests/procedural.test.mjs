import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

test('the public replacement supplies distinct building footprints and genuinely walkable ground without kit assets', async () => {
  const path = new URL('../packages/visual-world/src/city-plan.ts', import.meta.url);
  assert.ok(existsSync(path), 'An explicit owned procedural city layout is required');
  const { createPlanLayout, isPlanPaving } = await import(path.href);
  const buildings = createPlanLayout();
  assert.equal(buildings.length, 48);
  assert.equal(new Set(buildings.map(b => b.placeId)).size, 48);
  for (const b of buildings) {
    assert.ok(b.rect[1] > b.rect[0] && b.rect[3] > b.rect[2]);
    assert.equal(isPlanPaving(b.x, b.z), false);
    assert.equal(isPlanPaving(...b.frontage), true);
  }
  assert.equal(isPlanPaving(0, 0), true);
  assert.equal(isPlanPaving(60, 0), false);
});

test('procedural material data is locally authored flat colour and imported models are explicitly disabled', async () => {
  const path = new URL('../packages/visual-world/src/surface-patterns.ts', import.meta.url);
  assert.ok(existsSync(path), 'Explicit flat procedural materials are required');
  const { generateSurface } = await import(path.href);
  for (const kind of ['clay', 'graphite', 'stone']) {
    const data = generateSurface(kind, 0, 32);
    assert.equal(data.albedo.length, 32 * 32 * 4);
    for (let i = 4; i < data.albedo.length; i += 4) assert.deepEqual(data.albedo.slice(i, i + 4), data.albedo.slice(0, 4));
  }
  const { residentModelUrl } = await import('../packages/visual-world/src/resident-skins.ts');
  assert.equal(residentModelUrl({ id: 'resident-02', persona: 'luna' }), undefined);
});

test('the accepted shared home contract gives every synthetic home a connected door and safe camera', async () => {
  const { createCityLife2State } = await import('../packages/world-kernel/src/index.ts');
  const { planLayout } = await import('../packages/visual-world/src/city-plan.ts');
  const { resolveHomeView } = await import('../packages/visual-world/src/home-interior.ts');
  const { createPedestrianMap, isConnectedPosition } = await import('../packages/visual-world/src/pedestrian-path.ts');
  const { homeNeighbourVolumes, homeCameraPose, homeLensSafe } = await import('../packages/visual-world/src/home-camera.ts');
  const buildings = planLayout();
  assert.strictEqual(planLayout(), buildings, 'scene and home view must share one stable layout');
  const map = createPedestrianMap(buildings);
  const state = createCityLife2State('meridian-public-demo-v1', 24);
  for (const resident of Object.values(state.residents)) {
    const resolved = resolveHomeView(buildings, resident.homePlaceId);
    assert.equal(resolved.status, 'available', 'Every actual synthetic home must be enterable');
    const home = resolved.layout;
    assert.equal(isConnectedPosition(map, home.outside), true);
    const neighbours = homeNeighbourVolumes(buildings, home);
    for (const aspect of [0.65, 16 / 9]) {
      const pose = homeCameraPose(home, neighbours, aspect);
      assert.equal(homeLensSafe(neighbours, pose.position, pose.target), true);
    }
  }
});
