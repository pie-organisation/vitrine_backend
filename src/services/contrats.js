// Cycle de vie d'un contrat côté Cubi : brouillon -> envoye -> (signe | annule | expire).
// La signature elle-même est dans services/signature.js.

const pool = require('../db');
const documentStorage = require('./documentStorage');
const { avecTransaction, erreur } = require('./transaction');
const { prochainNumero } = require('./numerotation');
const { calculerPalier, prixEnCentimes } = require('./palier');
const { genererToken } = require('./signatureCrypto');
const { renderContratPdf } = require('../pdf/render');
const { getSignatureCubiDataUrl } = require('../pdf/emetteur');
const { emailSignerContrat } = require('../email');

const DUREE_MOIS_DEFAUT = 12;
const LIBELLE_FACTURATION = 'Mensuelle, à terme à échoir';

function aujourdhuiParis() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
}

// ── Journal de preuve (append-only) ───────────────────────────────────────────
// clock_timestamp() et non NOW() : plusieurs événements d'une même transaction restent ordonnés.

async function evenement(db, contratId, type, { acteur = 'systeme', ip = null, userAgent = null, meta = {} } = {}) {
  await db.query(
    `INSERT INTO contrat_evenement (contrat_id, horodatage, type, acteur, ip, user_agent, meta)
     VALUES ($1, clock_timestamp(), $2, $3, $4, $5, $6)`,
    [contratId, type, acteur, ip, userAgent, JSON.stringify(meta)]
  );
}

async function evenements(db, contratId) {
  const { rows } = await db.query(
    `SELECT id, horodatage, type, acteur, ip, user_agent, meta
     FROM contrat_evenement WHERE contrat_id = $1 ORDER BY horodatage, id`,
    [contratId]
  );
  return rows;
}

// Email du membre de l'équipe Cubi qui agit (acteur du journal)
async function acteurCubi(db, userId) {
  const { rows } = await db.query('SELECT email FROM utilisateur_cubi WHERE id = $1', [userId]);
  return rows[0]?.email || `cubi:${userId}`;
}

// ── Données figées du contrat ─────────────────────────────────────────────────

async function typesLicenceActifs(db) {
  const { rows } = await db.query('SELECT * FROM type_licence WHERE actif = TRUE ORDER BY sessions_min');
  return rows;
}

// etablissements : [{ ecoleId, nom, siret, quantite }] ; forme décrite dans src/pdf/mappers.js
function donneesContrat({ client, palier, etablissements }) {
  const prixUnitaireCentimes = prixEnCentimes(palier.prix_unitaire);
  return {
    client,
    offre: { nom: palier.nom, badge: palier.personnalisable ? 'Sur mesure' : null },
    palier: {
      typeLicenceId: palier.id,
      nom: palier.nom,
      sessionsMin: palier.sessions_min,
      sessionsMax: palier.sessions_max,
      prixUnitaireCentimes,
    },
    quantiteTotale: etablissements.reduce((s, e) => s + e.quantite, 0),
    facturation: { libelle: LIBELLE_FACTURATION },
    etablissements: etablissements.map(e => ({
      ecoleId: e.ecoleId, nom: e.nom, siret: e.siret, quantite: e.quantite, prixUnitaireCentimes,
    })),
  };
}

