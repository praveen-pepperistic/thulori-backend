// What a customer (or the team) orders: one entry per storybook. Prices come only from the
// catalog; the browser sends edition keys.
import { z } from 'zod';
import { q, one, type Queryable } from '../db.js';
import { EDITIONS, EDITION_KEYS, type Edition } from './catalog.js';
import { zName } from './validate.js';

export const zItems = z.array(z.object({
  edition: z.enum(EDITION_KEYS as [Edition, ...Edition[]]),
  childName: zName,
})).min(1, 'Your cart is empty.').max(6);

export function priceItems(items: z.infer<typeof zItems>) {
  const priced = items.map(i => ({ ...i, unitPaise: EDITIONS[i.edition].pricePaise }));
  return { priced, subtotalPaise: priced.reduce((t, p) => t + p.unitPaise, 0) };
}

/** Creates the books and order lines for an order. */
export async function insertItems(c: Queryable, orderId: string, userId: string, priced: ReturnType<typeof priceItems>['priced']) {
  for (const i of priced) {
    const book = await one(`INSERT INTO books(user_id, order_id, child_name, edition) VALUES ($1,$2,$3,$4) RETURNING id`, [userId, orderId, i.childName, i.edition], c);
    await q(`INSERT INTO order_items(order_id, edition, unit_price_paise, child_name, book_id) VALUES ($1,$2,$3,$4,$5)`, [orderId, i.edition, i.unitPaise, i.childName, book.id], c);
  }
}
