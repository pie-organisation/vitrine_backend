const { join } = require('path');

// Chromium est téléchargé dans le projet (et non dans ~/.cache) pour être présent au runtime sur Render :
// seul le dossier du projet est conservé entre le build et l'exécution.
module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
