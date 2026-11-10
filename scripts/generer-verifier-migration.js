// npm run migration:verifier — (re)génère scripts/verifier-migration.sql à partir de la migration 004.
// Le fichier généré se colle dans le SQL Editor de Neon : il applique la 004 deux fois (idempotence),
// exerce chaque contrainte et trigger, puis annule tout (ROLLBACK). Rien n'est appliqué.
const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'migrations', '004_documents_signature.sql');
const SORTIE = path.join(__dirname, 'verifier-migration.sql');

// Bloc de vérification : chaque cas interdit doit lever l'erreur attendue, sinon 'KO : …' arrête tout
const VERIFICATIONS = `
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
    VALUES ('contrat_original', 3, repeat('a', 64), '\\x414243'::bytea) RETURNING id INTO v_doc_orig;
    INSERT INTO document (type, taille_octets, sha256, contenu)
    VALUES ('contrat_signe', 3, repeat('b', 64), '\\x414243'::bytea) RETURNING id INTO v_doc_sign;

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
    SET statut = 'terminee', signature_png = '\\x89504e47'::bytea, preuve_id = 'SIG-0000-0000-0001',
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
    VALUES ('facture', 3, repeat('e', 64), '\\x414243'::bytea) RETURNING id INTO v_doc_fac;
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
`;

const RECAPITULATIF = `
-- Récapitulatif des nouvelles tables et colonnes (visible dans le résultat de l'éditeur)
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (table_name IN ('document', 'sequence_document', 'contrat', 'demande_signature', 'contrat_evenement', 'facture')
       OR (table_name = 'demande_inscription' AND column_name = 'nb_licences_estime'))
ORDER BY table_name, ordinal_position;
`;

function generer() {
  const migration = fs.readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').trimEnd();
  return [
    '-- FICHIER GÉNÉRÉ par scripts/generer-verifier-migration.js (npm run migration:verifier) : ne pas modifier à la main.',
    '-- Test de fumée de la migration 004, à coller dans le SQL Editor de Neon (ou psql -f).',
    '-- Tout se passe dans une transaction annulée à la fin : rien n\'est appliqué.',
    '-- Succès : le NOTICE « toutes les vérifications passent » puis le récapitulatif des colonnes.',
    '-- Échec : une erreur « KO : … » ou une erreur SQL, et la transaction est annulée.',
    '',
    'BEGIN;',
    '',
    '-- ── Migration 004, 1er passage ──────────────────────────────────────────────',
    migration,
    '',
    '-- ── Migration 004, 2e passage : doit être sans effet ni erreur (idempotence) ─',
    migration,
    VERIFICATIONS,
    RECAPITULATIF,
    'ROLLBACK;',
    '',
  ].join('\n');
}

module.exports = { generer, SORTIE };

if (require.main === module) {
  fs.writeFileSync(SORTIE, generer());
  console.log(`${SORTIE} généré`);
}
