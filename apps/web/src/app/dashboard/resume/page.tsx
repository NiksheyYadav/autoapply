'use client';

import { ApiError } from '@/lib/api';
import { useSession } from '@/lib/auth-context';
import { listResumes, uploadResume } from '@/lib/services/profile';
import { statusLabel, statusVariant } from '@/lib/status-badge';
import { useResource } from '@/lib/use-resource';
import { Badge, Button, Card, CardDescription, CardTitle, ProgressRing, Skeleton, fadeUp, staggerContainer } from '@atlas/ui';
import { motion } from 'framer-motion';
import { Upload } from 'lucide-react';
import * as React from 'react';

export default function ResumePage() {
  const { accessToken } = useSession();
  const resumes = useResource(() => listResumes(accessToken!), [accessToken]);
  const [uploading, setUploading] = React.useState(false);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  async function handleFileSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !accessToken) return;
    setUploading(true);
    setUploadError(null);
    try {
      await uploadResume(file, accessToken);
      resumes.reload();
    } catch (cause) {
      setUploadError(cause instanceof ApiError ? cause.message : 'Upload failed.');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  const latest = resumes.data?.items[0];

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-[var(--font-display)] text-2xl font-medium text-[var(--color-ink)]">Resume</h1>
          <p className="mt-1 text-[var(--color-ink-soft)]">Parsed automatically — skills, experience, and an ATS score.</p>
        </div>
        <Button onClick={() => fileInputRef.current?.click()} disabled={uploading}>
          <Upload className="h-4 w-4" />
          {uploading ? 'Uploading…' : 'Upload resume'}
        </Button>
        <input ref={fileInputRef} type="file" accept=".pdf,.docx,.txt" className="hidden" onChange={(e) => void handleFileSelected(e)} />
      </div>

      {uploadError ? <p className="mt-3 text-sm text-[var(--color-serious)]">{uploadError}</p> : null}

      {resumes.loading ? (
        <Card className="mt-6">
          <Skeleton className="h-24 w-full" />
        </Card>
      ) : resumes.error ? (
        <Card className="mt-6">
          <CardDescription>Couldn&apos;t reach profile-service: {resumes.error}</CardDescription>
        </Card>
      ) : !latest ? (
        <Card className="mt-6">
          <CardTitle>No resume yet</CardTitle>
          <CardDescription className="mt-1">Upload one to get matched against active jobs.</CardDescription>
        </Card>
      ) : (
        <Card className="mt-6 flex flex-col items-start gap-6 sm:flex-row sm:items-center">
          <ProgressRing value={latest.ats_score ?? 0} label="ATS" />
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <CardTitle>{latest.original_filename}</CardTitle>
              <Badge variant={statusVariant(latest.status)}>{statusLabel(latest.status)}</Badge>
            </div>
            {latest.parsed_profile ? (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {latest.parsed_profile.skills.slice(0, 12).map((skill) => (
                  <Badge key={skill.name} variant="neutral">
                    {skill.name}
                  </Badge>
                ))}
              </div>
            ) : latest.failure_reason ? (
              <p className="mt-2 text-sm text-[var(--color-serious)]">{latest.failure_reason}</p>
            ) : null}
          </div>
        </Card>
      )}

      {resumes.data && resumes.data.items.length > 1 ? (
        <motion.div initial="hidden" animate="visible" variants={staggerContainer} className="mt-6 flex flex-col gap-3">
          <h2 className="text-sm font-medium text-[var(--color-ink-soft)]">Earlier uploads</h2>
          {resumes.data.items.slice(1).map((resume) => (
            <motion.div key={resume.resume_id} variants={fadeUp}>
              <Card className="flex items-center justify-between py-4">
                <span className="text-sm text-[var(--color-ink)]">{resume.original_filename}</span>
                <Badge variant={statusVariant(resume.status)}>{statusLabel(resume.status)}</Badge>
              </Card>
            </motion.div>
          ))}
        </motion.div>
      ) : null}
    </div>
  );
}
