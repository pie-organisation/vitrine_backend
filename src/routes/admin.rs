use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{error::AppError, middleware::auth::AuthUser, models::{demande_inscription::DemandeInscription, ecole::Ecole, session::Session, utilisateur::Utilisateur}};

// ── /admin/metriques ──────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct Metriques {
    pub nb_organisations: i64,
    pub nb_utilisateurs_actifs: i64,
    pub nb_sessions_actives: i64,
    pub nb_licences_disponibles: i64,
    pub nb_licences_assignees: i64,
    pub nb_demandes_en_attente: i64,
}

/// GET /admin/metriques
pub async fn metriques(
    State(pool): State<PgPool>,
    Extension(_auth): Extension<AuthUser>,
) -> Result<Json<Metriques>, AppError> {
    let (nb_organisations,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM ecole WHERE statut = 'actif'")
        .fetch_one(&pool).await?;
    let (nb_utilisateurs_actifs,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM utilisateur WHERE statut = 'actif'")
        .fetch_one(&pool).await?;
    let (nb_sessions_actives,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM session WHERE statut = 'active'")
        .fetch_one(&pool).await?;
    let (nb_licences_disponibles,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM licence WHERE statut = 'disponible'")
        .fetch_one(&pool).await?;
    let (nb_licences_assignees,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM licence WHERE statut = 'assignee'")
        .fetch_one(&pool).await?;
    let (nb_demandes_en_attente,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM demande_inscription WHERE statut = 'en_attente'")
        .fetch_one(&pool).await?;

    Ok(Json(Metriques {
        nb_organisations,
        nb_utilisateurs_actifs,
        nb_sessions_actives,
        nb_licences_disponibles,
        nb_licences_assignees,
        nb_demandes_en_attente,
    }))
}

// ── /admin/alertes ────────────────────────────────────────────────────────────

/// GET /admin/alertes
pub async fn alertes(
    State(pool): State<PgPool>,
    Extension(_auth): Extension<AuthUser>,
) -> Result<Json<Value>, AppError> {
    let (sessions_anormales,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM session WHERE statut = 'active' AND date_debut < NOW() - INTERVAL '8 hours'",
    )
    .fetch_one(&pool).await?;

    let (demandes_en_attente,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM demande_inscription WHERE statut = 'en_attente' AND date_demande < NOW() - INTERVAL '48 hours'",
    )
    .fetch_one(&pool).await?;

    Ok(Json(json!({
        "sessions_anormales": sessions_anormales,
        "demandes_en_attente": demandes_en_attente
    })))
}

// ── /admin/analytiques ────────────────────────────────────────────────────────

/// GET /admin/analytiques
pub async fn analytiques(
    State(pool): State<PgPool>,
    Extension(_auth): Extension<AuthUser>,
) -> Result<Json<Value>, AppError> {
    let (nb_orgs,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM ecole").fetch_one(&pool).await?;
    let (nb_users,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM utilisateur").fetch_one(&pool).await?;

    Ok(Json(json!({
        "evolutionOrgs": [{ "mois": "Jan", "orgs": nb_orgs }],
        "usageSessions": [],
        "repartitionPlans": [],
        "tauxRenouvellement": 0,
        "churn": 0,
        "totalOrgs": nb_orgs,
        "totalUsers": nb_users
    })))
}

// ── /admin/dashboard (legacy) ─────────────────────────────────────────────────

#[derive(Serialize)]
pub struct DashboardStats {
    pub nb_utilisateurs_actifs: i64,
    pub nb_sessions_actives: i64,
    pub nb_licences_disponibles: i64,
    pub nb_licences_assignees: i64,
    pub nb_classes: i64,
}

/// GET /admin/dashboard
pub async fn dashboard(
    State(pool): State<PgPool>,
    Extension(auth_user): Extension<AuthUser>,
) -> Result<Json<DashboardStats>, AppError> {
    let ecole_id = auth_user.ecole_id;

    let (nb_utilisateurs_actifs,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM utilisateur WHERE ecole_id = $1 AND statut = 'actif'",
    ).bind(ecole_id).fetch_one(&pool).await?;

    let (nb_sessions_actives,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM session s JOIN utilisateur u ON u.id = s.utilisateur_id WHERE u.ecole_id = $1 AND s.statut = 'active'",
    ).bind(ecole_id).fetch_one(&pool).await?;

    let (nb_licences_disponibles,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM licence WHERE ecole_id = $1 AND statut = 'disponible'",
    ).bind(ecole_id).fetch_one(&pool).await?;

    let (nb_licences_assignees,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM licence WHERE ecole_id = $1 AND statut = 'assignee'",
    ).bind(ecole_id).fetch_one(&pool).await?;

    let (nb_classes,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM classe WHERE ecole_id = $1",
    ).bind(ecole_id).fetch_one(&pool).await?;

    Ok(Json(DashboardStats {
        nb_utilisateurs_actifs,
        nb_sessions_actives,
        nb_licences_disponibles,
        nb_licences_assignees,
        nb_classes,
    }))
}

// ── /admin/organisations ──────────────────────────────────────────────────────

/// GET /admin/organisations
pub async fn list_organisations(
    State(pool): State<PgPool>,
    Extension(_auth): Extension<AuthUser>,
) -> Result<Json<Vec<Ecole>>, AppError> {
    let ecoles = sqlx::query_as::<_, Ecole>("SELECT * FROM ecole ORDER BY date_creation DESC")
        .fetch_all(&pool).await?;
    Ok(Json(ecoles))
}

/// GET /admin/organisations/:id
pub async fn get_organisation(
    State(pool): State<PgPool>,
    Extension(_auth): Extension<AuthUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Ecole>, AppError> {
    let ecole = sqlx::query_as::<_, Ecole>("SELECT * FROM ecole WHERE id = $1")
        .bind(id)
        .fetch_optional(&pool).await?
        .ok_or_else(|| AppError::NotFound("Organisation introuvable".to_string()))?;
    Ok(Json(ecole))
}

// ── /admin/plans (→ type_licence) ─────────────────────────────────────────────

/// GET /admin/plans
pub async fn list_plans(
    State(pool): State<PgPool>,
    Extension(_auth): Extension<AuthUser>,
) -> Result<Json<Value>, AppError> {
    let rows: Vec<(Uuid, String, i32, Option<i32>, rust_decimal::Decimal, bool)> = sqlx::query_as(
        "SELECT id, nom, sessions_min, sessions_max, prix_unitaire, actif FROM type_licence ORDER BY sessions_min",
    ).fetch_all(&pool).await?;

    let plans: Vec<Value> = rows.into_iter().map(|(id, nom, smin, smax, prix, actif)| json!({
        "id": id,
        "nom": nom,
        "sessionsMin": smin,
        "sessionsMax": smax,
        "tarif": format!("{} €/session", prix),
        "statut": if actif { "actif" } else { "archive" },
        "description": format!("Plan {}", nom),
        "nbOrganisations": 0
    })).collect();

    Ok(Json(json!(plans)))
}

/// POST /admin/plans
pub async fn create_plan(
    Extension(_auth): Extension<AuthUser>,
) -> Result<Json<Value>, AppError> {
    Ok(Json(json!({ "message": "Fonctionnalité à implémenter" })))
}

/// PATCH /admin/plans/:id
pub async fn update_plan(
    Path(_id): Path<Uuid>,
    Extension(_auth): Extension<AuthUser>,
) -> Result<Json<Value>, AppError> {
    Ok(Json(json!({ "message": "Fonctionnalité à implémenter" })))
}

/// DELETE /admin/plans/:id
pub async fn delete_plan(
    Path(_id): Path<Uuid>,
    Extension(_auth): Extension<AuthUser>,
) -> Result<Json<Value>, AppError> {
    Ok(Json(json!({ "message": "Fonctionnalité à implémenter" })))
}

// ── /admin/demandes ───────────────────────────────────────────────────────────

/// GET /admin/demandes
pub async fn list_demandes(
    State(pool): State<PgPool>,
    Extension(_auth): Extension<AuthUser>,
) -> Result<Json<Vec<DemandeInscription>>, AppError> {
    let demandes = sqlx::query_as::<_, DemandeInscription>(
        "SELECT * FROM demande_inscription ORDER BY date_demande DESC",
    ).fetch_all(&pool).await?;
    Ok(Json(demandes))
}

#[derive(Deserialize)]
pub struct UpdateDemandeBody {
    pub statut: String,
}

/// PATCH /admin/demandes/:id
pub async fn update_demande(
    State(pool): State<PgPool>,
    Extension(_auth): Extension<AuthUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateDemandeBody>,
) -> Result<Json<Value>, AppError> {
    let rows = sqlx::query(
        "UPDATE demande_inscription SET statut = $1, date_traitement = NOW() WHERE id = $2",
    )
    .bind(&body.statut)
    .bind(id)
    .execute(&pool).await?
    .rows_affected();

    if rows == 0 {
        return Err(AppError::NotFound("Demande introuvable".to_string()));
    }
    Ok(Json(json!({ "message": "Demande mise à jour" })))
}

// ── /admin/sessions ───────────────────────────────────────────────────────────

/// GET /admin/sessions
pub async fn list_sessions(
    State(pool): State<PgPool>,
    Extension(_auth): Extension<AuthUser>,
) -> Result<Json<Vec<Session>>, AppError> {
    let sessions = sqlx::query_as::<_, Session>(
        "SELECT * FROM session ORDER BY date_debut DESC LIMIT 100",
    ).fetch_all(&pool).await?;
    Ok(Json(sessions))
}

/// DELETE /admin/sessions/:id  (terminer une session)
pub async fn terminate_session(
    State(pool): State<PgPool>,
    Extension(_auth): Extension<AuthUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    let rows = sqlx::query(
        "UPDATE session SET statut = 'terminee', date_fin = NOW() WHERE id = $1",
    )
    .bind(id)
    .execute(&pool).await?
    .rows_affected();

    if rows == 0 {
        return Err(AppError::NotFound("Session introuvable".to_string()));
    }
    Ok(Json(json!({ "message": "Session terminée" })))
}

// ── /admin/factures ───────────────────────────────────────────────────────────

/// GET /admin/factures
pub async fn list_factures(
    Extension(_auth): Extension<AuthUser>,
) -> Result<Json<Value>, AppError> {
    Ok(Json(json!([])))
}

// ── /admin/journaux ───────────────────────────────────────────────────────────

/// GET /admin/journaux
pub async fn list_journaux(
    State(pool): State<PgPool>,
    Extension(_auth): Extension<AuthUser>,
) -> Result<Json<Value>, AppError> {
    let rows: Vec<(Uuid, Uuid, String, Option<String>, chrono::DateTime<chrono::Utc>)> =
        sqlx::query_as(
            "SELECT l.id, l.session_id, l.action, l.details, l.horodatage
             FROM log_activite l
             ORDER BY l.horodatage DESC LIMIT 200",
        ).fetch_all(&pool).await?;

    let logs: Vec<Value> = rows.into_iter().map(|(id, session_id, action, details, ts)| json!({
        "id": id,
        "sessionId": session_id,
        "type": "modification",
        "organisation": "—",
        "utilisateur": "—",
        "message": details.unwrap_or_else(|| action.clone()),
        "horodatage": ts.format("%d/%m/%Y %H:%M").to_string()
    })).collect();

    Ok(Json(json!(logs)))
}

// ── /admin/equipe (stubs — pas de table pour l'équipe interne CUBI) ───────────

/// GET /admin/equipe
pub async fn list_equipe(Extension(_auth): Extension<AuthUser>) -> Json<Value> {
    Json(json!([]))
}

/// POST /admin/equipe
pub async fn invite_equipe(Extension(_auth): Extension<AuthUser>) -> Json<Value> {
    Json(json!({ "message": "Invitation envoyée" }))
}

/// PATCH /admin/equipe/:id
pub async fn update_equipe(
    Path(_id): Path<Uuid>,
    Extension(_auth): Extension<AuthUser>,
) -> Json<Value> {
    Json(json!({ "message": "Rôle modifié" }))
}

/// DELETE /admin/equipe/:id
pub async fn delete_equipe(
    Path(_id): Path<Uuid>,
    Extension(_auth): Extension<AuthUser>,
) -> Json<Value> {
    Json(json!({ "message": "Accès révoqué" }))
}

// ── /admin/messages (stubs) ───────────────────────────────────────────────────

/// GET /admin/messages
pub async fn list_messages(Extension(_auth): Extension<AuthUser>) -> Json<Value> {
    Json(json!([]))
}

/// PATCH /admin/messages/:id
pub async fn update_message(
    Path(_id): Path<Uuid>,
    Extension(_auth): Extension<AuthUser>,
) -> Json<Value> {
    Json(json!({ "message": "Message mis à jour" }))
}

// ── /admin/offres (stubs) ─────────────────────────────────────────────────────

/// GET /admin/offres
pub async fn list_offres(Extension(_auth): Extension<AuthUser>) -> Json<Value> {
    Json(json!([]))
}

/// POST /admin/offres
pub async fn create_offre(Extension(_auth): Extension<AuthUser>) -> Json<Value> {
    Json(json!({ "message": "Offre créée" }))
}

/// PATCH /admin/offres/:id
pub async fn update_offre(
    Path(_id): Path<Uuid>,
    Extension(_auth): Extension<AuthUser>,
) -> Json<Value> {
    Json(json!({ "message": "Offre mise à jour" }))
}
