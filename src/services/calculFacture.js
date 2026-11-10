// Calculs de facturation purs (sans base) : périodes, prorata, lignes, totaux, avoirs.
// Montants en centimes entiers. Dates 'YYYY-MM-DD' manipulées en UTC (aucun décalage de fuseau).
// Les lignes ont la forme des templates PDF : { label, description?, quantity, unitPriceCents, vatRate, totalHtCents }.

const TAUX_TVA = 20;

const pad = n => String(n).padStart(2, '0');
const versIso = d => d.toISOString().slice(0, 10);
const versDate = iso => new Date(`${iso}T00:00:00Z`);
const fr = iso => iso.split('-').reverse().join('/');

// Arrondi au centime symétrique (les avoirs sont négatifs : -12,5 -> -13, comme 12,5 -> 13)
const arrondi = x => Math.sign(x) * Math.round(Math.abs(x));

function joursDansMois(iso) {
  const d = versDate(iso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

function debutDeMois(iso) {
  return `${iso.slice(0, 7)}-01`;
}

function finDeMois(iso) {
  return `${iso.slice(0, 7)}-${pad(joursDansMois(iso))}`;
}

function ajouterJours(iso, n) {
  const d = versDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return versIso(d);
}

function moisSuivant(iso) {
  return ajouterJours(finDeMois(iso), 1);
}

// Période facturée du mois civil contenant `jour`, bornée par le début du contrat.
// null si le contrat commence après ce mois.
function periodeDuMois(jour, dateDebutContrat) {
  const fin = finDeMois(jour);
  if (dateDebutContrat > fin) return null;
  const debut = dateDebutContrat > debutDeMois(jour) ? dateDebutContrat : debutDeMois(jour);
  return { debut, fin };
}

// Prorata au jour près, à l'intérieur d'un seul mois civil
function prorata(periodeDebut, periodeFin) {
  if (periodeDebut.slice(0, 7) !== periodeFin.slice(0, 7) || periodeFin < periodeDebut) {
    throw Object.assign(new Error('Une période facturée doit tenir dans un seul mois civil.'), { status: 422 });
  }
  const jours = Number(periodeFin.slice(8)) - Number(periodeDebut.slice(8)) + 1;
  return { jours, joursMois: joursDansMois(periodeDebut) };
}

// Lignes d'une facture de licences : une par établissement (contrat.donnees figées).
// Arrondi ligne par ligne : quantité × prix mensuel × jours / jours du mois.
function lignesFacture(donnees, { periodeDebut, periodeFin, fraisMiseEnServiceCentimes = 0, premiere = false }) {
  const { jours, joursMois } = prorata(periodeDebut, periodeFin);
  const complet = jours === joursMois;
  const etabs = donnees.etablissements;
  const description = complet
    ? `Période du ${fr(periodeDebut)} au ${fr(periodeFin)}`
    : `Prorata ${jours}/${joursMois} jours, du ${fr(periodeDebut)} au ${fr(periodeFin)}`;

  const lignes = etabs.map(e => ({
    label: etabs.length > 1 ? `Abonnement ${donnees.offre.nom} — ${e.nom}` : `Abonnement ${donnees.offre.nom}`,
    description,
    quantity: e.quantite,
    unitPriceCents: e.prixUnitaireCentimes,
    vatRate: TAUX_TVA,
    totalHtCents: arrondi((e.quantite * e.prixUnitaireCentimes * jours) / joursMois),
  }));

  if (premiere && fraisMiseEnServiceCentimes > 0) {
    lignes.push({
      label: 'Frais de mise en service',
      description: 'Facturés une seule fois',
      quantity: 1,
      unitPriceCents: fraisMiseEnServiceCentimes,
      vatRate: TAUX_TVA,
      totalHtCents: fraisMiseEnServiceCentimes,
    });
  }
  return lignes;
}

// Totaux : HT = somme des lignes arrondies ; TVA ventilée par taux sur la base HT de chaque taux
function totaux(lignes) {
  const basesParTaux = new Map();
  for (const l of lignes) basesParTaux.set(l.vatRate, (basesParTaux.get(l.vatRate) || 0) + l.totalHtCents);
  const ventilation = [...basesParTaux.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rate, base]) => ({ rate, baseCents: base, amountCents: arrondi((base * rate) / 100) }));
  const totalHtCents = lignes.reduce((s, l) => s + l.totalHtCents, 0);
  const totalTvaCents = ventilation.reduce((s, v) => s + v.amountCents, 0);
  return { totalHtCents, totalTvaCents, totalTtcCents: totalHtCents + totalTvaCents, ventilation };
}

// ── Avoirs (montants négatifs) ────────────────────────────────────────────────

// Avoir total : reprend chaque ligne de la facture, en négatif
function lignesAvoirTotal(facture, motif) {
  return facture.lignes.map(l => ({
    ...l,
    description: `Annulation de la facture ${facture.numero} — ${motif}`,
    quantity: -l.quantity,
    totalHtCents: -l.totalHtCents,
  }));
}

// Avoir partiel : lignes saisies { label, quantite = 1, prixUnitaireHtCentimes, tauxTva? }.
// Le taux doit exister sur la facture d'origine (le seul taux de la facture par défaut).
function lignesAvoirPartiel(facture, demandees, motif) {
  const taux = [...new Set(facture.lignes.map(l => l.vatRate))];
  return demandees.map(d => {
    const vatRate = d.tauxTva ?? (taux.length === 1 ? taux[0] : null);
    if (!taux.includes(vatRate)) {
      throw Object.assign(new Error(`Taux de TVA ${d.tauxTva ?? '(non précisé)'} absent de la facture ${facture.numero}.`), { status: 422 });
    }
    const quantite = d.quantite ?? 1;
    return {
      label: d.label,
      description: `Avoir sur la facture ${facture.numero} — ${motif}`,
      quantity: -quantite,
      unitPriceCents: d.prixUnitaireHtCentimes,
      vatRate,
      totalHtCents: -(quantite * d.prixUnitaireHtCentimes),
    };
  });
}

// Le cumul des avoirs (TTC négatifs) ne dépasse jamais le TTC de la facture d'origine.
// Renvoie { solde, soldeApres, total } : total = l'avoir solde entièrement la facture.
function verifierPlafondAvoir({ totalTtcFacture, ttcAvoirsExistants = [], ttcNouvelAvoir }) {
  if (ttcNouvelAvoir >= 0) {
    throw Object.assign(new Error('Un avoir doit avoir un montant strictement positif.'), { status: 422 });
  }
  const dejaCredite = -ttcAvoirsExistants.reduce((s, t) => s + t, 0);
  const solde = totalTtcFacture - dejaCredite;
  const soldeApres = solde + ttcNouvelAvoir;
  if (soldeApres < 0) {
    throw Object.assign(new Error(
      `Avoir refusé : il dépasserait la facture (reste à créditer ${(solde / 100).toFixed(2).replace('.', ',')} € TTC).`
    ), { status: 422, soldeCentimes: solde });
  }
  return { solde, soldeApres, total: soldeApres === 0 };
}

module.exports = {
  TAUX_TVA, arrondi,
  joursDansMois, debutDeMois, finDeMois, ajouterJours, moisSuivant, periodeDuMois, prorata,
  lignesFacture, totaux, lignesAvoirTotal, lignesAvoirPartiel, verifierPlafondAvoir,
};
