#!/usr/bin/env -S node --no-warnings
// Write the catalog as a Shopify product import file, so the same products and
// prices can be listed on a Shopify storefront (where Muse and other assistants
// check out with Shop Pay). Products import as drafts, unpublished; nothing is
// for sale until someone sets them to Active in Shopify.
//
//   node scripts/shopify-csv.js [out.csv]      (default: stdout)

import { writeFileSync } from 'node:fs';
import { CATEGORIES, PRODUCTS, baseUnitsPerPack } from '../src/catalog.js';

const COLUMNS = [
  'Title', 'URL handle', 'Description', 'Vendor', 'Product category', 'Type', 'Tags',
  'Published on online store', 'Status', 'SKU', 'Barcodes', 'Option1 name', 'Option1 value',
  'Price', 'Compare-at price', 'Cost per item', 'Charge tax', 'Inventory tracker', 'Inventory quantity',
  'Continue selling when out of stock', 'Weight value (grams)', 'Weight unit for display',
  'Requires shipping', 'Fulfillment service', 'Product image URL', 'Image position', 'Image alt text',
  'Gift card', 'SEO title', 'SEO description',
];

const categoryName = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.name]));
const UNIT = { sq_ft: 'sq ft', oz: 'fl oz' };
const dollars = (cents) => (cents / 100).toFixed(2);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Attribute keys as a shopper reads them; true flags become plain labels.
const FLAG = {
  septic_safe: 'Septic safe', machine_washable: 'Machine washable', non_scratch: 'Non-scratch',
  drawstring: 'Drawstring', double_zipper: 'Double zipper', he_compatible: 'HE compatible',
  bleach_free: 'Bleach free', fragrance_free: 'Fragrance free', epa_safer_choice: 'EPA Safer Choice',
  kills_99_9: 'Kills 99.9% of germs', fluoride: 'Fluoride', waxed: 'Waxed',
};
const LABEL = { plies: 'Ply', sheets_per_roll: 'Sheets per roll', tissues_per_box: 'Tissues per box', size_in: 'Size (in)',
  volume_oz: 'Volume (fl oz)', gallons: 'Gallons', sq_ft: 'Square feet', loads: 'Loads', length_yd: 'Length (yd)' };

function facts(p) {
  const out = [];
  for (const [k, v] of Object.entries(p.attributes)) {
    if (v === true && FLAG[k]) out.push(FLAG[k]);
    else if (v !== false && LABEL[k]) out.push(`${LABEL[k]}: ${v}`);
    else if (typeof v === 'string') out.push(`${k[0].toUpperCase()}${k.slice(1).replace(/_/g, ' ')}: ${v}`);
  }
  return out;
}

function row(p) {
  const base = baseUnitsPerPack(p);
  const unit = UNIT[p.pack.base_unit] ?? p.pack.base_unit ?? p.pack.unit;
  const perUnit = `$${(p.price_cents / 100 / base).toFixed(base >= 100 ? 3 : 2)} per ${unit}`;
  const title = `${p.brand} ${p.name}`;
  const description = [
    `<p>${esc(title)}. ${esc(`${base} ${unit}${base === 1 ? '' : 's'}`.replace(/(fl oz|sq ft)s$/, '$1'))} in every pack (${esc(perUnit)}).</p>`,
    `<ul>${facts(p).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`,
    '<p>Sold by Domaru. Set it up as a repeating delivery and it arrives before you run out.</p>',
  ].join('');
  return {
    'Title': title,
    'URL handle': p.sku.toLowerCase(),
    'Description': description,
    'Vendor': p.brand,
    'Product category': '',
    'Type': categoryName[p.category],
    'Tags': [categoryName[p.category], ...p.tags].join(', '),
    'Published on online store': 'false',
    'Status': 'draft',
    'SKU': p.sku,
    'Barcodes': '',
    'Option1 name': 'Title',
    'Option1 value': 'Default Title',
    'Price': dollars(p.price_cents),
    'Compare-at price': '',
    // What one pack costs us at the retailer, sales tax included. Shopify keeps it private.
    'Cost per item': dollars(Math.round(p.source.price_cents * 1.08)),
    'Charge tax': 'true',
    'Inventory tracker': '',
    'Inventory quantity': '',
    'Continue selling when out of stock': 'continue',
    'Weight value (grams)': '',
    'Weight unit for display': 'lb',
    'Requires shipping': 'true',
    'Fulfillment service': 'manual',
    'Product image URL': '',
    'Image position': '',
    'Image alt text': '',
    'Gift card': 'false',
    'SEO title': `${title} | Domaru`,
    'SEO description': `${title}, ${perUnit}. Delivered on a schedule that matches how fast your household uses it.`,
  };
}

const csv = [COLUMNS.join(','), ...PRODUCTS.map((p) => COLUMNS.map((c) => cell(row(p)[c])).join(','))].join('\n') + '\n';
const out = process.argv[2];
if (out) writeFileSync(out, csv);
else process.stdout.write(csv);
