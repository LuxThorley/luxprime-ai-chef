const test = require('node:test'); const assert = require('node:assert');
test('admin household associates get Restauranteur; others Gastronomique', () => {
  process.env.ADMIN_EMAILS = 'boss@example.org'; const P = require('../src/plans');
  assert.strictEqual(P.associatePlan({ email: 'boss@example.org' }), 'restaurant'); assert.strictEqual(P.associatePlan({ email: 'owner@example.org', plan: 'gastronomique' }), 'gastronomique');
  const invitee = { id: 9, email: 'fam@example.org', plan: P.associatePlan({ email: 'boss@example.org' }), sub_status: 'active', _associateOf: 1 };
  assert.ok(P.isRestaurateur(invitee)); assert.ok(P.isPremium(invitee)); assert.ok(P.magazineIncluded(invitee)); assert.strictEqual(P.planName(invitee), 'Restauranteur'); assert.ok(!P.canOwnSeats(invitee));
  assert.ok(P.isRestaurateur({ id: 18, email: 'v@example.org', plan: 'restaurant', sub_status: 'active' }));
  delete process.env.ADMIN_EMAILS;
});
