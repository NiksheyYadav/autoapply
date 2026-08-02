import {
  APPLICATION_MODES,
  APPLICATION_STATUSES,
  AUTH_PROVIDERS,
  EMPLOYMENT_TYPES,
  JOB_SOURCES,
  MEMBER_ROLES,
  MESSAGE_CHANNELS,
  MESSAGE_STATUSES,
  ORGANIZATION_PLANS,
  ORGANIZATION_TYPES,
  REMOTE_TYPES,
  RESUME_STATUSES,
  TASK_STATUSES,
} from '@atlas/types';
import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Postgres enums are generated from the same constants the Zod schemas use, so
 * an API value that validates is always storable and vice versa.
 */
export const organizationTypeEnum = pgEnum('organization_type', ORGANIZATION_TYPES);
export const organizationPlanEnum = pgEnum('organization_plan', ORGANIZATION_PLANS);
export const memberRoleEnum = pgEnum('member_role', MEMBER_ROLES);
export const authProviderEnum = pgEnum('auth_provider', AUTH_PROVIDERS);
export const remoteTypeEnum = pgEnum('remote_type', REMOTE_TYPES);
export const employmentTypeEnum = pgEnum('employment_type', EMPLOYMENT_TYPES);
export const resumeStatusEnum = pgEnum('resume_status', RESUME_STATUSES);
export const applicationStatusEnum = pgEnum('application_status', APPLICATION_STATUSES);
export const applicationModeEnum = pgEnum('application_mode', APPLICATION_MODES);
export const messageChannelEnum = pgEnum('message_channel', MESSAGE_CHANNELS);
export const messageStatusEnum = pgEnum('message_status', MESSAGE_STATUSES);
export const taskStatusEnum = pgEnum('task_status', TASK_STATUSES);
export const jobSourceEnum = pgEnum('job_source', JOB_SOURCES);
