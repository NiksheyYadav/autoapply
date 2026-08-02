-- Extensions required by the Atlas schema. Runs once on first container start.
-- Migrations assume these already exist (docs/02 § Design notes).

-- Embeddings for resumes, jobs, and contacts.
CREATE EXTENSION IF NOT EXISTS vector;

-- gen_random_uuid() for primary keys.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Trigram indexes backing fuzzy company/title matching during dedupe.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Separate database for integration tests so they can truncate freely.
SELECT 'CREATE DATABASE atlas_test OWNER atlas'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'atlas_test') \gexec

\connect atlas_test
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
