use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct GroupeScolaire {
    pub id: Uuid,
    pub nom_du_siege: String,
    pub nom_daf: String,
    pub prenom_daf: String,
    pub type_licence_id: Uuid,
    #[serde(skip_serializing)]
    pub mot_de_passe_hash: String,
    pub statut: String,
    pub date_creation: DateTime<Utc>,
    pub date_modification: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateGroupeScolaire {
    pub nom_du_siege: String,
    pub nom_daf: String,
    pub prenom_daf: String,
    pub type_licence_id: Uuid,
    /// Mot de passe en clair — sera haché avant insertion
    pub mot_de_passe: String,
    pub statut: String,
}
