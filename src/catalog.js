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

// Concierge fulfillment places each order on Walmart.com, shipped straight to
// the customer, so every SKU is exactly one Walmart listing (packs can't be
// split). `source` is operator-only and never returned by the API.
const WALMART = (id, item, price_cents) => ({ retailer: 'Walmart', item, url: `https://www.walmart.com/ip/${id}`, price_cents, checked: '2026-10-17' });

/**
 * Our price from the retailer's: cover ~8% sales tax we pay the retailer, card
 * fees (2.9% + 30c) and keep ~25% of the subscription price (5% off list),
 * rounded up to the next .99. Walmart+ delivery is free, so there's no shipping cost.
 */
export const TARGET_MARGIN = 0.25;
export function priceFromCost(cost_cents, { taxRate = 0.08, cardPct = 0.029, cardFixed = 30, subDiscount = 0.05 } = {}) {
  const list = (cost_cents * (1 + taxRate) + cardFixed) / ((1 - subDiscount) * (1 - cardPct - TARGET_MARGIN));
  return Math.ceil((list + 1) / 100) * 100 - 1;
}

// usage: { per_person: base units / person / month, per_household: base units / household / month }
const P = (sku, category, brand, name, pack, source, attributes, usage, tags = []) => ({
  sku, category, name, brand, pack, price_cents: priceFromCost(source.price_cents), source, attributes, usage, tags,
});

