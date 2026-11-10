// Sérialisation des factures pour le front, en gardant les formes déjà attendues par les mocks :
//  admin  : Facture       { id, organisationId, organisation, plan, montant, echeance, statut, reference }
//  école  : SchoolInvoice { id, reference, date, echeance, montant, statut }
// Les champs supplémentaires (type, montants en centimes, période…) sont ajoutés à côté, sans rien retirer.

const { isoDate } = require('../pdf/mappers');

const euros = c => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(c / 100);
const fr = d => (d ? isoDate(d).split('-').reverse().join('/') : null);

// Statut affiché, calculé en SQL pour pouvoir filtrer dessus.
// Front admin (FactureStatut) : payee | en_attente | impayee, plus annulee et avoir (nouveaux).
const STATUT_ADMIN_SQL = `
  CASE WHEN f.type = 'avoir'                 THEN 'avoir'
       WHEN f.statut = 'annulee_par_avoir'   THEN 'annulee'
       WHEN f.statut = 'payee'               THEN 'payee'
       WHEN f.date_echeance < (NOW() AT TIME ZONE 'Europe/Paris')::date THEN 'impayee'
       ELSE 'en_attente' END`;

const STATUTS_ADMIN = ['payee', 'en_attente', 'impayee', 'annulee', 'avoir'];

// Front école (InvoiceStatut) : presentee (réglée) | en_cours (à régler) | a_venir (jamais émis ici),
// plus annulee et avoir (nouveaux)
function statutEcole(f) {
  if (f.type === 'avoir') return 'avoir';
  if (f.statut === 'annulee_par_avoir') return 'annulee';
  return f.statut === 'payee' ? 'presentee' : 'en_cours';
}

function champsCommuns(f) {
  return {
    type: f.type,
    statutFacture: f.statut,
    dateEmission: isoDate(f.date_emission),
    dateEcheance: isoDate(f.date_echeance),
    datePaiement: isoDate(f.date_paiement),
    periodeDebut: isoDate(f.periode_debut),
    periodeFin: isoDate(f.periode_fin),
    totalHtCentimes: f.total_ht_centimes,
    totalTvaCentimes: f.total_tva_centimes,
    totalTtcCentimes: f.total_ttc_centimes,
    factureOrigineId: f.facture_origine_id,
    factureOrigine: f.facture_origine_numero || null,
    contratNumero: f.contrat_numero,
  };
}

function factureAdmin(f) {
  return {
    id: f.id,
    organisationId: f.ecole_id || f.groupe_scolaire_id,
    organisation: f.client_snapshot.name,
    plan: f.plan,
    montant: euros(f.total_ttc_centimes),
    echeance: fr(f.date_echeance),
    statut: f.statut_affiche,
    reference: f.numero,
    ...champsCommuns(f),
    contratId: f.contrat_id,
  };
}

function factureEcole(f) {
  return {
    id: f.id,
    reference: f.numero,
    date: fr(f.date_emission),
    echeance: fr(f.date_echeance),
    montant: euros(f.total_ttc_centimes),
    statut: statutEcole(f),
    ...champsCommuns(f),
  };
}

// Détail complet (admin) : lignes, TVA, parties figées
function factureDetail(f) {
  return {
    ...factureAdmin(f),
    lignes: f.lignes,
    ventilationTva: f.ventilation_tva,
    client: f.client_snapshot,
    emetteur: f.emetteur_snapshot,
    sha256: f.sha256,
  };
}

module.exports = { STATUT_ADMIN_SQL, STATUTS_ADMIN, factureAdmin, factureEcole, factureDetail, statutEcole };
