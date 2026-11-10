// Émission des factures et avoirs. Une facture émise est immuable (trigger en base) :
// toute correction passe par un avoir. Une facture émise ne dépend jamais de l'envoi de l'e-mail.

const config = require('../config');
const pool = require('../db');
const documentStorage = require('./documentStorage');
const { avecTransaction, erreur } = require('./transaction');
const { prochainNumero } = require('./numerotation');
const { evenement, aujourdhuiParis } = require('./contrats');
const {
  ajouterJours, finDeMois, moisSuivant, periodeDuMois,
  lignesFacture, totaux, lignesAvoirTotal, lignesAvoirPartiel, verifierPlafondAvoir,
} = require('./calculFacture');
const { renderFacturePdf } = require('../pdf/render');
const { getEmetteur } = require('../pdf/emetteur');
const { isoDate } = require('../pdf/mappers');
const { emailFacture } = require('../email');

// Facture + numéros du contrat et de la facture d'origine (forme attendue par le mapper PDF)
const SELECT_FACTURE = `
  SELECT f.*, c.numero AS contrat_numero, o.numero AS facture_origine_numero
  FROM facture f
  JOIN contrat c      ON c.id = f.contrat_id
  LEFT JOIN facture o ON o.id = f.facture_origine_id`;

async function lireFacture(db, id) {
  const { rows } = await db.query(`${SELECT_FACTURE} WHERE f.id = $1`, [id]);
  return rows[0] || null;
}

// Date d'émission 'YYYY-MM-DD' -> Date pour la numérotation (année de Paris)
const dateNumerotation = iso => new Date(`${iso}T12:00:00Z`);

// Client figé sur la facture : identité du contrat + contact de facturation de l'organisation
async function snapshotClient(db, contrat) {
  const { rows } = await db.query(
    `SELECT nom_contact, prenom_contact, email_facturation FROM contact_facturation
     WHERE ($1::uuid IS NOT NULL AND ecole_id = $1) OR ($2::uuid IS NOT NULL AND groupe_scolaire_id = $2)
     ORDER BY date_creation LIMIT 1`,
    [contrat.ecole_id, contrat.groupe_scolaire_id]
  );
  const contact = rows[0];
  const c = contrat.donnees.client;
  return {
    name: c.name,
    legalForm: c.legalForm,
    address: c.address,
    siret: c.siret,
    billingContact: contact ? `${contact.prenom_contact} ${contact.nom_contact}`.trim() : c.billingContact,
    // Hors template : destinataire de l'e-mail de facture
    billingEmail: contact?.email_facturation || contrat.signataire_email,
  };
}

async function insererFacture(client, f) {
  const { rows } = await client.query(
    `INSERT INTO facture
       (numero, type, facture_origine_id, contrat_id, ecole_id, groupe_scolaire_id, periode_debut, periode_fin,
        date_emission, date_echeance, lignes, total_ht_centimes, total_tva_centimes, total_ttc_centimes,
        ventilation_tva, client_snapshot, emetteur_snapshot, document_id, sha256)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     RETURNING id`,
    [
      f.numero, f.type, f.facture_origine_id, f.contrat_id, f.ecole_id, f.groupe_scolaire_id,
      f.periode_debut, f.periode_fin, f.date_emission, f.date_echeance, JSON.stringify(f.lignes),
      f.total_ht_centimes, f.total_tva_centimes, f.total_ttc_centimes, JSON.stringify(f.ventilation_tva),
      JSON.stringify(f.client_snapshot), JSON.stringify(f.emetteur_snapshot), f.document_id, f.sha256,
    ]
  );
  return rows[0].id;
}

// Rendu, stockage et insertion d'une facture ou d'un avoir (dans la transaction appelante)
async function figer(client, brouillon) {
  const pdf = await renderFacturePdf(brouillon);
  const doc = await documentStorage.put(client, { type: brouillon.type, contenu: pdf });
  const id = await insererFacture(client, { ...brouillon, document_id: doc.id, sha256: doc.sha256 });
  return { id, pdf };
}

// ── Envoi par e-mail (hors transaction, jamais bloquant) ──────────────────────

async function envoyerFactureParEmail(factureId, pdf = null) {
  const facture = await lireFacture(pool, factureId);
  if (!facture) throw erreur(404, 'Facture introuvable');
  const contenu = pdf || (await documentStorage.get(pool, facture.document_id)).contenu;
  try {
    await emailFacture({
      email: facture.client_snapshot.billingEmail,
      nom: facture.client_snapshot.billingContact,
      numero: facture.numero,
      avoir: facture.type === 'avoir',
      totalTtcCentimes: facture.total_ttc_centimes,
      dateEcheance: facture.date_echeance,
      pdf: contenu,
    });
    await evenement(pool, facture.contrat_id, 'facture_envoyee', {
      meta: { factureId, numero: facture.numero, destinataire: facture.client_snapshot.billingEmail },
    });
    return true;
  } catch (e) {
    console.warn(`E-mail de la facture ${facture.numero} non envoyé : ${e.message}`);
    await evenement(pool, facture.contrat_id, 'facture_email_echec', {
      meta: { factureId, numero: facture.numero, erreur: e.message.slice(0, 300) },
    }).catch(() => {});
    return false;
  }
}

