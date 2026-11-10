import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalize, shuffle, formatTime } from '../src/names.js';

test('name matching ignores case, punctuation and Mount/Mt, Saint/St', () => {
  assert.equal(normalize('Mount Druitt'), normalize('mt druitt'));
  assert.equal(normalize('Saint Ives'), normalize('St Ives'));
  assert.equal(normalize('Brighton-Le-Sands'), normalize('brighton le sands'));
  assert.equal(normalize("O'Connell"), normalize('oconnell'));
  assert.notEqual(normalize('Bondi'), normalize('Bondi Beach'));
});

test('shuffle keeps every item', () => {
  const a = [1, 2, 3, 4, 5];
  assert.deepEqual(shuffle(a).sort(), a);
});

test('formatTime', () => {
  assert.equal(formatTime(65_000), '1:05');
});

test('suburb data: unique names, every feature has geometry', () => {
  const geo = JSON.parse(readFileSync(new URL('../src/data/suburbs.geojson', import.meta.url)));
  const keys = geo.features.map(f => normalize(f.properties.name));
  assert.ok(geo.features.length > 700);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(geo.features.every(f => f.geometry.coordinates.length));
});

test('suburb data: no water-only suburbs, every suburb has a known region', () => {
  const geo = JSON.parse(readFileSync(new URL('../src/data/suburbs.geojson', import.meta.url)));
  const names = new Set(geo.features.map(f => f.properties.name));
  for (const water of ['Botany Bay', 'Middle Harbour', 'North Harbour', 'Pittwater', 'Port Hacking']) {
    assert.ok(!names.has(water), water);
  }
  assert.equal(geo.regions.length, 10);
  assert.ok(geo.features.every(f => geo.regions.includes(f.properties.region)));
});
