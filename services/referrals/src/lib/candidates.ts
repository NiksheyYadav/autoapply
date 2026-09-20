import type { Database } from '@atlas/db';
import type { ReferralCandidate } from '@atlas/types';
import { toContact, topContactsForCompanies } from '../repo/contacts.js';
import { findCompaniesByIds, listUserApplicationCompanies } from '../repo/lookups.js';

const MAX_APPLICATIONS = 20;
const CONTACTS_PER_COMPANY = 3;

/**
 * Shared by the worker's `referral.detected` fan-out and the `GET
 * /v1/referrals` read path, so "what counts as a referral opportunity"
 * can't drift between the two. Batches the company/contact lookups (two
 * queries total) instead of looping per company — a user with 20
 * applications used to mean up to 40 round trips here.
 */
export async function findReferralCandidatesForUser(db: Database, userId: string): Promise<ReferralCandidate[]> {
  const applicationCompanies = await listUserApplicationCompanies(db, userId, MAX_APPLICATIONS);

  // A company's contacts surface once, off the user's most recent
  // application there — repeating them per application would just be noise.
  const firstApplicationByCompany = new Map<string, (typeof applicationCompanies)[number]>();
  for (const applicationCompany of applicationCompanies) {
    if (!firstApplicationByCompany.has(applicationCompany.companyId)) {
      firstApplicationByCompany.set(applicationCompany.companyId, applicationCompany);
    }
  }
  const companyIds = [...firstApplicationByCompany.keys()];

  const [companies, contactsByCompany] = await Promise.all([
    findCompaniesByIds(db, companyIds),
    topContactsForCompanies(db, companyIds, CONTACTS_PER_COMPANY),
  ]);
  const companyById = new Map(companies.map((company) => [company.company_id, company]));

  const results: ReferralCandidate[] = [];
  for (const [companyId, applicationCompany] of firstApplicationByCompany) {
    const company = companyById.get(companyId);
    if (!company) continue;

    const contacts = contactsByCompany.get(companyId) ?? [];
    for (const contact of contacts) {
      results.push({
        contact: toContact(contact),
        company,
        job_id: applicationCompany.jobId,
        application_id: applicationCompany.applicationId,
      });
    }
  }

  return results;
}
