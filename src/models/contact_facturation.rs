use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ContactFacturation {
    pub id: Uuid,
    pub ecole_id: Option<Uuid>,
    pub groupe_scolaire_id: Option<Uuid>,
    pub nom_contact: String,
    pub prenom_contact: String,
    pub email_facturation: String,
    pub telephone: Option<String>,
    pub date_creation: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateContactFacturation {
    pub ecole_id: Option<Uuid>,
    pub groupe_scolaire_id: Option<Uuid>,
    pub nom_contact: String,
    pub prenom_contact: String,
    pub email_facturation: String,
    pub telephone: Option<String>,
}
