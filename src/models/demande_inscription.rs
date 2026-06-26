use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct DemandeInscription {
    pub id: Uuid,
    /// "ecole" | "groupe"
    pub type_demande: String,
    pub nom_siege_ou_ecole: String,
    pub nom_daf: Option<String>,
    pub prenom_daf: Option<String>,
    pub siret: Option<String>,
    pub type_licence_id: Uuid,
    /// "en_attente" | "validee" | "rejetee"
    pub statut: String,
    pub date_demande: DateTime<Utc>,
    pub date_traitement: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateDemandeInscription {
    pub type_demande: String,
    pub nom_siege_ou_ecole: String,
    pub nom_daf: Option<String>,
    pub prenom_daf: Option<String>,
    pub siret: Option<String>,
    pub type_licence_id: Uuid,
}
