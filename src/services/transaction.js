const pool = require('../db');

// Exécute fn(client) dans une transaction : COMMIT si fn se termine, ROLLBACK si elle lève.
async function avecTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resultat = await fn(client);
    await client.query('COMMIT');
    return resultat;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Erreur métier : le gestionnaire d'erreurs d'Express renvoie err.status et err.message
function erreur(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

module.exports = { avecTransaction, erreur };
