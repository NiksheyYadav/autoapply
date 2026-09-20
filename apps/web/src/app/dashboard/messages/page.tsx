'use client';

import { useSession } from '@/lib/auth-context';
import { listMessages } from '@/lib/services/outreach';
import { statusLabel, statusVariant } from '@/lib/status-badge';
import { useResource } from '@/lib/use-resource';
import { Badge, Card, CardDescription, CardTitle, Skeleton, fadeUp, staggerContainer } from '@atlas/ui';
import { motion } from 'framer-motion';

export default function MessagesPage() {
  const { accessToken } = useSession();
  const messages = useResource(() => listMessages(accessToken!), [accessToken]);

  return (
    <div>
      <h1 className="font-[var(--font-display)] text-2xl font-medium text-[var(--color-ink)]">Messages</h1>
      <p className="mt-1 text-[var(--color-ink-soft)]">Drafted, scheduled, and sent outreach.</p>

      {messages.loading ? (
        <div className="mt-6 flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : messages.error ? (
        <Card className="mt-6">
          <CardDescription>Couldn&apos;t reach outreach-service: {messages.error}</CardDescription>
        </Card>
      ) : messages.data?.items.length === 0 ? (
        <Card className="mt-6">
          <CardTitle>No messages yet</CardTitle>
          <CardDescription className="mt-1">Draft outreach to a referral contact to see it here.</CardDescription>
        </Card>
      ) : (
        <motion.div initial="hidden" animate="visible" variants={staggerContainer} className="mt-6 flex flex-col gap-3">
          {messages.data?.items.map((message) => (
            <motion.div key={message.message_id} variants={fadeUp}>
              <Card className="py-4">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{message.subject ?? '(no subject)'}</CardTitle>
                  <Badge variant={statusVariant(message.status)}>{statusLabel(message.status)}</Badge>
                </div>
                <CardDescription className="mt-1 line-clamp-2">{message.body}</CardDescription>
              </Card>
            </motion.div>
          ))}
        </motion.div>
      )}
    </div>
  );
}
