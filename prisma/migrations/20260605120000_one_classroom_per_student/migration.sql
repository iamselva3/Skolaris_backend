-- A student may belong to at most ONE classroom. First drop duplicate
-- memberships (keep the most recently joined classroom per student), then make
-- the membership unique by student.
DELETE FROM "classroom_students" a
USING "classroom_students" b
WHERE a.student_id = b.student_id
  AND (a.joined_at < b.joined_at
       OR (a.joined_at = b.joined_at AND a.ctid < b.ctid));

DROP INDEX "classroom_students_student_id_idx";

CREATE UNIQUE INDEX "classroom_students_student_id_key"
  ON "classroom_students"("student_id");