// Appelé dans la transaction de validation de la demande
async function creerContratBrouillon(db, { demande, ecoleId = null, groupeId = null, client, etablissements, palier, creePar, acteur }) {
  const donnees = donneesContrat({ client, palier, etablissements });
  const numero = await prochainNumero(db, 'contrat');
  const { rows } = await db.query(
    `INSERT INTO contrat
       (numero, ecole_id, groupe_scolaire_id, demande_inscription_id, donnees, duree_mois, date_debut,
        signataire_nom, signataire_email, cree_par)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      numero, ecoleId, groupeId, demande.id, JSON.stringify(donnees), DUREE_MOIS_DEFAUT, aujourdhuiParis(),
      // Signataire par défaut : le contact de la demande. La fonction est à compléter avant l'envoi.
      `${demande.prenom_contact || demande.prenom_daf || ''} ${demande.nom_contact || demande.nom_daf || ''}`.trim(),
      demande.email, creePar,
    ]
  );
  await evenement(db, rows[0].id, 'cree', {
    acteur, meta: { palier: palier.nom, quantiteTotale: donnees.quantiteTotale },
  });
  return rows[0];
}

async function verrouiller(db, contratId) {
  const { rows } = await db.query('SELECT * FROM contrat WHERE id = $1 FOR UPDATE', [contratId]);
  if (!rows.length) throw erreur(404, 'Contrat introuvable');
  return rows[0];
}

// ── Modification d'un brouillon ───────────────────────────────────────────────
// modifs : { signataire?: { nom, fonction, email }, quantites?: [{ ecoleId, quantite }], dateDebut?, dureeMois? }

async function modifierBrouillon(contratId, modifs, acteur) {
  return avecTransaction(async client => {
    const contrat = await verrouiller(client, contratId);
    if (contrat.statut !== 'brouillon') throw erreur(409, 'Seul un contrat en brouillon peut être modifié.');

    let { donnees } = contrat;
    const champs = [];

    if (modifs.quantites) {
      const parEcole = new Map(modifs.quantites.map(q => [q.ecoleId, q.quantite]));
      const ecoles = donnees.etablissements.map(e => e.ecoleId);
      if (parEcole.size !== ecoles.length || !ecoles.every(id => parEcole.has(id))) {
        throw erreur(422, 'Les quantités doivent couvrir exactement les établissements du contrat.');
      }
      const etablissements = donnees.etablissements.map(e => ({ ...e, quantite: parEcole.get(e.ecoleId) }));
      const total = etablissements.reduce((s, e) => s + e.quantite, 0);
      const palier = calculerPalier(await typesLicenceActifs(client), total);
      donnees = donneesContrat({ client: donnees.client, palier, etablissements });

      await client.query('UPDATE ecole SET type_licence_id = $1 WHERE id = ANY($2::uuid[])', [palier.id, ecoles]);
      if (contrat.groupe_scolaire_id) {
        await client.query(
          'UPDATE groupe_scolaire SET type_licence_id = $1, date_modification = NOW() WHERE id = $2',
          [palier.id, contrat.groupe_scolaire_id]
        );
      }
      champs.push('quantites');
    }
    // Adresse du client figée dans le contrat (le formulaire de groupe ne demande pas celle du siège)
    if (modifs.adresseClient) {
      donnees = { ...donnees, client: { ...donnees.client, address: modifs.adresseClient } };
      champs.push('adresseClient');
    }
    if (modifs.signataire) champs.push('signataire');
    if (modifs.dateDebut) champs.push('dateDebut');
    if (modifs.dureeMois) champs.push('dureeMois');

    const s = modifs.signataire || {};
    const { rows } = await client.query(
      `UPDATE contrat SET
         donnees             = $2,
         signataire_nom      = COALESCE($3, signataire_nom),
         signataire_fonction = COALESCE($4, signataire_fonction),
         signataire_email    = COALESCE($5, signataire_email),
         date_debut          = COALESCE($6, date_debut),
         duree_mois          = COALESCE($7, duree_mois),
         date_modification   = NOW()
       WHERE id = $1
       RETURNING *`,
      [contratId, JSON.stringify(donnees), s.nom ?? null, s.fonction ?? null, s.email ?? null,
        modifs.dateDebut ?? null, modifs.dureeMois ?? null]
    );
    await evenement(client, contratId, 'modifie', { acteur, meta: { champs } });
    return rows[0];
  });
}

// ── Envoi à la signature ──────────────────────────────────────────────────────

// Nouvelle demande de signature : seul le SHA-256 du token est stocké.
// expireLeDepuis : id d'une demande dont on reprend l'échéance (relance) ; sinon J+14.
async function creerDemandeSignature(db, contratId, { expireLeDepuis = null } = {}) {
  const { token, tokenHash } = genererToken();
  const { rows } = await db.query(
    `INSERT INTO demande_signature (contrat_id, token_hash, expire_le)
     VALUES ($1, $2, COALESCE((SELECT expire_le FROM demande_signature WHERE id = $3), NOW() + INTERVAL '14 days'))
     RETURNING id, expire_le`,
    [contratId, tokenHash, expireLeDepuis]
  );
  return { token, demandeId: rows[0].id, expireLe: rows[0].expire_le };
}

async function revoquerDemandesOuvertes(db, contratId) {
  await db.query(
    "UPDATE demande_signature SET statut = 'revoquee', date_fin = NOW() WHERE contrat_id = $1 AND statut = 'ouverte'",
    [contratId]
  );
}

function verifierAvantEnvoi(contrat) {
  if (!contrat.signataire_nom || !contrat.signataire_fonction || !contrat.signataire_email) {
    throw erreur(422, 'Renseigne le nom, la fonction et l\'e-mail du signataire avant l\'envoi.');
  }
  if (!contrat.donnees.client.address?.trim()) {
    throw erreur(422, 'Renseigne l\'adresse du client (adresseClient) avant l\'envoi.');
  }
}

// L'e-mail part avant le COMMIT : s'il échoue, rien n'est enregistré et l'admin peut réessayer.
async function envoyer(contratId, acteur) {
  return avecTransaction(async client => {
    const contrat = await verrouiller(client, contratId);
    if (contrat.statut !== 'brouillon') throw erreur(409, 'Ce contrat a déjà été envoyé.');
    verifierAvantEnvoi(contrat);

    // Contre-signature Cubi apposée à la génération si la signature PNG est configurée
    const dateSignatureCubi = getSignatureCubiDataUrl() ? new Date() : null;
    const pdf = await renderContratPdf({ ...contrat, date_signature_cubi: dateSignatureCubi });
    const doc = await documentStorage.put(client, { type: 'contrat_original', contenu: pdf });

    await client.query(
      `UPDATE contrat SET statut = 'envoye', document_original_id = $2, sha256_original = $3,
         date_signature_cubi = $4, date_modification = NOW()
       WHERE id = $1`,
      [contratId, doc.id, doc.sha256, dateSignatureCubi]
    );
    await evenement(client, contratId, 'genere', { acteur, meta: { sha256: doc.sha256 } });
    if (dateSignatureCubi) await evenement(client, contratId, 'signe_cubi', { acteur });

    const demande = await creerDemandeSignature(client, contratId);
    await evenement(client, contratId, 'envoye', { meta: { destinataire: contrat.signataire_email } });

    await emailSignerContrat({
      email: contrat.signataire_email, nom: contrat.signataire_nom,
      numero: contrat.numero, token: demande.token, expireLe: demande.expireLe,
    }).catch(e => { throw erreur(502, `E-mail au signataire non envoyé, rien n'a été enregistré : ${e.message}`); });

    return { numero: contrat.numero, expireLe: demande.expireLe };
  });
}

