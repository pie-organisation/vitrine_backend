// Job quotidien, appelé par un cron externe (POST /internal/jobs/quotidien) : Render free met le
// service en veille, un cron interne ne serait pas fiable. Idempotent : rejouable sans effet de bord.
//  1. expire les demandes de signature échues (J+14) et leurs contrats, notifie l'admin ;
//  2. relance à J+3 et J+7 (comptés depuis l'envoi = expire_le - 14 j) ;
//  3. rattrape les activations (onContratSigne) qui auraient échoué après une signature ;
//  4. émet la facture du mois en cours des contrats signés dont l'organisation est active.

const pool = require('../db');
const { avecTransaction } = require('./transaction');
const { evenement, creerDemandeSignature, aujourdhuiParis } = require('./contrats');
const { onContratSigne } = require('./onContratSigne');
const { emettreFacture } = require('./factures');
const { periodeDuMois } = require('./calculFacture');
const { isoDate } = require('../pdf/mappers');
const { emailRelanceSignature, notifierAdmins } = require('../email');

const JOURS_RELANCE = [7, 3]; // du plus tardif au plus précoce

async function expirer() {
  const contrats = await avecTransaction(async client => {
    const { rows: demandes } = await client.query(
      `UPDATE demande_signature SET statut = 'expiree', date_fin = NOW()
       WHERE statut = 'ouverte' AND expire_le <= NOW()
       RETURNING contrat_id`
    );
    const ids = [...new Set(demandes.map(d => d.contrat_id))];
    const { rows } = await client.query(
      `UPDATE contrat c SET statut = 'expire', date_modification = NOW()
       WHERE c.id = ANY($1::uuid[]) AND c.statut = 'envoye'
         AND NOT EXISTS (SELECT 1 FROM demande_signature d WHERE d.contrat_id = c.id AND d.statut = 'ouverte')
       RETURNING c.id, c.numero, c.donnees->'client'->>'name' AS organisation`,
      [ids]
    );
    for (const c of rows) await evenement(client, c.id, 'expire');
    return rows;
  });

  if (contrats.length) {
    await notifierAdmins(
      `${contrats.length} contrat(s) CUBI expiré(s) sans signature`,
      `Ces contrats n'ont pas été signés sous 14 jours :\n${contrats.map(c => `- ${c.numero} (${c.organisation})`).join('\n')}\n\n` +
      'Ils peuvent être renvoyés depuis l\'admin (nouveau lien valable 14 jours).'
    ).catch(e => console.warn(`Notification admin non envoyée : ${e.message}`));
  }
  return contrats.length;
}

// Le token n'étant stocké que haché, une relance émet un nouveau lien (même échéance) et révoque l'ancien.
// L'e-mail part avant le COMMIT : en cas d'échec, l'ancien lien reste valide.
async function relancer(demandeId, jour) {
  return avecTransaction(async client => {
    const { rows } = await client.query(
      `SELECT d.id, d.contrat_id, d.expire_le, c.numero, c.signataire_nom, c.signataire_email
       FROM demande_signature d JOIN contrat c ON c.id = d.contrat_id
       WHERE d.id = $1 AND d.statut = 'ouverte' AND d.expire_le > NOW() AND c.statut = 'envoye'
       FOR UPDATE OF d, c`,
      [demandeId]
    );
    if (!rows.length) return false;
    const d = rows[0];
    const echeance = d.expire_le.toISOString();

    // Déjà relancé pour ce palier (ou un plus tardif) pour cette échéance ?
    const { rows: deja } = await client.query(
      `SELECT 1 FROM contrat_evenement
       WHERE contrat_id = $1 AND type = 'relance' AND meta->>'echeance' = $2 AND (meta->>'jour')::int >= $3
       LIMIT 1`,
      [d.contrat_id, echeance, jour]
    );
    if (deja.length) return false;

    // Révocation d'abord : une seule demande ouverte par contrat (index unique partiel)
    await client.query("UPDATE demande_signature SET statut = 'revoquee', date_fin = NOW() WHERE id = $1", [d.id]);
    const nouvelle = await creerDemandeSignature(client, d.contrat_id, { expireLeDepuis: d.id });
    await evenement(client, d.contrat_id, 'relance', { meta: { jour, echeance } });

    await emailRelanceSignature({
      email: d.signataire_email, nom: d.signataire_nom, numero: d.numero,
      token: nouvelle.token, expireLe: nouvelle.expireLe,
    });
    return true;
  });
}

