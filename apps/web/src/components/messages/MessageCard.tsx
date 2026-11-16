'use client';

import { ApiError } from '@/lib/api';
import { markMessageSent } from '@/lib/services/outreach';
import { statusVariant } from '@/lib/status-badge';
import type { Message } from '@atlas/types';
import { Badge, Button, Card, CardDescription, CardTitle } from '@atlas/ui';
import { Check, Copy, Mail } from 'lucide-react';
import * as React from 'react';
import {
  buildMailtoUrl,
  canOpenInMailApp,
  canRecordAsSent,
  copyText,
  describeMarkSentFailure,
  formatMessageForCopy,
  messageStatusLabel,
  messageStatusNote,
} from './draft-actions';

/** How long "Copied" stays on the button before it goes back to "Copy message". */
const COPIED_RESET_MS = 2500;

export interface MessageCardProps {
  message: Message;
  accessToken: string;
  /** The contact's address, when the referral list knows it. */
  recipient: string | null;
}

/**
 * One outreach draft. Atlas does not send it: the person copies it or opens it
 * in their own email app, sends it from there, and then says so with "I sent
 * this". Opening the email app is never taken to mean it was sent.
 */
export function MessageCard({ message, accessToken, recipient }: MessageCardProps) {
  const titleId = React.useId();
  const helpId = React.useId();
  const statusRef = React.useRef<HTMLParagraphElement>(null);
  const copiedTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // What the server last told us about this message. It outlives a reload of the list.
  const [recorded, setRecorded] = React.useState<Message | null>(null);
  const [copy, setCopy] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [announcement, setAnnouncement] = React.useState('');

  const current = recorded ?? message;
  const mailto = canOpenInMailApp(current.status)
    ? buildMailtoUrl({ to: recipient, subject: current.subject, body: current.body })
    : null;
  const note = messageStatusNote(current.status);

  React.useEffect(
    () => () => {
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    },
    [],
  );

  async function handleCopy() {
    const ok = await copyText(formatMessageForCopy(current));
    setCopy(ok ? 'copied' : 'failed');
    // A failure is announced by its own alert below; only the success needs a spoken confirmation.
    setAnnouncement(ok ? 'Message copied to the clipboard.' : '');
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopy('idle'), COPIED_RESET_MS);
  }

  async function handleRecordSent() {
    setSaving(true);
    setError(null);
    try {
      const { message: updated } = await markMessageSent(accessToken, current.message_id);
      setRecorded(updated);
      setAnnouncement('Marked as sent.');
      // The button that was just pressed is about to disappear; keep keyboard and screen-reader users in place.
      queueMicrotask(() => statusRef.current?.focus());
    } catch (cause) {
      setError(describeMarkSentFailure(cause instanceof ApiError ? cause.status : null));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="py-4" role="group" aria-labelledby={titleId}>
      <div className="flex items-start justify-between gap-3">
        <CardTitle id={titleId} className="text-base">
          {current.subject ?? '(no subject)'}
        </CardTitle>
        <Badge variant={statusVariant(current.status)} className="shrink-0">
          {messageStatusLabel(current.status)}
        </Badge>
      </div>

      <p className="mt-3 whitespace-pre-wrap break-words rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-canvas-raised)] p-3 text-sm text-[var(--color-ink)]">
        {current.body}
      </p>

      {note ? <CardDescription className="mt-3">{note}</CardDescription> : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => void handleCopy()}>
          {copy === 'copied' ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
          {copy === 'copied' ? 'Copied' : 'Copy message'}
        </Button>

        {canOpenInMailApp(current.status) ? (
          mailto ? (
            <Button asChild variant="secondary" size="sm">
              <a href={mailto}>
                <Mail className="h-4 w-4" aria-hidden="true" />
                Open in my email app
              </a>
            </Button>
          ) : (
            <CardDescription>Too long to open in an email app. Use Copy message instead.</CardDescription>
          )
        ) : null}

        {canRecordAsSent(current.status) ? (
          <Button type="button" size="sm" onClick={() => void handleRecordSent()} disabled={saving} aria-describedby={helpId}>
            {saving ? 'Saving…' : 'I sent this'}
          </Button>
        ) : null}
      </div>

      {canRecordAsSent(current.status) ? (
        <CardDescription id={helpId} className="mt-2">
          Atlas does not send email. After you send this yourself, choose “I sent this” to record it. That cannot be undone.
        </CardDescription>
      ) : null}

      {copy === 'failed' ? (
        <p role="alert" className="mt-3 text-sm text-[var(--color-serious)]">
          We could not copy that automatically. Select the text above and copy it yourself.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 text-sm text-[var(--color-serious)]">
          {error}
        </p>
      ) : null}

      <p ref={statusRef} tabIndex={-1} role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </Card>
  );
}
