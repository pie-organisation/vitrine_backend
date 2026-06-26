use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Ecole {
    pub id: Uuid,
    pub groupe_scolaire_id: Option<Uuid>,
    pub nom_complet_ecole: String,
    pub siret: String,
    pub adresse: String,
    pub code_postal: String,
    pub ville: String,
    pub type_licence_id: Uuid,
    #[serde(skip_serializing)]
    pub mot_de_passe_hash: String,
    pub statut: String,
    pub date_creation: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateEcole {
    pub groupe_scolaire_id: Option<Uuid>,
    pub nom_complet_ecole: String,
    pub siret: String,
    pub adresse: String,
    pub code_postal: String,
    pub ville: String,
    pub type_licence_id: Uuid,
    /// Mot de passe en clair — sera haché avant insertion
    pub mot_de_passe: String,
    pub statut: String,
}
