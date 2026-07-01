/**
 * Canonical classroom identity normalization, shared by every code path that
 * creates or looks up a classroom (manual create + create-student/teacher
 * auto-assignment). Keeping a single normalizer is what guarantees that "NEET",
 * "neet", and " Neet " all resolve to the same classroom and never produce
 * duplicates. Discipline (subject), batch (name) and section are matched
 * case-insensitively at the query layer; here we trim and upper-case name/section
 * (the long-standing convention) and trim discipline/year.
 */
export interface ClassroomIdentity {
  name: string;
  year: string | null;
  section: string | null;
  subject: string | null;
}

const trimToNull = (v?: string | null): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

export function normalizeClassroomIdentity(input: {
  name: string;
  year?: string | null;
  section?: string | null;
  subject?: string | null;
}): ClassroomIdentity {
  return {
    name: (input.name ?? '').trim().toUpperCase(),
    year: trimToNull(input.year),
    section: input.section?.trim() ? input.section.trim().toUpperCase() : null,
    subject: trimToNull(input.subject),
  };
}
