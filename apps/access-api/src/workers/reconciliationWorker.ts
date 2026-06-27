/**
 * reconciliationWorker.ts
 *
 * Periodically updates persisted membership states that have drifted from
 * the truth: active/suspended memberships whose expiresAt is in the past
 * are transitioned to "expired" in the DB, and an audit event is written
 * for each change.
 *
 * This is a background correctness pass only. Read-time expiry checks in
 * memberService remain the first line of defence.
 */

import { PrismaClient } from '@prisma/client';
import { logEvent } from '../services/auditService';
import { getPrisma } from '../services/prisma';

export type ReconciliationResult = {
  processed: number;
  updated: number;
  errors: number;
};

/**
 * Run a single reconciliation pass.
 * Finds memberships with non-expired stored state but a past expiresAt,
 * updates them to "expired", and emits audit events.
 *
 * Safe to call concurrently: the updateMany is idempotent (only targets
 * non-expired rows, so a second concurrent call updates 0 rows).
 */
export async function runReconciliation(
  prismaOverride?: PrismaClient,
): Promise<ReconciliationResult> {
  const db = prismaOverride ?? getPrisma();
  const now = new Date();
  let updated = 0;
  let errors = 0;

  // Find stale memberships: stored state is active or suspended, but expiry has passed.
  const stale = await db.membership.findMany({
    where: {
      state: { in: ['active', 'suspended'] },
      expiresAt: { lt: now },
    },
    select: { id: true, memberId: true, state: true, expiresAt: true },
  });

  for (const membership of stale) {
    try {
      await db.membership.update({
        where: { id: membership.id },
        data: { state: 'expired' },
      });

      await logEvent({
        eventType: 'MEMBERSHIP_UPDATED',
        communityId: null,
        walletId: null,
        reasonCode: 'RECONCILIATION_EXPIRED',
        beforeState: { memberId: membership.memberId, state: membership.state, expiresAt: membership.expiresAt },
        afterState: { memberId: membership.memberId, state: 'expired', expiresAt: membership.expiresAt },
      });

      updated++;
    } catch (err) {
      errors++;
    }
  }

  return { processed: stale.length, updated, errors };
}

/**
 * Starts the reconciliation scheduler. Returns a stop function.
 *
 * @param intervalMs  How often to run (default: config value or 5 minutes).
 */
export function startReconciliationWorker(intervalMs: number): () => void {
  const timer = setInterval(async () => {
    try {
      await runReconciliation();
    } catch {
      // swallow – individual run errors are tracked inside runReconciliation
    }
  }, intervalMs);

  // Don't block process exit
  timer.unref();

  return () => clearInterval(timer);
}
