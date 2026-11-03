-- Messagerie entre les organisations (ecole) et l'équipe Cubi.
-- Une conversation appartient à une organisation et regroupe ses messages.

CREATE TABLE IF NOT EXISTS conversation (
    id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    ecole_id              UUID         NOT NULL,
    objet                 VARCHAR(255) NOT NULL,
    statut                VARCHAR(20)  NOT NULL DEFAULT 'ouverte' CHECK (statut IN ('ouverte', 'traitee')),
    lu_par_cubi           BOOLEAN      NOT NULL DEFAULT FALSE,
    lu_par_ecole          BOOLEAN      NOT NULL DEFAULT TRUE,
    date_creation         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    date_dernier_message  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_conversation_ecole
        FOREIGN KEY (ecole_id) REFERENCES ecole (id)
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS message (
    id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id  UUID         NOT NULL,
    auteur_type      VARCHAR(10)  NOT NULL CHECK (auteur_type IN ('cubi', 'ecole')),
    auteur_id        UUID         NOT NULL,  -- utilisateur_cubi.id ou utilisateur.id selon auteur_type
    contenu          TEXT         NOT NULL,
    date_envoi       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_message_conversation
        FOREIGN KEY (conversation_id) REFERENCES conversation (id)
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversation_ecole ON conversation (ecole_id, date_dernier_message DESC);
CREATE INDEX IF NOT EXISTS idx_message_conversation ON message (conversation_id, date_envoi);
