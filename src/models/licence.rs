use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Licence {
    pub id: Uuid,
    pub ecole_id: Uuid,
    /// NULL = licence non encore assignée à un utilisateur
    pub utilisateur_id: Option<Uuid>,
    pub type_licence_id: Uuid,
    /// "disponible" | "assignee" | "suspendue" | "expiree"
    pub statut: String,
    pub nb_sessions_actives: i32,
    pub date_debut: NaiveDate,
    /// NULL = licence permanente sans date d'expiration
    pub date_fin: Option<NaiveDate>,
    pub date_creation: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateLicence {
    pub ecole_id: Uuid,
    pub utilisateur_id: Option<Uuid>,
    pub type_licence_id: Uuid,
    pub date_debut: NaiveDate,
    pub date_fin: Option<NaiveDate>,
}
