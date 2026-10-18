import { Store } from '../src/store.js';

export const ADDRESS = { name: 'Test Household', line1: '1 Main St', city: 'New York', region: 'NY', postal_code: '10001' };

/** Owner auth as the signed-in household would have it (via the emailed sign-in link). */
export const ownerOf = (accountId) => ({ accountId, role: 'owner' });

/** Fresh in-memory store with one funded account on a fixed clock. The owner set the address and any limits. */
export async function setup({ token = 'pm_card_visa', policy, household_size = 2, store = new Store() } = {}) {
  const created = store.createAccount({ name: 'Test', email: 'owner@example.com', household_size, start_date: '2026-01-05' });
  const agent = store.authenticate(created.api_key);
  const owner = ownerOf(agent.accountId);
  if (policy) store.updatePolicy(owner, policy);
  await store.addPaymentMethod(agent, { token });
  store.addAddress(owner, ADDRESS);
  return { store, agent, owner, created };
}
