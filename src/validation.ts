import { z } from 'zod';

// Up to 12 digits before the point and 2 after, to fit NUMERIC(14, 2).
const MONEY_PATTERN = /^(0|[1-9]\d{0,11})(\.\d{1,2})?$/;

export const idSchema = z.number().int().positive();

// Accepts 150, 150.5 or "150.50". The value leaves this schema as a decimal
// string and Postgres does all comparisons, so JS floats never do money math.
// A float artefact like 0.30000000000000004 fails the two-decimal rule.
const amountSchema = z
  .union([z.number(), z.string()])
  .transform((value) => (typeof value === 'number' ? String(value) : value))
  .refine((value) => MONEY_PATTERN.test(value), {
    error: 'amount must be a decimal with at most 2 decimal places and 12 integer digits',
  })
  .refine((value) => /[1-9]/.test(value), { error: 'amount must be greater than 0' });

export const bidRequestSchema = z.object({
  auction_id: idSchema,
  user_id: idSchema,
  amount: amountSchema,
});

export type BidRequest = z.infer<typeof bidRequestSchema>;
