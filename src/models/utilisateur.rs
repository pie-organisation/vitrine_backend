use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Utilisateur {
    pub id: Uuid,
    pub ecole_id: Uuid,
    pub classe_id: Option<Uuid>,
    /// Admin qui a créé cet utilisateur
    pub invite_par: Option<Uuid>,
    pub nom: String,
    pub prenom: String,
    pub email: String,
    #[serde(skip_serializing)]
    pub mot_de_passe_hash: String,
    /// true = l'utilisateur doit changer son mot de passe au premier login
    pub mdp_temporaire: bool,
    /// "eleve" | "enseignant" | "admin"
    pub role: String,
    /// "actif" | "inactif" | "suspendu"
    pub statut: String,
    pub date_invitation: DateTime<Utc>,
    pub derniere_connexion: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateUtilisateur {
    pub ecole_id: Uuid,
    pub classe_id: Option<Uuid>,
    pub invite_par: Option<Uuid>,
    pub nom: String,
    pub prenom: String,
    pub email: String,
    pub role: String,
}
