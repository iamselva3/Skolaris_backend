-- Reset the seeded student1 attempt back to NOT_STARTED so the E2E attempt
-- flow has a startable exam. Clears saved answers + grading state.
SET client_encoding TO 'UTF8';

WITH s AS (
  SELECT id AS student_id, tenant_id FROM users WHERE email = 'student1@acme.test'
)
DELETE FROM attempt_answers aa
USING exam_attempts ea, s
WHERE aa.attempt_id = ea.id AND ea.student_id = s.student_id;

WITH s AS (
  SELECT id AS student_id FROM users WHERE email = 'student1@acme.test'
)
UPDATE exam_attempts ea
SET status = 'NOT_STARTED',
    score = NULL,
    submitted_at = NULL,
    started_at = NULL,
    auto_submitted = false,
    descriptive_pending = false,
    time_remaining_seconds = NULL
FROM s
WHERE ea.student_id = s.student_id;
