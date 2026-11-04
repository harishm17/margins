-- When the student closed the "About this reading" row above the reader, so it stays closed on every device. Additive only.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "seen_reader_note_at" TIMESTAMP(3);
