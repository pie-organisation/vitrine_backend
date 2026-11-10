// Lignes des tables contrat / facture (migration 004) -> données des templates,
// exactement à la forme de reference/sample-data.json.
//
// Convention de stockage (les colonnes JSONB sont déjà à la forme des templates) :
//   facture.lignes            [{ label, description?, quantity, unitPriceCents, vatRate, totalHtCents }]
//   facture.ventilation_tva   [{ rate, amountCents }]
//   facture.client_snapshot   { name, legalForm?, billingContact?, address, siret?, purchaseOrder? }
//   facture.emetteur_snapshot getEmetteur() au moment de l'émission
//   contrat.donnees           { client: <comme client_snapshot>,
//                               offre: { nom, badge? },
//                               facturation: { libelle },
//                               etablissements: [{ ecoleId, nom, siret, quantite, prixUnitaireCentimes }] }

const { getEmetteur, getSignatureCubiDataUrl } = require('./emetteur');

const TZ = 'Europe/Paris';

// Types écrits par src/services (contrats.js, signature.js, jobQuotidien.js)
const LIBELLES_EVENEMENT = {
  cree:        'Contrat créé à la validation de la demande',
  modifie:     'Brouillon modifié',
  genere:      'Contrat généré (empreinte figée)',
  signe_cubi:  'Contrat contre-signé par CUBI',
  envoye:      'Invitation à signer envoyée',
  renvoye:     'Nouveau lien de signature envoyé',
  relance:     'Relance envoyée',
  consulte:    'Document consulté',
  otp_envoye:  'Code OTP envoyé',
  otp_echec:   'Code OTP erroné',
  revoque:     'Lien de signature révoqué',
  signe:       'Code validé — contrat signé',
};

// DATE PostgreSQL ('2026-11-01' ou Date) -> 'YYYY-MM-DD', sans décalage de fuseau
function isoDate(d) {
  if (d == null) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
}

function isoDateTime(d) {
  return d == null ? null : new Date(d).toISOString();
}

// 2026-11-01 -> 2026-11-30 : « Nov. 2026 » ; sinon « 01/11/2026 – 31/01/2027 »
function libellePeriode(debut, fin) {
  const [y1, m1, d1] = debut.split('-').map(Number);
  const [y2, m2, d2] = fin.split('-').map(Number);
  const dernierJour = new Date(Date.UTC(y1, m1, 0)).getUTCDate();
  if (y1 === y2 && m1 === m2 && d1 === 1 && d2 === dernierJour) {
    const mois = new Intl.DateTimeFormat('fr-FR', { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y1, m1 - 1, 1)));
    return `${mois.charAt(0).toUpperCase()}${mois.slice(1)} ${y1}`;
  }
  const fr = s => s.split('-').reverse().join('/');
  return `${fr(debut)} – ${fr(fin)}`;
}

function euros(centimes) {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(centimes / 100);
}

// facture : ligne de la table facture, avec en plus contrat_numero et facture_origine_numero (jointures)
function factureVersTemplate(facture) {
  return {
    issuer: facture.emetteur_snapshot,
    client: facture.client_snapshot,
    invoice: {
      number:                facture.numero,
      isCreditNote:          facture.type === 'avoir',
      originalInvoiceNumber: facture.facture_origine_numero || null,
      issuedAt:              isoDate(facture.date_emission),
      dueAt:                 isoDate(facture.date_echeance),
      paidAt:                facture.statut === 'payee' ? isoDate(facture.date_paiement) : null,
      periodLabel:           libellePeriode(isoDate(facture.periode_debut), isoDate(facture.periode_fin)),
      contractNumber:        facture.contrat_numero,
      totalHtCents:          facture.total_ht_centimes,
      totalTtcCents:         facture.total_ttc_centimes,
      vatBreakdown:          facture.ventilation_tva,
    },
    lines: facture.lignes,
  };
}

// Lignes des conditions particulières : une par établissement (le nom n'est affiché que pour un groupe)
function lignesContrat(donnees) {
  const etabs = donnees.etablissements || [];
  return etabs.map(e => ({
    label: etabs.length > 1 ? e.nom : `Abonnement ${donnees.offre.nom}`,
    detail: `${e.quantite} licence${e.quantite > 1 ? 's' : ''} · ${euros(e.prixUnitaireCentimes)} HT / licence / mois`,
  }));
}

// contrat : ligne de la table contrat
// signature : { png: Buffer, signedAt, mention, proofId } — signature du client, une fois signé
// preuve    : { evenements: lignes contrat_evenement, verifyUrl }
function contratVersTemplate(contrat, { signature, preuve } = {}) {
  const { donnees } = contrat;
  const signatureCubi = getSignatureCubiDataUrl();

  const data = {
    issuer: getEmetteur(),
    client: donnees.client,
    signer: {
      fullName: contrat.signataire_nom,
      role:     contrat.signataire_fonction,
      email:    contrat.signataire_email,
    },
    contract: {
      number:         contrat.numero,
      offerName:      donnees.offre.nom,
      offerBadge:     donnees.offre.badge || null,
      durationMonths: contrat.duree_mois,
      startDate:      isoDate(contrat.date_debut),
      billingLabel:   donnees.facturation.libelle,
      lines:          lignesContrat(donnees),
    },
    signature: {},
  };

  if (signatureCubi && contrat.date_signature_cubi) {
    data.signature.issuer = { imageDataUrl: signatureCubi, signedAt: isoDateTime(contrat.date_signature_cubi) };
  }
  if (signature) {
    data.signature.client = {
      imageDataUrl: `data:image/png;base64,${Buffer.from(signature.png).toString('base64')}`,
      signedAt:     isoDateTime(signature.signedAt),
      mention:      signature.mention,
      proofId:      signature.proofId,
    };
  }
  if (preuve) {
    data.proof = {
      originalHash: contrat.sha256_original,
      verifyUrl:    preuve.verifyUrl,
      events: preuve.evenements.map(e => ({
        at:    isoDateTime(e.horodatage),
        label: LIBELLES_EVENEMENT[e.type] || e.type,
        actor: e.acteur,
        ip:    e.ip || '—',
      })),
    };
  }
  return data;
}

module.exports = { factureVersTemplate, contratVersTemplate, libellePeriode, isoDate };