async function jobQuotidien() {
  const bilan = { expires: 0, relances: 0, activationsRattrapees: 0, factures: 0, erreurs: [] };

  bilan.expires = await expirer();

  const { rows: ouvertes } = await pool.query(
    `SELECT d.id, EXTRACT(EPOCH FROM NOW() - (d.expire_le - INTERVAL '14 days')) / 86400 AS age_jours
     FROM demande_signature d JOIN contrat c ON c.id = d.contrat_id
     WHERE d.statut = 'ouverte' AND d.expire_le > NOW() AND c.statut = 'envoye'`
  );
  for (const d of ouvertes) {
    const jour = JOURS_RELANCE.find(j => Number(d.age_jours) >= j);
    if (!jour) continue;
    try {
      if (await relancer(d.id, jour)) bilan.relances++;
    } catch (e) {
      bilan.erreurs.push(`relance ${d.id} : ${e.message}`);
    }
  }

  const { rows: aActiver } = await pool.query(
    `SELECT c.id FROM contrat c
     WHERE c.statut = 'signe'
       AND NOT EXISTS (SELECT 1 FROM contrat_evenement e WHERE e.contrat_id = c.id AND e.type = 'organisation_activee')`
  );
  for (const c of aActiver) {
    try {
      const r = await onContratSigne(c.id);
      if (!r.dejaActive) bilan.activationsRattrapees++;
    } catch (e) {
      bilan.erreurs.push(`activation ${c.id} : ${e.message}`);
    }
  }

  bilan.factures = await facturer(bilan.erreurs);

  if (bilan.erreurs.length) console.error('Job quotidien :', bilan.erreurs);
  return bilan;
}

// Facture du mois en cours (terme à échoir) pour chaque contrat signé dont l'organisation est active.
// Job quotidien plutôt que mensuel : si le service dort le 1er, la facture part au premier réveil.
// Une période déjà facturée, même annulée par avoir, n'est jamais re-facturée automatiquement.
async function facturer(erreurs) {
  const aujourdhui = aujourdhuiParis();
  const { rows: contrats } = await pool.query(
    `SELECT c.id, c.numero, c.date_effet
     FROM contrat c
     LEFT JOIN ecole e           ON e.id = c.ecole_id
     LEFT JOIN groupe_scolaire g ON g.id = c.groupe_scolaire_id
     WHERE c.statut = 'signe'
       AND COALESCE(e.statut, g.statut) = 'actif'
       AND c.date_effet IS NOT NULL
       AND EXISTS (SELECT 1 FROM contrat_evenement ev WHERE ev.contrat_id = c.id AND ev.type = 'organisation_activee')`
  );

  let emises = 0;
  for (const c of contrats) {
    const periode = periodeDuMois(aujourdhui, isoDate(c.date_effet));
    if (!periode) continue; // contrat qui commence après ce mois
    const { rows: deja } = await pool.query(
      "SELECT 1 FROM facture WHERE contrat_id = $1 AND type = 'facture' AND periode_debut = $2 LIMIT 1",
      [c.id, periode.debut]
    );
    if (deja.length) continue;
    try {
      const r = await emettreFacture({ contratId: c.id, periodeDebut: periode.debut, periodeFin: periode.fin });
      if (!r.dejaEmise) emises++;
    } catch (e) {
      erreurs.push(`facture ${c.numero} : ${e.message}`);
    }
  }
  return emises;
}

module.exports = { jobQuotidien };
