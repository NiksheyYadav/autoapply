# 5. AI-Agent Design

## Agent topology
Use specialized agents with narrow responsibilities and explicit tool access.

### Resume agent
- Parse resumes
- Extract skills and achievements
- Build candidate profiles
- Generate embeddings

### Job discovery agent
- Search jobs continuously
- Rank opportunities
- Detect duplicates
- Filter spam

### Matching agent
- Calculate compatibility scores
- Identify skill gaps
- Rank opportunities

### Resume optimization agent
- Optimize keywords
- Rewrite bullet points
- Improve ATS scores

### Application agent
- Fill forms
- Upload files
- Answer screening questions
- Track failures

### Referral agent
- Discover employees
- Identify recruiters and hiring managers
- Build relationship graphs

### Outreach agent
- Generate personalized emails and messages
- Schedule follow-ups
- Measure response rates

### Learning agent
- Learn from outcomes
- Improve ranking algorithms
- Improve application quality

## Orchestration
- One top-level orchestrator owns the user objective.
- Subagents should return compact summaries, not raw dumps.
- Persist structured outputs to Postgres and vector DB.
- Use retries and tool-specific limits to avoid infinite loops.

## Model policy
- Use smaller models for extraction and classification.
- Use stronger models for synthesis and planning.
- Escalate only when a task needs deep reasoning or high-impact outputs.
