use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct LogActivite {
    pub id: Uuid,
    pub session_id: Uuid,
    /// "connexion" | "deconnexion" | "mode_examen" | …
    pub action: String,
    pub details: Option<String>,
    pub horodatage: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateLogActivite {
    pub session_id: Uuid,
    pub action: String,
    pub details: Option<String>,
}