export const PRODUCTS = [
  P('TP-2PLY-30', 'paper', 'Great Value', 'Toilet Paper, 2-ply, 30 mega rolls', { count: 30, unit: 'roll', base_units_per_unit: 1 },
    WALMART('20219668929', 'Great Value Soft & Strong Premium Toilet Paper, 30 Mega Rolls', 1893),
    { plies: 2, sheets_per_roll: 380, septic_safe: true }, { per_person: 7, per_household: 0 }, ['bestseller']),
  P('PT-2PLY-12', 'paper', 'Great Value', 'Paper Towels, 12 double rolls', { count: 12, unit: 'roll', base_units_per_unit: 1 },
    WALMART('15106305176', 'Great Value Everyday Strong Paper Towels, 12 Double Rolls', 1092),
    { plies: 2, sheets_per_roll: 110 }, { per_person: 1.5, per_household: 2 }, ['bestseller']),
  P('KT-CLOTH-4', 'paper', 'Mainstays', 'Cotton Waffle Dishcloths, 4 pack', { count: 4, unit: 'cloth', base_units_per_unit: 1 },
    WALMART('3145627268', 'Mainstays 4-Pack Waffle Dishcloth Set, 100% Cotton, Gray, 12x12', 512),
    { material: 'cotton', machine_washable: true, size_in: '12x12' }, { per_person: 0, per_household: 0.4 }, ['reusable']),
  P('TIS-3PLY-6', 'paper', 'Great Value', 'Facial Tissues, 3-ply, 6 boxes', { count: 6, unit: 'box', base_units_per_unit: 1 },
    WALMART('323377518', 'Great Value Ultra Soft Facial Tissues, 3-Ply, 6 Flat Cartons, 120 per Carton', 948),
    { plies: 3, tissues_per_box: 120 }, { per_person: 1, per_household: 0 }),
  P('NAP-500', 'paper', 'Great Value', 'Paper Napkins, 500 count', { count: 500, unit: 'napkin', base_units_per_unit: 1 },
    WALMART('363821204', 'Great Value White Disposable Paper Napkins, 500 Count', 348),
    { color: 'white' }, { per_person: 40, per_household: 0 }),

  P('DISH-LIQ-90', 'kitchen', 'Great Value', 'Dish Soap, original, 90 oz', { count: 1, unit: 'bottle', base_units_per_unit: 90, base_unit: 'oz' },
    WALMART('18611056326', 'Great Value Ultra Original Dish Liquid, 90 fl oz', 714),
    { scent: 'original', volume_oz: 90 }, { per_person: 4, per_household: 4 }),
  P('DW-PODS-115', 'kitchen', 'Great Value', 'Dishwasher Pods, 115 count', { count: 115, unit: 'pod', base_units_per_unit: 1 },
    WALMART('16759055075', 'Great Value Original Dishwasher Detergent Pacs, 115 Count', 1394),
    {}, { per_person: 5, per_household: 8 }, ['bestseller']),
  P('SPONGE-8', 'kitchen', 'Great Value', 'Non-scratch Scrub Sponges, 8 pack', { count: 8, unit: 'sponge', base_units_per_unit: 1 },
    WALMART('1097258886', 'Great Value Non-Scratch Scrub Sponges, 8 Count', 397),
    { non_scratch: true }, { per_person: 0.5, per_household: 2 }),
  P('TRASH-13G-90', 'kitchen', 'Great Value', 'Tall Kitchen Trash Bags, 13 gal, 90 count', { count: 90, unit: 'bag', base_units_per_unit: 1 },
    WALMART('609214552', 'Great Value Strong Flex 13 Gallon Drawstring Trash Bags, 90 Count', 1047),
    { gallons: 13, drawstring: true }, { per_person: 6, per_household: 6 }, ['bestseller']),
  P('FOIL-225', 'kitchen', 'Great Value', 'Aluminum Foil, 225 sq ft', { count: 1, unit: 'roll', base_units_per_unit: 225, base_unit: 'sq_ft' },
    WALMART('877246154', 'Great Value Aluminum Foil, 225 sq ft', 1288),
    { sq_ft: 225 }, { per_person: 10, per_household: 10 }),
  P('ZIP-GAL-80', 'kitchen', 'Great Value', 'Gallon Storage Bags, 80 count', { count: 80, unit: 'bag', base_units_per_unit: 1 },
    WALMART('44676672', 'Great Value Fresh Seal Double Zipper Gallon Storage Bags, 80 Count', 537),
    { size: 'gallon', double_zipper: true }, { per_person: 8, per_household: 4 }),

  P('LAUN-LIQ-115', 'laundry', 'Purex', 'Laundry Detergent, free & clear, 115 loads', { count: 1, unit: 'jug', base_units_per_unit: 115, base_unit: 'load' },
    WALMART('1932061430', 'Purex Free & Clear Liquid Laundry Detergent, 150 fl oz, 115 Loads', 997),
    { loads: 115, he_compatible: true, scent: 'free & clear' }, { per_person: 8, per_household: 4 }, ['bestseller']),
  P('LAUN-PODS-76', 'laundry', 'Great Value', 'Laundry Pods, 76 count', { count: 76, unit: 'pod', base_units_per_unit: 1 },
    WALMART('14542851188', 'Great Value Premium Clean Laundry Pacs, Original Scent, 76 Count', 1497),
    { loads: 76, he_compatible: true, scent: 'original' }, { per_person: 8, per_household: 4 }),
  P('DRYER-240', 'laundry', 'Bounce', 'Dryer Sheets, unscented, 240 count', { count: 240, unit: 'sheet', base_units_per_unit: 1 },
    WALMART('156163578', 'Bounce Free & Gentle Unscented Dryer Sheets, 240 Count', 1047),
    { scent: 'unscented' }, { per_person: 8, per_household: 4 }),

  P('APC-SPRAY-2', 'cleaning', 'Clorox', 'All-purpose Cleaner, free & clear, 2 x 32 oz', { count: 2, unit: 'bottle', base_units_per_unit: 32, base_unit: 'oz' },
    WALMART('20775504917', 'Clorox Free & Clear Multi-Surface Spray Cleaner, 32 fl oz, 2 Pack', 772),
    { volume_oz: 32, bleach_free: true, fragrance_free: true, epa_safer_choice: true }, { per_person: 4, per_household: 8 }),
  P('WIPES-225', 'cleaning', 'Great Value', 'Disinfecting Wipes, 3 x 75 count', { count: 225, unit: 'wipe', base_units_per_unit: 1 },
    WALMART('35067463', 'Great Value Disinfecting Wipes, Lemon & Fresh Scent, 3 x 75 Count', 1047),
    { kills_99_9: true, scent: 'lemon and fresh' }, { per_person: 25, per_household: 20 }),

  P('HSOAP-REFILL-56', 'bath', 'Equate', 'Hand Soap Refill, 56 oz', { count: 1, unit: 'bottle', base_units_per_unit: 56, base_unit: 'oz' },
    WALMART('21674376', 'Equate Clear Liquid Hand Soap Refill, 56 fl oz', 297),
    { volume_oz: 56 }, { per_person: 5, per_household: 2 }),
  P('TPASTE-6', 'bath', 'Colgate', 'Fluoride Toothpaste, 6 x 6 oz', { count: 6, unit: 'tube', base_units_per_unit: 6, base_unit: 'oz' },
    WALMART('580400401', 'Colgate Cavity Protection Toothpaste, 6 oz, 6 Pack', 920),
    { fluoride: true, volume_oz: 6 }, { per_person: 1.5, per_household: 0 }),
  P('FLOSS-6', 'bath', 'Equate', 'Mint Waxed Floss, 6 x 55 yd', { count: 6, unit: 'spool', base_units_per_unit: 55, base_unit: 'yd' },
    WALMART('13317917267', 'Equate Mint Waxed Floss, 55 yd, 6 Pack', 510),
    { length_yd: 55, waxed: true }, { per_person: 16, per_household: 0 }),

  P('BATT-AA-24', 'household', 'Great Value', 'Alkaline AA Batteries, 24 pack', { count: 24, unit: 'battery', base_units_per_unit: 1 },
    WALMART('16400974503', 'Great Value Alkaline AA Batteries, 24 Pack', 997),
    { chemistry: 'alkaline' }, { per_person: 0.5, per_household: 1 }),
  P('BATT-AAA-24', 'household', 'Great Value', 'Alkaline AAA Batteries, 24 pack', { count: 24, unit: 'battery', base_units_per_unit: 1 },
    WALMART('16464905769', 'Great Value Alkaline AAA Batteries, 24 Pack', 997),
    { chemistry: 'alkaline' }, { per_person: 0.5, per_household: 1 }),
  P('COFFEE-FLT-400', 'household', 'Rockline', '#4 Cone Coffee Filters, 400 count', { count: 400, unit: 'filter', base_units_per_unit: 1 },
    WALMART('536094743', 'Rockline #4 Cone Coffee Filters, 400 Count', 1497),
    { size: '#4 cone' }, { per_person: 15, per_household: 0 }),
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
