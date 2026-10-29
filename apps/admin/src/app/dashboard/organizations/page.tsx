'use client';

import { Notice } from '@/components/Notice';
import { PageHeader } from '@/components/PageHeader';
import { useSession } from '@/lib/auth-context';
import { candidateOrganizations, parseOrganizationIdInput, shortId } from '@/lib/org';
import { Badge, Button, Card, CardDescription, CardTitle, Input, Label } from '@atlas/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

export default function OrganizationsPage() {
  const router = useRouter();
  const { organizationId, role } = useSession();
  const candidates = candidateOrganizations({ organizationId, role });

  const [idInput, setIdInput] = React.useState('');
  const [idError, setIdError] = React.useState<string | null>(null);

  function openById(event: React.FormEvent) {
    event.preventDefault();
    const parsed = parseOrganizationIdInput(idInput);
    if (!parsed) {
      setIdError('That is not a valid organization ID. It looks like 0b6d2a4e-6f43-4a39-9a43-4a1d3c1a8e11.');
      return;
    }
    setIdError(null);
    router.push(`/dashboard/${parsed}`);
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <PageHeader
        title="Choose an organization"
        description="The student roster console works on one university organization at a time."
      />

      {candidates.length > 0 ? (
        candidates.map((candidate) => (
          <Card key={candidate.organizationId}>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="min-w-0">
                <CardTitle>Organization {shortId(candidate.organizationId)}…</CardTitle>
                <CardDescription className="mt-1">
                  The organization your sign-in belongs to. Role on your sign-in:{' '}
                  <Badge variant={candidate.claimsRosterAccess ? 'progress' : 'warning'}>
                    {candidate.claimedRole ?? 'none'}
                  </Badge>
                </CardDescription>
              </div>
              <Button asChild>
                <Link href={`/dashboard/${candidate.organizationId}`}>Open roster console</Link>
              </Button>
            </div>
            {!candidate.claimsRosterAccess ? (
              <div className="mt-4">
                <Notice tone="warning" title="This role may not be enough">
                  The roster console needs an owner or admin role in a university organization. Your sign-in lists a
                  different role, but Atlas checks your current membership on every request, so you can still try.
                </Notice>
              </div>
            ) : null}
          </Card>
        ))
      ) : (
        <Card>
          <CardTitle>You are not a member of a university organization</CardTitle>
          <CardDescription className="mt-2">
            Your account is not linked to any organization, so there is no student roster to show. University
            organizations are set up by Atlas administrators, who add staff members explicitly. Ask the person who is
            running your university&apos;s Atlas pilot to add you as an owner or admin, then sign out and back in.
          </CardDescription>
        </Card>
      )}

      <Card>
        <CardTitle>Open an organization by ID</CardTitle>
        <CardDescription className="mt-1 mb-4">
          Your sign-in tells this console about one organization: the one you joined first. If you belong to another
          one, paste its ID here. Atlas still checks that you are an owner or admin of it.
        </CardDescription>
        <form onSubmit={openById} className="flex flex-col gap-3 sm:flex-row sm:items-end" noValidate>
          <div className="min-w-0 flex-1">
            <Label htmlFor="org-id">Organization ID</Label>
            <Input
              id="org-id"
              value={idInput}
              onChange={(event) => setIdInput(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="00000000-0000-0000-0000-000000000000"
              aria-invalid={idError ? true : undefined}
              aria-describedby={idError ? 'org-id-error' : undefined}
              className="font-mono"
            />
          </div>
          <Button type="submit" variant="secondary">
            Open
          </Button>
        </form>
        {idError ? (
          <p id="org-id-error" className="mt-2 text-sm text-[var(--color-serious)]">
            {idError}
          </p>
        ) : null}
      </Card>
    </div>
  );
}
