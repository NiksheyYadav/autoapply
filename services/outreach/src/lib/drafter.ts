/**
 * Template-based drafting — the same "good enough to make the pipeline real"
 * bar as `@atlas/ai`'s resume parser (no LLM key is configured anywhere in
 * this repo). The seam is isolated here so a real model call can replace the
 * body later without touching the route that calls it.
 */
export interface DraftContext {
  candidateName: string | null;
  jobTitle: string | null;
  companyName: string | null;
  contactName: string | null;
  contactTitle: string | null;
  topSkills: string[];
}

export interface Draft {
  subject: string;
  body: string;
}

function draftSubject(ctx: DraftContext): string {
  if (ctx.jobTitle && ctx.companyName) return `Interested in the ${ctx.jobTitle} role at ${ctx.companyName}`;
  if (ctx.companyName) return `Reaching out about opportunities at ${ctx.companyName}`;
  return 'Quick introduction';
}

function draftBody(ctx: DraftContext): string {
  const greeting = ctx.contactName ? `Hi ${ctx.contactName},` : 'Hello,';
  const who = ctx.candidateName ?? 'a candidate';

  const roleClause =
    ctx.jobTitle && ctx.companyName
      ? `I'm ${who}, and I just applied for the ${ctx.jobTitle} role at ${ctx.companyName}.`
      : ctx.companyName
        ? `I'm ${who}, and I'm interested in opportunities at ${ctx.companyName}.`
        : `I'm ${who}, and I wanted to reach out and introduce myself.`;

  const skillsClause =
    ctx.topSkills.length > 0 ? ` My background includes ${ctx.topSkills.slice(0, 3).join(', ')}.` : '';

  const contactRoleClause = ctx.contactTitle ? ` I saw you work as ${ctx.contactTitle} there and thought you'd be a great person to connect with.` : '';

  const ask = ' Would you be open to a quick chat about the role, or pointing me to the right person on your team?';

  return `${greeting}\n\n${roleClause}${skillsClause}${contactRoleClause}${ask}\n\nThanks for your time,\n${who}`;
}

export function draftMessage(ctx: DraftContext): Draft {
  return { subject: draftSubject(ctx), body: draftBody(ctx) };
}
