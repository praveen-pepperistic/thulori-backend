import { z, type ZodTypeAny } from 'zod';
import { badRequest } from './errors.js';

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const i of r.error.issues) fields[i.path.join('.') || '_'] ??= i.message;
    throw badRequest('Please check the highlighted fields.', { fields });
  }
  return r.data;
}

export const zEmail = z.string().trim().toLowerCase().email('Please enter a valid email address.').max(254);
export const zPhone = z.string().trim().transform(v => v.replace(/[^\d+]/g, '')).refine(v => v.replace(/\D/g, '').length >= 10 && v.replace(/\D/g, '').length <= 13, 'Please enter a 10-digit phone number.');
export const zPassword = z.string().min(8, 'Use at least 8 characters.').max(200).refine(v => /\d/.test(v), 'Add at least one number.');
export const zName = z.string().trim().min(1, 'Please add a name.').max(120);
export const zUuid = z.string().uuid();
