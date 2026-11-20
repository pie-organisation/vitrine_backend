-- Identifiants du service « postes de travail » (API Go / Proxmox) d'une école.
-- Le back s'y connecte à la place de l'admin : plus de seconde connexion côté front.
-- Le mot de passe est chiffré (AES-256-GCM, clé VDI_SECRET_KEY), jamais renvoyé au front.
-- Migration additive et idempotente.

CREATE TABLE IF NOT EXISTS vdi_identifiants (
    ecole_id              UUID         PRIMARY KEY REFERENCES ecole(id) ON DELETE CASCADE,
    email                 VARCHAR(255) NOT NULL,
    mot_de_passe_chiffre  TEXT         NOT NULL,
    date_maj              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
