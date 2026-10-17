// Seed catalog of household consumables.
//
// Every product carries machine-readable facts an agent needs to compare and
// plan without scraping a product page: pack size in base units, a normalized
// unit price, and a usage model (base units consumed per person per month plus
// a fixed per-household amount) used for cadence recommendations.

export const CATEGORIES = [
  { id: 'paper', name: 'Paper goods', description: 'Toilet paper, paper towels, tissues, napkins.' },
  { id: 'kitchen', name: 'Kitchen', description: 'Dish soap, dishwasher pods, sponges, trash bags, wraps.' },
  { id: 'laundry', name: 'Laundry', description: 'Detergent and dryer sheets.' },
  { id: 'cleaning', name: 'Cleaning', description: 'Surface cleaners and wipes.' },
  { id: 'bath', name: 'Bath & personal care', description: 'Hand soap, toothpaste, floss.' },
  { id: 'household', name: 'Household', description: 'Batteries, light bulbs, coffee filters.' },
];

// usage: { per_person: base units / person / month, per_household: base units / household / month }
const P = (sku, category, name, pack, price_cents, attributes, usage, tags = []) => ({
  sku, category, name, brand: 'Basics', pack, price_cents, attributes, usage, tags,
});

export const PRODUCTS = [
  P('TP-2PLY-24', 'paper', 'Toilet Paper, 2-ply, 24 double rolls', { count: 24, unit: 'roll', base_units_per_unit: 1 }, 2499,
    { plies: 2, sheets_per_roll: 300, septic_safe: true }, { per_person: 9, per_household: 0 }, ['bestseller']),
  P('TP-BAMBOO-24', 'paper', 'Bamboo Toilet Paper, 3-ply, 24 rolls', { count: 24, unit: 'roll', base_units_per_unit: 1 }, 3299,
    { plies: 3, sheets_per_roll: 300, septic_safe: true, material: 'bamboo', plastic_free_packaging: true }, { per_person: 9, per_household: 0 }, ['eco']),
  P('PT-2PLY-12', 'paper', 'Paper Towels, select-a-size, 12 rolls', { count: 12, unit: 'roll', base_units_per_unit: 1 }, 2799,
    { plies: 2, sheets_per_roll: 110, select_a_size: true }, { per_person: 1.5, per_household: 2 }, ['bestseller']),
  P('KT-CLOTH-6', 'paper', 'Reusable Kitchen Towels, cotton, 6 pack', { count: 6, unit: 'towel', base_units_per_unit: 1 }, 1899,
    { material: 'cotton', machine_washable: true }, { per_person: 0, per_household: 0.5 }, ['eco', 'reusable']),
  P('TIS-3PLY-8', 'paper', 'Facial Tissues, 3-ply, 8 boxes', { count: 8, unit: 'box', base_units_per_unit: 1 }, 1599,
    { plies: 3, tissues_per_box: 120, lotion: false }, { per_person: 1, per_household: 0 }),
  P('NAP-250', 'paper', 'Paper Napkins, 250 count', { count: 250, unit: 'napkin', base_units_per_unit: 1 }, 699,
    { compostable: true }, { per_person: 40, per_household: 0 }),

  P('DISH-LIQ-3', 'kitchen', 'Dish Soap, unscented, 3 x 22 oz', { count: 3, unit: 'bottle', base_units_per_unit: 22, base_unit: 'oz' }, 1199,
    { scent: 'unscented', volume_oz: 22 }, { per_person: 4, per_household: 4 }),
  P('DW-PODS-60', 'kitchen', 'Dishwasher Pods, 60 count', { count: 60, unit: 'pod', base_units_per_unit: 1 }, 1899,
    { phosphate_free: true }, { per_person: 5, per_household: 8 }, ['bestseller']),
  P('SPONGE-12', 'kitchen', 'Non-scratch Sponges, 12 pack', { count: 12, unit: 'sponge', base_units_per_unit: 1 }, 999,
    { non_scratch: true }, { per_person: 0.5, per_household: 2 }),
  P('TRASH-13G-90', 'kitchen', 'Tall Kitchen Trash Bags, 13 gal, 90 count', { count: 90, unit: 'bag', base_units_per_unit: 1 }, 2199,
    { gallons: 13, drawstring: true }, { per_person: 6, per_household: 6 }, ['bestseller']),
  P('FOIL-200', 'kitchen', 'Aluminum Foil, 200 sq ft', { count: 1, unit: 'roll', base_units_per_unit: 200, base_unit: 'sq_ft' }, 1099,
    { sq_ft: 200 }, { per_person: 10, per_household: 10 }),
  P('ZIP-GAL-75', 'kitchen', 'Gallon Storage Bags, 75 count', { count: 75, unit: 'bag', base_units_per_unit: 1 }, 899,
    { size: 'gallon', double_zipper: true }, { per_person: 8, per_household: 4 }),

  P('LAUN-LIQ-100', 'laundry', 'Laundry Detergent, free & clear, 100 loads', { count: 1, unit: 'jug', base_units_per_unit: 100, base_unit: 'load' }, 1999,
    { loads: 100, he_compatible: true, scent: 'free & clear' }, { per_person: 8, per_household: 4 }, ['bestseller']),
  P('LAUN-PODS-81', 'laundry', 'Laundry Pods, 81 count', { count: 81, unit: 'pod', base_units_per_unit: 1 }, 2299,
    { loads: 81, he_compatible: true }, { per_person: 8, per_household: 4 }),
  P('DRYER-240', 'laundry', 'Dryer Sheets, unscented, 240 count', { count: 240, unit: 'sheet', base_units_per_unit: 1 }, 899,
    { scent: 'unscented' }, { per_person: 8, per_household: 4 }),

  P('APC-SPRAY-3', 'cleaning', 'All-purpose Cleaner, 3 x 32 oz spray', { count: 3, unit: 'bottle', base_units_per_unit: 32, base_unit: 'oz' }, 1299,
    { volume_oz: 32, epa_safer_choice: true }, { per_person: 4, per_household: 8 }),
  P('WIPES-225', 'cleaning', 'Disinfecting Wipes, 3 x 75 count', { count: 225, unit: 'wipe', base_units_per_unit: 1 }, 1399,
    { kills_99_9: true, bleach_free: true }, { per_person: 25, per_household: 20 }),

  P('HSOAP-REFILL-2', 'bath', 'Hand Soap Refill, 2 x 34 oz', { count: 2, unit: 'bottle', base_units_per_unit: 34, base_unit: 'oz' }, 1299,
    { volume_oz: 34, scent: 'unscented' }, { per_person: 5, per_household: 2 }),
  P('TPASTE-4', 'bath', 'Fluoride Toothpaste, 4 x 6 oz', { count: 4, unit: 'tube', base_units_per_unit: 6, base_unit: 'oz' }, 1199,
    { fluoride: true, volume_oz: 6 }, { per_person: 1.5, per_household: 0 }),
  P('FLOSS-6', 'bath', 'Mint Floss, 6 x 50 m', { count: 6, unit: 'spool', base_units_per_unit: 50, base_unit: 'm' }, 899,
    { length_m: 50 }, { per_person: 15, per_household: 0 }),

  P('BATT-AA-24', 'household', 'Alkaline AA Batteries, 24 pack', { count: 24, unit: 'battery', base_units_per_unit: 1 }, 1699,
    { chemistry: 'alkaline', shelf_life_years: 10 }, { per_person: 0.5, per_household: 1 }),
  P('BATT-AAA-24', 'household', 'Alkaline AAA Batteries, 24 pack', { count: 24, unit: 'battery', base_units_per_unit: 1 }, 1699,
    { chemistry: 'alkaline', shelf_life_years: 10 }, { per_person: 0.5, per_household: 1 }),
  P('COFFEE-FLT-300', 'household', '#4 Cone Coffee Filters, 300 count', { count: 300, unit: 'filter', base_units_per_unit: 1 }, 799,
    { size: '#4 cone', unbleached: true }, { per_person: 15, per_household: 0 }),
];

/** Base units in one pack (e.g. 3 bottles x 22 oz = 66 oz). */
export function baseUnitsPerPack(p) {
  return p.pack.count * p.pack.base_units_per_unit;
}

/** Monthly base-unit consumption for a household. */
export function monthlyUsage(p, people) {
  return p.usage.per_person * people + p.usage.per_household;
}

/** Public shape returned by the API: adds normalized unit pricing. */
export function presentProduct(p) {
  const base = baseUnitsPerPack(p);
  return {
    sku: p.sku,
    name: p.name,
    category: p.category,
    brand: p.brand,
    price_cents: p.price_cents,
    currency: 'usd',
    pack: p.pack,
    unit_price_cents: Math.round((p.price_cents / p.pack.count) * 100) / 100,
    base_unit_price_cents: Math.round((p.price_cents / base) * 1000) / 1000,
    attributes: p.attributes,
    usage_model: { ...p.usage, base_unit: p.pack.base_unit ?? p.pack.unit },
    tags: p.tags,
    in_stock: true,
  };
}
