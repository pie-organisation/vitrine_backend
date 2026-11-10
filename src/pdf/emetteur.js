// Mentions légales de Cubi (émetteur des factures, prestataire des contrats), lues depuis l'env.
// Lecture à chaque appel : une facture fige ces valeurs dans emetteur_snapshot au moment de l'émission.

const A_COMPLETER = 'À COMPLÉTER';

function env(key, fallback = A_COMPLETER) {
  const val = process.env[key];
  return val && val.trim() ? val.trim() : fallback;
}

// Forme attendue par les templates (cf. reference/sample-data.json, clé "issuer")
function getEmetteur() {
  return {
    legalName:        env('CUBI_RAISON_SOCIALE'),
    legalForm:        env('CUBI_FORME_JURIDIQUE'),
    capital:          env('CUBI_CAPITAL'),
    address:          env('CUBI_ADRESSE'),
    siret:            env('CUBI_SIRET'),
    rcs:              env('CUBI_RCS'),
    vatNumber:        env('CUBI_TVA_INTRACOM'),
    billingEmail:     env('CUBI_EMAIL_FACTURATION'),
    iban:             env('CUBI_IBAN'),
    bic:              env('CUBI_BIC'),
    paymentTermsDays: parseInt(env('CUBI_DELAI_PAIEMENT_JOURS', '30'), 10),
    signatoryName:    env('CUBI_SIGNATAIRE_NOM'),
    signatoryRole:    env('CUBI_SIGNATAIRE_FONCTION'),
  };
}

// Signature manuscrite scannée de Cubi (PNG en base64, avec ou sans préfixe data:).
// Optionnelle : sans elle, le contrat affiche « En attente de contre-signature ».
function getSignatureCubiDataUrl() {
  const raw = process.env.CUBI_SIGNATURE_PNG_BASE64?.trim();
  if (!raw) return null;
  const b64 = raw.replace(/^data:image\/png;base64,/, '');
  if (!Buffer.from(b64, 'base64').subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error('CUBI_SIGNATURE_PNG_BASE64 ne contient pas un PNG valide');
  }
  return `data:image/png;base64,${b64}`;
}

module.exports = { getEmetteur, getSignatureCubiDataUrl, A_COMPLETER };
