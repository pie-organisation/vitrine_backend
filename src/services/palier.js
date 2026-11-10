// Palier de licence (type_licence) déduit de la quantité totale, jamais saisi à la main.
// Pour un groupe, la quantité est la somme de ses établissements : tous profitent du même palier.

// typesLicence : lignes type_licence actives ({ id, nom, sessions_min, sessions_max, prix_unitaire, ... })
function calculerPalier(typesLicence, quantite) {
  if (!Number.isInteger(quantite) || quantite <= 0) {
    throw Object.assign(new Error('La quantité de licences doit être un entier positif.'), { status: 422 });
  }
  const palier = typesLicence.find(t =>
    t.actif !== false
    && quantite >= t.sessions_min
    && (t.sessions_max === null || quantite <= t.sessions_max));
  if (!palier) {
    throw Object.assign(new Error(`Aucun palier de licence actif ne couvre ${quantite} licence(s).`), { status: 422 });
  }
  return palier;
}

// NUMERIC (euros, renvoyé en chaîne par pg) -> centimes entiers
function prixEnCentimes(prixUnitaire) {
  return Math.round(Number(prixUnitaire) * 100);
}

module.exports = { calculerPalier, prixEnCentimes };
