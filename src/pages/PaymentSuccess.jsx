import { useEffect, useState, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { CheckCircle, ArrowRight, ShoppingBag, Calendar, CreditCard, Info } from 'lucide-react';
import { supabase, supabaseWithTimeout } from '../lib/supabase';
import { useNotification } from '../context/NotificationContext';
import { useCustomer } from '../context/CustomerContext';

const PaymentSuccess = () => {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const { showNotification } = useNotification();
    const { customer } = useCustomer();
    const [loading, setLoading] = useState(true);
    const [orderInfo, setOrderInfo] = useState(null);
    const [errorMsg, setErrorMsg] = useState(null);
    // Prevent React StrictMode from double-invoking the payment (would create 2 orders)
    const hasRun = useRef(false);

    useEffect(() => {
        if (hasRun.current) return; // StrictMode guard: only run once
        hasRun.current = true;

        const verifyPayment = async () => {
            const dataParam = searchParams.get('data');
            const prnParam = searchParams.get('PRN'); // Fonepay Product Reference Number

            if (!dataParam && !prnParam) {
                setErrorMsg('Invalid payment response. Missing payment details.');
                setLoading(false);
                return;
            }

            try {
                let orderSummary = null;

                if (dataParam) {
                    // ─── ESEWA FLOW ───
                    // The edge function verifies the gateway signature, binds the
                    // callback to the stored payment intent (amount + reference
                    // match), creates the order from the server snapshot and
                    // marks it paid — all server-side. The browser never creates
                    // orders or flips payment status anymore.
                    let paymentDetails;
                    try {
                        const decodedString = atob(dataParam);
                        paymentDetails = JSON.parse(decodedString);
                    } catch (e) {
                        console.error('Failed to decode eSewa response:', e);
                        setErrorMsg('Invalid payment response payload received from payment gateway.');
                        setLoading(false);
                        return;
                    }
                    const { transaction_uuid, transaction_code, status } = paymentDetails || {};

                    if (status !== 'COMPLETE') {
                        setErrorMsg(`Payment was not completed. Status: ${status}`);
                        setLoading(false);
                        return;
                    }

                    const cacheKey = `last_esewa_success_${transaction_uuid}`;
                    const cachedSummary = sessionStorage.getItem(cacheKey) || sessionStorage.getItem('last_esewa_success');
                    // Refresh-safe: a cached summary means this callback already
                    // completed server-side (intents are single-use).
                    if (cachedSummary) {
                        try {
                            orderSummary = JSON.parse(cachedSummary);
                            showNotification('eSewa Payment verified successfully!', 'success');
                            setOrderInfo(orderSummary);
                            setLoading(false);
                            return;
                        } catch (e) {
                            console.warn('Corrupted cached eSewa summary:', e);
                        }
                    }

                    let stored = null;
                    try {
                        const rawIntent = sessionStorage.getItem('pending_esewa_intent');
                        if (rawIntent) stored = JSON.parse(rawIntent);
                    } catch (e) {
                        console.warn('Failed to parse pending_esewa_intent:', e);
                    }
                    if (!stored?.intent_token) {
                        setErrorMsg('We could not match this payment to a checkout session. If money was deducted, please contact support.');
                        setLoading(false);
                        return;
                    }

                    // No auto-retry: completion creates the order server-side —
                    // a blind retry after a lost response could double-create it.
                    const { data: completed, error: completeError } = await supabaseWithTimeout(supabase.functions.invoke('payment-gateway', {
                        body: { action: 'complete-esewa-order', paymentDetails, intentToken: stored.intent_token }
                    }));
                    if (completeError || !completed?.success) {
                        throw new Error(completeError?.message || completed?.error || 'Payment verification failed.');
                    }

                    orderSummary = {
                        orderNumber: completed.order_number,
                        customerName: completed.customer_name,
                        phone: completed.phone,
                        address: completed.address,
                        city: completed.city,
                        totalAmount: Number(completed.total_amount),
                        txnCode: completed.txn_code || transaction_code,
                        paymentMethod: 'eSewa'
                    };

                    sessionStorage.setItem(cacheKey, JSON.stringify(orderSummary));
                    sessionStorage.setItem('last_esewa_success', JSON.stringify(orderSummary));
                    sessionStorage.removeItem('pending_esewa_intent');
                    showNotification('eSewa Payment verified successfully!', 'success');

                } else {
                    // ─── FONEPAY FLOW ───
                    const fonepayDetails = {
                        PRN: searchParams.get('PRN'),
                        PID: searchParams.get('PID'),
                        BID: searchParams.get('BID'),
                        AMT: searchParams.get('AMT'),
                        UID: searchParams.get('UID'),
                        UTN: searchParams.get('UTN'),
                        P_STAT: searchParams.get('P_STAT'),
                        DV: searchParams.get('DV')
                    };

                    const { PRN, P_STAT } = fonepayDetails;

                    if (P_STAT !== 'SUCCESS' && P_STAT !== 'COMPLETED') {
                        setErrorMsg(`Payment was not completed. Status: ${P_STAT}`);
                        setLoading(false);
                        return;
                    }

                    const fonepayCacheKey = `last_fonepay_success_${PRN}`;
                    const fonepayCached = sessionStorage.getItem(fonepayCacheKey) || sessionStorage.getItem('last_fonepay_success');
                    // Refresh-safe: cached means the callback already completed.
                    if (fonepayCached) {
                        try {
                            orderSummary = JSON.parse(fonepayCached);
                            showNotification('Bank Transfer Payment verified successfully!', 'success');
                            setOrderInfo(orderSummary);
                            setLoading(false);
                            return;
                        } catch (e) {
                            console.warn('Corrupted cached Fonepay summary:', e);
                        }
                    }

                    // The PRN is the server-assigned intent ref; completion binds
                    // amount + signature server-side and creates/marks the order
                    // there. No pending-order blob is trusted from the browser.
                    // No auto-retry: same double-create rationale as eSewa above.
                    const { data: fonepayDone, error: fonepayError } = await supabaseWithTimeout(supabase.functions.invoke('payment-gateway', {
                        body: { action: 'complete-fonepay-order', paymentDetails: fonepayDetails }
                    }));
                    if (fonepayError || !fonepayDone?.success) {
                        throw new Error(fonepayError?.message || fonepayDone?.error || 'Payment verification failed.');
                    }

                    orderSummary = {
                        orderNumber: fonepayDone.order_number,
                        customerName: fonepayDone.customer_name,
                        phone: fonepayDone.phone,
                        address: fonepayDone.address,
                        city: fonepayDone.city,
                        totalAmount: Number(fonepayDone.total_amount),
                        txnCode: fonepayDone.txn_code,
                        paymentMethod: 'Bank Transfer'
                    };

                    sessionStorage.setItem(fonepayCacheKey, JSON.stringify(orderSummary));
                    sessionStorage.setItem('last_fonepay_success', JSON.stringify(orderSummary));
                    sessionStorage.removeItem('pending_fonepay_intent');
                    showNotification('Bank Transfer Payment verified successfully!', 'success');
                }

                setOrderInfo(orderSummary);
            } catch (err) {
                console.error('Payment verification error:', err);
                setErrorMsg(err.message || 'Verification failed. Please contact support.');
            } finally {
                setLoading(false);
            }
        };

        verifyPayment();
    }, [searchParams, showNotification]);

    if (loading) {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: '1rem' }}>
                <div className="spinner" style={{ width: '40px', height: '40px', border: '3px solid #e2e8f0', borderTopColor: '#60b524', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                <h3 style={{ fontWeight: '800', color: '#1e293b' }}>Verifying Payment...</h3>
                <p style={{ color: '#64748b', fontSize: '0.9rem' }}>Please do not close this window or refresh the page.</p>
            </div>
        );
    }

    if (errorMsg) {
        return (
            <div style={{ maxWidth: '500px', margin: '4rem auto', padding: '2rem', background: 'white', borderRadius: '1.5rem', border: '1px solid #e2e8f0', textAlign: 'center', boxShadow: '0 10px 30px rgba(0,0,0,0.05)' }}>
                <div style={{ width: '60px', height: '60px', background: '#fef2f2', color: '#ef4444', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.5rem' }}>
                    <Info size={30} />
                </div>
                <h2 style={{ fontWeight: '900', color: '#1e293b', marginBottom: '0.75rem' }}>Payment Status Unconfirmed</h2>
                <p style={{ color: '#64748b', fontSize: '0.95rem', marginBottom: '2rem', lineHeight: '1.6' }}>{errorMsg}</p>
                <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
                    <button onClick={() => navigate('/checkout')} className="btn btn-secondary" style={{ padding: '0.75rem 1.5rem' }}>Try Checkout Again</button>
                    <button onClick={() => navigate('/shop')} className="btn btn-primary" style={{ padding: '0.75rem 1.5rem' }}>Continue Shopping</button>
                </div>
            </div>
        );
    }

    return (
        <div style={{ maxWidth: '460px', margin: '0.75rem auto 1.5rem', padding: '1.25rem 1.4rem', background: 'white', borderRadius: '1.25rem', border: '1px solid #e2e8f0', boxShadow: '0 10px 30px rgba(0,0,0,0.04)', boxSizing: 'border-box' }}>
            <div style={{ textAlign: 'center', marginBottom: '0.75rem' }}>
                <div style={{ width: '42px', height: '42px', background: '#ecfdf5', color: '#10b981', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 0.4rem' }}>
                    <CheckCircle size={24} />
                </div>
                <h1 style={{ fontWeight: '900', color: '#111827', fontSize: '1.25rem', margin: '0 0 0.15rem 0' }}>Payment Successful!</h1>
                <p style={{ color: '#10b981', fontWeight: '700', fontSize: '0.82rem', margin: 0 }}>Thank you! Your transaction via {orderInfo.paymentMethod || 'eSewa'} is complete.</p>
            </div>

            <div style={{ background: '#f8fafc', padding: '0.75rem 1rem', borderRadius: '0.85rem', border: '1px solid #f1f5f9', marginBottom: '0.85rem', textAlign: 'left' }}>
                <h3 style={{ margin: '0 0 0.5rem 0', fontWeight: '800', fontSize: '0.82rem', color: '#1e293b', borderBottom: '1px solid #e2e8f0', paddingBottom: '0.35rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Transaction Summary</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', fontSize: '0.8rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#64748b' }}>Order Number</span>
                        <strong style={{ color: '#0f172a' }}>{orderInfo.orderNumber}</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#64748b' }}>{orderInfo.paymentMethod || 'eSewa'} Ref Code</span>
                        <strong style={{ color: '#0f172a' }}>{orderInfo.txnCode}</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#64748b' }}>Amount Paid</span>
                        <strong style={{ color: '#059669', fontSize: '0.92rem' }}>Rs. {orderInfo.totalAmount.toLocaleString()}</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #e2e8f0', paddingTop: '0.35rem' }}>
                        <span style={{ color: '#64748b' }}>Customer</span>
                        <span style={{ color: '#0f172a', fontWeight: '600' }}>{orderInfo.customerName}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#64748b' }}>Phone</span>
                        <span style={{ color: '#0f172a', fontWeight: '600' }}>{orderInfo.phone}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#64748b' }}>Address</span>
                        <span style={{ color: '#0f172a', fontWeight: '600', textAlign: 'right' }}>{orderInfo.address}, {orderInfo.city}</span>
                    </div>
                </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '0.5rem' }}>
                <button 
                    onClick={() => {
                        if (customer) {
                            navigate('/my-orders');
                        } else {
                            const phone = orderInfo?.phone || '';
                            navigate(`/my-orders?setup-pin=${encodeURIComponent(phone)}`);
                        }
                    }}
                    className="btn btn-primary" 
                    style={{ width: '100%', padding: '0.65rem 0.85rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', fontWeight: '700', fontSize: '0.85rem' }}
                >
                    <ShoppingBag size={15} /> View My Orders <ArrowRight size={14} />
                </button>
                
                <button 
                    onClick={() => navigate('/shop')} 
                    className="btn btn-secondary" 
                    style={{ width: '100%', padding: '0.65rem 0.85rem', fontWeight: '700', fontSize: '0.85rem' }}
                >
                    Continue Shopping
                </button>
            </div>
        </div>
    );
};

export default PaymentSuccess;
