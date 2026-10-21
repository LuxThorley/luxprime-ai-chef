'use strict';
const test = require('node:test'); const assert = require('node:assert');
test('malcolm lattice mode: posts to /omni/command and falls back to library on a status-only reply', async () => {
  process.env.AI_PROVIDER = 'malcolm'; process.env.MALCOLM_AI_URL = 'https://example.invalid/'; process.env.MALCOLM_AI_KEY = 'test'; process.env.MALCOLM_AI_MODE = 'lattice';
  const ai = require('../src/ai'); const calls = [];
  const fetchImpl = async (url, o) => { calls.push({ url, body: JSON.parse(o.body) }); return { ok: true, json: async () => ({ status: 'executed', result: 'Command executed through the Omni-Lattice.' }) }; };
  const out = await ai.generate({ include: ['chicken', 'rice'], maxMinutes: 40, servings: 2, diets: [] }, { fetchImpl, retries: 0 });
  assert.equal(calls[0].url, 'https://example.invalid/omni/command'); assert.ok(typeof calls[0].body.command === 'string');
  assert.equal(out.source, 'offline'); assert.ok(out.recipes.length > 0);
  for (const k of ['AI_PROVIDER', 'MALCOLM_AI_URL', 'MALCOLM_AI_KEY', 'MALCOLM_AI_MODE']) delete process.env[k];
});
