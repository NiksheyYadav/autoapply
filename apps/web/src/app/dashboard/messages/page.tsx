'use client';

import { MessageCard } from '@/components/messages/MessageCard';
import { recipientsByContactId } from '@/components/messages/draft-actions';
import { ResourceError } from '@/components/dashboard/ResourceError';
import { SkeletonGroup } from '@/components/dashboard/SkeletonGroup';
import { useSession } from '@/lib/auth-context';
import { listMessages } from '@/lib/services/outreach';
import { listReferrals } from '@/lib/services/referrals';
import { useResource } from '@/lib/use-resource';
import { Card, CardDescription, CardTitle, Skeleton, fadeUp, staggerContainer } from '@atlas/ui';
import { motion } from 'framer-motion';
import * as React from 'react';

export default function MessagesPage() {
  const { accessToken } = useSession();
  const messages = useResource(() => listMessages(accessToken!), [accessToken]);
  // Only used to fill in the To field of "Open in my email app". If it fails, the drafts still work
  // and the link simply opens with the To field empty, so its error is deliberately not shown.
  const referrals = useResource(() => listReferrals(accessToken!), [accessToken]);
  const recipients = React.useMemo(() => recipientsByContactId(referrals.data?.items ?? []), [referrals.data]);

  return (
    <div>
      <h1 className="font-[var(--font-display)] text-2xl font-medium text-[var(--color-ink)]">Messages</h1>
      <p className="mt-1 max-w-2xl text-[var(--color-ink-soft)]">
        Drafts of outreach to your contacts. Atlas does not send email: copy a draft or open it in your own email app, send it from there, then
        tell us you sent it.
      </p>

      {messages.loading ? (
        <SkeletonGroup label="Loading messages…" className="mt-6 flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </SkeletonGroup>
      ) : messages.error ? (
        <ResourceError what="your messages" onRetry={messages.reload} />
      ) : messages.data?.items.length === 0 ? (
        <Card className="mt-6">
          <CardTitle>No messages yet</CardTitle>
          <CardDescription className="mt-1">Outreach drafts will appear here. You send them yourself, from your own email.</CardDescription>
        </Card>
      ) : (
        <motion.ul initial="hidden" animate="visible" variants={staggerContainer} className="mt-6 flex flex-col gap-3">
          {messages.data?.items.map((message) => (
            <motion.li key={message.message_id} variants={fadeUp}>
              <MessageCard
                message={message}
                accessToken={accessToken!}
                recipient={message.contact_id ? (recipients.get(message.contact_id) ?? null) : null}
              />
            </motion.li>
          ))}
        </motion.ul>
      )}
    </div>
  );
}
