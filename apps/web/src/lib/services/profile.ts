import type { CreateResumeResponse, Page, Resume, ResumeResponse } from '@atlas/types';
import { ApiError, apiFetch } from '../api';
import { SERVICE_URLS } from '../config';

export async function uploadResume(file: File, accessToken: string): Promise<CreateResumeResponse> {
  const form = new FormData();
  form.append('source', 'upload');
  form.append('file', file);

  const res = await fetch(`${SERVICE_URLS.profile}/v1/resumes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
    body: form,
  });
  const data = (await res.json()) as CreateResumeResponse | { error: { code: string; message: string } };
  if (!res.ok) {
    const errorBody = data as { error: { code: string; message: string } };
    throw new ApiError(res.status, errorBody.error.code, errorBody.error.message);
  }
  return data as CreateResumeResponse;
}

export function getResume(resumeId: string, accessToken: string): Promise<ResumeResponse> {
  return apiFetch<ResumeResponse>(SERVICE_URLS.profile, `/v1/resumes/${resumeId}`, { accessToken });
}

export function listResumes(accessToken: string): Promise<Page<Resume>> {
  return apiFetch<Page<Resume>>(SERVICE_URLS.profile, '/v1/resumes', { accessToken });
}
