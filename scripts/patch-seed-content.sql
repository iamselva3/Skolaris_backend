SET client_encoding TO 'UTF8';
UPDATE questions SET payload = payload || '{"contentHtml":"<p>What is 4 × 6?</p>"}'::jsonb
  WHERE type='SINGLE_CHOICE' AND topic='Arithmetic' AND (payload->>'contentHtml') IS NULL;
UPDATE questions SET payload = payload || '{"contentHtml":"<p>Select all statements that are true.</p>"}'::jsonb
  WHERE type='MULTIPLE_CHOICE' AND topic='Numbers' AND (payload->>'contentHtml') IS NULL;
UPDATE questions SET payload = payload || '{"contentHtml":"<p>The sum of the interior angles of a triangle is 180°.</p>"}'::jsonb
  WHERE type='TRUE_FALSE' AND topic='Geometry' AND (payload->>'contentHtml') IS NULL;
UPDATE questions SET payload = payload || '{"contentHtml":"<p>The theorem a² + b² = c² for right triangles is named after ______.</p>"}'::jsonb
  WHERE type='FILL_BLANK' AND topic='Geometry' AND (payload->>'contentHtml') IS NULL;
UPDATE questions SET payload = payload || '{"contentHtml":"<p>Match each shape to its defining property.</p>"}'::jsonb
  WHERE type='MATCH_FOLLOWING' AND topic='Shapes' AND (payload->>'contentHtml') IS NULL;
UPDATE questions SET payload = payload || '{"contentHtml":"<p>Explain the Pythagorean theorem and give one real-world application.</p>"}'::jsonb
  WHERE type='DESCRIPTIVE' AND topic='Geometry' AND (payload->>'contentHtml') IS NULL;
