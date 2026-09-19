import type { FastifyInstance } from 'fastify';
import { requireAuth } from '@atlas/auth-kit';
import { createContactRequestSchema, type ContactResponse } from '@atlas/types';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { findByCompanyAndEmail, insertContact, toContact } from '../../repo/contacts.js';
import { findCompanyById } from '../../repo/lookups.js';
import { scoreContactRelevance } from '../../lib/relevance.js';

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505';

export function createContactRoute(app: FastifyInstance, deps: AppDeps): void {
  app.post('/v1/contacts', { preHandler: requireAuth(deps.tokenVerifier) }, async (_request, reply) => {
    const body = createContactRequestSchema.parse(_request.body);

    const company = await findCompanyById(deps.db, body.company_id);
    if (!company) {
      throw new AppError('NOT_FOUND', 'Company not found');
    }

    // Re-reporting a known contact (e.g. two users independently add the same
    // recruiter) is a no-op, not a duplicate — same dedupe shape as companies
    // and jobs (contacts_company_email_key).
    if (body.email) {
      const existing = await findByCompanyAndEmail(deps.db, body.company_id, body.email);
      if (existing) {
        const response: ContactResponse = { contact: toContact(existing) };
        reply.status(200).send(response);
        return;
      }
    }

    try {
      const created = await insertContact(deps.db, {
        companyId: body.company_id,
        fullName: body.full_name ?? null,
        title: body.title ?? null,
        email: body.email ?? null,
        linkedinUrl: body.linkedin_url ?? null,
        relevanceScore: scoreContactRelevance(body.title),
        source: 'manual',
      });
      const response: ContactResponse = { contact: toContact(created) };
      reply.status(201).send(response);
    } catch (cause) {
      if ((cause as { code?: string }).code === UNIQUE_VIOLATION && body.email) {
        const raced = await findByCompanyAndEmail(deps.db, body.company_id, body.email);
        if (raced) {
          const response: ContactResponse = { contact: toContact(raced) };
          reply.status(200).send(response);
          return;
        }
      }
      throw cause;
    }
  });
}
