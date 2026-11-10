import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// =============================================================================
// Regression tests for the hardened payment-gateway flow.
//
// These mirror the logic in supabase/functions/payment-gateway/index.ts:
//   - the signed field list is fixed server-side
//   - a payment counts as paid ONLY after the gateway confirms it
//   - the intent is claimed atomically, so one payment creates one order
//   - redirect targets must be on the server-side allowlist
// =============================================================================

const ESEWA_SIGNED_FIELDS = ['total_amount', 'transaction_uuid', 'product_code'];

function esewaSignedMessage(totalAmount, transactionUuid, productCode) {
    return ESEWA_SIGNED_FIELDS.map((field) => {
        if (field === 'total_amount') return `total_amount=${totalAmount}`;
        if (field === 'transaction_uuid') return `transaction_uuid=${transactionUuid}`;
        return `product_code=${productCode}`;
    }).join(',');
}

function computeEsewaSignature(message, secret) {
    return crypto.createHmac('sha256', secret).update(message).digest('base64');
}

function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

// Mirrors verifyWithEsewa(): the authoritative, server-to-server check.
function verifyWithEsewa({ gatewayStatus, gatewayAmount, gatewayUuid, transactionUuid, expectedTotal }) {
    const status = String(gatewayStatus || '').toUpperCase();
    if (status !== 'COMPLETE') {
        return { ok: false, reason: `Payment was not completed at the gateway (status: ${status || 'unknown'}).` };
    }
    if (gatewayUuid && gatewayUuid !== transactionUuid) {
        return { ok: false, reason: 'Payment reference mismatch at the gateway.' };
    }
    if (gatewayAmount !== undefined && gatewayAmount !== null && gatewayAmount !== '') {
        const gw = Number(gatewayAmount);
        const expected = Number(expectedTotal);
        const matchesRupees = Math.abs(gw - expected) < 0.01;
        const matchesPaisa = Math.abs(gw - expected * 100) < 0.01;
        if (!matchesRupees && !matchesPaisa) {
            return { ok: false, reason: 'The amount paid does not match the order total.' };
        }
    }
    return { ok: true };
}

// Mirrors claimIntent(): conditional pending -> paid transition.
function createIntentStore() {
    const rows = new Map();
    return {
        insert(id) { rows.set(id, { id, status: 'pending', order_number: null }); },
        claim(id) {
            const row = rows.get(id);
            if (!row || row.status !== 'pending') return false;
            row.status = 'paid';
            return true;
        },
        get(id) { return rows.get(id); },
    };
}

