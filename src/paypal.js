import crypto from 'node:crypto';

// This module only ever talks to the PayPal SANDBOX. There is no live URL in
// the code on purpose. With no credentials (or PAYPAL_MODE=mock) it runs in a
// mock mode that moves no money, so the app can be tried without any setup.

const SANDBOX = 'https://api-m.sandbox.paypal.com';

const dollars = (cents) => (cents / 100).toFixed(2);

export function createPayPal(env = process.env, fetchImpl = globalThis.fetch) {
  const clientId = env.PAYPAL_CLIENT_ID;
  const clientSecret = env.PAYPAL_CLIENT_SECRET;
  const receiverEmail = (env.PAYPAL_MERCHANT_EMAIL || '').trim();
  const mode = clientId && clientSecret && env.PAYPAL_MODE !== 'mock' ? 'sandbox' : 'mock';

  let token = null;
  let tokenExpiresAt = 0;

  async function getToken() {
    if (token && Date.now() < tokenExpiresAt) return token;
    const res = await fetchImpl(`${SANDBOX}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      throw new Error(`PayPal sign-in failed (${res.status}). Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are sandbox credentials.`);
    }
    token = json.access_token;
    tokenExpiresAt = Date.now() + (json.expires_in - 60) * 1000;
    return token;
  }

  async function api(method, path, body, headers = {}) {
    const res = await fetchImpl(`${SANDBOX}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const detail = json.details?.[0]?.description || json.message || json.error_description || `status ${res.status}`;
      const err = new Error(`PayPal ${method} ${path}: ${detail}`);
      err.status = res.status;
      err.debugId = json.debug_id || res.headers.get('paypal-debug-id') || undefined;
      throw err;
    }
    return json;
  }

  return {
    mode,
    receiverConfigured: Boolean(receiverEmail),

    /** Starts a checkout so the owner can add funds. Returns { id, approveUrl }. */
    async createOrder({ amountCents, referenceId, returnUrl, cancelUrl }) {
      if (mode === 'mock') {
        const id = `MOCK-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
        return { id, approveUrl: `/mock/paypal/approve?token=${id}` };
      }
      const order = await api(
        'POST',
        '/v2/checkout/orders',
        {
          intent: 'CAPTURE',
          purchase_units: [
            {
              reference_id: referenceId,
              description: 'AgentWallet top-up',
              amount: { currency_code: 'USD', value: dollars(amountCents) },
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                brand_name: 'AgentWallet',
                user_action: 'PAY_NOW',
                shipping_preference: 'NO_SHIPPING',
                return_url: returnUrl,
                cancel_url: cancelUrl,
              },
            },
          },
        },
        { 'PayPal-Request-Id': referenceId },
      );
      const link = order.links?.find((l) => l.rel === 'payer-action') || order.links?.find((l) => l.rel === 'approve');
      if (!link) throw new Error('PayPal did not return an approval link for this order.');
      return { id: order.id, approveUrl: link.href };
    },

    /** Captures an order the owner approved. Returns { status, captureId, amountCents }. */
    async captureOrder(orderId, expectedCents) {
      if (mode === 'mock') {
        return { status: 'COMPLETED', captureId: `MOCKCAP-${crypto.randomBytes(5).toString('hex')}`, amountCents: expectedCents };
      }
      const res = await api('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, undefined, {
        'PayPal-Request-Id': `capture-${orderId}`,
        Prefer: 'return=representation', // the default, minimal, omits the capture details we verify
      });
      const capture = res.purchase_units?.[0]?.payments?.captures?.[0];
      // Credit only when the order AND the capture are complete, in US dollars.
      const complete = res.status === 'COMPLETED' && capture?.status === 'COMPLETED' && capture?.amount?.currency_code === 'USD';
      return {
        status: complete ? 'COMPLETED' : `${res.status}/${capture?.status ?? 'no capture'}`,
        captureId: capture?.id,
        amountCents: capture ? Math.round(parseFloat(capture.amount.value) * 100) : 0,
      };
    },

    /** Sends the merchant's money out of the wallet. Returns a settlement record. */
    async settle({ purchaseId, merchant, amountCents, title }) {
      if (mode === 'mock') {
        return { mode: 'simulated', status: 'SIMULATED', note: 'Mock mode: no money moved.' };
      }
      if (!receiverEmail) {
        return { mode: 'simulated', status: 'SIMULATED', note: 'Set PAYPAL_MERCHANT_EMAIL to send a real sandbox payout.' };
      }
      const res = await api('POST', '/v1/payments/payouts', {
        sender_batch_header: {
          sender_batch_id: `aw-${purchaseId}`,
          email_subject: 'Payment from AgentWallet',
          email_message: `AgentWallet paid ${merchant} for: ${title}`,
        },
        items: [
          {
            recipient_type: 'EMAIL',
            receiver: receiverEmail,
            amount: { value: dollars(amountCents), currency: 'USD' },
            note: `${merchant}: ${title}`.slice(0, 160),
            sender_item_id: purchaseId,
          },
        ],
      });
      const batchStatus = res.batch_header?.batch_status || 'PENDING';
      if (batchStatus === 'DENIED' || batchStatus === 'CANCELED') {
        throw new Error(`PayPal rejected the payout (${batchStatus}).`);
      }
      return {
        mode: 'sandbox',
        status: batchStatus,
        batchId: res.batch_header?.payout_batch_id,
        note: 'Sandbox payout sent.',
      };
    },
  };
}
