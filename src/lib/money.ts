// GST maths. All amounts are integer paise. Confirm GST_RATE / INVOICE_HSN with your CA.
import { config } from '../config.js';

export function orderAmounts(subtotalPaise: number, rate = config().GST_RATE) {
  if (config().PRICES_INCLUDE_GST) {
    const base = Math.round(subtotalPaise / (1 + rate / 100));
    return { subtotal: base, tax: subtotalPaise - base, total: subtotalPaise, rate };
  }
  const tax = Math.round(subtotalPaise * rate / 100);
  return { subtotal: subtotalPaise, tax, total: subtotalPaise + tax, rate };
}

/** Same state as the company → CGST + SGST; otherwise IGST. */
export function splitTax(taxPaise: number, customerState: string | undefined, rate: number) {
  const intra = String(customerState || '').trim().toLowerCase() === config().COMPANY_STATE.trim().toLowerCase();
  if (intra) { const c = Math.floor(taxPaise / 2); return { rate, cgst: c, sgst: taxPaise - c, igst: 0, intra: true }; }
  return { rate, cgst: 0, sgst: 0, igst: taxPaise, intra: false };
}

export const rupees = (paise: number) => Math.round(paise) / 100;
export const inr = (paise: number) => '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 });

/** Indian financial year label for a date: 2026-27 for 1 Apr 2026 – 31 Mar 2027. */
export function finYear(d = new Date()) {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}