// ── Facture de licences ───────────────────────────────────────────────────────

// Début de la facturation : date_effet = max(date_debut, signature), fixée à la signature
function dateEffet(contrat) {
  if (!contrat.date_effet) throw erreur(409, `Contrat ${contrat.numero} sans date d'effet : pas de facture.`);
  return isoDate(contrat.date_effet);
}

// Facture la période [periodeDebut, periodeFin] (un mois civil, ou sa fin pour le premier mois).
// Idempotent : si une facture active existe déjà pour cette période, elle est renvoyée telle quelle.
// dateEmission : aujourd'hui (Paris) par défaut ; paramétrable pour les tests.
async function emettreFacture({ contratId, periodeDebut, periodeFin, dateEmission = aujourdhuiParis() }) {
  const r = await avecTransaction(async client => {
    // Verrou du contrat : sérialise les émissions d'un même contrat (pas de doublon de période)
    const { rows: [contrat] } = await client.query('SELECT * FROM contrat WHERE id = $1 FOR UPDATE', [contratId]);
    if (!contrat) throw erreur(404, 'Contrat introuvable');
    if (contrat.statut !== 'signe') throw erreur(409, `Contrat ${contrat.numero} non signé : pas de facture.`);
    const debutEffet = dateEffet(contrat);
    if (periodeDebut < debutEffet) {
      throw erreur(422, `La période facturée commence avant la date d'effet du contrat (${debutEffet}).`);
    }

    const { rows: existantes } = await client.query(
      `SELECT id FROM facture
       WHERE contrat_id = $1 AND periode_debut = $2 AND type = 'facture' AND statut <> 'annulee_par_avoir'`,
      [contratId, periodeDebut]
    );
    if (existantes.length) return { id: existantes[0].id, dejaEmise: true };

    const lignes = lignesFacture(contrat.donnees, {
      periodeDebut,
      periodeFin,
      fraisMiseEnServiceCentimes: config.fraisMiseEnServiceCentimes,
      premiere: periodeDebut === debutEffet,
    });
    const t = totaux(lignes);
    const emetteur = getEmetteur();
    const delai = Number.isInteger(emetteur.paymentTermsDays) ? emetteur.paymentTermsDays : 30;
    const numero = await prochainNumero(client, 'facture', dateNumerotation(dateEmission));

    const { id, pdf } = await figer(client, {
      numero,
      type: 'facture',
      facture_origine_id: null,
      contrat_id: contrat.id,
      contrat_numero: contrat.numero,
      ecole_id: contrat.ecole_id,
      groupe_scolaire_id: contrat.groupe_scolaire_id,
      periode_debut: periodeDebut,
      periode_fin: periodeFin,
      date_emission: dateEmission,
      date_echeance: ajouterJours(dateEmission, delai),
      date_paiement: null,
      statut: 'emise',
      lignes,
      total_ht_centimes: t.totalHtCents,
      total_tva_centimes: t.totalTvaCents,
      total_ttc_centimes: t.totalTtcCents,
      ventilation_tva: t.ventilation,
      client_snapshot: await snapshotClient(client, contrat),
      emetteur_snapshot: emetteur,
    });
    await evenement(client, contrat.id, 'facture_emise', {
      meta: { factureId: id, numero, periodeDebut, periodeFin, totalTtcCentimes: t.totalTtcCents },
    });
    return { id, pdf, dejaEmise: false };
  });

  if (!r.dejaEmise) await envoyerFactureParEmail(r.id, r.pdf);
  return { facture: await lireFacture(pool, r.id), dejaEmise: r.dejaEmise };
}

// Toutes les périodes dues de la date d'effet jusqu'au mois en cours (la première proratisée).
// À l'activation, c'est en pratique la seule période du mois de signature ; si date_debut est
// dans un mois futur, rien n'est émis et le job quotidien prendra le relais.
async function facturerPeriodesDues(contratId, debutEffet, aujourdhui = aujourdhuiParis()) {
  const resultats = [];
  for (let jour = debutEffet; jour <= finDeMois(aujourdhui); jour = moisSuivant(jour)) {
    const p = periodeDuMois(jour, debutEffet);
    if (!p) break;
    resultats.push(await emettreFacture({ contratId, periodeDebut: p.debut, periodeFin: p.fin }));
  }
  return resultats;
}

