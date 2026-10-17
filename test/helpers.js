import { Store } from '../src/store.js';

export const ADDRESS = { name: 'Test Household', line1: '1 Main St', city: 'New York', region: 'NY', postal_code: '10001' };

/** Fresh in-memory store with one funded account on a fixed clock. */
export async function setup({ token = 'pm_card_visa', policy, household_size = 2 } = {}) {
  const store = new Store();
  const created = store.createAccount({ name: 'Test', household_size, start_date: '2026-01-05', policy });
  const agent = store.authenticate(created.api_key);
  const owner = store.authenticate(created.owner_key);
  await store.addPaymentMethod(agent, { token });
  store.addAddress(agent, ADDRESS);
  return { store, agent, owner, created };
}
