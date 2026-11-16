'use client';

import { useSession } from '@/lib/auth-context';
import {
  DELETE_CONFIRMATION,
  deleteAccount,
  describePrivacyError,
  downloadAccountExport,
  isDeleteConfirmed,
  saveBlob,
} from '@/lib/services/privacy';
import { Button, Card, CardDescription, CardTitle, Input, Label } from '@atlas/ui';
import { Download, Trash2 } from 'lucide-react';
import * as React from 'react';

type DownloadState = { phase: 'idle' } | { phase: 'working' } | { phase: 'done' } | { phase: 'error'; message: string };

type RemovalState =
  | { phase: 'idle' }
  | { phase: 'working' }
  | { phase: 'error'; message: string }
  /** The account is gone, but some stored files could not be removed: say so before leaving the page. */
  | { phase: 'deleted-with-notice'; failedFiles: number };

const DELETED_ITEMS = [
  'Your profile and your sign-in account.',
  'Your resumes: the parsed text and profile, and the uploaded files.',
  'Your applications and their history.',
  'Your messages and drafts.',
  'Your job match scores and activity records.',
  'Your organization memberships and student records. A personal workspace you are the only member of is deleted with them.',
];

export default function SettingsPage() {
  const { accessToken, logout } = useSession();
  const [download, setDownload] = React.useState<DownloadState>({ phase: 'idle' });
  const [removal, setRemoval] = React.useState<RemovalState>({ phase: 'idle' });
  const [typed, setTyped] = React.useState('');

  const confirmed = isDeleteConfirmed(typed);
  const removing = removal.phase === 'working';

  async function handleDownload() {
    if (!accessToken) return;
    setDownload({ phase: 'working' });
    try {
      const file = await downloadAccountExport(accessToken);
      saveBlob(file.blob, file.filename);
      setDownload({ phase: 'done' });
    } catch (cause) {
      setDownload({ phase: 'error', message: describePrivacyError(cause, 'export') });
    }
  }

  /** Sign out of the now-deleted account and leave. A full navigation, so nothing here races the dashboard's own redirect. */
  async function leave() {
    try {
      await logout();
    } catch {
      // The session belonged to an account that no longer exists; there is nothing left to sign out of.
    }
    window.location.replace('/');
  }

  async function handleDelete(event: React.FormEvent) {
    event.preventDefault();
    if (!accessToken || !confirmed || removing) return;
    setRemoval({ phase: 'working' });
    try {
      const result = await deleteAccount(accessToken);
      if (result.resume_files.failed > 0) {
        setRemoval({ phase: 'deleted-with-notice', failedFiles: result.resume_files.failed });
        return;
      }
      await leave();
    } catch (cause) {
      setRemoval({ phase: 'error', message: describePrivacyError(cause, 'delete') });
    }
  }

  return (
    <div className="max-w-3xl">
      <h1 className="font-[var(--font-display)] text-2xl font-medium text-[var(--color-ink)]">Your data</h1>
      <p className="mt-1 text-[var(--color-ink-soft)]">
        Download a copy of what Atlas holds about you, or delete your account and the data tied to it.
      </p>

      <Card className="mt-6">
        <CardTitle>Download my data</CardTitle>
        <CardDescription className="mt-1">
          A JSON file with your account details, resumes (parsed text and profile), applications and their history,
          messages, job match scores, activity records, and any organization or student records.
        </CardDescription>
        <p className="mt-3 text-xs text-[var(--color-ink-faint)]">
          It does not include your original resume files, passwords or sign-in tokens, or anything about other people. If
          your data is very large, parts may be left out to keep the file small, and the file lists what was left out.
        </p>
        <Button className="mt-4" variant="secondary" onClick={() => void handleDownload()} disabled={!accessToken || download.phase === 'working'}>
          <Download className="h-4 w-4" />
          {download.phase === 'working' ? 'Preparing…' : 'Download my data'}
        </Button>
        {download.phase === 'done' ? (
          <p role="status" className="mt-3 text-sm text-[var(--color-ink-soft)]">
            Your download has started.
          </p>
        ) : null}
        {download.phase === 'error' ? (
          <p role="alert" className="mt-3 text-sm text-[var(--color-serious)]">
            {download.message}
          </p>
        ) : null}
      </Card>

      <Card className="mt-6">
        <CardTitle>Delete my account</CardTitle>
        <CardDescription className="mt-1">
          This permanently deletes your Atlas account and the data tied to it. It can&apos;t be undone, and you will be
          signed out.
        </CardDescription>

        <h3 className="mt-4 text-sm font-medium text-[var(--color-ink)]">What is deleted</h3>
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-[var(--color-ink-soft)]">
          {DELETED_ITEMS.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>

        <h3 className="mt-4 text-sm font-medium text-[var(--color-ink)]">What stops it</h3>
        <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
          If you are the only owner of an organization that has other members, or you still have a connected account,
          the deletion is refused and we tell you which. Once that is resolved, you can try again.
        </p>

        <h3 className="mt-4 text-sm font-medium text-[var(--color-ink)]">What is kept</h3>
        <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
          Job listings and companies are shared and are not deleted. A record that an account was deleted (its id and the
          time) is kept. Deletion does not rewrite backups or logs held by our infrastructure providers.
        </p>

        {removal.phase === 'deleted-with-notice' ? (
          <div role="status" className="mt-5 rounded-[var(--radius-control)] border border-[var(--color-line)] p-4">
            <p className="text-sm font-medium text-[var(--color-ink)]">Your account has been deleted.</p>
            <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
              {removal.failedFiles === 1
                ? '1 uploaded resume file could not be removed from storage automatically.'
                : `${removal.failedFiles} uploaded resume files could not be removed from storage automatically.`}
            </p>
            <Button className="mt-3" onClick={() => void leave()}>
              Continue
            </Button>
          </div>
        ) : (
          <form className="mt-5" onSubmit={(event) => void handleDelete(event)}>
            <Label htmlFor="delete-confirmation">Type {DELETE_CONFIRMATION} to confirm</Label>
            <Input
              id="delete-confirmation"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              disabled={removing}
              aria-describedby={removal.phase === 'error' ? 'delete-error' : undefined}
              className="max-w-xs"
            />
            <Button type="submit" variant="destructive" className="mt-4" disabled={!accessToken || !confirmed || removing}>
              <Trash2 className="h-4 w-4" />
              {removing ? 'Deleting…' : 'Delete my account'}
            </Button>
            {removal.phase === 'error' ? (
              <p id="delete-error" role="alert" className="mt-3 text-sm text-[var(--color-serious)]">
                {removal.message}
              </p>
            ) : null}
          </form>
        )}
      </Card>
    </div>
  );
}
