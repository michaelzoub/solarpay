ALTER TABLE payment_intents ADD COLUMN intent_nonce TEXT;
ALTER TABLE payment_intents ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX unique_intent_nonce ON payment_intents(intent_nonce) WHERE intent_nonce IS NOT NULL;
