const swaggerSpec = {
  openapi: '3.0.0',
  info: {
    title: 'Cubi API',
    version: '1.0.0',
    description: 'API REST — gestion des licences, sessions et utilisateurs pour établissements scolaires.',
  },
  servers: [{ url: '' }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Token JWT obtenu via POST /auth/login',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: { error: { type: 'string' } },
      },
    },
  },
  tags: [
    { name: 'Auth', description: 'Authentification et inscription' },
    { name: 'Utilisateur', description: 'Profil et gestion des comptes' },
    { name: 'Sessions', description: 'Sessions desktop' },
    { name: 'Licences', description: 'Gestion des licences' },
    { name: 'École', description: 'Espace école' },
    { name: 'Admin', description: 'Espace administration (rôle admin requis)' },
  ],
  paths: {

    // ── Auth ────────────────────────────────────────────────────────────────

    '/auth/inscription': {
      post: {
        tags: ['Auth'],
        summary: 'Soumettre une demande d\'inscription',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['type', 'nom', 'email'],
                properties: {
                  type:       { type: 'string', enum: ['ecole', 'groupe'] },
                  nom:        { type: 'string', example: 'École Saint-Exupéry' },
                  email:      { type: 'string', format: 'email' },
                  siret:      { type: 'string', example: '12345678901234', description: 'École seulement' },
                  nom_daf:    { type: 'string', description: 'Groupe seulement' },
                  prenom_daf: { type: 'string', description: 'Groupe seulement' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Demande reçue' },
        },
      },
    },

    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Se connecter et obtenir un JWT',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'mot_de_passe'],
                properties: {
                  email:        { type: 'string', format: 'email', example: 'admin@cubi.fr' },
                  mot_de_passe: { type: 'string', example: 'admin123' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'JWT retourné',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    token:   { type: 'string' },
                    user_id: { type: 'string', format: 'uuid' },
                    role:    { type: 'string', enum: ['eleve', 'enseignant', 'admin'] },
                  },
                },
              },
            },
          },
          401: { description: 'Identifiants invalides' },
          403: { description: 'reset_required — mot de passe temporaire à changer' },
        },
      },
    },

    '/auth/reset-password': {
      post: {
        tags: ['Auth'],
        summary: 'Réinitialiser le mot de passe via token temporaire',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['token_temporaire', 'nouveau_mot_de_passe'],
                properties: {
                  token_temporaire:    { type: 'string' },
                  nouveau_mot_de_passe: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Mot de passe mis à jour' },
          401: { description: 'Token invalide' },
          404: { description: 'Utilisateur introuvable' },
        },
      },
    },

    // ── Utilisateur ─────────────────────────────────────────────────────────

    '/me': {
      get: {
        tags: ['Utilisateur'],
        summary: 'Profil de l\'utilisateur connecté',
        security: [{ bearerAuth: [] }],
        responses: {
          200: { description: 'Profil utilisateur' },
          401: { description: 'Non authentifié' },
        },
      },
    },

    // ── Sessions ────────────────────────────────────────────────────────────

    '/sessions/open': {
      post: {
        tags: ['Sessions'],
        summary: 'Ouvrir une session',
        security: [{ bearerAuth: [] }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  ip_origine:   { type: 'string' },
                  appareil_os:  { type: 'string', example: 'Windows 11' },
                  type_session: { type: 'string', enum: ['normale', 'examen', 'supervisee'], default: 'normale' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Session ouverte',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    session_id:    { type: 'string', format: 'uuid' },
                    token_session: { type: 'string' },
                  },
                },
              },
            },
          },
          404: { description: 'Aucune licence active' },
          409: { description: 'Session déjà active ou quota atteint' },
        },
      },
    },

    '/sessions/close': {
      post: {
        tags: ['Sessions'],
        summary: 'Fermer une session',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['session_id'],
                properties: { session_id: { type: 'string', format: 'uuid' } },
              },
            },
          },
        },
        responses: {
          200: { description: 'Session fermée' },
          404: { description: 'Session introuvable' },
        },
      },
    },

    // ── Licences ────────────────────────────────────────────────────────────

    '/licences': {
      get: {
        tags: ['Licences'],
        summary: 'Lister les licences de l\'école',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Liste des licences' } },
      },
    },

    '/licences/{id}/assign': {
      patch: {
        tags: ['Licences'],
        summary: 'Assigner une licence à un utilisateur',
        security: [{ bearerAuth: [] }],
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['utilisateur_id'],
                properties: { utilisateur_id: { type: 'string', format: 'uuid' } },
              },
            },
          },
        },
        responses: {
          200: { description: 'Licence assignée' },
          404: { description: 'Licence introuvable ou déjà assignée' },
        },
      },
    },

    '/licences/{id}/unassign': {
      patch: {
        tags: ['Licences'],
        summary: 'Libérer une licence',
        security: [{ bearerAuth: [] }],
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'Licence libérée' },
          404: { description: 'Licence introuvable' },
        },
      },
    },

    // ── École ───────────────────────────────────────────────────────────────

    '/school/organisation': {
      get: {
        tags: ['École'],
        summary: 'Infos de l\'école',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Données école' } },
      },
    },

    '/school/comptes': {
      get: {
        tags: ['École'],
        summary: 'Lister les comptes',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Liste des utilisateurs' } },
      },
      post: {
        tags: ['École'],
        summary: 'Créer un compte',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['nom', 'prenom', 'email', 'role'],
                properties: {
                  nom:       { type: 'string' },
                  prenom:    { type: 'string' },
                  email:     { type: 'string', format: 'email' },
                  role:      { type: 'string', enum: ['eleve', 'enseignant', 'admin'] },
                  classe_id: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Compte créé' } },
      },
    },

    '/school/comptes/{id}': {
      patch: {
        tags: ['École'],
        summary: 'Modifier un compte',
        security: [{ bearerAuth: [] }],
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  statut:    { type: 'string', enum: ['actif', 'inactif', 'suspendu'] },
                  role:      { type: 'string', enum: ['eleve', 'enseignant', 'admin'] },
                  classe_id: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Compte mis à jour' } },
      },
      delete: {
        tags: ['École'],
        summary: 'Suspendre un compte',
        security: [{ bearerAuth: [] }],
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Compte suspendu' }, 404: { description: 'Compte introuvable' } },
      },
    },

    '/school/contact': {
      get: {
        tags: ['École'],
        summary: 'Contact de facturation',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Contact' } },
      },
      patch: {
        tags: ['École'],
        summary: 'Mettre à jour le contact de facturation',
        security: [{ bearerAuth: [] }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  nom_contact:       { type: 'string' },
                  prenom_contact:    { type: 'string' },
                  email_facturation: { type: 'string', format: 'email' },
                  telephone:         { type: 'string' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Contact mis à jour' } },
      },
    },

    '/school/activite': {
      get: {
        tags: ['École'],
        summary: 'Journal d\'activité de l\'école',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Activité récente' } },
      },
    },

    '/school/factures': {
      get: {
        tags: ['École'],
        summary: 'Factures',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Liste des factures' } },
      },
    },

    // ── Admin ───────────────────────────────────────────────────────────────

    '/admin/dashboard': {
      get: {
        tags: ['Admin'],
        summary: 'Tableau de bord',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Stats du tableau de bord' } },
      },
    },

    '/admin/metriques': {
      get: {
        tags: ['Admin'],
        summary: 'Métriques globales',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Métriques' } },
      },
    },

    '/admin/alertes': {
      get: {
        tags: ['Admin'],
        summary: 'Alertes système',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Alertes' } },
      },
    },

    '/admin/analytiques': {
      get: {
        tags: ['Admin'],
        summary: 'Analytiques',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Données analytiques' } },
      },
    },

    '/admin/organisations': {
      get: {
        tags: ['Admin'],
        summary: 'Lister toutes les organisations',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Liste des écoles' } },
      },
    },

    '/admin/organisations/{id}': {
      get: {
        tags: ['Admin'],
        summary: 'Détail d\'une organisation',
        security: [{ bearerAuth: [] }],
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Données organisation' }, 404: { description: 'Introuvable' } },
      },
    },

    '/admin/plans': {
      get: {
        tags: ['Admin'],
        summary: 'Lister les plans tarifaires',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Plans' } },
      },
      post: {
        tags: ['Admin'],
        summary: 'Créer un plan',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Plan créé' } },
      },
    },

    '/admin/plans/{id}': {
      patch: {
        tags: ['Admin'],
        summary: 'Modifier un plan',
        security: [{ bearerAuth: [] }],
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Plan modifié' } },
      },
      delete: {
        tags: ['Admin'],
        summary: 'Supprimer un plan',
        security: [{ bearerAuth: [] }],
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Plan supprimé' } },
      },
    },

    '/admin/demandes': {
      get: {
        tags: ['Admin'],
        summary: 'Lister les demandes d\'inscription',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Demandes' } },
      },
    },

    '/admin/demandes/{id}': {
      patch: {
        tags: ['Admin'],
        summary: 'Valider ou rejeter une demande',
        security: [{ bearerAuth: [] }],
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['statut'],
                properties: { statut: { type: 'string', enum: ['validee', 'rejetee'] } },
              },
            },
          },
        },
        responses: { 200: { description: 'Demande mise à jour' }, 404: { description: 'Introuvable' } },
      },
    },

    '/admin/sessions': {
      get: {
        tags: ['Admin'],
        summary: 'Lister toutes les sessions',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Sessions' } },
      },
    },

    '/admin/sessions/{id}': {
      delete: {
        tags: ['Admin'],
        summary: 'Terminer une session',
        security: [{ bearerAuth: [] }],
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Session terminée' }, 404: { description: 'Introuvable' } },
      },
    },

    '/admin/journaux': {
      get: {
        tags: ['Admin'],
        summary: 'Journaux d\'activité',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Logs' } },
      },
    },

    '/admin/users': {
      post: {
        tags: ['Admin'],
        summary: 'Créer un utilisateur (envoie email de bienvenue)',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['nom', 'prenom', 'email', 'role'],
                properties: {
                  nom:       { type: 'string' },
                  prenom:    { type: 'string' },
                  email:     { type: 'string', format: 'email' },
                  role:      { type: 'string', enum: ['eleve', 'enseignant', 'admin'] },
                  classe_id: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Utilisateur créé' },
          409: { description: 'Email déjà utilisé' },
        },
      },
      get: {
        tags: ['Admin'],
        summary: 'Lister les utilisateurs',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Utilisateurs' } },
      },
    },

    '/admin/users/{id}/suspend': {
      delete: {
        tags: ['Admin'],
        summary: 'Suspendre un utilisateur',
        security: [{ bearerAuth: [] }],
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Suspendu' }, 404: { description: 'Introuvable' } },
      },
    },

    '/admin/factures': {
      get: {
        tags: ['Admin'],
        summary: 'Factures',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Factures' } },
      },
    },

    '/admin/equipe': {
      get:  { tags: ['Admin'], summary: 'Équipe interne', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Équipe' } } },
      post: { tags: ['Admin'], summary: 'Inviter un membre', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Invitation envoyée' } } },
    },

    '/admin/equipe/{id}': {
      patch:  { tags: ['Admin'], summary: 'Modifier un membre', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Modifié' } } },
      delete: { tags: ['Admin'], summary: 'Révoquer un membre', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Révoqué' } } },
    },

    '/admin/messages': {
      get: { tags: ['Admin'], summary: 'Messages', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Messages' } } },
    },

    '/admin/offres': {
      get:  { tags: ['Admin'], summary: 'Offres', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Offres' } } },
      post: { tags: ['Admin'], summary: 'Créer une offre', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Offre créée' } } },
    },
  },
};

module.exports = swaggerSpec;
