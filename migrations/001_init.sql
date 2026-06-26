-- Migration initiale Cubi Backend
-- Création des 10 tables dans l'ordre respectant les dépendances FK

-- Extension pour gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- 1. type_licence (aucune dépendance)
-- ============================================================
CREATE TABLE type_licence (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    nom               VARCHAR(100) NOT NULL,
    sessions_min      INT         NOT NULL,
    sessions_max      INT,                         -- NULL = illimité (Licence 3)
    prix_unitaire     NUMERIC(10, 2) NOT NULL,
    personnalisable   BOOLEAN     NOT NULL DEFAULT FALSE,
    ressources_cpu    INT         NOT NULL,
    ressources_ram_go INT         NOT NULL,
    actif             BOOLEAN     NOT NULL DEFAULT TRUE
);

-- Données de référence des trois paliers de licence
INSERT INTO type_licence (nom, sessions_min, sessions_max, prix_unitaire, personnalisable, ressources_cpu, ressources_ram_go)
VALUES
    ('Licence 1', 1,   30,  5.00,  FALSE, 2, 4),
    ('Licence 2', 31,  100, 4.00,  FALSE, 2, 4),
    ('Licence 3', 101, NULL, 3.00, TRUE,  4, 8);

-- ============================================================
-- 2. groupe_scolaire (dépend de type_licence)
-- ============================================================
CREATE TABLE groupe_scolaire (
    id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    nom_du_siege      VARCHAR(255) NOT NULL,
    nom_DAF           VARCHAR(100) NOT NULL,
    prenom_DAF        VARCHAR(100) NOT NULL,
    type_licence_id   UUID         NOT NULL,
    mot_de_passe_hash VARCHAR(255) NOT NULL,
    statut            VARCHAR(20)  NOT NULL CHECK (statut IN ('actif', 'inactif', 'suspendu')),
    date_creation     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    date_modification TIMESTAMPTZ,

    CONSTRAINT fk_groupe_type_licence
        FOREIGN KEY (type_licence_id) REFERENCES type_licence (id)
        ON DELETE RESTRICT ON UPDATE CASCADE
);

-- ============================================================
-- 3. ecole (dépend de groupe_scolaire et type_licence)
-- ============================================================
CREATE TABLE ecole (
    id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    groupe_scolaire_id  UUID,                          -- nullable : école indépendante
    nom_complet_ecole   VARCHAR(255) NOT NULL,
    siret               CHAR(14)     NOT NULL UNIQUE,
    adresse             VARCHAR(255) NOT NULL,
    code_postal         CHAR(5)      NOT NULL,
    ville               VARCHAR(100) NOT NULL,
    type_licence_id     UUID         NOT NULL,
    mot_de_passe_hash   VARCHAR(255) NOT NULL,
    statut              VARCHAR(20)  NOT NULL CHECK (statut IN ('actif', 'inactif', 'suspendu')),
    date_creation       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_ecole_groupe
        FOREIGN KEY (groupe_scolaire_id) REFERENCES groupe_scolaire (id)
        ON DELETE SET NULL ON UPDATE CASCADE,

    CONSTRAINT fk_ecole_type_licence
        FOREIGN KEY (type_licence_id) REFERENCES type_licence (id)
        ON DELETE RESTRICT ON UPDATE CASCADE
);

