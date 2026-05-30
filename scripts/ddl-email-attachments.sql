-- Marks a campaign knowledge file as attachable to outbound emails. The AI
-- decides per email whether to attach it (marketing PDFs, app one-pagers).
ALTER TABLE campaign_knowledge_files ADD COLUMN IF NOT EXISTS attach_to_emails boolean NOT NULL DEFAULT false;