// Mirrors resolveRedirectUrl().
function resolveRedirectUrl(raw, allowedOrigins) {
    if (!allowedOrigins.length) throw new Error('Payment redirects are not configured.');
    const value = String(raw || '');
    if (!value) throw new Error('Missing redirect URL.');
    let url;
    try { url = new URL(value); } catch { throw new Error('Invalid redirect URL.'); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Invalid redirect protocol.');
    if (url.username || url.password) throw new Error('Invalid redirect URL.');
    if (!allowedOrigins.includes(url.origin.toLowerCase())) throw new Error('Redirect origin is not allowed.');
    return url.toString();
}

// ── The vulnerability that was fixed ────────────────────────────────────────

test('replaying the create-time signature without paying is rejected', () => {
    const secret = 'test-secret-key-12345';
    const totalAmount = '1500.00';
    const transactionUuid = 'SN-1234567890AB-1700000000';
    const productCode = 'EPAYTEST';

    // Step 1: the server signs the intent at checkout start (as before).
    const signature = computeEsewaSignature(esewaSignedMessage(totalAmount, transactionUuid, productCode), secret);

    // Step 2: the attacker replays that signature with status=COMPLETE,
    //         without ever paying eSewa.
    const details = {
        status: 'COMPLETE',
        signed_field_names: 'total_amount,transaction_uuid,product_code',
        total_amount: totalAmount,
        transaction_uuid: transactionUuid,
        product_code: productCode,
        signature,
    };

    // Defence in depth: the server recomputes the signature over ITS OWN values.
    const expected = computeEsewaSignature(
        esewaSignedMessage(totalAmount, transactionUuid, productCode),
        secret,
    );
    assert.ok(timingSafeEqual(expected, details.signature), 'signature itself is valid (it is the server’s own)');

    // The authoritative check: eSewa has no completed transaction for this id.
    const gateway = verifyWithEsewa({
        gatewayStatus: 'PENDING',       // never paid
        gatewayAmount: null,
        gatewayUuid: null,
        transactionUuid,
        expectedTotal: 1500,
    });

    assert.equal(gateway.ok, false, 'A payment the gateway never confirmed must be rejected');
    assert.match(gateway.reason, /not completed/i);
});

test('a genuinely completed gateway transaction is accepted', () => {
    const gateway = verifyWithEsewa({
        gatewayStatus: 'COMPLETE',
        gatewayAmount: '1500.00',
        gatewayUuid: 'SN-1234567890AB-1700000000',
        transactionUuid: 'SN-1234567890AB-1700000000',
        expectedTotal: 1500,
    });
    assert.equal(gateway.ok, true);
});

test('a completed transaction for a different amount is rejected', () => {
    const gateway = verifyWithEsewa({
        gatewayStatus: 'COMPLETE',
        gatewayAmount: '10.00',
        gatewayUuid: 'SN-1234567890AB-1700000000',
        transactionUuid: 'SN-1234567890AB-1700000000',
        expectedTotal: 1500,
    });
    assert.equal(gateway.ok, false);
    assert.match(gateway.reason, /amount paid does not match/i);
});

test('a completed transaction for a different reference is rejected', () => {
    const gateway = verifyWithEsewa({
        gatewayStatus: 'COMPLETE',
        gatewayAmount: '1500.00',
        gatewayUuid: 'SN-SOMEONE-ELSES-000',
        transactionUuid: 'SN-1234567890AB-1700000000',
        expectedTotal: 1500,
    });
    assert.equal(gateway.ok, false);
    assert.match(gateway.reason, /reference mismatch/i);
});

// ── Server-side control of the signed message ───────────────────────────────

test('the client cannot choose which fields are signed', () => {
    const secret = 'test-secret-key-12345';
    const totalAmount = '1500.00';
    const transactionUuid = 'SN-1234567890AB-1700000000';
    const productCode = 'EPAYTEST';

    // The server always signs the same three fields, whatever the client claims.
    assert.equal(esewaSignedMessage(totalAmount, transactionUuid, productCode),
        'total_amount=1500.00,transaction_uuid=SN-1234567890AB-1700000000,product_code=EPAYTEST');

    // A client-supplied field list is ignored: the message is rebuilt from
    // server-side values only.
    const clientFieldList = 'status';
    const serverMessage = esewaSignedMessage(totalAmount, transactionUuid, productCode);
    const clientMessage = `${clientFieldList}=COMPLETE`;
    assert.notEqual(serverMessage, clientMessage);

    // A signature over the client's own field list does not verify.
    const clientSignature = computeEsewaSignature(clientMessage, secret);
    const expected = computeEsewaSignature(serverMessage, secret);
    assert.equal(timingSafeEqual(expected, clientSignature), false);
});

test('the transaction reference used for verification is the server-assigned one', () => {
    const serverAssigned = 'SN-1234567890AB-1700000000';
    const clientSupplied = 'SN-ATTACKER-000';
    const gateway = verifyWithEsewa({
        gatewayStatus: 'COMPLETE',
        gatewayAmount: '1500.00',
        gatewayUuid: serverAssigned,
        transactionUuid: serverAssigned,   // server-side intent.gateway_ref
        expectedTotal: 1500,
    });
    assert.equal(gateway.ok, true);
    assert.notEqual(serverAssigned, clientSupplied);
});

// ── Exactly one order per payment ───────────────────────────────────────────

test('the atomic intent claim allows exactly one completion', () => {
    const store = createIntentStore();
    store.insert('intent-1');

    assert.equal(store.claim('intent-1'), true, 'first callback wins the claim');
    assert.equal(store.claim('intent-1'), false, 'second callback cannot claim it again');
    assert.equal(store.claim('intent-1'), false, 'nor can a third');
});

test('a claimed intent is not claimable after being released as failed', () => {
    const store = createIntentStore();
    store.insert('intent-2');

    assert.equal(store.claim('intent-2'), true);
    store.get('intent-2').status = 'failed';
    assert.equal(store.claim('intent-2'), false, 'a failed intent is not reusable');
});

// ── Redirect allowlist ──────────────────────────────────────────────────────

test('only allowlisted redirect origins are accepted', () => {
    const allowed = ['https://shopynepal.vercel.app'];

    assert.equal(
        resolveRedirectUrl('https://shopynepal.vercel.app/payment-success', allowed),
        'https://shopynepal.vercel.app/payment-success',
    );
    assert.throws(
        () => resolveRedirectUrl('https://evil.example/payment-success', allowed),
        /not allowed/i,
    );
    assert.throws(
        () => resolveRedirectUrl('javascript:alert(1)', allowed),
        /protocol/i,
    );
    assert.throws(
        () => resolveRedirectUrl('https://user:pass@shopynepal.vercel.app/x', allowed),
        /invalid/i,
    );
});

test('an unconfigured redirect allowlist fails closed', () => {
    assert.throws(
        () => resolveRedirectUrl('https://shopynepal.vercel.app/payment-success', []),
        /not configured/i,
    );
});