// ── Avoirs ────────────────────────────────────────────────────────────────────

// lignesDemandees absent : avoir total. Sinon avoir partiel, lignes { label, quantite?, prixUnitaireHtCentimes, tauxTva? }.
async function emettreAvoir(factureId, motif, lignesDemandees = null, acteur = 'systeme') {
  const r = await avecTransaction(async client => {
    const { rows } = await client.query(`${SELECT_FACTURE} WHERE f.id = $1 FOR UPDATE OF f`, [factureId]);
    const origine = rows[0];
    if (!origine) throw erreur(404, 'Facture introuvable');
    if (origine.type !== 'facture') throw erreur(422, 'Un avoir porte sur une facture, pas sur un autre avoir.');
    if (origine.statut === 'annulee_par_avoir') throw erreur(409, `La facture ${origine.numero} est déjà annulée par avoir.`);

    const { rows: avoirs } = await client.query(
      "SELECT total_ttc_centimes FROM facture WHERE facture_origine_id = $1 AND type = 'avoir'", [factureId]
    );
    if (!lignesDemandees && avoirs.length) {
      throw erreur(409, `Des avoirs partiels existent déjà sur ${origine.numero} : émets un avoir partiel pour le solde.`);
    }

    const lignes = lignesDemandees
      ? lignesAvoirPartiel(origine, lignesDemandees, motif)
      : lignesAvoirTotal(origine, motif);
    const t = totaux(lignes);
    const plafond = verifierPlafondAvoir({
      totalTtcFacture: origine.total_ttc_centimes,
      ttcAvoirsExistants: avoirs.map(a => a.total_ttc_centimes),
      ttcNouvelAvoir: t.totalTtcCents,
    });

    const dateEmission = aujourdhuiParis();
    const numero = await prochainNumero(client, 'avoir', dateNumerotation(dateEmission));
    const { id, pdf } = await figer(client, {
      numero,
      type: 'avoir',
      facture_origine_id: origine.id,
      facture_origine_numero: origine.numero,
      contrat_id: origine.contrat_id,
      contrat_numero: origine.contrat_numero,
      ecole_id: origine.ecole_id,
      groupe_scolaire_id: origine.groupe_scolaire_id,
      periode_debut: isoDate(origine.periode_debut),
      periode_fin: isoDate(origine.periode_fin),
      date_emission: dateEmission,
      date_echeance: dateEmission,
      date_paiement: null,
      statut: 'emise',
      lignes,
      total_ht_centimes: t.totalHtCents,
      total_tva_centimes: t.totalTvaCents,
      total_ttc_centimes: t.totalTtcCents,
      ventilation_tva: t.ventilation,
      // Mêmes parties que la facture d'origine
      client_snapshot: origine.client_snapshot,
      emetteur_snapshot: origine.emetteur_snapshot,
    });

    // Facture entièrement créditée (avoir total, ou partiels qui soldent) : annulée par avoir
    if (plafond.total) {
      await client.query("UPDATE facture SET statut = 'annulee_par_avoir' WHERE id = $1", [origine.id]);
    }
    await evenement(client, origine.contrat_id, 'avoir_emis', {
      acteur,
      meta: { avoirId: id, numero, factureOrigine: origine.numero, motif, totalTtcCentimes: t.totalTtcCents, soldeFacture: plafond.total },
    });
    return { id, pdf };
  });

  await envoyerFactureParEmail(r.id, r.pdf);
  return lireFacture(pool, r.id);
}

// ── Paiement ──────────────────────────────────────────────────────────────────

async function marquerPayee(factureId, datePaiement, acteur) {
  return avecTransaction(async client => {
    const { rows } = await client.query(
      `UPDATE facture SET statut = 'payee', date_paiement = $2
       WHERE id = $1 AND type = 'facture' AND statut = 'emise' AND $2::date >= date_emission
       RETURNING id, numero, contrat_id`,
      [factureId, datePaiement]
    );
    if (!rows.length) {
      const f = await lireFacture(client, factureId);
      if (!f) throw erreur(404, 'Facture introuvable');
      if (f.type !== 'facture' || f.statut !== 'emise') throw erreur(409, `La facture ${f.numero} n'est pas en attente de paiement.`);
      throw erreur(422, 'La date de paiement ne peut pas précéder la date d\'émission.');
    }
    await evenement(client, rows[0].contrat_id, 'facture_payee', {
      acteur, meta: { factureId, numero: rows[0].numero, datePaiement },
    });
    return lireFacture(client, factureId);
  });
}

module.exports = {
  SELECT_FACTURE, lireFacture, dateEffet,
  emettreFacture, facturerPeriodesDues, emettreAvoir, marquerPayee, envoyerFactureParEmail,
};
