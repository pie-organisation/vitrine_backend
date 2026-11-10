const config = require('./config');
const runMigrations = require('./migrate');
const app = require('./app');
const { closeBrowser } = require('./pdf/render');

async function start() {
  await runMigrations();
  console.log('Migrations appliquées');

  app.listen(config.appPort, '0.0.0.0', () => {
    console.log(`Serveur Cubi démarré sur le port ${config.appPort}`);
  });
}

// Arrêt propre (redéploiement Render) : ferme le Chromium partagé du rendu PDF
process.on('SIGTERM', () => {
  closeBrowser().finally(() => process.exit(0));
});

start().catch(err => {
  console.error('Erreur au démarrage :', err.message);
  process.exit(1);
});
