'use client';

import { useSession } from '@/lib/auth-context';
import { listReferrals } from '@/lib/services/referrals';
import { useResource } from '@/lib/use-resource';
import { Badge, Card, CardDescription, CardTitle, Skeleton, fadeUp, staggerContainer } from '@atlas/ui';
import { motion } from 'framer-motion';

export default function ReferralsPage() {
  const { accessToken } = useSession();
  const referrals = useResource(() => listReferrals(accessToken!), [accessToken]);

  return (
    <div>
      <h1 className="font-[var(--font-display)] text-2xl font-medium text-[var(--color-ink)]">Referrals</h1>
      <p className="mt-1 text-[var(--color-ink-soft)]">People at companies you&apos;ve already applied to.</p>

      {referrals.loading ? (
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : referrals.error ? (
        <Card className="mt-6">
          <CardDescription>Couldn&apos;t reach referrals-service: {referrals.error}</CardDescription>
        </Card>
      ) : referrals.data?.items.length === 0 ? (
        <Card className="mt-6">
          <CardTitle>No referral leads yet</CardTitle>
          <CardDescription className="mt-1">
            These surface automatically once a contact is on file at a company you&apos;ve applied to.
          </CardDescription>
        </Card>
      ) : (
        <motion.div initial="hidden" animate="visible" variants={staggerContainer} className="mt-6 grid gap-4 sm:grid-cols-2">
          {referrals.data?.items.map((candidate) => (
            <motion.div key={candidate.contact.contact_id} variants={fadeUp}>
              <Card>
                <CardTitle>{candidate.contact.full_name ?? 'Unnamed contact'}</CardTitle>
                <CardDescription className="mt-1">
                  {candidate.contact.title ?? 'Role unknown'} at {candidate.company.name}
                </CardDescription>
                <div className="mt-3 flex items-center gap-2">
                  <Badge variant="accent">
                    {candidate.contact.relevance_score !== null ? `${Math.round(candidate.contact.relevance_score * 100)}% relevant` : 'Relevance unknown'}
                  </Badge>
                  {candidate.contact.email ? <Badge variant="neutral">{candidate.contact.email}</Badge> : null}
                </div>
              </Card>
            </motion.div>
          ))}
        </motion.div>
      )}
    </div>
  );
}
