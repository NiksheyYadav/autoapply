import type { Database } from '@atlas/db';
import type { ReferralCandidate } from '@atlas/types';
import { topContactsForCompany, toContact } from '../repo/contacts.js';
import { findCompanyById, listUserApplicationCompanies } from '../repo/lookups.js';

const MAX_APPLICATIONS = 20;
const CONTACTS_PER_COMPANY = 3;

/**
 * Shared by the worker's `referral.detected` fan-out and the `GET
 * /v1/referrals` read path, so "what counts as a referral opportunity"
 * can't drift between the two.
 */
export async function findReferralCandidatesForUser(db: Database, userId: string): Promise<ReferralCandidate[]> {
  const applicationCompanies = await listUserApplicationCompanies(db, userId, MAX_APPLICATIONS);
  const results: ReferralCandidate[] = [];
  const seenCompanies = new Set<string>();

  for (const applicationCompany of applicationCompanies) {
    // A company's contacts surface once, off the user's most recent
    // application there — repeating them per application would just be noise.
    if (seenCompanies.has(applicationCompany.companyId)) continue;
    seenCompanies.add(applicationCompany.companyId);

    const company = await findCompanyById(db, applicationCompany.companyId);
    if (!company) continue;

    const contacts = await topContactsForCompany(db, applicationCompany.companyId, CONTACTS_PER_COMPANY);
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
