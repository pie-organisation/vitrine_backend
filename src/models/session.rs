use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Session {
    pub id: Uuid,
    pub utilisateur_id: Uuid,
    pub licence_id: Uuid,
    pub token_session: String,
    pub ip_origine: Option<String>,
    pub appareil_os: Option<String>,
    /// "active" | "terminee" | "expiree"
    pub statut: String,
    /// "normale" | "examen" | "supervisee"
    pub type_session: String,
    pub date_debut: DateTime<Utc>,
    pub date_fin: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSession {
    pub utilisateur_id: Uuid,
    pub licence_id: Uuid,
    pub ip_origine: Option<String>,
    pub appareil_os: Option<String>,
    pub type_session: Option<String>,
}
