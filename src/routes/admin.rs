use axum::{extract::State, Extension, Json};
use serde::Serialize;
use sqlx::PgPool;

use crate::{error::AppError, middleware::auth::AuthUser};

// ── DTOs ────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct DashboardStats {
    pub nb_utilisateurs_actifs: i64,
    pub nb_sessions_actives: i64,
    pub nb_licences_disponibles: i64,
    pub nb_licences_assignees: i64,
    pub nb_classes: i64,
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/// GET /admin/dashboard
/// Retourne les statistiques de monitoring de l'école pour l'admin.
pub async fn dashboard(
    State(pool): State<PgPool>,
    Extension(auth_user): Extension<AuthUser>,
) -> Result<Json<DashboardStats>, AppError> {
    let ecole_id = auth_user.ecole_id;

    // Toutes les requêtes sont scopées sur l'école de l'admin authentifié
    let (nb_utilisateurs_actifs,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM utilisateur WHERE ecole_id = $1 AND statut = 'actif'",
    )
    .bind(ecole_id)
    .fetch_one(&pool)
    .await?;

    let (nb_sessions_actives,): (i64,) = sqlx::query_as(
        r#"
        SELECT COUNT(*) FROM session s
        JOIN utilisateur u ON u.id = s.utilisateur_id
        WHERE u.ecole_id = $1 AND s.statut = 'active'
        "#,
    )
    .bind(ecole_id)
    .fetch_one(&pool)
    .await?;

    let (nb_licences_disponibles,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM licence WHERE ecole_id = $1 AND statut = 'disponible'",
    )
    .bind(ecole_id)
    .fetch_one(&pool)
    .await?;

    let (nb_licences_assignees,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM licence WHERE ecole_id = $1 AND statut = 'assignee'",
    )
    .bind(ecole_id)
    .fetch_one(&pool)
    .await?;

    let (nb_classes,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM classe WHERE ecole_id = $1",
    )
    .bind(ecole_id)
    .fetch_one(&pool)
    .await?;

    Ok(Json(DashboardStats {
        nb_utilisateurs_actifs,
        nb_sessions_actives,
        nb_licences_disponibles,
        nb_licences_assignees,
        nb_classes,
    }))
}
