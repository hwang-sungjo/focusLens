-- Concentration log v2 preserves the client measurement window and retry identity.
ALTER TABLE "concentration_logs"
ADD COLUMN "client_log_id" TEXT,
ADD COLUMN "measured_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "concentration_logs_session_id_client_log_id_key"
ON "concentration_logs"("session_id", "client_log_id");

-- Rotating opaque refresh tokens. Only SHA-256 hashes are persisted.
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "replaced_by_token_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");
CREATE INDEX "refresh_tokens_user_id_expires_at_idx" ON "refresh_tokens"("user_id", "expires_at");
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

ALTER TABLE "refresh_tokens"
ADD CONSTRAINT "refresh_tokens_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "refresh_tokens"
ADD CONSTRAINT "refresh_tokens_replaced_by_token_id_fkey"
FOREIGN KEY ("replaced_by_token_id") REFERENCES "refresh_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;