-- ============================================================
-- 4. contact_facturation (dépend de ecole et groupe_scolaire)
-- ============================================================
CREATE TABLE contact_facturation (
    id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    ecole_id            UUID,
    groupe_scolaire_id  UUID,
    nom_contact         VARCHAR(100) NOT NULL,
    prenom_contact      VARCHAR(100) NOT NULL,
    email_facturation   VARCHAR(255) NOT NULL UNIQUE,
    telephone           VARCHAR(20),
    date_creation       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- Au moins un des deux FK doit être renseigné
    CONSTRAINT chk_contact_rattachement
        CHECK (ecole_id IS NOT NULL OR groupe_scolaire_id IS NOT NULL),

    CONSTRAINT fk_contact_ecole
        FOREIGN KEY (ecole_id) REFERENCES ecole (id)
        ON DELETE CASCADE ON UPDATE CASCADE,

    CONSTRAINT fk_contact_groupe
        FOREIGN KEY (groupe_scolaire_id) REFERENCES groupe_scolaire (id)
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- ============================================================
-- 5. demande_inscription (dépend de type_licence)
-- ============================================================
CREATE TABLE demande_inscription (
    id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    type_demande       VARCHAR(10)  NOT NULL CHECK (type_demande IN ('ecole', 'groupe')),
    nom_siege_ou_ecole VARCHAR(255) NOT NULL,
    nom_DAF            VARCHAR(100),           -- groupe seulement
    prenom_DAF         VARCHAR(100),           -- groupe seulement
    siret              CHAR(14),               -- ecole seulement
    type_licence_id    UUID         NOT NULL,
    statut             VARCHAR(20)  NOT NULL   CHECK (statut IN ('en_attente', 'validee', 'rejetee')),
    date_demande       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    date_traitement    TIMESTAMPTZ,

    CONSTRAINT fk_demande_type_licence
        FOREIGN KEY (type_licence_id) REFERENCES type_licence (id)
        ON DELETE RESTRICT ON UPDATE CASCADE
);

-- ============================================================
-- 6. classe (dépend de ecole)
-- ============================================================
CREATE TABLE classe (
    id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    ecole_id       UUID         NOT NULL,
    nom            VARCHAR(100) NOT NULL,
    niveau         VARCHAR(50),
    annee_scolaire CHAR(9),               -- ex: 2024-2025
    effectif_max   INT,
    date_creation  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_classe_ecole
        FOREIGN KEY (ecole_id) REFERENCES ecole (id)
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- ============================================================
-- 7. utilisateur (dépend de ecole et classe, auto-référence invite_par)
-- ============================================================
CREATE TABLE utilisateur (
    id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    ecole_id          UUID         NOT NULL,
    classe_id         UUID,                    -- nullable : admin/enseignant sans classe
    invite_par        UUID,                    -- nullable : auto-référence vers l'admin créateur
    nom               VARCHAR(100) NOT NULL,
    prenom            VARCHAR(100) NOT NULL,
    email             VARCHAR(255) NOT NULL UNIQUE,
    mot_de_passe_hash VARCHAR(255) NOT NULL,
    mdp_temporaire    BOOLEAN      NOT NULL DEFAULT TRUE,
    role              VARCHAR(20)  NOT NULL CHECK (role IN ('eleve', 'enseignant', 'admin')),
    statut            VARCHAR(20)  NOT NULL CHECK (statut IN ('actif', 'inactif', 'suspendu')),
    date_invitation   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    derniere_connexion TIMESTAMPTZ,

    CONSTRAINT fk_utilisateur_ecole
        FOREIGN KEY (ecole_id) REFERENCES ecole (id)
        ON DELETE RESTRICT ON UPDATE CASCADE,

    CONSTRAINT fk_utilisateur_classe
        FOREIGN KEY (classe_id) REFERENCES classe (id)
        ON DELETE SET NULL ON UPDATE CASCADE,

    CONSTRAINT fk_utilisateur_invite_par
        FOREIGN KEY (invite_par) REFERENCES utilisateur (id)
        ON DELETE SET NULL ON UPDATE CASCADE
);

-- ============================================================
-- 8. licence (dépend de ecole, utilisateur, type_licence)
-- ============================================================
CREATE TABLE licence (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    ecole_id            UUID        NOT NULL,
    utilisateur_id      UUID,                  -- nullable : licence non encore assignée
    type_licence_id     UUID        NOT NULL,
    statut              VARCHAR(20) NOT NULL CHECK (statut IN ('disponible', 'assignee', 'suspendue', 'expiree')),
    nb_sessions_actives INT         NOT NULL DEFAULT 0,
    date_debut          DATE        NOT NULL,
    date_fin            DATE,                  -- NULL = licence permanente
    date_creation       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_licence_ecole
        FOREIGN KEY (ecole_id) REFERENCES ecole (id)
        ON DELETE RESTRICT ON UPDATE CASCADE,

    CONSTRAINT fk_licence_utilisateur
        FOREIGN KEY (utilisateur_id) REFERENCES utilisateur (id)
        ON DELETE SET NULL ON UPDATE CASCADE,

    CONSTRAINT fk_licence_type
        FOREIGN KEY (type_licence_id) REFERENCES type_licence (id)
        ON DELETE RESTRICT ON UPDATE CASCADE
);

-- ============================================================
-- 9. session (dépend de utilisateur et licence)
-- ============================================================
CREATE TABLE session (
    id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    utilisateur_id UUID         NOT NULL,
    licence_id     UUID         NOT NULL,
    token_session  VARCHAR(512) NOT NULL UNIQUE,
    ip_origine     VARCHAR(45),
    appareil_os    VARCHAR(100),
    statut         VARCHAR(20)  NOT NULL CHECK (statut IN ('active', 'terminee', 'expiree')),
    type_session   VARCHAR(20)  NOT NULL DEFAULT 'normale' CHECK (type_session IN ('normale', 'examen', 'supervisee')),
    date_debut     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    date_fin       TIMESTAMPTZ,

    CONSTRAINT fk_session_utilisateur
        FOREIGN KEY (utilisateur_id) REFERENCES utilisateur (id)
        ON DELETE RESTRICT ON UPDATE CASCADE,

    CONSTRAINT fk_session_licence
        FOREIGN KEY (licence_id) REFERENCES licence (id)
        ON DELETE RESTRICT ON UPDATE CASCADE
);

-- ============================================================
-- 10. log_activite (dépend de session)
-- ============================================================
CREATE TABLE log_activite (
    id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID         NOT NULL,
    action     VARCHAR(100) NOT NULL,
    details    TEXT,
    horodatage TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_log_session
        FOREIGN KEY (session_id) REFERENCES session (id)
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- ============================================================
-- Index pour optimiser les requêtes fréquentes
-- ============================================================
CREATE INDEX idx_ecole_groupe         ON ecole (groupe_scolaire_id);
CREATE INDEX idx_ecole_statut         ON ecole (statut);
CREATE INDEX idx_utilisateur_ecole    ON utilisateur (ecole_id);
CREATE INDEX idx_utilisateur_email    ON utilisateur (email);
CREATE INDEX idx_utilisateur_statut   ON utilisateur (statut);
CREATE INDEX idx_licence_ecole        ON licence (ecole_id);
CREATE INDEX idx_licence_utilisateur  ON licence (utilisateur_id);
CREATE INDEX idx_licence_statut       ON licence (statut);
CREATE INDEX idx_session_utilisateur  ON session (utilisateur_id);
CREATE INDEX idx_session_statut       ON session (statut);
CREATE INDEX idx_log_session          ON log_activite (session_id);
CREATE INDEX idx_log_horodatage       ON log_activite (horodatage DESC);
