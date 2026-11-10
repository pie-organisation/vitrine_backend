// npm run pdf:preview : génère dans ./tmp-preview/ les 4 documents types, sans base :
//  contrat-non-signe.pdf, contrat-signe.pdf (avec annexe de preuve) : données de reference/sample-data.json
//  facture-groupe-prorata.pdf, avoir.pdf : vrais calculs (calculFacture) et vrai mapper (renderFacturePdf)
const fs = require('fs');
const path = require('path');
const { renderPdf, renderFacturePdf, closeBrowser } = require('../src/pdf/render');
const { lignesFacture, totaux, lignesAvoirTotal } = require('../src/services/calculFacture');
const sample = require('../reference/sample-data.json');

const OUT_DIR = path.join(__dirname, '..', 'tmp-preview');

// Contrat non signé : ni signatures ni annexe
const contratNonSigne = { ...sample.contrat, signature: {}, proof: undefined };

// Groupe de deux établissements, contrat effectif le 15/11 : premier mois proratisé (16/30)
const donneesGroupe = {
  offre: { nom: 'Licence 3' },
  etablissements: [
    { nom: 'Collège Jean Moulin', quantite: 70, prixUnitaireCentimes: 300 },
    { nom: 'Lycée professionnel Les Platanes', quantite: 45, prixUnitaireCentimes: 300 },
  ],
};
const lignes = lignesFacture(donneesGroupe, { periodeDebut: '2026-11-15', periodeFin: '2026-11-30' });
const t = totaux(lignes);
const facture = {
  numero: 'FAC-2026-0007', type: 'facture', contrat_numero: 'CTR-2026-0003', statut: 'emise',
  periode_debut: '2026-11-15', periode_fin: '2026-11-30', date_emission: '2026-11-15', date_echeance: '2026-12-15',
  lignes, total_ht_centimes: t.totalHtCents, total_tva_centimes: t.totalTvaCents,
  total_ttc_centimes: t.totalTtcCents, ventilation_tva: t.ventilation,
  client_snapshot: {
    name: 'Groupe scolaire Saint-Exupéry', legalForm: 'Groupe scolaire',
    address: '10 place du Siège, 69002 Lyon', billingContact: 'Jeanne Martin',
  },
  emetteur_snapshot: sample.facture.issuer,
};

const lignesAvoir = lignesAvoirTotal(facture, 'Erreur de quantité');
const ta = totaux(lignesAvoir);
const avoir = {
  ...facture,
  numero: 'AV-2026-0001', type: 'avoir', facture_origine_numero: facture.numero,
  date_emission: '2026-11-20', date_echeance: '2026-11-20', lignes: lignesAvoir,
  total_ht_centimes: ta.totalHtCents, total_tva_centimes: ta.totalTvaCents,
  total_ttc_centimes: ta.totalTtcCents, ventilation_tva: ta.ventilation,
};

const DOCUMENTS = [
  ['contrat-non-signe', () => renderPdf('contrat', contratNonSigne)],
  ['contrat-signe', () => renderPdf('contrat', sample.contrat)],
  ['facture-groupe-prorata', () => renderFacturePdf(facture)],
  ['avoir', () => renderFacturePdf(avoir)],
];

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  try {
    for (const [nom, rendre] of DOCUMENTS) {
      const debut = Date.now();
      const pdf = await rendre();
      const fichier = path.join(OUT_DIR, `${nom}.pdf`);
      fs.writeFileSync(fichier, pdf);
      console.log(`${fichier} (${Math.round(pdf.length / 1024)} Ko, ${Date.now() - debut} ms)`);
    }
  } finally {
    await closeBrowser();
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
