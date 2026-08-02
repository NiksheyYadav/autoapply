# 2. Database Schema

## Core tables
### users
- user_id (UUID, PK)
- profile_id (UUID, nullable, FK)
- email (unique)
- full_name
- auth_provider
- created_at
- updated_at

### organizations
- organization_id (UUID, PK)
- name
- type (`individual`, `university`, `enterprise`)
- plan
- created_at

### organization_members
- organization_id (FK)
- user_id (FK)
- role
- permissions (JSONB)
- created_at

### students
- student_id (UUID, PK)
- organization_id (FK)
- department
- graduation_year
- current_status
- created_at

### resumes
- resume_id (UUID, PK)
- user_id (FK)
- storage_url
- parsed_text
- embeddings (vector reference)
- ats_score
- created_at

### jobs
- job_id (UUID, PK)
- company_id (FK)
- title
- salary_min
- salary_max
- location
- remote_type
- source
- job_hash
- created_at

### companies
- company_id (UUID, PK)
- name
- industry
- website
- created_at

### applications
- application_id (UUID, PK)
- user_id (FK)
- job_id (FK)
- status
- submitted_at
- last_event_at
- failure_reason

### contacts
- contact_id (UUID, PK)
- company_id (FK)
- title
- email
- linkedin_url
- relevance_score

### messages
- message_id (UUID, PK)
- application_id (FK)
- contact_id (FK, nullable)
- channel
- status
- body
- sent_at

### tasks
- task_id (UUID, PK)
- task_type
- queue_status
- retry_count
- payload (JSONB)
- locked_at

### analytics_events
- event_id (UUID, PK)
- organization_id (FK)
- user_id (FK, nullable)
- event_type
- payload (JSONB)
- timestamp

## Design notes
- Use soft deletes only where legally required.
- Partition large event and application tables by time.
- Store sensitive tokens in a separate encrypted secrets store, not in Postgres.
- Add unique constraints on job_hash, external source IDs, and connector account IDs.