// Révoque le lien en cours et en envoie un nouveau (J+14). Relance aussi un contrat expiré.
async function renvoyer(contratId, acteur) {
  return avecTransaction(async client => {
    const contrat = await verrouiller(client, contratId);
    if (!['envoye', 'expire'].includes(contrat.statut)) {
      throw erreur(409, 'Seul un contrat envoyé ou expiré peut être renvoyé.');
    }
    await revoquerDemandesOuvertes(client, contratId);
    if (contrat.statut === 'expire') {
      await client.query("UPDATE contrat SET statut = 'envoye', date_modification = NOW() WHERE id = $1", [contratId]);
    }
    const demande = await creerDemandeSignature(client, contratId);
    await evenement(client, contratId, 'renvoye', { acteur, meta: { destinataire: contrat.signataire_email } });

    await emailSignerContrat({
      email: contrat.signataire_email, nom: contrat.signataire_nom,
      numero: contrat.numero, token: demande.token, expireLe: demande.expireLe,
    }).catch(e => { throw erreur(502, `E-mail au signataire non envoyé, rien n'a été enregistré : ${e.message}`); });

    return { numero: contrat.numero, expireLe: demande.expireLe };
  });
}

async function annuler(contratId, acteur) {
  return avecTransaction(async client => {
    const contrat = await verrouiller(client, contratId);
    if (!['brouillon', 'envoye', 'expire'].includes(contrat.statut)) {
      throw erreur(409, 'Un contrat signé ou déjà annulé ne peut pas être annulé.');
    }
    await revoquerDemandesOuvertes(client, contratId);
    await client.query("UPDATE contrat SET statut = 'annule', date_modification = NOW() WHERE id = $1", [contratId]);
    await evenement(client, contratId, 'annule', { acteur });
    return { numero: contrat.numero };
  });
}

// PDF à servir : signé s'il existe, sinon l'original ; aperçu non stocké pour un brouillon
async function pdfDuContrat(contrat) {
  const docId = contrat.document_signe_id || contrat.document_original_id;
  if (docId) {
    const doc = await documentStorage.get(pool, docId);
    return { contenu: doc.contenu, apercu: false, signe: Boolean(contrat.document_signe_id) };
  }
  return { contenu: await renderContratPdf(contrat), apercu: true, signe: false };
}

module.exports = {
  evenement, evenements, acteurCubi, typesLicenceActifs, aujourdhuiParis,
  creerContratBrouillon, modifierBrouillon,
  creerDemandeSignature, revoquerDemandesOuvertes,
  envoyer, renvoyer, annuler, pdfDuContrat,
};
