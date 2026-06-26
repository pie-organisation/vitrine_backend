use axum::{extract::Request, middleware::Next, response::Response};
use sqlx::PgPool;

use crate::{error::AppError, middleware::auth::AuthUser};

/// Middleware : bloque la requête si l'utilisateur a déjà une session active.
/// À placer sur POST /sessions/open pour éviter les sessions simultanées.
pub async fn no_active_session(
    axum::extract::State(pool): axum::extract::State<PgPool>,
    request: Request,
    next: Next,
) -> Result<Response, AppError> {
    let auth_user = request
        .extensions()
        .get::<AuthUser>()
        .ok_or(AppError::Unauthorized)?
        .clone();

    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM session WHERE utilisateur_id = $1 AND statut = 'active'",
    )
    .bind(auth_user.user_id)
    .fetch_one(&pool)
    .await?;

    if count > 0 {
        return Err(AppError::Conflict(
            "Une session est déjà active pour cet utilisateur".to_string(),
        ));
    }

    Ok(next.run(request).await)
}
