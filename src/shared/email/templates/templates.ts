// Plain HTML strings — no template engine. Keeps the email module zero-deps beyond nodemailer.

export const wrap = (innerHtml: string): string => `
<!doctype html><html><body style="font-family:Arial,sans-serif;color:#1F2937;max-width:560px;margin:auto;padding:24px">
${innerHtml}
<hr style="margin-top:32px;border:none;border-top:1px solid #E5E7EB" />
<p style="font-size:12px;color:#6B7280">SKOLARIS — do not reply to this email.</p>
</body></html>`;

export const examPublishedTemplate = (input: {
  studentName: string;
  examTitle: string;
  opensAt: string | null;
  closesAt: string | null;
  durationMinutes: number;
}): { subject: string; html: string } => ({
  subject: `New exam scheduled: ${input.examTitle}`,
  html: wrap(`
    <h2 style="font-size:18px;margin:0 0 12px">${input.examTitle}</h2>
    <p>Hello ${input.studentName},</p>
    <p>A new exam has been scheduled for you.</p>
    <ul>
      <li><strong>Duration:</strong> ${input.durationMinutes} minutes</li>
      ${input.opensAt ? `<li><strong>Opens:</strong> ${input.opensAt}</li>` : ''}
      ${input.closesAt ? `<li><strong>Closes:</strong> ${input.closesAt}</li>` : ''}
    </ul>
    <p>Log in to SKOLARIS to take the exam during the open window.</p>
  `),
});

export const examStartsSoonTemplate = (input: {
  studentName: string;
  examTitle: string;
  opensAt: string;
}): { subject: string; html: string } => ({
  subject: `Reminder: ${input.examTitle} starts soon`,
  html: wrap(`
    <p>Hello ${input.studentName},</p>
    <p><strong>${input.examTitle}</strong> opens at <strong>${input.opensAt}</strong>.</p>
    <p>Log in to SKOLARIS and be ready.</p>
  `),
});

export const attemptGradedTemplate = (input: {
  studentName: string;
  examTitle: string;
  score: string;
  totalMarks: string;
  descriptivePending: boolean;
}): { subject: string; html: string } => ({
  subject: `Your result for ${input.examTitle}`,
  html: wrap(`
    <p>Hello ${input.studentName},</p>
    <p>Your attempt for <strong>${input.examTitle}</strong> has been graded.</p>
    <p style="font-size:20px"><strong>${input.score}</strong> / ${input.totalMarks}</p>
    ${
      input.descriptivePending
        ? '<p style="color:#6B7280">Descriptive answers are still pending teacher review and will update your final score.</p>'
        : ''
    }
    <p>Log in to SKOLARIS to see the per-question breakdown and weak-topic recommendations.</p>
  `),
});

export const attemptFlaggedTemplate = (input: {
  teacherName: string;
  studentName: string;
  examTitle: string;
  violationCount: number;
}): { subject: string; html: string } => ({
  subject: `Attempt flagged: ${input.studentName} — ${input.examTitle}`,
  html: wrap(`
    <p>Hello ${input.teacherName},</p>
    <p>
      <strong>${input.studentName}</strong>'s attempt at <strong>${input.examTitle}</strong>
      has been flagged after <strong>${input.violationCount}</strong> anti-cheating events.
    </p>
    <p>Review the attempt in SKOLARIS to decide whether to accept or invalidate.</p>
  `),
});
