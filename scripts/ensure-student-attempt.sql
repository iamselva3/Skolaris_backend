-- Ensure student1 has a startable (NOT_STARTED) attempt for the seeded LIVE
-- exam, so the E2E student-attempt flow has something to open. Idempotent.
SET client_encoding TO 'UTF8';

INSERT INTO exam_attempts (id, tenant_id, exam_id, student_id, status, question_order_seed, updated_at)
SELECT gen_random_uuid(), e.tenant_id, e.id, s.id, 'NOT_STARTED', 123456789, now()
FROM exams e
JOIN students s ON s.user_id = (SELECT id FROM users WHERE email = 'student1@acme.test')
WHERE e.title = 'Term 1 Quiz — Mathematics' AND e.status = 'LIVE'
ON CONFLICT (exam_id, student_id)
DO UPDATE SET status = 'NOT_STARTED', score = NULL, submitted_at = NULL,
              started_at = NULL, auto_submitted = false, descriptive_pending = false,
              time_remaining_seconds = NULL, updated_at = now();

SELECT u.email, ea.status FROM exam_attempts ea
JOIN students s ON s.id = ea.student_id
JOIN users u ON u.id = s.user_id;
