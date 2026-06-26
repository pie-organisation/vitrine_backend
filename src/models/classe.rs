use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Classe {
    pub id: Uuid,
    pub ecole_id: Uuid,
    pub nom: String,
    pub niveau: Option<String>,
    /// Format "2024-2025"
    pub annee_scolaire: Option<String>,
    pub effectif_max: Option<i32>,
    pub date_creation: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateClasse {
    pub ecole_id: Uuid,
    pub nom: String,
    pub niveau: Option<String>,
    pub annee_scolaire: Option<String>,
    pub effectif_max: Option<i32>,
}
