-- A student's margin notes outlive the file and the topic they were written on (findings 78 and 89, plan F7 and SW13).
-- Deleting a file or a topic used to cascade over them. Now:
--   * the topic and file links are cleared instead (ON DELETE SET NULL), and the note keeps its course (project_id), so
--     the course page can list it under "Notes from removed topics" or "Notes from removed files";
--   * the note keeps the passage it sits on (quote), copied here from the chunk for existing notes and by the app for
--     new ones, so a detached note still shows what it was about.
-- Expand only: every column the old app writes is still accepted (project_id and quote have no old writer, and the old
-- app's inserts are covered by the trigger below until the new web app is live).

ALTER TABLE "margin_notes" ADD COLUMN "project_id" TEXT;
ALTER TABLE "margin_notes" ADD COLUMN "quote" TEXT;

UPDATE "margin_notes" n SET "project_id" = t."project_id" FROM "topics" t WHERE t."id" = n."topic_id";
UPDATE "margin_notes" n SET "quote" = c."chunk_text" FROM "material_chunks" c WHERE c."id" = n."chunk_id";

-- Old web app instances still running during the deploy insert without project_id or quote; fill them as the backfill
-- above does (the course from the topic, the passage from the chunk).
CREATE OR REPLACE FUNCTION margin_notes_fill_project() RETURNS trigger AS $$
BEGIN
  IF NEW."project_id" IS NULL AND NEW."topic_id" IS NOT NULL THEN
    SELECT "project_id" INTO NEW."project_id" FROM "topics" WHERE "id" = NEW."topic_id";
  END IF;
  IF NEW."quote" IS NULL AND NEW."chunk_id" IS NOT NULL THEN
    SELECT "chunk_text" INTO NEW."quote" FROM "material_chunks" WHERE "id" = NEW."chunk_id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER margin_notes_fill_project BEFORE INSERT ON "margin_notes"
  FOR EACH ROW EXECUTE FUNCTION margin_notes_fill_project();

-- expand-contract: every existing row was filled above, and the trigger fills rows the old web app inserts during the deploy.
ALTER TABLE "margin_notes" ALTER COLUMN "project_id" SET NOT NULL;
-- expand-contract: dropping NOT NULL and swapping the two foreign keys from CASCADE to SET NULL only widens what is
-- accepted; the old app never writes NULL, and no reader of these columns is in the AI service.
ALTER TABLE "margin_notes" ALTER COLUMN "topic_id" DROP NOT NULL;
ALTER TABLE "margin_notes" ALTER COLUMN "material_id" DROP NOT NULL;

ALTER TABLE "margin_notes" DROP CONSTRAINT "margin_notes_topic_id_fkey";
ALTER TABLE "margin_notes" ADD CONSTRAINT "margin_notes_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "margin_notes" DROP CONSTRAINT "margin_notes_material_id_fkey";
ALTER TABLE "margin_notes" ADD CONSTRAINT "margin_notes_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "margin_notes" ADD CONSTRAINT "margin_notes_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "margin_notes_user_id_project_id_created_at_idx" ON "margin_notes"("user_id", "project_id", "created_at");
