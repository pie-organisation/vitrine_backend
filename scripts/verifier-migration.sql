-- FICHIER GÉNÉRÉ par scripts/generer-verifier-migration.js (npm run migration:verifier) : ne pas modifier à la main.
-- Test de fumée de la migration 004, à coller dans le SQL Editor de Neon (ou psql -f).
-- Tout se passe dans une transaction annulée à la fin : rien n'est appliqué.
-- Succès : le NOTICE « toutes les vérifications passent » puis le récapitulatif des colonnes.
-- Échec : une erreur « KO : … » ou une erreur SQL, et la transaction est annulée.

BEGIN;

-- ── Migration 004, 1er passage ──────────────────────────────────────────────
-- Contrats, signature électronique simple (eIDAS art. 25) et factures.
-- Migration additive et idempotente : rejouable sans erreur, ne modifie aucune colonne existante.
-- Montants toujours en centimes (INTEGER). Une facture émise est immuable : toute correction passe par un avoir.

-- ============================================================
-- 1. document : fichiers binaires (PDF), lus uniquement via src/services/documentStorage.js
-- ============================================================
CREATE TABLE IF NOT EXISTS document (
    id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    type           VARCHAR(20)  NOT NULL CHECK (type IN ('contrat_original', 'contrat_signe', 'facture', 'avoir')),
    mime           VARCHAR(100) NOT NULL DEFAULT 'application/pdf',
    taille_octets  INT          NOT NULL CHECK (taille_octets >= 0),
    sha256         CHAR(64)     NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    contenu        BYTEA        NOT NULL,
    date_creation  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 2. sequence_document : numérotation sans trou ni doublon (CTR, FAC, AV) par année
-- ============================================================
CREATE TABLE IF NOT EXISTS sequence_document (
    annee            SMALLINT    NOT NULL,
    type             VARCHAR(3)  NOT NULL CHECK (type IN ('CTR', 'FAC', 'AV')),
    derniere_valeur  INT         NOT NULL DEFAULT 0 CHECK (derniere_valeur >= 0),
    PRIMARY KEY (annee, type)
);

-- ============================================================
-- 3. contrat : un par école indépendante ou par groupe scolaire
-- ============================================================
CREATE TABLE IF NOT EXISTS contrat (
    id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    numero                  VARCHAR(20)  NOT NULL UNIQUE CHECK (numero ~ '^CTR-[0-9]{4}-[0-9]{4,}$'),
    ecole_id                UUID,
    groupe_scolaire_id      UUID,
    demande_inscription_id  UUID,
    donnees                 JSONB        NOT NULL,   -- offre, lignes par établissement, quantités, prix en centimes : figés
    duree_mois              INT          NOT NULL CHECK (duree_mois > 0),
    date_debut              DATE         NOT NULL,
    statut                  VARCHAR(20)  NOT NULL DEFAULT 'brouillon'
                                         CHECK (statut IN ('brouillon', 'envoye', 'signe', 'annule', 'expire')),
    signataire_nom          VARCHAR(200),
    signataire_fonction     VARCHAR(150),
    signataire_email        VARCHAR(255),
    document_original_id    UUID,
    sha256_original         CHAR(64)     CHECK (sha256_original ~ '^[0-9a-f]{64}$'),
    document_signe_id       UUID,
    sha256_signe            CHAR(64)     CHECK (sha256_signe ~ '^[0-9a-f]{64}$'),
    date_signature_cubi     TIMESTAMPTZ,
    date_signature_client   TIMESTAMPTZ,
    cree_par                UUID,
    date_creation           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    date_modification       TIMESTAMPTZ,

    -- Exactement un rattachement : école indépendante OU groupe
    CONSTRAINT chk_contrat_rattachement
        CHECK (num_nonnulls(ecole_id, groupe_scolaire_id) = 1),

    -- Pas d'envoi sans signataire ni original figé
    CONSTRAINT chk_contrat_envoi
        CHECK (statut IN ('brouillon', 'annule')
               OR (signataire_nom IS NOT NULL AND signataire_email IS NOT NULL
                   AND document_original_id IS NOT NULL AND sha256_original IS NOT NULL)),

    -- Un contrat signé a forcément sa version signée et sa date de signature
    CONSTRAINT chk_contrat_signe
        CHECK (statut <> 'signe'
               OR (document_signe_id IS NOT NULL AND sha256_signe IS NOT NULL
                   AND date_signature_client IS NOT NULL)),

    -- RESTRICT : un contrat est une pièce à conserver, il bloque la suppression de l'organisation
    CONSTRAINT fk_contrat_ecole
        FOREIGN KEY (ecole_id) REFERENCES ecole (id)
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_contrat_groupe
        FOREIGN KEY (groupe_scolaire_id) REFERENCES groupe_scolaire (id)
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_contrat_demande
        FOREIGN KEY (demande_inscription_id) REFERENCES demande_inscription (id)
        ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT fk_contrat_document_original
        FOREIGN KEY (document_original_id) REFERENCES document (id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_contrat_document_signe
        FOREIGN KEY (document_signe_id) REFERENCES document (id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_contrat_cree_par
        FOREIGN KEY (cree_par) REFERENCES utilisateur_cubi (id)
        ON DELETE SET NULL ON UPDATE CASCADE
);

-- ============================================================
-- 4. demande_signature : une par envoi, l'historique des renvois est conservé
-- ============================================================
CREATE TABLE IF NOT EXISTS demande_signature (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    contrat_id      UUID         NOT NULL,
    token_hash      CHAR(64)     NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),  -- jamais le token en clair
    expire_le       TIMESTAMPTZ  NOT NULL DEFAULT NOW() + INTERVAL '14 days',
    otp_hash        CHAR(64)     CHECK (otp_hash ~ '^[0-9a-f]{64}$'),
    otp_expire_le   TIMESTAMPTZ,
    otp_tentatives  INT          NOT NULL DEFAULT 0 CHECK (otp_tentatives >= 0),
    statut          VARCHAR(20)  NOT NULL DEFAULT 'ouverte'
                                 CHECK (statut IN ('ouverte', 'terminee', 'revoquee', 'expiree')),
    signature_png   BYTEA,
    mention         VARCHAR(255),
    ip              VARCHAR(45),
    user_agent      TEXT,
    preuve_id       VARCHAR(32)  UNIQUE,
    date_creation   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    date_fin        TIMESTAMPTZ,

    CONSTRAINT chk_demande_signature_terminee
        CHECK (statut <> 'terminee'
               OR (signature_png IS NOT NULL AND preuve_id IS NOT NULL AND date_fin IS NOT NULL)),

    CONSTRAINT fk_demande_signature_contrat
        FOREIGN KEY (contrat_id) REFERENCES contrat (id)
        ON DELETE RESTRICT ON UPDATE CASCADE
);

-- ============================================================
-- 5. contrat_evenement : journal de preuve append-only
-- ============================================================
CREATE TABLE IF NOT EXISTS contrat_evenement (
    id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    contrat_id  UUID         NOT NULL,
    horodatage  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    type        VARCHAR(50)  NOT NULL,
    acteur      VARCHAR(255) NOT NULL,   -- email de l'utilisateur, ou 'systeme'
    ip          VARCHAR(45),
    user_agent  TEXT,
    meta        JSONB        NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT fk_contrat_evenement_contrat
        FOREIGN KEY (contrat_id) REFERENCES contrat (id)
        ON DELETE RESTRICT ON UPDATE CASCADE
);

-- ============================================================
-- 6. facture : factures et avoirs, immuables une fois émis
-- ============================================================
CREATE TABLE IF NOT EXISTS facture (
    id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    numero              VARCHAR(20)  NOT NULL UNIQUE,
    type                VARCHAR(10)  NOT NULL DEFAULT 'facture' CHECK (type IN ('facture', 'avoir')),
    facture_origine_id  UUID,
    contrat_id          UUID         NOT NULL,
    ecole_id            UUID,
    groupe_scolaire_id  UUID,
    periode_debut       DATE         NOT NULL,
    periode_fin         DATE         NOT NULL,
    date_emission       DATE         NOT NULL,
    date_echeance       DATE         NOT NULL,
    date_paiement       DATE,
    lignes              JSONB        NOT NULL,
    total_ht_centimes   INT          NOT NULL,
    total_tva_centimes  INT          NOT NULL,
    total_ttc_centimes  INT          NOT NULL,
    ventilation_tva     JSONB        NOT NULL,
    client_snapshot     JSONB        NOT NULL,
    emetteur_snapshot   JSONB        NOT NULL,
    document_id         UUID         NOT NULL,
    sha256              CHAR(64)     NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    statut              VARCHAR(20)  NOT NULL DEFAULT 'emise'
                                     CHECK (statut IN ('emise', 'payee', 'annulee_par_avoir')),
    date_creation       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_facture_rattachement
        CHECK (num_nonnulls(ecole_id, groupe_scolaire_id) = 1),

    -- Le préfixe suit le type, et seul un avoir référence une facture d'origine
    CONSTRAINT chk_facture_numero
        CHECK ((type = 'facture' AND numero ~ '^FAC-[0-9]{4}-[0-9]{4,}$' AND facture_origine_id IS NULL)
            OR (type = 'avoir'   AND numero ~ '^AV-[0-9]{4}-[0-9]{4,}$'  AND facture_origine_id IS NOT NULL)),

    CONSTRAINT chk_facture_totaux
        CHECK (total_ttc_centimes = total_ht_centimes + total_tva_centimes),

    CONSTRAINT chk_facture_dates
        CHECK (periode_fin >= periode_debut AND date_echeance >= date_emission),

    CONSTRAINT chk_facture_paiement
        CHECK ((statut = 'payee') = (date_paiement IS NOT NULL) OR statut = 'annulee_par_avoir'),

    CONSTRAINT fk_facture_origine
        FOREIGN KEY (facture_origine_id) REFERENCES facture (id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_facture_contrat
        FOREIGN KEY (contrat_id) REFERENCES contrat (id)
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_facture_ecole
        FOREIGN KEY (ecole_id) REFERENCES ecole (id)
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_facture_groupe
        FOREIGN KEY (groupe_scolaire_id) REFERENCES groupe_scolaire (id)
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_facture_document
        FOREIGN KEY (document_id) REFERENCES document (id)
        ON DELETE RESTRICT
);

-- ============================================================
-- 7. Quantité estimée saisie à l'inscription (confirmée par l'admin à la validation)
-- ============================================================
ALTER TABLE demande_inscription
    ADD COLUMN IF NOT EXISTS nb_licences_estime INT CHECK (nb_licences_estime > 0);

-- ============================================================
-- 7 bis. Date d'effet du contrat : max(date_debut, date de signature), fixée à la signature.
-- date_debut reste celle du document signé (figé) ; facturation et licences partent de date_effet.
-- ============================================================
ALTER TABLE contrat ADD COLUMN IF NOT EXISTS date_effet DATE;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_contrat_date_effet') THEN
        ALTER TABLE contrat ADD CONSTRAINT chk_contrat_date_effet
            CHECK ((statut <> 'signe' OR date_effet IS NOT NULL)
                   AND (date_effet IS NULL OR date_effet >= date_debut));
    END IF;
END $$;

-- ============================================================
-- 8. Garde-fous en base : immuabilité, append-only
-- Fonctions : CREATE OR REPLACE. Triggers : créés seulement s'ils n'existent pas
-- (bloc DO plutôt que CREATE OR REPLACE TRIGGER, réservé à PostgreSQL 14+).
-- ============================================================

-- Un document stocké ne change jamais (son sha256 est référencé par les preuves)
CREATE OR REPLACE FUNCTION cubi_document_immuable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'document % : un document stocké est immuable', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_document_immuable' AND tgrelid = 'document'::regclass) THEN
        CREATE TRIGGER trg_document_immuable
            BEFORE UPDATE ON document
            FOR EACH ROW EXECUTE FUNCTION cubi_document_immuable();
    END IF;
END $$;

-- Journal de preuve : ni modification ni suppression
CREATE OR REPLACE FUNCTION cubi_contrat_evenement_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'contrat_evenement est append-only (% interdit)', TG_OP
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_contrat_evenement_append_only' AND tgrelid = 'contrat_evenement'::regclass) THEN
        CREATE TRIGGER trg_contrat_evenement_append_only
            BEFORE UPDATE OR DELETE ON contrat_evenement
            FOR EACH ROW EXECUTE FUNCTION cubi_contrat_evenement_append_only();
    END IF;
END $$;

-- Facture émise : seuls statut et date_paiement évoluent, jamais de suppression
CREATE OR REPLACE FUNCTION cubi_facture_immuable() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'facture % : suppression interdite, émettre un avoir', OLD.numero
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF (to_jsonb(NEW) - 'statut' - 'date_paiement') IS DISTINCT FROM (to_jsonb(OLD) - 'statut' - 'date_paiement') THEN
        RAISE EXCEPTION 'facture % : une facture émise est immuable, émettre un avoir', OLD.numero
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.statut = 'annulee_par_avoir' AND NEW.statut <> 'annulee_par_avoir' THEN
        RAISE EXCEPTION 'facture % : déjà annulée par avoir', OLD.numero
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_facture_immuable' AND tgrelid = 'facture'::regclass) THEN
        CREATE TRIGGER trg_facture_immuable
            BEFORE UPDATE OR DELETE ON facture
            FOR EACH ROW EXECUTE FUNCTION cubi_facture_immuable();
    END IF;
END $$;

-- ============================================================
-- 9. Index (FK + statuts)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_contrat_ecole            ON contrat (ecole_id);
CREATE INDEX IF NOT EXISTS idx_contrat_groupe           ON contrat (groupe_scolaire_id);
CREATE INDEX IF NOT EXISTS idx_contrat_demande          ON contrat (demande_inscription_id);
CREATE INDEX IF NOT EXISTS idx_contrat_doc_original     ON contrat (document_original_id);
CREATE INDEX IF NOT EXISTS idx_contrat_doc_signe        ON contrat (document_signe_id);
CREATE INDEX IF NOT EXISTS idx_contrat_cree_par         ON contrat (cree_par);
CREATE INDEX IF NOT EXISTS idx_contrat_statut           ON contrat (statut);

CREATE INDEX IF NOT EXISTS idx_demande_signature_contrat ON demande_signature (contrat_id);
-- Une seule demande de signature ouverte à la fois par contrat
CREATE UNIQUE INDEX IF NOT EXISTS uq_demande_signature_ouverte
    ON demande_signature (contrat_id) WHERE statut = 'ouverte';

CREATE INDEX IF NOT EXISTS idx_contrat_evenement_contrat ON contrat_evenement (contrat_id, horodatage);

CREATE INDEX IF NOT EXISTS idx_facture_origine          ON facture (facture_origine_id);
CREATE INDEX IF NOT EXISTS idx_facture_contrat          ON facture (contrat_id);
CREATE INDEX IF NOT EXISTS idx_facture_ecole            ON facture (ecole_id);
CREATE INDEX IF NOT EXISTS idx_facture_groupe           ON facture (groupe_scolaire_id);
CREATE INDEX IF NOT EXISTS idx_facture_document         ON facture (document_id);
CREATE INDEX IF NOT EXISTS idx_facture_statut           ON facture (statut);
-- Une seule facture active par contrat et par période (re-facturation possible après avoir)
CREATE UNIQUE INDEX IF NOT EXISTS uq_facture_contrat_periode
    ON facture (contrat_id, periode_debut) WHERE type = 'facture' AND statut <> 'annulee_par_avoir';

-- ── Migration 004, 2e passage : doit être sans effet ni erreur (idempotence) ─
-- Contrats, signature électronique simple (eIDAS art. 25) et factures.
-- Migration additive et idempotente : rejouable sans erreur, ne modifie aucune colonne existante.
-- Montants toujours en centimes (INTEGER). Une facture émise est immuable : toute correction passe par un avoir.

-- ============================================================
-- 1. document : fichiers binaires (PDF), lus uniquement via src/services/documentStorage.js
-- ============================================================
CREATE TABLE IF NOT EXISTS document (
    id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    type           VARCHAR(20)  NOT NULL CHECK (type IN ('contrat_original', 'contrat_signe', 'facture', 'avoir')),
    mime           VARCHAR(100) NOT NULL DEFAULT 'application/pdf',
    taille_octets  INT          NOT NULL CHECK (taille_octets >= 0),
    sha256         CHAR(64)     NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    contenu        BYTEA        NOT NULL,
    date_creation  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 2. sequence_document : numérotation sans trou ni doublon (CTR, FAC, AV) par année
-- ============================================================
CREATE TABLE IF NOT EXISTS sequence_document (
    annee            SMALLINT    NOT NULL,
    type             VARCHAR(3)  NOT NULL CHECK (type IN ('CTR', 'FAC', 'AV')),
    derniere_valeur  INT         NOT NULL DEFAULT 0 CHECK (derniere_valeur >= 0),
    PRIMARY KEY (annee, type)
);

-- ============================================================
-- 3. contrat : un par école indépendante ou par groupe scolaire
-- ============================================================
CREATE TABLE IF NOT EXISTS contrat (
    id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    numero                  VARCHAR(20)  NOT NULL UNIQUE CHECK (numero ~ '^CTR-[0-9]{4}-[0-9]{4,}$'),
    ecole_id                UUID,
    groupe_scolaire_id      UUID,
    demande_inscription_id  UUID,
    donnees                 JSONB        NOT NULL,   -- offre, lignes par établissement, quantités, prix en centimes : figés
    duree_mois              INT          NOT NULL CHECK (duree_mois > 0),
    date_debut              DATE         NOT NULL,
    statut                  VARCHAR(20)  NOT NULL DEFAULT 'brouillon'
                                         CHECK (statut IN ('brouillon', 'envoye', 'signe', 'annule', 'expire')),
    signataire_nom          VARCHAR(200),
    signataire_fonction     VARCHAR(150),
    signataire_email        VARCHAR(255),
    document_original_id    UUID,
    sha256_original         CHAR(64)     CHECK (sha256_original ~ '^[0-9a-f]{64}$'),
    document_signe_id       UUID,
    sha256_signe            CHAR(64)     CHECK (sha256_signe ~ '^[0-9a-f]{64}$'),
    date_signature_cubi     TIMESTAMPTZ,
    date_signature_client   TIMESTAMPTZ,
    cree_par                UUID,
    date_creation           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    date_modification       TIMESTAMPTZ,

    -- Exactement un rattachement : école indépendante OU groupe
    CONSTRAINT chk_contrat_rattachement
        CHECK (num_nonnulls(ecole_id, groupe_scolaire_id) = 1),

    -- Pas d'envoi sans signataire ni original figé
    CONSTRAINT chk_contrat_envoi
        CHECK (statut IN ('brouillon', 'annule')
               OR (signataire_nom IS NOT NULL AND signataire_email IS NOT NULL
                   AND document_original_id IS NOT NULL AND sha256_original IS NOT NULL)),

    -- Un contrat signé a forcément sa version signée et sa date de signature
    CONSTRAINT chk_contrat_signe
        CHECK (statut <> 'signe'
               OR (document_signe_id IS NOT NULL AND sha256_signe IS NOT NULL
                   AND date_signature_client IS NOT NULL)),

    -- RESTRICT : un contrat est une pièce à conserver, il bloque la suppression de l'organisation
    CONSTRAINT fk_contrat_ecole
        FOREIGN KEY (ecole_id) REFERENCES ecole (id)
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_contrat_groupe
        FOREIGN KEY (groupe_scolaire_id) REFERENCES groupe_scolaire (id)
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_contrat_demande
        FOREIGN KEY (demande_inscription_id) REFERENCES demande_inscription (id)
        ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT fk_contrat_document_original
        FOREIGN KEY (document_original_id) REFERENCES document (id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_contrat_document_signe
        FOREIGN KEY (document_signe_id) REFERENCES document (id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_contrat_cree_par
        FOREIGN KEY (cree_par) REFERENCES utilisateur_cubi (id)
        ON DELETE SET NULL ON UPDATE CASCADE
);

-- ============================================================
-- 4. demande_signature : une par envoi, l'historique des renvois est conservé
-- ============================================================
CREATE TABLE IF NOT EXISTS demande_signature (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    contrat_id      UUID         NOT NULL,
    token_hash      CHAR(64)     NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),  -- jamais le token en clair
    expire_le       TIMESTAMPTZ  NOT NULL DEFAULT NOW() + INTERVAL '14 days',
    otp_hash        CHAR(64)     CHECK (otp_hash ~ '^[0-9a-f]{64}$'),
    otp_expire_le   TIMESTAMPTZ,
    otp_tentatives  INT          NOT NULL DEFAULT 0 CHECK (otp_tentatives >= 0),
    statut          VARCHAR(20)  NOT NULL DEFAULT 'ouverte'
                                 CHECK (statut IN ('ouverte', 'terminee', 'revoquee', 'expiree')),
    signature_png   BYTEA,
    mention         VARCHAR(255),
    ip              VARCHAR(45),
    user_agent      TEXT,
    preuve_id       VARCHAR(32)  UNIQUE,
    date_creation   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    date_fin        TIMESTAMPTZ,

    CONSTRAINT chk_demande_signature_terminee
        CHECK (statut <> 'terminee'
               OR (signature_png IS NOT NULL AND preuve_id IS NOT NULL AND date_fin IS NOT NULL)),

    CONSTRAINT fk_demande_signature_contrat
        FOREIGN KEY (contrat_id) REFERENCES contrat (id)
        ON DELETE RESTRICT ON UPDATE CASCADE
);

-- ============================================================
-- 5. contrat_evenement : journal de preuve append-only
-- ============================================================
CREATE TABLE IF NOT EXISTS contrat_evenement (
    id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    contrat_id  UUID         NOT NULL,
    horodatage  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    type        VARCHAR(50)  NOT NULL,
    acteur      VARCHAR(255) NOT NULL,   -- email de l'utilisateur, ou 'systeme'
    ip          VARCHAR(45),
    user_agent  TEXT,
    meta        JSONB        NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT fk_contrat_evenement_contrat
        FOREIGN KEY (contrat_id) REFERENCES contrat (id)
        ON DELETE RESTRICT ON UPDATE CASCADE
);

-- ============================================================
-- 6. facture : factures et avoirs, immuables une fois émis
-- ============================================================
CREATE TABLE IF NOT EXISTS facture (
    id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    numero              VARCHAR(20)  NOT NULL UNIQUE,
    type                VARCHAR(10)  NOT NULL DEFAULT 'facture' CHECK (type IN ('facture', 'avoir')),
    facture_origine_id  UUID,
    contrat_id          UUID         NOT NULL,
    ecole_id            UUID,
    groupe_scolaire_id  UUID,
    periode_debut       DATE         NOT NULL,
    periode_fin         DATE         NOT NULL,
    date_emission       DATE         NOT NULL,
    date_echeance       DATE         NOT NULL,
    date_paiement       DATE,
    lignes              JSONB        NOT NULL,
    total_ht_centimes   INT          NOT NULL,
    total_tva_centimes  INT          NOT NULL,
    total_ttc_centimes  INT          NOT NULL,
    ventilation_tva     JSONB        NOT NULL,
    client_snapshot     JSONB        NOT NULL,
    emetteur_snapshot   JSONB        NOT NULL,
    document_id         UUID         NOT NULL,
    sha256              CHAR(64)     NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    statut              VARCHAR(20)  NOT NULL DEFAULT 'emise'
                                     CHECK (statut IN ('emise', 'payee', 'annulee_par_avoir')),
    date_creation       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_facture_rattachement
        CHECK (num_nonnulls(ecole_id, groupe_scolaire_id) = 1),

    -- Le préfixe suit le type, et seul un avoir référence une facture d'origine
    CONSTRAINT chk_facture_numero
        CHECK ((type = 'facture' AND numero ~ '^FAC-[0-9]{4}-[0-9]{4,}$' AND facture_origine_id IS NULL)
            OR (type = 'avoir'   AND numero ~ '^AV-[0-9]{4}-[0-9]{4,}$'  AND facture_origine_id IS NOT NULL)),

    CONSTRAINT chk_facture_totaux
        CHECK (total_ttc_centimes = total_ht_centimes + total_tva_centimes),

    CONSTRAINT chk_facture_dates
        CHECK (periode_fin >= periode_debut AND date_echeance >= date_emission),

    CONSTRAINT chk_facture_paiement
        CHECK ((statut = 'payee') = (date_paiement IS NOT NULL) OR statut = 'annulee_par_avoir'),

    CONSTRAINT fk_facture_origine
        FOREIGN KEY (facture_origine_id) REFERENCES facture (id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_facture_contrat
        FOREIGN KEY (contrat_id) REFERENCES contrat (id)
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_facture_ecole
        FOREIGN KEY (ecole_id) REFERENCES ecole (id)
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_facture_groupe
        FOREIGN KEY (groupe_scolaire_id) REFERENCES groupe_scolaire (id)
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_facture_document
        FOREIGN KEY (document_id) REFERENCES document (id)
        ON DELETE RESTRICT
);

-- ============================================================
-- 7. Quantité estimée saisie à l'inscription (confirmée par l'admin à la validation)
-- ============================================================
ALTER TABLE demande_inscription
    ADD COLUMN IF NOT EXISTS nb_licences_estime INT CHECK (nb_licences_estime > 0);

-- ============================================================
-- 7 bis. Date d'effet du contrat : max(date_debut, date de signature), fixée à la signature.
-- date_debut reste celle du document signé (figé) ; facturation et licences partent de date_effet.
-- ============================================================
ALTER TABLE contrat ADD COLUMN IF NOT EXISTS date_effet DATE;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_contrat_date_effet') THEN
        ALTER TABLE contrat ADD CONSTRAINT chk_contrat_date_effet
            CHECK ((statut <> 'signe' OR date_effet IS NOT NULL)
                   AND (date_effet IS NULL OR date_effet >= date_debut));
    END IF;
END $$;

-- ============================================================
-- 8. Garde-fous en base : immuabilité, append-only
-- Fonctions : CREATE OR REPLACE. Triggers : créés seulement s'ils n'existent pas
-- (bloc DO plutôt que CREATE OR REPLACE TRIGGER, réservé à PostgreSQL 14+).
-- ============================================================

-- Un document stocké ne change jamais (son sha256 est référencé par les preuves)
CREATE OR REPLACE FUNCTION cubi_document_immuable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'document % : un document stocké est immuable', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_document_immuable' AND tgrelid = 'document'::regclass) THEN
        CREATE TRIGGER trg_document_immuable
            BEFORE UPDATE ON document
            FOR EACH ROW EXECUTE FUNCTION cubi_document_immuable();
    END IF;
END $$;

-- Journal de preuve : ni modification ni suppression
CREATE OR REPLACE FUNCTION cubi_contrat_evenement_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'contrat_evenement est append-only (% interdit)', TG_OP
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_contrat_evenement_append_only' AND tgrelid = 'contrat_evenement'::regclass) THEN
        CREATE TRIGGER trg_contrat_evenement_append_only
            BEFORE UPDATE OR DELETE ON contrat_evenement
            FOR EACH ROW EXECUTE FUNCTION cubi_contrat_evenement_append_only();
    END IF;
END $$;

-- Facture émise : seuls statut et date_paiement évoluent, jamais de suppression
CREATE OR REPLACE FUNCTION cubi_facture_immuable() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'facture % : suppression interdite, émettre un avoir', OLD.numero
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF (to_jsonb(NEW) - 'statut' - 'date_paiement') IS DISTINCT FROM (to_jsonb(OLD) - 'statut' - 'date_paiement') THEN
        RAISE EXCEPTION 'facture % : une facture émise est immuable, émettre un avoir', OLD.numero
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.statut = 'annulee_par_avoir' AND NEW.statut <> 'annulee_par_avoir' THEN
        RAISE EXCEPTION 'facture % : déjà annulée par avoir', OLD.numero
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_facture_immuable' AND tgrelid = 'facture'::regclass) THEN
        CREATE TRIGGER trg_facture_immuable
            BEFORE UPDATE OR DELETE ON facture
            FOR EACH ROW EXECUTE FUNCTION cubi_facture_immuable();
    END IF;
END $$;

-- ============================================================
-- 9. Index (FK + statuts)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_contrat_ecole            ON contrat (ecole_id);
CREATE INDEX IF NOT EXISTS idx_contrat_groupe           ON contrat (groupe_scolaire_id);
CREATE INDEX IF NOT EXISTS idx_contrat_demande          ON contrat (demande_inscription_id);
CREATE INDEX IF NOT EXISTS idx_contrat_doc_original     ON contrat (document_original_id);
CREATE INDEX IF NOT EXISTS idx_contrat_doc_signe        ON contrat (document_signe_id);
CREATE INDEX IF NOT EXISTS idx_contrat_cree_par         ON contrat (cree_par);
CREATE INDEX IF NOT EXISTS idx_contrat_statut           ON contrat (statut);

CREATE INDEX IF NOT EXISTS idx_demande_signature_contrat ON demande_signature (contrat_id);
-- Une seule demande de signature ouverte à la fois par contrat
CREATE UNIQUE INDEX IF NOT EXISTS uq_demande_signature_ouverte
    ON demande_signature (contrat_id) WHERE statut = 'ouverte';

CREATE INDEX IF NOT EXISTS idx_contrat_evenement_contrat ON contrat_evenement (contrat_id, horodatage);

CREATE INDEX IF NOT EXISTS idx_facture_origine          ON facture (facture_origine_id);
CREATE INDEX IF NOT EXISTS idx_facture_contrat          ON facture (contrat_id);
CREATE INDEX IF NOT EXISTS idx_facture_ecole            ON facture (ecole_id);
CREATE INDEX IF NOT EXISTS idx_facture_groupe           ON facture (groupe_scolaire_id);
CREATE INDEX IF NOT EXISTS idx_facture_document         ON facture (document_id);
CREATE INDEX IF NOT EXISTS idx_facture_statut           ON facture (statut);
-- Une seule facture active par contrat et par période (re-facturation possible après avoir)
CREATE UNIQUE INDEX IF NOT EXISTS uq_facture_contrat_periode
    ON facture (contrat_id, periode_debut) WHERE type = 'facture' AND statut <> 'annulee_par_avoir';

DO $verif$
DECLARE
    v_tl       uuid;
    v_ecole    uuid;
    v_doc_orig uuid;
    v_doc_sign uuid;
    v_doc_fac  uuid;
    v_contrat  uuid;
    v_demande  uuid;
    v_evt      uuid;
    v_fac      uuid;
    v_avoir    uuid;
    v_siret    text := lpad((floor(random() * 1e14))::bigint::text, 14, '0');
BEGIN
    SELECT id INTO v_tl FROM type_licence ORDER BY sessions_min LIMIT 1;
    IF v_tl IS NULL THEN RAISE EXCEPTION 'KO : aucun type_licence'; END IF;

    INSERT INTO ecole (nom_complet_ecole, siret, adresse, code_postal, ville, type_licence_id, mot_de_passe_hash, statut)
    VALUES ('École vérification 004', v_siret, '1 rue Test', '75001', 'Paris', v_tl, 'x', 'inactif')
    RETURNING id INTO v_ecole;

    INSERT INTO document (type, taille_octets, sha256, contenu)
    VALUES ('contrat_original', 3, repeat('a', 64), '\x414243'::bytea) RETURNING id INTO v_doc_orig;
    INSERT INTO document (type, taille_octets, sha256, contenu)
    VALUES ('contrat_signe', 3, repeat('b', 64), '\x414243'::bytea) RETURNING id INTO v_doc_sign;

    -- Contrat : brouillon -> envoyé -> signé
    INSERT INTO contrat (numero, ecole_id, donnees, duree_mois, date_debut, signataire_nom, signataire_email)
    VALUES ('CTR-2099-9999', v_ecole, '{"client": {}}', 12, DATE '2099-01-10', 'Signataire Test', 'signataire@test.fr')
    RETURNING id INTO v_contrat;

    BEGIN
        UPDATE contrat SET statut = 'envoye' WHERE id = v_contrat;
        RAISE EXCEPTION 'KO : contrat envoyé sans PDF original';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO contrat (numero, ecole_id, groupe_scolaire_id, donnees, duree_mois, date_debut)
        SELECT 'CTR-2099-9998', v_ecole, id, '{}', 12, DATE '2099-01-10' FROM groupe_scolaire LIMIT 1;
        IF FOUND THEN RAISE EXCEPTION 'KO : contrat rattaché à une école ET un groupe'; END IF;
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    UPDATE contrat SET statut = 'envoye', document_original_id = v_doc_orig, sha256_original = repeat('a', 64)
    WHERE id = v_contrat;

    -- Demande de signature : une seule ouverte par contrat, terminée = signature + preuve
    INSERT INTO demande_signature (contrat_id, token_hash) VALUES (v_contrat, repeat('c', 64)) RETURNING id INTO v_demande;
    BEGIN
        INSERT INTO demande_signature (contrat_id, token_hash) VALUES (v_contrat, repeat('d', 64));
        RAISE EXCEPTION 'KO : deux demandes de signature ouvertes';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
        UPDATE demande_signature SET statut = 'terminee' WHERE id = v_demande;
        RAISE EXCEPTION 'KO : demande terminée sans signature';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    UPDATE demande_signature
    SET statut = 'terminee', signature_png = '\x89504e47'::bytea, preuve_id = 'SIG-0000-0000-0001',
        date_fin = clock_timestamp(), mention = 'Lu et approuvé', ip = '127.0.0.1', otp_hash = NULL
    WHERE id = v_demande;

    BEGIN
        UPDATE contrat SET statut = 'signe', document_signe_id = v_doc_sign, sha256_signe = repeat('b', 64),
               date_signature_client = clock_timestamp()
        WHERE id = v_contrat;
        RAISE EXCEPTION 'KO : contrat signé sans date d''effet';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        UPDATE contrat SET statut = 'signe', document_signe_id = v_doc_sign, sha256_signe = repeat('b', 64),
               date_signature_client = clock_timestamp(), date_effet = DATE '2099-01-01'
        WHERE id = v_contrat;
        RAISE EXCEPTION 'KO : date d''effet antérieure à date_debut';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    -- Même expression que src/services/signature.js
    UPDATE contrat SET statut = 'signe', document_signe_id = v_doc_sign, sha256_signe = repeat('b', 64),
           date_signature_client = clock_timestamp(),
           date_effet = GREATEST(date_debut, (clock_timestamp() AT TIME ZONE 'Europe/Paris')::date)
    WHERE id = v_contrat;

    -- Journal de preuve append-only, document immuable
    INSERT INTO contrat_evenement (contrat_id, horodatage, type, acteur, meta)
    VALUES (v_contrat, clock_timestamp(), 'signe', 'signataire@test.fr', '{"preuveId": "SIG-0000-0000-0001"}')
    RETURNING id INTO v_evt;
    BEGIN
        UPDATE contrat_evenement SET acteur = 'pirate' WHERE id = v_evt;
        RAISE EXCEPTION 'KO : journal modifiable';
    EXCEPTION WHEN integrity_constraint_violation THEN NULL;
    END;
    BEGIN
        DELETE FROM contrat_evenement WHERE id = v_evt;
        RAISE EXCEPTION 'KO : journal supprimable';
    EXCEPTION WHEN integrity_constraint_violation THEN NULL;
    END;
    BEGIN
        UPDATE document SET mime = 'text/plain' WHERE id = v_doc_orig;
        RAISE EXCEPTION 'KO : document modifiable';
    EXCEPTION WHEN integrity_constraint_violation THEN NULL;
    END;

    -- Facture : immuable, une seule active par période, payée = date de paiement, avoir
    INSERT INTO document (type, taille_octets, sha256, contenu)
    VALUES ('facture', 3, repeat('e', 64), '\x414243'::bytea) RETURNING id INTO v_doc_fac;
    INSERT INTO facture (numero, contrat_id, ecole_id, periode_debut, periode_fin, date_emission, date_echeance,
                         lignes, total_ht_centimes, total_tva_centimes, total_ttc_centimes, ventilation_tva,
                         client_snapshot, emetteur_snapshot, document_id, sha256)
    VALUES ('FAC-2099-9999', v_contrat, v_ecole, DATE '2099-01-10', DATE '2099-01-31', DATE '2099-01-10', DATE '2099-02-09',
            '[]', 1000, 200, 1200, '[{"rate": 20, "amountCents": 200}]', '{}', '{}', v_doc_fac, repeat('e', 64))
    RETURNING id INTO v_fac;

    BEGIN
        INSERT INTO facture (numero, contrat_id, ecole_id, periode_debut, periode_fin, date_emission, date_echeance,
                             lignes, total_ht_centimes, total_tva_centimes, total_ttc_centimes, ventilation_tva,
                             client_snapshot, emetteur_snapshot, document_id, sha256)
        VALUES ('FAC-2099-9998', v_contrat, v_ecole, DATE '2099-01-10', DATE '2099-01-31', DATE '2099-01-10', DATE '2099-02-09',
                '[]', 1000, 200, 1200, '[]', '{}', '{}', v_doc_fac, repeat('e', 64));
        RAISE EXCEPTION 'KO : deux factures actives pour la même période';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO facture (numero, contrat_id, ecole_id, periode_debut, periode_fin, date_emission, date_echeance,
                             lignes, total_ht_centimes, total_tva_centimes, total_ttc_centimes, ventilation_tva,
                             client_snapshot, emetteur_snapshot, document_id, sha256)
        VALUES ('FAC-2099-9997', v_contrat, v_ecole, DATE '2099-02-01', DATE '2099-02-28', DATE '2099-02-01', DATE '2099-03-03',
                '[]', 1000, 200, 1300, '[]', '{}', '{}', v_doc_fac, repeat('e', 64));
        RAISE EXCEPTION 'KO : TTC <> HT + TVA accepté';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        UPDATE facture SET total_ht_centimes = 1, total_ttc_centimes = 201 WHERE id = v_fac;
        RAISE EXCEPTION 'KO : montant d''une facture émise modifiable';
    EXCEPTION WHEN integrity_constraint_violation THEN NULL;
    END;
    BEGIN
        UPDATE facture SET statut = 'payee' WHERE id = v_fac;
        RAISE EXCEPTION 'KO : facture payée sans date de paiement';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    UPDATE facture SET statut = 'payee', date_paiement = DATE '2099-01-15' WHERE id = v_fac;

    INSERT INTO facture (numero, type, facture_origine_id, contrat_id, ecole_id, periode_debut, periode_fin,
                         date_emission, date_echeance, lignes, total_ht_centimes, total_tva_centimes, total_ttc_centimes,
                         ventilation_tva, client_snapshot, emetteur_snapshot, document_id, sha256)
    VALUES ('AV-2099-9999', 'avoir', v_fac, v_contrat, v_ecole, DATE '2099-01-10', DATE '2099-01-31',
            DATE '2099-01-20', DATE '2099-01-20', '[]', -1000, -200, -1200, '[]', '{}', '{}', v_doc_fac, repeat('e', 64))
    RETURNING id INTO v_avoir;
    UPDATE facture SET statut = 'annulee_par_avoir' WHERE id = v_fac;
    BEGIN
        UPDATE facture SET statut = 'emise', date_paiement = NULL WHERE id = v_fac;
        RAISE EXCEPTION 'KO : facture annulée par avoir réactivée';
    EXCEPTION WHEN integrity_constraint_violation THEN NULL;
    END;
    -- La période annulée par avoir peut être refacturée (émission manuelle)
    INSERT INTO facture (numero, contrat_id, ecole_id, periode_debut, periode_fin, date_emission, date_echeance,
                         lignes, total_ht_centimes, total_tva_centimes, total_ttc_centimes, ventilation_tva,
                         client_snapshot, emetteur_snapshot, document_id, sha256)
    VALUES ('FAC-2099-9996', v_contrat, v_ecole, DATE '2099-01-10', DATE '2099-01-31', DATE '2099-01-21', DATE '2099-02-20',
            '[]', 1000, 200, 1200, '[]', '{}', '{}', v_doc_fac, repeat('e', 64));
    BEGIN
        DELETE FROM facture WHERE id = v_avoir;
        RAISE EXCEPTION 'KO : avoir supprimable';
    EXCEPTION WHEN integrity_constraint_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO facture (numero, type, contrat_id, ecole_id, periode_debut, periode_fin, date_emission, date_echeance,
                             lignes, total_ht_centimes, total_tva_centimes, total_ttc_centimes, ventilation_tva,
                             client_snapshot, emetteur_snapshot, document_id, sha256)
        VALUES ('AV-2099-9998', 'avoir', v_contrat, v_ecole, DATE '2099-01-10', DATE '2099-01-31', DATE '2099-01-20',
                DATE '2099-01-20', '[]', -1, 0, -1, '[]', '{}', '{}', v_doc_fac, repeat('e', 64));
        RAISE EXCEPTION 'KO : avoir sans facture d''origine';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    -- Numérotation (même séquence d'instructions que src/services/numerotation.js)
    INSERT INTO sequence_document (annee, type) VALUES (2099, 'FAC') ON CONFLICT DO NOTHING;
    PERFORM derniere_valeur FROM sequence_document WHERE annee = 2099 AND type = 'FAC' FOR UPDATE;
    UPDATE sequence_document SET derniere_valeur = derniere_valeur + 1 WHERE annee = 2099 AND type = 'FAC';

    -- Colonne ajoutée à demande_inscription
    PERFORM nb_licences_estime FROM demande_inscription LIMIT 1;

    RAISE NOTICE 'Migration 004 : toutes les vérifications passent';
END
$verif$;


-- Récapitulatif des nouvelles tables et colonnes (visible dans le résultat de l'éditeur)
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (table_name IN ('document', 'sequence_document', 'contrat', 'demande_signature', 'contrat_evenement', 'facture')
       OR (table_name = 'demande_inscription' AND column_name = 'nb_licences_estime'))
ORDER BY table_name, ordinal_position;

ROLLBACK;
