use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    error::AppError,
    middleware::auth::AuthUser,
    models::{contact_facturation::ContactFacturation, ecole::Ecole, utilisateur::Utilisateur},
};

// ── /school/organisation ──────────────────────────────────────────────────────

/// GET /school/organisation
pub async fn get_organisation(
    State(pool): State<PgPool>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<Ecole>, AppError> {
    let ecole = sqlx::query_as::<_, Ecole>("SELECT * FROM ecole WHERE id = $1")
        .bind(auth.ecole_id)
        .fetch_optional(&pool).await?
        .ok_or_else(|| AppError::NotFound("Organisation introuvable".to_string()))?;
    Ok(Json(ecole))
}

// ── /school/comptes ───────────────────────────────────────────────────────────

/// GET /school/comptes
pub async fn list_comptes(
    State(pool): State<PgPool>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<Vec<Utilisateur>>, AppError> {
    let users = sqlx::query_as::<_, Utilisateur>(
        "SELECT * FROM utilisateur WHERE ecole_id = $1 ORDER BY date_invitation DESC",
    )
    .bind(auth.ecole_id)
    .fetch_all(&pool).await?;
    Ok(Json(users))
}

#[derive(Deserialize)]
pub struct CreateCompteBody {
    pub nom: String,
    pub prenom: String,
    pub email: String,
    pub role: String,
    pub classe_id: Option<Uuid>,
}

/// POST /school/comptes
pub async fn create_compte(
    State(pool): State<PgPool>,
    Extension(auth): Extension<AuthUser>,
    Json(body): Json<CreateCompteBody>,
) -> Result<Json<Value>, AppError> {
    let user_id = Uuid::new_v4();
    sqlx::query(
        r#"INSERT INTO utilisateur
           (id, ecole_id, classe_id, invite_par, nom, prenom, email, mot_de_passe_hash, mdp_temporaire, role, statut)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'temporaire', TRUE, $8, 'actif')"#,
    )
    .bind(user_id)
    .bind(auth.ecole_id)
    .bind(body.classe_id)
    .bind(auth.user_id)
    .bind(&body.nom)
    .bind(&body.prenom)
    .bind(&body.email)
    .bind(&body.role)
    .execute(&pool).await?;

    Ok(Json(json!({ "id": user_id, "message": "Compte créé" })))
}

#[derive(Deserialize)]
pub struct UpdateCompteBody {
    pub statut: Option<String>,
    pub role: Option<String>,
    pub classe_id: Option<Uuid>,
}

/// PATCH /school/comptes/:id
pub async fn update_compte(
    State(pool): State<PgPool>,
    Extension(auth): Extension<AuthUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateCompteBody>,
) -> Result<Json<Value>, AppError> {
    if let Some(statut) = &body.statut {
        sqlx::query(
            "UPDATE utilisateur SET statut = $1 WHERE id = $2 AND ecole_id = $3",
        )
        .bind(statut)
        .bind(id)
        .bind(auth.ecole_id)
        .execute(&pool).await?;
    }
    if let Some(role) = &body.role {
        sqlx::query(
            "UPDATE utilisateur SET role = $1 WHERE id = $2 AND ecole_id = $3",
        )
        .bind(role)
        .bind(id)
        .bind(auth.ecole_id)
        .execute(&pool).await?;
    }
    Ok(Json(json!({ "message": "Compte mis à jour" })))
}

/// DELETE /school/comptes/:id
pub async fn delete_compte(
    State(pool): State<PgPool>,
    Extension(auth): Extension<AuthUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    let rows = sqlx::query(
        "UPDATE utilisateur SET statut = 'suspendu' WHERE id = $1 AND ecole_id = $2",
    )
    .bind(id)
    .bind(auth.ecole_id)
    .execute(&pool).await?
    .rows_affected();

    if rows == 0 {
        return Err(AppError::NotFound("Compte introuvable".to_string()));
    }
    Ok(Json(json!({ "message": "Compte suspendu" })))
}

// ── /school/factures (stub) ───────────────────────────────────────────────────

/// GET /school/factures
pub async fn list_factures(Extension(_auth): Extension<AuthUser>) -> Json<Value> {
    Json(json!([]))
}

// ── /school/activite ──────────────────────────────────────────────────────────

/// GET /school/activite
pub async fn list_activite(
    State(pool): State<PgPool>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<Value>, AppError> {
    let rows: Vec<(Uuid, String, Option<String>, chrono::DateTime<chrono::Utc>)> =
        sqlx::query_as(
            r#"SELECT l.id, l.action, l.details, l.horodatage
               FROM log_activite l
               JOIN session s ON s.id = l.session_id
               JOIN utilisateur u ON u.id = s.utilisateur_id
               WHERE u.ecole_id = $1
               ORDER BY l.horodatage DESC LIMIT 50"#,
        )
        .bind(auth.ecole_id)
        .fetch_all(&pool).await?;

    let activite: Vec<Value> = rows.into_iter().map(|(id, action, details, ts)| json!({
        "id": id,
        "type": "connexion",
        "description": details.unwrap_or(action),
        "date": ts.format("%d/%m/%Y %H:%M").to_string()
    })).collect();

    Ok(Json(json!(activite)))
}

// ── /school/contact ───────────────────────────────────────────────────────────

/// GET /school/contact
pub async fn get_contact(
    State(pool): State<PgPool>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<Value>, AppError> {
    let contact = sqlx::query_as::<_, ContactFacturation>(
        "SELECT * FROM contact_facturation WHERE ecole_id = $1 LIMIT 1",
    )
    .bind(auth.ecole_id)
    .fetch_optional(&pool).await?;

    match contact {
        Some(c) => Ok(Json(json!(c))),
        None => Ok(Json(json!({
            "nom_contact": "",
            "prenom_contact": "",
            "email_facturation": "",
            "telephone": ""
        }))),
    }
}

#[derive(Deserialize)]
pub struct UpdateContactBody {
    pub nom_contact: Option<String>,
    pub prenom_contact: Option<String>,
    pub email_facturation: Option<String>,
    pub telephone: Option<String>,
}

/// PATCH /school/contact
pub async fn update_contact(
    State(pool): State<PgPool>,
    Extension(auth): Extension<AuthUser>,
    Json(body): Json<UpdateContactBody>,
) -> Result<Json<Value>, AppError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM contact_facturation WHERE ecole_id = $1)",
    )
    .bind(auth.ecole_id)
    .fetch_one(&pool).await?;

    if exists {
        sqlx::query(
            r#"UPDATE contact_facturation SET
               nom_contact = COALESCE($1, nom_contact),
               prenom_contact = COALESCE($2, prenom_contact),
               email_facturation = COALESCE($3, email_facturation),
               telephone = COALESCE($4, telephone)
               WHERE ecole_id = $5"#,
        )
        .bind(&body.nom_contact)
        .bind(&body.prenom_contact)
        .bind(&body.email_facturation)
        .bind(&body.telephone)
        .bind(auth.ecole_id)
        .execute(&pool).await?;
    } else {
        sqlx::query(
            r#"INSERT INTO contact_facturation
               (ecole_id, nom_contact, prenom_contact, email_facturation, telephone)
               VALUES ($1, $2, $3, $4, $5)"#,
        )
        .bind(auth.ecole_id)
        .bind(body.nom_contact.unwrap_or_default())
        .bind(body.prenom_contact.unwrap_or_default())
        .bind(body.email_facturation.unwrap_or_default())
        .bind(&body.telephone)
        .execute(&pool).await?;
    }

    Ok(Json(json!({ "message": "Contact mis à jour" })))
}
