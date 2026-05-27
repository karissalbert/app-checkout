/* =========================================================
   Bloom — PayPal server-side backend
   Multi-item cart · secure (price computed on the server)
   ---------------------------------------------------------
   Run:   npm install   then   npm start
   Needs: a .env file (see .env.example)
   ========================================================= */

import express from 'express';
import 'dotenv/config';

const app = express();
app.use(express.json());
app.use(express.static('public'));   // serves index.html (the checkout page)

const {
  PAYPAL_CLIENT_ID,
  PAYPAL_SECRET,
  PAYPAL_ENV = 'sandbox',
  PORT = 3000,
  CURRENCY = 'USD'
} = process.env;

const BASE = PAYPAL_ENV === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

/* -----------------------------------------------------------
   TRUSTED CATALOG
   This is the source of truth for prices. The browser only
   sends item IDs + quantities — never prices. That way a user
   can't tamper with amounts in dev tools.
   ----------------------------------------------------------- */
const CATALOG = {
  'starter':   { name: 'BestIPTV4K Starter — 1 Month',      price: 17.00 },
  'quarterly': { name: 'BestIPTV4K Quarterly — 3 Months',   price: 31.00 },
  'premium':   { name: 'BestIPTV4K Premium — 6 Months',     price: 45.00 },
  'ultra':     { name: 'BestIPTV4K Ultra Annual — 12 Months', price: 64.00 }
};

const TAX_RATE = 0.00;   // set e.g. 0.13 for 13% Ontario HST if you charge tax
const PROMOS = {
  'IPTV10': { type: 'percent', value: 10 },
  'SAVE5':  { type: 'flat',    value: 5  }
};

const money = n => n.toFixed(2);

/* Compute totals from a cart of {id, qty} — server side only */
function priceCart(cart = [], promoCode = '') {
  const items = [];
  let subtotal = 0;

  for (const line of cart) {
    const product = CATALOG[line.id];
    const qty = Math.max(1, parseInt(line.qty, 10) || 1);
    if (!product) continue;
    const lineTotal = product.price * qty;
    subtotal += lineTotal;
    items.push({
      id: line.id, name: product.name,
      unit: product.price, qty, lineTotal
    });
  }

  let discount = 0;
  const promo = PROMOS[(promoCode || '').toUpperCase()];
  if (promo) {
    discount = promo.type === 'percent'
      ? subtotal * (promo.value / 100)
      : Math.min(promo.value, subtotal);
  }

  const taxable = Math.max(0, subtotal - discount);
  const tax = taxable * TAX_RATE;
  const total = taxable + tax;
  return { items, subtotal, discount, tax, total };
}

/* Get an OAuth access token from PayPal */
async function getToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) throw new Error('Failed to get PayPal token');
  const data = await res.json();
  return data.access_token;
}

/* Expose the client id + currency to the front-end safely */
app.get('/api/config', (req, res) => {
  res.json({ clientId: PAYPAL_CLIENT_ID, currency: CURRENCY });
});

/* Price a cart (so the page can show a live, trusted total) */
app.post('/api/quote', (req, res) => {
  const { cart, promo } = req.body || {};
  const q = priceCart(cart, promo);
  res.json({
    items: q.items,
    subtotal: money(q.subtotal),
    discount: money(q.discount),
    tax: money(q.tax),
    total: money(q.total)
  });
});

/* CREATE ORDER — amount is computed here, not trusted from client */
app.post('/api/orders', async (req, res) => {
  try {
    const { cart, promo } = req.body || {};
    const q = priceCart(cart, promo);
    if (q.total <= 0) return res.status(400).json({ error: 'Empty cart' });

    const token = await getToken();
    const r = await fetch(`${BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: CURRENCY,
            value: money(q.total),
            breakdown: {
              item_total: { currency_code: CURRENCY, value: money(q.subtotal) },
              discount:   { currency_code: CURRENCY, value: money(q.discount) },
              tax_total:  { currency_code: CURRENCY, value: money(q.tax) }
            }
          },
          items: q.items.map(it => ({
            name: it.name,
            quantity: String(it.qty),
            unit_amount: { currency_code: CURRENCY, value: money(it.unit) }
          }))
        }]
      })
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not create order' });
  }
});

/* CAPTURE ORDER — call this after the buyer approves */
app.post('/api/orders/:id/capture', async (req, res) => {
  try {
    const token = await getToken();
    const r = await fetch(`${BASE}/v2/checkout/orders/${req.params.id}/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    });
    const data = await r.json();

    // ✅ Only fulfill if PayPal confirms the capture completed
    if (data.status === 'COMPLETED') {
      // TODO: save order to your DB, send receipt email, grant access, etc.
      console.log('Payment completed:', data.id);
    }
    res.status(r.status).json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not capture order' });
  }
});

app.listen(PORT, () => {
  console.log(`Bloom checkout running → http://localhost:${PORT}  (${PAYPAL_ENV})`);
});
