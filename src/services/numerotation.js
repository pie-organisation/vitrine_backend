// Numérotation légale des contrats, factures et avoirs : CTR-AAAA-NNNN, FAC-AAAA-NNNN, AV-AAAA-NNNN.
// Continue par année et par type, sans trou ni doublon.

const PREFIXES = { contrat: 'CTR', facture: 'FAC', avoir: 'AV' };

function anneeParis(date) {
  return Number(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', year: 'numeric' }).format(date));
}

// `client` doit être un client pg dans une transaction ouverte (BEGIN) : le verrou FOR UPDATE
// est tenu jusqu'au COMMIT, et un ROLLBACK rend le numéro (pas de trou).
async function prochainNumero(client, type, date = new Date()) {
  const prefixe = PREFIXES[type];
  if (!prefixe) throw new Error(`Type de numérotation inconnu : ${type}`);
  const annee = anneeParis(date);

  await client.query(
    'INSERT INTO sequence_document (annee, type) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [annee, prefixe]
  );
  const { rows } = await client.query(
    'SELECT derniere_valeur FROM sequence_document WHERE annee = $1 AND type = $2 FOR UPDATE',
    [annee, prefixe]
  );
  const valeur = rows[0].derniere_valeur + 1;
  await client.query(
    'UPDATE sequence_document SET derniere_valeur = $3 WHERE annee = $1 AND type = $2',
    [annee, prefixe, valeur]
  );

  return `${prefixe}-${annee}-${String(valeur).padStart(4, '0')}`;
}

module.exports = { prochainNumero };
