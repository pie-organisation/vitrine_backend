-- Inscription d'un groupe avec plusieurs établissements en une seule demande.
-- Chaque élément : { nom, siret, visa, adresse, code_postal, ville,
--                    nom_responsable, prenom_responsable, email_responsable }
ALTER TABLE demande_inscription ADD COLUMN IF NOT EXISTS etablissements JSONB;
